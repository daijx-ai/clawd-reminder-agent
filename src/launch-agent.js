"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LABEL = "com.clawd.reminder-agent";

function errorWithCode(code, detail = "") {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function renderPlist({ nodePath, scriptPath, home }) {
  const dataDir = path.join(home, ".clawd-reminders");
  const str = (value) => `<string>${escapeXml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Managed by clawd-reminder-agent: uninstall with 'service uninstall'. -->
<plist version="1.0">
<dict>
  <key>Label</key>${str(LABEL)}
  <key>ProgramArguments</key><array>${str(nodePath)}${str(scriptPath)}${str("daemon")}</array>
  <key>WorkingDirectory</key>${str(path.dirname(path.dirname(scriptPath)))}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key>${str(path.join(dataDir, "daemon.log"))}
  <key>StandardErrorPath</key>${str(path.join(dataDir, "daemon.err.log"))}
</dict>
</plist>
`;
}

function createLaunchAgentManager(options = {}) {
  const platform = options.platform || process.platform;
  const home = options.home || os.homedir();
  const nodePath = options.nodePath || process.execPath;
  const scriptPath = options.scriptPath || fs.realpathSync(path.join(__dirname, "..", "bin", "clawd-reminders.js"));
  const uid = options.uid === undefined ? process.getuid && process.getuid() : options.uid;
  const run = options.run || ((args) => spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: 15_000 }));
  const plist = path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
  const domain = `gui/${uid}`;
  const target = `${domain}/${LABEL}`;

  function guard() {
    if (platform !== "darwin" || !Number.isSafeInteger(uid) || uid < 0
      || !path.isAbsolute(home) || !path.isAbsolute(nodePath) || !path.isAbsolute(scriptPath)) {
      throw errorWithCode("launch_agent_requires_macos_user_session");
    }
  }

  function call(args, allowFailure = false) {
    const result = run(args);
    if (result.error) throw errorWithCode("launchctl_unavailable", result.error.message);
    if (result.status !== 0 && !allowFailure) {
      throw errorWithCode("launchctl_failed", `${args[0]}: ${(result.stderr || result.stdout || "unknown failure").trim()}`);
    }
    return result;
  }

  function existingPlist() {
    let stat;
    try { stat = fs.lstatSync(plist); } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) {
      throw errorWithCode("launch_agent_plist_unsafe");
    }
    const content = fs.readFileSync(plist, "utf8");
    if (!content.includes("<!-- Managed by clawd-reminder-agent:")) {
      throw errorWithCode("launch_agent_plist_unmanaged");
    }
    return content;
  }

  function installed() { return existingPlist() !== null; }
  function loaded() { return call(["print", target], true).status === 0; }

  function install() {
    guard();
    const content = renderPlist({ nodePath, scriptPath, home });
    const existing = existingPlist();
    if (existing !== null) {
      if (existing !== content) throw errorWithCode("launch_agent_plist_changed_reinstall_required");
      return { installed: true, unchanged: true, plist };
    }
    const dir = path.dirname(plist);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const info = fs.lstatSync(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw errorWithCode("launch_agent_directory_unsafe");
    const dataDir = path.join(home, ".clawd-reminders");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dataStat = fs.lstatSync(dataDir);
    if (!dataStat.isDirectory() || dataStat.isSymbolicLink()
      || (process.getuid && dataStat.uid !== process.getuid())) {
      throw errorWithCode("launch_agent_data_directory_unsafe");
    }
    fs.chmodSync(dataDir, 0o700);
    const temporary = `${plist}.tmp-${process.pid}-${require("node:crypto").randomBytes(6).toString("hex")}`;
    try {
      fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, plist);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    return { installed: true, unchanged: false, plist };
  }

  function start() {
    guard();
    if (!installed()) throw errorWithCode("launch_agent_not_installed");
    call(["enable", target]);
    if (loaded()) return { loaded: true, alreadyRunning: true };
    call(["bootstrap", domain, plist]);
    return { loaded: true, alreadyRunning: false };
  }

  function stop() {
    guard();
    if (!loaded()) return { loaded: false, alreadyStopped: true };
    call(["bootout", target]);
    return { loaded: false, alreadyStopped: false };
  }

  function disable() {
    guard();
    stop();
    call(["disable", target]);
    return { disabled: true };
  }

  function uninstall() {
    guard();
    stop();
    if (installed()) fs.unlinkSync(plist);
    // launchd remembers disabled overrides independently of the plist.
    call(["enable", target]);
    return { uninstalled: true, dataPreserved: true };
  }

  function status() {
    guard();
    return { installed: installed(), loaded: loaded(), plist };
  }

  return Object.freeze({ install, start, stop, disable, uninstall, status, plist, target });
}

module.exports = { LABEL, renderPlist, createLaunchAgentManager };
