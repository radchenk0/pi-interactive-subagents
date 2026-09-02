---
name: run-integration-tests
description: Run the integration test suite and verify all sessions end-to-end. Use when asked to "run integration tests", "run e2e tests", "test before release", "verify integration", "run the full test suite", "check everything works".
---

# Run Integration Tests

Execute the integration test suite inside a supported multiplexer (cmux, herdr, tmux, zellij), then introspect the spawned sessions to verify the full subagent lifecycle worked end-to-end.

## Step 1: Preflight Checks

Verify the environment is ready:

```bash
echo "CMUX_SOCKET_PATH=$CMUX_SOCKET_PATH"
echo "HERDR_PANE_ID=$HERDR_PANE_ID"
echo "TMUX=$TMUX"
echo "ZELLIJ=$ZELLIJ"
node --version
```

- At least one of `CMUX_SOCKET_PATH`, `HERDR_PANE_ID`, `TMUX`, or `ZELLIJ` must be set
- Node 22+ required (24+ for native type-stripping of .ts test files)

If no multiplexer is available, stop and tell the user to run inside one.

> **herdr note:** herdr runs on top of tmux and sets `HERDR_PANE_ID` (not `TMUX`). Backend detection tries herdr before tmux, so running inside herdr selects the herdr backend automatically.

## Step 2: Run Unit Tests

Run the fast unit tests first — if these fail, skip integration tests:

```bash
cd /Users/misha-radchenko/Projects/pi-interactive-subagents && node --test test/test.ts
```

All 141 unit tests must pass. If any fail, stop and fix them before proceeding.

## Step 3: Run Integration Tests

Run the two suites sequentially (no LLM needed for mux-surface; LLM needed for subagent-lifecycle):

```bash
cd /Users/misha-radchenko/Projects/pi-interactive-subagents
PI_TEST_MODEL=vllm/qwen3.8-27b-fp8 node --test --test-concurrency=1 \
  test/integration/mux-surface.test.ts test/integration/subagent-lifecycle.test.ts
```

`--test-concurrency=1` is required: the focus-preservation test asserts global mux state and would race against parallel suites.

`PI_TEST_MODEL` must be a model available on this machine — this fork runs on the local `vllm` provider only (no Anthropic).

Timeout: 10 minutes.

### Expected results

| Suite | Tests | Approx Duration |
|-------|-------|-----------------|
| `mux-surface` | 8 | ~50s |
| `subagent-lifecycle` | 7 | ~180s |

All 15 tests must pass, each parametrized per detected backend (e.g. `[herdr]`, `[cmux]`). If any fail, report the failure output and stop.

The long-running `keeps a long active tool call from surfacing false stalled status` test in `subagent-lifecycle` runs ~100s on its own.

### herdr-specific harness behavior

- Test surfaces split **downward** (right splits halve pane width and wrap marker strings).
- Commands are only typed after the shell reaches an idle prompt (`ensureHerdrShellReady`), since zsh rc loading eats typed characters.
- `readScreen` reads twice and keeps the longer capture (guards against mid-repaint truncation).

## Step 4: Introspect Sessions

After tests pass, verify the sessions created during the test run are well-formed. Find them by looking for session directories matching the temp dir pattern:

```bash
# Find session dirs created in the last 15 minutes
find ~/.pi/agent/sessions -type d -name '--private-var-*pi-integ*' -mmin -15 2>/dev/null
```

If no directory is found, widen the search:

```bash
find ~/.pi/agent/sessions -type d -name '*pi-integ*' 2>/dev/null | tail -5
```

Once found, analyze every session file in that directory:

```bash
SESSION_DIR="<the directory found above>"
for f in "$SESSION_DIR"/*.jsonl; do
  echo "=== $(basename $f) ==="
  head -1 "$f" | python3 -c "
import sys, json
d = json.loads(sys.stdin.readline())
print(f\"  type: {d.get('type')}  id: {d.get('id','?')[:12]}  parent: {'YES' if d.get('parentSession') else 'no'}\")
"
  python3 -c "
import sys, json
roles = {}
for line in open('$f'):
    line = line.strip()
    if not line: continue
    try:
        d = json.loads(line)
        t = d.get('type','?')
        if t == 'message':
            r = d.get('message',{}).get('role','?')
            roles[r] = roles.get(r,0)+1
        else:
            roles[t] = roles.get(t,0)+1
    except: pass
print('  entries:', ' '.join(f'{k}:{v}' for k,v in sorted(roles.items())))
"
done
```

### What to verify

Check each session against these criteria:

| Check | How | Pass condition |
|-------|-----|----------------|
| **Session header** | First line has `"type": "session"` | Every `.jsonl` file |
| **Has messages** | At least 1 `user` + 1 `assistant` message | Every session |
| **Tool usage** | At least 1 `toolResult` entry | Subagent sessions (they run bash/write) |
| **Fork linkage** | `parentSession` field in header | At least 1 session (from fork test) |
| **No errors** | No `"type": "error"` entries | All sessions |
| **Clean exit** | No `stopReason: "aborted"` on final assistant message | All sessions |
| **Parent count** | Multiple parent sessions (one per lifecycle test) | At least 5 parent sessions |
| **Subagent count** | Multiple subagent sessions spawned | At least 7 subagent sessions |

## Step 5: Report

Print a final summary:

```
╭─────────────────────────────────────────────╮
│ Integration Test Results                    │
├─────────────────────────────────────────────┤
│ Unit tests:        141/141 ✅               │
│ Mux surface:       8/8  ✅  [<backend>]     │
│ Subagent lifecycle: 7/7  ✅  [<backend>]    │
│ Session validation: X sessions verified ✅  │
│ Fork linkage:      verified ✅              │
╰─────────────────────────────────────────────╯
```

If any step failed, summarize what broke and suggest next steps.
