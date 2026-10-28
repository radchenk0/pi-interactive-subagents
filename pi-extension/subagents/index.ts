import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  sendLongCommand,
  sendCommand,
  pollForExit,
  closeSurface,
  getMuxBackend,
  herdrCli,
  sendEscape,
  shellEscape,
  renameCurrentTab,
  renameWorkspace,
  readScreen,
} from "./cmux.ts";

import {
  findLastAssistantMessage,
  getNewEntries,
  seedSubagentSessionFile,
} from "./session.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";
import {
  applyHerdrAgentIdentity,
  herdrNativeEnabled,
  nativeAgentStatusMap,
  nativeSendEscape,
  nativeWaitSentinel,
} from "./herdr-native.ts";
import {
  clearQuestionSidecars,
  formatQuestionForDisplay,
  readQuestion,
  waitForReply,
  writeAnswer,
  writeParentReply,
  writeQuestion,
  questionTimeoutMs,
  type QuestionOption,
  type QuestionPayload,
} from "./question-channel.ts";
import { randomUUID } from "node:crypto";

/**
 * One-line warning when the native herdr path degrades to the raw path.
 */
let nativeFallbackWarned = false;
function nativeSlowPathFor(surface: string): Promise<{ exitCode: number } | null> {
  return nativeWaitSentinel(surface, 1500).catch((error: any) => {
    if (!nativeFallbackWarned) {
      nativeFallbackWarned = true;
      console.warn(`[subagents] herdr native wait-output failed, using screen reads: ${error?.message ?? error}`);
    }
    throw error;
  });
}

/** Fire-and-forget herdr display identity (display only, never blocks). */
function applyHerdrIdentityIfEnabled(
  surface: string,
  opts: { displayName?: string; taskId: string; task?: string; sessionFile?: string },
): void {
  if (!herdrNativeEnabled()) return;
  void applyHerdrAgentIdentity(surface, opts).catch(() => {});
}

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({
    description:
      "Task/prompt for the sub-agent. Make it self-contained: the sub-agent does not share your conversation unless fork: true. State the goal, the constraints, and what 'done' looks like.",
  }),
  systemPrompt: Type.Optional(
    Type.String({
      description:
        "Appended to the sub-agent's system prompt. Use for role instructions and task-specific rules.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "Model for the sub-agent as 'provider/id'. Falls back to the PI_SUBAGENT_MODEL env var when omitted, then to the sub-agent's own default model.",
    }),
  ),
  thinking: Type.Optional(
    Type.String({
      description:
        "Thinking level: off, minimal, low, medium, high, xhigh, max. Falls back to the PI_SUBAGENT_THINKING env var, then to 'medium'.",
    }),
  ),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills to load in the sub-agent" }),
  ),
  tools: Type.Optional(
    Type.String({
      description:
        "Comma-separated ALLOWLIST of tools the sub-agent may use. By default the sub-agent gets the standard pi toolset (read, write, edit, bash, ffgrep, fffind, web tools, installed extensions). The 4 control tools (subagent_done, caller_ping, ask_parent, reply_to_parent) are always present and cannot be removed. Use this to reduce the surface, not to grant extra power: it never adds spawning tools (see spawning).",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, AGENTS.md, skills, and extensions.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "Mark the subagent as interactive (long-running, user drives the conversation in its own pane). When true, the main session is not woken by status transitions (stalled/recovered) for this subagent. Defaults to false (autonomous: the parent is woken on stalls and expects a subagent_done result).",
    }),
  ),
  spawning: Type.Optional(
    Type.Boolean({
      description:
        "Allow this sub-agent to spawn further sub-agents. Off by default: sub-agent sessions do NOT get the subagent-spawning tools (subagent, subagent_resume, subagent_interrupt, subagent_kill, ask_subagent, answer_subagent). Set true only for orchestrator-style sub-agents that must delegate work further. The grant is not preserved across subagent_resume.",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous pi session by its ID. Loads the conversation history and continues where it left off. Use this to retry cancelled runs or ask follow-up questions.",
    }),
  ),
});

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

/** Tools that spawn or drive sub-agents. Gated by resolveSpawnAllowed(). */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagent_kill",
  "subagent_resume",
  "ask_subagent",
  "answer_subagent",
]);

/**
 * Whether the subagent-spawning tools are registered in this session.
 * Top-level sessions always get them. Sub-agent sessions (PI_SUBAGENT_ID
 * set by the spawner) only get them when the parent explicitly granted
 * spawning (PI_SUBAGENT_ALLOW_SPAWNING=1, propagated from spawning: true).
 */
export function resolveSpawnAllowed(): boolean {
  if (!process.env.PI_SUBAGENT_ID) return true;
  return process.env.PI_SUBAGENT_ALLOW_SPAWNING === "1";
}

/**
 * Thinking level resolution: explicit param → PI_SUBAGENT_THINKING env var
 * → "medium" default.
 */
export function resolveEffectiveThinking(paramThinking?: string): string {
  return paramThinking || process.env.PI_SUBAGENT_THINKING || "medium";
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const effectiveCwd = params.cwd
    ? params.cwd.startsWith("/")
      ? params.cwd
      : join(process.cwd(), params.cwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveLaunchBehavior(params: Static<typeof SubagentParams>): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode: SubagentSessionMode = params.fork ? "fork" : "standalone";
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

/**
 * Whether a subagent is interactive (user-driven, long-running pane) or
 * autonomous (parent gets woken on stalls, expects a subagent_done result).
 * Defaults to autonomous; pass `interactive: true` for user-driven panes
 * (e.g. `/iterate` forks).
 */
function resolveEffectiveInteractive(params: Static<typeof SubagentParams>): boolean {
  return params.interactive ?? false;
}

/**
 * Model resolution: the explicit `model` param wins; PI_SUBAGENT_MODEL is
 * the global fallback for all subagents; otherwise the child's own default.
 */
export function resolveEffectiveModel(paramModel?: string): string | undefined {
  return paramModel || process.env.PI_SUBAGENT_MODEL || undefined;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "errorMessage" | "crashMessage"
  >,
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.crashMessage) {
    // The pane died externally (killed, terminal closed, ...) — not a
    // provider/agent error. The summary already carries the crash note and
    // whatever output the subagent produced before dying.
    return (
      `Sub-agent "${name}" crashed after ${formatElapsed(result.elapsed)}.\n\n` +
      `${result.summary}${sessionRef}`
    );
  }

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** Crash cause when the subagent's pane died externally (not a provider error). */
  crashMessage?: string;
  ping?: { name: string; message: string };
  /** Question the subagent exited with (exit-based escalation). */
  question?: { qid: string; question: string; options?: QuestionOption[]; multiSelect?: boolean };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  /** Set when subagent_kill was called for this entry. */
  killRequested?: boolean;
  /** qids of live worker questions already delivered as steer messages. */
  notifiedQids?: Set<string>;
  statusState: SubagentStatusState;
  /** herdr-reported agent state (working/idle/blocked/...) — display only. */
  agentStatus?: string;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Latest ExtensionAPI, used for out-of-tool message delivery (live worker questions). */
let latestPi: ExtensionAPI | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const herdrTag = agent.agentStatus ? ` · ${agent.agentStatus}` : "";
    const left = ` ${elapsed}  ${agent.name}${herdrTag} `;
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = [
  "caller_ping",
  "subagent_done",
  "ask_parent",
  "reply_to_parent",
] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call subagent_done.
 */
function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

/**
 * Default interrupt key sender. With the native herdr API enabled, prefers
 * herdr's validated `agent send-keys esc`; falls back to raw pane send-keys
 * on any failure (nativeSendEscape returns false).
 */
function sendInterruptKey(surface: string): void {
  if (herdrNativeEnabled() && nativeSendEscape(surface)) return;
  sendEscape(surface);
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void = sendInterruptKey,
): { ok: true } | { error: string } {
  try {
    sendEscapeKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    const backend = getMuxBackend() ?? "unknown";
    return {
      error:
        `Failed to send Escape to subagent "${running.name}" via ${backend}: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  sendEscapeKey: (surface: string) => void = sendInterruptKey,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, sendEscapeKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.id, name: running.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.name}".` }],
    details: { id: running.id, name: running.name, status: "interrupt_requested" },
  };
}

/**
 * Kill a subagent's pane and its processes (best effort), then close the
 * pane. On herdr the shell and foreground process group are SIGKILLed first
 * so the child pi process cannot outlive the pane. Never throws.
 */
function killSubagentSurface(surface: string): void {
  if (getMuxBackend() === "herdr") {
    try {
      const info = herdrCli(["pane", "process-info", "--pane", surface]) as any;
      const proc = info?.process_info ?? info;
      const shellPid = Number.isInteger(proc?.shell_pid) ? (proc.shell_pid as number) : null;
      const fgPgid = Number.isInteger(proc?.foreground_process_group_id)
        ? (proc.foreground_process_group_id as number)
        : null;
      if (shellPid != null) {
        try { process.kill(shellPid, "SIGKILL"); } catch {}
      }
      if (fgPgid != null) {
        try { process.kill(-fgPgid, "SIGKILL"); } catch {}
      }
    } catch {
      // Pane or process info unavailable — closing the pane below still cleans up.
    }
  }
  closeSurface(surface);
}

/**
 * Kill a running subagent: stop its watcher (so it emits a final
 * "killed" subagent_result instead of polling a dead pane), terminate the
 * child processes, close the pane, and remove the running entry. The
 * session file is preserved for subagent_resume.
 */
function handleSubagentKill(
  params: { id?: string; name?: string },
  killSurfaceFn: (surface: string) => void = killSubagentSurface,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;

  // Mark + abort so the watcher's catch path emits "killed" (not
  // "cancelled") as the final subagent_result.
  running.killRequested = true;
  running.abortController?.abort();

  try {
    killSurfaceFn(running.surface);
  } catch {
    // Pane may already be gone — the kill still succeeded.
  }

  runningSubagents.delete(running.id);
  updateWidget();

  return {
    content: [{
      type: "text" as const,
      text:
        `Sub-agent "${running.name}" killed. Pane closed, entry removed. ` +
        `The session file is preserved for resume: ${running.sessionFile}`,
    }],
    details: {
      id: running.id,
      name: running.name,
      status: "killed",
      sessionFile: running.sessionFile,
    },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    // Display-only: refresh herdr-reported agent states (working/idle/blocked)
    // for the widget. One local-socket CLI call; failures are no-ops.
    if (herdrNativeEnabled()) {
      const statusMap = nativeAgentStatusMap();
      for (const running of runningSubagents.values()) {
        running.agentStatus = statusMap.get(running.surface) ?? undefined;
      }
    }

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  resolveEffectiveModel,
  resolveEffectiveThinking,
  resolveSpawnAllowed,
  SPAWNING_TOOLS,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
  handleSubagentKill,
  killSubagentSurface,
  resolveResultPresentation,
  runningSubagents,
  formatElapsed,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  // Model resolution: explicit param wins, PI_SUBAGENT_MODEL is the global
  // fallback (see resolveEffectiveModel).
  const effectiveModel = resolveEffectiveModel(params.model);
  const effectiveTools = params.tools;
  const effectiveSkills = params.skills;
  const effectiveThinking = resolveEffectiveThinking(params.thinking);
  const effectiveInteractive = resolveEffectiveInteractive(params);

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  const launchBehavior = resolveLaunchBehavior(params);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  const modeHint =
    "Complete your task. When finished, your LAST action must be a call to the subagent_done tool — never end your turn with plain text, or your results will not be delivered. The user can interact with you at any time.";
  const summaryInstruction =
    "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const identity = params.systemPrompt ?? null;
  const fullTask = inheritsConversationContext
    ? params.task
    : `${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;
  // ── Pi CLI path ──

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  if (effectiveModel) {
    parts.push("--model", shellEscape(effectiveModel));
  }
  if (effectiveThinking) {
    parts.push("--thinking", shellEscape(effectiveThinking));
  }

  // Pass the system prompt via file to avoid shell escaping issues with
  // multiline content. Pi's --append-system-prompt auto-detects file paths
  // and reads their contents.
  if (identity) {
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const syspromptPath = join(artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
    parts.push("--append-system-prompt", shellEscape(syspromptPath));
  }

  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
  if (toolAllowlist) {
    parts.push("--tools", shellEscape(toolAllowlist));
  }

  // Build env prefix: subagent identity + config dir propagation
  const envParts: string[] = [];

  // If the target cwd has its own .pi/agent/, use that as the config root.
  // Otherwise propagate the current/global agent dir.
  if (localAgentDir && existsSync(localAgentDir)) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
  } else if (process.env.PI_CODING_AGENT_DIR) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
  }

  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  if (params.spawning === true) {
    envParts.push(`PI_SUBAGENT_ALLOW_SPAWNING=1`);
  }
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);
  sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    activityFile,
    interactive: effectiveInteractive,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
    }),
  };

  runningSubagents.set(id, running);
  applyHerdrIdentityIfEnabled(surface, {
    displayName: params.name,
    taskId: id,
    task: params.task,
    sessionFile: subagentSessionFile,
  });
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
/**
 * Deliver a live worker question to the parent session as a steer, once per qid.
 * The child stays alive and blocked in its ask_parent tool until answered.
 */
function handleLiveWorkerQuestion(running: RunningSubagent, q: QuestionPayload): void {
  if (running.notifiedQids?.has(q.qid)) return;
  running.notifiedQids ??= new Set();
  running.notifiedQids.add(q.qid);

  latestPi?.sendMessage(
    {
      customType: "subagent_question",
      content:
        `Sub-agent "${running.name}" is asking (its turn is blocked, waiting for your answer):\n\n` +
        `${formatQuestionForDisplay(q)}\n\n` +
        `Answer with answer_subagent {id: "${running.id}", answer: "..."}. ` +
        `If a human decision is required, first ask the user with ask_user_question and answer with their choice. ` +
        `Do not guess the worker's question yourself.`,
      display: true,
      details: {
        name: running.name,
        qid: q.qid,
        question: q.question,
        ...(q.options?.length ? { options: q.options } : {}),
        sessionFile: running.sessionFile,
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      activityFile: running.activityFile,
      onTick() {
        observeRunningSubagent(running);
      },
      onQuestion(q) {
        handleLiveWorkerQuestion(running, q);
      },
      nativeSlowPath: herdrNativeEnabled() ? (s) => nativeSlowPathFor(s) : undefined,
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // Pi subagent result extraction
    const crashMessage = result.reason === "crashed" ? result.errorMessage : undefined;
    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (crashMessage
          ? `Subagent error: ${crashMessage}`
          : result.errorMessage
            ? `Subagent error: ${result.errorMessage}`
            : result.exitCode !== 0
              ? `Sub-agent exited with code ${result.exitCode}`
              : "Sub-agent exited without output");
    } else {
      summary = crashMessage
        ? `Subagent error: ${crashMessage}`
        : result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output";
    }
    if (crashMessage) {
      summary = `⚠ ${crashMessage}\n\n${summary}`;
    }

    try {
      closeSurface(surface);
    } catch {
      // Pane may already be gone (e.g. destroyed externally) — the result
      // is still valid; do not mask it with a close error.
    }
    runningSubagents.delete(running.id);

    return {
      name,
      task,
      summary,
      sessionFile,
      exitCode: result.exitCode,
      elapsed,
      ping: result.ping,
      ...(result.question ? { question: result.question } : {}),
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      ...(crashMessage ? { crashMessage } : {}),
    };
  } catch (err: any) {
    try {
      closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    const moduleAborted = getModuleAbortSignal().aborted;
    if (signal.aborted || moduleAborted) {
      const killed = running.killRequested === true;
      return {
        name,
        task,
        summary:
          killed
            ? "Subagent killed by the caller."
            : moduleAborted && !signal.aborted
              ? "Subagent cancelled (session ended)."
              : "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: killed ? "killed" : "cancelled",
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;

  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // Session switches (/new, /resume, /fork, /reload) fire session_shutdown,
    // which aborts the module-level poll AbortController. Without re-import the
    // aborted controller would survive into the new session and kill every
    // subagent on its first poll tick ("Aborted while waiting for subagent to
    // finish"). Re-create it so polling works in the next session too.
    (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

    // Environment-level escape hatch: tools listed in PI_DENY_TOOLS are not
    // registered in this session. (The orchestrator does not set this — a
    // user can export it manually to hide specific tools.)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  // Sub-agent sessions do not get the spawning tools unless the parent
  // explicitly granted it (see resolveSpawnAllowed).
  const spawnAllowed = resolveSpawnAllowed();

  const shouldRegister = (name: string) =>
    !deniedTools.has(name) && (!SPAWNING_TOOLS.has(name) || spawnAllowed);

  // ── subagent tool ──
  if (shouldRegister("subagent"))
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane to execute a task in the background. " +
        "This is the PREFERRED way to delegate work: use it whenever the user asks to spawn, launch, or delegate agents/workers for one or more independent tasks (writing code, research, tests, docs), or whenever the deliverable is a RESULT rather than a conversation the user drives. " +
        "\n\nASYNC PROTOCOL — " +
        "This is a fire-and-forget tool: the call returns an immediate acknowledgement and your turn continues. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn. " +
        "DO NOT poll: no sleep/wait loops, no tail/watch scripts, no reading session/log files, no listing commands to check status — the harness handles delivery. " +
        "DO NOT fabricate, assume, or summarize the result before the steer arrives. " +
        "After spawning, either end your turn immediately or work on other independent tasks (including spawning more sub-agents in parallel). " +
        "\n\nWHAT THE SUB-AGENT HAS — " +
        "The sub-agent is a full pi agent in its own pane: " +
        "the standard pi toolset (read, write, edit, bash, ffgrep, fffind, web tools, installed extensions) — the `tools` param is an allowlist that REDUCES that surface — " +
        "PLUS 4 control tools the harness relies on: `subagent_done` (its ONLY way to finish with a result), `ask_parent` (asks you a question, blocks until you answer via answer_subagent), `reply_to_parent` (answers your ask_subagent question), `caller_ping` (signals you that it is parked and waiting for a follow-up). " +
        "MINUS the subagent-spawning tools (unless spawning: true) and ask_user_question (a sub-agent never talks to the user directly — it must route questions through you via ask_parent). " +
        "The sub-agent's session ends ONLY when it calls subagent_done (with its summary and session path) or the user closes the pane — it never auto-exits. " +
        "Recursion is OFF by default: a sub-agent cannot spawn further sub-agents unless you pass spawning: true. " +
        "\n\nPARAMETERS — " +
        "Required: name, task (make the task self-contained: the sub-agent does not see your conversation unless fork: true). " +
        "Optional: model ('provider/id'; falls back to PI_SUBAGENT_MODEL, then the child's default), thinking (off…max; default medium), systemPrompt (role instructions), skills, tools (allowlist), cwd (local .pi config / AGENTS.md / skills), fork (inherit this conversation), interactive (long-running, user-driven pane; parent not woken on stalls), spawning (grant further delegation), resumeSessionId. " +
        "\n\nCONTROLLING A RUNNING SUB-AGENT — " +
        "On a FAILED or cancelled steer, inspect the pane with subagent_resume (pass the session path) BEFORE judging the outcome; you can resume with fix instructions. " +
        "ask_subagent asks a running sub-agent a multiple-choice question; answer_subagent delivers the answer to one that is parked waiting; subagent_interrupt sends Esc; subagent_kill terminates.",
      promptSnippet:
        "Spawn a background sub-agent in a dedicated pane — the preferred way to delegate independent tasks whose deliverable is a result. " +
        "Fire-and-forget: the result arrives as an automatic steer message; do NOT poll, do NOT assume the outcome. " +
        "Sub-agents get the standard pi toolset + 4 control tools (subagent_done, ask_parent, reply_to_parent, caller_ping); they cannot spawn further sub-agents unless spawning: true, and they finish only via subagent_done. " +
        "On failure, inspect with subagent_resume before judging.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Launch the subagent (creates pane, sends command)
        const running = await launchSubagent(params, ctx);

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background
        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget(); // reflect removal from Map immediately

            if (result.question) {
              // Exit-based escalation: the session ended with a structured
              // question — resume it with the answer.
              const q = result.question;
              pi.sendMessage(
                {
                  customType: "subagent_question",
                  content:
                    `Sub-agent "${result.name}" exited with a question and needs your answer (${formatElapsed(result.elapsed)}):\n\n` +
                    `${formatQuestionForDisplay({ qid: q.qid, from: "worker", question: q.question, options: q.options, multiSelect: q.multiSelect, ts: 0 })}\n\n` +
                    `If a human decision is required, first ask the user with ask_user_question. ` +
                    `Then resume the sub-agent with the answer: subagent_resume {sessionPath: "${result.sessionFile}", message: "Answer to your question: <answer>"}.\n\n` +
                    `Session: ${result.sessionFile}`,
                  display: true,
                  details: {
                    name: result.name,
                    qid: q.qid,
                    question: q.question,
                    ...(q.options?.length ? { options: q.options } : {}),
                    sessionFile: result.sessionFile,
                    resumeMessage: `Answer to your question: <answer>`,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            if (result.ping) {
              // Subagent is requesting help — steer a ping message with session path for resume
              const sessionRef = `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`;
              pi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    sessionFile: result.sessionFile,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            const presentation = resolveResultPresentation(result, running.name);

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name: running.name,
                  task: running.task,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.crashMessage ? { crashMessage: result.crashMessage } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            status: "started",
          },
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
  if (shouldRegister("subagent_interrupt"))
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      promptSnippet:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_kill tool ──
  if (shouldRegister("subagent_kill"))
    pi.registerTool({
      name: "subagent_kill",
      label: "Kill Subagent",
      description:
        "Kill a running subagent: terminate its child process, close its pane, remove it from the running list, " +
        "and emit a final subagent_result so the count is cleared. " +
        "Use to drop a stalled or interrupted subagent that you no longer need. " +
        "The session file is preserved — resume it later with subagent_resume.",
      promptSnippet:
        "Kill a running subagent: terminate its child process, close its pane, remove it from the running list, " +
        "and emit a final subagent_result so the count is cleared. " +
        "Use to drop a stalled or interrupted subagent that you no longer need. " +
        "The session file is preserved — resume it later with subagent_resume.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentKill(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — kill"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "killed") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — killed, session preserved for resume"),
            0,
            0,
          );
        }

        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── answer_subagent tool (deliver answer to a blocked worker) ──
  if (shouldRegister("answer_subagent"))
    pi.registerTool({
      name: "answer_subagent",
      label: "Answer Subagent",
      description:
        "Deliver an answer to a running sub-agent that is blocked in its ask_parent call. " +
        "The sub-agent's turn continues immediately with your answer. " +
        "Use when you received a subagent_question steer from a worker.",
      promptSnippet:
        "Deliver an answer to a running sub-agent that is blocked in its ask_parent call. " +
        "The sub-agent's turn continues immediately with your answer.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
        answer: Type.String({
          description: "The answer text to deliver to the waiting sub-agent.",
        }),
      }),

      async execute(_toolCallId, params) {
        const resolved = resolveInterruptTarget(params);
        if ("error" in resolved) {
          return {
            content: [{ type: "text" as const, text: resolved.error }],
            details: { error: resolved.error },
          };
        }

        const running = resolved.running;
        const q = readQuestion(running.sessionFile);
        if (!q || q.from !== "worker") {
          return {
            content: [
              {
                type: "text" as const,
                text: `Sub-agent "${running.name}" has no pending question (it may have timed out and moved on).`,
              },
            ],
            details: { id: running.id, name: running.name, error: "no pending question" },
          };
        }

        writeAnswer(running.sessionFile, { qid: q.qid, answer: params.answer, ts: Date.now() });

        return {
          content: [
            {
              type: "text" as const,
              text: `Answer delivered to sub-agent "${running.name}". Its turn continues with your answer.`,
            },
          ],
          details: { id: running.id, name: running.name, qid: q.qid },
        };
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — answer"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.error) {
          const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
          return new Text(theme.fg("dim", text), 0, 0);
        }
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(details?.name ?? details?.id ?? "subagent")) +
            theme.fg("dim", " — answer delivered"),
          0,
          0,
        );
      },
    });

  // ── ask_subagent tool (parent asks a live worker a question) ──
  if (shouldRegister("ask_subagent"))
    pi.registerTool({
      name: "ask_subagent",
      label: "Ask Subagent",
      description:
        "Ask a question to a RUNNING pi sub-agent. The question is injected into the sub-agent's " +
        "terminal; it answers with its reply_to_parent tool and this tool returns the answer. " +
        "Your turn is blocked until the sub-agent answers or the timeout fires.",
      promptSnippet:
        "Ask a question to a RUNNING pi sub-agent; blocks until it answers (or times out).",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
        question: Type.String({ description: "The question to ask the sub-agent." }),
        details: Type.Optional(
          Type.String({ description: "Optional extra context shown with the question." }),
        ),
        options: Type.Optional(
          Type.Array(
            Type.Object({
              label: Type.String({ description: "Display label for the option." }),
              value: Type.Optional(Type.String({ description: "Optional machine-readable value." })),
              description: Type.Optional(Type.String({ description: "Optional detail below the option." })),
            }),
            { description: "Optional multiple-choice options to offer the sub-agent." },
          ),
        ),
        multiSelect: Type.Optional(
          Type.Boolean({ description: "Set true when several options may be chosen." }),
        ),
      }),

      async execute(_toolCallId, params, signal) {
        const resolved = resolveInterruptTarget(params);
        if ("error" in resolved) {
          return {
            content: [{ type: "text" as const, text: resolved.error }],
            details: { error: resolved.error },
          };
        }

        const running = resolved.running;

        const qid = randomUUID();
        const q: QuestionPayload = {
          qid,
          from: "parent",
          question: params.question,
          ...(params.details ? { details: params.details } : {}),
          ...(params.options?.length ? { options: params.options as QuestionOption[] } : {}),
          ...(typeof params.multiSelect === "boolean" ? { multiSelect: params.multiSelect } : {}),
          ts: Date.now(),
        };
        writeQuestion(running.sessionFile, q);

        // Inject the question into the child TUI. Single line on purpose:
        // the child's input box queues it until the current turn boundary.
        const optionsText =
          params.options?.length
            ? ` Options: ${params.options.map((o, i) => `${i + 1}. ${o.label}`).join("; ")}.`
            : "";
        const injected = `❓ Question from parent: ${params.question}${optionsText} Answer using the reply_to_parent tool (answer text as your answer parameter).`;
        try {
          sendCommand(running.surface, injected);
        } catch (err: any) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Could not inject the question into sub-agent "${running.name}" (pane may be gone): ${err?.message ?? String(err)}`,
              },
            ],
            details: { id: running.id, name: running.name, error: "injection failed" },
          };
        }

        const reply = await waitForReply(running.sessionFile, "parent-reply", qid, { signal });
        if (reply.ok) {
          return {
            content: [{ type: "text" as const, text: `Sub-agent "${running.name}" answered: ${reply.answer}` }],
            details: { id: running.id, name: running.name, qid, answer: reply.answer },
          };
        }
        const reason = reply.reason === "aborted" ? "you were interrupted" : `no answer within ${Math.round(questionTimeoutMs() / 60000)} minutes`;
        return {
          content: [
            {
              type: "text" as const,
              text: `Sub-agent "${running.name}" did not answer: ${reason}. It may still answer later — the question file stays until it does.`,
            },
          ],
          details: { id: running.id, name: running.name, qid, error: reply.reason },
        };
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — ask: ") +
            theme.fg("muted", String(args.question ?? "").slice(0, 60)),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.answer) {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details?.name ?? details?.id ?? "subagent")) +
              theme.fg("dim", " — answered: ") +
              theme.fg("muted", String(details.answer).slice(0, 80)),
            0,
            0,
          );
        }
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_resume tool ──
  if (shouldRegister("subagent_resume"))
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work, and as the FIRST step after a FAILED or cancelled steer: inspect the pane to see where it got stuck, then resume with fix instructions. " +
        "Note: the resumed session runs with a fresh environment — a spawning grant from the original spawn is not preserved, and the model stays whatever the session file has.",
      promptSnippet:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
        interactive: Type.Optional(
          Type.Boolean({
            description:
              "Mark the resumed session as interactive (user-driven, long-running). Defaults to false (autonomous: the parent is woken on stalls and the subagent_done result is expected).",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const name = params.name ?? "Resume";
        const interactive = params.interactive ?? false;
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        // Record entry count before resuming so we can extract new messages
        const entryCountBefore = getNewEntries(params.sessionPath, 0).length;

        const surface = createSurface(name);
        await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

        // Build pi resume command
        const parts = ["pi", "--session", shellEscape(params.sessionPath)];

        // Load subagent-done extension so the agent can self-terminate if needed
        const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
        parts.push("-e", shellEscape(subagentDonePath));

        const sessionId = ctx.sessionManager.getSessionId();
        const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        let resumeMsgFile: string | undefined;
        if (params.message) {
          const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          resumeMsgFile = join(
            artifactDir,
            "subagent-resume",
            `${name
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, "")
              .replace(/\s+/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`,
          );
          mkdirSync(dirname(resumeMsgFile), { recursive: true });
          writeFileSync(resumeMsgFile, params.message, "utf8");
          parts.push(shellEscape(`@${resumeMsgFile}`));
        }

        // Build env prefix — propagate PI_CODING_AGENT_DIR for config isolation
        const resumeEnvParts: string[] = [];
        if (process.env.PI_CODING_AGENT_DIR) {
          resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
        }
        resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
        resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(params.sessionPath)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
        const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

        const command = `${resumeEnvPrefix}${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`,
        );
        sendLongCommand(surface, command, {
          scriptPath: launchScriptFile,
          scriptPreamble: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${params.sessionPath}`,
            `# Surface: ${surface}`,
            ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
          ].join("\n"),
        });

        // Register as a running subagent for widget tracking.
        // Clear stale question sidecars from previous rounds of this session.
        clearQuestionSidecars(params.sessionPath);
        const running: RunningSubagent = {
          id,
          name,
          task: params.message ?? "resumed session",
          surface,
          startTime,
          sessionFile: params.sessionPath,
          launchScriptFile,
          activityFile,
          interactive,
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
          }),
        };
        runningSubagents.set(id, running);
        applyHerdrIdentityIfEnabled(surface, {
          displayName: name,
          taskId: id,
          task: params.message ?? "resumed session",
          sessionFile: params.sessionPath,
        });
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            updateWidget();

            if (result.question) {
              // Exit-based escalation: resume with the answer.
              const q = result.question;
              pi.sendMessage(
                {
                  customType: "subagent_question",
                  content:
                    `Sub-agent "${result.name}" exited with a question and needs your answer (${formatElapsed(result.elapsed)}):\n\n` +
                    `${formatQuestionForDisplay({ qid: q.qid, from: "worker", question: q.question, options: q.options, multiSelect: q.multiSelect, ts: 0 })}\n\n` +
                    `If a human decision is required, first ask the user with ask_user_question. ` +
                    `Then resume the sub-agent with the answer: subagent_resume {sessionPath: "${result.sessionFile}", message: "Answer to your question: <answer>"}.\n\n` +
                    `Session: ${result.sessionFile}`,
                  display: true,
                  details: {
                    name: result.name,
                    qid: q.qid,
                    question: q.question,
                    ...(q.options?.length ? { options: q.options } : {}),
                    sessionFile: result.sessionFile,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            if (result.ping) {
              const sessionRef = `\n\nSession: ${params.sessionPath}\nResume: pi --session ${params.sessionPath}`;
              pi.sendMessage(
                {
                  customType: "subagent_ping",
                  content: `Sub-agent "${result.ping.name}" needs help (${formatElapsed(result.elapsed)}):\n\n${result.ping.message}${sessionRef}`,
                  display: true,
                  details: {
                    name: result.ping.name,
                    message: result.ping.message,
                    sessionFile: params.sessionPath,
                  },
                },
                { triggerTurn: true, deliverAs: "steer" },
              );
              return;
            }

            const allEntries = getNewEntries(params.sessionPath, entryCountBefore);
            const summary = findLastAssistantMessage(allEntries) ??
              (result.errorMessage
                ? `Subagent error: ${result.errorMessage}`
                : result.exitCode !== 0
                  ? `Resumed session exited with code ${result.exitCode}`
                  : "Resumed session exited without new output");
            const presentation = resolveResultPresentation(
              { ...result, summary, sessionFile: params.sessionPath },
              name,
            );

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name,
                  task: params.message ?? "resumed session",
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: params.sessionPath,
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.crashMessage ? { crashMessage: result.crashMessage } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            sessionPath: params.sessionPath,
            launchScriptFile,
            status: "started",
          },
        };
      },
    });

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work (bugfixes, iteration)",
    handler: async (args, _ctx) => {
      const task = args.trim() || "";
      const toolCall = task
        ? `Use subagent to fork a session. fork: true, name: "Iterate", task: ${JSON.stringify(task)}`
        : `Use subagent to fork a session. fork: true, name: "Iterate", task: "The user wants to do some hands-on work. Help them with whatever they need."`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const crashMessage = typeof details.crashMessage === "string" ? details.crashMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const status = errorMessage
          ? "failed (provider/agent error)"
          : crashMessage
            ? "failed (crashed)"
            : failed
              ? `failed (exit ${exitCode})`
              : "completed";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(`Sub-agent "${name}" crashed after ${elapsed}.\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });
}
// test
