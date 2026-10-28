/**
 * Extension loaded into sub-agents.
 * - Shows available tools as a styled widget above the editor (toggle with Ctrl+Shift+J)
 * - Provides a `subagent_done` tool — the single way a subagent signals
 *   completion; otherwise only a human closing the pane ends the session
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import {
  readQuestion,
  waitForReply,
  writeParentReply,
  writeQuestion,
  type QuestionOption,
} from "./question-channel.ts";
import { randomUUID } from "node:crypto";

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user.
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Shift+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Shift+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    recorder.agentStart();
  });

  pi.on("agent_end", (event) => {
    const messages = (event as any).messages as any[] | undefined;

    // Surface stopReason: "error" turns (auto-retry exhausted, provider
    // overload, etc.) to the parent via the .exit sidecar so the watcher
    // can report a clear failure with the underlying error message.
    // The session stays open — the pane is interactive; completion happens
    // via the subagent_done tool or the user closing the pane.
    const errorInfo = findLatestAssistantError(messages);
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (errorInfo && sessionFile) {
      try {
        writeFileSync(
          `${sessionFile}.exit`,
          JSON.stringify({
            type: "error",
            errorMessage: errorInfo.errorMessage,
            stopReason: errorInfo.stopReason,
          }),
        );
      } catch {
        // Best effort — even without the sidecar, watcher's session-file
        // fallback can still recover the errorMessage.
      }
    }

    recorder.agentEndWaiting();
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+Shift+J (ctrl+j is the built-in
  // tui.input.newLine — binding it here raises a shortcut-conflict warning)
  pi.registerShortcut("ctrl+shift+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      writeFileSync(`${sessionFile}.exit`, JSON.stringify(exitData));

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It is the only way to finish a subagent session (otherwise only closing the pane ends it). " +
      "It closes this session and returns your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      if (sessionFile) {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "done" }));
      }
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "ask_parent",
    label: "Ask Parent",
    description:
      "Ask a question to the parent agent that spawned you. Your turn is BLOCKED until the parent " +
      "answers (up to 10 minutes). Use for ambiguous requirements, significant decisions with " +
      "irreversible consequences, or blockers you cannot resolve yourself — not for routine choices. " +
      "Offer options with your recommendation first when useful. On timeout, proceed carefully and " +
      "record your assumption in the final report.",
    parameters: Type.Object({
      question: Type.String({ description: "The single question to ask the parent agent." }),
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
          { description: "Optional options to offer the parent. Recommended option first, labeled '(Recommended)'." },
        ),
      ),
      multiSelect: Type.Optional(
        Type.Boolean({ description: "Set true when several options may be correct at once." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_parent is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      // No activity recorder call here: caller_ping() would mark the activity
      // file phase "done", and the parent's activity fast-path would stop
      // polling while this tool is still blocked waiting for the answer.

      const qid = randomUUID();
      writeQuestion(sessionFile, {
        qid,
        from: "worker",
        question: params.question,
        ...(params.details ? { details: params.details } : {}),
        ...(params.options?.length ? { options: params.options as QuestionOption[] } : {}),
        ...(typeof params.multiSelect === "boolean" ? { multiSelect: params.multiSelect } : {}),
        ts: Date.now(),
      });

      const reply = await waitForReply(sessionFile, "answer", qid, { signal });
      if (reply.ok) {
        return {
          content: [{ type: "text", text: `Parent answered: ${reply.answer}` }],
          details: { qid, answer: reply.answer },
        };
      }
      const reason =
        reply.reason === "aborted"
          ? "you were interrupted"
          : "the parent did not answer in time";
      return {
        content: [
          {
            type: "text",
            text:
              `No answer from the parent (${reason}). ` +
              `Proceed carefully with your best judgment and record the assumption you made in your final report.`,
          },
        ],
        details: { qid, error: reply.reason },
      };
    },
  });

  pi.registerTool({
    name: "reply_to_parent",
    label: "Reply to Parent",
    description:
      "Answer a question the parent agent asked you (delivered as an injected " +
      "'❓ Question from parent' message). Pass the answer text; the parent's ask_subagent " +
      "call returns with it.",
    parameters: Type.Object({
      answer: Type.String({ description: "Your answer to the parent's question." }),
      qid: Type.Optional(
        Type.String({ description: "Question id if known (otherwise the pending question is used)." }),
      ),
    }),
    async execute(_toolCallId, params) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "reply_to_parent is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      const pending = params.qid ? null : readQuestion(sessionFile);
      const qid = params.qid ?? pending?.qid;
      if (!qid) {
        return {
          content: [
            { type: "text", text: "No pending parent question found. Nothing to reply to." },
          ],
          details: { error: "no pending question" },
        };
      }

      writeParentReply(sessionFile, { qid, answer: params.answer, ts: Date.now() });
      return {
        content: [{ type: "text", text: "Reply delivered to the parent." }],
        details: { qid },
      };
    },
  });
}
