"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  createClawdStateClient,
  isValidCustomAgentId,
  readClawdRuntime,
} = require("../src/clawd-state-client");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "clawd-reminder-client-"));
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


function writeTrustedRuntime(runtimePath, value) {
  fs.writeFileSync(runtimePath, JSON.stringify(value), { mode: 0o600 });
}

test("custom agent IDs are validated before any request", () => {
  assert.equal(isValidCustomAgentId("custom-reminders-0123456789ab"), true);
  assert.equal(isValidCustomAgentId("custom-../wrong"), false);
  assert.equal(isValidCustomAgentId("my-agent"), false);
});

test("runtime discovery rejects missing identity, malformed content, and unapproved ports", () => {
  const directory = makeTempDir();
  const runtimePath = path.join(directory, "runtime.json");
  try {
    assert.throws(() => readClawdRuntime({ runtimePath, allowedPorts: [23333] }), { code: "clawd_runtime_missing" });
    writeTrustedRuntime(runtimePath, { app: "other-app", port: 23333 });
    assert.throws(() => readClawdRuntime({ runtimePath, allowedPorts: [23333] }), { code: "clawd_runtime_invalid" });
    writeTrustedRuntime(runtimePath, { app: "clawd-on-desk", port: 23334 });
    assert.throws(() => readClawdRuntime({ runtimePath, allowedPorts: [23333] }), { code: "clawd_runtime_invalid" });
    fs.writeFileSync(runtimePath, "{");
    assert.throws(() => readClawdRuntime({ runtimePath, allowedPorts: [23333] }), { code: "clawd_runtime_invalid" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("notification posts only a local state event with the reminder title", async () => {
  const directory = makeTempDir();
  const runtimePath = path.join(directory, "runtime.json");
  let received = null;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        method: request.method,
        path: request.url,
        host: request.headers.host,
        headerNames: request.rawHeaders.filter((_value, index) => index % 2 === 0).map((name) => name.toLowerCase()),
        origin: request.headers.origin,
        contentType: request.headers["content-type"],
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
  });
  try {
    const port = await listen(server);
    writeTrustedRuntime(runtimePath, { app: "clawd-on-desk", port });
    const client = createClawdStateClient({ runtimePath });
    const result = await client.notify({
      agentId: "custom-reminders-0123456789ab",
      reminder: { id: "123", title: "休息一下" },
    });

    assert.deepEqual(result, { ok: true, statusCode: 200 });
    assert.equal(received.method, "POST");
    assert.equal(received.path, "/state");
    assert.equal(received.headerNames.filter((name) => name === "host").length, 1);
    assert.equal(received.headerNames.filter((name) => name === "content-type").length, 1);
    assert.equal(received.origin, undefined);
    assert.equal(received.contentType, "application/json");
    assert.equal(received.host, `127.0.0.1:${port}`);
    assert.deepEqual(received.payload, {
      agent_id: "custom-reminders-0123456789ab",
      session_id: "reminder-123",
      state: "notification",
      event: "Notification",
      tool_name: "休息一下",
    });
    assert.equal(Object.keys(received.payload).some((key) => /token|secret|cwd|prompt/i.test(key)), false);
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a disabled or missing custom agent is reported as an unaccepted event", async () => {
  const directory = makeTempDir();
  const runtimePath = path.join(directory, "runtime.json");
  const server = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  try {
    const port = await listen(server);
    writeTrustedRuntime(runtimePath, { app: "clawd-on-desk", port });
    const client = createClawdStateClient({ runtimePath });
    await assert.rejects(client.notify({
      agentId: "custom-reminders-0123456789ab",
      reminder: { id: "123", title: "提醒" },
    }), { code: "clawd_http_204" });
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("default discovery accepts legacy, dynamic, and canonical decimal string ports", () => {
  const directory = makeTempDir();
  const runtimePath = path.join(directory, "runtime.json");
  try {
    for (const port of [1, 23333, 23334, 23337, 49152, 65535, "1", "23333", "49152", "65535"]) {
      writeTrustedRuntime(runtimePath, { app: "clawd-on-desk", port, ownerPid: process.pid });
      assert.deepEqual(readClawdRuntime({ runtimePath }), {
        app: "clawd-on-desk",
        port: Number(port),
      }, "port: " + String(port));
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("default discovery rejects invalid port formats and forged app identities", async () => {
  const directory = makeTempDir();
  const runtimePath = path.join(directory, "runtime.json");
  let requests = 0;
  const client = createClawdStateClient({
    runtimePath,
    request: async () => {
      requests += 1;
      return { statusCode: 200 };
    },
  });
  const input = { agentId: "custom-reminders-0123456789ab", reminder: { id: "123", title: "私密提醒" } };
  try {
    const invalid = [0, -1, 65536, 2.2, null, true, false, [], {}, "", "0", "00", "023333",
      "65536", "-1", "+3", " 23333", "23333 ", "1.0", "1e2", "0x5b15", "１２３", "01"];
    for (const port of invalid) {
      writeTrustedRuntime(runtimePath, { app: "clawd-on-desk", port });
      assert.throws(() => readClawdRuntime({ runtimePath }), { code: "clawd_runtime_invalid" }, String(port));
      await assert.rejects(client.notify(input), { code: "clawd_runtime_invalid" });
    }
    writeTrustedRuntime(runtimePath, { app: "not-clawd", port: 49152 });
    await assert.rejects(client.notify(input), { code: "clawd_runtime_invalid" });
    assert.equal(requests, 0, "never send reminder content to invalid/forged runtime");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime cannot override loopback destination even with a valid dynamic port", async () => {
  const directory = makeTempDir();
  const runtimePath = path.join(directory, "runtime.json");
  let optionsSeen;
  try {
    writeTrustedRuntime(runtimePath, {
      app: "clawd-on-desk", port: "49152", ownerPid: process.pid,
      host: "attacker.example", url: "http://attacker.example/state",
    });
    const client = createClawdStateClient({
      runtimePath,
      request: async (options) => {
        optionsSeen = options;
        return { statusCode: 200 };
      },
    });
    await client.notify({ agentId: "custom-reminders-0123456789ab", reminder: { id: "7", title: "提醒" } });
    assert.deepEqual(Object.keys(optionsSeen).sort(), ["payload", "port", "timeoutMs"]);
    assert.equal(optionsSeen.port, 49152);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime file must be a regular owner-only file on POSIX", { skip: process.platform === "win32" }, () => {
  const directory = makeTempDir();
  const runtimePath = path.join(directory, "runtime.json");
  const linkedPath = path.join(directory, "linked.json");
  try {
    writeTrustedRuntime(linkedPath, { app: "clawd-on-desk", port: 49152 });
    fs.symlinkSync(linkedPath, runtimePath);
    assert.throws(() => readClawdRuntime({ runtimePath }), { code: "clawd_runtime_invalid" });
    fs.unlinkSync(runtimePath);
    writeTrustedRuntime(runtimePath, { app: "clawd-on-desk", port: 49152 });
    fs.chmodSync(runtimePath, 0o644);
    assert.throws(() => readClawdRuntime({ runtimePath }), { code: "clawd_runtime_invalid" });
    fs.chmodSync(runtimePath, 0o600);
    assert.equal(readClawdRuntime({ runtimePath }).port, 49152);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("one client rereads runtime after a Clawd restart and follows the new dynamic port", async () => {
  const directory = makeTempDir();
  const runtimePath = path.join(directory, "runtime.json");
  const received = [];
  function fakeClawd(name) {
    return http.createServer((request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        received.push({ name, host: request.headers.host, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        response.writeHead(200);
        response.end("ok");
      });
    });
  }
  const before = fakeClawd("before");
  const after = fakeClawd("after");
  try {
    const oldPort = await listen(before);
    const newPort = await listen(after);
    assert.notEqual(oldPort, newPort);
    const client = createClawdStateClient({ runtimePath, timeoutMs: 500 });
    writeTrustedRuntime(runtimePath, { app: "clawd-on-desk", port: oldPort });
    await client.notify({ agentId: "custom-reminders-0123456789ab", reminder: { id: "first", title: "第一次" } });
    await close(before);
    await assert.rejects(client.notify({
      agentId: "custom-reminders-0123456789ab", reminder: { id: "stale", title: "不会投递" },
    }), (error) => ["econnrefused", "econnreset"].includes(error.code));
    writeTrustedRuntime(runtimePath, { app: "clawd-on-desk", port: String(newPort) });
    await client.notify({ agentId: "custom-reminders-0123456789ab", reminder: { id: "second", title: "第二次" } });
    assert.deepEqual(received.map((item) => item.name), ["before", "after"]);
    assert.deepEqual(received.map((item) => item.body.tool_name), ["第一次", "第二次"]);
    assert.deepEqual(received.map((item) => item.host), ["127.0.0.1:" + oldPort, "127.0.0.1:" + newPort]);
  } finally {
    if (before.listening) await close(before);
    if (after.listening) await close(after);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
