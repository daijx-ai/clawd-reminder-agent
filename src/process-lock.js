"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
    if (isRunning(existing.pid)) throw makeError("agent_already_running");

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
      if (isRunning(latest.pid)) throw makeError("agent_already_running");
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
    fsImpl.writeFileSync(descriptor, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`);
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
