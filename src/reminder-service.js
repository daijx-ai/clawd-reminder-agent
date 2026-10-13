"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STORE_VERSION = 2;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const SNOOZE_OPTIONS = Object.freeze([5, 15, 60]);
const MAX_TIMER_MS = 2_147_000_000;
const MAX_TITLE_LENGTH = 160;
const MAX_INPUT_LENGTH = 500;
const MAX_DELIVERY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = Object.freeze([30_000, 120_000, 600_000, 1_800_000, 7_200_000]);
const STATUS = Object.freeze({
  SCHEDULED: "scheduled",
  PENDING: "pending",
  SNOOZED: "snoozed",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
});
const VALID_STATUSES = new Set(Object.values(STATUS));
const TERMINAL_STATUSES = new Set([STATUS.COMPLETED, STATUS.CANCELLED]);
const CHANNELS = Object.freeze(["bubble", "system", "feishu"]);
const DELIVERY_STATUSES = new Set(["pending", "sending", "sent", "failed", "skipped"]);
const FEISHU_PLATFORMS = new Set(["feishu", "lark"]);
const FEISHU_ID_TYPES = new Set(["open_id", "user_id", "union_id"]);
const DND_POLICIES = new Set(["mute_all", "desktop_silent_feishu_continue"]);

function normalizeNow(value) {
  const result = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(result) ? result : NaN;
}

function normalizeTitle(value) {
  return String(value || "").replace(/^[\s，,：:]+/, "").trim();
}

function isAmbiguousLocalMinute(date) {
  const fields = [
    date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(),
  ];
  // Minute-by-minute search covers common 30/60/120-minute DST fallbacks.
  for (let delta = -180; delta <= 180; delta += 1) {
    if (delta === 0) continue;
    const candidate = new Date(date.getTime() + delta * MINUTE_MS);
    if (candidate.getFullYear() === fields[0]
      && candidate.getMonth() === fields[1]
      && candidate.getDate() === fields[2]
      && candidate.getHours() === fields[3]
      && candidate.getMinutes() === fields[4]) return true;
  }
  return false;
}

function makeLocalDate(year, month, day, hour, minute) {
  if (![year, month, day, hour, minute].every(Number.isInteger)
    || month < 1 || month > 12 || day < 1 || day > 31
    || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return { ok: false, error: "invalid_time" };
  }
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, 0, 0);
  if (date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute) return { ok: false, error: "invalid_time" };
  if (isAmbiguousLocalMinute(date)) return { ok: false, error: "ambiguous_time" };
  return { ok: true, dueAt: date.getTime() };
}

function normalizeChannels(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    bubble: source.bubble === true,
    system: source.system === true,
    feishu: source.feishu === true,
  };
}

function createDelivery(status = "pending", bindingFingerprint = "") {
  return {
    status,
    attempts: 0,
    nextRetryAt: null,
    messageId: "",
    error: "",
    bindingFingerprint,
    attemptKey: "",
    attemptRevision: null,
  };
}

function defaultReminderSettings() {
  return {
    dndPolicy: "mute_all",
    binding: {
      enabled: false,
      platform: "feishu",
      appId: "",
      idType: "open_id",
      recipientId: "",
      source: "manual",
    },
  };
}

function createBindingFingerprint(binding) {
  if (!binding || binding.enabled !== true
    || !FEISHU_PLATFORMS.has(binding.platform)
    || !FEISHU_ID_TYPES.has(binding.idType)
    || typeof binding.appId !== "string" || !binding.appId
    || typeof binding.recipientId !== "string" || !binding.recipientId) return "";
  const identity = [binding.platform, binding.appId, binding.idType, binding.recipientId].join("\u0000");
  return crypto.createHash("sha256").update(identity).digest("hex");
}

function normalizeSettings(value) {
  const defaults = defaultReminderSettings();
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const rawBinding = source.binding && typeof source.binding === "object" && !Array.isArray(source.binding)
    ? source.binding
    : {};
  const binding = {
    enabled: rawBinding.enabled === true,
    platform: FEISHU_PLATFORMS.has(rawBinding.platform) ? rawBinding.platform : defaults.binding.platform,
    appId: typeof rawBinding.appId === "string" ? rawBinding.appId.trim().slice(0, 256) : "",
    idType: FEISHU_ID_TYPES.has(rawBinding.idType) ? rawBinding.idType : defaults.binding.idType,
    recipientId: typeof rawBinding.recipientId === "string" ? rawBinding.recipientId.trim().slice(0, 128) : "",
    source: rawBinding.source === "approval" ? "approval" : "manual",
  };
  if (!binding.enabled) {
    binding.appId = "";
    binding.recipientId = "";
  }
  return {
    dndPolicy: DND_POLICIES.has(source.dndPolicy) ? source.dndPolicy : defaults.dndPolicy,
    binding,
  };
}

function parseReminderText(input, options = {}) {
  if (typeof input !== "string" || input.length > MAX_INPUT_LENGTH) {
    return { ok: false, error: "invalid_format" };
  }
  const text = input.trim();
  if (!text) return { ok: false, error: "empty" };
  const now = normalizeNow(options.now === undefined ? Date.now() : options.now);
  if (!Number.isFinite(now)) return { ok: false, error: "invalid_time" };

  let dueAt;
  let title;
  let match = text.match(/^(?:提醒我\s*)?(\d+)\s*(分钟|小时)后\s*(?:提醒我\s*)?(.*)$/);
  if (match) {
    const amount = Number(match[1]);
    if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, error: "invalid_time" };
    const unit = match[2] === "小时" ? HOUR_MS : MINUTE_MS;
    dueAt = now + amount * unit;
    title = normalizeTitle(match[3]);
  } else {
    match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{1,2})\s*(?:提醒我\s*)?(.*)$/);
    if (match) {
      const resolved = makeLocalDate(
        Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]),
      );
      if (!resolved.ok) return resolved;
      dueAt = resolved.dueAt;
      title = normalizeTitle(match[6]);
    } else {
      match = text.match(/^(今天|明天)\s*(?:(上午|下午|晚上)\s*)?(\d{1,2})(?:(?:[:：](\d{1,2}))|\s*点\s*(半|(?:(\d{1,2})\s*分?)?)?)\s*(?:提醒我\s*)?(.*)$/);
      if (!match) return { ok: false, error: "invalid_format" };
      const nowDate = new Date(now);
      const targetDate = new Date(nowDate.getTime());
      if (match[1] === "明天") targetDate.setDate(targetDate.getDate() + 1);
      let hour = Number(match[3]);
      let minute = match[4] === undefined
        ? (match[5] === "半" ? 30 : (match[6] === undefined ? 0 : Number(match[6])))
        : Number(match[4]);
      const period = match[2] || "";
      if ((period && hour > 12) || (!period && hour > 23) || minute > 59) {
        return { ok: false, error: "invalid_time" };
      }
      if (period === "上午") hour = hour === 12 ? 0 : hour;
      if (period === "下午") hour = hour === 12 ? 12 : hour + 12;
      if (period === "晚上") {
        if (hour === 12) {
          targetDate.setDate(targetDate.getDate() + 1);
          hour = 0;
        } else hour += 12;
      }
      if (!period && hour > 23) return { ok: false, error: "invalid_time" };
      const resolved = makeLocalDate(
        targetDate.getFullYear(), targetDate.getMonth() + 1, targetDate.getDate(), hour, minute,
      );
      if (!resolved.ok) return resolved;
      dueAt = resolved.dueAt;
      title = normalizeTitle(match[7]);
    }
  }

  if (!Number.isSafeInteger(dueAt) || !Number.isFinite(new Date(dueAt).getTime())) {
    return { ok: false, error: "invalid_time" };
  }
  if (dueAt <= now) return { ok: false, error: "past_time" };
  if (!title) return { ok: false, error: "missing_title" };
  if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: "title_too_long" };
  return { ok: true, title, dueAt };
}

function parseReminderFields(titleValue, dateValue, timeValue, options = {}) {
  const title = normalizeTitle(titleValue);
  if (!title) return { ok: false, error: "missing_title" };
  if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: "title_too_long" };
  if (typeof dateValue !== "string" || typeof timeValue !== "string") {
    return { ok: false, error: "invalid_time" };
  }
  const date = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const time = timeValue.match(/^(\d{2}):([0-5]\d)$/);
  if (!date || !time) return { ok: false, error: "invalid_time" };
  const resolved = makeLocalDate(
    Number(date[1]), Number(date[2]), Number(date[3]), Number(time[1]), Number(time[2]),
  );
  if (!resolved.ok) return resolved;
  const now = normalizeNow(options.now === undefined ? Date.now() : options.now);
  if (!Number.isFinite(now)) return { ok: false, error: "invalid_time" };
  if (resolved.dueAt <= now) return { ok: false, error: "past_time" };
  return { ok: true, title, dueAt: resolved.dueAt };
}

function cloneReminder(reminder) {
  return {
    id: reminder.id,
    title: reminder.title,
    dueAt: reminder.dueAt,
    status: reminder.status,
    channels: { ...reminder.channels },
    revision: reminder.revision,
    snoozeCount: reminder.snoozeCount,
    delivery: {
      bubble: { ...reminder.delivery.bubble },
      system: { ...reminder.delivery.system },
      feishu: { ...reminder.delivery.feishu },
    },
  };
}

function isDelivery(value) {
  return !!value
    && typeof value === "object"
    && DELIVERY_STATUSES.has(value.status)
    && Object.keys(value).sort().join(",") === "attemptKey,attemptRevision,attempts,bindingFingerprint,error,messageId,nextRetryAt,status"
    && Number.isSafeInteger(value.attempts) && value.attempts >= 0
    && (value.nextRetryAt === null || (Number.isSafeInteger(value.nextRetryAt) && value.nextRetryAt >= 0))
    && typeof value.messageId === "string" && value.messageId.length <= 256
    && typeof value.error === "string" && value.error.length <= 128
    && typeof value.bindingFingerprint === "string"
    && (value.bindingFingerprint === "" || /^[a-f0-9]{64}$/.test(value.bindingFingerprint))
    && typeof value.attemptKey === "string"
    && (value.attemptKey === "" || /^[a-f0-9]{32}$/.test(value.attemptKey))
    && (value.attemptRevision === null || (Number.isSafeInteger(value.attemptRevision) && value.attemptRevision >= 1))
    && (!!value.attemptKey === Number.isSafeInteger(value.attemptRevision));
}

function validateReminder(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "channels,delivery,dueAt,id,revision,snoozeCount,status,title") return false;
  if (typeof value.id !== "string" || value.id.length < 1 || value.id.length > 80
    || typeof value.title !== "string" || value.title.length < 1 || value.title.length > MAX_TITLE_LENGTH
    || !Number.isSafeInteger(value.dueAt) || value.dueAt <= 0
    || !VALID_STATUSES.has(value.status)
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.snoozeCount) || value.snoozeCount < 0 || value.snoozeCount > 1) {
    return false;
  }
  const channels = value.channels;
  const delivery = value.delivery;
  return !!channels && typeof channels === "object" && !Array.isArray(channels)
    && Object.keys(channels).sort().join(",") === "bubble,feishu,system"
    && CHANNELS.every((name) => typeof channels[name] === "boolean")
    && !!delivery && typeof delivery === "object" && !Array.isArray(delivery)
    && Object.keys(delivery).sort().join(",") === "bubble,feishu,system"
    && CHANNELS.every((name) => isDelivery(delivery[name]));
}

function validateSettings(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== "binding,dndPolicy") return false;
  const normalized = normalizeSettings(value);
  const binding = value.binding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)
    || Object.keys(binding).sort().join(",") !== "appId,enabled,idType,platform,recipientId,source"
    || typeof binding.enabled !== "boolean"
    || !FEISHU_PLATFORMS.has(binding.platform)
    || typeof binding.appId !== "string" || binding.appId.length > 256
    || !FEISHU_ID_TYPES.has(binding.idType)
    || typeof binding.recipientId !== "string" || binding.recipientId.length > 128
    || !["approval", "manual"].includes(binding.source)
    || !DND_POLICIES.has(value.dndPolicy)) return false;
  return !binding.enabled || (!!binding.appId && !!binding.recipientId && normalized.binding.enabled);
}

function makeMigratedReminder(value) {
  const localStatus = value.status === STATUS.COMPLETED ? "sent" : "pending";
  return {
    id: value.id,
    title: value.title,
    dueAt: value.dueAt,
    status: value.status,
    channels: { bubble: true, system: true, feishu: false },
    revision: 1,
    snoozeCount: value.status === STATUS.SNOOZED ? 1 : 0,
    delivery: {
      bubble: createDelivery(localStatus),
      system: createDelivery(localStatus),
      feishu: createDelivery("skipped"),
    },
  };
}

function validateLegacyReminder(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).sort().join(",") === "dueAt,id,status,title"
    && typeof value.id === "string" && value.id.length >= 1 && value.id.length <= 80
    && typeof value.title === "string" && value.title.length >= 1 && value.title.length <= MAX_TITLE_LENGTH
    && Number.isSafeInteger(value.dueAt) && value.dueAt > 0
    && [STATUS.SCHEDULED, STATUS.PENDING, STATUS.SNOOZED, STATUS.COMPLETED].includes(value.status);
}

function writeStoreAtomic(filePath, reminders, settings = defaultReminderSettings(), options = {}) {
  // Retain the old internal call shape (filePath, reminders, options) for
  // callers that only need default settings.
  if (settings && (settings.fs || settings.randomBytes) && arguments.length === 3) {
    options = settings;
    settings = defaultReminderSettings();
  }
  const fsImpl = options.fs || fs;
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const parent = path.dirname(filePath);
  fsImpl.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const suffix = randomBytes(8).toString("hex");
  const tempPath = `${filePath}.tmp-${process.pid}-${suffix}`;
  let renamed = false;
  try {
    const payload = {
      version: STORE_VERSION,
      reminders: reminders.map(cloneReminder),
      settings: normalizeSettings(settings),
    };
    fsImpl.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try { fsImpl.chmodSync(tempPath, 0o600); } catch {}
    fsImpl.renameSync(tempPath, filePath);
    renamed = true;
    try { fsImpl.chmodSync(filePath, 0o600); } catch {}
  } finally {
    if (!renamed) {
      try { fsImpl.unlinkSync(tempPath); } catch {}
    }
  }
}

function backupLegacyFile(filePath, raw, fsImpl) {
  const backupPath = `${filePath}.v1.bak`;
  try {
    fsImpl.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    const existing = fsImpl.readFileSync(backupPath, "utf8");
    if (existing !== raw) throw new Error("Existing v1 backup differs; migration stopped");
  }
  try { fsImpl.chmodSync(backupPath, 0o600); } catch {}
  return backupPath;
}

function readStore(filePath, options = {}) {
  const fsImpl = options.fs || fs;
  const now = normalizeNow(options.now === undefined ? Date.now() : options.now);
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { reminders: [], settings: defaultReminderSettings(), migrated: false, exists: false };
    }
    throw err;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray(parsed.reminders)) throw new Error("Reminder store has an unsupported or invalid shape");
  if (parsed.version === 1) {
    if (!parsed.reminders.every(validateLegacyReminder)) {
      throw new Error("Reminder store contains an invalid v1 record; original file was preserved");
    }
    const migrated = parsed.reminders.map(makeMigratedReminder);
    const settings = defaultReminderSettings();
    backupLegacyFile(filePath, raw, fsImpl);
    return { reminders: migrated, settings, migrated: true, exists: true };
  }
  if (parsed.version !== STORE_VERSION || !parsed.reminders.every(validateReminder) || !validateSettings(parsed.settings)) {
    throw new Error("Reminder store has an unsupported or invalid v2 shape; original file was preserved");
  }
  const reminders = parsed.reminders.map(cloneReminder);
  let changed = false;
  for (const reminder of reminders) {
    if (reminder.delivery.feishu.status === "sending") {
      reminder.delivery.feishu.status = "failed";
      const delivery = reminder.delivery.feishu;
      const stoppedBeforeAck = !delivery.messageId
        && (TERMINAL_STATUSES.has(reminder.status) || !reminder.channels.feishu);
      if (stoppedBeforeAck) {
        delivery.error = "send_unconfirmed_stopped";
        delivery.nextRetryAt = null;
      } else if (delivery.attempts >= MAX_DELIVERY_ATTEMPTS) {
        delivery.error = delivery.messageId ? "update_unconfirmed" : "send_unconfirmed";
        delivery.nextRetryAt = null;
      } else {
        delivery.error = "interrupted";
        const delay = RETRY_DELAYS_MS[Math.min(Math.max(delivery.attempts - 1, 0), RETRY_DELAYS_MS.length - 1)];
        delivery.nextRetryAt = Math.max(
          Number.isSafeInteger(delivery.nextRetryAt) ? delivery.nextRetryAt : 0,
          (Number.isFinite(now) ? now : Date.now()) + delay,
        );
      }
      changed = true;
    }
  }
  return {
    reminders,
    settings: normalizeSettings(parsed.settings),
    migrated: changed,
    exists: true,
  };
}

function createReminderService(options = {}) {
  const filePath = options.filePath;
  if (typeof filePath !== "string" || !filePath) {
    throw new TypeError("createReminderService requires filePath");
  }
  const fsImpl = options.fs || fs;
  const randomUUID = options.randomUUID || (() => crypto.randomUUID());
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const now = options.now || Date.now;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;
  const onDue = options.onDue || (() => {});
  const onFeishuRetry = options.onFeishuRetry || (() => {});
  const onChanged = options.onChanged || (() => {});
  const onSettingsChanged = options.onSettingsChanged || (() => {});

  let reminders = [];
  let settings = defaultReminderSettings();
  let loaded = false;
  let loadError = null;
  let started = false;
  let timer = null;
  let mutationError = null;
  const dueEmittedThisRun = new Set();
  const retryEmittedThisRun = new Set();
  const recentRequests = new Map();

  function getNow() {
    return normalizeNow(now());
  }

  function commit(next, nextSettings = settings) {
    writeStoreAtomic(filePath, next, nextSettings, { fs: fsImpl, randomBytes });
    reminders = next.map(cloneReminder);
    settings = normalizeSettings(nextSettings);
    mutationError = null;
  }

  function reportError(err, action) {
    mutationError = err;
    try { options.onError && options.onError(err, action); } catch {}
  }

  function list() {
    return reminders.map(cloneReminder).sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id));
  }

  function get(id) {
    const found = reminders.find((item) => item.id === id);
    return found ? cloneReminder(found) : null;
  }

  function getSettings() {
    return JSON.parse(JSON.stringify(settings));
  }

  function preview(text) {
    return parseReminderText(text, { now: getNow() });
  }

  function previewFields(title, date, time) {
    return parseReminderFields(title, date, time, { now: getNow() });
  }

  function notifyChanged(reminder, action, previous) {
    try { onChanged(cloneReminder(reminder), action, previous ? cloneReminder(previous) : null); } catch {}
  }

  function scheduleNext() {
    if (!started) return;
    if (timer) {
      clearTimeoutFn(timer);
      timer = null;
    }
    const currentNow = getNow();
    if (!Number.isFinite(currentNow)) return;
    const nextScheduled = reminders
      .filter((item) => (item.status === STATUS.SCHEDULED || item.status === STATUS.SNOOZED)
        && item.dueAt > currentNow && !TERMINAL_STATUSES.has(item.status))
      .sort((a, b) => a.dueAt - b.dueAt)[0];
    const nextRetryAt = reminders
      .filter((item) => (item.channels.feishu || !!item.delivery.feishu.messageId)
        && item.delivery.feishu.status === "failed"
        && Number.isSafeInteger(item.delivery.feishu.nextRetryAt)
        && item.delivery.feishu.nextRetryAt > currentNow)
      .reduce((minimum, item) => Math.min(minimum, item.delivery.feishu.nextRetryAt), Infinity);
    const dueAt = Math.min(nextScheduled ? nextScheduled.dueAt : Infinity, nextRetryAt);
    if (!Number.isFinite(dueAt)) return;
    const delay = Math.max(0, Math.min(MAX_TIMER_MS, dueAt - currentNow));
    timer = setTimeoutFn(() => {
      timer = null;
      pump("timer");
    }, delay);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function pump(source) {
    if (!started || !loaded) return;
    const currentNow = getNow();
    if (!Number.isFinite(currentNow)) return;
    let next = reminders.map(cloneReminder);
    let changed = false;
    for (let index = 0; index < next.length; index += 1) {
      const item = next[index];
      if ((item.status === STATUS.SCHEDULED || item.status === STATUS.SNOOZED) && item.dueAt <= currentNow) {
        item.status = STATUS.PENDING;
        changed = true;
      }
    }
    if (changed) {
      try {
        commit(next);
      } catch (err) {
        reportError(err, "mark-due");
        timer = setTimeoutFn(() => { timer = null; pump("retry"); }, 1_000);
        if (timer && typeof timer.unref === "function") timer.unref();
        return;
      }
    }
    for (const reminder of reminders) {
      const dueKey = `${reminder.id}:${reminder.revision}`;
      if (!TERMINAL_STATUSES.has(reminder.status)
        && reminder.dueAt <= currentNow
        && !dueEmittedThisRun.has(dueKey)) {
        dueEmittedThisRun.add(dueKey);
        try {
          onDue(cloneReminder(reminder), {
            missed: source === "startup" || currentNow - reminder.dueAt > MINUTE_MS,
            source: source || "reconcile",
          });
        } catch (err) {
          dueEmittedThisRun.delete(dueKey);
          reportError(err, "notify-due");
        }
      }
      const delivery = reminder.delivery.feishu;
      const canRetry = delivery.messageId
        || (!TERMINAL_STATUSES.has(reminder.status) && reminder.channels.feishu);
      if (canRetry
        && delivery.status === "failed"
        && Number.isSafeInteger(delivery.nextRetryAt)
        && delivery.nextRetryAt <= currentNow
        && !retryEmittedThisRun.has(dueKey)) {
        retryEmittedThisRun.add(dueKey);
        try { onFeishuRetry(cloneReminder(reminder)); } catch (err) {
          reportError(err, "feishu-retry");
        } finally {
          retryEmittedThisRun.delete(dueKey);
        }
      }
    }
    scheduleNext();
  }

  function start() {
    if (started) return { ok: !loadError, error: loadError };
    started = true;
    try {
      const store = readStore(filePath, { fs: fsImpl, now: getNow() });
      reminders = store.reminders.map(cloneReminder);
      settings = normalizeSettings(store.settings);
      loaded = true;
      loadError = null;
      if (store.migrated || !store.exists) {
        try { writeStoreAtomic(filePath, reminders, settings, { fs: fsImpl, randomBytes }); } catch (err) {
          loaded = false;
          loadError = err;
          reportError(err, store.migrated ? "migrate" : "initialize");
          return { ok: false, error: err };
        }
      }
      if (store.migrated) settings = normalizeSettings(store.settings);
    } catch (err) {
      loaded = false;
      loadError = err;
      reportError(err, "load");
      return { ok: false, error: err };
    }
    pump("startup");
    return { ok: true };
  }

  function normalizeCreateInput(input) {
    if (typeof input === "string") return { ...preview(input), channels: { bubble: true, system: true, feishu: false } };
    if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "invalid_format" };
    const parsed = typeof input.text === "string"
      ? preview(input.text)
      : typeof input.date === "string" && typeof input.time === "string"
      ? previewFields(input.title, input.date, input.time)
      : (() => {
        const title = normalizeTitle(input.title);
        const dueAt = Number(input.dueAt);
        if (!title) return { ok: false, error: "missing_title" };
        if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: "title_too_long" };
        if (!Number.isSafeInteger(dueAt)) return { ok: false, error: "invalid_time" };
        if (dueAt <= getNow()) return { ok: false, error: "past_time" };
        return { ok: true, title, dueAt };
      })();
    if (!parsed.ok) return parsed;
    return {
      ...parsed,
      channels: input.channels === undefined
        ? { bubble: true, system: true, feishu: false }
        : normalizeChannels(input.channels),
    };
  }

  function validateChannels(channels) {
    if (channels.feishu && (!settings.binding.enabled || !settings.binding.appId || !settings.binding.recipientId)) {
      return { ok: false, error: "feishu_binding_required" };
    }
    if (!CHANNELS.some((channel) => channels[channel])) return { ok: false, error: "channel_required" };
    return { ok: true };
  }

  function create(input, requestId) {
    if (!loaded) return { ok: false, error: "store_unavailable", cause: loadError };
    if (typeof requestId === "string" && requestId && recentRequests.has(requestId)) {
      const existing = get(recentRequests.get(requestId));
      if (existing) return { ok: true, reminder: existing, duplicate: true };
    }
    const parsed = normalizeCreateInput(input);
    if (!parsed.ok) return parsed;
    const channelCheck = validateChannels(parsed.channels);
    if (!channelCheck.ok) return channelCheck;
    const reminder = {
      id: String(randomUUID()),
      title: parsed.title,
      dueAt: parsed.dueAt,
      status: STATUS.SCHEDULED,
      channels: parsed.channels,
      revision: 1,
      snoozeCount: 0,
      delivery: {
        bubble: createDelivery(parsed.channels.bubble ? "pending" : "skipped"),
        system: createDelivery(parsed.channels.system ? "pending" : "skipped"),
        feishu: createDelivery(
          parsed.channels.feishu ? "pending" : "skipped",
          parsed.channels.feishu ? createBindingFingerprint(settings.binding) : "",
        ),
      },
    };
    try { commit(reminders.concat(reminder)); } catch (err) {
      reportError(err, "create");
      return { ok: false, error: "store_write_failed", cause: err };
    }
    if (typeof requestId === "string" && requestId) {
      recentRequests.set(requestId, reminder.id);
      while (recentRequests.size > 100) recentRequests.delete(recentRequests.keys().next().value);
    }
    scheduleNext();
    notifyChanged(reminder, "create");
    return { ok: true, reminder: cloneReminder(reminder), duplicate: false };
  }

  function checkExpectedRevision(current, expectedRevision) {
    return expectedRevision === undefined || expectedRevision === null
      || expectedRevision === current.revision;
  }

  function update(id, patch, expectedRevision) {
    if (!loaded) return { ok: false, error: "store_unavailable", cause: loadError };
    const current = reminders.find((item) => item.id === id);
    if (!current) return { ok: false, error: "not_found" };
    if (!checkExpectedRevision(current, expectedRevision)) return { ok: false, error: "stale_revision", reminder: cloneReminder(current) };
    if (TERMINAL_STATUSES.has(current.status)) return { ok: false, error: "terminal", reminder: cloneReminder(current) };
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: "invalid_format" };
    const title = patch.title === undefined ? current.title : normalizeTitle(patch.title);
    if (!title) return { ok: false, error: "missing_title" };
    if (title.length > MAX_TITLE_LENGTH) return { ok: false, error: "title_too_long" };
    let dueAt = current.dueAt;
    if (typeof patch.date === "string" || typeof patch.time === "string") {
      if (typeof patch.date !== "string" || typeof patch.time !== "string") return { ok: false, error: "invalid_time" };
      const date = patch.date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const time = patch.time.match(/^(\d{2}):([0-5]\d)$/);
      if (!date || !time) return { ok: false, error: "invalid_time" };
      const parsed = makeLocalDate(
        Number(date[1]), Number(date[2]), Number(date[3]), Number(time[1]), Number(time[2]),
      );
      if (!parsed.ok) return parsed;
      dueAt = parsed.dueAt;
      // A pending reminder may have its title or channels edited while
      // keeping its original due time. A changed past date is never accepted.
      if (dueAt <= getNow() && !(dueAt === current.dueAt && current.status === STATUS.PENDING)) {
        return { ok: false, error: "past_time" };
      }
    } else if (patch.dueAt !== undefined) {
      dueAt = Number(patch.dueAt);
      if (!Number.isSafeInteger(dueAt)) return { ok: false, error: "invalid_time" };
      if (dueAt <= getNow() && !(dueAt === current.dueAt && current.status === STATUS.PENDING)) {
        return { ok: false, error: "past_time" };
      }
    }
    const channels = patch.channels === undefined ? { ...current.channels } : normalizeChannels(patch.channels);
    const channelCheck = validateChannels(channels);
    if (!channelCheck.ok) return channelCheck;
    const nextBindingFingerprint = createBindingFingerprint(settings.binding);
    const routeChanged = channels.feishu
      && current.delivery.feishu.bindingFingerprint !== nextBindingFingerprint;
    const routeConfirmed = routeChanged && patch.confirmBinding === true;
    const changed = title !== current.title || dueAt !== current.dueAt
      || CHANNELS.some((channel) => channels[channel] !== current.channels[channel])
      || routeConfirmed;
    if (!changed) return { ok: true, reminder: cloneReminder(current), duplicate: true };
    const updated = {
      ...cloneReminder(current),
      title,
      dueAt,
      status: dueAt !== current.dueAt && dueAt > getNow() && current.status !== STATUS.SCHEDULED
        ? STATUS.SCHEDULED
        : current.status,
      channels,
      revision: current.revision + 1,
      delivery: {
        ...cloneReminder(current).delivery,
        ...Object.fromEntries(CHANNELS.map((channel) => {
          if (channel === "feishu") {
            if (!channels.feishu) {
              if (current.delivery.feishu.messageId) {
                return ["feishu", {
                  ...current.delivery.feishu,
                  status: "sent",
                  nextRetryAt: null,
                  error: "",
                }];
              }
              if (current.delivery.feishu.attemptKey) {
                return ["feishu", {
                  ...current.delivery.feishu,
                  status: "failed",
                  nextRetryAt: null,
                  error: "send_unconfirmed_stopped",
                }];
              }
              return ["feishu", createDelivery("skipped")];
            }
            if (routeConfirmed) {
              return ["feishu", createDelivery("pending", nextBindingFingerprint)];
            }
            if (!current.channels.feishu) {
              if (current.delivery.feishu.attemptKey
                && current.delivery.feishu.bindingFingerprint === nextBindingFingerprint) {
                return ["feishu", {
                  ...current.delivery.feishu,
                  status: "pending",
                  nextRetryAt: null,
                  error: "",
                }];
              }
              if (current.delivery.feishu.messageId
                && current.delivery.feishu.bindingFingerprint === nextBindingFingerprint) {
                return ["feishu", {
                  ...current.delivery.feishu,
                  status: "sent",
                  nextRetryAt: null,
                  error: "",
                }];
              }
              return ["feishu", createDelivery("pending", nextBindingFingerprint)];
            }
            return ["feishu", { ...current.delivery.feishu }];
          }
          if (channels[channel] && !current.channels[channel]) return [channel, createDelivery("pending")];
          if (!channels[channel]) return [channel, createDelivery("skipped")];
          return [channel, { ...current.delivery[channel] }];
        })),
      },
    };
    try { commit(reminders.map((item) => item.id === id ? updated : item)); } catch (err) {
      reportError(err, "update");
      return { ok: false, error: "store_write_failed", cause: err };
    }
    dueEmittedThisRun.delete(`${id}:${current.revision}`);
    retryEmittedThisRun.delete(`${id}:${current.revision}`);
    scheduleNext();
    notifyChanged(updated, "update", current);
    return { ok: true, reminder: cloneReminder(updated), duplicate: false };
  }

  function cancel(id, expectedRevision) {
    if (!loaded) return { ok: false, error: "store_unavailable", cause: loadError };
    const current = reminders.find((item) => item.id === id);
    if (!current) return { ok: false, error: "not_found" };
    if (current.status === STATUS.CANCELLED) return { ok: true, reminder: cloneReminder(current), duplicate: true };
    if (TERMINAL_STATUSES.has(current.status)) return { ok: false, error: "terminal", reminder: cloneReminder(current) };
    if (!checkExpectedRevision(current, expectedRevision)) return { ok: false, error: "stale_revision", reminder: cloneReminder(current) };
    const updated = { ...cloneReminder(current), status: STATUS.CANCELLED, revision: current.revision + 1 };
    try { commit(reminders.map((item) => item.id === id ? updated : item)); } catch (err) {
      reportError(err, "cancel");
      return { ok: false, error: "store_write_failed", cause: err };
    }
    dueEmittedThisRun.delete(`${id}:${current.revision}`);
    retryEmittedThisRun.delete(`${id}:${current.revision}`);
    scheduleNext();
    notifyChanged(updated, "cancel", current);
    return { ok: true, reminder: cloneReminder(updated), duplicate: false };
  }

  function complete(id, expectedRevision) {
    if (!loaded) return { ok: false, error: "store_unavailable", cause: loadError };
    const current = reminders.find((item) => item.id === id);
    if (!current) return { ok: false, error: "not_found" };
    if (current.status === STATUS.COMPLETED) return { ok: true, reminder: cloneReminder(current), duplicate: true };
    if (TERMINAL_STATUSES.has(current.status)) return { ok: false, error: "terminal", reminder: cloneReminder(current) };
    if (!checkExpectedRevision(current, expectedRevision)) return { ok: false, error: "stale_revision", reminder: cloneReminder(current) };
    const updated = { ...cloneReminder(current), status: STATUS.COMPLETED, revision: current.revision + 1 };
    try { commit(reminders.map((item) => item.id === id ? updated : item)); } catch (err) {
      reportError(err, "complete");
      return { ok: false, error: "store_write_failed", cause: err };
    }
    dueEmittedThisRun.delete(`${id}:${current.revision}`);
    retryEmittedThisRun.delete(`${id}:${current.revision}`);
    scheduleNext();
    notifyChanged(updated, "complete", current);
    return { ok: true, reminder: cloneReminder(updated), duplicate: false };
  }

  function snooze(id, delay, expectedRevision) {
    if (!loaded) return { ok: false, error: "store_unavailable", cause: loadError };
    const current = reminders.find((item) => item.id === id);
    if (!current) return { ok: false, error: "not_found" };
    if (TERMINAL_STATUSES.has(current.status)) return { ok: false, error: "terminal", reminder: cloneReminder(current) };
    if (!checkExpectedRevision(current, expectedRevision)) return { ok: false, error: "stale_revision", reminder: cloneReminder(current) };
    if (current.status !== STATUS.PENDING) {
      return { ok: false, error: current.status === STATUS.SNOOZED ? "snooze_already_used" : "not_due" };
    }
    if (current.snoozeCount >= 1) return { ok: false, error: "snooze_already_used" };
    let nextDueAt;
    if (typeof delay === "number") {
      if (!SNOOZE_OPTIONS.includes(delay)) return { ok: false, error: "invalid_snooze" };
      nextDueAt = getNow() + delay * MINUTE_MS;
    } else if (delay && typeof delay === "object" && Number.isSafeInteger(delay.dueAt)) {
      nextDueAt = delay.dueAt;
    } else {
      nextDueAt = getNow() + 15 * MINUTE_MS;
    }
    if (!Number.isSafeInteger(nextDueAt) || nextDueAt <= getNow()) return { ok: false, error: "past_time" };
    const updated = {
      ...cloneReminder(current),
      dueAt: nextDueAt,
      status: STATUS.SNOOZED,
      revision: current.revision + 1,
      snoozeCount: current.snoozeCount + 1,
    };
    try { commit(reminders.map((item) => item.id === id ? updated : item)); } catch (err) {
      reportError(err, "snooze");
      return { ok: false, error: "store_write_failed", cause: err };
    }
    dueEmittedThisRun.delete(`${id}:${current.revision}`);
    retryEmittedThisRun.delete(`${id}:${current.revision}`);
    scheduleNext();
    notifyChanged(updated, "snooze", current);
    return { ok: true, reminder: cloneReminder(updated), duplicate: false };
  }

  function setDelivery(id, channel, patch) {
    if (!loaded) return { ok: false, error: "store_unavailable", cause: loadError };
    if (!CHANNELS.includes(channel)) return { ok: false, error: "invalid_channel" };
    const current = reminders.find((item) => item.id === id);
    if (!current) return { ok: false, error: "not_found" };
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: "invalid_format" };
    const previous = current.delivery[channel];
    const nextDelivery = { ...previous };
    if (patch.status !== undefined) {
      if (!DELIVERY_STATUSES.has(patch.status)) return { ok: false, error: "invalid_delivery_status" };
      nextDelivery.status = patch.status;
    }
    if (patch.attempts !== undefined) {
      if (!Number.isSafeInteger(patch.attempts) || patch.attempts < previous.attempts) return { ok: false, error: "invalid_attempts" };
      nextDelivery.attempts = patch.attempts;
    }
    if (patch.nextRetryAt !== undefined) {
      if (patch.nextRetryAt !== null && (!Number.isSafeInteger(patch.nextRetryAt) || patch.nextRetryAt < 0)) {
        return { ok: false, error: "invalid_retry_time" };
      }
      nextDelivery.nextRetryAt = patch.nextRetryAt;
    }
    if (patch.messageId !== undefined) {
      if (typeof patch.messageId !== "string" || patch.messageId.length > 256) return { ok: false, error: "invalid_message_id" };
      nextDelivery.messageId = patch.messageId;
    }
    if (patch.error !== undefined) {
      if (typeof patch.error !== "string" || patch.error.length > 128) return { ok: false, error: "invalid_delivery_error" };
      nextDelivery.error = patch.error;
    }
    if (patch.attemptKey !== undefined) {
      if (typeof patch.attemptKey !== "string" || (patch.attemptKey !== "" && !/^[a-f0-9]{32}$/.test(patch.attemptKey))) {
        return { ok: false, error: "invalid_attempt_key" };
      }
      nextDelivery.attemptKey = patch.attemptKey;
    }
    if (patch.attemptRevision !== undefined) {
      if (patch.attemptRevision !== null
        && (!Number.isSafeInteger(patch.attemptRevision) || patch.attemptRevision < 1)) {
        return { ok: false, error: "invalid_attempt_revision" };
      }
      nextDelivery.attemptRevision = patch.attemptRevision;
    }
    if (!!nextDelivery.attemptKey !== Number.isSafeInteger(nextDelivery.attemptRevision)) {
      return { ok: false, error: "invalid_attempt_identity" };
    }
    const updated = cloneReminder(current);
    updated.delivery[channel] = nextDelivery;
    try { commit(reminders.map((item) => item.id === id ? updated : item)); } catch (err) {
      reportError(err, `delivery-${channel}`);
      return { ok: false, error: "store_write_failed", cause: err };
    }
    scheduleNext();
    return { ok: true, reminder: cloneReminder(updated) };
  }

  function beginFeishuAttempt(id) {
    if (!loaded) return { ok: false, error: "store_unavailable", cause: loadError };
    const current = reminders.find((item) => item.id === id);
    if (!current) return { ok: false, error: "not_found" };
    if (TERMINAL_STATUSES.has(current.status)) return { ok: false, error: "terminal", reminder: cloneReminder(current) };
    if (!current.channels.feishu) return { ok: false, error: "channel_disabled", reminder: cloneReminder(current) };
    if (current.delivery.feishu.messageId) return { ok: false, error: "already_sent", reminder: cloneReminder(current) };
    if (current.delivery.feishu.status === "sending") return { ok: true, reminder: cloneReminder(current), duplicate: true };
    if (current.delivery.feishu.attempts >= MAX_DELIVERY_ATTEMPTS) {
      return { ok: false, error: "retry_limit", reminder: cloneReminder(current) };
    }
    const attemptKey = current.delivery.feishu.attemptKey || randomBytes(16).toString("hex");
    const attemptRevision = current.delivery.feishu.attemptRevision || current.revision;
    const updated = cloneReminder(current);
    updated.delivery.feishu = {
      ...current.delivery.feishu,
      status: "sending",
      attempts: current.delivery.feishu.attempts + 1,
      nextRetryAt: null,
      error: "",
      attemptKey,
      attemptRevision,
    };
    try { commit(reminders.map((item) => item.id === id ? updated : item)); } catch (err) {
      reportError(err, "delivery-feishu");
      return { ok: false, error: "store_write_failed", cause: err };
    }
    scheduleNext();
    return { ok: true, reminder: cloneReminder(updated), duplicate: false };
  }

  function beginFeishuAttempt(id) {
    if (!loaded) return { ok: false, error: "store_unavailable", cause: loadError };
    const current = reminders.find((item) => item.id === id);
    if (!current) return { ok: false, error: "not_found" };
    if (TERMINAL_STATUSES.has(current.status)) return { ok: false, error: "terminal", reminder: cloneReminder(current) };
    if (!current.channels.feishu) return { ok: false, error: "channel_disabled", reminder: cloneReminder(current) };
    if (current.delivery.feishu.messageId) return { ok: false, error: "already_sent", reminder: cloneReminder(current) };
    if (current.delivery.feishu.status === "sending") return { ok: true, reminder: cloneReminder(current), duplicate: true };
    if (current.delivery.feishu.attempts >= MAX_DELIVERY_ATTEMPTS) {
      return { ok: false, error: "retry_limit", reminder: cloneReminder(current) };
    }
    const attemptKey = current.delivery.feishu.attemptKey || randomBytes(16).toString("hex");
    const attemptRevision = current.delivery.feishu.attemptRevision || current.revision;
    const updated = cloneReminder(current);
    updated.delivery.feishu = {
      ...current.delivery.feishu,
      status: "sending",
      attempts: current.delivery.feishu.attempts + 1,
      nextRetryAt: null,
      error: "",
      attemptKey,
      attemptRevision,
    };
    try { commit(reminders.map((item) => item.id === id ? updated : item)); } catch (err) {
      reportError(err, "delivery-feishu");
      return { ok: false, error: "store_write_failed", cause: err };
    }
    scheduleNext();
    return { ok: true, reminder: cloneReminder(updated), duplicate: false };
  }

  function setSettings(patch) {
    if (!loaded) return { ok: false, error: "store_unavailable", cause: loadError };
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return { ok: false, error: "invalid_format" };
    let next = getSettings();
    if (patch.dndPolicy !== undefined) {
      if (!DND_POLICIES.has(patch.dndPolicy)) return { ok: false, error: "invalid_dnd_policy" };
      next.dndPolicy = patch.dndPolicy;
    }
    if (patch.binding !== undefined) {
      const raw = patch.binding;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid_binding" };
      if (raw.enabled === false) {
        next.binding = {
          enabled: false,
          platform: FEISHU_PLATFORMS.has(raw.platform) ? raw.platform : "feishu",
          appId: "",
          idType: FEISHU_ID_TYPES.has(raw.idType) ? raw.idType : "open_id",
          recipientId: "",
          source: raw.source === "approval" ? "approval" : "manual",
        };
      } else {
        const binding = normalizeSettings({ binding: raw }).binding;
        if (!binding.appId || !binding.recipientId || !FEISHU_PLATFORMS.has(raw.platform)
          || !FEISHU_ID_TYPES.has(raw.idType) || !["approval", "manual"].includes(raw.source)) {
          return { ok: false, error: "invalid_binding" };
        }
        binding.enabled = true;
        next.binding = binding;
      }
    }
    try { commit(reminders, next); } catch (err) {
      reportError(err, "settings");
      return { ok: false, error: "store_write_failed", cause: err };
    }
    try { onSettingsChanged(getSettings()); } catch {}
    return { ok: true, settings: getSettings() };
  }

  function dispose() {
    started = false;
    if (timer) clearTimeoutFn(timer);
    timer = null;
  }

  return {
    start,
    preview,
    previewFields,
    create,
    update,
    cancel,
    complete,
    snooze,
    setDelivery,
    beginFeishuAttempt,
    beginFeishuAttempt,
    setSettings,
    list,
    get,
    getSettings,
    recheck: () => pump("reconcile"),
    dispose,
    get ready() { return loaded; },
    get loadError() { return loadError; },
    get lastError() { return mutationError; },
  };
}

module.exports = {
  STATUS,
  STORE_VERSION,
  MINUTE_MS,
  HOUR_MS,
  SNOOZE_OPTIONS,
  MAX_TITLE_LENGTH,
  MAX_DELIVERY_ATTEMPTS,
  RETRY_DELAYS_MS,
  parseReminderText,
  parseReminderFields,
  normalizeChannels,
  createBindingFingerprint,
  validateReminder,
  validateSettings,
  readStore,
  writeStoreAtomic,
  createReminderService,
};
