import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { EngineGroup, ModelProvider, store } from './store.js';

export const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
export const LMSTUDIO_URL = (process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234').replace(/\/+$/, '');

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  provider?: ModelProvider;
  model?: string;
  jsonSchema?: Record<string, unknown>;
  expectJson?: boolean;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

export interface ChatCompletionResult {
  text: string;
  provider: ModelProvider;
  model: string;
  prompt_tokens: number | null;
  output_tokens: number | null;
  done_reason?: string;
}

export interface EngineDescriptor {
  id: ModelProvider;
  group: EngineGroup;
  name: string;
  name_zh: string;
  description: string;
  description_zh: string;
  default_model: string;
  recommended_models: string[];
  env_var: string | null;
  cli_binaries?: string[];
  endpoint_hint?: string;
  allow_custom_model: boolean;
}

export interface EngineStatus extends EngineDescriptor {
  available: boolean;
  detected_models: string[];
  models: string[];
  status_text: string;
  status_text_en: string;
  detected_binary?: string | null;
}

export class LlmError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const ENGINE_CATALOG: readonly EngineDescriptor[] = [
  // Local Models
  {
    id: 'ollama',
    group: 'local',
    name: 'Ollama',
    name_zh: 'Ollama',
    description: 'Run open-source models locally with full privacy',
    description_zh: '本機執行開源模型，資料完全留在電腦',
    default_model: 'qwen3.5:0.8b',
    recommended_models: ['qwen3.5:0.8b', 'qwen3:4b', 'gemma3:4b', 'llama3.2:3b'],
    env_var: null,
    endpoint_hint: OLLAMA_URL,
    allow_custom_model: true,
  },
  {
    id: 'lmstudio',
    group: 'local',
    name: 'LM Studio',
    name_zh: 'LM Studio',
    description: 'Local OpenAI-compatible server via LM Studio',
    description_zh: '連接本機 LM Studio 模型伺服器',
    default_model: 'local-model',
    recommended_models: ['local-model'],
    env_var: null,
    endpoint_hint: LMSTUDIO_URL,
    allow_custom_model: true,
  },

  // Local CLI
  {
    id: 'antigravity-cli',
    group: 'cli',
    name: 'Antigravity CLI',
    name_zh: 'Antigravity CLI',
    description: 'Invoke local Antigravity CLI agent directly',
    description_zh: '透過本機 Antigravity CLI 命令列執行',
    default_model: 'default',
    recommended_models: ['default', 'gemini-4-hydrogen', 'gemini-4-neon', 'claude-sonnet-4'],
    env_var: null,
    cli_binaries: ['antigravity', 'agy'],
    allow_custom_model: true,
  },
  {
    id: 'claude-code',
    group: 'cli',
    name: 'Claude Code',
    name_zh: 'Claude Code',
    description: 'Invoke local Anthropic Claude Code CLI',
    description_zh: '透過本機 Claude Code CLI（claude）執行',
    default_model: 'sonnet',
    recommended_models: ['sonnet', 'opus', 'haiku', 'default'],
    env_var: null,
    cli_binaries: ['claude'],
    allow_custom_model: true,
  },
  {
    id: 'codex-cli',
    group: 'cli',
    name: 'Codex CLI',
    name_zh: 'Codex CLI',
    description: 'Invoke local OpenAI Codex CLI in non-interactive mode',
    description_zh: '透過本機 Codex CLI（codex）命令列執行',
    default_model: 'default',
    recommended_models: ['default', 'o4-mini', 'gpt-4.1', 'codex-mini-latest'],
    env_var: null,
    cli_binaries: ['codex'],
    allow_custom_model: true,
  },

  // Cloud APIs (server-side env vars only — never exposed to browser)
  {
    id: 'gemini',
    group: 'cloud',
    name: 'Gemini',
    name_zh: 'Gemini',
    description: 'Google Gemini API via official @google/genai SDK',
    description_zh: 'Google Gemini 官方雲端模型',
    default_model: 'gemini-4-hydrogen',
    recommended_models: ['gemini-4-hydrogen', 'gemini-3.1-flash-lite', 'gemini-4-neon', 'gemini-4-carbon'],
    env_var: 'GEMINI_API_KEY',
    allow_custom_model: false,
  },
  {
    id: 'openai',
    group: 'cloud',
    name: 'OpenAI',
    name_zh: 'OpenAI',
    description: 'OpenAI GPT & reasoning models via server API key',
    description_zh: 'OpenAI GPT 與推理系列模型',
    default_model: 'gpt-4.1-mini',
    recommended_models: ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4o-mini', 'gpt-4o', 'o4-mini'],
    env_var: 'OPENAI_API_KEY',
    allow_custom_model: true,
  },
  {
    id: 'claude',
    group: 'cloud',
    name: 'Claude',
    name_zh: 'Claude',
    description: 'Anthropic Claude Messages API via server API key',
    description_zh: 'Anthropic Claude 官方雲端模型',
    default_model: 'claude-sonnet-4-20250514',
    recommended_models: ['claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
    env_var: 'ANTHROPIC_API_KEY',
    allow_custom_model: true,
  },
  {
    id: 'opencode',
    group: 'cloud',
    name: 'OpenCode',
    name_zh: 'OpenCode',
    description: 'OpenCode Zen / compatible cloud endpoint',
    description_zh: 'OpenCode 雲端模型端點（OpenAI 相容）',
    default_model: 'kimi-k2',
    recommended_models: ['kimi-k2', 'qwen3-coder', 'deepseek-chat', 'big-pickle', 'grok-code'],
    env_var: 'OPENCODE_API_KEY',
    allow_custom_model: true,
  },
  {
    id: 'deepseek',
    group: 'cloud',
    name: 'DeepSeek',
    name_zh: 'DeepSeek',
    description: 'DeepSeek Chat & Reasoner cloud models',
    description_zh: 'DeepSeek 官方雲端模型',
    default_model: 'deepseek-chat',
    recommended_models: ['deepseek-chat', 'deepseek-reasoner'],
    env_var: 'DEEPSEEK_API_KEY',
    allow_custom_model: true,
  },
  {
    id: 'openrouter',
    group: 'cloud',
    name: 'OpenRouter',
    name_zh: 'OpenRouter',
    description: 'Unified multi-model router via OpenRouter',
    description_zh: '透過 OpenRouter 切換多種雲端模型',
    default_model: 'google/gemini-2.5-flash',
    recommended_models: [
      'google/gemini-2.5-flash',
      'anthropic/claude-sonnet-4',
      'openai/gpt-4.1-mini',
      'deepseek/deepseek-chat-v3-0324',
    ],
    env_var: 'OPENROUTER_API_KEY',
    allow_custom_model: true,
  },
];

const ENGINE_BY_ID = new Map<ModelProvider, EngineDescriptor>(ENGINE_CATALOG.map((e) => [e.id, e]));

export function isValidProvider(value: unknown): value is ModelProvider {
  return typeof value === 'string' && ENGINE_BY_ID.has(value as ModelProvider);
}

export function getEngineDescriptor(provider: ModelProvider): EngineDescriptor {
  return ENGINE_BY_ID.get(provider) || ENGINE_CATALOG[0];
}

// Strict model name check: no whitespace, no shell metacharacters, cannot start with '-' (prevents CLI flag injection).
export function isSafeModelName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 120 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(value)
  );
}

function isEn(): boolean {
  return store.settings.language === 'en';
}

// Safe PATH lookup without spawning a shell (`which`).
function findExecutableOnPath(candidates: string[]): string | null {
  const envPath = process.env.PATH || '';
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const bin of candidates) {
    // Only permit bare executable names from our static allowlist.
    if (!/^[a-zA-Z0-9_-]+$/.test(bin)) continue;
    for (const dir of dirs) {
      for (const ext of exts) {
        const candidate = path.join(dir, `${bin}${ext}`);
        try {
          fs.accessSync(candidate, fs.constants.X_OK);
          return candidate;
        } catch {
          // continue searching PATH
        }
      }
    }
  }
  return null;
}

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  return (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '::' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^(::ffff:|fe80:|fc|fd)/i.test(host)
  );
}

export function stripThinkAndFence(raw: string): string {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = /^```(?:json|markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(text);
  if (fenced) text = fenced[1].trim();
  return text;
}

export function parseJsonFromLlm<T>(raw: string): T {
  const cleaned = stripThinkAndFence(raw);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const startObj = cleaned.indexOf('{');
    const endObj = cleaned.lastIndexOf('}');
    if (startObj !== -1 && endObj > startObj) {
      try {
        return JSON.parse(cleaned.slice(startObj, endObj + 1)) as T;
      } catch {
        // continue
      }
    }
    const startArr = cleaned.indexOf('[');
    const endArr = cleaned.lastIndexOf(']');
    if (startArr !== -1 && endArr > startArr) {
      try {
        return JSON.parse(cleaned.slice(startArr, endArr + 1)) as T;
      } catch {
        // continue
      }
    }
    throw new LlmError(
      502,
      isEn()
        ? 'The AI engine returned incomplete structured output. Please try regenerating.'
        : 'AI 模型輸出的結構化格式不完整，請點擊重新生成再試一次。'
    );
  }
}

function withSchemaHint(
  messages: ChatMessage[],
  jsonSchema?: Record<string, unknown>,
  expectJson?: boolean
): ChatMessage[] {
  if (!jsonSchema && !expectJson) return messages;
  const hint = jsonSchema
    ? `\n\nRespond ONLY with a single valid JSON object conforming strictly to this JSON Schema (no markdown fences or extra text):\n${JSON.stringify(jsonSchema)}`
    : '\n\nRespond ONLY with a single valid JSON object with no markdown fences or extra text.';
  if (messages[0]?.role === 'system') {
    return [{ ...messages[0], content: `${messages[0].content}${hint}` }, ...messages.slice(1)];
  }
  return [{ role: 'system', content: hint.trim() }, ...messages];
}

function getSafeCloudBaseUrl(envName: string, defaultUrl: string): string {
  const raw = (process.env[envName] || '').trim();
  if (!raw) return defaultUrl;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') return defaultUrl;
    if (isBlockedHost(parsed.hostname)) {
      return defaultUrl;
    }
    return raw.replace(/\/+$/, '');
  } catch {
    return defaultUrl;
  }
}

export async function probeOllamaModels(timeoutMs = 1500): Promise<string[] | null> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: Array<{ name?: unknown }> };
    return (data.models || []).map((m) => m.name).filter((n): n is string => typeof n === 'string');
  } catch {
    return null;
  }
}

export async function probeLmStudioModels(timeoutMs = 1500): Promise<string[] | null> {
  try {
    const res = await fetch(`${LMSTUDIO_URL}/v1/models`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (data.data || []).map((m) => m.id).filter((n): n is string => typeof n === 'string');
  } catch {
    return null;
  }
}

export async function discoverEngines(): Promise<EngineStatus[]> {
  const [ollamaModels, lmStudioModels] = await Promise.all([probeOllamaModels(), probeLmStudioModels()]);

  return ENGINE_CATALOG.map((desc) => {
    if (desc.id === 'ollama') {
      const available = ollamaModels !== null;
      const detected = ollamaModels || [];
      const models = detected.length ? detected : desc.recommended_models;
      return {
        ...desc,
        available,
        detected_models: detected,
        models,
        status_text: available
          ? detected.length
            ? `已連線 · ${detected.length} 個模型`
            : '已連線 · 尚未下載模型'
          : '未偵測到本機服務',
        status_text_en: available
          ? detected.length
            ? `Connected · ${detected.length} model(s)`
            : 'Connected · No models downloaded'
          : 'Local service offline',
      };
    }

    if (desc.id === 'lmstudio') {
      const available = lmStudioModels !== null;
      const detected = lmStudioModels || [];
      const models = detected.length ? detected : desc.recommended_models;
      return {
        ...desc,
        available,
        detected_models: detected,
        models,
        status_text: available
          ? detected.length
            ? `已連線 · ${detected.length} 個模型`
            : '已連線 · 請於 LM Studio 載入模型'
          : '未偵測到本機服務',
        status_text_en: available
          ? detected.length
            ? `Connected · ${detected.length} model(s)`
            : 'Connected · Load a model in LM Studio'
          : 'Local service offline',
      };
    }

    if (desc.group === 'cli') {
      const detectedBinary = findExecutableOnPath(desc.cli_binaries || []);
      const available = Boolean(detectedBinary);
      return {
        ...desc,
        available,
        detected_binary: detectedBinary ? path.basename(detectedBinary) : null,
        detected_models: available ? desc.recommended_models : [],
        models: desc.recommended_models,
        status_text: available ? `已偵測本機 CLI（${path.basename(detectedBinary!)}）` : '尚未安裝本機 CLI',
        status_text_en: available ? `CLI detected (${path.basename(detectedBinary!)})` : 'CLI not found on PATH',
      };
    }

    // Cloud API
    const envVar = desc.env_var;
    const hasKey = Boolean(envVar && process.env[envVar]?.trim());
    return {
      ...desc,
      available: hasKey,
      detected_models: hasKey ? desc.recommended_models : [],
      models: desc.recommended_models,
      status_text: hasKey ? '已就緒（伺服器環境金鑰）' : `待設定伺服器環境變數 ${envVar}`,
      status_text_en: hasKey ? 'Ready (server key configured)' : `Set ${envVar} on server`,
    };
  });
}

// ============================================================
// Provider Implementations
// ============================================================

async function runOllamaChat(
  model: string,
  opts: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const payload: Record<string, unknown> = {
    model,
    messages: opts.messages,
    stream: false,
    options: {
      num_ctx: 8192,
      num_predict: opts.maxTokens ?? 1600,
      temperature: opts.temperature ?? 0.25,
    },
  };
  if (opts.jsonSchema) {
    payload.format = opts.jsonSchema;
  } else if (opts.expectJson) {
    payload.format = 'json';
  }
  if (model.startsWith('qwen3.') || model.startsWith('qwen3:')) {
    payload.think = false;
  }

  let res: Response;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message));
    if (isTimeout) {
      throw new LlmError(504, isEn() ? 'Ollama took too long to respond. Try a lighter model.' : 'Ollama 生成逾時，建議改用較輕量模型後再試。');
    }
    throw new LlmError(
      503,
      isEn()
        ? `Cannot reach local Ollama (${OLLAMA_URL}). Start Ollama or switch to another engine in Settings.`
        : `目前無法連線至本機 Ollama（${OLLAMA_URL}），請啟動服務或於「助教設定」切換其他模型引擎。`
    );
  }

  if (!res.ok) {
    throw new LlmError(res.status >= 500 ? 502 : res.status, isEn() ? `Ollama returned HTTP ${res.status}.` : `Ollama 服務回應異常（HTTP ${res.status}），請確認已下載模型「${model}」。`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const msg = data.message as { content?: string } | undefined;
  const text = typeof msg?.content === 'string' ? msg.content.trim() : '';
  if (!text) {
    throw new LlmError(502, isEn() ? 'Ollama returned an empty response.' : '模型回傳空白內容，請稍後再試一次。');
  }

  return {
    text,
    provider: 'ollama',
    model,
    prompt_tokens: typeof data.prompt_eval_count === 'number' ? data.prompt_eval_count : null,
    output_tokens: typeof data.eval_count === 'number' ? data.eval_count : null,
    done_reason: typeof data.done_reason === 'string' ? data.done_reason : undefined,
  };
}

async function runOpenAiCompatibleChat(params: {
  provider: ModelProvider;
  providerLabel: string;
  baseUrl: string;
  apiKey: string | null;
  model: string;
  opts: ChatCompletionOptions;
  extraHeaders?: Record<string, string>;
}): Promise<ChatCompletionResult> {
  const { provider, providerLabel, baseUrl, apiKey, model, opts, extraHeaders } = params;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...extraHeaders,
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const preparedMessages = withSchemaHint(opts.messages, opts.jsonSchema, opts.expectJson);
  const isOpenAiReasoning = provider === 'openai' && /^(o1|o3|o4)(?:$|-)/i.test(model);
  const body: Record<string, unknown> = {
    model,
    messages: preparedMessages,
    ...(isOpenAiReasoning
      ? { max_completion_tokens: opts.maxTokens ?? 1600 }
      : { temperature: opts.temperature ?? 0.25, max_tokens: opts.maxTokens ?? 1600 }),
  };

  if (opts.expectJson || opts.jsonSchema) {
    body.response_format = { type: 'json_object' };
  }

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message));
    if (isTimeout) {
      throw new LlmError(504, isEn() ? `${providerLabel} timed out.` : `${providerLabel} 回應逾時，請稍後再試。`);
    }
    throw new LlmError(
      503,
      isEn()
        ? `Cannot reach ${providerLabel}. Check service availability or switch engines in Settings.`
        : `目前無法連線至 ${providerLabel}，請確認服務狀態或於「助教設定」切換其他模型引擎。`
    );
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new LlmError(
        401,
        isEn()
          ? `${providerLabel} rejected the server API key. Check your environment configuration.`
          : `${providerLabel} 金鑰驗證未通過，請檢查伺服器環境變數設定。`
      );
    }
    if (res.status === 429) {
      throw new LlmError(429, isEn() ? `${providerLabel} rate limit reached. Try again shortly.` : `${providerLabel} 目前用量達上限，請稍後再試。`);
    }
    throw new LlmError(502, isEn() ? `${providerLabel} request failed (HTTP ${res.status}).` : `${providerLabel} 回應異常（HTTP ${res.status}），請確認模型名稱「${model}」是否可用。`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) {
    throw new LlmError(502, isEn() ? `${providerLabel} returned an empty response.` : `${providerLabel} 回傳空白內容，請再試一次。`);
  }

  return {
    text,
    provider,
    model,
    prompt_tokens: typeof data.usage?.prompt_tokens === 'number' ? data.usage.prompt_tokens : null,
    output_tokens: typeof data.usage?.completion_tokens === 'number' ? data.usage.completion_tokens : null,
    done_reason: data.choices?.[0]?.finish_reason,
  };
}

async function runGeminiChat(model: string, opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmError(
      503,
      isEn()
        ? 'GEMINI_API_KEY is not configured on the server.'
        : '伺服器尚未設定 GEMINI_API_KEY，請於環境變數設定後再使用 Gemini。'
    );
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const systemParts = opts.messages.filter((m) => m.role === 'system').map((m) => m.content);
  const conversation = opts.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  const config: Record<string, unknown> = {
    abortSignal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
  };
  if (systemParts.length) {
    config.systemInstruction = systemParts.join('\n\n');
  }
  if (opts.jsonSchema) {
    config.responseMimeType = 'application/json';
    config.responseJsonSchema = opts.jsonSchema;
  } else if (opts.expectJson) {
    config.responseMimeType = 'application/json';
  }

  try {
    const response = await ai.models.generateContent({
      model,
      contents: conversation.length ? conversation : [{ role: 'user', parts: [{ text: '' }] }],
      config,
    });
    const text = (response.text ?? '').trim();
    if (!text) {
      throw new LlmError(502, isEn() ? 'Gemini returned an empty response.' : 'Gemini 回傳空白內容，請稍後再試一次。');
    }
    const usage = response.usageMetadata;
    return {
      text,
      provider: 'gemini',
      model,
      prompt_tokens: typeof usage?.promptTokenCount === 'number' ? usage.promptTokenCount : null,
      output_tokens: typeof usage?.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : null,
    };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message));
    if (isTimeout) {
      throw new LlmError(504, isEn() ? 'Gemini timed out. Please try again.' : 'Gemini 回應逾時，請稍後再試。');
    }
    const msg = err instanceof Error ? err.message : '';
    if (/403|PERMISSION_DENIED|API_KEY_INVALID|401/i.test(msg)) {
      throw new LlmError(
        401,
        isEn()
          ? 'Gemini API key was rejected. Check GEMINI_API_KEY in Settings > Secrets.'
          : 'Gemini 金鑰驗證失敗，請於 Settings > Secrets 確認 GEMINI_API_KEY。'
      );
    }
    if (/429|RESOURCE_EXHAUSTED/i.test(msg)) {
      throw new LlmError(
        429,
        isEn()
          ? 'Gemini quota limit reached. Switch to gemini-4-hydrogen or check billing in Settings > Secrets.'
          : 'Gemini 配額已達上限，建議改選 gemini-4-hydrogen 或確認 API 配額後再試。'
      );
    }
    if (/404|NOT_FOUND/i.test(msg)) {
      throw new LlmError(
        404,
        isEn()
          ? `Gemini model "${model}" is unavailable. Try gemini-4-hydrogen.`
          : `Gemini 模型「${model}」目前不可用，請改選 gemini-4-hydrogen。`
      );
    }
    throw new LlmError(
      502,
      isEn() ? 'Gemini request failed. Please try again shortly.' : 'Gemini 暫時無法回應，請稍後再試一次。'
    );
  }
}

async function runAnthropicChat(model: string, opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new LlmError(
      503,
      isEn()
        ? 'ANTHROPIC_API_KEY is not configured on the server.'
        : '伺服器尚未設定 ANTHROPIC_API_KEY，請於環境變數設定後再使用 Claude。'
    );
  }

  const prepared = withSchemaHint(opts.messages, opts.jsonSchema, opts.expectJson);
  const systemText = prepared
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const convo = prepared
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

  const body: Record<string, unknown> = {
    model,
    max_tokens: opts.maxTokens ?? 1600,
    messages: convo.length ? convo : [{ role: 'user', content: '' }],
  };
  if (systemText) body.system = systemText;
  if (typeof opts.temperature === 'number') body.temperature = opts.temperature;

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000),
    });
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message));
    if (isTimeout) {
      throw new LlmError(504, isEn() ? 'Claude API timed out.' : 'Claude API 回應逾時，請稍後再試。');
    }
    throw new LlmError(503, isEn() ? 'Cannot reach Claude API.' : '目前無法連線至 Claude API，請稍後再試。');
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new LlmError(401, isEn() ? 'Anthropic API key is invalid.' : 'Claude API 金鑰驗證失敗，請檢查 ANTHROPIC_API_KEY。');
    }
    throw new LlmError(502, isEn() ? `Claude API failed (HTTP ${res.status}).` : `Claude API 回應異常（HTTP ${res.status}）。`);
  }

  const data = (await res.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
    stop_reason?: string;
  };
  const text = (data.content || [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new LlmError(502, isEn() ? 'Claude returned an empty response.' : 'Claude 回傳空白內容，請再試一次。');
  }

  return {
    text,
    provider: 'claude',
    model,
    prompt_tokens: typeof data.usage?.input_tokens === 'number' ? data.usage.input_tokens : null,
    output_tokens: typeof data.usage?.output_tokens === 'number' ? data.usage.output_tokens : null,
    done_reason: data.stop_reason,
  };
}

function flattenMessagesForCli(
  messages: ChatMessage[],
  jsonSchema?: Record<string, unknown>,
  expectJson?: boolean
): string {
  const sections: string[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      sections.push(`[System Instructions]\n${m.content}`);
    } else if (m.role === 'assistant') {
      sections.push(`[Assistant]\n${m.content}`);
    } else {
      sections.push(`[User]\n${m.content}`);
    }
  }
  if (jsonSchema) {
    sections.push(
      `[Output Format]\nReturn ONLY a single valid JSON object conforming strictly to this JSON Schema (no markdown fences or commentary):\n${JSON.stringify(jsonSchema)}`
    );
  } else if (expectJson) {
    sections.push('[Output Format]\nReturn ONLY a single valid JSON object with no markdown fences or extra commentary.');
  }
  return sections.join('\n\n');
}

function buildMinimalCliEnv(): NodeJS.ProcessEnv {
  // Pass only standard OS/user session variables; never leak unrelated cloud API keys to child CLIs.
  const allowKeys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'SYSTEMROOT',
  ];
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const key of allowKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function runLocalCli(
  provider: 'antigravity-cli' | 'claude-code' | 'codex-cli',
  model: string,
  opts: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const desc = getEngineDescriptor(provider);
  const binPath = findExecutableOnPath(desc.cli_binaries || []);
  if (!binPath) {
    return Promise.reject(
      new LlmError(
        503,
        isEn()
          ? `${desc.name} is not installed or not found on PATH. Install it locally or switch engines in Settings.`
          : `這台環境未偵測到本機 ${desc.name_zh}，請確認已安裝並加入 PATH，或於「助教設定」改選其他模型引擎。`
      )
    );
  }

  const promptText = flattenMessagesForCli(opts.messages, opts.jsonSchema, Boolean(opts.expectJson || opts.jsonSchema));
  const useModelFlag = model && model !== 'default' && isSafeModelName(model);

  let args: string[];
  if (provider === 'claude-code') {
    // Disable file/shell agent tools for pure text generation from untrusted study documents.
    args = ['-p', '--output-format', 'text', '--tools', ''];
    if (useModelFlag) args.push('--model', model);
  } else if (provider === 'codex-cli') {
    args = ['exec', '-'];
    if (useModelFlag) args.push('-m', model);
  } else {
    // Antigravity CLI non-interactive prompt via stdin
    args = ['prompt'];
    if (useModelFlag) args.push('--model', model);
  }

  const timeoutMs = opts.timeoutMs ?? 90_000;

  return new Promise((resolve, reject) => {
    // Strictly shell: false, isolated tmpdir cwd, minimal env, and prompt passed via stdin.
    const child = spawn(binPath, args, {
      shell: false,
      cwd: os.tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildMinimalCliEnv(),
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_CAPTURE = 512 * 1024;

    const cleanupTimers = () => {
      clearTimeout(timer);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already exited
        }
      }, 3000);
      reject(
        new LlmError(
          504,
          isEn() ? `${desc.name} timed out.` : `${desc.name_zh} 執行逾時，請稍後再試。`
        )
      );
    }, timeoutMs);

    child.stdin.on('error', () => {
      // Prevent unhandled EPIPE if the child exits before stdin finishes writing.
    });

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE) {
        stdout += chunk.toString('utf-8');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 32 * 1024) {
        stderr += chunk.toString('utf-8');
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      console.warn(`[llm] Failed to spawn ${desc.name} (${err.code || err.message})`);
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(
        new LlmError(
          503,
          isEn() ? `Could not start ${desc.name}.` : `無法啟動本機 ${desc.name_zh}，請確認工具狀態。`
        )
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      const output = stdout.trim();
      if (code !== 0 || !output) {
        const hint = stderr.trim().slice(0, 140);
        reject(
          new LlmError(
            502,
            isEn()
              ? `${desc.name} exited with an error.${hint ? ` (${hint})` : ''}`
              : `${desc.name_zh} 執行未完成，請確認已完成本機登入與授權後再試。`
          )
        );
        return;
      }
      resolve({
        text: output,
        provider,
        model,
        prompt_tokens: null,
        output_tokens: null,
      });
    });

    child.stdin.write(promptText, 'utf-8');
    child.stdin.end();
  });
}

// ============================================================
// Unified Chat Dispatcher
// ============================================================

export async function runChatCompletion(opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const provider: ModelProvider = opts.provider || store.settings.provider || 'ollama';
  const desc = getEngineDescriptor(provider);
  const model = opts.model || store.settings.model || desc.default_model;

  switch (provider) {
    case 'ollama':
      return runOllamaChat(model, opts);

    case 'lmstudio':
      return runOpenAiCompatibleChat({
        provider: 'lmstudio',
        providerLabel: 'LM Studio',
        baseUrl: `${LMSTUDIO_URL}/v1`,
        apiKey: process.env.LMSTUDIO_API_KEY?.trim() || null,
        model,
        opts,
      });

    case 'antigravity-cli':
    case 'claude-code':
    case 'codex-cli':
      return runLocalCli(provider, model, opts);

    case 'gemini':
      return runGeminiChat(model, opts);

    case 'openai': {
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) {
        throw new LlmError(
          503,
          isEn() ? 'OPENAI_API_KEY is not configured on the server.' : '伺服器尚未設定 OPENAI_API_KEY，請設定環境變數後再使用 OpenAI。'
        );
      }
      return runOpenAiCompatibleChat({
        provider: 'openai',
        providerLabel: 'OpenAI',
        baseUrl: getSafeCloudBaseUrl('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        apiKey,
        model,
        opts,
      });
    }

    case 'claude':
      return runAnthropicChat(model, opts);

    case 'opencode': {
      const apiKey = process.env.OPENCODE_API_KEY?.trim();
      if (!apiKey) {
        throw new LlmError(
          503,
          isEn() ? 'OPENCODE_API_KEY is not configured on the server.' : '伺服器尚未設定 OPENCODE_API_KEY，請設定環境變數後再使用 OpenCode。'
        );
      }
      return runOpenAiCompatibleChat({
        provider: 'opencode',
        providerLabel: 'OpenCode',
        baseUrl: getSafeCloudBaseUrl('OPENCODE_BASE_URL', 'https://opencode.ai/zen/v1'),
        apiKey,
        model,
        opts,
      });
    }

    case 'deepseek': {
      const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
      if (!apiKey) {
        throw new LlmError(
          503,
          isEn() ? 'DEEPSEEK_API_KEY is not configured on the server.' : '伺服器尚未設定 DEEPSEEK_API_KEY，請設定環境變數後再使用 DeepSeek。'
        );
      }
      return runOpenAiCompatibleChat({
        provider: 'deepseek',
        providerLabel: 'DeepSeek',
        baseUrl: getSafeCloudBaseUrl('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
        apiKey,
        model,
        opts,
      });
    }

    case 'openrouter': {
      const apiKey = process.env.OPENROUTER_API_KEY?.trim();
      if (!apiKey) {
        throw new LlmError(
          503,
          isEn() ? 'OPENROUTER_API_KEY is not configured on the server.' : '伺服器尚未設定 OPENROUTER_API_KEY，請設定環境變數後再使用 OpenRouter。'
        );
      }
      return runOpenAiCompatibleChat({
        provider: 'openrouter',
        providerLabel: 'OpenRouter',
        baseUrl: getSafeCloudBaseUrl('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
        apiKey,
        model,
        opts,
        extraHeaders: { 'X-Title': 'BIIBO Personal Tutor' },
      });
    }
  }
}

export async function testEngineConnection(provider: ModelProvider, model: string): Promise<{ ok: boolean; latency_ms: number; preview: string }> {
  const started = Date.now();
  const res = await runChatCompletion({
    provider,
    model,
    messages: [
      { role: 'system', content: 'Reply with a single word: OK' },
      { role: 'user', content: 'ping' },
    ],
    maxTokens: 16,
    temperature: 0,
    timeoutMs: 20_000,
  });
  return {
    ok: true,
    latency_ms: Date.now() - started,
    preview: res.text.slice(0, 60),
  };
}
