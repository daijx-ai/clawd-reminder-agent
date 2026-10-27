"use strict";

const fs = require("node:fs");
const net = require("node:net");
const { acquireProcessLock } = require("./process-lock");
const { createReminderAgent, resolveDataPaths } = require("./reminder-agent");

const MAX_REQUEST_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 2_097_152;
const CONTROL_TIMEOUT_MS = 30_000;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function controlPath(paths) {
  return paths.socketPath || require("node:path").join(paths.dataDir, "control.sock");
}

function validateSocketPath(paths, requireSocket = true) {
  const directory = fs.lstatSync(paths.dataDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()
    || (process.getuid && (directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0))) {
    throw codedError("control_directory_unsafe");
  }
  let entry;
  try { entry = fs.lstatSync(controlPath(paths)); } catch (error) {
    if (error.code === "ENOENT" && !requireSocket) return null;
    throw error;
  }
  if (!entry.isSocket() || entry.isSymbolicLink()
    || (process.getuid && (entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0))) {
    throw codedError("control_socket_unsafe");
  }
  return entry;
}

function unlinkMatchingSocket(paths, original) {
  if (!original) return;
  try {
    const current = validateSocketPath(paths);
    if (current.ino === original.ino && current.dev === original.dev) fs.unlinkSync(controlPath(paths));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function clearStaleSocket(paths) {
  const current = validateSocketPath(paths, false);
  if (!current) return;
  const available = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: controlPath(paths) });
    const timer = setTimeout(() => { socket.destroy(); reject(codedError("control_socket_busy")); }, 1_000);
    const finish = (error, value) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.once("connect", () => finish(null, false));
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") finish(null, true);
      else finish(error);
    });
  });
  if (!available) throw codedError("control_socket_busy");
  unlinkMatchingSocket(paths, current);
}

// Only the daemon holds the process lock and writes reminders.json. All management
// requests are serialized through this owner; a second agent is never started.
async function startDaemon(options = {}) {
  if (process.platform === "win32") throw codedError("daemon_requires_unix");
  const paths = options.paths || resolveDataPaths(options.home);
  const releaseLock = acquireProcessLock(paths.lockPath, options.lockOptions || {});
  const log = options.log || (() => {});
  let agent;
  let server;
  let socketIdentity;
  let closing = false;
  let closePromise;
  let commandTail = Promise.resolve();
  const active = new Set();
  const connections = new Set();
  const busy = new WeakSet();

  function connection(socket) {
    connections.add(socket);
    let buffer = "";
    let accepted = false;
    socket.setEncoding("utf8");
    socket.setTimeout(CONTROL_TIMEOUT_MS, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => connections.delete(socket));
    if (closing) { socket.destroy(); return; }

    socket.on("data", (chunk) => {
      if (accepted) { socket.destroy(); return; }
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) { socket.destroy(); return; }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      accepted = true;
      if (buffer.slice(newline + 1).trim()) { socket.destroy(); return; }
      busy.add(socket);
      const request = buffer.slice(0, newline);
      let job;
      job = commandTail.then(async () => {
        let message;
        try { message = JSON.parse(request); } catch { return { ok: false, output: "请求格式错误。\n" }; }
        if (!message || typeof message !== "object" || Array.isArray(message)
          || Object.keys(message).some((key) => key !== "command")
          || typeof message.command !== "string" || !message.command.trim()
          || message.command.length > 1_024) return { ok: false, output: "请求无效。\n" };
        if (message.command === "__ping__") return { ok: true, output: "running\n" };
        const verb = message.command.trim().split(/\s/, 1)[0].toLowerCase();
        if (!["add", "list", "done", "complete", "cancel", "snooze", "retry", "agent-id", "help"].includes(verb)) {
          return { ok: false, output: "不支持的后台命令。\n" };
        }
        const lines = [];
        try {
          const { executeCommand } = require("../bin/clawd-reminders");
          const result = await executeCommand(message.command, agent, { write: (part) => lines.push(part) });
          const output = lines.join("");
          if (Buffer.byteLength(output) > MAX_RESPONSE_BYTES) return { ok: false, output: "响应过大。\n" };
          return { ok: Boolean(result.ok), output };
        } catch (error) {
          try { log(`Control command failed: ${error.code || error.message}`); } catch {}
          return { ok: false, output: "后台命令执行失败。\n" };
        }
      });
      commandTail = job.then(() => {}, () => {});
      active.add(job);
      job.then((result) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify(result)}\n`, () => socket.destroy());
      }).catch(() => {
        if (!socket.destroyed) socket.end('{"ok":false,"output":"后台命令执行失败。\\n"}\n', () => socket.destroy());
      }).finally(() => active.delete(job));
    });
  }

  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      try {
        if (server && server.listening) {
          const stopped = new Promise((resolve) => server.close(resolve));
          for (const socket of connections) {
            // Idle peers cannot hold up launchctl bootout indefinitely.
            if (!busy.has(socket)) socket.destroy();
          }
          await Promise.allSettled(Array.from(active));
          for (const socket of connections) socket.destroy();
          await stopped;
        }
        await Promise.allSettled(Array.from(active));
        if (agent) await agent.stop();
      } finally {
        try { unlinkMatchingSocket(paths, socketIdentity); } finally { releaseLock(); }
      }
    })();
    return closePromise;
  }

  try {
    agent = createReminderAgent({ ...(options.agentOptions || {}), paths, log });
    const result = agent.start();
    if (!result.ok) throw codedError("reminder_store_unavailable");
    await clearStaleSocket(paths);
    server = net.createServer(connection);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(controlPath(paths), () => { server.removeListener("error", reject); resolve(); });
    });
    fs.chmodSync(controlPath(paths), 0o600);
    socketIdentity = validateSocketPath(paths);
    server.on("error", (error) => { try { log(`Control socket failed: ${error.code || error.message}`); } catch {} });
    return Object.freeze({ agent, paths, close });
  } catch (error) {
    await close();
    throw error;
  }
}

function sendControlCommand(command, options = {}) {
  const paths = options.paths || resolveDataPaths(options.home);
  if (typeof command !== "string" || !command || command.length > 1_024) {
    return Promise.reject(codedError("control_command_invalid"));
  }
  try { validateSocketPath(paths); } catch (error) {
    return Promise.reject(error.code === "ENOENT" ? codedError("daemon_not_running") : error);
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: controlPath(paths) });
    let response = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(options.timeoutMs || CONTROL_TIMEOUT_MS, () => finish(codedError("daemon_timeout")));
    socket.on("error", (error) => finish(error.code === "ECONNREFUSED" ? codedError("daemon_not_running") : error));
    socket.on("connect", () => socket.write(`${JSON.stringify({ command })}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response) > MAX_RESPONSE_BYTES + 1_024) return finish(codedError("daemon_response_too_large"));
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(response.slice(0, newline));
        if (!parsed || typeof parsed.ok !== "boolean" || typeof parsed.output !== "string") {
          throw codedError("daemon_response_invalid");
        }
        finish(null, parsed);
      } catch { finish(codedError("daemon_response_invalid")); }
    });
    socket.on("end", () => finish(codedError("daemon_response_incomplete")));
  });
}

async function runDaemon(options = {}) {
  const signals = options.signals || process;
  let requestShutdown;
  const ending = new Promise((resolve) => { requestShutdown = resolve; });
  const onSignal = () => requestShutdown();
  signals.on("SIGTERM", onSignal);
  signals.on("SIGINT", onSignal);
  let daemon;
  try {
    daemon = await startDaemon(options);
    if (options.onReady) options.onReady(daemon);
    else process.stdout.write("Clawd Reminder Agent daemon ready.\n");
    await ending;
  } finally {
    try {
      if (daemon) await daemon.close();
    } finally {
      signals.removeListener("SIGTERM", onSignal);
      signals.removeListener("SIGINT", onSignal);
    }
  }
}

module.exports = { startDaemon, runDaemon, sendControlCommand, validateSocketPath };
