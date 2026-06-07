/**
 * client/src/App.tsx
 * -------------------
 * OpenClaw Gateway Dashboard - main React UI.
 *
 * The UI never talks to the OpenClaw Gateway directly; it goes
 * through the Flask server, which is the only component that has
 * access to the encrypted token vault and the audit log.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const API_BASE: string = (import.meta.env.VITE_API_BASE as string) || "";
const DEMO_USER_ID = "00000000-0000-0000-0000-000000000001";

type Role = "user" | "agent" | "tool" | "system";

interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  toolName?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  model?: string;
  pending?: boolean;
}

interface AuditEntry {
  id: string;
  action: string;
  tool_name?: string | null;
  result_status: string;
  message?: string | null;
  created_at: string;
}

interface HealthInfo {
  backend: { ok: boolean; detail?: string };
  gateway: { ok: boolean; detail?: string; model?: string };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON response from ${path}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const errMsg =
      (body as { error?: string })?.error || `HTTP ${res.status} from ${path}`;
    throw new Error(errMsg);
  }
  return body as T;
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function summariseTool(name: string | undefined, result: unknown): string {
  if (!name) return "(no tool)";
  if (name === "read_email" && result && typeof result === "object") {
    const r = result as { emails?: { from: string; subject: string }[] };
    if (r.emails && r.emails.length > 0) {
      const lines = r.emails.map((e) => `  - ${e.subject}  (from ${e.from})`);
      return `I found ${r.emails.length} email${r.emails.length === 1 ? "" : "s"}:\n${lines.join("\n")}`;
    }
    return "Your inbox is empty.";
  }
  if (name === "send_email" && result && typeof result === "object") {
    const r = result as { success?: boolean; message?: string };
    return r.success ? `Email queued. ${r.message ?? ""}`.trim() : "Send failed.";
  }
  return `Tool ${name} executed.`;
}

function App(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: uid(),
      role: "system",
      text:
        "OpenClaw Gateway is running locally through Ollama. Try: " +
        '"Read my emails" or "Send an email to alex@example.com subject=Hi body=Hello".',
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [health, setHealth] = useState<HealthInfo>({
    backend: { ok: false },
    gateway: { ok: false },
  });
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  const refreshHealth = useCallback(async () => {
    const next: HealthInfo = {
      backend: { ok: false },
      gateway: { ok: false },
    };
    try {
      await api<{ ok: boolean; service: string }>("/api/health");
      next.backend = { ok: true };
    } catch (err) {
      next.backend = { ok: false, detail: (err as Error).message };
    }
    try {
      const r = await api<{ ok: boolean; gateway?: { model?: string } }>(
        "/api/agent/chat",
        { method: "POST", body: JSON.stringify({ message: "ping" }) },
      );
      next.gateway = {
        ok: !!r.ok,
        detail: r.ok ? undefined : "non-ok response",
        model: r.gateway?.model,
      };
    } catch (err) {
      next.gateway = { ok: false, detail: (err as Error).message };
    }
    setHealth(next);
  }, []);

  const refreshAudit = useCallback(async () => {
    try {
      const r = await api<{ ok: boolean; entries: AuditEntry[] }>(
        `/api/audit?limit=20&user_id=${DEMO_USER_ID}`,
      );
      setAudit(r.entries);
    } catch {
      // Non-fatal
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    refreshAudit();
    const id = setInterval(() => {
      refreshHealth();
      refreshAudit();
    }, 5000);
    return () => clearInterval(id);
  }, [refreshHealth, refreshAudit]);

  useEffect(() => {
    chatScrollRef.current?.scrollTo({
      top: chatScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    const userMsg: ChatMessage = { id: uid(), role: "user", text };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setBusy(true);
    const pendingId = uid();
    setMessages((m) => [
      ...m,
      { id: pendingId, role: "agent", text: "Thinking...", pending: true },
    ]);

    try {
      const resp = await api<{
        ok: boolean;
        gateway: {
          ok: boolean;
          kind: "text" | "tool";
          text?: string;
          toolName?: string;
          arguments?: unknown;
          result?: unknown;
          model?: string;
        };
      }>("/api/agent/chat", {
        method: "POST",
        body: JSON.stringify({ message: text, user_id: DEMO_USER_ID }),
      });
      const g = resp.gateway;
      setMessages((m) => m.filter((x) => x.id !== pendingId));
      if (g.kind === "tool") {
        setMessages((m) => [
          ...m,
          {
            id: uid(),
            role: "tool",
            text: `tool: ${g.toolName}`,
            toolName: g.toolName,
            toolArgs: g.arguments,
            toolResult: g.result,
            model: g.model,
          },
          {
            id: uid(),
            role: "agent",
            text: summariseTool(g.toolName, g.result),
            model: g.model,
          },
        ]);
      } else {
        setMessages((m) => [
          ...m,
          { id: uid(), role: "agent", text: g.text || "(empty response)", model: g.model },
        ]);
      }
    } catch (err) {
      setMessages((m) =>
        m
          .filter((x) => x.id !== pendingId)
          .concat({ id: uid(), role: "system", text: `error: ${(err as Error).message}` }),
      );
    } finally {
      setBusy(false);
      refreshAudit();
    }
  }, [input, busy, refreshAudit]);

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const headerStatus = useMemo(() => {
    if (!health.backend.ok) return { label: "Backend offline", color: "bg-red-500" };
    if (!health.gateway.ok) return { label: "Gateway offline", color: "bg-amber-500" };
    return {
      label: `Online - model ${health.gateway.model ?? "?"}`,
      color: "bg-emerald-500",
    };
  }, [health]);

  return (
    <div className="min-h-screen w-full text-slate-100">
      <header className="border-b border-white/10 backdrop-blur bg-white/5">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4">
          <div className="size-9 rounded-lg bg-gradient-to-br from-indigo-500 to-sky-400 grid place-items-center text-lg font-bold">
            OC
          </div>
          <div>
            <h1 className="text-lg font-semibold">OpenClaw Gateway</h1>
            <p className="text-xs text-slate-400">
              Local Ollama - Token-hub audit - Tool-calling agent
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className={`inline-block size-2 rounded-full ${headerStatus.color}`} />
            <span className="text-slate-300">{headerStatus.label}</span>
            <button
              onClick={() => {
                refreshHealth();
                refreshAudit();
              }}
              className="ml-3 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/15 text-xs"
            >
              Refresh
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-6 py-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 flex flex-col h-[78vh]">
          <div ref={chatScrollRef} className="flex-1 overflow-y-auto scrollbar-thin p-5 space-y-3">
            {messages.map((m) => (
              <Bubble key={m.id} m={m} />
            ))}
          </div>
          <div className="border-t border-white/10 p-3 flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder='Try: "Read my emails" or "Send an email to alex@example.com subject=Hi body=Hello"'
              rows={2}
              className="flex-1 resize-none rounded-lg bg-slate-900/70 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              onClick={send}
              disabled={busy || !input.trim()}
              className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 disabled:opacity-50 text-sm font-medium"
            >
              {busy ? "Sending..." : "Send"}
            </button>
          </div>
        </section>

        <aside className="space-y-4">
          <Panel title="System health">
            <HealthRow label="Backend (Flask)" info={health.backend} />
            <HealthRow label="Gateway (Ollama)" info={health.gateway} />
          </Panel>
          <Panel
            title="Recent audit log"
            right={<span className="text-xs text-slate-500">{audit.length}</span>}
          >
            {audit.length === 0 ? (
              <p className="text-sm text-slate-400">
                No actions yet. Send a chat message to see the audit log light up.
              </p>
            ) : (
              <ul className="space-y-2 max-h-[55vh] overflow-y-auto scrollbar-thin pr-1">
                {audit.map((a) => (
                  <li key={a.id} className="rounded-lg border border-white/10 bg-slate-900/40 p-2">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-mono text-slate-200">{a.action}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          a.result_status === "ok"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : "bg-rose-500/20 text-rose-300"
                        }`}
                      >
                        {a.result_status}
                      </span>
                    </div>
                    {a.tool_name && (
                      <p className="text-[11px] text-slate-400 mt-1">
                        tool: <span className="text-slate-200">{a.tool_name}</span>
                      </p>
                    )}
                    {a.message && (
                      <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">
                        msg: {a.message}
                      </p>
                    )}
                    <p className="text-[10px] text-slate-500 mt-1">
                      {new Date(a.created_at).toLocaleTimeString()}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </aside>
      </main>
    </div>
  );
}

function Bubble({ m }: { m: ChatMessage }): React.JSX.Element {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-indigo-500 text-white px-4 py-2 text-sm whitespace-pre-wrap">
          {m.text}
        </div>
      </div>
    );
  }
  if (m.role === "agent") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-slate-800/80 border border-white/10 px-4 py-2 text-sm whitespace-pre-wrap">
          {m.pending ? <span className="animate-pulse text-slate-400">{m.text}</span> : m.text}
          {m.model && !m.pending && <p className="mt-1 text-[10px] text-slate-500">via {m.model}</p>}
        </div>
      </div>
    );
  }
  if (m.role === "tool") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] rounded-2xl bg-sky-500/10 border border-sky-400/30 px-4 py-2 text-xs font-mono">
          <p className="text-sky-300 mb-1">{m.text}</p>
          {m.toolArgs !== undefined && (
            <details className="text-slate-300">
              <summary className="cursor-pointer text-slate-400">arguments</summary>
              <pre className="mt-1 text-[11px] whitespace-pre-wrap break-all">
                {JSON.stringify(m.toolArgs, null, 2)}
              </pre>
            </details>
          )}
          {m.toolResult !== undefined && (
            <details className="text-slate-300 mt-1">
              <summary className="cursor-pointer text-slate-400">result</summary>
              <pre className="mt-1 text-[11px] whitespace-pre-wrap break-all">
                {JSON.stringify(m.toolResult, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }
  return <div className="text-center text-xs text-slate-400 italic">{m.text}</div>;
}

function Panel({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <div className="flex items-center mb-3">
        <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
        <div className="ml-auto">{right}</div>
      </div>
      <div className="space-y-1.5 text-sm">{children}</div>
    </div>
  );
}

function HealthRow({
  label,
  info,
}: {
  label: string;
  info: { ok: boolean; detail?: string; model?: string };
}): React.JSX.Element {
  const detail = info.ok ? "ok" : info.detail?.slice(0, 40) || "down";
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-slate-300">{label}</span>
      <span className="flex items-center gap-2">
        {info.model && <span className="text-xs text-slate-500">{info.model}</span>}
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded ${
            info.ok ? "bg-emerald-500/20 text-emerald-300" : "bg-rose-500/20 text-rose-300"
          }`}
        >
          {detail}
        </span>
      </span>
    </div>
  );
}

export default App;
