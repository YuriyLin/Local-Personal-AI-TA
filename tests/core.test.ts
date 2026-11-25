import assert from 'node:assert/strict';
import test from 'node:test';
import { isBlockedHost, isSafeModelName, isValidProvider, parseJsonFromLlm, stripThinkAndFence } from '../src/llm.js';
import { renderMarkdown, sanitizeLatexDelimiters } from '../src/markdown.js';
import { MODEL_PROVIDERS, pruneInactiveDocuments, pruneOldJobs, store } from '../src/store.js';
import { classifySyllabusWeek, stratifiedSamplePages } from '../src/study.js';

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
