import assert from 'node:assert/strict';
import test from 'node:test';
import { cliGenerationArgs, isBlockedHost, isSafeModelName, isValidProvider, listProviderModels, parseCliReply, parseCodexModels, parseJsonFromLlm, stripThinkAndFence } from '../src/llm.js';
import { renderMarkdown, sanitizeLatexDelimiters } from '../src/markdown.js';
import { MODEL_PROVIDERS, pruneInactiveDocuments, pruneOldJobs, readCliOptions, store } from '../src/store.js';
import { classifySyllabusWeek, cleanGeneratedMarkdown, generateDocumentQuiz, stratifiedSamplePages } from '../src/study.js';
import { expandPageEvidence, generateAnswer } from '../src/tutor.js';
import type { EvidenceRow } from '../src/tutor.js';

test('Markdown renders bare line breaks in tables while preserving code and blocking active HTML', () => {
  const html = renderMarkdown('| Column |\n| --- |\n| First<br/>Second &lt;br&gt;Third |\n\n`<br>` <script>alert(1)</script>');
  assert.match(html, /<td>First<br\s*\/?>(?:\n)?Second\s*<br\s*\/?>(?:\n)?Third<\/td>/);
  assert.match(html, /<code>&lt;br&gt;<\/code>/);
  assert.doesNotMatch(html, /<script>/);
});

test('the CLI uses final response content instead of diagnostic or tool events', () => {
  assert.equal(parseCliReply('antigravity-cli', '{"status":"SUCCESS","response":"OK"}'), 'OK');
  assert.equal(parseCliReply('claude-code', '{"is_error":true,"result":"An error"}'), '');
  assert.equal(parseCliReply('codex-cli', [
    '{"type":"item.completed","item":{"type":"command_execution","text":"irrelevant"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}',
  ].join('\n')), 'OK');
});

test('Codex detects visible models and their advertised effort and speed options', () => {
  const catalog = parseCodexModels(JSON.stringify({ models: [
    { slug: 'listed', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'ultra' }], service_tiers: [{ id: 'priority' }] },
    { slug: 'standard', visibility: 'list', supported_reasoning_levels: [], additional_speed_tiers: [] },
    { slug: 'hidden', visibility: 'hide' },
    { slug: '--invalid', visibility: 'list' },
  ] }));
  assert.deepEqual(catalog.models, ['default', 'listed', 'standard']);
  assert.deepEqual(catalog.model_capabilities.listed, { reasoning_levels: ['medium', 'ultra'], fast: true });
  assert.deepEqual(catalog.model_capabilities.standard, { reasoning_levels: [], fast: false });
  assert.deepEqual(parseCodexModels('{}').models, ['default']);
});

test('CLI generation applies independent draft overrides and keeps legacy Antigravity model variants usable', () => {
  const codex = cliGenerationArgs('codex-cli', 'default', { reasoning_effort: 'medium', service_tier: 'fast' });
  const start = codex.indexOf('exec');
  assert.deepEqual(codex.slice(start - 4, start), ['-c', 'model_reasoning_effort="medium"', '-c', 'service_tier="fast"']);
  assert.ok(!codex.includes('--model'));
  assert.ok(cliGenerationArgs('codex-cli', 'listed', { service_tier: 'default' }).includes('service_tier="default"'));
  assert.ok(!cliGenerationArgs('codex-cli', 'listed').some(arg => arg.startsWith('service_tier=') || arg.startsWith('model_reasoning_effort=')));
  assert.deepEqual(cliGenerationArgs('claude-code', 'sonnet', { reasoning_effort: 'high' }).slice(-4), ['--model', 'sonnet', '--effort', 'high']);
  assert.deepEqual(cliGenerationArgs('antigravity-cli', 'gemini-neon-high').slice(-4), ['--model', 'gemini-neon', '--effort', 'high']);
  assert.deepEqual(cliGenerationArgs('antigravity-cli', 'gemini-neon-high', { reasoning_effort: 'low' }).slice(-4), ['--model', 'gemini-neon', '--effort', 'low']);
  assert.equal(readCliOptions('claude-code', { service_tier: 'fast' }), null);
  assert.equal(readCliOptions('codex-cli', { reasoning_effort: 'high"\nallow = true' }), null);
});

test('cloud model discovery sends a draft key only to the selected provider', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=100');
    assert.deepEqual(options.headers, { 'x-goog-api-key': 'synthetic-test-key' });
    assert.equal(options.redirect, 'manual');
    return Response.json({ models: [
      { name: 'models/qa-generation-model', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/qa-embedding-model', supportedGenerationMethods: ['embedContent'] },
    ] });
  });
  assert.deepEqual(await listProviderModels('gemini', 'synthetic-test-key'), ['qa-generation-model']);
});

test('isSafeModelName accepts valid model identifiers and rejects CLI flag / shell injection', () => {
  assert.equal(isSafeModelName('qwen3.5:0.8b'), true);
  assert.equal(isSafeModelName('gemini-4-hydrogen'), true);
  assert.equal(isSafeModelName('anthropic/claude-sonnet-4'), true);
  assert.equal(isSafeModelName('gpt-4.1-mini'), true);

  assert.equal(isSafeModelName('--dangerously-skip-permissions'), false);
  assert.equal(isSafeModelName('-m'), false);
  assert.equal(isSafeModelName('foo;rm -rf /'), false);
  assert.equal(isSafeModelName('model name with spaces'), false);
  assert.equal(isSafeModelName(''), false);
  assert.equal(isSafeModelName(null), false);
});

test('isValidProvider stays aligned with MODEL_PROVIDERS single source of truth', () => {
  for (const id of MODEL_PROVIDERS) {
    assert.equal(isValidProvider(id), true, `Expected ${id} to be valid`);
  }
  assert.equal(isValidProvider('unknown-provider'), false);
  assert.equal(isValidProvider(''), false);
});

test('isBlockedHost blocks IPv4/IPv6 loopback, private, and link-local hosts including bracketed IPv6', () => {
  assert.equal(isBlockedHost('localhost'), true);
  assert.equal(isBlockedHost('127.0.0.1'), true);
  assert.equal(isBlockedHost('127.0.1.1'), true);
  assert.equal(isBlockedHost('0.0.0.0'), true);
  assert.equal(isBlockedHost('[::1]'), true);
  assert.equal(isBlockedHost('::1'), true);
  assert.equal(isBlockedHost('[::ffff:127.0.0.1]'), true);
  assert.equal(isBlockedHost('169.254.169.254'), true);
  assert.equal(isBlockedHost('169.254.1.2'), true);
  assert.equal(isBlockedHost('10.0.0.5'), true);
  assert.equal(isBlockedHost('192.168.1.10'), true);
  assert.equal(isBlockedHost('172.16.0.1'), true);
  assert.equal(isBlockedHost('[fe80::1]'), true);
  assert.equal(isBlockedHost('[fc00::1]'), true);

  assert.equal(isBlockedHost('api.openai.com'), false);
  assert.equal(isBlockedHost('opencode.ai'), false);
  assert.equal(isBlockedHost('openrouter.ai'), false);
});

test('stripThinkAndFence and parseJsonFromLlm handle reasoning tags, fences, and surrounding prose', () => {
  const fenced = '<think>reasoning here</think>\n```json\n{"ok":true,"count":3}\n```';
  assert.equal(stripThinkAndFence(fenced), '{"ok":true,"count":3}');
  assert.deepEqual(parseJsonFromLlm<{ ok: boolean; count: number }>(fenced), { ok: true, count: 3 });

  const noisy = 'Here is the result:\n{"supported":true,"citations":["S1"]}\nHope this helps!';
  assert.deepEqual(parseJsonFromLlm<{ supported: boolean; citations: string[] }>(noisy), {
    supported: true,
    citations: ['S1'],
  });

  assert.throws(() => parseJsonFromLlm('not valid json at all'));
});

test('renderMarkdown preserves $& / $\' inside math without HTML corruption and sanitizes XSS', () => {
  const trickyMath = 'Before $$a \\$& b \\$\' c$$ After';
  const html = renderMarkdown(trickyMath);
  assert.ok(html.includes('Before'));
  assert.ok(html.includes('After'));
  // Ensure the placeholder token or trailing HTML was NOT duplicated by String.replace special patterns.
  assert.equal(html.includes('AITAMATHPLACEHOLDER'), false);
  assert.equal((html.match(/After/g) || []).length, 1);

  const xss = '[click](javascript:alert(1)) <script>alert(2)</script> [safe](https://example.com)';
  const safeHtml = renderMarkdown(xss);
  assert.equal(/href\s*=\s*["']?\s*javascript:/i.test(safeHtml), false);
  assert.equal(safeHtml.includes('<script'), false);
  assert.ok(safeHtml.includes('href="https://example.com"'));
  assert.ok(safeHtml.includes('rel="noopener noreferrer"'));
});

test('sanitizeLatexDelimiters balances dangling delimiters while keeping currency intact', () => {
  assert.equal(sanitizeLatexDelimiters('The book costs $50 and $12.99.'), 'The book costs \\$50 and \\$12.99.');
  const fixedBlock = sanitizeLatexDelimiters('Formula:\n$$\nx^2 + y^2 = z^2');
  assert.equal((fixedBlock.match(/\$\$/g) || []).length, 2);
});

test('stratifiedSamplePages evenly covers long documents within budget with [Page N] markers', () => {
  const pages = Array.from({ length: 20 }, (_, i) => ({
    page: i + 1,
    text: `Page ${i + 1} content `.repeat(40),
  }));
  const res = stratifiedSamplePages(pages, 2000);
  assert.ok(res.sampledPages[0] === 1);
  assert.ok(res.sampledPages[res.sampledPages.length - 1] === 20);
  assert.ok(res.contextText.includes('[Page 1]'));
  assert.ok(res.contextText.includes('[Page 20]'));
  assert.ok(res.contextText.length <= 2300);
});

test('classifySyllabusWeek handles holidays, pure exams, activities, and mixed lecture+quiz weeks', () => {
  assert.deepEqual(
    classifySyllabusWeek({ title: '教師節放假 (Teacher Day Holiday)', topics: [], milestone: null }),
    { week_type: 'holiday', requires_material: false }
  );
  assert.deepEqual(
    classifySyllabusWeek({ title: '期中考 (Midterm)', topics: [], milestone: 'Midterm' }),
    { week_type: 'exam', requires_material: false }
  );
  assert.deepEqual(
    classifySyllabusWeek({ title: '期末專題同儕互評 (Final Project Peer Review)', topics: [], milestone: null }),
    { week_type: 'activity', requires_material: false }
  );
  assert.deepEqual(
    classifySyllabusWeek({ title: '瑕疵檢測專案分享與小考 (Quiz)', topics: ['瑕疵檢測'], milestone: '小考' }),
    { week_type: 'lecture', requires_material: true }
  );
});

test('pruneInactiveDocuments and pruneOldJobs reclaim unreferenced inactive records and oversized failed payloads', () => {
  store.documents.clear();
  store.chunks.clear();
  store.personalNotes.clear();
  store.jobs.clear();
  store.turns = [];

  store.documents.set('stale-doc', {
    id: 'stale-doc',
    name: 'old.md',
    digest: 'a',
    revision: 'r',
    kind: 'personal',
    active: false,
    raw: Buffer.from('old'),
    markdown: 'old',
    blocks: [],
    original_id: null,
    official: false,
    created: new Date().toISOString(),
  });
  store.chunks.set('stale-doc-0', {
    id: 'stale-doc-0',
    document_id: 'stale-doc',
    position: 0,
    section: 's',
    page: null,
    text: 'old',
    blocks: [0],
  });

  pruneInactiveDocuments();
  assert.equal(store.documents.has('stale-doc'), false);
  assert.equal(store.chunks.has('stale-doc-0'), false);

  for (let i = 1; i <= 5; i++) {
    store.jobs.set(`job-${i}`, {
      id: `job-${i}`,
      name: `f${i}.pdf`,
      state: 'failed',
      message: 'err',
      document_id: null,
      payload: Buffer.alloc(1024),
      options: { kind: 'pdf', original_id: null, official: false },
      created: new Date().toISOString(),
      seq: i,
    });
  }
  pruneOldJobs(30, 2);
  const retained = [...store.jobs.values()].filter((j) => j.payload !== null);
  assert.equal(retained.length, 2);
});

test('cleanup keeps pending imports and old document revisions referenced by a conversation', () => {
  store.jobs.clear();
  store.documents.clear();
  const baseJob = {
    name: 'test.md', state: 'queued' as const, message: null, document_id: null, payload: Buffer.from('test'),
    options: { kind: 'text' as const, original_id: null, official: false }, created: '',
  };
  store.jobs.set('pending', { ...baseJob, id: 'pending', seq: 1, state: 'processing' });
  store.jobs.set('queued', { ...baseJob, id: 'queued', seq: 2 });
  store.jobs.set('ready', { ...baseJob, id: 'ready', seq: 3, state: 'ready' });
  pruneOldJobs(1);
  assert.deepEqual([...store.jobs.keys()], ['pending', 'queued', 'ready']);

  for (const id of ['old-revision', 'original-source', 'uncited']) {
    store.documents.set(id, {
      id, name: id, digest: 'test', revision: 'test', kind: 'text', active: false, raw: Buffer.alloc(0),
      markdown: '', blocks: [], original_id: null, official: false, created: '',
    });
  }
  store.turns = [{
    id: 1, conversation_id: 'chat', question: 'Question', answer: 'Answer',
    result: { citations: [{ document_id: 'old-revision', source_id: 'original-source' }] },
  }];
  pruneInactiveDocuments();
  assert.deepEqual([...store.documents.keys()], ['old-revision', 'original-source']);
  store.turns = [];
});

test('a failed model call exposes retrieved excerpts without presenting them as a verified answer', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Mocked offline model'); });
  const reply = await generateAnswer({
    question: 'What color is this handout?', history: [], mode: 'concept', model: 'test', language: 'en', provider: 'ollama',
    hits: [{
      id: 'chunk', document_id: 'document', position: 0, name: 'Unit test material', kind: 'text',
      source_name: 'Unit test material', section: 'Intro', page: 2, official: false,
      text: 'A material excerpt about feature selection.', blocks: [0], original_id: null,
    }],
  });
  assert.equal(reply.status, 'error');
  assert.deepEqual(reply.citations, []);
  assert.equal(reply.retrieved_evidence?.[0]?.chunk_id, 'chunk');
});

test('a quiz rejects invalid answers and citations to pages omitted from that batch', async (t) => {
  store.documents.set('quiz-test', {
    id: 'quiz-test', name: 'Quiz test', digest: 'test', revision: 'test', kind: 'pdf', active: true, raw: Buffer.alloc(0),
    markdown: '', blocks: [1, 2, 3, 4].map(page => ({ text: `Concept on page ${page}.`, page, section: '', type: 'text' })),
    original_id: null, official: false, created: '',
  });
  const question = { options: ['A', 'B', 'C', 'D'], correct_index: 2 };
  let batch = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({
    questions: ++batch === 1 ? [
      { ...question, stem: 'Invalid index', page_ref: 1, correct_index: 99 },
      { ...question, stem: 'Valid first batch\n\noptions: [A, B, C, D]\n\ncorrect_index: 2', page_ref: 2 },
      { ...question, stem: 'Page outside first batch', page_ref: 3 },
    ] : [
      { ...question, stem: 'Valid second batch', page_ref: 4 },
      { ...question, stem: 'Invalid choice position', page_ref: 3, options: ['', 'B', 'C', 'D'] },
    ],
  }) } }));
  const quiz = await generateDocumentQuiz({ documentId: 'quiz-test', scope: 'full', page: null, count: 5 });
  assert.deepEqual(quiz.questions.map(({ stem, page_ref }) => [stem, page_ref]), [
    ['Valid first batch', 2], ['Valid second batch', 4],
  ]);
  assert.doesNotMatch(quiz.questions[0].stem_html, /options|correct_index/);
});

test('generated Markdown collapses repeated heading markers outside fenced code', () => {
  assert.equal(cleanGeneratedMarkdown('## ## Core concepts\n### ### Example\n~~~text\n## ## Literal\n~~~'),
    '## Core concepts\n### Example\n~~~text\n## ## Literal\n~~~');
});

test('whole-page evidence includes neighboring algorithm steps along with a short definition', () => {
  const rows = [
    '## Sequential Forward Selection (SFS)',
    'Start with an empty set; add a useful feature on each round.',
    '## Algorithm',
    '1. Start with an empty set.',
    '2. Score each remaining candidate with CV.',
    '3. Add the candidate with the highest score.',
    '4. Stop when the target number is reached.',
  ].map((text, position) => ({ id: String(position), position, text } as EvidenceRow));
  const selected = expandPageEvidence(rows, [rows[0], rows[1]]);
  assert.deepEqual(selected.map(row => row.position), [1, 3, 4, 5, 6]);
});
