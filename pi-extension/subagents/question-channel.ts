/**
 * Live question channel between a parent session and its sub-agents.
 *
 * File-based RPC over sidecar files next to the sub-agent session file:
 *
 *   <session>.question     child ask_parent / parent ask_subagent → the other side
 *   <session>.answer       parent answer_subagent → child ask_parent poller
 *   <session>.parent-reply child reply_to_parent → parent ask_subagent poller
 *
 * Every payload carries a qid (uuid); pollers only accept the matching qid,
 * so stale files from previous rounds can never answer a live wait.
 */
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface QuestionOption {
  label: string;
  value?: string;
  description?: string;
}

export interface QuestionPayload {
  qid: string;
  from: "worker" | "parent";
  question: string;
  details?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
  ts: number;
}

export interface AnswerPayload {
  qid: string;
  answer: string;
  ts: number;
}

export type WaitForReplyResult =
  | { ok: true; answer: string }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "aborted" };

export const QUESTION_POLL_MS = 500;

export function questionTimeoutMs(): number {
  const raw = process.env.PI_SUBAGENT_QUESTION_TIMEOUT_MS?.trim();
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 10 * 60 * 1000;
}

// ── Sidecar paths ──────────────────────────────────────────────────────────

export const questionFile = (sessionFile: string): string => `${sessionFile}.question`;
export const answerFile = (sessionFile: string): string => `${sessionFile}.answer`;
export const parentReplyFile = (sessionFile: string): string => `${sessionFile}.parent-reply`;

export function questionSidecarFiles(sessionFile: string): string[] {
  return [questionFile(sessionFile), answerFile(sessionFile), parentReplyFile(sessionFile)];
}

// ── Atomic JSON sidecar I/O ────────────────────────────────────────────────

function writeJsonAtomic(path: string, payload: unknown): void {
  const tmp = `${path}.tmp-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
  renameSync(tmp, path);
}

export function readQuestion(sessionFile: string): QuestionPayload | null {
  try {
    const data = JSON.parse(readFileSync(questionFile(sessionFile), "utf8"));
    if (data && typeof data.qid === "string" && typeof data.question === "string") {
      return data as QuestionPayload;
    }
    return null;
  } catch {
    return null;
  }
}

export function readAnswer(sessionFile: string): AnswerPayload | null {
  try {
    const data = JSON.parse(readFileSync(answerFile(sessionFile), "utf8"));
    if (data && typeof data.qid === "string" && typeof data.answer === "string") {
      return data as AnswerPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function readReply(sessionFile: string): AnswerPayload | null {
  return readAnswerOf(parentReplyFile(sessionFile));
}

function readAnswerOf(path: string): AnswerPayload | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data && typeof data.qid === "string" && typeof data.answer === "string") {
      return data as AnswerPayload;
    }
    return null;
  } catch {
    return null;
  }
}

export function writeQuestion(sessionFile: string, payload: QuestionPayload): void {
  writeJsonAtomic(questionFile(sessionFile), payload);
}

export function writeAnswer(sessionFile: string, payload: AnswerPayload): void {
  writeJsonAtomic(answerFile(sessionFile), payload);
}

export function writeParentReply(sessionFile: string, payload: AnswerPayload): void {
  writeJsonAtomic(parentReplyFile(sessionFile), payload);
}

/** Remove all question sidecars (stale cleanup on spawn / after delivery). */
export function clearQuestionSidecars(sessionFile: string): void {
  for (const file of questionSidecarFiles(sessionFile)) {
    try {
      unlinkSync(file);
    } catch {
      // Missing is fine.
    }
  }
}

// ── Polling wait ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll an answer sidecar until the matching qid appears, the timeout fires,
 * or the signal aborts. Only the matching qid is accepted.
 */
export async function waitForReply(
  sessionFile: string,
  kind: "answer" | "parent-reply",
  qid: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<WaitForReplyResult> {
  const timeoutMs = opts.timeoutMs ?? questionTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  const reader = kind === "answer" ? readAnswer : readReply;

  for (;;) {
    if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
    const reply = reader(sessionFile);
    if (reply && reply.qid === qid) return { ok: true, answer: reply.answer };
    if (Date.now() >= deadline) return { ok: false, reason: "timeout" };
    await sleep(QUESTION_POLL_MS);
  }
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function formatQuestionForDisplay(q: QuestionPayload): string {
  const lines: string[] = [];
  if (q.details) lines.push(q.details, "");
  if (q.options && q.options.length > 0) {
    lines.push(
      ...(q.multiSelect ? ["(multi-select)"] : []),
      ...q.options.map((o, i) =>
        o.description ? `${i + 1}. ${o.label} — ${o.description}` : `${i + 1}. ${o.label}`,
      ),
    );
  }
  lines.push(q.question);
  return lines.join("\n").trim();
}
