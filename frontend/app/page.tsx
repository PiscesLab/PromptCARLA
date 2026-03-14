'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Send, Car, Loader2, Copy, Check, RotateCcw, Clock, Zap, Play } from 'lucide-react';

// -- Config --
const NODE_IP = process.env.NEXT_PUBLIC_NODE_IP || 'localhost';
const AGENT_PORT = process.env.NEXT_PUBLIC_AGENT_PORT || '8500';
const SNAPSHOT_PORT = process.env.NEXT_PUBLIC_SNAPSHOT_PORT || "8000";
const API_URL = process.env.NEXT_PUBLIC_API_URL || 
                `http://${process.env.NEXT_PUBLIC_NODE_IP}:${process.env.NEXT_PUBLIC_API_PORT || '8500'}`;

// -- Types --
type ModelResult = {
  model_name: string;
  status: string;
  config: Record<string, unknown> | null;
  validation_success: boolean;
  validation_errors: string[];
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  error: string | null;
};

type ConfigData = {
  status: string;
  simulator: string;
  simulation_id?: string;
  timestamp: string;
  model_results: ModelResult[];
  error?: string;
};

type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; data?: ConfigData; error?: string };

// -- Helpers --
function syntaxHighlight(json: string | object): string {
  if (typeof json !== 'string') json = JSON.stringify(json, null, 2);
  return json.replace(
    /("(\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
    (match: string) => {
      let cls = 'text-amber-300';
      if (/^"/.test(match)) {
        cls = /:$/.test(match) ? 'text-sky-400' : 'text-emerald-400';
      } else if (/true|false/.test(match)) {
        cls = 'text-violet-400';
      } else if (/null/.test(match)) {
        cls = 'text-rose-400';
      }
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

const MODEL_COLORS: Record<string, string> = {
  'gemini-2.5-flash': '#4285f4',
  'claude-sonnet-4': '#d4a27f',
  'gpt-4.1-mini': '#10a37f',
  'deepseek-v3': '#7c5cfc',
};

function getModelColor(name: string): string {
  return MODEL_COLORS[name] || '#6b7280';
}

// -- Components --
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      onClick={copy}
      className="flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors"
      style={{ color: '#9ca3af', background: 'rgba(255,255,255,0.04)' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.04)')}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div
        className="max-w-xl rounded-2xl rounded-br-md px-4 py-3"
        style={{ background: 'rgba(255,255,255,0.07)' }}
      >
        <p className="text-sm leading-relaxed" style={{ color: '#e5e7eb' }}>
          {text}
        </p>
      </div>
    </div>
  );
}

function ModelResultCard({
  result,
  onSelect,
  selecting,
}: {
  result: ModelResult;
  onSelect: (result: ModelResult) => void;
  selecting: boolean;
}) {
  const color = getModelColor(result.model_name);
  const config = result.config || {};
  const jsonStr = JSON.stringify(config, null, 2);
  const hasError = result.status === 'error' || !result.validation_success;
  const canSelect = result.validation_success && result.config;

  return (
    <div
      onClick={() => canSelect && !selecting && onSelect(result)}
      className={`overflow-hidden rounded-xl transition-all ${canSelect && !selecting ? 'cursor-pointer' : ''}`}
      style={{
        background: '#0d1117',
        border: `1px solid ${hasError ? 'rgba(239,68,68,0.2)' : 'rgba(255,255,255,0.06)'}`,
      }}
      onMouseEnter={(e) => {
        if (canSelect && !selecting) e.currentTarget.style.borderColor = `${color}40`;
      }}
      onMouseLeave={(e) => {
        if (canSelect && !selecting)
          e.currentTarget.style.borderColor = hasError
            ? 'rgba(239,68,68,0.2)'
            : 'rgba(255,255,255,0.06)';
      }}
    >
      {/* Model header */}
      <div
        className="flex items-center justify-between px-4 py-2.5"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full" style={{ background: color }} />
          <span className="text-xs font-semibold" style={{ color }}>
            {result.model_name}
          </span>
          {result.validation_success ? (
            <span
              className="rounded-full px-1.5 py-0.5"
              style={{
                background: 'rgba(34,197,94,0.1)',
                color: '#4ade80',
                fontSize: '10px',
              }}
            >
              valid
            </span>
          ) : (
            <span
              className="rounded-full px-1.5 py-0.5"
              style={{
                background: 'rgba(239,68,68,0.1)',
                color: '#f87171',
                fontSize: '10px',
              }}
            >
              {result.status === 'error' ? 'error' : 'invalid'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1" title="Latency">
            <Clock size={10} style={{ color: '#6b7280' }} />
            <span className="text-xs" style={{ color: '#6b7280' }}>
              {result.latency_ms.toFixed(0)}ms
            </span>
          </div>
          <div className="flex items-center gap-1" title="Tokens">
            <Zap size={10} style={{ color: '#6b7280' }} />
            <span className="text-xs" style={{ color: '#6b7280' }}>
              {result.total_tokens}tok
            </span>
          </div>
          {result.config && <CopyButton text={jsonStr} />}
        </div>
      </div>

      {/* Error display */}
      {result.error && (
        <div className="px-4 py-3">
          <p className="text-xs" style={{ color: '#f87171' }}>
            {result.error}
          </p>
        </div>
      )}

      {/* Validation errors */}
      {!result.error && result.validation_errors.length > 0 && (
        <div className="px-4 py-2" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
          <p className="text-xs" style={{ color: '#fbbf24' }}>
            Validation: {result.validation_errors[0].slice(0, 120)}
          </p>
        </div>
      )}

      {/* JSON output */}
      {result.config && (
        <pre
          className="overflow-x-auto p-4 text-xs leading-relaxed"
          style={{
            fontFamily: "var(--font-geist-mono, 'Geist Mono', monospace)",
          }}
          dangerouslySetInnerHTML={{ __html: syntaxHighlight(jsonStr) }}
        />
      )}

      {/* Footer: tokens + select prompt */}
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}
      >
        <div className="flex gap-4">
          {result.total_tokens > 0 && (
            <>
              <span className="text-xs" style={{ color: '#4b5563' }}>
                in: {result.input_tokens}
              </span>
              <span className="text-xs" style={{ color: '#4b5563' }}>
                out: {result.output_tokens}
              </span>
              <span className="text-xs" style={{ color: '#4b5563' }}>
                total: {result.total_tokens}
              </span>
            </>
          )}
        </div>
        {canSelect && (
          <div className="flex items-center gap-1" style={{ color: '#6b7280' }}>
            <Play size={10} />
            <span className="text-xs">Click to simulate</span>
          </div>
        )}
      </div>
    </div>
  );
}

function AssistantMessage({
  data,
  error,
  onSelectConfig,
  selecting,
}: {
  data?: ConfigData;
  error?: string;
  onSelectConfig: (result: ModelResult) => void;
  selecting: boolean;
}) {
  if (error) {
    return (
      <div className="flex justify-start">
        <div
          className="max-w-xl rounded-2xl rounded-bl-md px-4 py-3"
          style={{
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.15)',
          }}
        >
          <p className="text-sm" style={{ color: '#fca5a5' }}>
            {error}
          </p>
        </div>
      </div>
    );
  }

  if (!data?.model_results?.length) return null;

  const simId = data.simulation_id;

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-4xl space-y-3">
        <div className="flex items-center gap-2">
          <Car size={14} style={{ color: '#9ca3af' }} />
          <span className="text-xs font-medium" style={{ color: '#9ca3af' }}>
            CARLA Configuration
          </span>
          {simId && (
            <span
              className="rounded-full px-2 py-0.5 text-xs"
              style={{ background: 'rgba(255,255,255,0.05)', color: '#6b7280' }}
            >
              {simId}
            </span>
          )}
          <span className="text-xs" style={{ color: '#4b5563' }}>
            {data.model_results.length} model
            {data.model_results.length !== 1 ? 's' : ''} &middot; click a config to simulate
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {data.model_results.map((result) => (
            <ModelResultCard
              key={result.model_name}
              result={result}
              onSelect={onSelectConfig}
              selecting={selecting}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function LoadingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 px-1 py-3">
        <Loader2 size={16} className="animate-spin" style={{ color: '#6b7280' }} />
        <span className="text-sm" style={{ color: '#6b7280' }}>
          Generating configurations across all models...
        </span>
      </div>
    </div>
  );
}

// -- Main --
export default function MetisCityChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const MAX_CHARS = 500;

  const [status, setStatus] = useState({
    agent: 'loading',
    simulator: 'loading',
  });

  useEffect(() => {
    const checkHealth = async () => {
      try {
        // Check Agent
        const agentRes = await fetch(`${API_URL}/health`);
        const agentStatus = agentRes.ok ? 'online' : 'offline';

        // Check Snapshot/Simulator service (port 8000)
        const simRes = await fetch(`http://${NODE_IP}:${SNAPSHOT_PORT}/health`);
        const simStatus = simRes.ok ? 'online' : 'offline';

        setStatus({ agent: agentStatus, simulator: simStatus });
      } catch {
        setStatus({ agent: 'offline', simulator: 'offline' });
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 10000); // Check every 10s
    return () => clearInterval(interval);
  }, [API_URL, NODE_IP, SNAPSHOT_PORT]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendPrompt = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setMessages((prev) => [...prev, { role: 'user', text: trimmed }]);
    setInput('');
    setLoading(true);

    const startTime = performance.now();
    console.log(`[MetisCity] REQ  POST /generate_config prompt="${trimmed}"`);

    try {
      const res = await fetch(`${API_URL}/generate_config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed, simulator: 'carla' }),
      });

      const elapsed = (performance.now() - startTime).toFixed(1);

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        console.error(`[MetisCity] ERR  status=${res.status} latency=${elapsed}ms`, errBody);
        throw new Error(errBody?.detail || `Server returned ${res.status}`);
      }

      const data: ConfigData = await res.json();
      console.log(
        `[MetisCity] RESP status=200 latency=${elapsed}ms models=${data.model_results?.length}`,
        data.model_results?.map((r) => ({
          model: r.model_name,
          latency: r.latency_ms,
          tokens: r.total_tokens,
          valid: r.validation_success,
        }))
      );
      setMessages((prev) => [...prev, { role: 'assistant', data }]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      const elapsed = (performance.now() - startTime).toFixed(1);
      console.error(`[MetisCity] FAIL latency=${elapsed}ms error="${message}"`);
      setMessages((prev) => [...prev, { role: 'assistant', error: message }]);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectConfig = async (result: ModelResult) => {
    if (!result.config || selecting) return;
    setSelecting(true);

    console.log(`[MetisCity] Selecting config from ${result.model_name}`);

    try {
      const res = await fetch(`${API_URL}/apply_config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: result.config,
          model_name: result.model_name,
        }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.detail || `Server returned ${res.status}`);
      }

      const data = await res.json();
      console.log(`[MetisCity] Config applied: ${data.simulation_id}`);

      // Store result for the results page
      sessionStorage.setItem(
        'simulationResult',
        JSON.stringify({
          simulation_id: data.simulation_id,
          config: result.config,
          model_name: result.model_name,
          simulator_status: data.simulator_status,
        })
      );

      router.push(`/results/${data.simulation_id}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to apply config';
      console.error(`[MetisCity] Apply failed: ${message}`);
      // Still navigate -- CARLA might not be running but we can show the config
      const fallbackId = `sim_${Date.now().toString(36)}`;
      sessionStorage.setItem(
        'simulationResult',
        JSON.stringify({
          simulation_id: fallbackId,
          config: result.config,
          model_name: result.model_name,
          simulator_status: 'error',
          error: message,
        })
      );
      router.push(`/results/${fallbackId}`);
    } finally {
      setSelecting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendPrompt(input);
    }
  };

  const handleClear = () => {
    setMessages([]);
    inputRef.current?.focus();
  };

  const examples = [
    'Light traffic on a clear day in a small town',
    'Pouring rain with heavy traffic downtown',
    'Night highway scene, 3 vehicles, no pedestrians',
    'Rural road with fog and a single car',
  ];

  const isEmpty = messages.length === 0;

  return (
    <div
      className="flex flex-col"
      style={{
        height: '100vh',
        background: '#111116',
        color: '#e5e7eb',
        fontFamily: "var(--font-geist-sans, 'Geist', system-ui, sans-serif)",
      }}
    >
      {/* Header */}
      <header
        className="flex items-center justify-between px-6 py-3"
        style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}
      >
        <div className="flex items-center gap-3">
          <Car size={20} style={{ color: '#9ca3af' }} />
          <span className="text-sm font-semibold tracking-wide" style={{ color: '#d1d5db' }}>
            MetisCity
          </span>
          <div className="flex gap-2">
            <span
              className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs"
              style={{
                background: 'rgba(255,255,255,0.05)',
                color: status.agent === 'online' ? '#4ade80' : '#f87171',
              }}
            >
              <div
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background: status.agent === 'online' ? '#4ade80' : '#f87171',
                }}
              />
              Agent
            </span>
            <span
              className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs"
              style={{
                background: 'rgba(255,255,255,0.05)',
                color: status.simulator === 'online' ? '#4ade80' : '#f87171',
              }}
            >
              <div
                className="h-1.5 w-1.5 rounded-full"
                style={{
                  background: status.simulator === 'online' ? '#4ade80' : '#f87171',
                }}
              />
              Simulator
            </span>
          </div>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleClear}
            className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors"
            style={{ color: '#6b7280' }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.05)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <RotateCcw size={12} />
            New chat
          </button>
        )}
      </header>

      {/* Selecting overlay */}
      {selecting && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.5)' }}
        >
          <div
            className="flex items-center gap-3 rounded-2xl px-6 py-4"
            style={{ background: '#1a1a22' }}
          >
            <Loader2 size={20} className="animate-spin" style={{ color: '#6b7280' }} />
            <span className="text-sm" style={{ color: '#d1d5db' }}>
              Applying config to CARLA...
            </span>
          </div>
        </div>
      )}

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center px-4">
            <div className="w-full max-w-2xl space-y-10">
              <div className="space-y-3 text-center">
                <div className="flex justify-center">
                  <div
                    className="flex h-12 w-12 items-center justify-center rounded-2xl"
                    style={{ background: 'rgba(255,255,255,0.04)' }}
                  >
                    <Car size={24} style={{ color: '#6b7280' }} />
                  </div>
                </div>
                <h1 className="text-2xl font-medium" style={{ color: '#d1d5db' }}>
                  Describe a traffic scenario
                </h1>
                <p className="text-sm" style={{ color: '#6b7280' }}>
                  MetisCity generates CARLA configs using Gemini, Claude, GPT, and DeepSeek in
                  parallel.
                  <br />
                  Click a result to send it to the simulator.
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {examples.map((ex) => (
                  <button
                    key={ex}
                    onClick={() => sendPrompt(ex)}
                    className="rounded-xl px-4 py-3 text-left text-sm transition-colors"
                    style={{
                      color: '#9ca3af',
                      background: 'rgba(255,255,255,0.03)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
                      e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)';
                    }}
                  >
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-5xl space-y-6 px-4 py-6">
            {messages.map((msg, i) =>
              msg.role === 'user' ? (
                <UserMessage key={i} text={msg.text} />
              ) : (
                <AssistantMessage
                  key={i}
                  data={msg.data}
                  error={msg.error}
                  onSelectConfig={handleSelectConfig}
                  selecting={selecting}
                />
              )
            )}
            {loading && <LoadingIndicator />}
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="px-4 pt-2 pb-4" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <div
          className="mx-auto max-w-3xl overflow-hidden rounded-2xl"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput((e.target.value || '').slice(0, MAX_CHARS))}
            onKeyDown={handleKeyDown}
            placeholder="Describe a traffic scenario..."
            rows={2}
            className="w-full resize-none border-0 bg-transparent p-4 text-sm placeholder-gray-600 outline-none"
            style={{ color: '#e5e7eb', fontFamily: 'inherit' }}
          />
          <div className="flex items-center justify-between px-4 pb-3">
            <span className="text-xs" style={{ color: '#4b5563' }}>
              {input.length}/{MAX_CHARS}
            </span>
            <button
              onClick={() => sendPrompt(input)}
              disabled={!input.trim() || loading}
              className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-all"
              style={{
                background:
                  input.trim() && !loading ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)',
                color: input.trim() && !loading ? '#e5e7eb' : '#4b5563',
                cursor: input.trim() && !loading ? 'pointer' : 'not-allowed',
              }}
              onMouseEnter={(e) => {
                if (input.trim() && !loading)
                  e.currentTarget.style.background = 'rgba(255,255,255,0.15)';
              }}
              onMouseLeave={(e) => {
                if (input.trim() && !loading)
                  e.currentTarget.style.background = 'rgba(255,255,255,0.1)';
              }}
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Simulate
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
