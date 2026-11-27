import type { ModelProvider } from './store.js';

export interface RuntimeSettings {
  mode: 'auto' | 'advanced';
  context: number;
  output: number;
  top_k: number;
  temperature: number;
}

export const DEFAULT_RUNTIME: RuntimeSettings = { mode: 'auto', context: 4096, output: 512, top_k: 3, temperature: 0 };
export const PROMPT_RESERVE_BYTES = 800;

export function readRuntime(value: unknown): RuntimeSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const integer = (n: unknown, min: number, max: number): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  if ((v.mode !== 'auto' && v.mode !== 'advanced') || !integer(v.context, 1024, 32768) ||
      !integer(v.output, 128, 2048) || !integer(v.top_k, 1, 8) ||
      typeof v.temperature !== 'number' || !Number.isFinite(v.temperature) || v.temperature < 0 || v.temperature > 1 ||
      v.output > v.context / 2) return null;
  return { mode: v.mode, context: v.context, output: v.output, top_k: v.top_k, temperature: v.temperature };
}

export async function modelCapabilities(provider: ModelProvider, model: string): Promise<{ context_limit: number | null; can_chat: boolean | null; can_disable_thinking: boolean | null }> {
  const unknown = { context_limit: null, can_chat: null, can_disable_thinking: null };
  if (provider !== 'ollama') return unknown;
  try {
    const base = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const response = await fetch(`${base}/api/show`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }), redirect: 'manual', signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return unknown;
    const data = await response.json() as { model_info?: Record<string, unknown>; capabilities?: unknown; thinking?: { values?: unknown } };
    const info = data.model_info || {};
    const architecture = info['general.architecture'];
    const limit = typeof architecture === 'string' ? info[`${architecture}.context_length`] : undefined;
    const context_limit = typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : null;
    const capabilities = Array.isArray(data.capabilities) ? data.capabilities : null;
    const can_chat = capabilities && capabilities.every(item => typeof item === 'string')
      ? capabilities.includes('completion') ? true : capabilities.includes('embedding') ? false : null
      : null;
    const values = data.thinking?.values;
    const can_disable_thinking = Array.isArray(values) ? values.includes(false) : null;
    return { context_limit, can_chat, can_disable_thinking };
  } catch { return unknown; }
}

export function resolveRuntime(settings: RuntimeSettings | undefined, modelLimit: number | null, limits?: { input_limit: number | null; output_limit: number | null }): RuntimeSettings & { model_limit: number | null; input_limit: number | null; output_limit: number | null } {
  const requested = settings?.mode === 'advanced' ? settings : DEFAULT_RUNTIME;
  const context = Math.min(requested.context, modelLimit ?? requested.context);
  return { ...requested, context, output: Math.min(requested.output, Math.floor(context / 2), limits?.output_limit ?? requested.output), model_limit: modelLimit, input_limit: limits?.input_limit ?? null, output_limit: limits?.output_limit ?? null };
}

// shortcut: UTF-8 bytes overestimate typical token counts but cannot prove a provider's template/tokenizer size; use provider tokenization when exposed.
export function inputByteBudget(context: number, output: number, inputLimit?: number | null): number {
  const reserved = Math.max(256, Math.ceil(context * 0.1));
  return Math.max(0, Math.min(context - output, inputLimit ?? context) - reserved);
}

export function requestByteEstimate(messages: Array<{ role: string; content: string }>, schema: unknown): number {
  // shortcut: provider templates and tokenizers remain unknown; include schema and per-message overhead conservatively.
  return Buffer.byteLength(JSON.stringify(messages), 'utf-8') +
    Buffer.byteLength(JSON.stringify(schema ?? {}), 'utf-8') + 128 + messages.length * 32;
}

export function autoTopK(context: number, question: string): number {
  return Math.min(5, Math.max(2, Math.ceil(context / 2048) + 1 + (question.length > 120 ? 1 : 0)));
}
