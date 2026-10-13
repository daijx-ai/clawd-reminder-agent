#!/usr/bin/env node
"use strict";

const readline = require("node:readline");
const { acquireProcessLock } = require("../src/process-lock");
const { createReminderAgent, resolveDataPaths } = require("../src/reminder-agent");

function formatDueTime(timestamp) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function writeLine(write, value = "") {
  write(`${value}\n`);
}

function helpText() {
  return [
    "命令：",
    "  agent-id <custom-agent-id>   保存 Clawd Settings 中显示的 Agent ID",
    "  add <提醒时间和内容>         例如：add 20 分钟后提醒我休息",
    "  list                         列出提醒",
    "  done <id>                    完成提醒",
    "  cancel <id>                  取消提醒",
    "  snooze <id> [5|15|60]        延后一次，默认 15 分钟",
    "  retry [id]                   立即重试到期提醒",
    "  help                         显示帮助",
    "  quit                         退出；提醒会保存在本机",
  ].join("\n");
}

async function executeCommand(input, agent, options = {}) {
  const write = typeof options.write === "function" ? options.write : process.stdout.write.bind(process.stdout);
  const line = String(input || "").trim();
  if (!line) return { ok: true };
  const firstSpace = line.search(/\s/);
  const command = (firstSpace < 0 ? line : line.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace < 0 ? "" : line.slice(firstSpace).trim();

  if (command === "help") {
    writeLine(write, helpText());
    return { ok: true };
  }
  if (command === "quit" || command === "exit") return { ok: true, quit: true };
  if (command === "agent-id") {
    const result = await agent.setAgentId(rest);
    if (!result.ok) {
      writeLine(write, `Agent ID 无效或无法保存：${result.error}`);
      return result;
    }
    writeLine(write, `已保存 Clawd Agent ID：${result.agentId}`);
    if (result.retried && result.retried.length) {
      writeLine(write, `已触发 ${result.retried.filter((item) => item.ok).length} 条到期提醒。`);
    }
    return result;
  }
  if (command === "add") {
    if (!rest) {
      writeLine(write, "请写明时间和提醒内容，例如：add 20 分钟后提醒我休息");
      return { ok: false, error: "empty" };
    }
    const result = agent.service.create({
      text: rest,
      channels: { bubble: true, system: false, feishu: false },
    });
    if (!result.ok) {
      writeLine(write, `无法创建提醒：${result.error}`);
      return result;
    }
    const reminder = result.reminder;
    writeLine(write, `已添加：${reminder.title} · ${formatDueTime(reminder.dueAt)} · ${reminder.id}`);
    return result;
  }
  if (command === "list") {
    const reminders = agent.service.list();
    if (!reminders.length) {
      writeLine(write, "暂无提醒。");
      return { ok: true, reminders };
    }
    for (const reminder of reminders) {
      writeLine(write, `${reminder.status} · ${formatDueTime(reminder.dueAt)} · ${reminder.title} · ${reminder.id}`);
    }
    return { ok: true, reminders };
  }
  if (command === "done" || command === "complete" || command === "cancel") {
    const reminder = agent.service.get(rest);
    if (!reminder) {
      writeLine(write, "找不到这条提醒。");
      return { ok: false, error: "not_found" };
    }
    const result = command === "cancel"
      ? agent.service.cancel(reminder.id, reminder.revision)
      : agent.service.complete(reminder.id, reminder.revision);
    writeLine(write, result.ok
      ? (command === "cancel" ? "已取消。" : "已完成。")
      : `操作失败：${result.error}`);
    return result;
  }
  if (command === "snooze") {
    const [id, rawMinutes, extra] = rest.split(/\s+/);
    const reminder = id && agent.service.get(id);
    if (!reminder) {
      writeLine(write, "找不到这条提醒。");
      return { ok: false, error: "not_found" };
    }
    if (extra !== undefined) {
      writeLine(write, "格式：snooze <id> [5|15|60]");
      return { ok: false, error: "invalid_format" };
    }
    const minutes = rawMinutes === undefined ? 15 : Number(rawMinutes);
    const result = agent.service.snooze(reminder.id, minutes, reminder.revision);
    if (!result.ok) {
      writeLine(write, `无法延后：${result.error}`);
      return result;
    }
    const reset = agent.service.setDelivery(reminder.id, "bubble", {
      status: "pending",
      nextRetryAt: null,
      error: "",
    });
    if (!reset.ok) {
      writeLine(write, `已延后，但通知状态未能重置：${reset.error}`);
      return reset;
    }
    writeLine(write, `已延后至 ${formatDueTime(result.reminder.dueAt)}。`);
    return result;
  }
  if (command === "retry") {
    const [id, ...extra] = rest ? rest.split(/\s+/) : [];
    if (extra.length) {
      writeLine(write, "格式：retry [id]");
      return { ok: false, error: "invalid_format" };
    }
    const result = await agent.retryDue(id);
    const delivered = result.filter((item) => item.ok).length;
    writeLine(write, `已尝试 ${result.length} 条到期提醒，Clawd 已接收 ${delivered} 条。`);
    return { ok: true, results: result };
  }

  writeLine(write, `未知命令：${command}。输入 help 查看命令。`);
  return { ok: false, error: "unknown_command" };
}

async function main(options = {}) {
  const input = options.stdin || process.stdin;
  const output = options.stdout || process.stdout;
  const write = (value) => output.write(value);
  if (options.requireTTY !== false && !input.isTTY) {
    throw new Error("Run this command in an interactive terminal.");
  }
  const paths = options.paths || resolveDataPaths(options.home);
  const releaseLock = acquireProcessLock(paths.lockPath, options.lockOptions || {});
  let agent = null;
  let rl = null;
  let onSignal = null;
  try {
    agent = createReminderAgent({
      ...(options.agentOptions || {}),
      paths,
      log: (message) => writeLine(write, message),
    });
    const started = agent.start();
    if (!started.ok) {
      throw new Error(`Reminder store unavailable: ${agent.service.loadError && agent.service.loadError.message || started.error}`);
    }

    writeLine(write, "Clawd 提醒助手已运行。输入 help 查看命令；保持此进程运行以接收提醒。");
    if (!agent.agentId) writeLine(write, "先在 Clawd 中注册自定义 HTTP Agent，再输入 agent-id <id> 绑定。");
    rl = readline.createInterface({
      input,
      output,
      terminal: options.terminal === undefined ? Boolean(input.isTTY) : options.terminal,
    });
    rl.setPrompt("reminders> ");
    onSignal = () => rl.close();
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    rl.prompt();
    for await (const line of rl) {
      const result = await executeCommand(line, agent, { write });
      if (result.quit) {
        rl.close();
        break;
      }
      rl.prompt();
    }
  } finally {
    if (onSignal) {
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
    if (rl) rl.close();
    try {
      if (agent) await agent.stop();
    } finally {
      releaseLock();
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    const detail = error && error.code === "lock_recovery_in_progress"
      ? "A stale-lock recovery is already running or was interrupted. Confirm no reminder agent is active, then remove ~/.clawd-reminders/agent.lock.recover."
      : error && error.code ? error.code : error && error.message ? error.message : String(error);
    process.stderr.write(`Clawd Reminder Agent failed: ${detail}\n`);
    process.exitCode = 1;
  });
}

module.exports = { executeCommand, formatDueTime, helpText, main };
