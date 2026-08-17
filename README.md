English | [中文](README.zh.md)

# dsh-auto-scheduler

A DeepSeek Harness (DSH) plugin for timed autonomous work: fill in a goal and a time window in the sidebar panel, and DSH automatically creates a session and starts working at the start time, then interrupts the agent and stops the session at the stop time (the session stays in the list for review).

## Features

- **Host-side scheduler**: timers live inside the dsh web host process, so they fire even when no browser tab is open (the dsh web process itself must be running; missed windows are skipped).
- **Auto start / auto stop**: creates a Web GUI session and sends the task at the start time; cancels the active turn and stops the session at the stop time.
- **Two modes**:
  - `default`: the agent may ask the user; every other setting keeps deployment defaults.
  - `silent`: never asks the user (ask_user_question tool disabled + silent persona), danger-full-access permissions, keeps working until the task is done (still stopped externally at the stop time).
- **ds valley/peak presets**: one-click quick fill for Beijing time 12:00-14:00 and 18:00-09:00 (UTC+8).
- **Timezone handling**: the panel displays/edits in your system timezone and converts to UTC for storage; valley presets are converted to your local timezone for display.
- **Repeat**: once / daily.

## Install

### One-click (Windows)

Download and run the installer (or clone the repo and run `install.cmd`):

```bat
curl -o install.cmd https://raw.githubusercontent.com/Cheng-xiu/dsh-auto-scheduler/v0.1.1/install.cmd
install.cmd            :: optional: install.cmd <profile>, default profile is web
```

### One-click (macOS / Linux)

```sh
curl -o install.sh https://raw.githubusercontent.com/Cheng-xiu/dsh-auto-scheduler/v0.1.1/install.sh
chmod +x install.sh && ./install.sh   # optional: ./install.sh <profile>
```

### Manual

```sh
dsh plugin --profile web add github:Cheng-xiu/dsh-auto-scheduler#v0.1.1
```

Restart `dsh web` afterwards. The "Auto Work" (自动工作) entry then appears in the sidebar.

## Usage

1. Open the "Auto Work" sidebar panel.
2. Fill in the goal, mode (default/silent), start/stop times, and repeat — or click a valley-period preset.
3. Save. When the time arrives, DSH creates a session and sends the task; the panel shows live status and the next-run countdown.
4. "Run now" triggers a run immediately (stop time = now + original duration).

## Data & security

- Schedules persist host-side in `DSH_HOME/dsh-auto-scheduler.json` (default `~/.dsh/dsh-auto-scheduler.json`).
- Panel APIs accept only loopback requests or hosts granted via `--trusted-host`; anything else gets 403.
- **Silent mode means unattended full-permission execution — use it only for tasks you trust.**

## How it works

- The host ticks every 20 seconds and drives sessions through the exact same path the Web GUI uses (`apiProxy.sessions.create/prompt/cancel`).
- Silent mode uses the bundled agent preset `dsh-auto-scheduler-silent` (a fork of the standard preset with a silent persona and the question tool disabled), synced to `~/.dsh/.agent-presets/` at startup.
- Sessions are titled "[Auto] <goal prefix>" so they are easy to find in the session list.

## Troubleshooting

- **No sidebar entry after restart**: run `dsh --profile web --dump-config | findstr auto-scheduler`; if the row is missing, re-run the install command. Client panels are injected at boot — a restart is mandatory after install/upgrade.
- **pnpm store or allowBuilds error**: this package has no build scripts and no dependencies; follow the pnpm hint printed by `dsh plugin add` (e.g. add the printed key to `allowBuilds` in the profile's `pnpm-workspace.yaml`) and re-run.
- **Missed schedule**: the dsh web process must be running at the scheduled time; missed windows are skipped by design.

## License

MIT
