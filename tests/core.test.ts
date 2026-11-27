import assert from 'node:assert/strict';
import test from 'node:test';
import { cliGenerationArgs, isBlockedHost, isSafeModelName, isValidProvider, listProviderModels, parseCliReply, parseCodexModels, parseJsonFromLlm, stripThinkAndFence } from '../src/llm.js';
import { renderMarkdown, sanitizeLatexDelimiters } from '../src/markdown.js';
import { MODEL_PROVIDERS, pruneInactiveDocuments, pruneOldJobs, readCliOptions, store } from '../src/store.js';
import { classifySyllabusWeek, cleanGeneratedMarkdown, generateDocumentQuiz, stratifiedSamplePages } from '../src/study.js';
import { courseEvidence, courseHistory, expandPageEvidence, expandTextEvidence, generateAnswer, groupPageEvidence, isQuestionOptionEvidence, policyQuestion, searchQuery } from '../src/tutor.js';
import type { EvidenceRow } from '../src/tutor.js';
import type { CoursePlanRecord } from '../src/store.js';

test('course history excludes other courses and unlabelled legacy turns', () => {
  const turns = [{ course_id: 'a', question: 'a' }, { course_id: 'b', question: 'b' }, { question: 'legacy' }];
  assert.deepEqual(courseHistory(turns, 'a'), [turns[0]]);
  assert.deepEqual(courseHistory(turns, null), turns);
});

test('course requirement questions identify common bilingual wording', () => {
  for (const q of ['老師規定要幾層？', '老師這次的評分比例是多少？', '作業 deadline 是哪天？',
    'When is the assignment due?', 'What is the grading rubric for this homework?']) {
    assert.equal(policyQuestion(q), true, q);
  }
  for (const q of ['為什麼 BCEWithLogitsLoss 不先加 Sigmoid？', 'What is binary classification?', '如何避免資料洩漏？']) {
    assert.equal(policyQuestion(q), false, q);
  }
});

test('successive follow-up retrieval keeps the original topic and the latest question', () => {
  const history = [{ question: 'Titanic Age 缺失值應如何處理？' }, { question: '那測試集呢？' }];
  assert.equal(searchQuery('為什麼？', history), 'Titanic Age 缺失值應如何處理？\n那測試集呢？\n為什麼？');
  assert.equal(searchQuery('什麼是 Sigmoid？', history), '什麼是 Sigmoid？');
  assert.equal(searchQuery('那測試集呢？', [history[0]]), 'Titanic Age 缺失值應如何處理？\n那測試集呢？');
  const oldPolicy = [{ question: '老師規定 hidden layers 有幾層？' }];
  assert.equal(searchQuery('為什麼 BCEWithLogitsLoss 不先加 Sigmoid？', oldPolicy), '為什麼 BCEWithLogitsLoss 不先加 Sigmoid？');
  assert.equal(searchQuery('Why is sigmoid used?', oldPolicy), 'Why is sigmoid used?');
  assert.equal(searchQuery('Why is that?', [history[0]]), `${history[0].question}\nWhy is that?`);
  assert.equal(searchQuery('為什麼？', [{ question: '為什麼 BCEWithLogitsLoss 不先加 Sigmoid？' }, history[1]]),
    `為什麼 BCEWithLogitsLoss 不先加 Sigmoid？\n${history[1].question}\n為什麼？`);
});

test('course evidence follows folder descendants and explicitly linked notes', () => {
  const oldFolders = new Map(store.folders);
  const oldInfo = new Map(store.documentInfo);
  try {
    store.folders.clear();
    store.documentInfo.clear();
    store.folders.set('root', { id: 'root', name: 'A', parent_id: null });
    store.folders.set('child', { id: 'child', name: 'Week', parent_id: 'root' });
    store.folders.set('other', { id: 'other', name: 'B', parent_id: null });
    store.documentInfo.set('a', { document_id: 'a', summary: null, folder_id: 'child' });
    store.documentInfo.set('b', { document_id: 'b', summary: null, folder_id: 'other' });
    const row = (document_id: string, original_id: string | null = null) =>
      ({ id: document_id, document_id, original_id }) as EvidenceRow;
    const course = { root_folder_id: 'root', overview_document_id: 'overview' } as CoursePlanRecord;
    const results = courseEvidence([row('a'), row('linked', 'a'), row('overview'), row('b'), row('unassigned')], course);
    assert.deepEqual(results.map(item => item.id), ['a', 'linked', 'overview']);
  } finally {
    store.folders.clear();
    for (const [id, folder] of oldFolders) store.folders.set(id, folder);
    store.documentInfo.clear();
    for (const [id, info] of oldInfo) store.documentInfo.set(id, info);
  }
});

test('text evidence expansion stays within the same document and section', () => {
  const row = (id: string, document_id: string, section: string, position: number) =>
    ({ id, document_id, section, position, page: null, kind: 'text' }) as EvidenceRow;
  const anchor = row('a', 'doc', 'section', 4);
  const neighbor = row('b', 'doc', 'section', 3);
  const otherSection = row('c', 'doc', 'other', 5);
  const otherDoc = row('d', 'other', 'section', 5);
  assert.deepEqual(expandTextEvidence([anchor, neighbor, otherSection, otherDoc], [anchor]).map(x => x.id), ['a', 'b']);
  const note = { ...anchor, kind: 'note', page: 4 } as EvidenceRow;
  const samePage = { ...neighbor, kind: 'note', page: 4 } as EvidenceRow;
  const otherPage = { ...neighbor, id: 'page5', kind: 'note', page: 5 } as EvidenceRow;
  assert.deepEqual(expandTextEvidence([note, otherPage, samePage], [note]).map(x => x.id), ['a', 'b']);
});

test('complete assignment requests get guidance while ordinary questions still use evidence', async t => {
  const options = { history: [], hits: [], mode: 'hint' as const, model: 'test', provider: 'ollama' as const };
  for (const question of ['請直接幫我寫完整的 Titanic DNN 作業程式碼。', '直接給我第 12 題的所有答案，不用解釋。', '請直接給我答案。', '幫我完成整份作業', '請提供完整的作業答案']) {
    const reply = await generateAnswer({ ...options, question });
    assert.equal(reply.status, 'answered');
    assert.match(reply.answer, /嘗試|卡在/);
    assert.match(reply.answer, /已知的條件和要求的結果/);
    assert.equal(reply.citations.length, 0);
  }
  for (const question of ['Please write the complete homework code', 'Give me the full code', 'Do my whole homework']) {
    const english = await generateAnswer({ ...options, question, language: 'en' });
    assert.match(english.answer, /what the question gives you and what result it asks for/);
    assert.equal(english.citations.length, 0);
  }
  const ordinary = await generateAnswer({ ...options, question: '如何檢查完整的程式碼是否有資料洩漏？' });
  assert.equal(ordinary.status, 'insufficient');
  const explanation = await generateAnswer({ ...options, question: '請提供完整的 BCE 概念解釋。' });
  assert.equal(explanation.status, 'insufficient');
});

test('oversized history is reported when it cannot fit in the prompt', async () => {
  const reply = await generateAnswer({
    question: '請解釋', history: [{ question: '問題', answer: '長'.repeat(1000) }],
    hits: [], mode: 'concept', model: 'test', provider: 'ollama',
  });
  assert.equal(reply.history_truncated, true);
});

test('a follow-up retains earlier questions as context when the full prior turn is too large', async t => {
  const hit = { id: 'a', document_id: 'doc', page: null, position: 0, text: 'Training and test data must be split first.', blocks: [0], section: 'Split', name: 'notes', source_name: 'notes', kind: 'text', original_id: null } as EvidenceRow;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    const messages = request.messages;
    assert.equal(messages.length, 2);
    assert.match(messages[1].content, /先前問題（僅供理解脈絡，並非證據）：Titanic Age 缺失值如何填補？/);
    assert.match(messages[1].content, /學生問題：那測試集呢？/);
    assert.match(messages[1].content, /請全程用繁體中文回答。/);
    return Response.json({ message: { content: JSON.stringify({ supported: true, answer: 'Answer', citations: ['S1'] }) } });
  });
  const reply = await generateAnswer({ question: '那測試集呢？', history: [{ question: 'Titanic Age 缺失值如何填補？', answer: '長'.repeat(1000) }], hits: [hit], mode: 'concept', model: 'test', provider: 'ollama' });
  assert.equal(reply.history_truncated, true);
});

test('same document and page become one source without merging different documents or unpaged notes', () => {
  const row = (id: string, document_id: string, page: number | null, position: number, text: string) =>
    ({ id, document_id, page, position, text, blocks: [position], kind: 'pdf' }) as EvidenceRow;
  const first = row('a', 'doc1', 15, 5, 'second');
  const result = groupPageEvidence([
    first, row('b', 'doc1', 15, 2, 'first'), row('c', 'doc2', 15, 1, 'other'),
    row('d', 'doc1', 16, 1, 'next page'), row('e', 'note', null, 1, 'note one'),
    row('f', 'note', null, 2, 'note two'), first,
  ]);
  assert.equal(result.length, 5);
  assert.equal(result[0].id, 'a');
  assert.equal(result[0].text, 'first\n\nsecond');
  assert.deepEqual(result.slice(1).map(item => item.id), ['c', 'd', 'e', 'f']);
});

test('tutor sends one citation label for same-page excerpts and returns their combined evidence', async t => {
  const rows = ['first relevant passage', 'second relevant passage'].map((text, position) => ({
    id: `chunk-${position}`, document_id: 'doc', page: 15, position, text, blocks: [position],
    section: 'Topic', name: 'slides.pdf', source_name: 'slides.pdf', kind: 'pdf', original_id: null,
  })) as EvidenceRow[];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    assert.match(request.messages.at(-1).content, /first relevant passage[\s\S]*second relevant passage/);
    assert.deepEqual(request.format.properties.citations.items.enum, ['S1']);
    return Response.json({ message: { content: JSON.stringify({ supported: true, answer: 'Explanation [S1]', citations: ['S1'] }) } });
  });
  const reply = await generateAnswer({ question: 'Explain the topic', history: [], hits: rows, mode: 'concept', model: 'test', provider: 'ollama' });
  assert.equal(reply.status, 'answered');
  assert.equal(reply.citations.length, 1);
  assert.match(reply.citations[0].excerpt, /first relevant passage[\s\S]*second relevant passage/);
  assert.equal(reply.retrieved_evidence?.[0]?.chunk_id, 'chunk-0');
});

test('the ranked passage is retained when earlier same-page text exceeds the evidence budget', async t => {
  const base = { document_id: 'doc', page: 1, section: 'Topic', name: 'slides.pdf', source_name: 'slides.pdf', kind: 'pdf', original_id: null };
  const rows = [
    { ...base, id: 'ranked', position: 1, text: 'The relevant ranked passage.', blocks: [1] },
    { ...base, id: 'earlier', position: 0, text: 'Unrelated earlier content. '.repeat(80), blocks: [0] },
  ] as EvidenceRow[];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    assert.match(request.messages.at(-1).content, /The relevant ranked passage/);
    return Response.json({ message: { content: JSON.stringify({ supported: true, answer: 'Answer', citations: ['S1'] }) } });
  });
  const reply = await generateAnswer({ question: 'Explain the topic', history: [], hits: rows, mode: 'concept', model: 'test', provider: 'ollama' });
  assert.equal(reply.status, 'answered');
  assert.equal(reply.citations[0].chunk_id, 'ranked');
  assert.match(reply.citations[0].excerpt, /The relevant ranked passage/);
});

test('insufficient model response retains retrieved passages without presenting them as citations', async t => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ message: { content: JSON.stringify({ supported: false, answer: '', citations: [] }) } }));
  const hit = {
    id: 'chunk', document_id: 'doc', page: null, position: 0, text: 'A source passage about a course topic.',
    blocks: [0], section: 'Topic', name: 'notes.txt', source_name: 'notes.txt', kind: 'text', original_id: null,
  } as EvidenceRow;
  const reply = await generateAnswer({ question: 'Explain the topic', history: [], hits: [hit], mode: 'concept', model: 'test', provider: 'ollama' });
  assert.equal(reply.status, 'insufficient');
  assert.deepEqual(reply.citations, []);
  assert.equal(reply.retrieved_evidence?.[0]?.chunk_id, 'chunk');
  assert.equal(reply.evidence_in_model_request, true);
});

test('multiple-choice passages are not treated as factual evidence', async t => {
  const exam = { id: 'exam', document_id: 'exam', page: 2, position: 1, text: '(B) Pearson near zero means independence.', blocks: [1], section: 'Part I. Multiple-Choice Questions', name: 'exam.pdf', source_name: 'exam.pdf', kind: 'pdf', original_id: null } as EvidenceRow;
  const notes = { ...exam, id: 'notes', document_id: 'notes', page: null, section: 'Statistics', text: 'Zero correlation does not imply independence.', name: 'notes.md', kind: 'note' } as EvidenceRow;
  const options = { question: 'Does zero correlation imply independence?', history: [], mode: 'concept' as const, model: 'test', provider: 'ollama' as const };
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    assert.match(request.messages.at(-1).content, /Zero correlation does not imply independence/);
    assert.doesNotMatch(request.messages.at(-1).content, /Pearson near zero means independence/);
    return Response.json({ message: { content: JSON.stringify({ supported: true, answer: 'No. [S1]', citations: ['S1'] }) } });
  });
  const onlyExam = await generateAnswer({ ...options, hits: [exam] });
  assert.equal(onlyExam.status, 'insufficient');
  assert.equal(onlyExam.evidence_in_model_request, false);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(onlyExam.retrieved_evidence?.[0].chunk_id, 'exam');
  assert.match(onlyExam.evidence_warning!, /選擇題/);
  const mixed = await generateAnswer({ ...options, hits: [exam, notes], quote: exam.text });
  assert.equal(mixed.status, 'answered');
  assert.equal(mixed.evidence_in_model_request, true);
  assert.equal(mixed.citations[0].chunk_id, 'notes');
  assert.match(mixed.evidence_warning!, /選擇題/);
  const regular = await generateAnswer({ ...options, hits: [notes] });
  assert.equal(regular.status, 'answered');
  assert.equal(regular.evidence_warning, undefined);
});

test('question headings identify options without suppressing ordinary notes', () => {
  const hit = { kind: 'pdf', blocks: [], section: '8. Which of the following statements about overfitting is(are) correct?' } as EvidenceRow;
  assert.equal(isQuestionOptionEvidence(hit), true);
  assert.equal(isQuestionOptionEvidence({ ...hit, section: '下列關於分類的敘述何者錯誤？' }), true);
  assert.equal(isQuestionOptionEvidence({ ...hit, section: 'Why is correct preprocessing necessary?' }), false);
  assert.equal(isQuestionOptionEvidence({ ...hit, kind: 'note' }), false);
});

test('question option detection follows blocks across pages and stops at an answer boundary', () => {
  const id = 'question-detection-test';
  const old = store.documents.get(id);
  const text = [
    '## 答案 : (C)(D)',
    '**6.** Which of these statements is **correct**?',
    '(A) A claim on page one.',
    '(B) A claim on page two.',
    '答案 : (A)',
    '(A) An unrelated item after the answer.',
  ];
  try {
    store.documents.set(id, { id, blocks: text.map((value, i) => ({ text: value, page: i < 3 ? 1 : 2 })) } as any);
    const hit = { kind: 'pdf', document_id: id, section: '答案 : (C)(D)', blocks: [3] } as EvidenceRow;
    assert.equal(isQuestionOptionEvidence(hit), true);
    assert.equal(isQuestionOptionEvidence({ ...hit, blocks: [5] }), false);
    assert.equal(isQuestionOptionEvidence({ ...hit, blocks: [1] }), false);
  } finally {
    if (old) store.documents.set(id, old);
    else store.documents.delete(id);
  }
});

test('adds valid inline citations omitted from the model citation list', async t => {
  const rows = ['first source', 'second source'].map((text, position) => ({
    id: `chunk-${position}`, document_id: `doc-${position}`, page: null, position, text, blocks: [0],
    section: 'Topic', name: 'notes', source_name: 'notes', kind: 'text', original_id: null,
  })) as EvidenceRow[];
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    message: { content: JSON.stringify({ supported: true, answer: 'Explanation [S1] and [S2].', citations: ['S2'] }) },
  }));
  const reply = await generateAnswer({ question: 'Explain', history: [], hits: rows, mode: 'concept', model: 'test', provider: 'ollama' });
  assert.equal(reply.status, 'answered');
  assert.deepEqual(reply.citations.map(c => c.label), ['S2', 'S1']);
});

test('rejects inline citation labels absent from supplied evidence', async t => {
  const hit = { id: 'a', document_id: 'doc', page: null, position: 0, text: 'Relevant course material.', blocks: [0], section: 'Topic', name: 'notes', source_name: 'notes', kind: 'text', original_id: null } as EvidenceRow;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: { content: JSON.stringify({ supported: true, answer: 'Explanation [S2]', citations: ['S1'] }) } }));
  const reply = await generateAnswer({ question: 'Explain', history: [], hits: [hit], mode: 'concept', model: 'test', provider: 'ollama' });
  assert.equal(reply.status, 'error');
  assert.equal(reply.citations.length, 0);
  assert.equal(reply.retrieved_evidence?.length, 1);
  assert.equal(reply.evidence_in_model_request, true);
});

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
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).endsWith('/api/show')) return Response.json({ thinking: { values: [false, true] } });
    return Response.json({ message: { content: JSON.stringify({
    questions: ++batch === 1 ? [
      { ...question, stem: 'Invalid index', page_ref: 1, correct_index: 99 },
      { ...question, stem: 'Valid first batch\n\noptions: [A, B, C, D]\n\ncorrect_index: 2', page_ref: 2 },
      { ...question, stem: 'Page outside first batch', page_ref: 3 },
    ] : [
      { ...question, stem: 'Valid second batch', page_ref: 4 },
      { ...question, stem: 'Invalid choice position', page_ref: 3, options: ['', 'B', 'C', 'D'] },
    ],
  }) } });
  });
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
