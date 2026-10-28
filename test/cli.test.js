"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { PassThrough, Readable, Writable } = require("node:stream");
const { executeCommand, main } = require("../bin/clawd-reminders");
const { createReminderAgent, resolveDataPaths } = require("../src/reminder-agent");
const { acquireProcessLock } = require("../src/process-lock");

function waitForOutput(stream, pattern, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for ${pattern}`)), timeoutMs);
    function finish(error) {
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      if (error) reject(error);
      else resolve(text);
    }
    function onData(chunk) {
      text += chunk.toString("utf8");
      if (pattern.test(text)) finish();
    }
    function onEnd() { finish(new Error(`CLI exited before ${pattern}: ${text}`)); }
    stream.on("data", onData);
    stream.once("end", onEnd);
  });
}

function waitForExit(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("CLI did not exit after the signal"));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForMessage(child, expected, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting for child message: ${expected}`)),
      timeoutMs);
    function finish(error) {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
      if (error) reject(error);
      else resolve();
    }
    function onMessage(message) {
      if (message === expected) finish();
    }
    function onExit() { finish(new Error(`CLI exited before child message: ${expected}`)); }
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

test("CLI creates, lists, snoozes, and completes a reminder", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-cli-"));
  let now = 1_800_000_000_000;
  const paths = resolveDataPaths(home);
  const agent = createReminderAgent({
    paths,
    now: () => now,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    client: { notify: async () => ({ ok: true, statusCode: 200 }) },
    log: () => {},
  });
  const output = [];
  const write = (value) => output.push(value);
  try {
    agent.start();
    const added = await executeCommand("add 20 分钟后提醒我休息一下", agent, { write });
    assert.equal(added.ok, true);
    const reminder = added.reminder;
    assert.equal(reminder.title, "休息一下");
    assert.ok(output.join("").includes(reminder.id));

    const listed = await executeCommand("list", agent, { write });
    assert.equal(listed.reminders.length, 1);
    assert.ok(output.join("").includes("休息一下"));

    now = reminder.dueAt;
    agent.service.recheck();
    agent.service.setDelivery(reminder.id, "bubble", { status: "sent" });
    const snoozed = await executeCommand(`snooze ${reminder.id} 5`, agent, { write });
    assert.equal(snoozed.ok, true);
    assert.equal(snoozed.reminder.status, "snoozed");
    assert.equal(agent.service.get(reminder.id).delivery.bubble.status, "pending");
    assert.equal(snoozed.reminder.dueAt, now + 5 * 60_000);

    const completed = await executeCommand(`done ${reminder.id}`, agent, { write });
    assert.equal(completed.ok, true);
    assert.equal(agent.service.get(reminder.id).status, "completed");
  } finally {
    agent.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("interactive entry persists commands and releases its single-instance lock on quit", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-repl-"));
  const chunks = [];
  const input = Readable.from([
    "agent-id custom-reminders-0123456789ab\n",
    "add 20 分钟后提醒我休息一下\n",
    "list\n",
    "quit\n",
  ]);
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  try {
    await main({
      home,
      stdin: input,
      stdout: output,
      requireTTY: false,
      terminal: false,
      agentOptions: { client: { notify: async () => ({ ok: true, statusCode: 200 }) } },
    });
    const paths = resolveDataPaths(home);
    const text = chunks.join("");
    assert.match(text, /已保存 Clawd Agent ID/);
    assert.match(text, /已添加：休息一下/);
    assert.match(text, /休息一下/);
    assert.equal(JSON.parse(fs.readFileSync(paths.configPath, "utf8")).agentId, "custom-reminders-0123456789ab");
    assert.equal(fs.existsSync(paths.storePath), true);
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("CLI processes buffered commands and releases its lock on EOF without quit", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-eof-"));
  const paths = resolveDataPaths(home);
  try {
    await main({
      home,
      stdin: Readable.from([
        "add 20 分钟后提醒我休息一下\n",
        "add 30 分钟后提醒我喝水\n",
      ]),
      stdout: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      requireTTY: false,
      terminal: false,
    });
    const saved = JSON.parse(fs.readFileSync(paths.storePath, "utf8"));
    assert.equal(saved.reminders.length, 2, "EOF must not discard queued commands");
    assert.deepEqual(
      saved.reminders.map((item) => item.title).sort(),
      ["休息一下", "喝水"].sort(),
    );
    assert.equal(fs.existsSync(paths.lockPath), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("CLI waits for an asynchronous command when EOF closes readline", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-async-eof-"));
  const paths = resolveDataPaths(home);
  const now = 1_800_000_000_000;
  const prep = createReminderAgent({
    paths,
    now: () => now,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    client: { notify: async () => ({ ok: true, statusCode: 200 }) },
  });
  const input = new PassThrough();
  let releaseDelivery;
  let deliveryStarted;
  const started = new Promise((resolve) => { deliveryStarted = resolve; });
  let run;
  try {
    assert.equal(prep.start().ok, true);
    assert.equal(prep.service.create({
      title: "之前的提醒",
      dueAt: now + 1_000,
      channels: { bubble: true, system: false, feishu: false },
    }).ok, true);
    await prep.stop();

    run = main({
      home,
      stdin: input,
      stdout: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      requireTTY: false,
      terminal: false,
      agentOptions: {
        now: () => now + 1_000,
        setTimeout: () => ({ unref() {} }),
        clearTimeout: () => {},
        client: {
          notify() {
            deliveryStarted();
            return new Promise((resolve) => { releaseDelivery = resolve; });
          },
        },
      },
    });
    input.write("agent-id custom-reminders-0123456789ab\n");
    let startTimeout;
    try {
      await Promise.race([
        started,
        new Promise((_, reject) => {
          startTimeout = setTimeout(() => reject(new Error("Delivery did not start")), 5_000);
        }),
      ]);
    } finally {
      clearTimeout(startTimeout);
    }

    const ended = once(input, "end");
    input.end();
    await ended;
    assert.equal(fs.existsSync(paths.lockPath), true, "lock must stay held until async work finishes");
    releaseDelivery({ ok: true, statusCode: 200 });
    await run;

    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.equal(JSON.parse(fs.readFileSync(paths.configPath, "utf8")).agentId,
      "custom-reminders-0123456789ab");
    assert.equal(JSON.parse(fs.readFileSync(paths.storePath, "utf8"))
      .reminders[0].delivery.bubble.status, "sent");
  } finally {
    if (releaseDelivery) releaseDelivery({ ok: true, statusCode: 200 });
    input.destroy();
    if (run) await run.catch(() => {});
    await prep.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`CLI handles ${signal} by releasing lock and preserving reminders`,
    { skip: process.platform === "win32" ? "Windows signals terminate subprocesses directly" : false },
    async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-signal-"));
      const paths = resolveDataPaths(home);
      const child = spawn(process.execPath, [
        "-e",
        "require('./bin/clawd-reminders').main({ home: process.argv[1], requireTTY: false, terminal: false }).catch(error => { console.error(error); process.exitCode = 1; });",
        home,
      ], { cwd: path.join(__dirname, ".."), stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      try {
        await waitForOutput(child.stdout, /Clawd 提醒助手已运行/);
        const created = waitForOutput(child.stdout, /已添加：备份数据/);
        child.stdin.write("add 20 分钟后提醒我备份数据\n");
        await created;
        assert.equal(fs.existsSync(paths.lockPath), true);
        const exited = waitForExit(child);
        assert.equal(child.kill(signal), true);
        assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
        assert.doesNotMatch(stderr, /ERR_USE_AFTER_CLOSE/);
        assert.equal(fs.existsSync(paths.lockPath), false);
        const saved = JSON.parse(fs.readFileSync(paths.storePath, "utf8"));
        assert.equal(saved.reminders.length, 1);
        assert.equal(saved.reminders[0].title, "备份数据");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
}

test("SIGTERM during an async command waits for delivery before releasing the lock",
  { skip: process.platform === "win32" ? "Windows signals terminate subprocesses directly" : false },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-signal-drain-"));
    const paths = resolveDataPaths(home);
    const now = 1_800_000_000_000;
    const prep = createReminderAgent({
      paths,
      now: () => now,
      setTimeout: () => ({ unref() {} }),
      clearTimeout: () => {},
      client: { notify: async () => ({ ok: true, statusCode: 200 }) },
    });
    let child;
    try {
      assert.equal(prep.start().ok, true);
      assert.equal(prep.service.create({
        title: "退出前须完成",
        dueAt: now + 1_000,
        channels: { bubble: true, system: false, feishu: false },
      }).ok, true);
      await prep.stop();

      const script = `
        const { main } = require("./bin/clawd-reminders");
        process.on("SIGTERM", () => process.send("signal_observed"));
        main({
          home: process.argv[1],
          requireTTY: false,
          terminal: false,
          agentOptions: {
            now: () => 1800000001000,
            setTimeout: () => ({ unref() {} }),
            clearTimeout: () => {},
            client: {
              notify() {
                return new Promise((resolve) => {
                  process.once("message", () => resolve({ ok: true, statusCode: 200 }));
                  process.send("delivery_started");
                });
              },
            },
          },
        }).catch((error) => { console.error(error); process.exitCode = 1; });
      `;
      child = spawn(process.execPath, ["-e", script, home], {
        cwd: path.join(__dirname, ".."),
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
      await waitForOutput(child.stdout, /Clawd 提醒助手已运行/);
      const delivering = waitForMessage(child, "delivery_started");
      child.stdin.write("agent-id custom-reminders-0123456789ab\n");
      await delivering;

      const signalObserved = waitForMessage(child, "signal_observed");
      assert.equal(child.kill("SIGTERM"), true);
      await signalObserved;
      assert.equal(fs.existsSync(paths.lockPath), true, "in-flight delivery still owns the lock");
      assert.equal(child.exitCode, null, "exit must wait for delivery to finish");
      const exited = waitForExit(child);
      child.send("release_delivery");
      assert.deepEqual(await exited, { code: 0, signal: null }, stderr);
      assert.equal(fs.existsSync(paths.lockPath), false);
      assert.equal(JSON.parse(fs.readFileSync(paths.storePath, "utf8"))
        .reminders[0].delivery.bubble.status, "sent");
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await prep.stop();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

test("CLI drains due notification before releasing lock and keeps later manager updates", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-drain-"));
  const paths = resolveDataPaths(home);
  const initialNow = 1_800_000_000_000;
  const prep = createReminderAgent({
    paths,
    now: () => initialNow,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    client: { notify: async () => ({ ok: true, statusCode: 200 }) },
    log: () => {},
  });
  let releaseDelivery;
  let signalDelivery;
  const deliveryStarted = new Promise((resolve) => { signalDelivery = resolve; });
  let firstMain;
  try {
    assert.equal(prep.start().ok, true);
    await prep.setAgentId("custom-reminders-0123456789ab");
    const created = prep.service.create({
      title: "已到期提醒",
      dueAt: initialNow + 1_000,
      channels: { bubble: true, system: false, feishu: false },
    });
    assert.equal(created.ok, true);
    await prep.stop();

    firstMain = main({
      home,
      stdin: Readable.from(["quit\n"]),
      stdout: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      requireTTY: false,
      terminal: false,
      agentOptions: {
        now: () => initialNow + 1_000,
        setTimeout: () => ({ unref() {} }),
        clearTimeout: () => {},
        client: {
          notify() {
            signalDelivery();
            return new Promise((resolve) => { releaseDelivery = resolve; });
          },
        },
      },
    });

    await deliveryStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(fs.existsSync(paths.lockPath), "lock must remain held while delivery is in flight");
    assert.throws(() => acquireProcessLock(paths.lockPath), { code: "agent_already_running" });

    releaseDelivery({ ok: true, statusCode: 200 });
    await firstMain;
    assert.equal(fs.existsSync(paths.lockPath), false);

    await main({
      home,
      stdin: Readable.from(["add 20 分钟后提醒我新提醒\n", "quit\n"]),
      stdout: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
      requireTTY: false,
      terminal: false,
      agentOptions: {
        now: () => initialNow + 1_000,
        setTimeout: () => ({ unref() {} }),
        clearTimeout: () => {},
        client: { notify: async () => ({ ok: true, statusCode: 200 }) },
      },
    });

    const check = createReminderAgent({
      paths,
      now: () => initialNow + 1_000,
      setTimeout: () => ({ unref() {} }),
      clearTimeout: () => {},
      client: { notify: async () => ({ ok: true, statusCode: 200 }) },
      log: () => {},
    });
    assert.equal(check.start().ok, true);
    assert.equal(check.service.list().length, 2);
    await check.stop();
  } finally {
    if (releaseDelivery) releaseDelivery({ ok: true, statusCode: 200 });
    if (firstMain) await firstMain.catch(() => {});
    await prep.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});