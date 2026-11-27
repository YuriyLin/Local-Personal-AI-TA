import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { modelCapabilities } from './runtime.js';
import { CLI_REASONING_LEVELS, CliOptions, CliProvider, EngineGroup, ModelProvider, isCliProvider, store } from './store.js';

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
  contextTokens?: number;
  canDisableThinking?: boolean | null;
  temperature?: number;
  timeoutMs?: number;
  cloudKey?: string;
  cliOptions?: CliOptions;
}

export interface ChatCompletionResult {
  text: string;
  provider: ModelProvider;
  model: string;
  prompt_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens?: number | null;
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
  reasoning_levels?: readonly string[];
  model_capabilities?: CliModelCatalog['model_capabilities'];
}

interface CliModelCatalog {
  models: string[];
  model_capabilities: Record<string, { reasoning_levels: string[]; fast?: boolean }>;
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
    recommended_models: ['default'],
    env_var: null,
    cli_binaries: ['agy', 'antigravity'],
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
    recommended_models: ['default'],
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
    allow_custom_model: true,
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
function resolveCli(provider: CliProvider): { bin: string; leadingArgs: string[]; label: string } | null {
  const desc = getEngineDescriptor(provider);
  const envPath = process.env.PATH || '';
  const dirs = envPath.split(path.delimiter).map(dir => dir.trim().replace(/^"|"$/g, '')).filter(path.isAbsolute);
  const windows = process.platform === 'win32';
  if (windows && provider === 'antigravity-cli' && process.env.LOCALAPPDATA) {
    dirs.push(path.join(process.env.LOCALAPPDATA, 'agy', 'bin'));
  }
  if (windows && provider === 'claude-code') dirs.push(path.join(os.homedir(), '.local', 'bin'));
  if (windows && provider === 'codex-cli' && process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
  for (const dir of dirs) {
    for (const binary of desc.cli_binaries || []) {
      const candidate = path.join(dir, binary + (windows ? '.exe' : ''));
      if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
        return { bin: candidate, leadingArgs: [], label: path.basename(candidate) };
      }
    }
    if (windows && provider === 'codex-cli') {
      const entry = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
      if (fs.existsSync(path.join(dir, 'codex.cmd')) && fs.statSync(entry, { throwIfNoEntry: false })?.isFile()) {
        return { bin: process.execPath, leadingArgs: [entry], label: 'codex (npm)' };
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
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash &&
      !isBlockedHost(parsed.hostname)) {
      return raw.replace(/\/+$/, '');
    }
  } catch { /* Report invalid configuration without displaying credentials or URLs. */ }
  throw new LlmError(422, isEn() ? `Invalid HTTPS address in ${envName}.` : `${envName} 的 HTTPS 位址無效。`);
}

const CLOUD_COMPAT = {
  openai: ['OPENAI_BASE_URL', 'https://api.openai.com/v1'],
  opencode: ['OPENCODE_BASE_URL', 'https://opencode.ai/zen/v1'],
  deepseek: ['DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'],
  openrouter: ['OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'],
} as const;
function compatibleBaseUrl(provider: keyof typeof CLOUD_COMPAT): string {
  const [variable, standardUrl] = CLOUD_COMPAT[provider];
  return getSafeCloudBaseUrl(variable, standardUrl);
}
const CLOUD_KEY_FILE = path.join(process.cwd(), 'data', 'provider-keys.json');
const anthropicApiBase = () => getSafeCloudBaseUrl('ANTHROPIC_BASE_URL', 'https://api.anthropic.com').replace(/\/v1$/, '') + '/v1';

function readCloudKeys(): Partial<Record<ModelProvider, string>> {
  try {
    return JSON.parse(fs.readFileSync(CLOUD_KEY_FILE, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}

export function parseCloudKey(value: unknown): string {
  if (value === undefined || value === '') return '';
  if (typeof value === 'string' && value.length <= 1024 && /^[\x21-\x7E]*$/.test(value.trim())) return value.trim();
  throw new LlmError(422, isEn() ? 'Invalid API key format.' : 'API 金鑰格式無效。');
}

export function saveCloudKey(provider: ModelProvider, key: string): void {
  if (getEngineDescriptor(provider).group !== 'cloud') {
    throw new LlmError(422, isEn() ? 'Choose a cloud provider before saving a key.' : '請選擇雲端服務後再儲存金鑰。');
  }
  const keys = readCloudKeys();
  keys[provider] = key;
  fs.mkdirSync(path.dirname(CLOUD_KEY_FILE), { recursive: true });
  const temporary = `${CLOUD_KEY_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(keys), { mode: 0o600 });
  fs.renameSync(temporary, CLOUD_KEY_FILE);
}

function configuredCloudKey(provider: ModelProvider): string {
  const envVar = getEngineDescriptor(provider).env_var;
  if (!envVar) return '';
  const saved = readCloudKeys()[provider];
  return (typeof saved === 'string' && saved) || process.env[envVar]?.trim() || '';
}

export async function geminiTokenLimits(model: string): Promise<{ input_limit: number | null; output_limit: number | null }> {
  const unknown = { input_limit: null, output_limit: null };
  const key = configuredCloudKey('gemini');
  if (!key) return unknown;
  try {
    const name = model.replace(/^models\//, '');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(name)}`, {
      headers: { 'x-goog-api-key': key }, redirect: 'manual', signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return unknown;
    const data = await response.json() as { inputTokenLimit?: unknown; outputTokenLimit?: unknown };
    const positive = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
    return { input_limit: positive(data.inputTokenLimit), output_limit: positive(data.outputTokenLimit) };
  } catch { return unknown; }
}

function requireCloudKey(provider: ModelProvider, draft?: string): string {
  const key = draft || configuredCloudKey(provider);
  if (key) return key;
  throw new LlmError(422, isEn() ? 'Enter an API key for this provider.' : '請輸入此雲端服務的 API 金鑰。');
}

const ANTIGRAVITY_EFFORT_SUFFIX = /-(low|medium|high|xhigh|max)$/;

export function parseCodexModels(raw: string): CliModelCatalog {
  const { models } = JSON.parse(raw) ?? {};
  const entries: Array<[string, CliModelCatalog['model_capabilities'][string]]> = [];
  if (Array.isArray(models)) {
    const levels: readonly string[] = CLI_REASONING_LEVELS['codex-cli'];
    for (const model of models) {
      if (model?.visibility !== 'list' || !isSafeModelName(model.slug) || model.slug === 'default') continue;
      const supported = model.supported_reasoning_levels;
      const tiers = model.service_tiers;
      const speeds = model.additional_speed_tiers;
      entries.push([model.slug, {
        reasoning_levels: Array.isArray(supported)
          ? supported.map(level => level?.effort).filter(effort => levels.includes(effort))
          : [...levels],
        fast: Array.isArray(tiers) || Array.isArray(speeds)
          ? (Array.isArray(tiers) && tiers.some(tier => tier?.id === 'priority' || tier?.id === 'fast'))
            || (Array.isArray(speeds) && speeds.includes('fast'))
          : undefined,
      }]);
    }
  }
  const capabilities = new Map(entries);
  return { models: ['default', ...capabilities.keys()], model_capabilities: Object.fromEntries(capabilities) };
}

function cachedCodexModels(): CliModelCatalog {
  try {
    const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    return parseCodexModels(fs.readFileSync(path.join(codexHome, 'models_cache.json'), 'utf8'));
  } catch {
    return { models: ['default'], model_capabilities: {} };
  }
}

export async function discoverCliModels(provider: 'codex-cli' | 'antigravity-cli', refresh = false): Promise<CliModelCatalog> {
  if (provider === 'codex-cli') {
    const cached = cachedCodexModels();
    if (!refresh && cached.models.length > 1) return cached;
    try {
      const result = await invokeCli(provider, ['debug', 'models'], '', 12_000, 4 * 1024 * 1024);
      if (result.code === 0) {
        const catalog = parseCodexModels(result.stdout);
        if (catalog.models.length > 1) return catalog;
      }
    } catch { /* Older versions can use their on-disk catalog. */ }
    return cached;
  }
  const { stdout, stderr, code } = await invokeCli(provider, ['models'], '', 20_000);
  if (code !== 0) throw cliFailure(provider, stdout + '\n' + stderr);
  const names = new Set(['default']);
  const efforts = new Map<string, Set<string>>();
  for (const line of stdout.split(/\r?\n/)) {
    const id = line.split('\t', 1)[0].trim();
    if (!isSafeModelName(id)) continue;
    const variant = ANTIGRAVITY_EFFORT_SUFFIX.exec(id);
    const model = variant ? id.slice(0, variant.index) : id;
    names.add(model);
    if (variant) {
      const levels = efforts.get(model) || new Set();
      levels.add(variant[1]);
      efforts.set(model, levels);
    }
  }
  return {
    models: [...names],
    model_capabilities: Object.fromEntries([...efforts].map(([model, levels]) => [
      model, { reasoning_levels: CLI_REASONING_LEVELS[provider].filter(level => levels.has(level)) },
    ])),
  };
}

export async function listProviderModels(provider: ModelProvider, draftKey?: string): Promise<string[]> {
  if (provider === 'antigravity-cli' || provider === 'codex-cli') {
    return (await discoverCliModels(provider)).models;
  }
  if (getEngineDescriptor(provider).group !== 'cloud') return getEngineDescriptor(provider).recommended_models;
  const key = requireCloudKey(provider, draftKey);
  let url: string;
  let headers: Record<string, string>;
  if (provider === 'gemini') {
    url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100';
    headers = { 'x-goog-api-key': key };
  } else if (provider === 'claude') {
    url = `${anthropicApiBase()}/models?limit=100`;
    headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  } else {
    url = `${compatibleBaseUrl(provider as keyof typeof CLOUD_COMPAT)}/models`;
    headers = { Authorization: `Bearer ${key}` };
  }
  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new LlmError(503, isEn() ? 'Could not reach the cloud model list.' : '無法連線取得雲端模型清單。');
  }
  if (response.status === 401 || response.status === 403) {
    throw new LlmError(401, isEn() ? 'The provider rejected the API key.' : '雲端服務拒絕此 API 金鑰。');
  }
  if (!response.ok) throw new LlmError(502, isEn() ? 'The provider could not list models.' : '雲端服務暫時無法列出模型。');
  const raw = await response.json() as {
    data?: Array<{ id?: unknown }>;
    models?: Array<{ name?: unknown; supportedGenerationMethods?: string[] }>;
  };
  const models = provider === 'gemini'
    ? raw.models?.filter(model => model.supportedGenerationMethods?.includes('generateContent')).map(model =>
      typeof model.name === 'string' ? model.name.replace(/^models\//, '') : '')
    : raw.data?.map(model => model.id);
  return [...new Set((models || []).filter(isSafeModelName))].sort().slice(0, 400);
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

export async function discoverEngines(refresh = false): Promise<EngineStatus[]> {
  const [ollamaModels, lmStudioModels, codexCatalog] = await Promise.all([
    probeOllamaModels(), probeLmStudioModels(),
    resolveCli('codex-cli') ? discoverCliModels('codex-cli', refresh) : null,
  ]);

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

    if (isCliProvider(desc.id)) {
      const detected = resolveCli(desc.id);
      const detectedBinary = detected?.label || null;
      const available = Boolean(detectedBinary);
      const catalog = desc.id === 'codex-cli' ? codexCatalog : null;
      return {
        ...desc,
        available,
        detected_binary: detectedBinary,
        detected_models: catalog?.models.slice(1) || [],
        models: catalog?.models || desc.recommended_models,
        model_capabilities: catalog?.model_capabilities,
        reasoning_levels: CLI_REASONING_LEVELS[desc.id],
        status_text: available ? `已偵測 ${detectedBinary} · 尚未測試` : '尚未安裝本機 CLI',
        status_text_en: available ? `Detected ${detectedBinary} · Untested` : 'CLI not found on PATH',
      };
    }

    // Cloud API
    const envVar = desc.env_var;
    const hasKey = Boolean(envVar && configuredCloudKey(desc.id));
    return {
      ...desc,
      available: hasKey,
      detected_models: [],
      models: desc.recommended_models,
      status_text: hasKey ? '已設定金鑰 · 尚未測試' : '待設定 API 金鑰',
      status_text_en: hasKey ? 'Key configured · Untested' : 'API key required',
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
      num_ctx: opts.contextTokens ?? 8192,
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
    const supported = opts.canDisableThinking === undefined
      ? (await modelCapabilities('ollama', model)).can_disable_thinking : opts.canDisableThinking;
    if (supported === true) payload.think = false;
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
    const detail = await res.json().catch(() => null) as { error?: unknown } | null;
    if (typeof detail?.error === 'string' && /MLX runtime is not available/i.test(detail.error)) {
      throw new LlmError(502, isEn()
        ? 'This model requires the unavailable MLX runtime. On Windows, select a GGUF model such as qwen3.5:4b-q4_K_M or qwen3.5:9b-q4_K_M.'
        : '此模型需要目前無法使用的 MLX runtime。Windows 請選用 GGUF 版本，例如 qwen3.5:4b-q4_K_M 或 qwen3.5:9b-q4_K_M。');
    }
    throw new LlmError(res.status >= 500 ? 502 : res.status, isEn() ? `Ollama returned HTTP ${res.status}. Check the model and Ollama service.` : `Ollama 服務回應異常（HTTP ${res.status}），請檢查模型與 Ollama 服務。`);
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
  const isOpenAiReasoning = provider === 'openai' && /^(o[1-9]|gpt-5|gpt-6)(?:$|[.-])/i.test(model);
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
  const apiKey = requireCloudKey('gemini', opts.cloudKey);

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
  if (typeof opts.maxTokens === 'number') {
    config.maxOutputTokens = opts.maxTokens;
    config.automaticContinuation = false;
  }
  if (typeof opts.temperature === 'number') config.temperature = opts.temperature;
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
      reasoning_tokens: typeof usage?.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : null,
      done_reason: response.candidates?.[0]?.finishReason === 'MAX_TOKENS' ? 'length' : response.candidates?.[0]?.finishReason,
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
  const apiKey = requireCloudKey('claude', opts.cloudKey);

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
    res = await fetch(`${anthropicApiBase()}/messages`, {
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
    done_reason: data.stop_reason === 'max_tokens' ? 'length' : data.stop_reason,
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

function buildMinimalCliEnv(provider: CliProvider): NodeJS.ProcessEnv {
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
    'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS',
    'SYSTEMROOT', 'COMSPEC', 'PATHEXT',
  ];
  if (provider === 'claude-code') {
    allowKeys.push('ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN');
  }
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const key of allowKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function invokeCli(provider: CliProvider, args: string[], input: string, timeoutMs: number, stdoutLimit = 512 * 1024): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const desc = getEngineDescriptor(provider);
  const executable = resolveCli(provider);
  if (!executable) {
    throw new LlmError(503, isEn() ? `Install ${desc.name} locally and refresh detection.` : `找不到 ${desc.name_zh}。請安裝後重新偵測。`);
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'biibo-cli-'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable.bin, [...executable.leadingArgs, ...args], {
      cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: buildMinimalCliEnv(provider),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new LlmError(504, isEn() ? `${desc.name} timed out.` : `${desc.name_zh} 執行逾時，請確認登入與連線。`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-stdoutLimit); });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-32 * 1024); });
    child.stdin.on('error', () => { /* The CLI can exit before it finishes reading stdin. */ });
    child.on('error', () => {
      reject(new LlmError(503, isEn() ? `Could not start ${desc.name}.` : `無法啟動 ${desc.name_zh}，請確認安裝狀態。`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      try { fs.rmdirSync(cwd); } catch { /* Leave files created by the CLI in its temporary directory. */ }
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(input, 'utf8');
  });
}

export function parseCliReply(provider: CliProvider, stdout: string): string {
  if (provider === 'codex-cli') {
    let latest = '';
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'turn.failed') return '';
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
          latest = event.item.text.trim();
        }
      } catch { /* Ignore progress and other non-JSON lines. */ }
    }
    return latest;
  }
  try {
    const reply = parseJsonFromLlm<{ is_error?: boolean; subtype?: string; result?: unknown; status?: string; response?: unknown }>(stdout);
    if (provider === 'antigravity-cli') return reply.status === 'SUCCESS' && typeof reply.response === 'string' ? reply.response.trim() : '';
    return !reply.is_error && (!reply.subtype || reply.subtype === 'success') && typeof reply.result === 'string' ? reply.result.trim() : '';
  } catch {
    return '';
  }
}

function cliFailure(provider: CliProvider, detail: string): LlmError {
  const name = getEngineDescriptor(provider).name;
  if (/not logged|login required|unauthenticated|unauthorized|sign in|log in/i.test(detail)) {
    return new LlmError(401, isEn() ? `Sign in to ${name} in your terminal, then retry.` : `請先在終端機登入 ${name} 再測試。`);
  }
  if (/quota|rate.limit|usage limit/i.test(detail)) {
    return new LlmError(429, isEn() ? `${name} reached its usage limit.` : `${name} 已達使用量限制。`);
  }
  if (/unknown model|model.*(?:not found|not available|not supported)|invalid model/i.test(detail)) {
    return new LlmError(422, isEn() ? `Select an available model for ${name}, or use the CLI default.`
      : `請為 ${name} 選擇可用模型，或使用 CLI 預設模型。`);
  }
  return new LlmError(502, isEn() ? `${name} did not return a response. Check its version and login in your terminal.`
    : `${name} 未回傳模型回覆。請在終端機確認版本與登入狀態。`);
}

export function cliGenerationArgs(provider: CliProvider, model: string, options: CliOptions = {}): string[] {
  const useModel = model !== 'default' && isSafeModelName(model);
  let args: string[];
  if (provider === 'claude-code') {
    args = ['--print', '--output-format', 'json', '--tools', '', '--strict-mcp-config', '--mcp-config',
      '{"mcpServers":{}}', '--disable-slash-commands', '--no-session-persistence'];
    if (useModel) args.push('--model', model);
    if (options.reasoning_effort) args.push('--effort', options.reasoning_effort);
  } else if (provider === 'codex-cli') {
    args = ['-a', 'never', '--disable', 'shell_tool', '--disable', 'apps', '--disable', 'plugins', '-c', 'mcp_servers={}'];
    if (options.reasoning_effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(options.reasoning_effort)}`);
    if (options.service_tier) args.push('-c', `service_tier=${JSON.stringify(options.service_tier)}`);
    args.push('exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '--json');
    if (useModel) args.push('--model', model);
    args.push('-');
  } else {
    args = ['--output-format', 'json', '--mode', 'plan', '--sandbox'];
    const variant = useModel ? ANTIGRAVITY_EFFORT_SUFFIX.exec(model) : null;
    if (useModel) {
      args.push('--model', variant ? model.slice(0, variant.index) : model);
    }
    const effort = options.reasoning_effort || variant?.[1];
    if (effort) args.push('--effort', effort);
  }
  return args;
}

async function runLocalCli(provider: CliProvider, model: string, opts: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const prompt = flattenMessagesForCli(opts.messages, opts.jsonSchema, Boolean(opts.expectJson || opts.jsonSchema));
  const args = cliGenerationArgs(provider, model, opts.cliOptions ?? store.settings.cli_options?.[provider]);
  const { stdout, stderr, code } = await invokeCli(provider, args, prompt, opts.timeoutMs ?? 90_000);
  const text = code === 0 ? parseCliReply(provider, stdout) : '';
  if (!text) throw cliFailure(provider, stdout + '\n' + stderr);
  return { text, provider, model, prompt_tokens: null, output_tokens: null };
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

    case 'claude':
      return runAnthropicChat(model, opts);

    case 'openai':
    case 'opencode':
    case 'deepseek':
    case 'openrouter':
      return runOpenAiCompatibleChat({
        provider,
        providerLabel: desc.name,
        baseUrl: compatibleBaseUrl(provider),
        apiKey: requireCloudKey(provider, opts.cloudKey),
        model,
        opts,
        extraHeaders: provider === 'openrouter' ? { 'X-Title': 'BIIBO Personal Tutor' } : undefined,
      });
  }
}

export async function testEngineConnection(provider: ModelProvider, model: string, cloudKey?: string, cliOptions?: CliOptions): Promise<{ ok: boolean; latency_ms: number; preview: string }> {
  const started = Date.now();
  const res = await runChatCompletion({
    provider,
    model,
    messages: [
      { role: 'system', content: 'Reply with a single word: OK' },
      { role: 'user', content: 'ping' },
    ],
    maxTokens: 128,
    temperature: 0,
    timeoutMs: getEngineDescriptor(provider).group === 'cli' ? 65_000 : 25_000,
    cloudKey,
    cliOptions,
  });
  return {
    ok: true,
    latency_ms: Date.now() - started,
    preview: res.text.slice(0, 60),
  };
}
