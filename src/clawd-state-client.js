"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const CLAWD_APP_ID = "clawd-on-desk";
// Legacy opt-in allowlist: default runtime discovery accepts every canonical local port.
const DEFAULT_ALLOWED_PORTS = Object.freeze([23333, 23334, 23335, 23336, 23337]);
const DEFAULT_RUNTIME_PATH = path.join(os.homedir(), ".clawd", "runtime.json");
const MAX_TITLE_LENGTH = 160;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_RUNTIME_BYTES = 16_384;

function makeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isValidCustomAgentId(value) {
  return typeof value === "string"
    && value.length <= 128
    && /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function normalizeNotificationTitle(value) {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

function normalizeRuntimePort(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[1-9][0-9]{0,4}$/.test(value))) {
    return null;
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function normalizeAllowedPorts(value) {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_ALLOWED_PORTS;
  return value.filter((port) => Number.isSafeInteger(port) && port >= 1 && port <= 65535);
}

function readClawdRuntime(options = {}) {
  const filePath = typeof options.runtimePath === "string" ? options.runtimePath : DEFAULT_RUNTIME_PATH;
  const fsImpl = options.fs || fs;
  let fd;
  let parsed;
  try {
    // Clawd atomically writes an owner-only regular file on POSIX. Open the
    // same inode we validate and refuse symlinks before reading its contents.
    const flags = fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
    fd = fsImpl.openSync(filePath, flags);
    const stat = fsImpl.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RUNTIME_BYTES
      || (process.platform !== "win32"
        && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
      throw makeError("clawd_runtime_invalid");
    }
    parsed = JSON.parse(fsImpl.readFileSync(fd, "utf8"));
  } catch (error) {
    throw makeError(error && error.code === "ENOENT" ? "clawd_runtime_missing" : "clawd_runtime_invalid");
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch {}
    }
  }

  // A runtime file supplies a port hint, not a hostname or proof of the
  // listener's identity. postJson always uses literal IPv4 loopback.
  const port = normalizeRuntimePort(parsed && parsed.port);
  const allowedPorts = Array.isArray(options.allowedPorts) ? normalizeAllowedPorts(options.allowedPorts) : null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || parsed.app !== CLAWD_APP_ID || port === null
    || (allowedPorts && !allowedPorts.includes(port))) {
    throw makeError("clawd_runtime_invalid");
  }
  return Object.freeze({ app: CLAWD_APP_ID, port });
}

function postJson(options) {
  const body = JSON.stringify(options.payload);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    const request = http.request({
      host: "127.0.0.1",
      port: options.port,
      path: "/state",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      response.resume();
      response.on("end", () => finish(null, { statusCode: response.statusCode }));
      response.on("error", () => finish(makeError("clawd_response_failed")));
    });
    request.setTimeout(options.timeoutMs, () => {
      request.destroy(makeError("clawd_timeout"));
    });
    request.on("error", (error) => {
      const candidate = typeof error.code === "string" ? error.code.toLowerCase() : "";
      const safeCode = /^[a-z0-9_]{1,64}$/.test(candidate) ? candidate : "clawd_connection_failed";
      finish(makeError(safeCode));
    });
    request.end(body);
  });
}

function createClawdStateClient(options = {}) {
  const runtimePath = typeof options.runtimePath === "string" ? options.runtimePath : DEFAULT_RUNTIME_PATH;
  const fsImpl = options.fs || fs;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const requestImpl = typeof options.request === "function" ? options.request : postJson;

  return Object.freeze({
    async notify(input = {}) {
      const agentId = input.agentId;
      const reminder = input.reminder;
      if (!isValidCustomAgentId(agentId)) throw makeError("agent_id_invalid");
      if (!reminder || typeof reminder !== "object"
        || typeof reminder.id !== "string" || !reminder.id || reminder.id.length > 128
        || /[\x00-\x1f\x7f-\x9f]/.test(reminder.id)
        || typeof reminder.title !== "string" || !reminder.title
        || reminder.title.length > MAX_TITLE_LENGTH) {
        throw makeError("reminder_invalid");
      }
      const title = normalizeNotificationTitle(reminder.title);
      if (!title) throw makeError("reminder_invalid");
      const runtime = readClawdRuntime({
        runtimePath,
        fs: fsImpl,
        allowedPorts: options.allowedPorts,
      });
      const payload = {
        agent_id: agentId,
        session_id: `reminder-${reminder.id}`,
        state: "notification",
        event: "Notification",
        tool_name: title,
      };
      const response = await requestImpl({
        port: runtime.port,
        payload,
        timeoutMs,
      });
      if (!response || response.statusCode !== 200) {
        const status = response && Number.isInteger(response.statusCode) ? response.statusCode : 0;
        throw makeError(status ? `clawd_http_${status}` : "clawd_response_invalid");
      }
      return { ok: true, statusCode: 200 };
    },
  });
}

module.exports = {
  CLAWD_APP_ID,
  DEFAULT_ALLOWED_PORTS,
  DEFAULT_RUNTIME_PATH,
  DEFAULT_TIMEOUT_MS,
  createClawdStateClient,
  isValidCustomAgentId,
  normalizeNotificationTitle,
  readClawdRuntime,
};
