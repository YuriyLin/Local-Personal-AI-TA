import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('missing referenced files prevent loading and leave the stored data intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biibo-integrity-'));
  const data = path.join(dir, 'data');
  const blobs = path.join(data, 'blobs');
  const storeFile = path.join(data, 'biibo-store.json');
  fs.mkdirSync(blobs, { recursive: true });
  const snapshot = JSON.stringify({ schema: 'biibo-store-v1', documents: [{ id: 'a', name: 'test.pdf', kind: 'pdf', active: true, raw_blob: 'doc_a.bin', blocks: [], asset_files: [{ asset_path: 'image.png', blob_file: 'asset_a_0.png' }] }] });
  fs.writeFileSync(storeFile, snapshot);
  const cli = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
  const modulePath = fileURLToPath(new URL('../src/store.ts', import.meta.url));
  const code = `import { loadStore } from ${JSON.stringify(modulePath)}; try { loadStore(); console.log('loaded'); } catch (error) { console.error(error.cause?.message || error.message); process.exitCode = 1; }`;
  const run = () => spawnSync(process.execPath, [cli, '-e', code], { cwd: dir, encoding: 'utf8' });
  try {
    const missing = run();
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /2 missing or invalid file/);
    assert.equal(fs.readFileSync(storeFile, 'utf8'), snapshot);
    fs.writeFileSync(path.join(blobs, 'doc_a.bin'), 'pdf');
    fs.writeFileSync(path.join(blobs, 'asset_a_0.png'), 'image');
    const restored = run();
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /loaded/);
  } finally {
    assert.ok(dir.startsWith(path.join(os.tmpdir(), 'biibo-integrity-')));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
