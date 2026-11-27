import assert from 'node:assert/strict';
import test from 'node:test';
import { runChatCompletion } from '../src/llm.js';

test('Ollama reports an unavailable MLX runtime without exposing local paths', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(
    { error: 'MLX runtime is not available: failed to load library in C:\\private\\path' },
    { status: 500 },
  ));
  await assert.rejects(
    runChatCompletion({ provider: 'ollama', model: 'qwen3.5-4b:latest', messages: [{ role: 'user', content: 'test' }] }),
    (error: Error) => /MLX/.test(error.message) && /qwen3\.5:4b-q4_K_M/.test(error.message) && !error.message.includes('private'),
  );
});
