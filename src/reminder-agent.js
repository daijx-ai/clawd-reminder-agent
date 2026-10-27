"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  RETRY_DELAYS_MS,
  STATUS,
  createReminderService,
} = require("./reminder-service");
const {
  createClawdStateClient,
  isValidCustomAgentId,
} = require("./clawd-state-client");

function resolveDataPaths(home = os.homedir()) {
  const dataDir = path.join(home, ".clawd-reminders");
  return Object.freeze({
    dataDir,
    storePath: path.join(dataDir, "reminders.json"),
    configPath: path.join(dataDir, "config.json"),
    lockPath: path.join(dataDir, "agent.lock"),
    socketPath: path.join(dataDir, "control.sock"),
    runtimePath: path.join(home, ".clawd", "runtime.json"),
  });
}

function makeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readAgentId(configPath, fsImpl = fs) {
  let value;
  try {
    value = JSON.parse(fsImpl.readFileSync(configPath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw makeError("config_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => key !== "agentId")
    || !isValidCustomAgentId(value.agentId)) {
    throw makeError("config_invalid");
  }
  return value.agentId;
}

function writeAgentId(configPath, agentId, options = {}) {
  if (!isValidCustomAgentId(agentId)) throw makeError("agent_id_invalid");
  const fsImpl = options.fs || fs;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const parent = path.dirname(configPath);
  fsImpl.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const tempPath = `${configPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let renamed = false;
  try {
    fsImpl.writeFileSync(tempPath, `${JSON.stringify({ agentId }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try { fsImpl.chmodSync(tempPath, 0o600); } catch {}
    fsImpl.renameSync(tempPath, configPath);
    renamed = true;
    try { fsImpl.chmodSync(configPath, 0o600); } catch {}
  } finally {
    if (!renamed) {
      try { fsImpl.unlinkSync(tempPath); } catch {}
    }
  }
}

function normalizeErrorCode(error) {
  const code = error && typeof error.code === "string" ? error.code.toLowerCase() : "delivery_failed";
  return /^[a-z0-9_]{1,128}$/.test(code) ? code : "delivery_failed";
}

function createReminderAgent(options = {}) {
  const paths = options.paths || resolveDataPaths(options.home);
  const fsImpl = options.fs || fs;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const retryDelays = Array.isArray(options.retryDelays) && options.retryDelays.length
    ? options.retryDelays.filter((delay) => Number.isSafeInteger(delay) && delay > 0)
    : RETRY_DELAYS_MS;
  const retrySchedule = retryDelays.length ? retryDelays : RETRY_DELAYS_MS;
  const log = typeof options.log === "function" ? options.log : () => {};
  const timers = new Map();
  const inFlight = new Set();
  const pendingDeliveries = new Set();
  let agentId = isValidCustomAgentId(options.agentId) ? options.agentId : null;
  let configError = null;
  let stopping = false;
  let stopPromise = null;

  if (!agentId) {
    try {
      agentId = readAgentId(paths.configPath, fsImpl);
    } catch (error) {
      configError = normalizeErrorCode(error);
    }
  }

  const client = options.client || createClawdStateClient({
    runtimePath: paths.runtimePath,
    fs: fsImpl,
    timeoutMs: options.timeoutMs,
    allowedPorts: options.allowedPorts,
    request: options.request,
  });
  let service;

  function retryKey(id, revision) {
    return `${id}:${revision}`;
  }

  function clearRetry(id, revision) {
    const key = retryKey(id, revision);
    const timer = timers.get(key);
    if (timer) clearTimeoutFn(timer);
    timers.delete(key);
  }

  function scheduleRetry(reminder, delay) {
    const key = retryKey(reminder.id, reminder.revision);
    clearRetry(reminder.id, reminder.revision);
    const timer = setTimeoutFn(() => {
      timers.delete(key);
      void notifyDue(reminder.id, reminder.revision);
    }, delay);
    if (timer && typeof timer.unref === "function") timer.unref();
    timers.set(key, timer);
  }

  async function deliverDue(reminderOrId, expectedRevision, notifyOptions = {}) {
    const id = typeof reminderOrId === "string" ? reminderOrId : reminderOrId && reminderOrId.id;
    if (typeof id !== "string" || !id) return { ok: false, error: "reminder_invalid" };
    const current = service && service.get(id);
    if (!current) return { ok: false, error: "not_found" };
    if (Number.isSafeInteger(expectedRevision) && current.revision !== expectedRevision) {
      return { ok: false, error: "stale_revision" };
    }
    if (current.status === STATUS.COMPLETED || current.status === STATUS.CANCELLED) {
      return { ok: false, error: "terminal" };
    }
    const currentNow = Number(now());
    if (!Number.isFinite(currentNow)) return { ok: false, error: "clock_invalid" };
    if (current.dueAt > currentNow) return { ok: false, error: "not_due" };
    if (current.delivery.bubble.status === "sent") return { ok: true, duplicate: true };
    if (!agentId) return { ok: false, error: configError || "agent_id_required" };
    if (notifyOptions.force !== true
      && current.delivery.bubble.status === "failed"
      && Number.isSafeInteger(current.delivery.bubble.nextRetryAt)
      && current.delivery.bubble.nextRetryAt > currentNow) {
      scheduleRetry(current, current.delivery.bubble.nextRetryAt - currentNow);
      return { ok: false, error: "retry_not_due", nextRetryAt: current.delivery.bubble.nextRetryAt };
    }

    const key = retryKey(current.id, current.revision);
    if (inFlight.has(key)) return { ok: true, duplicate: true };
    inFlight.add(key);
    const attempts = current.delivery.bubble.attempts + 1;
    try {
      const begun = service.setDelivery(current.id, "bubble", {
        status: "sending",
        attempts,
        nextRetryAt: null,
        error: "",
      });
      if (!begun.ok) return begun;
      await client.notify({ agentId, reminder: current });
      const latest = service.get(current.id);
      if (latest && latest.revision === current.revision
        && latest.status !== STATUS.COMPLETED && latest.status !== STATUS.CANCELLED) {
        const saved = service.setDelivery(current.id, "bubble", {
          status: "sent",
          attempts,
          nextRetryAt: null,
          error: "",
        });
        if (!saved.ok) return saved;
      }
      clearRetry(current.id, current.revision);
      try { log(`Sent reminder notification for ${current.id}.`); } catch {}
      return { ok: true, reminder: service.get(current.id) };
    } catch (error) {
      const latest = service.get(current.id);
      if (!latest || latest.revision !== current.revision
        || latest.status === STATUS.COMPLETED || latest.status === STATUS.CANCELLED) {
        return { ok: false, error: "stale_revision" };
      }
      const retryIndex = Math.min(attempts - 1, retrySchedule.length - 1);
      const delay = retrySchedule[retryIndex];
      const errorCode = normalizeErrorCode(error);
      const nextRetryAt = Number(now()) + delay;
      const saved = service.setDelivery(current.id, "bubble", {
        status: "failed",
        attempts,
        nextRetryAt,
        error: errorCode,
      });
      if (saved.ok && !stopping) scheduleRetry(current, delay);
      try {
        log(stopping
          ? `Reminder ${current.id} delivery failed (${errorCode}); shutdown is in progress.`
          : `Reminder ${current.id} delivery failed (${errorCode}); retry scheduled.`);
      } catch {}
      return { ok: false, error: errorCode, nextRetryAt };
    } finally {
      inFlight.delete(key);
    }
  }

  function notifyDue(reminderOrId, expectedRevision, notifyOptions = {}) {
    if (stopping) return Promise.resolve({ ok: false, error: "agent_stopped" });
    const operation = deliverDue(reminderOrId, expectedRevision, notifyOptions);
    let tracked;
    tracked = operation.finally(() => pendingDeliveries.delete(tracked));
    pendingDeliveries.add(tracked);
    return tracked;
  }

  service = createReminderService({
    filePath: paths.storePath,
    fs: fsImpl,
    now,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    onDue: (reminder) => { void notifyDue(reminder); },
    onChanged: (reminder, _action, previous) => {
      if (previous) clearRetry(previous.id, previous.revision);
    },
    onError: (error, action) => {
      try { log(`Reminder service ${action} failed (${normalizeErrorCode(error)}).`); } catch {}
    },
  });

  function start() {
    if (stopping) return { ok: false, error: "agent_stopped" };
    const result = service.start();
    if (configError) {
      try { log("The saved Clawd agent ID is invalid; set it again with 'agent-id <id>'."); } catch {}
    }
    return result;
  }

  async function setAgentId(value) {
    if (!isValidCustomAgentId(value)) return { ok: false, error: "agent_id_invalid" };
    try {
      writeAgentId(paths.configPath, value, { fs: fsImpl, randomBytes: options.randomBytes });
      agentId = value;
      configError = null;
    } catch (error) {
      return { ok: false, error: normalizeErrorCode(error) };
    }
    const retried = await retryDue();
    return { ok: true, agentId, retried };
  }

  async function retryDue(reminderId) {
    const currentNow = Number(now());
    const due = service.list().filter((reminder) => reminder.dueAt <= currentNow
      && reminder.status !== STATUS.COMPLETED
      && reminder.status !== STATUS.CANCELLED
      && reminder.delivery.bubble.status !== "sent"
      && (reminderId === undefined || reminder.id === reminderId));
    return Promise.all(due.map((reminder) => notifyDue(reminder, reminder.revision, { force: true })));
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    for (const timer of timers.values()) clearTimeoutFn(timer);
    timers.clear();
    service.dispose();
    stopPromise = Promise.allSettled(Array.from(pendingDeliveries)).then(() => undefined);
    return stopPromise;
  }

  return Object.freeze({
    start,
    stop,
    retryDue,
    notifyDue,
    setAgentId,
    service,
    paths,
    get agentId() { return agentId; },
    get configError() { return configError; },
  });
}

module.exports = {
  createReminderAgent,
  readAgentId,
  resolveDataPaths,
  writeAgentId,
};
