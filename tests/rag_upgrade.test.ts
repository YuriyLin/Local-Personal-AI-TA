import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CHUNKER_VERSION, migrateChunksIfNeeded, semanticChunksFor } from '../src/ingest.js';
import { autoTopK, DEFAULT_RUNTIME, knownModelLimits, readRuntime, resolveRuntime } from '../src/runtime.js';
import { store } from '../src/store.js';
import type { Block, DocumentRecord } from '../src/store.js';
import { evidenceRows, generateAnswer, retrieve } from '../src/tutor.js';
import type { EvidenceRow } from '../src/tutor.js';
import {
  clearVectors,
  loadVectorCache,
  pruneOrphanVectors,
  saveVectorCacheNow,
  scoreDenseVectors,
  setVector,
  vectorKeyFor,
} from '../src/vectorStore.js';

test('adaptive auto runtime keeps local at safe 4096 while scaling CLI and Cloud to model limits', () => {
  const local = resolveRuntime(DEFAULT_RUNTIME, null, undefined, { provider: 'ollama', model: 'qwen3:4b' });
  assert.equal(local.provider_group, 'local');
  assert.equal(local.context, 4096);
  assert.equal(local.output, 512);
  assert.equal(local.top_k, 4);
  assert.equal(local.evidence_ratio, 0.68);
  assert.equal(local.max_passage_bytes, 1600);

  const localSmall = resolveRuntime(DEFAULT_RUNTIME, 2048, undefined, { provider: 'ollama', model: 'tiny' });
  assert.equal(localSmall.context, 2048);
  assert.equal(localSmall.output, 512);

  const cli = resolveRuntime(DEFAULT_RUNTIME, null, undefined, { provider: 'claude-code', model: 'sonnet' });
  assert.equal(cli.provider_group, 'cli');
  assert.equal(cli.context, 16384);
  assert.equal(cli.output, 1536);
  assert.equal(cli.top_k, 8);
  assert.equal(cli.evidence_ratio, 0.72);
  assert.equal(autoTopK(cli.context, 'a'.repeat(130), 'cli'), 10);

  const cloudGemini = resolveRuntime(
    DEFAULT_RUNTIME,
    null,
    { input_limit: 1_048_576, output_limit: 8192 },
    { provider: 'gemini', model: 'gemini-4-hydrogen' }
  );
  assert.equal(cloudGemini.provider_group, 'cloud');
  assert.equal(cloudGemini.context, 32768);
  assert.equal(cloudGemini.output, 2048);
  assert.equal(cloudGemini.top_k, 10);
  assert.equal(cloudGemini.evidence_ratio, 0.75);
  assert.equal(cloudGemini.max_passage_bytes, 3200);
  assert.equal(autoTopK(cloudGemini.context, 'a'.repeat(140), 'cloud'), 12);

  const cloudSmall = resolveRuntime(
    DEFAULT_RUNTIME,
    null,
    { input_limit: 8192, output_limit: 1024 },
    { provider: 'gemini', model: 'small-gemini' }
  );
  assert.equal(cloudSmall.context, 8192);
  assert.equal(cloudSmall.output, 1024);

  assert.equal(knownModelLimits('ollama', 'qwen3:4b').context_limit, null);
  assert.equal(knownModelLimits('openai', 'gpt-4.1-mini').context_limit, 1_047_576);

  // Widened readRuntime bounds + optional evidence_ratio
  const adv = readRuntime({ mode: 'advanced', context: 65536, output: 4096, top_k: 16, temperature: 0.2, evidence_ratio: 0.8 });
  assert.deepEqual(adv, { mode: 'advanced', context: 65536, output: 4096, top_k: 16, temperature: 0.2, evidence_ratio: 0.8 });
  assert.equal(readRuntime({ mode: 'advanced', context: 8192, output: 1024, top_k: 17, temperature: 0 }), null);
  assert.equal(readRuntime({ mode: 'advanced', context: 8192, output: 1024, top_k: 4, temperature: 0, evidence_ratio: 0.95 }), null);
});

test('semantic chunking attaches headings, keeps tables/equations/code atomic, and splits prose on sentences with overlap', () => {
  const blocks: Block[] = [
    { type: 'heading', section: 'Gradient Descent', page: 2, text: '## Gradient Descent' },
    { type: 'text', section: 'Gradient Descent', page: 2, text: 'Gradient descent updates parameters opposite to the gradient of the loss function.' },
    { type: 'text', section: 'Gradient Descent', page: 2, text: 'For example, with learning rate eta = 0.01, each step computes w <- w - eta * grad.' },
    { type: 'equation', section: 'Gradient Descent', page: 2, text: '$$\nw_{t+1} = w_t - \\eta \\nabla L(w_t)\n$$' },
    { type: 'heading', section: 'Comparison', page: 2, text: '## Comparison' },
    { type: 'table', section: 'Comparison', page: 2, text: '| Method | Step |\n| --- | --- |\n| SGD | Stochastic |\n| Adam | Adaptive |' },
    { type: 'footer', section: 'Comparison', page: 2, text: 'Page 2' },
  ];

  const chunks = semanticChunksFor(blocks);
  // First chunk merges heading + definition + example into one coherent unit with multi-block provenance.
  assert.ok(chunks[0].text.includes('## Gradient Descent'));
  assert.ok(chunks[0].text.includes('updates parameters'));
  assert.ok(chunks[0].text.includes('eta = 0.01'));
  assert.deepEqual(chunks[0].blocks, [0, 1, 2]);

  // Equation stays atomic.
  const eqChunk = chunks.find((c) => c.text.includes('\\nabla L(w_t)'));
  assert.ok(eqChunk);
  assert.deepEqual(eqChunk.blocks, [3]);

  // Heading attaches above atomic table.
  const tableChunk = chunks.find((c) => c.text.includes('| Adam | Adaptive |'));
  assert.ok(tableChunk);
  assert.ok(tableChunk.text.includes('## Comparison'));
  assert.deepEqual(tableChunk.blocks, [4, 5]);

  // Footer stays isolated in its own block so evidenceRows() can filter it.
  const footerChunk = chunks.find((c) => c.text === 'Page 2');
  assert.ok(footerChunk);
  assert.deepEqual(footerChunk.blocks, [6]);

  // Oversized prose splits cleanly at sentence boundaries without slicing decimals/words and preserves overlap.
  const sentences = Array.from({ length: 16 }, (_, i) =>
    `Sentence ${i + 1} explains rule e.g. threshold 3.${i + 1}4 clearly in complete academic prose for verification.`
  );
  const longBlocks: Block[] = [{ type: 'text', section: 'Long', page: 1, text: sentences.join(' ') }];
  const split = semanticChunksFor(longBlocks);
  assert.ok(split.length >= 2, 'Expected long paragraph to split into multiple semantic chunks');
  for (const chunk of split) {
    assert.ok(chunk.text.endsWith('.'), `Expected chunk to end cleanly on sentence boundary: ${chunk.text.slice(-30)}`);
  }
  // Consecutive chunks share at least one overlapping complete sentence.
  const overlapSentence = sentences.find((s) => split[0].text.includes(s) && split[1].text.includes(s));
  assert.ok(overlapSentence, 'Expected sentence-level overlap between consecutive chunks');
});

test('startup chunk migration rebuilds chunks in-place while preserving document IDs, folders, notes, and courses', () => {
  const docId = 'mig-doc-1';
  const noteId = 'mig-note-1';
  const oldDocs = new Map(store.documents);
  const oldChunks = new Map(store.chunks);
  const oldInfo = new Map(store.documentInfo);
  const oldNotes = new Map(store.personalNotes);
  const oldVersion = store.chunkerVersion;

  try {
    store.documents.clear();
    store.chunks.clear();
    store.documentInfo.clear();
    store.personalNotes.clear();
    store.chunkerVersion = null;

    const doc: DocumentRecord = {
      id: docId,
      name: 'lecture1.pdf',
      digest: 'd1',
      revision: 'r1',
      kind: 'pdf',
      active: true,
      raw: Buffer.from('%PDF-1.4'),
      markdown: '## Backpropagation\n\nComputes gradients via chain rule.',
      blocks: [
        { type: 'heading', section: 'Backpropagation', page: 1, text: '## Backpropagation' },
        { type: 'text', section: 'Backpropagation', page: 1, text: 'Computes gradients via chain rule.' },
        { type: 'footer', section: 'Backpropagation', page: 1, text: '1' },
      ],
      original_id: null,
      official: true,
      created: new Date().toISOString(),
    };
    store.documents.set(docId, doc);
    store.documentInfo.set(docId, { document_id: docId, summary: 'Week 1', folder_id: 'folder-w1' });
    store.personalNotes.set(noteId, { id: noteId, original_id: docId, document_id: docId, pinned: true, role: 'general' });
    // Legacy orphaned heading chunk
    store.chunks.set(`${docId}-0`, { id: `${docId}-0`, document_id: docId, position: 0, section: 'Backpropagation', page: 1, text: '## Backpropagation', blocks: [0] });

    const outcome = migrateChunksIfNeeded();
    assert.equal(outcome.migrated, true);
    assert.equal(outcome.documents, 1);
    assert.equal(store.chunkerVersion, CHUNKER_VERSION);

    // Document metadata & note linkage intact
    assert.equal(store.documents.has(docId), true);
    assert.equal(store.documentInfo.get(docId)?.folder_id, 'folder-w1');
    assert.equal(store.personalNotes.get(noteId)?.pinned, true);

    // Evidence rows now have merged heading+body and exclude footer
    const rows = evidenceRows().filter((r) => r.document_id === docId);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].text.includes('## Backpropagation'));
    assert.ok(rows[0].text.includes('chain rule'));
    assert.deepEqual(rows[0].blocks, [0, 1]);

    // Second run is a no-op
    assert.equal(migrateChunksIfNeeded().migrated, false);
  } finally {
    store.documents.clear();
    for (const [k, v] of oldDocs) store.documents.set(k, v);
    store.chunks.clear();
    for (const [k, v] of oldChunks) store.chunks.set(k, v);
    store.documentInfo.clear();
    for (const [k, v] of oldInfo) store.documentInfo.set(k, v);
    store.personalNotes.clear();
    for (const [k, v] of oldNotes) store.personalNotes.set(k, v);
    store.chunkerVersion = oldVersion;
  }
});

test('binary vector persistence round-trips Float32 vectors across restarts and prunes orphans', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biibo-vec-'));
  const oldChunks = new Map(store.chunks);
  clearVectors();

  try {
    store.chunks.clear();
    store.chunks.set('chunk-keep', {
      id: 'chunk-keep',
      document_id: 'doc-1',
      position: 0,
      section: 'Intro',
      page: 1,
      text: 'Persistent vector content',
      blocks: [0],
    });
    const keepKey = vectorKeyFor('sha256:model1', 'chunk-keep', 'Intro', 'Persistent vector content');
    const staleKey = vectorKeyFor('sha256:model1', 'chunk-keep', 'Intro', 'Old text before rechunk');
    const orphanKey = vectorKeyFor('sha256:model1', 'chunk-deleted', 'Gone', 'Deleted chunk');

    const v1 = new Float32Array([0.6, 0.8, 0, 0]);
    const v2 = new Float32Array([0, 0, 1, 0]);
    setVector(keepKey, v1);
    setVector(staleKey, v2);
    setVector(orphanKey, v2);

    saveVectorCacheNow(dir);
    assert.equal(fs.existsSync(path.join(dir, 'vectors.bin')), true);
    assert.equal(fs.existsSync(path.join(dir, 'vectors.manifest.json')), true);

    clearVectors();
    assert.equal(store.vectors.size, 0);

    const loaded = loadVectorCache(dir);
    assert.equal(loaded, 3);
    const restored = store.vectors.get(keepKey);
    assert.ok(restored);
    assert.equal(restored.length, 4);
    assert.ok(Math.abs(restored[0] - 0.6) < 1e-6);
    assert.ok(Math.abs(restored[1] - 0.8) < 1e-6);

    const pruned = pruneOrphanVectors();
    assert.equal(pruned, 2);
    assert.equal(store.vectors.size, 1);
    assert.equal(store.vectors.has(keepKey), true);
  } finally {
    clearVectors();
    store.chunks.clear();
    for (const [k, v] of oldChunks) store.chunks.set(k, v);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('two-stage Int8 quantized prefilter matches exact Float32 top-k ranking on large corpora', () => {
  clearVectors();
  const dim = 64;
  const n = 1500;
  const keys: string[] = [];

  // Deterministic pseudo-random generator
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  const normalize = (arr: Float32Array) => {
    let norm = 0;
    for (let i = 0; i < arr.length; i++) norm += arr[i] * arr[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < arr.length; i++) arr[i] /= norm;
    return arr;
  };

  try {
    const query = normalize(Float32Array.from({ length: dim }, () => rand()));
    const exactScores: Array<[number, number]> = [];

    for (let i = 0; i < n; i++) {
      const vec = normalize(Float32Array.from({ length: dim }, () => rand()));
      // Inject 5 strongly aligned vectors near query to guarantee clear top-5
      if (i % 300 === 17) {
        for (let d = 0; d < dim; d++) vec[d] = query[d] * 0.9 + vec[d] * 0.1;
        normalize(vec);
      }
      const key = `m:c${i}:${'a'.repeat(64)}`;
      keys.push(key);
      setVector(key, vec);
      let dot = 0;
      for (let d = 0; d < dim; d++) dot += vec[d] * query[d];
      exactScores.push([i, dot]);
    }

    const res = scoreDenseVectors(keys, query, { prefilterThreshold: 1200, shortlistSize: 256 });
    assert.equal(res.usedPrefilter, true);
    assert.equal(res.rerankedCount, 256);

    exactScores.sort((a, b) => b[1] - a[1]);
    const top10Exact = exactScores.slice(0, 10).map(([idx]) => idx);
    const top10TwoStage = res.scores
      .map((score, idx): [number, number] => [idx, score])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([idx]) => idx);

    assert.deepEqual(top10TwoStage, top10Exact);
    // Exact Float32 score is preserved on shortlisted winners
    for (const [idx, expected] of exactScores.slice(0, 10)) {
      assert.ok(Math.abs(res.scores[idx] - expected) < 1e-6);
    }
  } finally {
    clearVectors();
  }
});

test('retrieve supports top_k > 8 and prompt honors adaptive evidence_ratio for multi-passage questions', async (t) => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `multi-${i}`,
    document_id: `doc-${i}`,
    position: i,
    section: `Topic ${i}`,
    page: null,
    text: `Gradient optimization principle passage ${i} explains convergence step details.`,
    blocks: [0],
    name: `notes-${i}.md`,
    kind: 'text',
    original_id: null,
    official: false,
    source_name: `notes-${i}.md`,
  })) as EvidenceRow[];

  const retrieved = await retrieve(rows, 'gradient optimization principle convergence', 'tfidf', 12);
  assert.equal(retrieved.hits.length, 12);

  // Verify cloud adaptive runtime feeds significantly more evidence passages into prompt than legacy 4096/55% cap
  let sentEvidenceCount = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    const req = JSON.parse(String(options?.body));
    const userMsg = req.messages.at(-1).content as string;
    sentEvidenceCount = (userMsg.match(/\[S\d+\]/g) || []).length;
    return Response.json({
      choices: [{ message: { content: JSON.stringify({ supported: true, answer: 'Summary [S1].', citations: ['S1'] }) } }],
    });
  });

  const longHits = rows.map((r) => ({ ...r, text: `${r.text} `.repeat(12) }));
  const cloudRuntime = resolveRuntime(DEFAULT_RUNTIME, null, { input_limit: 128_000, output_limit: 4096 }, { provider: 'openai', model: 'gpt-4o' });
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  try {
    const reply = await generateAnswer({
      question: 'Summarize gradient optimization principles',
      history: [],
      hits: longHits,
      mode: 'ask',
      provider: 'openai',
      model: 'gpt-4o',
      runtime: cloudRuntime,
    });
    assert.equal(reply.status, 'answered');
    assert.equal(sentEvidenceCount, 12);
  } finally {
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldKey;
  }
});
