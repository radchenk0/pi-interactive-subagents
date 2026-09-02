---
name: plan
description: >
  Planning workflow. Spawns the interactive planner agent, which interviews
  the user (goal → key decisions) and delivers a tightly-scoped spec.md plus a
  sliced plan.md. The planner can spawn researchers mid-session for external
  facts. Use when asked to "plan", "brainstorm", "I want to build X", or
  "let's design". Requires the subagents extension and a supported
  multiplexer (cmux/herdr/tmux/zellij/wezterm).
---

# Plan

A planning workflow. An interactive planner interviews the user to uncover the real **goal**, pins down the key **decisions**, then writes two artifacts: a `spec.md` and a sliced `plan.md`. **The deliverables are the spec and the plan — not implementation.** Execution is a separate, explicit step the user chooses later.

**Announce at start:** "I'll launch the planner — it will interview you about the goal and key decisions, then write a spec and a plan."

---

## The Flow

```
Phase 1: Spawn Planner (interactive — interview → spec.md → plan.md)
    ↓
    (Planner may spawn a researcher mid-session for external facts)
    ↓
Phase 2: Spec + Plan ready (user reviews in the planner pane)
    ↓
Phase 3: (optional, user-driven) Execute slices with workers
    ↓
Phase 4: (optional) Review + test
```

---

## Artifact Paths

Pick a short `<name>` (e.g. `auth-redesign`) and use a shared directory for every deliverable:

- `.pi/plans/YYYY-MM-DD-<name>/spec.md`
- `.pi/plans/YYYY-MM-DD-<name>/plan.md`
- `.pi/plans/YYYY-MM-DD-<name>/review.md` (optional, reviewer output)
- `.pi/plans/YYYY-MM-DD-<name>/test-report.md` (optional, tester output)

---

## Phase 1: Spawn Planner

```typescript
subagent({
  name: "💬 Planner",
  agent: "planner",
  interactive: true,
  task: `Plan: [what the user wants]

Write the spec to .pi/plans/YYYY-MM-DD-<name>/spec.md and the plan to .pi/plans/YYYY-MM-DD-<name>/plan.md.`,
});
```

**The user works with the planner directly in its pane.** It runs the interview (goal first, then key questions one at a time), forces an explicit verification pass over goal + decisions + assumptions, and only then writes the spec and the sliced plan.

When done, the user presses Ctrl+D and the planner's summary (artifact paths) returns to the main session.

### The planner may spawn specialists

During the session the planner can spawn:
- **`researcher`** — when a decision depends on external facts (library tradeoffs, best practices, API behaviors)

These are internal to the planning session. You'll see them in the multiplexer but don't need to intervene.

---

## Phase 2: Spec + Plan

Once the planner closes, read both artifacts and summarize for the user:

> "Spec and plan are ready at `[dir]`. Summary: [goal, key decisions, slices]. Want to execute, or leave it parked?"

**Do not start executing without the user's explicit go-ahead.**

---

## Phase 3: Execute Slices (only on request)

The plan is a set of slices with acceptance criteria. Execute them **sequentially in the same git repo**:

```typescript
subagent({
  name: "🔨 Slice 1/N",
  agent: "pi-worker",
  task: "Implement slice 1: [scope from plan]. Plan: [plan path]. Spec: [spec path].\n\nAcceptance criteria:\n[yes/no checklist from the plan]\n\nReport evidence for each criterion.",
});
```

Check the result and each acceptance criterion before the next slice. If a slice's criteria fail, re-spawn with the failure details before moving on.

---

## Phase 4: Review & Test (on request)

```typescript
subagent({
  name: "🧪 Tester",
  agent: "tester",
  task: "Test the changes for [scope]. Plan: [plan path]. Save the report to .pi/plans/YYYY-MM-DD-<name>/test-report.md",
});

subagent({
  name: "Reviewer",
  agent: "reviewer",
  task: "Review the recent changes. Plan: [plan path]. Save the review to .pi/plans/YYYY-MM-DD-<name>/review.md",
});
```

Triage findings:

- **P0** — broken / unusable → fix now
- **P1** — major → fix before moving on
- **P2 / P3** — note for later

Fix P0/P1 with a worker, re-test only the affected surface.

---

## ⚠️ Completion Checklist

Before reporting done:

1. ✅ Spec and plan written by the planner (paths in the summary)?
2. ✅ (if executing) Every slice's acceptance criteria verified with evidence?
3. ✅ (if executing) Tester + reviewer ran and P0/P1 findings addressed?
