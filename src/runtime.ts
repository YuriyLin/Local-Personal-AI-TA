import type { EngineGroup, ModelProvider } from './store.js';

export interface RuntimeSettings {
  mode: 'auto' | 'advanced';
  context: number;
  output: number;
  top_k: number;
  temperature: number;
  evidence_ratio?: number;
}

export interface ResolvedRuntime extends RuntimeSettings {
  evidence_ratio: number;
  max_passage_bytes: number;
  provider_group: EngineGroup;
  model_limit: number | null;
  input_limit: number | null;
  output_limit: number | null;
  known_context_limit: number | null;
  known_output_limit: number | null;
}

export const DEFAULT_EVIDENCE_RATIO = 0.68;
export const EVIDENCE_RATIO_MIN = 0.5;
export const EVIDENCE_RATIO_MAX = 0.8;

export const DEFAULT_RUNTIME: RuntimeSettings = {
  mode: 'auto',
  context: 4096,
  output: 512,
  top_k: 4,
  temperature: 0,
};
export const PROMPT_RESERVE_BYTES = 800;

export function providerGroupFor(provider: ModelProvider): EngineGroup {
  if (provider === 'ollama' || provider === 'lmstudio') return 'local';
  if (provider === 'antigravity-cli' || provider === 'claude-code' || provider === 'codex-cli') return 'cli';
  return 'cloud';
}

export function knownModelLimits(
  provider: ModelProvider,
  model: string
): { context_limit: number | null; output_limit: number | null } {
  const m = (model || '').toLowerCase();
  if (provider === 'ollama' || provider === 'lmstudio') {
    return { context_limit: null, output_limit: null };
  }
  if (provider === 'gemini') {
    return { context_limit: 1_048_576, output_limit: 8192 };
  }
  if (provider === 'claude' || provider === 'claude-code') {
    return { context_limit: 200_000, output_limit: 8192 };
  }
  if (provider === 'openai' || provider === 'codex-cli') {
    if (m.includes('gpt-4.1')) return { context_limit: 1_047_576, output_limit: 16_384 };
    if (/(?:gpt-4o|gpt-5|o1|o3|o4|codex|default)/.test(m)) return { context_limit: 128_000, output_limit: 16_384 };
    return { context_limit: 128_000, output_limit: 4096 };
  }
  if (provider === 'deepseek') {
    return { context_limit: 65_536, output_limit: 8192 };
  }
  // OpenRouter, OpenCode, Antigravity CLI: infer from model slug when recognizable.
  if (m.includes('gemini')) return { context_limit: 1_048_576, output_limit: 8192 };
  if (m.includes('claude')) return { context_limit: 200_000, output_limit: 8192 };
  if (m.includes('gpt-4.1')) return { context_limit: 1_047_576, output_limit: 16_384 };
  if (/(?:gpt-4o|gpt-5|o1|o3|o4|kimi|qwen)/.test(m)) return { context_limit: 128_000, output_limit: 8192 };
  if (m.includes('deepseek')) return { context_limit: 65_536, output_limit: 8192 };
  return { context_limit: 65_536, output_limit: 4096 };
}

export function passageByteCap(context: number): number {
  if (context >= 24_576) return 3200;
  if (context >= 12_288) return 2600;
  if (context >= 6144) return 2000;
  return 1600;
}

export function readRuntime(value: unknown): RuntimeSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const integer = (n: unknown, min: number, max: number): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  if (
    (v.mode !== 'auto' && v.mode !== 'advanced') ||
    !integer(v.context, 1024, 65536) ||
    !integer(v.output, 128, 4096) ||
    !integer(v.top_k, 1, 16) ||
    typeof v.temperature !== 'number' ||
    !Number.isFinite(v.temperature) ||
    v.temperature < 0 ||
    v.temperature > 1 ||
    v.output > v.context / 2
  ) {
    return null;
  }
  let evidenceRatio: number | undefined;
  if (v.evidence_ratio !== undefined) {
    if (
      typeof v.evidence_ratio !== 'number' ||
      !Number.isFinite(v.evidence_ratio) ||
      v.evidence_ratio < EVIDENCE_RATIO_MIN ||
      v.evidence_ratio > EVIDENCE_RATIO_MAX
    ) {
      return null;
    }
    evidenceRatio = Math.round(v.evidence_ratio * 100) / 100;
  }
  const result: RuntimeSettings = {
    mode: v.mode,
    context: v.context,
    output: v.output,
    top_k: v.top_k,
    temperature: v.temperature,
  };
  if (evidenceRatio !== undefined) {
    result.evidence_ratio = evidenceRatio;
  }
  return result;
}

export async function modelCapabilities(
  provider: ModelProvider,
  model: string
): Promise<{ context_limit: number | null; can_chat: boolean | null; can_disable_thinking: boolean | null }> {
  const unknown = { context_limit: null, can_chat: null, can_disable_thinking: null };
  if (provider !== 'ollama') return unknown;
  try {
    const base = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const response = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      redirect: 'manual',
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return unknown;
    const data = (await response.json()) as {
      model_info?: Record<string, unknown>;
      capabilities?: unknown;
      thinking?: { values?: unknown };
    };
    const info = data.model_info || {};
    const architecture = info['general.architecture'];
    const limit = typeof architecture === 'string' ? info[`${architecture}.context_length`] : undefined;
    const context_limit = typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : null;
    const capabilities = Array.isArray(data.capabilities) ? data.capabilities : null;
    const can_chat =
      capabilities && capabilities.every((item) => typeof item === 'string')
        ? capabilities.includes('completion')
          ? true
          : capabilities.includes('embedding')
            ? false
            : null
        : null;
    const values = data.thinking?.values;
    const can_disable_thinking = Array.isArray(values) ? values.includes(false) : null;
    return { context_limit, can_chat, can_disable_thinking };
  } catch {
    return unknown;
  }
}

function minPositive(...values: Array<number | null | undefined>): number | null {
  let result: number | null = null;
  for (const val of values) {
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      result = result === null ? val : Math.min(result, val);
    }
  }
  return result;
}

export function recommendedAutoProfile(
  providerGroup: EngineGroup,
  modelLimit: number | null,
  limits?: { input_limit: number | null; output_limit: number | null },
  known?: { context_limit: number | null; output_limit: number | null }
): {
  context: number;
  output: number;
  top_k: number;
  temperature: number;
  evidence_ratio: number;
  max_passage_bytes: number;
} {
  const effectiveContextCeiling = minPositive(modelLimit, limits?.input_limit, known?.context_limit);
  const effectiveOutputCeiling = minPositive(limits?.output_limit, known?.output_limit);

  if (providerGroup === 'local') {
    const context = effectiveContextCeiling !== null ? Math.min(4096, effectiveContextCeiling) : 4096;
    const output = Math.min(512, Math.floor(context / 2), effectiveOutputCeiling ?? 512);
    return {
      context,
      output,
      top_k: autoTopK(context, '', 'local'),
      temperature: 0,
      evidence_ratio: 0.68,
      max_passage_bytes: 1600,
    };
  }

  if (providerGroup === 'cli') {
    const context = effectiveContextCeiling !== null ? Math.min(16384, effectiveContextCeiling) : 16384;
    const output = Math.min(1536, Math.floor(context / 2), effectiveOutputCeiling ?? 1536);
    return {
      context,
      output,
      top_k: autoTopK(context, '', 'cli'),
      temperature: 0,
      evidence_ratio: 0.72,
      max_passage_bytes: Math.min(2600, passageByteCap(context)),
    };
  }

  // Cloud API: scale with detected/known window up to 32,768 tokens.
  let targetContext = 16384;
  let targetOutput = 1536;
  let evidenceRatio = 0.75;
  if (effectiveContextCeiling !== null && effectiveContextCeiling >= 128_000) {
    targetContext = 32768;
    targetOutput = 2048;
  } else if (effectiveContextCeiling !== null && effectiveContextCeiling < 16384) {
    targetContext = effectiveContextCeiling;
    targetOutput = 1024;
    evidenceRatio = 0.72;
  }
  const context = effectiveContextCeiling !== null ? Math.min(targetContext, effectiveContextCeiling) : targetContext;
  const output = Math.min(targetOutput, Math.floor(context / 2), effectiveOutputCeiling ?? targetOutput);
  return {
    context,
    output,
    top_k: autoTopK(context, '', 'cloud'),
    temperature: 0,
    evidence_ratio: evidenceRatio,
    max_passage_bytes: passageByteCap(context),
  };
}

export function resolveRuntime(
  settings: RuntimeSettings | undefined,
  modelLimit: number | null,
  limits?: { input_limit: number | null; output_limit: number | null },
  options?: { provider?: ModelProvider; providerGroup?: EngineGroup; model?: string }
): ResolvedRuntime {
  const providerGroup: EngineGroup =
    options?.providerGroup || (options?.provider ? providerGroupFor(options.provider) : 'local');
  const known =
    options?.provider && options?.model
      ? knownModelLimits(options.provider, options.model)
      : { context_limit: null, output_limit: null };

  const effectiveContextCeiling = minPositive(modelLimit, limits?.input_limit, known.context_limit);
  const effectiveOutputCeiling = minPositive(limits?.output_limit, known.output_limit);

  if (settings?.mode === 'advanced') {
    const context = Math.min(settings.context, effectiveContextCeiling ?? settings.context);
    const output = Math.min(settings.output, Math.floor(context / 2), effectiveOutputCeiling ?? settings.output);
    const evidenceRatio =
      typeof settings.evidence_ratio === 'number' && Number.isFinite(settings.evidence_ratio)
        ? Math.min(EVIDENCE_RATIO_MAX, Math.max(EVIDENCE_RATIO_MIN, settings.evidence_ratio))
        : 0.7;
    return {
      ...settings,
      context,
      output,
      evidence_ratio: evidenceRatio,
      max_passage_bytes: passageByteCap(context),
      provider_group: providerGroup,
      model_limit: modelLimit,
      input_limit: limits?.input_limit ?? null,
      output_limit: limits?.output_limit ?? null,
      known_context_limit: known.context_limit,
      known_output_limit: known.output_limit,
    };
  }

  const auto = recommendedAutoProfile(providerGroup, modelLimit, limits, known);
  return {
    mode: 'auto',
    context: auto.context,
    output: auto.output,
    top_k: auto.top_k,
    temperature: auto.temperature,
    evidence_ratio: auto.evidence_ratio,
    max_passage_bytes: auto.max_passage_bytes,
    provider_group: providerGroup,
    model_limit: modelLimit,
    input_limit: limits?.input_limit ?? null,
    output_limit: limits?.output_limit ?? null,
    known_context_limit: known.context_limit,
    known_output_limit: known.output_limit,
  };
}

// shortcut: UTF-8 bytes overestimate typical token counts but cannot prove a provider's template/tokenizer size; use provider tokenization when exposed.
export function inputByteBudget(context: number, output: number, inputLimit?: number | null): number {
  const reserved = Math.max(256, Math.ceil(context * 0.1));
  return Math.max(0, Math.min(context - output, inputLimit ?? context) - reserved);
}

export function requestByteEstimate(messages: Array<{ role: string; content: string }>, schema: unknown): number {
  // shortcut: provider templates and tokenizers remain unknown; include schema and per-message overhead conservatively.
  return (
    Buffer.byteLength(JSON.stringify(messages), 'utf-8') +
    Buffer.byteLength(JSON.stringify(schema ?? {}), 'utf-8') +
    128 +
    messages.length * 32
  );
}

export function autoTopK(context: number, question: string, providerGroup: EngineGroup = 'local'): number {
  const isLong = question.length > 120;
  if (providerGroup === 'local') {
    if (context <= 2048) return isLong ? 4 : 3;
    if (context <= 4096) return isLong ? 5 : 4;
    if (context <= 8192) return isLong ? 7 : 6;
    return isLong ? 9 : 8;
  }
  if (providerGroup === 'cli') {
    if (context <= 4096) return isLong ? 5 : 4;
    if (context <= 8192) return isLong ? 7 : 6;
    if (context <= 16384) return isLong ? 10 : 8;
    return isLong ? 12 : 10;
  }
  // Cloud API
  if (context <= 4096) return isLong ? 5 : 4;
  if (context <= 8192) return isLong ? 7 : 6;
  if (context <= 16384) return isLong ? 10 : 8;
  return isLong ? 12 : 10;
}
