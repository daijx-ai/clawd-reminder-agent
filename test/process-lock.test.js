"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { acquireProcessLock } = require("../src/process-lock");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-lock-"));
}

test("process lock prevents a second writer and releases only its own lock", () => {
  const directory = makeTempDir();
  const lockPath = path.join(directory, "agent.lock");
  if (process.platform !== "win32") fs.chmodSync(directory, 0o755);
  const release = acquireProcessLock(lockPath, { pid: 1234 });
  try {
    if (process.platform !== "win32") assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.throws(() => acquireProcessLock(lockPath, {
      pid: 5678,
      isPidRunning: () => true,
    }), { code: "agent_already_running" });
    assert.equal(release(), true);
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    release();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("process lock recovers a confirmed stale owner but rejects a symlink", () => {
  const directory = makeTempDir();
  const lockPath = path.join(directory, "agent.lock");
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1234 }));
    const release = acquireProcessLock(lockPath, {
      pid: 5678,
      isPidRunning: () => false,
    });
    assert.equal(release(), true);
    assert.equal(fs.existsSync(`${lockPath}.recover`), false);
    fs.symlinkSync(path.join(directory, "missing-target"), lockPath);
    assert.throws(() => acquireProcessLock(lockPath, { pid: 5678 }), { code: "lock_file_invalid" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("process lock fails closed when stale recovery is already owned", () => {
  const directory = makeTempDir();
  const lockPath = path.join(directory, "agent.lock");
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1234 }));
    fs.writeFileSync(`${lockPath}.recover`, JSON.stringify({ pid: 5678, token: "owned" }));
    assert.throws(() => acquireProcessLock(lockPath, {
      pid: 9012,
      isPidRunning: () => false,
    }), { code: "lock_recovery_in_progress" });
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 1234);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent stale-lock recovery cannot delete a newly acquired live lock", () => {
  const directory = makeTempDir();
  const lockPath = path.join(directory, "agent.lock");
  let reentered = false;
  let innerRelease;
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 1234 }));
    assert.throws(() => acquireProcessLock(lockPath, {
      pid: 100,
      isPidRunning(pid) {
        if (pid === 1234 && !reentered) {
          reentered = true;
          innerRelease = acquireProcessLock(lockPath, {
            pid: 200,
            isPidRunning: (candidate) => candidate === 200,
          });
        }
        return pid === 200;
      },
    }), { code: "agent_already_running" });
    assert.ok(innerRelease, "the competing acquirer should own the recovered lock");
    assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 200);
  } finally {
    if (innerRelease) innerRelease();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
