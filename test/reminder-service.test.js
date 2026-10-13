"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  STATUS,
  STORE_VERSION,
  RETRY_DELAYS_MS,
  parseReminderText,
  parseReminderFields,
  createBindingFingerprint,
  createReminderService,
} = require("../src/reminder-service");

function makeClock(initial = 1_800_000_000_000) {
  let current = initial;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(fn, delay) {
      const handle = { id: nextId++, at: current + Math.max(0, delay), fn, unref() {} };
      timers.set(handle.id, handle);
      return handle;
    },
    clearTimeout(handle) { if (handle) timers.delete(handle.id); },
    advance(ms) {
      const target = current + ms;
      let executions = 0;
      while (true) {
        const next = Array.from(timers.values())
          .filter((item) => item.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        if (++executions > 100) throw new Error("fake clock runaway");
        timers.delete(next.id);
        current = next.at;
        next.fn();
      }
      current = target;
    },
    pendingCount: () => timers.size,
  };
}

function makeFixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminders-v2-"));
  const filePath = path.join(directory, "reminders.json");
  const clock = makeClock(options.now);
  const due = [];
  const retries = [];
  let id = 0;
  const service = createReminderService({
    filePath,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    randomUUID: () => "reminder-" + String(++id),
    onDue: (reminder, meta) => due.push({ reminder, meta }),
    onFeishuRetry: (reminder) => retries.push(reminder),
  });
  return { directory, filePath, clock, due, retries, service };
}

function bindFakeRecipient(service) {
  return service.setSettings({
    binding: {
      enabled: true,
      platform: "feishu",
      appId: "cli_fake",
      idType: "open_id",
      recipientId: "ou_fake_recipient",
      source: "manual",
    },
  });
}

test("binding fingerprint tracks delivery destination and ignores app-secret rotation", () => {
  const original = {
    enabled: true,
    platform: "feishu",
    appId: "cli_same_app",
    idType: "open_id",
    recipientId: "ou_same_recipient",
    appSecret: "old-secret-value",
  };
  assert.equal(
    createBindingFingerprint(original),
    createBindingFingerprint({ ...original, appSecret: "rotated-secret-value" }),
  );
  assert.notEqual(
    createBindingFingerprint(original),
    createBindingFingerprint({ ...original, recipientId: "ou_new_recipient" }),
  );
  assert.notEqual(
    createBindingFingerprint(original),
    createBindingFingerprint({ ...original, idType: "union_id" }),
  );
});

test("parser supports minutes, hours, today, tomorrow, Chinese periods and explicit dates", () => {
  const now = new Date(2026, 8, 28, 10, 0, 0, 0).getTime();
  assert.deepEqual(parseReminderText("20 分钟后提醒我出发", { now }), {
    ok: true,
    title: "出发",
    dueAt: now + 20 * 60_000,
  });
  assert.equal(parseReminderText("2 小时后开会", { now }).dueAt, now + 2 * 60 * 60_000);

  const today = parseReminderText("今天 11:45 提醒我出门", { now });
  assert.equal(today.ok, true);
  assert.equal(today.title, "出门");
  assert.equal(new Date(today.dueAt).getHours(), 11);
  assert.equal(new Date(today.dueAt).getMinutes(), 45);

  const tomorrow = parseReminderText("明天 14:30 提醒我出发", { now });
  assert.equal(tomorrow.ok, true);
  assert.equal(tomorrow.title, "出发");
  assert.equal(new Date(tomorrow.dueAt).getDate(), 29);
  assert.equal(new Date(tomorrow.dueAt).getHours(), 14);
  assert.equal(new Date(tomorrow.dueAt).getMinutes(), 30);

  assert.equal(new Date(parseReminderText("明天上午 8 点提醒我出发", { now }).dueAt).getHours(), 8);
  assert.equal(new Date(parseReminderText("明天下午 2 点半提醒我出发", { now }).dueAt).getHours(), 14);
  assert.equal(new Date(parseReminderText("明天晚上 8 点半提醒我出发", { now }).dueAt).getHours(), 20);
  const midnight = new Date(parseReminderText("明天晚上 12 点半提醒我出发", { now }).dueAt);
  assert.equal(midnight.getDate(), 30);
  assert.equal(midnight.getHours(), 0);
  assert.equal(midnight.getMinutes(), 30);
  const explicit = parseReminderText("2026-10-03 09:15 提醒我出发", { now });
  assert.equal(explicit.ok, true);
  assert.equal(explicit.title, "出发");
  assert.equal(new Date(explicit.dueAt).getDate(), 3);
  assert.equal(new Date(explicit.dueAt).getHours(), 9);
});

test("parser rejects vague dates, malformed times, past times, DST gaps and duplicate DST minutes", () => {
  const now = new Date(2026, 8, 28, 15, 0).getTime();
  assert.equal(parseReminderText("", { now }).error, "empty");
  assert.equal(parseReminderText("提醒我找个时间出发", { now }).error, "invalid_format");
  assert.equal(parseReminderText("10月3日 14:00 提醒我出发", { now }).error, "invalid_format");
  assert.equal(parseReminderText("今天 25:70 提醒我出发", { now }).error, "invalid_time");
  assert.equal(parseReminderText("今天 14:59 提醒我出发", { now }).error, "past_time");
  assert.equal(parseReminderText("20 分钟后提醒我", { now }).error, "missing_title");
  assert.equal(parseReminderFields("出门", "2026-09-28", "14:00", { now }).error, "past_time");

  const servicePath = require.resolve("../src/reminder-service");
  const runInZone = (zone, expression, instant) => {
    const script = [
      "const { parseReminderText, parseReminderFields } = require(" + JSON.stringify(servicePath) + ");",
      "const now = Date.parse(" + JSON.stringify(instant) + ");",
      "process.stdout.write(JSON.stringify(" + expression + "));",
    ].join("\n");
    return JSON.parse(execFileSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, TZ: zone },
    }));
  };
  assert.deepEqual(
    runInZone("America/New_York", 'parseReminderText("2026-11-01 01:30 提醒我出发", { now })', "2026-10-31T12:00:00.000Z"),
    { ok: false, error: "ambiguous_time" },
  );
  assert.deepEqual(
    runInZone("America/New_York", 'parseReminderFields("出发", "2026-03-08", "02:30", { now })', "2026-03-07T12:00:00.000Z"),
    { ok: false, error: "invalid_time" },
  );
});

test("v1 migration backs up the exact file and preserves every completed record", () => {
  const fixture = makeFixture();
  const v1 = {
    version: 1,
    reminders: [
      { id: "old-scheduled", title: "未来提醒", dueAt: 1_900_000_000_000, status: "scheduled" },
      { id: "old-pending", title: "待处理提醒", dueAt: 1_900_000_000_001, status: "pending" },
      { id: "old-snoozed", title: "稍后提醒", dueAt: 1_900_000_000_002, status: "snoozed" },
      { id: "old-a", title: "已完成一", dueAt: 1_900_000_000_003, status: "completed" },
      { id: "old-b", title: "已完成二", dueAt: 1_900_000_000_004, status: "completed" },
    ],
  };
  const original = JSON.stringify(v1, null, 2) + "\n";
  fs.writeFileSync(fixture.filePath, original);
  try {
    assert.equal(fixture.service.start().ok, true);
    assert.equal(fs.readFileSync(fixture.filePath + ".v1.bak", "utf8"), original);
    const saved = JSON.parse(fs.readFileSync(fixture.filePath, "utf8"));
    assert.equal(saved.version, STORE_VERSION);
    assert.equal(saved.reminders.length, 5);
    assert.deepEqual(saved.reminders.map(({ id, title, dueAt, status }) => ({ id, title, dueAt, status })), v1.reminders);
    assert.ok(saved.reminders.every((item, index) => (
      item.revision === 1 && item.status === v1.reminders[index].status
    )));
    assert.deepEqual(saved.reminders.map((item) => item.channels), Array.from({ length: 5 }, () => ({
      bubble: true,
      system: true,
      feishu: false,
    })));
    assert.deepEqual(saved.reminders.map((item) => item.status), ["scheduled", "pending", "snoozed", "completed", "completed"]);
    assert.equal(saved.settings.dndPolicy, "mute_all");
    assert.equal(saved.settings.binding.enabled, false);
  } finally {
    fixture.service.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("v1 migration backup failure and atomic replacement failure preserve the v1 bytes", () => {
  const runFailureCase = ({ failBackup, failReplace }) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminders-migrate-failure-"));
    const filePath = path.join(directory, "reminders.json");
    const v1 = {
      version: 1,
      reminders: [
        { id: "kept", title: "保留记录", dueAt: 1_700_000_000_000, status: "completed" },
      ],
    };
    const original = JSON.stringify(v1, null, 2) + "\n";
    fs.writeFileSync(filePath, original);
    const fsImpl = Object.create(fs);
    if (failBackup) fsImpl.copyFileSync = () => { throw Object.assign(new Error("backup denied"), { code: "EACCES" }); };
    if (failReplace) fsImpl.renameSync = () => { throw Object.assign(new Error("replace denied"), { code: "EACCES" }); };
    const service = createReminderService({ filePath, fs: fsImpl });
    try {
      assert.equal(service.start().ok, false);
      assert.equal(service.ready, false);
      assert.equal(service.create("1 分钟后提醒我新增").error, "store_unavailable");
      assert.equal(fs.readFileSync(filePath, "utf8"), original);
      if (failBackup) assert.equal(fs.existsSync(filePath + ".v1.bak"), false);
      if (failReplace) assert.equal(fs.readFileSync(filePath + ".v1.bak", "utf8"), original);
    } finally {
      service.dispose();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
  runFailureCase({ failBackup: true });
  runFailureCase({ failReplace: true });
});

test("invalid stores fail closed and preserve the original bytes", () => {
  const fixture = makeFixture();
  const original = "{broken json";
  fs.writeFileSync(fixture.filePath, original);
  try {
    assert.equal(fixture.service.start().ok, false);
    assert.equal(fixture.service.create("1 分钟后提醒我出发").error, "store_unavailable");
    assert.equal(fs.readFileSync(fixture.filePath, "utf8"), original);
    assert.equal(fs.existsSync(fixture.filePath + ".v1.bak"), false);
  } finally {
    fixture.service.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }

  const conflict = makeFixture();
  const v1 = { version: 1, reminders: [] };
  fs.writeFileSync(conflict.filePath, JSON.stringify(v1));
  fs.writeFileSync(conflict.filePath + ".v1.bak", "different prior backup");
  try {
    assert.equal(conflict.service.start().ok, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(conflict.filePath, "utf8")), v1);
  } finally {
    conflict.service.dispose();
    fs.rmSync(conflict.directory, { recursive: true, force: true });
  }
});

test("creation requires a bound recipient for Feishu and defaults to bubble plus system", () => {
  const fixture = makeFixture();
  try {
    assert.equal(fixture.service.start().ok, true);
    const defaultCreated = fixture.service.create("5 分钟后提醒我出门", "default-channel");
    assert.equal(defaultCreated.ok, true);
    assert.deepEqual(defaultCreated.reminder.channels, { bubble: true, system: true, feishu: false });
    const missingBinding = fixture.service.create({
      text: "5 分钟后提醒我出门",
      channels: { bubble: false, system: false, feishu: true },
    });
    assert.deepEqual(missingBinding, { ok: false, error: "feishu_binding_required" });
    assert.deepEqual(fixture.service.create({
      title: "出门",
      dueAt: fixture.clock.now() + 60_000,
      channels: { bubble: false, system: false, feishu: false },
    }), { ok: false, error: "channel_required" });
    assert.equal(bindFakeRecipient(fixture.service).ok, true);
    const selected = fixture.service.create({
      title: "出门",
      dueAt: fixture.clock.now() + 60_000,
      channels: { bubble: false, system: false, feishu: true },
    });
    assert.equal(selected.ok, true);
    assert.deepEqual(selected.reminder.channels, { bubble: false, system: false, feishu: true });
  } finally {
    fixture.service.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("edit uses revision CAS; cancellation and completion are terminal and idempotent", () => {
  const fixture = makeFixture();
  try {
    fixture.service.start();
    const first = fixture.service.create("20 分钟后提醒我出发", "edit-one");
    const current = first.reminder;
    const updated = fixture.service.update(current.id, {
      title: "提前出发",
      dueAt: fixture.clock.now() + 30 * 60_000,
      channels: { bubble: true, system: false, feishu: false },
    }, current.revision);
    assert.equal(updated.ok, true);
    assert.equal(updated.reminder.revision, current.revision + 1);
    assert.equal(updated.reminder.title, "提前出发");
    assert.equal(updated.reminder.dueAt, fixture.clock.now() + 30 * 60_000);
    assert.equal(fixture.service.update(current.id, { title: "旧页面", dueAt: updated.reminder.dueAt }, current.revision).error, "stale_revision");
    assert.equal(fixture.service.get(current.id).title, "提前出发");

    const cancelled = fixture.service.cancel(current.id, updated.reminder.revision);
    assert.equal(cancelled.ok, true);
    assert.equal(cancelled.reminder.status, STATUS.CANCELLED);
    assert.equal(cancelled.reminder.revision, updated.reminder.revision + 1);
    assert.equal(fixture.service.cancel(current.id, 1).duplicate, true);
    assert.equal(fixture.service.update(current.id, { title: "复活" }, cancelled.reminder.revision).error, "terminal");

    const second = fixture.service.create("25 分钟后提醒我接人", "complete-two");
    const completed = fixture.service.complete(second.reminder.id, second.reminder.revision);
    assert.equal(completed.reminder.status, STATUS.COMPLETED);
    assert.equal(completed.reminder.revision, second.reminder.revision + 1);
    assert.equal(fixture.service.complete(second.reminder.id, second.reminder.revision).duplicate, true);
    assert.equal(fixture.service.cancel(second.reminder.id, completed.reminder.revision).error, "terminal");
  } finally {
    fixture.service.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("due, snooze options and delivery acknowledgements preserve the semantic revision", () => {
  const fixture = makeFixture();
  try {
    fixture.service.start();
    bindFakeRecipient(fixture.service);
    const created = fixture.service.create({
      title: "出发",
      dueAt: fixture.clock.now() + 60_000,
      channels: { bubble: true, system: true, feishu: true },
    });
    const originalRevision = created.reminder.revision;
    assert.equal(fixture.service.setDelivery(created.reminder.id, "feishu", {
      status: "sent",
      attempts: 1,
      messageId: "fake-message-id",
    }).reminder.revision, originalRevision);
    fixture.clock.advance(60_000);
    assert.equal(fixture.due.length, 1);
    assert.equal(fixture.due[0].reminder.status, STATUS.PENDING);
    assert.equal(fixture.due[0].reminder.revision, originalRevision);
    const stale = fixture.service.snooze(created.reminder.id, 15, originalRevision - 1);
    assert.equal(stale.error, "stale_revision");
    const snoozed = fixture.service.snooze(created.reminder.id, 15, originalRevision);
    assert.equal(snoozed.ok, true);
    assert.equal(snoozed.reminder.status, STATUS.SNOOZED);
    assert.equal(snoozed.reminder.dueAt, fixture.clock.now() + 15 * 60_000);
    assert.equal(snoozed.reminder.revision, originalRevision + 1);
    fixture.clock.advance(15 * 60_000);
    assert.equal(fixture.service.get(created.reminder.id).status, STATUS.PENDING);
    assert.equal(fixture.service.get(created.reminder.id).revision, snoozed.reminder.revision);
    assert.equal(fixture.service.snooze(created.reminder.id, 5, snoozed.reminder.revision).error, "snooze_already_used");
    const file = JSON.parse(fs.readFileSync(fixture.filePath, "utf8"));
    assert.equal(file.reminders[0].delivery.feishu.messageId, "fake-message-id");
  } finally {
    fixture.service.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("all preset snooze durations are accepted and move the reminder from the current clock", () => {
  const fixture = makeFixture();
  try {
    fixture.service.start();
    const created = [5, 15, 60].map((minutes) => fixture.service.create({
      title: "稍后 " + String(minutes),
      dueAt: fixture.clock.now() + 60_000,
      channels: { bubble: true, system: false, feishu: false },
    }).reminder);
    fixture.clock.advance(60_000);
    for (let index = 0; index < created.length; index += 1) {
      const minutes = [5, 15, 60][index];
      const result = fixture.service.snooze(created[index].id, minutes, created[index].revision);
      assert.equal(result.ok, true);
      assert.equal(result.reminder.dueAt, fixture.clock.now() + minutes * 60_000);
    }
  } finally {
    fixture.service.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("ambiguous send retry keeps one attempt key across semantic edits and revisions", () => {
  const fixture = makeFixture();
  try {
    fixture.service.start();
    bindFakeRecipient(fixture.service);
    const created = fixture.service.create({
      title: "旧标题",
      dueAt: fixture.clock.now() + 60_000,
      channels: { bubble: false, system: false, feishu: true },
    });
    fixture.clock.advance(60_000);
    const firstAttempt = fixture.service.beginFeishuAttempt(created.reminder.id);
    assert.equal(firstAttempt.ok, true);
    const attemptKey = firstAttempt.reminder.delivery.feishu.attemptKey;
    fixture.service.setDelivery(created.reminder.id, "feishu", {
      status: "failed",
      attempts: firstAttempt.reminder.delivery.feishu.attempts,
      nextRetryAt: fixture.clock.now() + 30_000,
      error: "send_failed",
    });
    const edited = fixture.service.update(created.reminder.id, {
      title: "新标题",
      channels: { bubble: false, system: false, feishu: true },
    }, firstAttempt.reminder.revision);
    assert.equal(edited.ok, true);
    assert.equal(edited.reminder.revision, created.reminder.revision + 1);
    assert.equal(edited.reminder.delivery.feishu.attemptKey, attemptKey);
    assert.equal(edited.reminder.delivery.feishu.attemptRevision, created.reminder.revision);
    fixture.clock.advance(30_000);
    const retry = fixture.service.beginFeishuAttempt(created.reminder.id);
    assert.equal(retry.ok, true);
    assert.equal(retry.reminder.title, "新标题");
    assert.equal(retry.reminder.revision, edited.reminder.revision);
    assert.equal(retry.reminder.delivery.feishu.attemptKey, attemptKey);
    assert.equal(retry.reminder.delivery.feishu.attempts, 2);
  } finally {
    fixture.service.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("restart recovers interrupted delivery with bounded persisted retry and no immediate replay", () => {
  const fixture = makeFixture();
  fixture.service.start();
  bindFakeRecipient(fixture.service);
  const created = fixture.service.create({
    title: "重试",
    dueAt: fixture.clock.now() + 60_000,
    channels: { bubble: false, system: false, feishu: true },
  });
  fixture.clock.advance(60_000);
  const begun = fixture.service.beginFeishuAttempt(created.reminder.id);
  assert.equal(begun.ok, true);
  assert.match(begun.reminder.delivery.feishu.attemptKey, /^[a-f0-9]{32}$/);
  assert.equal(begun.reminder.delivery.feishu.attemptRevision, created.reminder.revision);
  const firstAttemptKey = begun.reminder.delivery.feishu.attemptKey;
  fixture.service.dispose();

  fixture.clock.advance(10_000);
  const recoveredRetries = [];
  const recovered = createReminderService({
    filePath: fixture.filePath,
    now: fixture.clock.now,
    setTimeout: fixture.clock.setTimeout,
    clearTimeout: fixture.clock.clearTimeout,
    onFeishuRetry: (reminder) => recoveredRetries.push(reminder),
  });
  try {
    assert.equal(recovered.start().ok, true);
    const recoveredReminder = recovered.get(created.reminder.id);
    assert.equal(recoveredReminder.delivery.feishu.status, "failed");
    assert.equal(recoveredReminder.delivery.feishu.attempts, 1);
    assert.equal(recoveredReminder.delivery.feishu.attemptKey, firstAttemptKey);
    assert.equal(recoveredReminder.delivery.feishu.nextRetryAt, fixture.clock.now() + RETRY_DELAYS_MS[0]);
    assert.equal(recoveredRetries.length, 0);
    fixture.clock.advance(RETRY_DELAYS_MS[0]);
    assert.equal(recoveredRetries.length, 1);
    assert.equal(recoveredRetries[0].revision, created.reminder.revision);
  } finally {
    recovered.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("completed reminders remain after restart and legacy request replay stays idempotent", () => {
  const fixture = makeFixture();
  try {
    fixture.service.start();
    const created = fixture.service.create("1 分钟后提醒我出发", "request-1");
    assert.equal(fixture.service.create("1 分钟后提醒我出发", "request-1").duplicate, true);
    const completed = fixture.service.complete(created.reminder.id, created.reminder.revision);
    assert.equal(completed.ok, true);
    const restarted = createReminderService({
      filePath: fixture.filePath,
      now: fixture.clock.now,
      setTimeout: fixture.clock.setTimeout,
      clearTimeout: fixture.clock.clearTimeout,
    });
    assert.equal(restarted.start().ok, true);
    assert.equal(restarted.get(created.reminder.id).status, STATUS.COMPLETED);
    assert.equal(restarted.list().length, 1);
    restarted.dispose();
  } finally {
    fixture.service.dispose();
    fs.rmSync(fixture.directory, { recursive: true, force: true });
  }
});
