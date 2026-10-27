# Clawd Reminder Agent

A small local reminder manager that alerts [Clawd](https://github.com/rullerzhou-afk/clawd-on-desk) through its custom HTTP Agent endpoint. Reminder data stays on this computer; Clawd receives a loopback `notification` event when a reminder is due.

## Requirements

- Node.js 22.12 or newer
- Clawd running locally for the pet notification

There are no npm dependencies. Start the command-line manager from this directory:

```sh
node bin/clawd-reminders.js
```

## Connect it to Clawd

1. In Clawd, register and enable a custom HTTP Agent using the [custom Agent guide](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/docs/guides/custom-agent-http.md). Give it a name such as **Clawd Reminders**.
2. Copy the generated `agent_id` from Clawd.
3. In the running command-line manager, enter `agent-id <custom-agent-id>`.

The agent reads Clawd's current `~/.clawd/runtime.json` before **every notification** and verifies `app: "clawd-on-desk"`. It accepts Clawd's fixed `23333–23337` ports **and dynamic ports**: a port must be a number from `1` to `65535` or a canonical decimal string (no spaces or leading zeroes). It always POSTs to the literal `http://127.0.0.1:<port>/state`; a runtime file cannot change the host or path. It never reads Codex or other agent authentication files.

On macOS/Linux, the runtime file must be a regular, non-symlink file owned by the current user without group/other permissions (Clawd publishes it as `0600`). Windows relies on the user's profile ACL. An absent, invalid, or stale runtime is treated as an offline delivery and retried. The runtime identity and loopback restriction reduce accidental or cross-user misrouting, but **are not cryptographic authentication**: another process running as the same OS user can still spoof a local listener or runtime file. Do not put credentials or full prompts in reminder titles.

## Create and manage reminders

Enter these commands at the `reminders>` prompt:

```text
add 20 分钟后提醒我休息
add 明天 9:30 提醒我开会
list
done <id>
snooze <id> 15
cancel <id>
retry
help
quit
```

The parser also accepts explicit local dates such as `2026-10-14 09:30 提醒我出发`. Snooze is available once per reminder for 5, 15, or 60 minutes.

Keep the process running to receive reminders on time. Scheduled reminders remain saved while it is closed; when the manager starts again, overdue reminders are sent to Clawd. If Clawd is offline or the custom Agent is disabled, delivery retries with increasing delays. `retry` requests an immediate attempt.

## Local data and delivery

The reminder store is `~/.clawd-reminders/reminders.json`; on POSIX systems the manager sets its data directory to `0700` and its store/config/lock files to `0600`. `config.json` contains only the custom `agent_id`. A single-instance lock prevents two managers from writing the same store at once. Stale-lock recovery is serialized and rechecks the owner before removing it. If a process is interrupted during recovery and leaves `~/.clawd-reminders/agent.lock.recover`, confirm no reminder agent is running before removing that marker. On exit, the CLI waits for any in-flight notification to finish before releasing the lock.

The due reminder title is sent to Clawd as the local event's `tool_name` so it can appear with the pet notification. The request includes no project path or credentials and does not leave loopback. A successful HTTP response means Clawd accepted the event; Do Not Disturb or notification settings may still suppress what is shown.

This companion does not install a background service. Start it in a terminal or another process manager you control.

## Development

```sh
npm test
```

The reminder store/service is adapted from Clawd on Desk and remains under the same AGPL-3.0-only license.
