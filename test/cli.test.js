"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable, Writable } = require("node:stream");
const { executeCommand, main } = require("../bin/clawd-reminders");
const { createReminderAgent, resolveDataPaths } = require("../src/reminder-agent");
const { acquireProcessLock } = require("../src/process-lock");

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
