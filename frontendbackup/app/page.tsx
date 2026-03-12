'use client';

import { useState, useRef, useEffect } from "react";
import { Send, Car, Loader2, Copy, Check, RotateCcw } from "lucide-react";

// -- Config --
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8500";

// -- Types --
type ConfigData = {
  config?: Record<string, unknown>;
  simulation_id?: string;
  simulator_status?: string;
  [key: string]: unknown;
};

type Message =
  | { role: "user"; text: string }
  | { role: "assistant"; data?: ConfigData; error?: string };

// -- Helpers --
function syntaxHighlight(json: string | object): string {
  if (typeof json !== "string") json = JSON.stringify(json, null, 2);
  return json.replace(
    /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match: string) => {
      let cls = "text-amber-300"; // number
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? "text-sky-400" : "text-emerald-400"; // key : string
      } else if (/true|false/.test(match)) {
        cls = "text-violet-400";
      } else if (/null/.test(match)) {
        cls = "text-rose-400";
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
      style={{ color: "#9ca3af", background: "rgba(255,255,255,0.04)" }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.background = "rgba(255,255,255,0.08)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.background = "rgba(255,255,255,0.04)")
      }
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

// -- Message components --
function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-xl rounded-2xl rounded-br-md px-4 py-3"
        style={{ background: "rgba(255,255,255,0.07)" }}
      >
        <p className="text-sm leading-relaxed" style={{ color: "#e5e7eb" }}>
          {text}
        </p>
      </div>
    </div>
  );
}

function AssistantMessage({ data, error }: { data?: ConfigData; error?: string }) {
  if (error) {
    return (
      <div className="flex justify-start">
        <div
          className="max-w-xl rounded-2xl rounded-bl-md px-4 py-3"
          style={{
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.15)",
          }}
        >
          <p className="text-sm" style={{ color: "#fca5a5" }}>
            {error}
          </p>
        </div>
      </div>
    );
  }

  const config = (data?.config || data || {}) as Record<string, unknown>;
  const simId = data?.simulation_id;
  const simStatus = data?.simulator_status;
  const jsonStr = JSON.stringify(config, null, 2);

  return (
    <div className="flex justify-start">
      <div className="max-w-2xl space-y-2">
        {/* status pill row */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Car size={14} style={{ color: "#9ca3af" }} />
            <span className="text-xs font-medium" style={{ color: "#9ca3af" }}>
              CARLA Configuration
            </span>
          </div>
          {simId && (
            <span
              className="rounded-full px-2 py-0.5 text-xs"
              style={{
                background: "rgba(255,255,255,0.05)",
                color: "#6b7280",
              }}
            >
              {simId}
            </span>
          )}
          {simStatus && (
            <span
              className="rounded-full px-2 py-0.5 text-xs"
              style={{
                background:
                  simStatus === "success"
                    ? "rgba(34,197,94,0.1)"
                    : "rgba(234,179,8,0.1)",
                color: simStatus === "success" ? "#4ade80" : "#facc15",
              }}
            >
              {simStatus === "success" ? "Applied" : simStatus}
            </span>
          )}
        </div>

        {/* JSON block */}
        <div
          className="overflow-hidden rounded-xl"
          style={{
            background: "#0d1117",
            border: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div
            className="flex items-center justify-between px-4 py-2"
            style={{
              borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <span className="text-xs" style={{ color: "#6b7280" }}>
              JSON
            </span>
            <CopyButton text={jsonStr} />
          </div>
          <pre
            className="overflow-x-auto p-4 text-sm leading-relaxed"
            style={{
              fontFamily:
                "var(--font-geist-mono, 'Geist Mono', monospace)",
            }}
            dangerouslySetInnerHTML={{ __html: syntaxHighlight(jsonStr) }}
          />
        </div>

        {/* quick-read chips for key params */}
        {config && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {(
              [
                config.weather && {
                  label: "Weather",
                  value: config.weather as string,
                },
                config.map && { label: "Map", value: config.map as string },
                config.number_of_vehicles != null && {
                  label: "Vehicles",
                  value: String(config.number_of_vehicles),
                },
                config.number_of_pedestrians != null && {
                  label: "Pedestrians",
                  value: String(config.number_of_pedestrians),
                },
                config.visibility != null && {
                  label: "Visibility",
                  value: `${config.visibility}%`,
                },
              ].filter(Boolean) as { label: string; value: string }[]
            ).map((chip) => (
              <span
                key={chip.label}
                className="rounded-md px-2 py-1 text-xs"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  color: "#9ca3af",
                }}
              >
                <span style={{ color: "#6b7280" }}>{chip.label}:</span>{" "}
                <span style={{ color: "#d1d5db" }}>{chip.value}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function LoadingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 px-1 py-3">
        <Loader2
          size={16}
          className="animate-spin"
          style={{ color: "#6b7280" }}
        />
        <span className="text-sm" style={{ color: "#6b7280" }}>
          Generating configuration...
        </span>
      </div>
    </div>
  );
}

// -- Main App --
export default function MetisCityChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const MAX_CHARS = 500;

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, loading]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendPrompt = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/generate_config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: trimmed,
          simulator: "carla",
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(
          errBody?.detail || `Server returned ${res.status}`
        );
      }

      const data: ConfigData = await res.json();
      setMessages((prev) => [...prev, { role: "assistant", data }]);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Something went wrong";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", error: message },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendPrompt(input);
    }
  };

  const handleClear = () => {
    setMessages([]);
    inputRef.current?.focus();
  };

  const examples = [
    "Light traffic on a clear day in a small town",
    "Pouring rain with heavy traffic downtown",
    "Night highway scene, 3 vehicles, no pedestrians",
    "Rural road with fog and a single car",
  ];

  const isEmpty = messages.length === 0;

  return (
    <div
      className="flex flex-col"
      style={{
        height: "100vh",
        background: "#111116",
        color: "#e5e7eb",
        fontFamily: "var(--font-geist-sans, 'Geist', system-ui, sans-serif)",
      }}
    >
      {/* Header */}
      <header
        className="flex items-center justify-between px-6 py-3"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="flex items-center gap-3">
          <Car size={20} style={{ color: "#9ca3af" }} />
          <span
            className="text-sm font-semibold tracking-wide"
            style={{ color: "#d1d5db", letterSpacing: "0.04em" }}
          >
            MetisCity
          </span>
          <span
            className="rounded-full px-2 py-0.5 text-xs"
            style={{
              background: "rgba(255,255,255,0.05)",
              color: "#6b7280",
            }}
          >
            CARLA
          </span>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleClear}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors"
            style={{ color: "#6b7280" }}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "rgba(255,255,255,0.05)")
            }
            onMouseLeave={(e) =>
              (e.currentTarget.style.background = "transparent")
            }
          >
            <RotateCcw size={12} />
            New chat
          </button>
        )}
      </header>

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {isEmpty ? (
          /* Empty state */
          <div className="flex h-full flex-col items-center justify-center px-4">
            <div className="w-full max-w-2xl space-y-10">
              <div className="space-y-3 text-center">
                <div className="flex justify-center">
                  <div
                    className="flex h-12 w-12 items-center justify-center rounded-2xl"
                    style={{ background: "rgba(255,255,255,0.04)" }}
                  >
                    <Car size={24} style={{ color: "#6b7280" }} />
                  </div>
                </div>
                <h1
                  className="text-2xl font-medium"
                  style={{ color: "#d1d5db" }}
                >
                  Describe a traffic scenario
                </h1>
                <p className="text-sm" style={{ color: "#6b7280" }}>
                  MetisCity will generate a CARLA simulation configuration from
                  your description.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {examples.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => sendPrompt(ex)}
                    className="rounded-xl px-4 py-3 text-left text-sm transition-colors"
                    style={{
                      color: "#9ca3af",
                      background: "rgba(255,255,255,0.03)",
                      border: "1px solid rgba(255,255,255,0.06)",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background =
                        "rgba(255,255,255,0.06)";
                      e.currentTarget.style.borderColor =
                        "rgba(255,255,255,0.1)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background =
                        "rgba(255,255,255,0.03)";
                      e.currentTarget.style.borderColor =
                        "rgba(255,255,255,0.06)";
                    }}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          /* Message thread */
          <div className="mx-auto max-w-3xl space-y-6 px-4 py-6">
            {messages.map((msg, i) =>
              msg.role === "user" ? (
                <UserMessage key={i} text={msg.text} />
              ) : (
                <AssistantMessage
                  key={i}
                  data={msg.data}
                  error={msg.error}
                />
              )
            )}
            {loading && <LoadingIndicator />}
          </div>
        )}
      </div>

      {/* Input bar */}
      <div
        className="px-4 pb-4 pt-2"
        style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div
          className="mx-auto max-w-3xl overflow-hidden rounded-2xl"
          style={{
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) =>
              setInput((e.target.value || "").slice(0, MAX_CHARS))
            }
            onKeyDown={handleKeyDown}
            placeholder="Describe a traffic scenario..."
            rows={2}
            className="w-full resize-none border-0 bg-transparent p-4 text-sm outline-none placeholder-gray-600"
            style={{
              color: "#e5e7eb",
              fontFamily: "inherit",
            }}
          />
          <div className="flex items-center justify-between px-4 pb-3">
            <span className="text-xs" style={{ color: "#4b5563" }}>
              {input.length}/{MAX_CHARS}
            </span>
            <button
              onClick={() => sendPrompt(input)}
              disabled={!input.trim() || loading}
              className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-all"
              style={{
                background:
                  input.trim() && !loading
                    ? "rgba(255,255,255,0.1)"
                    : "rgba(255,255,255,0.03)",
                color: input.trim() && !loading ? "#e5e7eb" : "#4b5563",
                cursor:
                  input.trim() && !loading ? "pointer" : "not-allowed",
              }}
              onMouseEnter={(e) => {
                if (input.trim() && !loading)
                  e.currentTarget.style.background = "rgba(255,255,255,0.15)";
              }}
              onMouseLeave={(e) => {
                if (input.trim() && !loading)
                  e.currentTarget.style.background = "rgba(255,255,255,0.1)";
              }}
            >
              {loading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Send size={14} />
              )}
              Simulate
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
