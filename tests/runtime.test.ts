import assert from 'node:assert/strict';
import test from 'node:test';
import { autoTopK, DEFAULT_RUNTIME, inputByteBudget, modelCapabilities, readRuntime, requestByteEstimate, resolveRuntime } from '../src/runtime.js';
import { geminiTokenLimits, runChatCompletion } from '../src/llm.js';
import { store } from '../src/store.js';
import type { DocumentRecord } from '../src/store.js';
import { expandTextEvidence, generateAnswer, retrieve, retrieveWithRetry } from '../src/tutor.js';
import type { EvidenceRow } from '../src/tutor.js';

test('runtime validates input and clamps to detected model limit', () => {
  const settings = { mode: 'advanced' as const, context: 8192, output: 1024, top_k: 6, temperature: 0.3 };
  assert.deepEqual(readRuntime(settings), settings);
  assert.equal(readRuntime({ ...settings, top_k: 0 }), null);
  assert.equal(readRuntime({ ...settings, output: 5000 }), null);
  assert.equal(readRuntime({ ...settings, temperature: NaN }), null);
  assert.equal(resolveRuntime(settings, 2048).context, 2048);
  assert.equal(resolveRuntime(settings, 2048).output, 1024);
  assert.equal(resolveRuntime({ ...settings, mode: 'auto' }, null).context, DEFAULT_RUNTIME.context);
  assert.ok(inputByteBudget(4096, 512) < 4096 - 512);
  assert.equal(autoTopK(2048, 'short'), 2);
  assert.equal(autoTopK(4096, 'short'), 3);
  assert.equal(autoTopK(4096, 'a'.repeat(121)), 4);
  assert.equal(autoTopK(32768, 'short'), 5);
  assert.ok(requestByteEstimate([{ role: 'user', content: 'text' }], { type: 'object' }) > requestByteEstimate([{ role: 'user', content: 'text' }], {}));
  const limited = resolveRuntime(settings, null, { input_limit: 1400, output_limit: 256 });
  assert.equal(limited.output, 256);
  assert.ok(inputByteBudget(limited.context, limited.output, limited.input_limit) < 1400);
});

test('Gemini metadata keeps input and output limits separate', async t => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'test-only';
  try {
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.match(String(url), /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\//);
      assert.equal((options?.headers as Record<string, string>)['x-goog-api-key'], 'test-only');
      return Response.json({ inputTokenLimit: 8192, outputTokenLimit: 1024 });
    });
    assert.deepEqual(await geminiTokenLimits('test-model'), { input_limit: 8192, output_limit: 1024 });
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});

test('Gemini SDK receives the requested generation settings', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    assert.equal(request.generationConfig.maxOutputTokens, 768);
    assert.equal(request.generationConfig.temperature, 0.4);
    return Response.json({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 5, thoughtsTokenCount: 20 } });
  });
  const result = await runChatCompletion({ provider: 'gemini', model: 'test-model', cloudKey: 'test-only', messages: [{ role: 'user', content: 'hello' }], maxTokens: 768, temperature: 0.4 });
  assert.equal(result.text, 'ok');
  assert.equal(result.prompt_tokens, 40);
  assert.equal(result.output_tokens, 5);
  assert.equal(result.reasoning_tokens, 20);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('Gemini output limit does not silently continue generation', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({
    candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
  }));
  const result = await runChatCompletion({ provider: 'gemini', model: 'test-model', cloudKey: 'test-only', messages: [{ role: 'user', content: 'hello' }], maxTokens: 128 });
  assert.equal(result.done_reason, 'length');
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('Anthropic output limit is reported as truncation', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    assert.equal(request.max_tokens, 128);
    return Response.json({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' });
  });
  const result = await runChatCompletion({ provider: 'claude', model: 'test-model', cloudKey: 'test-only', messages: [{ role: 'user', content: 'hello' }], maxTokens: 128 });
  assert.equal(result.done_reason, 'length');
});

test('Ollama context detection uses architecture metadata and unknown providers remain unknown', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ model_info: { 'general.architecture': 'test', 'test.context_length': 8192, 'vision.context_length': 99 } }));
  assert.deepEqual(await modelCapabilities('ollama', 'example'), { context_limit: 8192, can_chat: null, can_disable_thinking: null });
  assert.deepEqual(await modelCapabilities('openai', 'example'), { context_limit: null, can_chat: null, can_disable_thinking: null });
});

test('small detected model limits are never treated as unknown', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ model_info: { 'general.architecture': 'test', 'test.context_length': 512 } }));
  const result = await modelCapabilities('ollama', 'example');
  assert.equal(result.context_limit, 512);
  assert.equal(resolveRuntime(DEFAULT_RUNTIME, result.context_limit).context, 512);
});

test('Ollama generation support comes from advertised capabilities', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ model_info: { 'general.architecture': 'bert', 'bert.context_length': 8192 }, capabilities: ['embedding'] }));
  assert.deepEqual(await modelCapabilities('ollama', 'embedding-model'), { context_limit: 8192, can_chat: false, can_disable_thinking: null });
});

test('unrecognized model capabilities do not imply lack of generation support', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ capabilities: ['custom-feature'] }));
  assert.deepEqual(await modelCapabilities('ollama', 'example'), { context_limit: null, can_chat: null, can_disable_thinking: null });
});

test('a model advertising both embeddings and completion remains usable for chat', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ capabilities: ['embedding', 'completion'] }));
  assert.equal((await modelCapabilities('ollama', 'example')).can_chat, true);
});

test('Qwen disables thinking only when metadata explicitly supports it', async t => {
  const requests: Array<Record<string, unknown>> = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/api/show')) return Response.json({ thinking: { values: [false, true] } });
    requests.push(JSON.parse(String(options?.body)));
    return Response.json({ message: { content: 'ok' } });
  });
  const base = { provider: 'ollama' as const, model: 'qwen3.5:2b', messages: [{ role: 'user' as const, content: 'hi' }] };
  await runChatCompletion(base);
  await runChatCompletion({ ...base, canDisableThinking: null });
  assert.equal(requests[0].think, false);
  assert.equal('think' in requests[1], false);
});

test('teaching modes pass runtime parameters and preserve valid citations', async t => {
  const hit = { id: 'a', document_id: 'd', page: 0, position: 0, text: 'A relevant course passage.', blocks: [0], section: 'Topic', name: 'slides', source_name: 'slides', kind: 'pdf', original_id: null } as EvidenceRow;
  const runtime = { mode: 'advanced' as const, context: 6144, output: 768, top_k: 4, temperature: 0.4 };
  const instructions: string[] = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    instructions.push(request.messages[0].content);
    assert.equal(request.options.num_ctx, 6144);
    assert.equal(request.options.num_predict, 768);
    assert.equal(request.options.temperature, 0.4);
    return Response.json({ message: { content: JSON.stringify({ supported: true, answer: 'Answer [S1]', citations: ['S1'] }) } });
  });
  for (const mode of ['hint', 'concept', 'debug', 'ask'] as const) {
    const reply = await generateAnswer({ question: 'Explain this', history: [], hits: [hit], mode, model: 'test', provider: 'ollama', runtime });
    assert.equal(reply.status, 'answered');
    assert.equal(reply.citations[0].chunk_id, 'a');
    assert.equal(reply.citations[0].page, null);
  }
  for (const [index, expected] of ['先給一個簡短提示', '解釋概念和原因', '從學生已嘗試的步驟開始', '直接回答學生的問題'].entries()) {
    assert.match(instructions[index], new RegExp(expected));
  }
});

test('unrelated material is not forced into sparse retrieval', async () => {
  const row = { id: 'a', section: 'Astronomy', text: 'Galaxies and stars', page: 1 } as EvidenceRow;
  assert.deepEqual((await retrieve([row], 'uvwxyz', 'tfidf')).hits, []);
});

test('retrieval retries at most once and only when the expanded query has no hits', async () => {
  const row = { id: 'a', section: 'Quantum', text: 'Quantum physics observations', page: 1 } as EvidenceRow;
  const firstHit = await retrieveWithRetry([row], 'quantum physics', 'quantum', 'tfidf', 3);
  assert.equal(firstHit.attempts, 1);
  const retryHit = await retrieveWithRetry([row], 'uvwxyz', 'quantum physics', 'tfidf', 3);
  assert.equal(retryHit.attempts, 2);
  assert.equal(retryHit.hits[0].id, 'a');
  const noHit = await retrieveWithRetry([row], 'uvwxyz', 'abcdef', 'tfidf', 3);
  assert.equal(noHit.attempts, 2);
  assert.equal(noHit.hits.length, 0);
  const identical = await retrieveWithRetry([row], 'uvwxyz', 'uvwxyz', 'tfidf', 3);
  assert.equal(identical.attempts, 1);
});

test('automatic neighboring text must pass the relevance gate', () => {
  const base = { document_id: 'd', section: '', page: null, kind: 'text' };
  const hit = { ...base, id: 'a', position: 1, text: 'Quantum physics measurement' } as EvidenceRow;
  const unrelated = { ...base, id: 'b', position: 0, text: 'Galaxies and stars' } as EvidenceRow;
  const relevant = { ...base, id: 'c', position: 2, text: 'Quantum mechanics observation' } as EvidenceRow;
  assert.deepEqual(expandTextEvidence([hit, unrelated, relevant], [hit], 5, 'quantum physics').map(row => row.id), ['a', 'c']);
  const age = { ...base, id: 'age', position: 2, text: 'Age missing values' } as EvidenceRow;
  assert.deepEqual(expandTextEvidence([hit, age], [hit], 5, 'Age').map(row => row.id), ['a', 'age']);
});

test('a related excerpt without the requested API name cannot support a specific API answer', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected model call'); });
  const hit = { id: 'a', document_id: 'd', page: 1, position: 0, text: 'Sigmoid produces a probability and BCE computes a loss.', blocks: [0], section: 'BCE', name: 'slides', source_name: 'slides', kind: 'pdf', original_id: null } as EvidenceRow;
  const reply = await generateAnswer({ question: 'Does BCEWithLogitsLoss need Sigmoid?', history: [], hits: [hit], mode: 'concept', model: 'test', provider: 'ollama' });
  assert.equal(reply.status, 'insufficient');
  assert.deepEqual(reply.citations, []);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('debug mode can discuss student-defined identifiers absent from the notes', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({ supported: true, answer: 'Check the split [S1].', citations: ['S1'] }) } }));
  const hit = { id: 'a', document_id: 'd', page: null, position: 0, text: 'Split training and test data before fitting preprocessing.', blocks: [0], section: 'Split', name: 'notes', source_name: 'notes', kind: 'text', original_id: null } as EvidenceRow;
  const reply = await generateAnswer({ question: '請檢查 my_train_data 是否在切分前填補', history: [], hits: [hit], mode: 'debug', model: 'test', provider: 'ollama' });
  assert.equal(reply.status, 'answered');
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('notes that mention a different source page produce a provenance warning', async t => {
  store.documents.set('source', { kind: 'pdf', blocks: [{ page: 6 }, { page: 11 }] } as DocumentRecord);
  t.after(() => store.documents.delete('source'));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({ supported: true, answer: 'Answer [S1]', citations: ['S1'] }) } }));
  const hit = { id: 'a', document_id: 'd', page: 6, position: 0, text: '相關課程內容。詳解見原 PDF 第 11 頁。', blocks: [0], section: 'Topic', name: 'note', source_name: 'slides', kind: 'note', original_id: 'source' } as EvidenceRow;
  const reply = await generateAnswer({ question: '請解釋概念', history: [], hits: [hit], mode: 'concept', model: 'test', provider: 'ollama' });
  assert.equal(reply.status, 'answered');
  assert.match(reply.evidence_warning || '', /不同的 PDF 頁碼/);
  assert.equal(reply.citations[0].page, 6);
  assert.deepEqual(reply.citations[0].related_pages, [11]);
});

test('citations hide pages absent from the source PDF', async t => {
  store.documents.set('source-check', { kind: 'pdf', blocks: [{ page: 6 }] } as DocumentRecord);
  t.after(() => store.documents.delete('source-check'));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({ supported: true, answer: 'Answer [S1]', citations: ['S1'] }) } }));
  const hit = { id: 'a', document_id: 'note', page: 999, position: 0, text: 'Relevant source text. 詳解見原 PDF 第 1000 頁。', blocks: [0], section: 'Topic', name: 'note', source_name: 'slides', kind: 'note', original_id: 'source-check' } as EvidenceRow;
  const reply = await generateAnswer({ question: 'Explain', history: [], hits: [hit], mode: 'concept', model: 'test', provider: 'ollama' });
  assert.equal(reply.status, 'answered');
  assert.equal(reply.citations[0].page, null);
  assert.equal(reply.citations[0].related_pages, undefined);
  assert.match(reply.evidence_warning || '', /頁碼無法核實/);
});

test('too-small context is reported without sending a truncated prompt', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected model call'); });
  const hit = { id: 'a', document_id: 'd', page: 1, position: 0, text: 'Relevant text', blocks: [0], section: 'Topic', name: 'slides', source_name: 'slides', kind: 'pdf', original_id: null } as EvidenceRow;
  const reply = await generateAnswer({ question: 'Explain', history: [], hits: [hit], mode: 'ask', model: 'test', provider: 'ollama', runtime: { mode: 'advanced', context: 1024, output: 512, top_k: 2, temperature: 0 } });
  assert.equal(reply.status, 'error');
  assert.match(reply.answer, /上下文預算不足/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('long history keeps complete recent turns and respects the final request estimate', async t => {
  const runtime = { mode: 'advanced' as const, context: 4096, output: 512, top_k: 2, temperature: 0 };
  const hit = { id: 'a', document_id: 'd', page: 1, position: 0, text: 'Relevant course evidence about training.', blocks: [0], section: 'Topic', name: 'slides', source_name: 'slides', kind: 'pdf', original_id: null } as EvidenceRow;
  const history = Array.from({ length: 6 }, (_, index) => ({ question: `Prior question ${index}`, answer: 'a'.repeat(350) }));
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    assert.ok(requestByteEstimate(request.messages, request.format) <= inputByteBudget(runtime.context, runtime.output));
    assert.equal(request.messages.at(-1).role, 'user');
    const turns = request.messages.slice(1, -1);
    assert.equal(turns.length % 2, 0);
    for (let index = 0; index < turns.length; index += 2) {
      assert.equal(turns[index].role, 'user');
      assert.equal(turns[index + 1].role, 'assistant');
    }
    assert.match(JSON.stringify(request.messages), /Prior question 5/);
    return Response.json({ message: { content: JSON.stringify({ supported: true, answer: 'Answer [S1]', citations: ['S1'] }) } });
  });
  const reply = await generateAnswer({ question: 'Explain training', history, hits: [hit], mode: 'ask', model: 'test', provider: 'ollama', runtime });
  assert.equal(reply.status, 'answered');
  assert.equal(reply.history_truncated, true);
});

test('several long passages fit the default budget instead of producing a false budget error', async t => {
  const hits = Array.from({ length: 3 }, (_, i) => ({ id: `c${i}`, document_id: `doc${i}`, page: null, position: i, text: '相關的資料切分與填補原則。'.repeat(50), blocks: [0], section: '資料處理', name: 'notes', source_name: 'notes', kind: 'text', original_id: null })) as EvidenceRow[];
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    assert.ok(requestByteEstimate(request.messages, request.format) <= inputByteBudget(DEFAULT_RUNTIME.context, DEFAULT_RUNTIME.output));
    return Response.json({ message: { content: JSON.stringify({ supported: false, answer: '', citations: [] }) } });
  });
  const reply = await generateAnswer({ question: '某個缺失值的數字是多少？', history: [], hits, mode: 'concept', model: 'test', provider: 'ollama' });
  assert.equal(reply.status, 'insufficient');
  assert.deepEqual(reply.citations, []);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('hybrid ranking keeps source metadata while merging TF-IDF and dense results', async t => {
  const rows = [
    { id: 'a', document_id: 'doc', section: 'Alpha', text: 'alpha gradient concept', page: 7, position: 1, blocks: [3] },
    { id: 'b', document_id: 'other', section: 'Beta', text: 'beta gradient concept', page: 8, position: 2, blocks: [4] },
  ] as EvidenceRow[];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'bge-m3:latest', digest: 'test-model-runtime' }] });
    const input = JSON.parse(String(options?.body)).input as string[];
    return Response.json({ embeddings: input.map(text => text.startsWith('Beta') ? [0.8, 0.6] : [1, 0]) });
  });
  const result = await retrieve(rows, 'alpha gradient', 'hybrid', 2);
  assert.equal(result.method, 'hybrid');
  assert.equal(result.hits[0].id, 'a');
  assert.equal(result.hits[0].page, 7);
  assert.deepEqual(result.hits[0].blocks, [3]);
  assert.equal(result.hits[0].document_id, 'doc');
  assert.equal(result.hits.length, 2);
});

test('retrieval caches refresh when a chunk changes without changing its ID or length', async t => {
  const row = { id: 'cache-refresh-test', document_id: 'doc', section: 'Topic', text: 'zzzzzz', page: 1, position: 0, blocks: [0], name: 'notes', source_name: 'notes', kind: 'text', original_id: null } as EvidenceRow;
  assert.equal((await retrieve([row], 'nebula', 'tfidf')).hits.length, 0);
  const updated = { ...row, text: 'nebula' };
  assert.equal((await retrieve([updated], 'nebula', 'tfidf')).hits[0]?.id, row.id);
  assert.equal((await retrieve([{ ...updated, section: 'quasar' }], 'quasar', 'tfidf')).hits[0]?.id, row.id);

  const embedded: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: 'bge-m3:latest', digest: 'cache-refresh-model' }] });
    const input = JSON.parse(String(options?.body)).input as string[];
    embedded.push(...input);
    return Response.json({ embeddings: input.map(text => text.includes('zzzzzz') ? [1, 0] : [0, 1]) });
  });
  t.after(() => {
    for (const key of store.vectors.keys()) if (key.startsWith('cache-refresh-model:')) store.vectors.delete(key);
  });
  assert.equal((await retrieve([row], 'nebula', 'dense')).hits.length, 0);
  assert.equal((await retrieve([updated], 'nebula', 'dense')).hits[0]?.id, row.id);
  assert.ok(embedded.includes('Topic\nzzzzzz'));
  assert.ok(embedded.includes('Topic\nnebula'));
});

test('cloud and local use the same evidence and cloud receives supported settings', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only';
  const hit = { id: 'a', document_id: 'd', page: 2, position: 0, text: 'A relevant course passage.', blocks: [0], section: 'Topic', name: 'slides', source_name: 'slides', kind: 'pdf', original_id: null } as EvidenceRow;
  store.documents.set('d', { kind: 'pdf', blocks: [{ page: 2 }] } as DocumentRecord);
  t.after(() => store.documents.delete('d'));
  try {
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      const request = JSON.parse(String(options?.body));
      assert.equal(request.max_tokens, 768);
      assert.equal(request.temperature, 0.4);
      assert.match(JSON.stringify(request.messages), /A relevant course passage/);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ supported: true, answer: 'Answer [S1]', citations: ['S1'] }) } }] });
    });
    const reply = await generateAnswer({ question: 'Explain', history: [], hits: [hit], mode: 'ask', model: 'test-model', provider: 'openai', runtime: { mode: 'advanced', context: 6144, output: 768, top_k: 4, temperature: 0.4 } });
    assert.equal(reply.status, 'answered');
    assert.equal(reply.citations[0].page, 2);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  }
});

test('a cloud provider failure returns a safe actionable error and keeps evidence', async t => {
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-only-secret';
  const hit = { id: 'a', document_id: 'd', page: null, position: 0, text: 'A relevant course passage.', blocks: [0], section: 'Topic', name: 'notes', source_name: 'notes', kind: 'text', original_id: null } as EvidenceRow;
  try {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'private upstream details' }, { status: 404 }));
    const reply = await generateAnswer({ question: 'Explain', history: [], hits: [hit], mode: 'ask', model: 'test-model', provider: 'openai' });
    assert.equal(reply.status, 'error');
    assert.match(reply.answer, /HTTP 404/);
    assert.doesNotMatch(reply.answer, /private|secret/);
    assert.equal(reply.retrieved_evidence?.[0].chunk_id, 'a');
    assert.deepEqual(reply.citations, []);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  }
});
