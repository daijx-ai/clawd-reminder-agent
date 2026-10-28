"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createReminderAgent, resolveDataPaths } = require("../src/reminder-agent");
const { acquireProcessLock } = require("../src/process-lock");
const { startDaemon, sendControlCommand } = require("../src/daemon");

const root = path.join(__dirname, "..");

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-daemon-"));
  return { home, paths: resolveDataPaths(home), cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

async function eventually(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Condition not met before deadline");
}

function childExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("child exit timeout")); }, timeoutMs);
    child.once("exit", (code, signal) => { clearTimeout(timeout); resolve({ code, signal }); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
  });
}

function childMessage(child, expected, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`missing child message ${expected}`)); }, timeoutMs);
    function cleanup() { clearTimeout(timeout); child.off("message", onMessage); child.off("exit", onExit); }
    function onMessage(value) { if (value === expected) { cleanup(); resolve(); } }
    function onExit() { cleanup(); reject(new Error(`child exited before ${expected}`)); }
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

function prepareReminder(paths, dueAt, now = Date.now()) {
  const agent = createReminderAgent({ paths, now: () => now, client: { notify: async () => ({ statusCode: 200 }) } });
  assert.equal(agent.start().ok, true);
  return agent.setAgentId("custom-reminders-0123456789ab").then(async () => {
    const created = agent.service.create({ title: "恢复后的提醒", dueAt,
      channels: { bubble: true, system: false, feishu: false } });
    assert.equal(created.ok, true);
    await agent.stop();
    return created.reminder;
  });
}

test("non-TTY daemon exclusively owns the store while multiple one-shot commands use IPC", async () => {
  const { home, paths, cleanup } = fixture();
  let daemon;
  try {
    daemon = await startDaemon({ home });
    assert.equal(fs.statSync(paths.socketPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.dataDir).mode & 0o777, 0o700);
    assert.throws(() => acquireProcessLock(paths.lockPath), { code: "agent_already_running" });
    await assert.rejects(startDaemon({ home }), { code: "agent_already_running" });
    const commands = Array.from({ length: 12 }, (_, index) =>
      sendControlCommand(`add ${20 + index} 分钟后提醒我任务${index}`, { home }));
    for (const result of await Promise.all(commands)) assert.equal(result.ok, true, result.output);
    const listed = await sendControlCommand("list", { home });
    assert.equal(listed.ok, true);
    assert.match(listed.output, /任务11/);
    const stored = JSON.parse(fs.readFileSync(paths.storePath, "utf8"));
    assert.equal(stored.reminders.length, 12);
    const first = stored.reminders[0];
    assert.equal((await sendControlCommand(`cancel ${first.id}`, { home })).ok, true);
    assert.equal(JSON.parse(fs.readFileSync(paths.storePath, "utf8")).reminders[0].status, "cancelled");
  } finally {
    if (daemon) await daemon.close();
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.equal(fs.existsSync(paths.socketPath), false);
    await assert.rejects(sendControlCommand("list", { home }), { code: "daemon_not_running" });
    cleanup();
  }
});

test("control client rejects symlinks and permissive fake sockets", async () => {
  const { home, paths, cleanup } = fixture();
  try {
    fs.mkdirSync(paths.dataDir, { mode: 0o700 });
    fs.symlinkSync(paths.storePath, paths.socketPath);
    await assert.rejects(sendControlCommand("list", { home }), { code: "control_socket_unsafe" });
    fs.unlinkSync(paths.socketPath);
    fs.chmodSync(paths.dataDir, 0o755);
    await assert.rejects(sendControlCommand("list", { home }), { code: "control_directory_unsafe" });
  } finally { cleanup(); }
});

test("one-shot CLI accepts piped/non-TTY management commands without becoming a second writer", async () => {
  const { home, paths, cleanup } = fixture();
  let daemon;
  try {
    daemon = await startDaemon({ home });
    const child = spawn(process.execPath, ["bin/clawd-reminders.js", "add", "20", "分钟后提醒我终端调用"],
      { cwd: root, env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    const ended = childExit(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    assert.deepEqual(await ended, { code: 0, signal: null });
    assert.match(output, /已添加：终端调用/);
    assert.equal(JSON.parse(fs.readFileSync(paths.storePath, "utf8")).reminders.length, 1);
    assert.equal(fs.existsSync(paths.lockPath), true, "only the daemon retains the lock");
  } finally {
    if (daemon) await daemon.close();
    cleanup();
  }
});

test("failed notification persists backoff across daemon restart and IPC retry overrides it", async () => {
  const { home, paths, cleanup } = fixture();
  const reference = Date.now();
  let daemon;
  let calls = 0;
  try {
    const reminder = await prepareReminder(paths, reference - 500, reference - 1_000);
    daemon = await startDaemon({ home, agentOptions: { client: { async notify() {
      calls++;
      const error = new Error("offline"); error.code = "ECONNREFUSED"; throw error;
    } } } });
    await eventually(() => daemon.agent.service.get(reminder.id).delivery.bubble.status === "failed");
    assert.equal(calls, 1);
    const failed = daemon.agent.service.get(reminder.id);
    assert.equal(failed.delivery.bubble.attempts, 1);
    assert.ok(failed.delivery.bubble.nextRetryAt > Date.now());
    await daemon.close();
    daemon = await startDaemon({ home, agentOptions: { client: { async notify() { calls++; return { statusCode: 200 }; } } } });
    assert.equal(calls, 1, "restart must respect persisted backoff");
    const forced = await sendControlCommand("retry", { home });
    assert.equal(forced.ok, true);
    assert.match(forced.output, /Clawd 已接收 1 条/);
    assert.equal(daemon.agent.service.get(reminder.id).delivery.bubble.status, "sent");
    assert.equal(daemon.agent.service.get(reminder.id).delivery.bubble.attempts, 2);
  } finally {
    if (daemon) await daemon.close();
    cleanup();
  }
});

test("a SIGKILL leaves a stale lock/socket, then non-TTY daemon restarts and delivers overdue event to fake HTTP Clawd", async () => {
  const { home, paths, cleanup } = fixture();
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { requests.push({ path: request.url, body: JSON.parse(body) });
      response.writeHead(200); response.end(); });
  });
  let first;
  let second;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    fs.mkdirSync(path.dirname(paths.runtimePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.runtimePath, JSON.stringify({ app: "clawd-on-desk", port: server.address().port }), { mode: 0o600 });
    const dueAt = Date.now() + 2_000;
    const reminder = await prepareReminder(paths, dueAt);
    function spawnRealDaemon() {
      return spawn(process.execPath, ["bin/clawd-reminders.js", "daemon"],
        { cwd: root, env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
    }
    first = spawnRealDaemon();
    const firstExit = childExit(first);
    await eventually(async () => {
      try { return (await sendControlCommand("__ping__", { home })).ok; } catch { return false; }
    });
    assert.equal(first.stdin, null, "daemon does not require stdin/TTY");
    assert.equal(first.kill("SIGKILL"), true);
    assert.deepEqual(await firstExit, { code: null, signal: "SIGKILL" });
    assert.ok(fs.existsSync(paths.lockPath));
    assert.ok(fs.existsSync(paths.socketPath));
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, dueAt - Date.now() + 80)));
    second = spawnRealDaemon();
    const secondExit = childExit(second);
    await eventually(() => requests.length === 1);
    assert.equal(requests[0].path, "/state");
    assert.equal(requests[0].body.tool_name, "恢复后的提醒");
    await eventually(() => JSON.parse(fs.readFileSync(paths.storePath, "utf8"))
      .reminders.find((item) => item.id === reminder.id).delivery.bubble.status === "sent");
    assert.equal(second.kill("SIGTERM"), true);
    assert.deepEqual(await secondExit, { code: 0, signal: null });
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.equal(fs.existsSync(paths.socketPath), false);
  } finally {
    for (const child of [first, second]) {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await new Promise((resolve) => server.close(resolve));
    cleanup();
  }
});

test("SIGTERM drains a blocked notification before releasing lock or exiting", async () => {
  const { home, paths, cleanup } = fixture();
  let child;
  try {
    await prepareReminder(paths, Date.now() + 300);
    const code = `const {runDaemon}=require('./src/daemon');
      runDaemon({home: process.argv[1], onReady:()=>process.send('ready'), agentOptions:{client:{notify(){
        process.send('delivery_started');
        return new Promise(resolve=>process.once('message',()=>resolve({statusCode:200})));
      }}}}).catch(error=>{console.error(error);process.exitCode=1;});`;
    child = spawn(process.execPath, ["-e", code, home], { cwd: root, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const exited = childExit(child);
    const ready = childMessage(child, "ready");
    await ready;
    const delivering = childMessage(child, "delivery_started");
    await delivering;
    assert.equal(child.kill("SIGTERM"), true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(paths.lockPath), true);
    assert.equal(child.exitCode, null);
    child.send("release");
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.equal(fs.existsSync(paths.socketPath), false);
    assert.equal(JSON.parse(fs.readFileSync(paths.storePath, "utf8")).reminders[0].delivery.bubble.status, "sent");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    cleanup();
  }
});
