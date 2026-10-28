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

The terminal manager is still available for manual sessions. For unattended operation on macOS, use the LaunchAgent below instead; **do not leave the interactive manager running at the same time**. Scheduled reminders remain saved when the process is stopped. On restart, overdue reminders are processed and unsent events are retried. If Clawd is offline or the custom Agent is disabled, delivery retries with increasing delays. `retry` requests an immediate attempt.

## macOS background operation (LaunchAgent)

Run these commands from the checkout on the Mac on which Clawd is installed (Node.js >= 22.12). **Do not run with `sudo`**; this is a per-user GUI LaunchAgent, not a system LaunchDaemon.

```sh
# Writes ~/Library/LaunchAgents/com.clawd.reminder-agent.plist; does not start it.
node bin/clawd-reminders.js service install
node bin/clawd-reminders.js service start
node bin/clawd-reminders.js service status

# No interactive terminal is needed once the daemon is running.
node bin/clawd-reminders.js agent-id custom-reminders-0123456789ab # 换成 Clawd 中的真实 ID
node bin/clawd-reminders.js add 20 分钟后提醒我休息
node bin/clawd-reminders.js list
node bin/clawd-reminders.js snooze REMINDER_ID 15
node bin/clawd-reminders.js done REMINDER_ID
node bin/clawd-reminders.js cancel REMINDER_ID
node bin/clawd-reminders.js retry

# Unload for this login session (may load on next login):
node bin/clawd-reminders.js service stop
# Unload AND persistently disable automatic login startup:
node bin/clawd-reminders.js service disable
# Explicit 'service start' re-enables a disabled service.
# Remove the LaunchAgent registration and plist, while preserving reminders:
node bin/clawd-reminders.js service uninstall
```

`service install` is idempotent for the exact same plist; if you move the checkout or change the Node executable, run `service uninstall` and then `service install` again from the new location. The plist contains **absolute** Node and script paths, starts without a TTY, and specifies `RunAtLoad` + `KeepAlive` + a 15-second launchd throttle. The installer rejects a `~/Library/LaunchAgents` directory or managed plist that is not owned by the current user or is writable by group/other users; correct the ownership/permissions before retrying. It is suitable for use while logged into the Mac user GUI session; it **does not wake a sleeping or powered-off Mac**, and cannot deliver a visible notification until Clawd itself is running and has enabled the matching custom HTTP Agent. A background Mac login session is required for `launchctl bootstrap gui/$UID`.

One daemon process exclusively owns `agent.lock` and `reminders.json`. One-shot management commands use an owner-only Unix-domain socket at `~/.clawd-reminders/control.sock` instead of acquiring the lock or loading a second writer. The data directory is mode `0700`, and the control socket mode `0600`; the client refuses symlinks, unsafe ownership and permissive socket permissions. IPC is local to the same macOS user; it is not designed as a cryptographic boundary against other processes already running as that user. One-shot commands **require the daemon to be running**. The old no-argument interactive command is for standalone manual use only; trying to open it alongside the daemon fails with `agent_already_running`.

You can also run `node bin/clawd-reminders.js daemon` directly in the foreground to inspect behavior without registering a service. `SIGINT`/`SIGTERM` stops accepting new requests, lets accepted commands and in-flight Clawd HTTP deliveries settle, removes the socket and releases the process lock. A crash may leave a stale lock and socket; after verifying the prior PID is gone, startup recovers them. A crash **during** HTTP delivery may cause at-least-once replay (the previous HTTP response may have been accepted without local acknowledgement); a successful HTTP 200 still does **not** prove a visible system notification. If an IPC client loses its response, check `list` before repeating `add`.

Inspect launchd and logs on a real Mac:

```sh
launchctl print "gui/$(id -u)/com.clawd.reminder-agent"
tail -n 100 ~/.clawd-reminders/daemon.err.log
tail -n 100 ~/.clawd-reminders/daemon.log
```

For an **end-to-end acceptance check**, register and enable the actual Clawd custom Agent first, run `add 1 分钟后提醒我测试通知`, wait for the due time while Clawd is open, then verify that the event is shown by Clawd. Check whether macOS notification permissions, Focus/Do Not Disturb or Clawd settings suppress the visible banner. Repeat after logging out and in, after forcing one daemon process to exit and allowing launchd to restart it, after disconnecting/reopening Clawd, and after `service disable` to verify it stays disabled. Run `service uninstall` to remove the job without deleting `~/.clawd-reminders/reminders.json` or `config.json`.

## Local data and delivery

The reminder store is `~/.clawd-reminders/reminders.json`; on POSIX systems the manager sets its data directory to `0700` and its store/config/lock files to `0600`. `config.json` contains only the custom `agent_id`. A single-instance lock prevents two managers from writing the same store at once. Stale-lock recovery is serialized and rechecks the owner before removing it. If a process is interrupted during recovery and leaves `~/.clawd-reminders/agent.lock.recover`, confirm no reminder agent is running before removing that marker. On exit, the CLI waits for any in-flight notification to finish before releasing the lock.

The due reminder title is sent to Clawd as the local event's `tool_name` so it can appear with the pet notification. The request includes no project path or credentials and does not leave loopback. A successful HTTP response means Clawd accepted the event; Do Not Disturb or notification settings may still suppress what is shown.

The `service` subcommands install and manage only a per-user macOS LaunchAgent; they never enable Clawd itself. Log files may grow over time and can be rotated or removed while the service is stopped.

## Development

```sh
npm test
```

The reminder store/service is adapted from Clawd on Desk and remains under the same AGPL-3.0-only license.
