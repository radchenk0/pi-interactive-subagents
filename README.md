# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f

**This package is neutral infrastructure.** It provides the mechanics — panes, status widget, ask/answer channels, fork/resume, session files — and takes no position on what a subagent *is*. Roles, standards, and workflows (planner, worker, reviewer, …) belong to an upper layer: your project's `AGENTS.md`, a skills package, or an explicit `systemPrompt`/`tools`/`model` per spawn.

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with their current state — `starting`, `active`, `waiting`, or `stalled`. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  Worker: Auth                active · bash 7m │
│ 00:45  Worker: DB                       waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({
  name: "Worker: Auth",
  task: "Implement the auth module",
  model: "my-provider/my-model",
});
subagent({
  name: "Worker: DB",
  task: "Map the database schema",
  systemPrompt: "You are a careful database engineer. Use evidence, not guesses.",
});
// Both return immediately, results steer back independently
```

## Install

```bash
pi install git:github.com/HazAT/pi-interactive-subagents
```

Supported multiplexers:

- [cmux](https://github.com/manaflow-ai/cmux)
- [herdr](https://github.com/herdr) (raw panes over a local socket server)
- [tmux](https://github.com/tmux/tmux)
- [zellij](https://zellij.dev)
- [WezTerm](https://wezfurlong.org/wezterm/) (terminal emulator with built-in multiplexing)

> **Note:** herdr runs *on top of* tmux (the `TMUX` env is set inside herdr), so detection tries herdr **before** tmux to avoid picking the wrong backend.

Start pi inside one of them:

```bash
cmux pi
# or
herdr        # then run: pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm — no wrapper needed
```

Optional: set `PI_SUBAGENT_MUX=cmux|herdr|tmux|zellij|wezterm` to force a specific backend.

If your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

Subagent panes are created without stealing keyboard focus (cmux, herdr, tmux). Launch commands target child surfaces by explicit ID, so focus and command delivery are independent. Note: the `interactive` option controls parent status notifications, not terminal focus.

### Herdr native agent API

When running under [herdr](https://herdr.dev), subagents use herdr's server-side agent API instead of screen scraping:

- **Completion detection** — `pane wait-output` searches the terminal snapshot and polls server-side for the exit sentinel (no client-side screen-read loop).
- **Interrupts** — sent via `agent send-keys <pane> esc` (herdr-validated key).
- **Naming & visibility** — the subagent's pane is renamed (`agent rename`) and gets a title/display name from the task (`pane report-metadata`), so herdr's agent UI shows `worker · running…` instead of an anonymous shell.
- **Session identity** — the pi session file is bound via `pane report-agent-session`, so herdr can restore the pane after a server restart.
- **Status** — herdr's `agent_status` (`working`/`idle`/`blocked`) is shown in the subagents widget next to each entry.

This is **on by default** when the herdr backend is detected. Opt out with:

```bash
export PI_SUBAGENT_HERDR_NATIVE=0
```

Every native call degrades to the raw pane path (with a one-line warning) if herdr is old or the call fails — subagent results are never affected.

For richer herdr integration (authoritative lifecycle states + native session restore), install herdr's official pi integration: `herdr integration install pi`.

## What's Included

### Extensions

**Subagents** — 6 main-session tools + 1 command:

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately)             |
| `subagent_interrupt` | Interrupt a running subagent's current turn                                                 |
| `subagent_kill`      | Kill a stalled subagent: close the pane, clear the entry, emit a final result               |
| `subagent_resume`    | Resume a previous sub-agent session (async)                                                 |
| `ask_subagent`       | Ask a question to a running sub-agent; blocks until it answers or times out                 |
| `answer_subagent`    | Deliver an answer to a sub-agent blocked in its `ask_parent` call                           |

**Subagent-only tools:** `caller_ping`, `subagent_done`, `ask_parent` (blocking question to the parent), `reply_to_parent` (answers a parent `ask_subagent`).

| Command    | Description                          |
| ---------- | ------------------------------------ |
| `/iterate` | Fork into a subagent for quick fixes |

### A Note on Roles

There are no bundled agent personalities. A subagent is a pi session with:

- the `task` you give it,
- an optional `systemPrompt` (appended to the system prompt),
- an optional `tools` allowlist,
- an optional `model` + `thinking` pin.

If you want roles (planner, worker, reviewer…), define them where your workflow lives — a skills package, project `AGENTS.md` conventions, or explicit spawn parameters — and compose them with this infrastructure.

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in mux pane      → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks all running agents:

```
╭─ Subagents ───────────────────────────────── 3 running ─╮
│ 01:23  Worker: Auth               active · write 7m     │
│ 00:45  Researcher                          stalled 4m   │
│ 00:12  Worker: DB                        starting…      │
╰─────────────────────────────────────────────────────────╯
```

A subagent session ends in exactly one of two ways: the child calls the `subagent_done` tool, or a human closes the pane. There is no silent auto-exit.

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path.

### In-progress status updates

The widget tracks each sub-agent from a child-written runtime snapshot and labels it with a coarse state:

- `starting` — launched, but no valid child snapshot has been observed yet
- `active` — the child is doing observed runtime work: agent turn, provider request, streaming, or tool execution
- `waiting` — the child finished a turn and is intentionally open for more input or another stage
- `stalled` — the parent has gone too long without a valid current child snapshot and can no longer trust the run is healthy

These labels are no longer derived from session-file growth. Session JSONL is still used for transcript, resume, lineage, and result extraction, but liveness now comes from a small activity snapshot written by the child extension. A fixed internal watchdog marks a run as `stalled` when valid snapshots never appear, stop being readable, or stop matching the current child; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay silent.** Long-running user-driven subagents (e.g. a `/iterate` fork you drive by hand) do not wake the parent session on `stalled`/`recovered` transitions — the user is working directly in the subagent's pane, and a steer message there would just burn an orchestrator turn on a no-op "still waiting" ping. The widget still updates normally, and child snapshots are still recorded/classified regardless of the `interactive` setting. Pass `interactive: true` on the tool call to opt a spawn out of stall pings; the default (`false`) is autonomous — the parent gets woken on stalls.

#### Configuration

Status display is controlled by `config.json` in the extension directory. Copy `config.json.example` to get started:

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  }
}
```

`config.json` is gitignored so local overrides don't get committed.

---

## Spawning Subagents

```typescript
// Plain spawn — the child gets pi's default tools and model
subagent({ name: "Fixer", task: "Fix the failing pagination test" });

// Role via system prompt + pinned model/thinking + narrowed tools
subagent({
  name: "Researcher",
  systemPrompt: "You are a web researcher. Cite sources. Write findings to research/notes.md.",
  model: "my-provider/my-model",
  thinking: "high",
  tools: "read, bash, write",
  task: "Research Postgres logical replication options",
});

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Custom working directory (own AGENTS.md, skills, config)
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Display name (shown in widget and pane title)                                                     |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `systemPrompt`         | string  | —              | Appended to the child's system prompt (identity/role)                                             |
| `model`                | string  | —              | Model pin (`provider/model`); default: the child's own default model                              |
| `thinking`             | string  | —              | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`                         |
| `skills`               | string  | —              | Comma-separated skill names to invoke in the child                                                |
| `tools`                | string  | —              | Comma-separated native pi tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Subagent control tools (`subagent_done`, `ask_parent`, …) are always included. |
| `cwd`                  | string  | —              | Working directory for the sub-agent (absolute, or relative to the parent's cwd)                   |
| `fork`                 | boolean | `false`        | Force a full-context fork for this spawn (the child inherits the parent's conversation)           |
| `interactive`          | boolean | `false`        | Mark this spawn as user-driven: don't wake the parent on stall/recovery                           |
| `resumeSessionId`      | string  | —              | (Internal) resume a previous session by id — normally use `subagent_resume`                       |

---

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Worker" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately moves the child back to `waiting`, and stale pre-interrupt snapshots are ignored. If the child starts work later, newer snapshots return it to `active`; completion, failure, and `caller_ping` still flow through normally.

This is a turn-level interrupt, not a method for forcibly terminating a subagent session. Use `subagent_kill` for that.

---

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a subagent request help from its parent agent. When called, the child session **exits** and the parent receives a notification with the help message. The parent can then **resume** the child session with a response using `subagent_resume`.

**`caller_ping` parameters:**
- `message` (required): What you need help with

**`subagent_resume` parameters:**
- `sessionPath` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for the resumed pane (defaults to `Resume`)
- `message` (optional): Follow-up prompt to send after resuming
- `interactive` (optional): Mark the resumed session as user-driven (no stall pings). Defaults to `false`.

**Interaction flow:**
1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. Child session exits (like `subagent_done`)
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. Parent resumes the child session via `subagent_resume` with the response
5. Child picks up where it left off with the parent's guidance

**Example:**
```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits here. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside subagent contexts. Calling it from a standalone pi session returns an error.

---

## Communication with sub-agents

Beyond the exit-based `caller_ping`, agents can communicate **live** over a file-based RPC channel (sidecar files next to the child session file, polled every 500 ms).

**Child → parent (live, blocking):** the child calls `ask_parent` with a question (and optional options, recommended one first). The child's turn **blocks** until the parent answers (default timeout: 10 minutes, configurable via `PI_SUBAGENT_QUESTION_TIMEOUT_MS`). The parent receives a `subagent_question` steer and answers with `answer_subagent` — the child's turn continues immediately with the answer. On timeout the child proceeds with its best judgment and records the assumption in its final report.

**Parent → child (live, blocking):** the parent calls `ask_subagent` — the question is injected into the child's terminal; the child answers with its `reply_to_parent` tool and the `ask_subagent` call returns with the answer.

**Exit-based escalation** is available as a fallback: a subagent can write a structured question sidecar (the bundled `pi-escalate` helper does this), exit, and be resumed with the answer via `subagent_resume` — the same flow as `caller_ping`.

**Escalation to a human** is always the parent model's own decision (it can use its `ask_user_question` tool) — the channel never forces it.

```typescript
// Parent side
await ask_subagent({ name: "Worker", question: "Which DB driver?", options: [...] }); // blocks
await answer_subagent({ name: "Worker", answer: "Use pg" }); // child unblocks

// Child side
const res = await ask_parent({ question: "v1 or v2 migration?", options: [{ label: "v2 (Recommended)" }] }); // blocks
```

Both directions respect the same 10-minute default timeout and the qid-matched sidecar protocol, so stale files from previous rounds can never answer a live wait.

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── AGENTS.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── AGENTS.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── AGENTS.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

When the target `cwd` has its own `.pi/agent/` directory, it is used as the child's config root (its own extensions, skills, and models); otherwise the parent's config root is propagated.

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+Shift+J`:

```
[worker] — 12 tools  (Ctrl+Shift+J)                 ← collapsed
[worker] — 12 available  (Ctrl+Shift+J to collapse)  ← expanded
  read, bash, edit, write, todo, ...
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- One supported multiplexer:
  - [cmux](https://github.com/manaflow-ai/cmux)
  - [herdr](https://github.com/herdr)
  - [tmux](https://github.com/tmux/tmux)
  - [zellij](https://zellij.dev)
  - [WezTerm](https://wezfurlong.org/wezterm/)

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm
```

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or herdr, tmux, zellij, wezterm
```

---

## Acknowledgements

The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT
