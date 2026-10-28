"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createLaunchAgentManager, LABEL, renderPlist } = require("../src/launch-agent");

test("LaunchAgent install/start/stop/disable/uninstall are idempotent and keep reminder data", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-launchctl-"));
  const calls = [];
  let loaded = false;
  let disabled = false;
  const run = (args) => {
    calls.push(args);
    const action = args[0];
    if (action === "print") return { status: loaded ? 0 : 113, stderr: loaded ? "" : "not found" };
    if (action === "enable") disabled = false;
    if (action === "disable") disabled = true;
    if (action === "bootstrap") { assert.equal(disabled, false); loaded = true; }
    if (action === "bootout") loaded = false;
    return { status: 0 };
  };
  const opts = { platform: "darwin", uid: 501, home, nodePath: "/absolute/node",
    scriptPath: "/tmp/Clawd & Friends/bin/clawd-reminders.js", run };
  const manager = createLaunchAgentManager(opts);
  try {
    const saved = manager.install();
    assert.equal(saved.unchanged, false);
    assert.equal(manager.install().unchanged, true);
    const plist = fs.readFileSync(saved.plist, "utf8");
    assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
    assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(plist, /Clawd &amp; Friends/);
    assert.match(plist, /<string>daemon<\/string>/);
    assert.equal(fs.statSync(path.join(home, ".clawd-reminders")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(saved.plist).mode & 0o777, 0o600);
    assert.deepEqual(manager.status(), { installed: true, loaded: false, plist: saved.plist });
    assert.equal(manager.start().alreadyRunning, false);
    assert.equal(manager.start().alreadyRunning, true);
    assert.equal(calls.filter((entry) => entry[0] === "bootstrap").length, 1);
    assert.equal(manager.stop().alreadyStopped, false);
    assert.equal(manager.stop().alreadyStopped, true);
    manager.start();
    manager.disable();
    assert.equal(disabled, true);
    assert.equal(loaded, false);
    manager.start();
    assert.equal(disabled, false, "explicit start re-enables disabled job");
    assert.equal(loaded, true);
    fs.writeFileSync(path.join(home, ".clawd-reminders", "reminders.json"), "user data");
    manager.uninstall();
    manager.uninstall();
    assert.equal(fs.existsSync(saved.plist), false);
    assert.equal(fs.readFileSync(path.join(home, ".clawd-reminders", "reminders.json"), "utf8"), "user data");
    assert.ok(calls.some((entry) => entry[0] === "bootout" && entry[1] === `gui/501/${LABEL}`));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("LaunchAgent rejects arbitrary existing plist and changed executable paths", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-plist-"));
  const opts = { platform: "darwin", uid: 501, home, nodePath: "/absolute/node", scriptPath: "/tmp/app/bin/clawd-reminders.js",
    run: () => ({ status: 113 }) };
  try {
    const manager = createLaunchAgentManager(opts);
    manager.install();
    assert.throws(() => createLaunchAgentManager({ ...opts, nodePath: "/new/node" }).install(),
      { code: "launch_agent_plist_changed_reinstall_required" });
    fs.writeFileSync(manager.plist, "<plist>unmanaged</plist>");
    assert.throws(() => manager.uninstall(), { code: "launch_agent_plist_unmanaged" });
    fs.unlinkSync(manager.plist);
    fs.symlinkSync(path.join(home, "fake"), manager.plist);
    assert.throws(() => manager.install(), { code: "launch_agent_plist_unsafe" });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("LaunchAgent refuses group/world-writable registration directory and plist", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-perms-"));
  const dir = path.join(home, "Library", "LaunchAgents");
  const manager = createLaunchAgentManager({
    platform: "darwin", uid: process.getuid(), home,
    nodePath: "/absolute/node", scriptPath: "/absolute/app/bin/clawd-reminders.js",
    run: (args) => ({ status: args[0] === "print" ? 113 : 0 }),
  });
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o777);
    assert.throws(() => manager.install(), { code: "launch_agent_directory_unsafe" });
    assert.equal(fs.existsSync(manager.plist), false);

    fs.chmodSync(dir, 0o700);
    const { plist } = manager.install();
    fs.chmodSync(dir, 0o777);
    assert.throws(() => manager.start(), { code: "launch_agent_directory_unsafe" });
    fs.chmodSync(dir, 0o700);
    fs.chmodSync(plist, 0o666);
    assert.throws(() => manager.start(), { code: "launch_agent_plist_unsafe" });
    assert.throws(() => manager.install(), { code: "launch_agent_plist_unsafe" });

    fs.chmodSync(plist, 0o600);
    assert.equal(manager.start().loaded, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("service management is gated to a macOS user session and launchctl errors propagate", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-platform-"));
  try {
    const options = { home, uid: 501, nodePath: "/abs/node", scriptPath: "/abs/app/bin/clawd-reminders.js" };
    assert.throws(() => createLaunchAgentManager({ ...options, platform: "linux" }).install(),
      { code: "launch_agent_requires_macos_user_session" });
    const manager = createLaunchAgentManager({ ...options, platform: "darwin", run(args) {
      if (args[0] === "print") return { status: 113 };
      return { status: 1, stderr: "GUI session unavailable" };
    } });
    manager.install();
    assert.throws(() => manager.start(), { code: "launchctl_failed" });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("rendered XML validates with macOS plutil (no persistent launchctl changes)",
  { skip: process.platform !== "darwin" ? "macOS plutil required" : false }, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-plutil-"));
    try {
      const file = path.join(home, "test.plist");
      fs.writeFileSync(file, renderPlist({ nodePath: "/absolute/node",
        scriptPath: "/tmp/Clawd & Friends/bin/clawd-reminders.js", home }));
      const result = spawnSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
