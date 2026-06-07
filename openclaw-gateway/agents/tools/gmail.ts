/**
 * agents/tools/gmail.ts
 * ----------------------
 * Mocked Gmail tool implementations used by the agent orchestrator
 * during Phase 4 development.
 *
 * In Phase 4 these functions DO NOT call any Google API. They DO NOT
 * touch Auth0, OAuth tokens, or any external credential store. They
 * simply return hard-coded / fabricated data so we can validate the
 * end-to-end flow:
 *
 *   user -> /api/gateway/chat -> runAgent -> Ollama -> tool call ->
 *   mocked tool -> response
 *
 * In later phases the gateway layer will replace these mocks with
 * real, audited, risk-classified calls that use tokens held in
 * `lib/tokenVault.ts`.
 */

import { z } from "zod";

/**
 * Zod schema describing a single mocked email.
 *
 * Kept intentionally minimal for the MVP — we only need a `from` and
 * a `subject` to demonstrate that the tool returned something useful.
 */
export const EmailSchema = z.object({
  from: z.string().describe("The sender's email address."),
  subject: z.string().describe("The subject line of the email."),
});
export type Email = z.infer<typeof EmailSchema>;

/**
 * Response shape for `readEmail`.
 */
export const ReadEmailResponseSchema = z.object({
  emails: z.array(EmailSchema),
});
export type ReadEmailResponse = z.infer<typeof ReadEmailResponseSchema>;

/**
 * Zod schema for the arguments of `sendEmail`.
 *
 * Mirrors the OpenAI tool schema declared in `lib/tools.ts` so we can
 * validate the model's output before "executing" the action.
 */
export const SendEmailArgsSchema = z.object({
  to: z.string().email().describe("Recipient email address."),
  subject: z.string().min(1).describe("Email subject line."),
  body: z.string().min(1).describe("Email body content."),
});
export type SendEmailArgs = z.infer<typeof SendEmailArgsSchema>;

/**
 * Response shape for `sendEmail`.
 */
export const SendEmailResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  payload: SendEmailArgsSchema,
});
export type SendEmailResponse = z.infer<typeof SendEmailResponseSchema>;

/**
 * readEmail()
 * -----------
 * MOCKED. Returns a hard-coded list of emails to simulate reading
 * the user's inbox.
 *
 * No HTTP calls, no Google API access, no token reads.
 */
export async function readEmail(): Promise<ReadEmailResponse> {
  const mock: ReadEmailResponse = {
    emails: [
      {
        from: "demo@gmail.com",
        subject: "Welcome to OpenClaw",
      },
    ],
  };
  return mock;
}

/**
 * sendEmail(args)
 * ---------------
 * MOCKED. Pretends to queue an email for delivery and echoes back
 * the payload it received.
 *
 * The real implementation will (in later phases):
 *   1. Look up the user's stored OAuth token from `tokenVault`.
 *   2. Classify the request via `riskClassifier`.
 *   3. Trigger CIBA / consent flow for sensitive writes.
 *   4. Call the Gmail API.
 *   5. Write an audit log entry.
 *
 * For the MVP we only validate arguments and return a fake success.
 */
export async function sendEmail(
  rawArgs: unknown,
): Promise<SendEmailResponse> {
  // Validate + coerce arguments before "executing" anything.
  const args: SendEmailArgs = SendEmailArgsSchema.parse(rawArgs);

  // MOCK: in real life this would hit Gmail's API. Here we just
  // acknowledge the request and return the payload unchanged.
  const response: SendEmailResponse = {
    success: true,
    message: "Email queued",
    payload: args,
  };
  return response;
}
