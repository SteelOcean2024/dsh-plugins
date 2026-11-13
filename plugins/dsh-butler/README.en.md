# dsh-butler · A butler for DeepSeek Harness

> A butler for DeepSeek Harness: a cross-workspace overview of every session, task board and schedule — plus **proactive WeChat notifications the moment a session finishes a turn**.

![icon](icon.svg)

[简体中文](README.md) · **English**

---

## The problem

DeepSeek Harness lets you run many sessions at once. The trouble is:

- you **cannot tell which session is still running and which just finished**
- when one finishes, **nothing tells you** — you have to go look
- ask an agent to check for you and it **cannot see the other sessions** (each agent only sees itself)

`dsh-butler` fills those three gaps.

## Features

### 1. Global overview tool `ds_butler_status`

One call lists **every workspace** with each session's latest state, the task board, and the schedules.

| Parameter | Type | Description |
| --- | --- | --- |
| `scope` | `"all"` \| `"workspaces"` \| `"tasks"` \| `"schedules"` | Optional; limit the output |

```
=== Workspaces and sessions ===

## my-project
  path: /path/to/my-project
  sessions: 3
    - session-ca60  [completed]     last active 2026-11-14 02:00
    - session-15f4  [running]       last active 2026-11-14 02:25
    - session-4e40  [empty session] last active 2026-11-12 12:14

=== Session state totals (23) ===
  - completed: 18
  - running: 1
  - error: 2
```

### 2. Proactive notifications

A background loop polls every **60 seconds**. When a session records a new `turn/end`, it pushes:

```
🐳 管家｜my-session-title
my-workspace · turn 97 ✅ completed
This turn has ended; nothing is waiting
14 tool calls this turn
2 teammates cooperated (spawn_teammate, wait_agent)
global: 2 active · 1 error
```

Every line comes from real session-log fields — **never from a model's own words**:

| Field | Source |
| --- | --- |
| Session title | The most recent `session/title` record |
| Turn number | `data.turn` of the latest `turn/end` |
| Result | `data.reason.kind` of the same record |
| "nothing is waiting" | A `turn/end` exists, so the turn really ended |
| Tool-call count | `tool/call` records with `data.turn == that turn` |
| Teammate cooperation | Tool names matching `spawn_teammate` / `wait_agent` / `send_message` / `list_agents` / `team_task` / `subagent` |

Each turn is announced once. The first run only builds a baseline, so history is not replayed.

### 3. A "butler" agent preset

A butler persona plus 18 tools (shell, filesystem, jobs, schedules, goals, todos, web, office, subagents, questions…). The persona embeds a capability list, so asking "what can you do?" prints it.

### 4. Helper tools

| Tool | Purpose |
| --- | --- |
| `ds_butler_notify` | Push one text message to WeChat (test the chain, or report proactively) |
| `ds_butler_watch` | `status` shows the monitor; `dryrun` reports what *would* be sent without sending |

## Install

Requires DeepSeek Harness `0.2.2-rc.1` or newer, Node.js 22.19+.

**The plugin has zero dependencies** — Node built-ins only, no `@deepseek-ai/*` imports.

```sh
# From GitHub
npx -y github:SteelOcean2024/dsh-plugins install

# From npm
dsh plugin --profile desktop add -w @steelocean2024/dsh-butler

# From a local directory
dsh plugin --profile desktop add -w <absolute path to this directory>
```

**Restart DSH after installing.**

## WeChat delivery

On startup the plugin reads `~/.dsh/integrations/dsh-weixin/config.json` for the `botId` and `ownerUserId`, then calls `ctx.dshIm.createTarget()` to create a delivery target named `butler-notify` (skipped if it exists; retried every 10 s up to 8 times while the channel connects).

> You do **not** need to click "New target" in the UI.

WeChat proactive delivery uses the `context_token` produced by your **most recent message to the bot**. If a send fails with `delivery-failed`, send the bot any message in WeChat and retry.

## Configuration

`~/.dsh/dsh-butler/config.json` (defaults apply when absent):

```json
{ "enabled": true, "intervalSeconds": 60 }
```

## Limitations

- **Read-only**: it never modifies sessions, configuration or files (apart from its own state file and delivery target).
- "Running" is an approximation: with no `turn/end` in the tail, a log touched within 20 minutes counts as *running*, older as *idle*, and logs under 4 KB as an *empty session*.
- Notifications always carry the `🐳 管家｜` prefix so they are distinguishable from other plugins' messages.
- "Teammates cooperated N times" counts teammate-class tool calls **used during that turn**; a finished `turn/end` means nothing is still waiting.
- Logs over 64 MB are not scanned in detail.

## Compatibility

| Item | Value |
| --- | --- |
| DSH | `0.2.2-rc.1` and newer |
| Node.js | `>=22.19` (uses built-in `zlib.zstdDecompressSync`) |
| Dependencies | none |
| Optional | `@xmanrui/dsh-im` (without it everything works except WeChat push) |

## Development

```sh
node test/selftest.mjs   # offline: both tools and the push chain, no DSH required
node test/watcher.mjs    # integration: the monitor, against real local session logs
```

## License

[MIT](LICENSE)
