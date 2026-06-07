/**
 * lib/tools.ts
 * ----------------
 * OpenAI-compatible tool/function schemas that describe the actions the
 * OpenClaw Agent is allowed to request.
 *
 * These schemas are passed to Ollama (via the OpenAI SDK) as `tools`.
 * The model can then emit a `tool_call` whose `function.name` and
 * `function.arguments` we match against a local dispatch table.
 *
 * IMPORTANT: the model itself NEVER executes these tools. It only
 * DECIDES which tool to call and with what arguments. Actual execution
 * is handled by the gateway layer (see `agents/orchestrator.ts`).
 *
 * In Phase 4 we only ship two MVP tools:
 *   - read_email
 *   - send_email
 *
 * Additional tools (GitHub, Slack, Calendar, etc.) will be added in
 * later phases by extending this array and the matching dispatcher.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";

/**
 * Tool 1: read_email
 * ------------------
 * Reads the user's inbox. Takes no parameters for the MVP — the
 * gateway layer decides which mailbox / filters to apply.
 */
const readEmailTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "read_email",
    description:
      "Read the user's email inbox. Use this tool whenever the user " +
      "asks to see, list, summarize, or inspect their emails. " +
      "The gateway executes the read on the user's behalf; the model " +
      "does not access Gmail directly.",
    parameters: {
      type: "object",
      properties: {},
      // No parameters required for the MVP read.
      required: [],
      additionalProperties: false,
    },
  },
};

/**
 * Tool 2: send_email
 * ------------------
 * Sends an email on behalf of the user. All three parameters
 * (to, subject, body) are required so the model must produce a
 * fully-formed payload before the gateway will execute it.
 */
const sendEmailTool: ChatCompletionTool = {
  type: "function",
  function: {
    name: "send_email",
    description:
      "Send an email on behalf of the user. The gateway layer is " +
      "responsible for authentication, risk classification, and " +
      "actually delivering the message. The model only chooses " +
      "when to call this tool and supplies the recipient, subject, " +
      "and body.",
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            "The recipient's email address (e.g. 'user@example.com').",
        },
        subject: {
          type: "string",
          description: "The subject line of the email.",
        },
        body: {
          type: "string",
          description: "The plain-text body of the email message.",
        },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
  },
};

/**
 * The full set of tools the agent is allowed to invoke.
 *
 * This is exported so the orchestrator can pass it directly to
 * `client.chat.completions.create({ tools: gatewayTools, ... })`.
 */
export const gatewayTools: ChatCompletionTool[] = [
  readEmailTool,
  sendEmailTool,
];

/**
 * Convenience: a set of supported tool names for quick membership
 * checks in the dispatcher. Exported in case other modules want to
 * verify that a name refers to a real tool before calling it.
 */
export const supportedToolNames: ReadonlySet<string> = new Set(
  gatewayTools.map((t) => t.function.name),
);
