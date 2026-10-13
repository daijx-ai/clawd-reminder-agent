"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createReminderAgent, resolveDataPaths, readAgentId } = require("../src/reminder-agent");

function makeFixture(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-agent-"));
  let now = options.now === undefined ? 1_800_000_000_000 : options.now;
  const scheduled = [];
  const cleared = [];
  const calls = [];
  let shouldFail = false;
  let nextId = 0;
  const paths = resolveDataPaths(home);
  const agent = createReminderAgent({
    paths,
    now: () => now,
    randomUUID: () => `reminder-${++nextId}`,
    setTimeout: (fn, delay) => {
      const timer = { fn, delay, unref() {} };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: (timer) => cleared.push(timer),
    retryDelays: options.retryDelays || [30_000, 120_000],
    client: {
      async notify(input) {
        calls.push(input);
        if (shouldFail) {
          const error = new Error("transport detail is not persisted");
          error.code = "ECONNREFUSED";
          throw error;
        }
        return { ok: true, statusCode: 200 };
      },
    },
    log: () => {},
  });
  const started = agent.start();
  assert.equal(started.ok, true);
  return {
    agent,
    calls,
    cleared,
    home,
    paths,
    scheduled,
    setNow(value) { now = value; },
    setShouldFail(value) { shouldFail = value; },
    cleanup() {
      agent.stop();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function makeFakeClock(initial) {
  let current = initial;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(fn, delay) {
      const timer = { id: ++nextId, at: current + delay, fn, unref() {} };
      timers.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timers.delete(timer.id);
    },
    async advance(ms) {
      const target = current + ms;
      let turns = 0;
      while (true) {
        const next = Array.from(timers.values())
          .filter((timer) => timer.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        if (++turns > 100) throw new Error("fake clock runaway");
        timers.delete(next.id);
        current = next.at;
        next.fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      current = target;
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("agent stores only the custom ID and sends a due reminder once", async () => {
  const fixture = makeFixture();
  try {
    const bound = await fixture.agent.setAgentId("custom-reminders-0123456789ab");
    assert.equal(bound.ok, true);
    assert.equal(readAgentId(fixture.paths.configPath), "custom-reminders-0123456789ab");

    const created = fixture.agent.service.create({
      title: "休息一下",
      dueAt: 1_800_000_001_000,
      channels: { bubble: true, system: false, feishu: false },
    });
    assert.equal(created.ok, true);
    fixture.setNow(created.reminder.dueAt);

    const sent = await fixture.agent.notifyDue(created.reminder.id, created.reminder.revision);
    assert.equal(sent.ok, true);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].reminder.title, "休息一下");
    assert.equal(fixture.agent.service.get(created.reminder.id).delivery.bubble.status, "sent");

    const duplicate = await fixture.agent.notifyDue(created.reminder.id, created.reminder.revision);
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(fixture.calls.length, 1);

    if (process.platform !== "win32") {
      assert.equal(fs.statSync(fixture.paths.configPath).mode & 0o777, 0o600);
      assert.equal(fs.statSync(fixture.paths.dataDir).mode & 0o777, 0o700);
    }
  } finally {
    fixture.cleanup();
  }
});

test("agent retries loopback failures and stores only a bounded error code", async () => {
  const fixture = makeFixture();
  try {
    await fixture.agent.setAgentId("custom-reminders-0123456789ab");
    const created = fixture.agent.service.create({
      title: "出门",
      dueAt: 1_800_000_002_000,
      channels: { bubble: true, system: false, feishu: false },
    });
    fixture.setNow(created.reminder.dueAt);
    fixture.setShouldFail(true);

    const failed = await fixture.agent.notifyDue(created.reminder.id, created.reminder.revision);
    assert.equal(failed.ok, false);
    const stored = fixture.agent.service.get(created.reminder.id).delivery.bubble;
    assert.equal(stored.status, "failed");
    assert.equal(stored.attempts, 1);
    assert.equal(stored.error, "econnrefused");
    assert.equal(stored.error.includes("transport detail"), false);
    assert.equal(stored.nextRetryAt, fixture.agent.service.get(created.reminder.id).dueAt + 30_000);

    fixture.setShouldFail(false);
    fixture.setNow(stored.nextRetryAt);
    const retry = await fixture.agent.notifyDue(created.reminder.id, created.reminder.revision);
    assert.equal(retry.ok, true);
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.agent.service.get(created.reminder.id).delivery.bubble.status, "sent");
    assert.ok(fixture.cleared.length > 0);
  } finally {
    fixture.cleanup();
  }
});

test("agent stop waits for an in-flight delivery and blocks later writes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-stop-"));
  const paths = resolveDataPaths(home);
  let now = 1_800_000_000_000;
  let resolveDelivery;
  let signalStarted;
  const deliveryStarted = new Promise((resolve) => { signalStarted = resolve; });
  const agent = createReminderAgent({
    paths,
    now: () => now,
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
    client: {
      notify() {
        signalStarted();
        return new Promise((resolve) => { resolveDelivery = resolve; });
      },
    },
    log: () => {},
  });
  try {
    assert.equal(agent.start().ok, true);
    assert.equal((await agent.setAgentId("custom-reminders-0123456789ab")).ok, true);
    const created = agent.service.create({
      title: "交接提醒",
      dueAt: now + 1_000,
      channels: { bubble: true, system: false, feishu: false },
    });
    now = created.reminder.dueAt;

    const delivery = agent.notifyDue(created.reminder.id, created.reminder.revision);
    await deliveryStarted;
    let stopped = false;
    const stop = agent.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stopped, false, "stop must retain ownership while the client request is unresolved");
    assert.deepEqual(
      await agent.notifyDue(created.reminder.id, created.reminder.revision),
      { ok: false, error: "agent_stopped" },
    );

    resolveDelivery({ ok: true, statusCode: 200 });
    await Promise.all([delivery, stop]);
    assert.equal(agent.service.get(created.reminder.id).delivery.bubble.status, "sent");
    const saved = JSON.parse(fs.readFileSync(paths.storePath, "utf8"));
    assert.equal(saved.reminders.length, 1);
    assert.equal(saved.reminders[0].delivery.bubble.status, "sent");
  } finally {
    if (resolveDelivery) resolveDelivery({ ok: true, statusCode: 200 });
    await agent.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("restart preserves delivery backoff and the manual retry command can override it", async () => {
  const fixture = makeFixture();
  let restartedAgent;
  let retryCalls = 0;
  const restartTimers = [];
  try {
    await fixture.agent.setAgentId("custom-reminders-0123456789ab");
    const created = fixture.agent.service.create({
      title: "出发",
      dueAt: 1_800_000_004_000,
      channels: { bubble: true, system: false, feishu: false },
    });
    fixture.setNow(created.reminder.dueAt);
    fixture.setShouldFail(true);
    await fixture.agent.notifyDue(created.reminder.id, created.reminder.revision);
    const failed = fixture.agent.service.get(created.reminder.id).delivery.bubble;
    fixture.agent.stop();

    restartedAgent = createReminderAgent({
      paths: fixture.paths,
      now: () => fixture.agent.service.get(created.reminder.id).dueAt,
      setTimeout: (fn, delay) => {
        const timer = { fn, delay, unref() {} };
        restartTimers.push(timer);
        return timer;
      },
      clearTimeout: () => {},
      client: { async notify() { retryCalls += 1; return { ok: true, statusCode: 200 }; } },
      log: () => {},
    });
    assert.equal(restartedAgent.start().ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(retryCalls, 0, "persisted backoff is not bypassed on restart");
    assert.ok(restartTimers.some((timer) => timer.delay === failed.nextRetryAt - created.reminder.dueAt));

    const manual = await restartedAgent.retryDue();
    assert.equal(manual.length, 1);
    assert.equal(manual[0].ok, true);
    assert.equal(retryCalls, 1);
  } finally {
    if (restartedAgent) restartedAgent.stop();
    fixture.cleanup();
  }
});

test("binding an agent after a reminder becomes due immediately retries it", async () => {
  const fixture = makeFixture();
  try {
    const created = fixture.agent.service.create({
      title: "开会",
      dueAt: 1_800_000_003_000,
      channels: { bubble: true, system: false, feishu: false },
    });
    fixture.setNow(created.reminder.dueAt);
    assert.deepEqual(
      await fixture.agent.notifyDue(created.reminder.id, created.reminder.revision),
      { ok: false, error: "agent_id_required" },
    );
    const bound = await fixture.agent.setAgentId("custom-reminders-0123456789ab");
    assert.equal(bound.ok, true);
    assert.equal(bound.retried.length, 1);
    assert.equal(fixture.calls.length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("scheduled reminder delivery reaches the Clawd client when the service timer fires", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-scheduler-"));
  const clock = makeFakeClock(1_800_000_000_000);
  const paths = resolveDataPaths(home);
  let resolveRequest;
  const requestReceived = new Promise((resolve) => { resolveRequest = resolve; });
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const result = {
        method: request.method,
        host: request.headers.host,
        origin: request.headers.origin,
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.writeHead(200);
      response.end("ok");
      resolveRequest(result);
    });
  });
  let agent;
  let timeoutHandle;
  try {
    const port = await listen(server);
    fs.mkdirSync(path.dirname(paths.runtimePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.runtimePath, JSON.stringify({ app: "clawd-on-desk", port }));
    agent = createReminderAgent({
      paths,
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      allowedPorts: [port],
      log: () => {},
    });
    assert.equal(agent.start().ok, true);
    await agent.setAgentId("custom-reminders-0123456789ab");
    const created = agent.service.create({
      title: "开会",
      dueAt: clock.now() + 1_000,
      channels: { bubble: true, system: false, feishu: false },
    });
    assert.equal(created.ok, true);

    await clock.advance(1_000);
    const timeout = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("request_timeout")), 2_000);
    });
    const received = await Promise.race([requestReceived, timeout]);
    clearTimeout(timeoutHandle);
    for (let attempt = 0; attempt < 10
      && agent.service.get(created.reminder.id).delivery.bubble.status !== "sent"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(received.method, "POST");
    assert.equal(received.host, `127.0.0.1:${port}`);
    assert.equal(received.origin, undefined);
    assert.deepEqual(received.payload, {
      agent_id: "custom-reminders-0123456789ab",
      session_id: `reminder-${created.reminder.id}`,
      state: "notification",
      event: "Notification",
      tool_name: "开会",
    });
    assert.equal(agent.service.get(created.reminder.id).delivery.bubble.status, "sent");
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (agent) agent.stop();
    await close(server);
    fs.rmSync(home, { recursive: true, force: true });
  }
});
