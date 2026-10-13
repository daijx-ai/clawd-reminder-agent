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
    fs.writeFileSync(runtimePath, JSON.stringify({ app: "other-app", port: 23333 }));
    assert.throws(() => readClawdRuntime({ runtimePath, allowedPorts: [23333] }), { code: "clawd_runtime_invalid" });
    fs.writeFileSync(runtimePath, JSON.stringify({ app: "clawd-on-desk", port: 23334 }));
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
        host: request.headers.host,
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
    fs.writeFileSync(runtimePath, JSON.stringify({ app: "clawd-on-desk", port }));
    const client = createClawdStateClient({ runtimePath, allowedPorts: [port] });
    const result = await client.notify({
      agentId: "custom-reminders-0123456789ab",
      reminder: { id: "123", title: "休息一下" },
    });

    assert.deepEqual(result, { ok: true, statusCode: 200 });
    assert.equal(received.method, "POST");
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
    fs.writeFileSync(runtimePath, JSON.stringify({ app: "clawd-on-desk", port }));
    const client = createClawdStateClient({ runtimePath, allowedPorts: [port] });
    await assert.rejects(client.notify({
      agentId: "custom-reminders-0123456789ab",
      reminder: { id: "123", title: "提醒" },
    }), { code: "clawd_http_204" });
  } finally {
    await close(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
