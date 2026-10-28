"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

function makeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPidRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    if (error && error.code === "EPERM") return true;
    throw error;
  }
}

// A PID can be reused after a crash or reboot. Record the OS process start
// time as a second identity component, but fail closed if ps is unavailable.
function readPidStartTime(pid) {
  if (process.platform === "win32") return null;
  const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 1_000,
    maxBuffer: 8_192,
  });
  if (result.error || result.status !== 0) return null;
  const timestamp = Date.parse((result.stdout || "").trim());
  return Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
}

function readLock(lockPath, fsImpl) {
  const stat = fsImpl.lstatSync(lockPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw makeError("lock_file_invalid");
  let value;
  try {
    value = JSON.parse(fsImpl.readFileSync(lockPath, "utf8"));
  } catch {
    throw makeError("lock_file_invalid");
  }
  if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1) {
    throw makeError("lock_file_invalid");
  }
  return value;
}

function acquireProcessLock(lockPath, options = {}) {
  const fsImpl = options.fs || fs;
  const pid = Number.isSafeInteger(options.pid) ? options.pid : process.pid;
  const isRunning = typeof options.isPidRunning === "function" ? options.isPidRunning : isPidRunning;
  const getStartTime = typeof options.readPidStartTime === "function"
    ? options.readPidStartTime : readPidStartTime;
  const ownerIsRunning = (lock) => {
    if (!isRunning(lock.pid)) return false;
    if (Number.isSafeInteger(lock.pidStartTime) && lock.pidStartTime > 0) {
      const currentStartTime = getStartTime(lock.pid);
      if (Number.isSafeInteger(currentStartTime) && currentStartTime > 0
        && currentStartTime !== lock.pidStartTime) return false;
    }
    return true;
  };
  const recoveryPath = `${lockPath}.recover`;
  const parent = path.dirname(lockPath);
  fsImpl.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = fsImpl.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw makeError("lock_directory_invalid");
  if (process.platform !== "win32") {
    try { fsImpl.chmodSync(parent, 0o700); } catch { throw makeError("lock_directory_permissions"); }
  }

  let descriptor;
  try {
    descriptor = fsImpl.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    if (!error || error.code !== "EEXIST") throw error;
    const existing = readLock(lockPath, fsImpl);
    if (ownerIsRunning(existing)) throw makeError("agent_already_running");

    let recoveryDescriptor;
    try {
      recoveryDescriptor = fsImpl.openSync(recoveryPath, "wx", 0o600);
    } catch (recoveryError) {
      if (recoveryError && recoveryError.code === "EEXIST") {
        throw makeError("lock_recovery_in_progress");
      }
      throw recoveryError;
    }

    const recoveryToken = crypto.randomBytes(16).toString("hex");
    try {
      fsImpl.writeFileSync(recoveryDescriptor, `${JSON.stringify({ pid, token: recoveryToken })}\n`);
      const latest = readLock(lockPath, fsImpl);
      if (ownerIsRunning(latest)) throw makeError("agent_already_running");
      fsImpl.unlinkSync(lockPath);
      try {
        descriptor = fsImpl.openSync(lockPath, "wx", 0o600);
      } catch (retryError) {
        if (retryError && retryError.code === "EEXIST") throw makeError("agent_already_running");
        throw retryError;
      }
    } finally {
      fsImpl.closeSync(recoveryDescriptor);
      try {
        const recovery = JSON.parse(fsImpl.readFileSync(recoveryPath, "utf8"));
        if (recovery && recovery.pid === pid && recovery.token === recoveryToken) {
          fsImpl.unlinkSync(recoveryPath);
        }
      } catch {}
    }
  }

  try {
    fsImpl.writeFileSync(descriptor, `${JSON.stringify({
      pid, startedAt: new Date().toISOString(), pidStartTime: getStartTime(pid),
    })}\n`);
    try { fsImpl.fchmodSync(descriptor, 0o600); } catch {}
  } finally {
    fsImpl.closeSync(descriptor);
  }

  let released = false;
  return function release() {
    if (released) return false;
    released = true;
    try {
      const current = readLock(lockPath, fsImpl);
      if (current.pid !== pid) return false;
      fsImpl.unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  };
}

module.exports = { acquireProcessLock, isPidRunning };
