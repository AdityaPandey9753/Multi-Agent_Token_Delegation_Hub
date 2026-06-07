/**
 * app/api/gateway/chat/route.ts
 * -------------------------------
 * POST endpoint for the OpenClaw Gateway chat surface (Phase 4).
 *
 * Request body:
 *   { "message": "Read my emails" }
 *
 * Response body (success):
 *   {
 *     ok: true,
 *     kind: "text" | "tool",
 *     text?: string,           // present when kind === "text"
 *     toolName?: string,       // present when kind === "tool"
 *     arguments?: unknown,     // present when kind === "tool"
 *     result?: unknown,        // present when kind === "tool"
 *     model: string,           // the local Ollama model used
 *   }
 *
 * Response body (error):
 *   { ok: false, error: string, details?: string }
 *
 * Status codes:
 *   200 - successful run
 *   400 - invalid request body (missing/invalid `message`)
 *   500 - internal server error (Ollama unreachable, tool threw, etc.)
 *
 * NOTE: In a later phase this route will be wrapped in an
 * authentication middleware (Auth0) and the user identity will be
 * threaded through to the orchestrator so per-user audit logs and
 * risk classification can be applied. For Phase 4 the route is
 * intentionally anonymous — we are validating the model/tool flow,
 * not the auth flow.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  OLLAMA_MODEL,
  runAgent,
} from "../../../../agents/orchestrator";

// Use the Node.js runtime so we get a full OpenAI SDK with streaming
// support and proper keep-alive. Edge runtime is unnecessary here
// and would force a lighter client.
export const runtime = "nodejs";
// This route is dynamic: it talks to a local model whose state can
// change between requests, so we don't want it statically cached.
export const dynamic = "force-dynamic";

/**
 * Zod schema for the incoming POST body.
 *
 * Keeping validation at the edge (rather than in the orchestrator)
 * means we can return a clean 400 with field-level details before
 * any LLM work is done.
 */
const ChatRequestSchema = z.object({
  message: z
    .string({ required_error: "message is required" })
    .min(1, "message must be a non-empty string")
    .max(8_000, "message must be at most 8000 characters"),
});

/**
 * POST /api/gateway/chat
 *
 * Main request handler. See the file-level comment for the
 * documented request/response shapes.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Parse + validate the JSON body.
  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: "Invalid JSON body",
        details: "Request body must be valid JSON.",
      },
      { status: 400 },
    );
  }

  const parsed = ChatRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: "Invalid request",
        details: parsed.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  const { message } = parsed.data;

  // 2. Run the agent. Any thrown error is treated as a 500.
  try {
    const result = await runAgent(message);

    if (result.kind === "text") {
      return NextResponse.json(
        {
          ok: true,
          kind: "text",
          text: result.text,
          model: OLLAMA_MODEL,
        },
        { status: 200 },
      );
    }

    // result.kind === "tool"
    return NextResponse.json(
      {
        ok: true,
        kind: "tool",
        toolName: result.toolName,
        arguments: result.arguments,
        result: result.result,
        model: OLLAMA_MODEL,
      },
      { status: 200 },
    );
  } catch (err) {
    // Avoid leaking internal stack traces to the client, but make
    // sure operators can see the cause in the server logs.
    // eslint-disable-next-line no-console
    console.error("[/api/gateway/chat] runAgent failed:", err);

    const message_ =
      err instanceof Error ? err.message : "Unknown error from runAgent";

    return NextResponse.json(
      {
        ok: false,
        error: "Internal server error",
        details: message_,
      },
      { status: 500 },
    );
  }
}

/**
 * GET /api/gateway/chat
 *
 * Lightweight health/info endpoint so developers can quickly check
 * which local model the route is configured to use. It does NOT
 * contact Ollama — that keeps the route useful even when the local
 * model server is down.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: true,
      endpoint: "/api/gateway/chat",
      method: "POST",
      model: OLLAMA_MODEL,
      description:
        "Send a JSON body of { message: string } to invoke the local " +
        "OpenClaw Agent (Ollama). The agent will decide whether to " +
        "respond with text or to call a gateway tool.",
    },
    { status: 200 },
  );
}
