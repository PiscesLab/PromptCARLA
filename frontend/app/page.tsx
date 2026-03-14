'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Send, Car, Loader2, Copy, Check, Clock, Zap, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';

// -- Config --
const API_URL =
  process.env.NEXT_PUBLIC_API_URL ||
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
  return MODEL_COLORS[name] || 'hsl(var(--muted-foreground))';
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
    <Button
      variant="ghost"
      size="sm"
      onClick={copy}
      className="h-6 gap-1 px-2 text-xs text-muted-foreground"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-xl rounded-2xl rounded-br-md bg-muted px-4 py-3">
        <p className="text-sm leading-relaxed text-foreground">{text}</p>
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
    <Card
      onClick={() => canSelect && !selecting && onSelect(result)}
      className={`overflow-hidden transition-all ${
        canSelect && !selecting ? 'cursor-pointer hover:border-border/80 hover:shadow-md' : ''
      } ${hasError ? 'border-destructive/30' : ''}`}
    >
      {/* Model header */}
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full" style={{ background: color }} />
          <span className="text-xs font-semibold" style={{ color }}>
            {result.model_name}
          </span>
          {result.validation_success ? (
            <Badge
              variant="outline"
              className="h-4 border-green-500/30 bg-green-500/10 px-1.5 text-[10px] text-green-400"
            >
              valid
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="h-4 border-destructive/30 bg-destructive/10 px-1.5 text-[10px] text-destructive"
            >
              {result.status === 'error' ? 'error' : 'invalid'}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 text-muted-foreground" title="Latency">
            <Clock size={10} />
            <span className="text-xs">{result.latency_ms.toFixed(0)}ms</span>
          </div>
          <div className="flex items-center gap-1 text-muted-foreground" title="Tokens">
            <Zap size={10} />
            <span className="text-xs">{result.total_tokens}tok</span>
          </div>
          {result.config && <CopyButton text={jsonStr} />}
        </div>
      </div>

      {/* Error display */}
      {result.error && (
        <div className="px-4 py-3">
          <p className="text-xs text-destructive">{result.error}</p>
        </div>
      )}

      {/* Validation errors */}
      {!result.error && result.validation_errors.length > 0 && (
        <div className="border-b px-4 py-2">
          <p className="text-xs text-yellow-400">
            Validation: {result.validation_errors[0].slice(0, 120)}
          </p>
        </div>
      )}

      {/* JSON output */}
      {result.config && (
        <pre
          className="overflow-x-auto bg-muted/40 p-4 text-xs leading-relaxed"
          style={{ fontFamily: "var(--font-geist-mono, 'Geist Mono', monospace)" }}
          dangerouslySetInnerHTML={{ __html: syntaxHighlight(jsonStr) }}
        />
      )}

      {/* Footer */}
      <div className="flex items-center justify-between border-t px-4 py-2">
        <div className="flex gap-4">
          {result.total_tokens > 0 && (
            <>
              <span className="text-xs text-muted-foreground/60">in: {result.input_tokens}</span>
              <span className="text-xs text-muted-foreground/60">out: {result.output_tokens}</span>
              <span className="text-xs text-muted-foreground/60">
                total: {result.total_tokens}
              </span>
            </>
          )}
        </div>
        {canSelect && (
          <div className="flex items-center gap-1 text-muted-foreground">
            <Play size={10} />
            <span className="text-xs">Click to simulate</span>
          </div>
        )}
      </div>
    </Card>
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
        <Card className="max-w-xl border-destructive/20 bg-destructive/5 px-4 py-3">
          <p className="text-sm text-destructive">{error}</p>
        </Card>
      </div>
    );
  }

  if (!data?.model_results?.length) return null;

  const simId = data.simulation_id;

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-4xl space-y-3">
        <div className="flex items-center gap-2">
          <Car size={14} className="text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">CARLA Configuration</span>
          {simId && (
            <Badge variant="secondary" className="text-xs">
              {simId}
            </Badge>
          )}
          <span className="text-xs text-muted-foreground/60">
            {data.model_results.length} model{data.model_results.length !== 1 ? 's' : ''} &middot;
            click a config to simulate
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
        <Loader2 size={16} className="animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">
          Generating configurations across all models...
        </span>
      </div>
    </div>
  );
}

// -- Main --
export default function PromptCarlaChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const MAX_CHARS = 500;

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

    try {
      const res = await fetch(`${API_URL}/generate_config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: trimmed, simulator: 'carla' }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.detail || `Server returned ${res.status}`);
      }

      const data: ConfigData = await res.json();
      setMessages((prev) => [...prev, { role: 'assistant', data }]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Something went wrong';
      setMessages((prev) => [...prev, { role: 'assistant', error: message }]);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectConfig = async (result: ModelResult) => {
    if (!result.config || selecting) return;
    setSelecting(true);

    try {
      const res = await fetch(`${API_URL}/apply_config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: result.config, model_name: result.model_name }),
      });

      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.detail || `Server returned ${res.status}`);
      }

      const data = await res.json();
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
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Selecting overlay */}
      {selecting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/60 backdrop-blur-sm">
          <Card className="flex items-center gap-3 px-6 py-4">
            <Loader2 size={20} className="animate-spin text-muted-foreground" />
            <span className="text-sm text-foreground">Applying config to CARLA...</span>
          </Card>
        </div>
      )}

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center px-4">
            <div className="w-full max-w-2xl space-y-10">
              <div className="space-y-3 text-center">
                <div className="flex justify-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted">
                    <Car size={24} className="text-muted-foreground" />
                  </div>
                </div>
                <h1 className="text-2xl font-medium text-foreground">
                  Describe a traffic scenario
                </h1>
                <p className="text-sm text-muted-foreground">
                  PromptCarla generates CARLA configs using Gemini, Claude, GPT, and DeepSeek in
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
                    className="rounded-xl border bg-card px-4 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
      <div className="border-t px-4 pb-4 pt-2">
        <div className="mx-auto max-w-3xl overflow-hidden rounded-2xl border bg-card">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput((e.target.value || '').slice(0, MAX_CHARS))}
            onKeyDown={handleKeyDown}
            placeholder="Describe a traffic scenario..."
            rows={2}
            className="resize-none rounded-none border-0 bg-transparent p-4 text-sm shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center justify-between px-4 pb-3">
            <span className="text-xs text-muted-foreground/60">
              {input.length}/{MAX_CHARS}
            </span>
            <Button
              onClick={() => sendPrompt(input)}
              disabled={!input.trim() || loading}
              size="sm"
              variant={input.trim() && !loading ? 'default' : 'ghost'}
              className="gap-2"
            >
              {loading ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              Simulate
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
