import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { store } from './store.js';

export interface QuantizedVector {
  data: Int8Array;
  scale: number;
}

interface VectorManifestEntry {
  key: string;
  dim: number;
  offset: number;
}

interface VectorManifest {
  schema: 'biibo-vectors-v1';
  saved_at: string;
  entries: VectorManifestEntry[];
}

const quantizedVectors = new Map<string, QuantizedVector>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInFlight: Promise<void> | null = null;
let saveDirty = false;
let pendingSaveDir: string | undefined;

function vectorPaths(dataDir?: string): { dir: string; manifestFile: string; binFile: string } {
  const dir = dataDir || path.join(process.cwd(), 'data');
  return {
    dir,
    manifestFile: path.join(dir, 'vectors.manifest.json'),
    binFile: path.join(dir, 'vectors.bin'),
  };
}

export function chunkContentHash(section: string, text: string): string {
  return createHash('sha256').update(JSON.stringify([section, text])).digest('hex');
}

export function vectorKeyFor(digest: string, chunkId: string, section: string, text: string): string {
  return `${digest}:${chunkId}:${chunkContentHash(section, text)}`;
}

export function parseVectorKey(key: string): { digest: string; chunkId: string; contentHash: string } | null {
  const lastColon = key.lastIndexOf(':');
  if (lastColon <= 0) return null;
  const contentHash = key.slice(lastColon + 1);
  if (!/^[a-f0-9]{64}$/.test(contentHash)) return null;
  const beforeHash = key.slice(0, lastColon);
  const secondColon = beforeHash.lastIndexOf(':');
  if (secondColon <= 0) return null;
  const chunkId = beforeHash.slice(secondColon + 1);
  const digest = beforeHash.slice(0, secondColon);
  if (!chunkId || !digest) return null;
  return { digest, chunkId, contentHash };
}

// Per-vector symmetric abs-max Int8 quantization preserves full [-127, 127] dynamic range for L2-normalized embeddings.
export function quantizeVector(vec: Float32Array): QuantizedVector {
  const len = vec.length;
  const data = new Int8Array(len);
  let maxAbs = 0;
  for (let i = 0; i < len; i++) {
    const a = Math.abs(vec[i]);
    if (a > maxAbs) maxAbs = a;
  }
  if (maxAbs === 0) {
    return { data, scale: 0 };
  }
  const scale = maxAbs / 127;
  const invScale = 127 / maxAbs;
  for (let i = 0; i < len; i++) {
    const q = Math.round(vec[i] * invScale);
    data[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return { data, scale };
}

export function setVector(key: string, vec: Float32Array): void {
  store.vectors.set(key, vec);
  quantizedVectors.set(key, quantizeVector(vec));
}

export function getQuantizedVector(key: string): QuantizedVector | null {
  const cached = quantizedVectors.get(key);
  if (cached) return cached;
  const raw = store.vectors.get(key);
  if (!raw) return null;
  const q = quantizeVector(raw);
  quantizedVectors.set(key, q);
  return q;
}

export function deleteVector(key: string): void {
  store.vectors.delete(key);
  quantizedVectors.delete(key);
}

export function clearVectors(): void {
  store.vectors.clear();
  quantizedVectors.clear();
}

export function pruneOrphanVectors(): number {
  const validByChunk = new Map<string, string>();
  for (const chunk of store.chunks.values()) {
    validByChunk.set(chunk.id, chunkContentHash(chunk.section, chunk.text));
  }

  let removed = 0;
  for (const key of [...store.vectors.keys()]) {
    const parsed = parseVectorKey(key);
    if (!parsed) {
      deleteVector(key);
      removed++;
      continue;
    }
    const expectedHash = validByChunk.get(parsed.chunkId);
    if (!expectedHash || expectedHash !== parsed.contentHash) {
      deleteVector(key);
      removed++;
    }
  }

  // Keep quantized cache strictly in sync with store.vectors.
  for (const key of [...quantizedVectors.keys()]) {
    if (!store.vectors.has(key)) {
      quantizedVectors.delete(key);
    }
  }
  return removed;
}

function buildBinaryPayload(): { manifest: VectorManifest; binBuffer: Buffer } {
  const entries: VectorManifestEntry[] = [];
  let totalBytes = 0;
  const vectors: Array<{ key: string; vec: Float32Array }> = [];

  for (const [key, vec] of store.vectors.entries()) {
    if (!(vec instanceof Float32Array) || vec.length === 0) continue;
    vectors.push({ key, vec });
    totalBytes += vec.length * 4;
  }

  const binBuffer = Buffer.allocUnsafe(totalBytes);
  let offset = 0;
  for (const { key, vec } of vectors) {
    const byteLen = vec.length * 4;
    for (let i = 0; i < vec.length; i++) {
      binBuffer.writeFloatLE(vec[i], offset + i * 4);
    }
    entries.push({ key, dim: vec.length, offset });
    offset += byteLen;
  }

  const manifest: VectorManifest = {
    schema: 'biibo-vectors-v1',
    saved_at: new Date().toISOString(),
    entries,
  };
  return { manifest, binBuffer };
}

export function saveVectorCacheNow(dataDir?: string): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const { dir, manifestFile, binFile } = vectorPaths(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const { manifest, binBuffer } = buildBinaryPayload();
  const stamp = `${process.pid}.${Date.now()}.sync.tmp`;
  const tmpBin = `${binFile}.${stamp}`;
  const tmpManifest = `${manifestFile}.${stamp}`;

  // Write binary payload first, then manifest, so a crash never leaves manifest referencing missing bytes.
  fs.writeFileSync(tmpBin, binBuffer);
  fs.renameSync(tmpBin, binFile);
  fs.writeFileSync(tmpManifest, JSON.stringify(manifest), 'utf-8');
  fs.renameSync(tmpManifest, manifestFile);
}

export async function saveVectorCacheAsync(dataDir?: string): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dataDir) pendingSaveDir = dataDir;
  if (saveInFlight) {
    saveDirty = true;
    return saveInFlight;
  }

  saveInFlight = (async () => {
    try {
      do {
        saveDirty = false;
        const targetDir = pendingSaveDir;
        pendingSaveDir = undefined;
        const { dir, manifestFile, binFile } = vectorPaths(targetDir);
        await fs.promises.mkdir(dir, { recursive: true });
        const { manifest, binBuffer } = buildBinaryPayload();
        const stamp = `${process.pid}.${Date.now()}.tmp`;
        const tmpBin = `${binFile}.${stamp}`;
        const tmpManifest = `${manifestFile}.${stamp}`;
        await fs.promises.writeFile(tmpBin, binBuffer);
        await fs.promises.rename(tmpBin, binFile);
        await fs.promises.writeFile(tmpManifest, JSON.stringify(manifest), 'utf-8');
        await fs.promises.rename(tmpManifest, manifestFile);
      } while (saveDirty);
    } catch (err) {
      console.error('[vectors] Failed to persist binary vector cache:', err);
    } finally {
      saveInFlight = null;
    }
  })();

  return saveInFlight;
}

export function scheduleVectorCacheSave(dataDir?: string): void {
  if (dataDir) pendingSaveDir = dataDir;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveVectorCacheAsync(pendingSaveDir);
  }, 250);
}

export function loadVectorCache(dataDir?: string): number {
  const { manifestFile, binFile } = vectorPaths(dataDir);
  if (!fs.existsSync(manifestFile) || !fs.existsSync(binFile)) return 0;

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf-8')) as Partial<VectorManifest>;
    if (!manifest || manifest.schema !== 'biibo-vectors-v1' || !Array.isArray(manifest.entries)) {
      return 0;
    }
    const bin = fs.readFileSync(binFile);
    let loaded = 0;

    for (const entry of manifest.entries) {
      if (
        !entry ||
        typeof entry.key !== 'string' ||
        typeof entry.dim !== 'number' ||
        !Number.isInteger(entry.dim) ||
        entry.dim <= 0 ||
        entry.dim > 16384 ||
        typeof entry.offset !== 'number' ||
        !Number.isInteger(entry.offset) ||
        entry.offset < 0
      ) {
        continue;
      }
      const byteEnd = entry.offset + entry.dim * 4;
      if (byteEnd > bin.length) continue;

      const vec = new Float32Array(entry.dim);
      let valid = true;
      for (let i = 0; i < entry.dim; i++) {
        const val = bin.readFloatLE(entry.offset + i * 4);
        if (!Number.isFinite(val)) {
          valid = false;
          break;
        }
        vec[i] = val;
      }
      if (!valid) continue;

      setVector(entry.key, vec);
      loaded++;
    }
    return loaded;
  } catch (err) {
    console.warn('[vectors] Ignoring unreadable local vector cache; embeddings will rebuild on demand:', err instanceof Error ? err.message : err);
    return 0;
  }
}

function exactDot(a: Float32Array, b: Float32Array): number {
  const len = a.length;
  if (len !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

function quantizedDot(a: QuantizedVector, b: QuantizedVector): number {
  const ad = a.data;
  const bd = b.data;
  const len = ad.length;
  if (len !== bd.length || a.scale === 0 || b.scale === 0) return 0;
  let sum = 0;
  for (let i = 0; i < len; i++) sum += ad[i] * bd[i];
  return sum * a.scale * b.scale;
}

export const VECTOR_PREFILTER_THRESHOLD = 1200;
export const VECTOR_SHORTLIST_SIZE = 256;

// Two-stage search: direct Float32 scan for small corpora, Int8 quantized prefilter + exact Float32 rerank for large corpora.
export function scoreDenseVectors(
  keys: string[],
  queryVec: Float32Array,
  options?: {
    prefilterThreshold?: number;
    shortlistSize?: number;
    extraCandidateIndices?: Iterable<number>;
  }
): { scores: number[]; usedPrefilter: boolean; rerankedCount: number } {
  const count = keys.length;
  const scores = new Array<number>(count).fill(0);
  if (count === 0) return { scores, usedPrefilter: false, rerankedCount: 0 };

  const threshold = options?.prefilterThreshold ?? VECTOR_PREFILTER_THRESHOLD;
  if (count <= threshold) {
    for (let i = 0; i < count; i++) {
      const vec = store.vectors.get(keys[i]);
      if (vec) scores[i] = exactDot(vec, queryVec);
    }
    return { scores, usedPrefilter: false, rerankedCount: count };
  }

  const shortlistSize = Math.max(16, Math.min(count, options?.shortlistSize ?? VECTOR_SHORTLIST_SIZE));
  const qQuant = quantizeVector(queryVec);
  const rough: Array<[number, number]> = new Array(count);
  let roughLen = 0;

  for (let i = 0; i < count; i++) {
    const qv = getQuantizedVector(keys[i]);
    if (!qv) continue;
    rough[roughLen++] = [i, quantizedDot(qv, qQuant)];
  }
  rough.length = roughLen;
  rough.sort((a, b) => b[1] - a[1] || a[0] - b[0]);

  const candidates = new Set<number>();
  const topN = Math.min(shortlistSize, rough.length);
  for (let i = 0; i < topN; i++) {
    candidates.add(rough[i][0]);
  }
  if (options?.extraCandidateIndices) {
    for (const idx of options.extraCandidateIndices) {
      if (idx >= 0 && idx < count) candidates.add(idx);
    }
  }

  for (const idx of candidates) {
    const vec = store.vectors.get(keys[idx]);
    if (vec) scores[idx] = exactDot(vec, queryVec);
  }

  return { scores, usedPrefilter: true, rerankedCount: candidates.size };
}
