/**
 * Native herdr agent API integration (PI_SUBAGENT_HERDR_NATIVE=1).
 *
 * Uses herdr's server-side primitives where they are strictly better than
 * screen-scraping, and falls back to the raw pane path on any error:
 *
 * - completion detection: `pane wait-output --regex` (server-side search+poll)
 * - interrupt:            `agent send-keys <pane> esc` (validated key)
 * - naming/visibility:    `agent rename` + `pane report-metadata` (display only)
 * - session identity:     `pane report-agent-session` (pane restore identity)
 * - status display:       `agent list` -> agent_status (display only)
 *
 * Design rules (see .pi/plans/2026-09-02-herdr-integration/plan-native-agent-api.md):
 * - Enabled by default on the herdr backend (B4). Opt out with
 *   PI_SUBAGENT_HERDR_NATIVE=0; PI_SUBAGENT_HERDR_NATIVE=1 is a no-op alias
 *   for "on".
 * - Disabled: zero calls into this module's CLI path.
 * - Enabled: any CLI error, timeout, or parse failure must degrade to the raw
 *   path with at most one warning. The feature must never kill, block, or
 *   misreport a subagent.
 * - Display-only metadata is best-effort; waits and results never depend on it.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getMuxBackend } from "./cmux.ts";

/** Herdr binary: prefer the env var herdr injects into its panes, else PATH. */
function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

const SENTINEL_REGEX = "__SUBAGENT_DONE_([0-9]+)__";

type CliRunner = (
  args: string[],
  opts: { timeoutMs: number },
) => { ok: boolean; stdout: string; stderr: string };

const defaultRunner: CliRunner = (args, opts) => {
  try {
    const result = spawnSync(herdrBin(), args, {
      encoding: "utf8",
      timeout: opts.timeoutMs + 5000, // let the CLI's own --timeout fire first
    });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? (result.error ? String(result.error) : ""),
    };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String(error) };
  }
};

let runnerOverride: CliRunner | null = null;
let backendResolverOverride: (() => string | null) | null = null;
const warnings = new Set<string>();

function warn(key: string, message: string): void {
  if (warnings.has(key)) return;
  warnings.add(key);
  console.warn(`[subagents] herdr native: ${message}`);
}

/**
 * Enabled by default on the herdr backend. Opt out with
 * PI_SUBAGENT_HERDR_NATIVE=0. (Explicit "1" is accepted for compatibility.)
 */
export function herdrNativeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.PI_SUBAGENT_HERDR_NATIVE ?? "").trim() === "0") return false;
  return resolveBackend() === "herdr";
}

function resolveBackend(): string | null {
  return backendResolverOverride ? backendResolverOverride() : getMuxBackend();
}

/**
 * Sanitize a display name into herdr's agent-name charset: [a-z][a-z0-9_-]{0,31}.
 * Deterministic: tests rely on the exact mapping.
 */
export function sanitizeAgentName(name: string): string {
  let out = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (out === "") out = "subagent";
  if (!/^[a-z]/.test(out)) out = `s-${out}`;
  return out.slice(0, 32);
}

function parseEnvelope(stdout: string): any {
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Server-side wait for the shell sentinel line (async — does not block the
 * event loop, unlike the short-lived sync CLI calls below).
 *
 * `pane wait-output` searches the current terminal snapshot immediately and
 * then polls server-side, so this replaces the JS readScreenAsync loop.
 * Returns the shell exit code when the sentinel is observed; null on timeout
 * (caller loops); throws on hard errors (caller falls back to raw path).
 */
export async function nativeWaitSentinel(
  pane: string,
  timeoutMs: number,
): Promise<{ exitCode: number } | null> {
  const { ok, stdout, stderr } = await runCliAsync([
    "pane", "wait-output", pane,
    "--regex", SENTINEL_REGEX,
    "--source", "recent",
    "--timeout", String(timeoutMs),
  ], timeoutMs);

  if (!ok) {
    const message = extractErrorMessage(stderr, "pane wait-output");
    // Timeout is the expected "not yet" outcome — not a hard error.
    if (/timed out|timeout/i.test(message)) return null;
    throw new Error(message);
  }

  const envelope = parseEnvelope(stdout);
  if (!envelope) {
    throw new Error(`unparseable CLI output: ${stdout.slice(0, 200)}`);
  }
  const matched = envelope.result?.matched_line;
  if (typeof matched === "string") {
    const m = matched.match(new RegExp(SENTINEL_REGEX));
    if (m) return { exitCode: parseInt(m[1], 10) };
  }
  // Envelope parsed but no usable line — treat as "not yet".
  return null;
}

/** Map of pane_id -> agent_status for all recognized agents (one CLI call). */
export function nativeAgentStatusMap(): Map<string, string> {
  const map = new Map<string, string>();
  const r = runCli(["agent", "list"], 5000);
  if (r.error) {
    warn("agent-list", `agent list failed: ${r.error}`);
    return map;
  }
  const agents = Array.isArray(r.result?.agents) ? r.result.agents : [];
  for (const agent of agents) {
    if (typeof agent?.pane_id === "string" && typeof agent?.agent_status === "string") {
      map.set(agent.pane_id, agent.agent_status);
    }
  }
  return map;
}

/** Best-effort display label for herdr's agent UI. Returns true on success. */
export function nativeAgentRename(pane: string, name: string): boolean {
  const r = runCli(["agent", "rename", pane, name], 5000);
  if (r.error) {
    warn(`rename:${pane}`, `agent rename failed: ${r.error}`);
    return false;
  }
  return true;
}

/** Best-effort presentation-only metadata (title, visible name, state labels). */
export function nativeReportMetadata(
  pane: string,
  source: string,
  opts: { displayAgent?: string; title?: string },
): boolean {
  const args = ["pane", "report-metadata", pane, "--source", source];
  if (opts.displayAgent) args.push("--display-agent", opts.displayAgent);
  if (opts.title) args.push("--title", opts.title);
  const r = runCli(args, 5000);
  if (r.error) {
    warn(`metadata:${pane}`, `report-metadata failed: ${r.error}`);
    return false;
  }
  return true;
}

/**
 * Bind the pi session file as the pane's agent session identity so herdr can
 * show it in the agent UI and restore the pane after a herdr restart.
 */
export function nativeReportAgentSession(
  pane: string,
  source: string,
  agent: string,
  sessionPath: string,
): boolean {
  const args = [
    "pane", "report-agent-session", pane,
    "--source", source,
    "--agent", agent,
    "--agent-session-path", sessionPath,
  ];
  const r = runCli(args, 5000);
  if (r.error) {
    warn(`session:${pane}`, `report-agent-session failed: ${r.error}`);
    return false;
  }
  return true;
}

/**
 * Send Escape via herdr's validated agent key path. Returns true when herdr
 * accepted it; false on any failure (caller falls back to raw sendEscape).
 */
export function nativeSendEscape(pane: string): boolean {
  const r = runCli(["agent", "send-keys", pane, "esc"], 5000);
  if (r.error) {
    // Do not spam: fall back silently per call, but surface once for debugging.
    warn(`send-esc:${pane}`, `agent send-keys esc failed: ${r.error}`);
    return false;
  }
  return true;
}

/**
 * Fire-and-forget: apply herdr display identity (rename + metadata + session
 * binding) once the pane's agent is detected. Detection takes a few seconds
 * after launch, so retry briefly; give up silently — display only.
 */
export async function applyHerdrAgentIdentity(
  pane: string,
  opts: { displayName?: string; taskId: string; task?: string; sessionFile?: string },
  attempts: number = 8,
  delayMs: number = 2000,
): Promise<void> {
  const agentName = sanitizeAgentName(opts.displayName || opts.taskId);
  const source = `subagents:${opts.taskId}`;
  const title = opts.task ? opts.task.slice(0, 60) : opts.taskId;

  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    if (!nativeAgentRename(pane, agentName)) continue;
    nativeReportMetadata(pane, source, {
      displayAgent: opts.displayName || agentName,
      title,
    });
    if (opts.sessionFile && existsSync(opts.sessionFile)) {
      nativeReportAgentSession(pane, source, agentName, opts.sessionFile);
    }
    return;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCli(args: string[], timeoutMs: number):
  | { result: any; error?: undefined }
  | { result?: undefined; error: string } {
  const runner = runnerOverride ?? defaultRunner;
  const r = runner(args, { timeoutMs });
  if (r.ok) {
    const envelope = parseEnvelope(r.stdout);
    if (!envelope) {
      return { error: `unparseable CLI output: ${r.stdout.slice(0, 200)}` };
    }
    return { result: envelope.result ?? {} };
  }
  // CLI server errors are JSON on stderr.
  return { error: extractErrorMessage(r.stderr, `exit ${args[0]} ${args[1] ?? ""}`) };
}

async function runCliAsync(
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const runner = asyncRunnerOverride ?? spawnCli;
  return runner(args, timeoutMs);
}

function spawnCli(
  args: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(herdrBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, timeoutMs + 5000); // let the CLI's own --timeout fire first
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: String(error) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

function extractErrorMessage(stderr: string, fallback: string): string {
  const parsed = parseEnvelope(stderr);
  return String(
    (parsed && (parsed.error?.message ?? parsed.message)) ||
    (stderr.trim().split("\n").pop() ?? fallback),
  );
}

let asyncRunnerOverride: ((args: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>) | null = null;

export const __herdrNativeTest__ = {
  /** Inject a fake CLI runner for sync calls (tests). Pass null to restore. */
  setRunner(runner: CliRunner | null): void {
    runnerOverride = runner;
  },
  /** Inject a fake CLI runner for the async wait call (tests). */
  setAsyncRunner(
    runner: ((args: string[], timeoutMs: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>) | null,
  ): void {
    asyncRunnerOverride = runner;
  },
  /** Override backend detection (tests). Pass null to restore. */
  setBackendResolver(resolver: (() => string | null) | null): void {
    backendResolverOverride = resolver;
  },
  resetWarnings(): void {
    warnings.clear();
  },
  sentinelRegex: SENTINEL_REGEX,
  join,
};
