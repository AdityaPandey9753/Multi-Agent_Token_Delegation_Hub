/**
 * lib/ollama.ts
 * ----------------
 * Ollama client wrapper using the OpenAI-compatible SDK.
 *
 * Ollama exposes an OpenAI-compatible API at /v1, which means we can use
 * the official `openai` package and just point it at our local Ollama
 * instance. This gives us:
 *   - Tool calling support
 *   - Streaming & non-streaming chat completions
 *   - A standard, well-typed SDK surface
 *
 * The model itself runs 100% locally. The wrapper never reaches out to
 * any external service. All calls to the gateway layer (Gmail, GitHub,
 * Slack, Calendar, etc.) MUST go through tool calls — never direct API
 * access from the model.
 */

import OpenAI from "openai";

/**
 * The base URL for the local Ollama server.
 *
 * Expected to include the `/v1` suffix that Ollama uses for its
 * OpenAI-compatible API (default: http://localhost:11434/v1).
 */
export const OLLAMA_BASE_URL: string =
  process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";

/**
 * The default model name. Ollama model names depend on what the user
 * has pulled locally (e.g. `llama3.1`, `mistral`, `qwen2.5`, etc.).
 * The model MUST support tool calling for Phase 4 to function.
 */
export const OLLAMA_MODEL: string = process.env.OLLAMA_MODEL ?? "llama3.1";

/**
 * The placeholder API key. Ollama does not validate API keys, but the
 * OpenAI SDK requires the field to be present, so we supply a dummy
 * literal. The real authentication boundary lives at the gateway.
 */
const OLLAMA_API_KEY = "ollama";

/**
 * Singleton OpenAI client pointed at local Ollama.
 *
 * Reusing a single client across requests is the recommended pattern
 * (the SDK keeps an HTTP agent and config under the hood).
 */
export const ollama: OpenAI = new OpenAI({
  baseURL: OLLAMA_BASE_URL,
  apiKey: OLLAMA_API_KEY,
});

/**
 * SYSTEM_PROMPT
 * -------------
 * The system prompt enforced for every chat completion. This is the
 * core of the agent's safety story in Phase 4:
 *
 *   - The model NEVER calls external APIs directly.
 *   - The model NEVER touches OAuth tokens.
 *   - The model NEVER impersonates a service.
 *   - All side-effecting actions must go through declared tools.
 *   - Actual execution is performed by the gateway, not the model.
 *   - The model only DECIDES which tool to invoke and with what args.
 *   - The model follows the principle of least privilege.
 */
export const SYSTEM_PROMPT: string = `You are OpenClaw Agent.

Rules:
1. Never call external APIs directly.
2. Never access OAuth tokens.
3. Never impersonate services.
4. If an external action is needed, use tools.
5. Tool execution is performed by the gateway.
6. Only decide which tool should be used.
7. Follow least-privilege principles.

When you need to perform an action that would require contacting an
external service (reading or sending email, interacting with GitHub,
Slack, Calendar, etc.), you MUST use one of the provided tools instead
of attempting to call those services yourself. The gateway layer is
responsible for actually executing the tool, including authentication,
risk classification, and audit logging. Your job is strictly to:
  - Understand the user's request.
  - Choose the most appropriate tool (if any).
  - Produce a well-formed tool call with valid arguments.

If no tool is required, respond with a concise, helpful plain-text
answer. Never reveal, invent, or reference OAuth tokens, secrets, or
internal service credentials.`;
