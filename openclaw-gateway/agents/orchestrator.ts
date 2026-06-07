/**
 * agents/orchestrator.ts
 * ------------------------
 * The main AI orchestrator for OpenClaw Gateway (Phase 4).
 *
 * `runAgent(userMessage)` is the single entry point used by the
 * `/api/gateway/chat` route. It:
 *
 *   1. Builds a chat request that includes the system prompt, the
 *      user message, and the gateway tool schemas.
 *   2. Sends the request to the LOCAL Ollama server via the OpenAI
 *      SDK.
 *   3. Inspects the model's response. If the model emitted a tool
 *      call, dispatches it to the matching mock implementation.
 *   4. Returns a structured result containing the tool name, the
 *      arguments, the tool's output, and the raw model response.
 *
 * The orchestrator NEVER calls external APIs (no Gmail, no Google,
 * no Auth0, no token reads). It only talks to local Ollama and to
 * the in-process mock tool implementations.
 */

import OpenAI from "openai";
import type {
  ChatCompletion,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";

import { ollama, OLLAMA_MODEL, SYSTEM_PROMPT } from "../lib/ollama";
import { gatewayTools } from "../lib/tools";
import { readEmail, sendEmail } from "./tools/gmail";

/**
 * The typed shape of a successful agent run.
 *
 * `kind` discriminates between a plain conversational reply and a
 * tool-driven reply so callers (e.g. the API route) can render
 * either form correctly.
 */
export type AgentRunResult =
  | {
      kind: "text";
      text: string;
      raw: ChatCompletion;
    }
  | {
      kind: "tool";
      toolName: string;
      arguments: unknown;
      result: unknown;
      raw: ChatCompletion;
    };

/**
 * Safe JSON parser.
 *
 * The OpenAI tool-call contract is that `function.arguments` is a
 * JSON-encoded string. The model may occasionally produce malformed
 * JSON, so we catch and surface a clear error rather than throwing
 * an opaque `SyntaxError` from deep inside the SDK.
 */
function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse tool arguments as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Extract the first tool call from a model response, if any.
 *
 * The OpenAI SDK returns tool calls as an array on the assistant
 * message. For the MVP we only honor the first call; multi-tool
 * orchestration will be added in a later phase.
 */
function extractFirstToolCall(
  completion: ChatCompletion,
): ChatCompletionMessageToolCall | undefined {
  const message = completion.choices?.[0]?.message;
  if (!message) return undefined;

  // The SDK exposes tool_calls as an optional array.
  const toolCalls = (message as { tool_calls?: ChatCompletionMessageToolCall[] })
    .tool_calls;
  if (!toolCalls || toolCalls.length === 0) return undefined;

  return toolCalls[0];
}

/**
 * Dispatch a tool call to the matching mock implementation.
 *
 * We match on `function.name` and pass `function.arguments` (parsed
 * from JSON) into the handler. Unknown tool names produce a clear
 * error — the model should never request a tool that isn't in
 * `gatewayTools`.
 */
async function dispatchToolCall(
  call: ChatCompletionMessageToolCall,
): Promise<unknown> {
  if (call.type !== "function") {
    throw new Error(`Unsupported tool call type: ${call.type}`);
  }

  const name = call.function.name;
  const parsedArgs = safeParseJson(call.function.arguments || "{}");

  switch (name) {
    case "read_email":
      return readEmail();

    case "send_email":
      return sendEmail(parsedArgs);

    default:
      throw new Error(`Unknown tool requested by model: ${name}`);
  }
}

/**
 * runAgent(userMessage)
 * ---------------------
 * The top-level entry point.
 *
 * @param userMessage - The user's natural-language request.
 * @returns A discriminated union describing either a plain-text
 *          reply or a tool-driven reply.
 * @throws  If the request to Ollama fails, the model returns no
 *          choices, or the dispatched tool throws.
 */
export async function runAgent(
  userMessage: string,
): Promise<AgentRunResult> {
  if (!userMessage || typeof userMessage !== "string") {
    throw new Error("runAgent: userMessage must be a non-empty string");
  }

  // 1. Build the chat request: system prompt + user message + tools.
  const completion: ChatCompletion = await ollama.chat.completions.create({
    model: OLLAMA_MODEL,
    temperature: 0,
    // We don't want the model to invent partial arguments.
    tools: gatewayTools,
    // Let the model decide whether to call a tool or just chat.
    tool_choice: "auto",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
  });

  // 2. Inspect the response.
  const toolCall = extractFirstToolCall(completion);

  // 3a. No tool call -> return plain text.
  if (!toolCall) {
    const text = completion.choices?.[0]?.message?.content ?? "";
    return {
      kind: "text",
      text,
      raw: completion,
    };
  }

  // 3b. Tool call -> execute the matching mock tool.
  const result = await dispatchToolCall(toolCall);

  // Parse arguments a second time purely so the caller can see
  // exactly what the model asked for, in structured form.
  const parsedArgs = safeParseJson(toolCall.function.arguments || "{}");

  return {
    kind: "tool",
    toolName: toolCall.function.name,
    arguments: parsedArgs,
    result,
    raw: completion,
  };
}

// Re-export the configured model name so the route handler can echo
// it back in API responses (useful for debugging which local model
// actually served the request).
export { OLLAMA_MODEL };

// Suppress an unused-symbol warning in environments where the
// import of `OpenAI` is only for side-effect type augmentation.
export type { OpenAI };
