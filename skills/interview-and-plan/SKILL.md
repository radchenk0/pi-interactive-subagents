---
name: interview-and-plan
description: When the user comes with a request or task and asks to plan it — first interview them to uncover the real goal, then pin down key decisions, then deliver a small, tightly-scoped spec and a sliced plan. The deliverables are the spec and the plan. Implementation is a SEPARATE, explicit step — it may never happen. Use whenever a planning request arrives and the goal or requirements are not yet pinned down.
---

# Interview and Plan

The spec is how the user's understanding gets delivered to the AI in a format it can act on. The AI is brilliant at what is measurable but has no signal about the user's context. The spec bridges that gap. It is co-created: the agent interviews, the user corrects.

**The deliverables of this skill are exactly two: the spec and the plan.** Writing any implementation code is OUT OF SCOPE. Implementation is a separate decision the user makes later — it may never happen.

Core rules:
- **The goal is not the task.** "Build a car wash report" is a task; the goal is the outcome it should achieve or the decision it should support. If the user has already stated that goal clearly, record it without asking them to repeat it. Otherwise, extract it through the interview.
- **Every assumption is a drift point.** Every guess the agent makes silently is a chance to drift from what the user actually wants. Surface key decisions and force explicit verification.
- **Agile, not waterfall.** Bias toward smaller, more compartmentalized specs.

## Phase 0 — Goal discovery

Start every planning request here, before any other question.

1. Restate the user's request as a *task* and determine whether the goal is already explicit. If it is, record it without asking the user to repeat it. Otherwise ask the goal question — this one is usually open-ended:
   - `ask_user_question` → "What outcome should this achieve or what decision should it support?" (options: 2-3 plausible goals based on context + Other, NO `(Recommended)` mark — the goal is the user's to decide, never the agent's).
   - If the user's answer reveals a deeper goal, dig one more level. Stop when the answer names a concrete decision or outcome, not another task.
2. Record the goal in one sentence and define observable success criteria. All later questions and the spec must trace back to them.
3. **Escape hatch:** if the user explicitly says "skip the interview" / "don't ask, just plan it" — respect it and jump to phase 2. Infer a provisional goal, success criteria, decisions, and assumptions from the available context. Mark them as provisional and make them concrete enough for the user to verify. In this path, the explicit verification pass in phase 2, step 2 replaces the normal readiness gate and becomes MANDATORY and non-negotiable, because the interview is the only other place assumptions would have surfaced.

## Phase 1 — Key questions

1. Do a quick context recon (project structure, related files) so questions are pointed, not dumb. No deeper than needed to phrase the questions.
2. Pick as many **non-obvious** open or closed(yes/no) questions are needed: edge cases, where things live, failure behavior, scope boundaries, interplay with existing rules, model/dependency requirements.
   - User-preference questions → ask the user.
   - Questions answerable with a grep → answer them yourself, don't ask.
3. Ask **ONE question at a time** using the `ask_user_question` tool. After each call — STOP and wait for the answer. Never bundle multiple questions into one call.

   Call shape:
   - `question` — the single question, as a short title + one line of context if needed.
   - `options` — 2-4 options. The recommended one goes FIRST with `(Recommended)` appended to its label.
   - Each option's `description` — one or two lines: what it means and, for the recommended one, why.
   - The user can always pick "Other" and type a custom answer — never close the question with options alone.
   - State your pick and reason in the option itself (first option + description), not in prose around the call.

   Rules:
   - Never number questions "1 of N" unless N is truly known. If the count is open, keep it open and keep asking until you have enough context.
   - If an answer overrides an earlier recorded decision — update the recorded decision immediately and state in one sentence what was superseded (the spec doesn't exist yet — it's written in phase 2).

4. **Readiness gate:** planning may begin when the goal and success criteria are clear, material user-preference decisions are resolved, repository facts have been investigated, and no foreseeable implementation slice requires a new product decision. When using the escape hatch, skip this pre-planning gate; the explicit verification pass in phase 2, step 2 replaces it.

## Phase 2 — Deliver the spec and the plan

Once all decisions are in, or have been made explicit as provisional under the escape hatch:

1. Write the spec — a short markdown artifact at `.pi/plans/YYYY-MM-DD-<name>/spec.md` (or wherever this project keeps specs). Structure:
   - **Goal** — the one-sentence goal from phase 0. Everything below must serve it.
   - **Success criteria** — observable conditions that show the goal has been achieved.
   - **Decisions** — every decision from the interview: decision + reason (one item per question).
   - **Key assumptions** — every material assumption the agent made that is NOT covered by a decision. If none remain, explicitly write: "None — all material uncertainties were resolved."
   - **Glossary / constraints** — if any.
   - **Out of scope** — explicit.
2. **Force explicit verification.** Present the Goal + Success criteria + Decisions + Key assumptions list to the user and ask them to confirm or correct each item (one pass is fine). Nothing from this list may be treated as settled until the user has seen it. If the user corrects something — update the spec and repeat the pass for the changed items only.
3. Write the plan in the same directory as the spec, at `.pi/plans/YYYY-MM-DD-<name>/plan.md`. Derive it from the spec as **slices, not one big build**: each slice = tight scope → deliverable → review checkpoint → acceptance criteria (short yes/no checklist per slice). The plan must be executable by a future session with zero additional context beyond the spec + plan.
4. Deliver: report the spec and plan paths, then STOP. Ask nothing further and write no code. Say one line: "Spec and plan are ready at `<dir>`"

## Style

- Very concise, short sentences.
- Conduct the interview and all user-facing text in the user's language.
- Never write the spec or plan before the goal and all answers are in.
- Never start implementation from this skill — not even "a little", not even "to validate the plan".
- If the plan no longer fits in a handful of small slices — the scope is too big; say so and propose splitting it.
