import fs from 'node:fs';
import path from 'node:path';

export interface Block {
  text: string;
  page: number | null;
  section: string;
  type: string;
  bbox?: unknown;
}

export interface DocumentRecord {
  id: string;
  name: string;
  digest: string;
  revision: string;
  kind: 'pdf' | 'note' | 'personal' | 'text';
  active: boolean;
  raw: Buffer;
  markdown: string;
  blocks: Block[];
  original_id: string | null;
  official: boolean;
  created: string;
}

export interface ChunkRecord {
  id: string;
  document_id: string;
  position: number;
  section: string;
  page: number | null;
  text: string;
  blocks: number[];
}

export interface JobOptions {
  kind: 'pdf' | 'note' | 'personal' | 'text';
  original_id: string | null;
  official: boolean;
  folder_id?: string | null;
}

export interface JobRecord {
  id: string;
  name: string;
  state: 'queued' | 'processing' | 'ready' | 'failed';
  message: string | null;
  document_id: string | null;
  payload: Buffer | null;
  options: JobOptions;
  created: string;
  seq: number;
}

export interface ConversationRecord {
  id: string;
  title: string;
  created: string;
  seq: number;
}

export interface TurnRecord {
  id: number;
  conversation_id: string;
  question: string;
  answer: string;
  result: Record<string, unknown>;
}

export interface RecordEntry {
  id: string;
  name: string;
  content: string;
  seq: number;
}

export type EngineGroup = 'local' | 'cli' | 'cloud';

export const MODEL_PROVIDERS = [
  'ollama',
  'lmstudio',
  'antigravity-cli',
  'claude-code',
  'codex-cli',
  'gemini',
  'openai',
  'claude',
  'opencode',
  'deepseek',
  'openrouter',
] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface Preferences {
  mode: 'hint' | 'concept' | 'debug';
  provider: ModelProvider;
  model: string;
  retriever: 'tfidf' | 'dense' | 'hybrid';
  language: 'zh-Hant' | 'en';
}

export interface FolderRecord {
  id: string;
  name: string;
  parent_id: string | null;
}

export interface DocumentInfoRecord {
  document_id: string;
  summary: string | null;
  folder_id: string | null;
}

export interface PersonalNoteRecord {
  id: string;
  original_id: string | null;
  document_id: string;
  pinned?: boolean;
  role?: 'course_overview' | 'general';
  manually_edited?: boolean;
}

export type WeekType = 'lecture' | 'holiday' | 'exam' | 'activity';

export interface CourseWeekPlan {
  week_number: number;
  label: string;
  title: string;
  week_type: WeekType;
  requires_material: boolean;
  folder_id: string | null;
  folder_name: string | null;
  topics: string[];
  objectives: string[];
  milestone: string | null;
}

export interface CourseExamMilestone {
  title: string;
  date: string;
  week: number | null;
  notes: string;
}

export interface CoursePlanRecord {
  course_title: string;
  summary: string;
  source_name: string;
  parser_engine?: 'mineru' | 'pdfjs' | 'text';
  overview_note_id: string | null;
  overview_document_id: string | null;
  weeks: CourseWeekPlan[];
  exams: CourseExamMilestone[];
  updated_at: string;
}

// In-memory store mirrored to local JSON + binary blobs so state survives local restarts.
export const store = {
  documents: new Map<string, DocumentRecord>(),
  chunks: new Map<string, ChunkRecord>(),
  assets: new Map<string, Map<string, Buffer>>(),
  vectors: new Map<string, Float32Array>(),
  jobs: new Map<string, JobRecord>(),
  conversations: new Map<string, ConversationRecord>(),
  turns: [] as TurnRecord[],
  records: new Map<string, RecordEntry>(),
  folders: new Map<string, FolderRecord>(),
  documentInfo: new Map<string, DocumentInfoRecord>(),
  personalNotes: new Map<string, PersonalNoteRecord>(),
  coursePlan: null as CoursePlanRecord | null,
  settings: {
    mode: 'hint',
    provider: 'ollama',
    model: 'qwen3.5:0.8b',
    retriever: 'tfidf',
    language: 'zh-Hant',
  } as Preferences,
  nextTurnId: 1,
  nextSeq: 1,
};

export function nextSeq(): number {
  return store.nextSeq++;
}

const DATA_DIR = path.join(process.cwd(), 'data');
const BLOBS_DIR = path.join(DATA_DIR, 'blobs');
const STORE_FILE = path.join(DATA_DIR, 'biibo-store.json');
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

interface PersistedDocument {
  id: string;
  name: string;
  digest: string;
  revision: string;
  kind: 'pdf' | 'note' | 'personal' | 'text';
  active: boolean;
  raw_blob: string | null;
  markdown: string;
  blocks: Block[];
  original_id: string | null;
  official: boolean;
  created: string;
  asset_files?: Array<{ asset_path: string; blob_file: string }>;
}

interface PersistedStore {
  schema: 'biibo-store-v1';
  saved_at: string;
  nextTurnId: number;
  nextSeq: number;
  settings: Preferences;
  coursePlan: CoursePlanRecord | null;
  folders: FolderRecord[];
  documentInfo: DocumentInfoRecord[];
  personalNotes: PersonalNoteRecord[];
  documents: PersistedDocument[];
  chunks: ChunkRecord[];
  conversations: ConversationRecord[];
  turns: TurnRecord[];
  records: RecordEntry[];
}

function ensureDataDirs(): void {
  fs.mkdirSync(BLOBS_DIR, { recursive: true });
}

function safeBlobPath(filename: string): string | null {
  const base = path.basename(filename);
  if (base !== filename || !/^[a-zA-Z0-9._-]{1,140}$/.test(base)) return null;
  return path.join(BLOBS_DIR, base);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let writeInFlight: Promise<void> | null = null;
let persistDirty = false;

export function pruneOldJobs(maxJobs = 30, maxFailedPayloads = 3): void {
  const ordered = [...store.jobs.values()].sort((a, b) => b.seq - a.seq);
  let retainedFailedPayloads = 0;
  for (let i = 0; i < ordered.length; i++) {
    const job = ordered[i];
    if (i >= maxJobs) {
      job.payload = null;
      store.jobs.delete(job.id);
      continue;
    }
    if (job.state === 'failed' && job.payload) {
      // Keep only a few recent small failed payloads in memory for retry; release large/older buffers.
      if (retainedFailedPayloads >= maxFailedPayloads || job.payload.length > 8 * 1024 * 1024) {
        job.payload = null;
      } else {
        retainedFailedPayloads++;
      }
    }
  }
}

export function pruneInactiveDocuments(): void {
  const referencedDocIds = new Set<string>();
  for (const n of store.personalNotes.values()) {
    referencedDocIds.add(n.document_id);
  }
  for (const d of store.documents.values()) {
    if (d.active && d.original_id) {
      referencedDocIds.add(d.original_id);
    }
  }

  const removedIds = new Set<string>();
  for (const [id, doc] of store.documents.entries()) {
    if (!doc.active && !referencedDocIds.has(id)) {
      removedIds.add(id);
      store.documents.delete(id);
      store.assets.delete(id);
      store.documentInfo.delete(id);
    }
  }

  if (removedIds.size > 0) {
    for (const [chunkId, chunk] of store.chunks.entries()) {
      if (removedIds.has(chunk.document_id)) {
        store.chunks.delete(chunkId);
      }
    }
  }
}

function buildPersistSnapshot(): { snapshot: PersistedStore; activeBlobs: Set<string>; blobsToWrite: Array<{ fullPath: string; data: Buffer }> } {
  pruneInactiveDocuments();
  const persistedDocs: PersistedDocument[] = [];
  const activeBlobs = new Set<string>();
  const blobsToWrite: Array<{ fullPath: string; data: Buffer }> = [];

  for (const doc of store.documents.values()) {
    let rawBlob: string | null = null;
    if (doc.raw && doc.raw.length > 0 && SAFE_ID_RE.test(doc.id)) {
      const blobName = `doc_${doc.id}.bin`;
      const fullPath = safeBlobPath(blobName);
      if (fullPath) {
        activeBlobs.add(blobName);
        if (!fs.existsSync(fullPath)) {
          blobsToWrite.push({ fullPath, data: doc.raw });
        }
        rawBlob = blobName;
      }
    }

    const assetFiles: Array<{ asset_path: string; blob_file: string }> = [];
    const docAssets = store.assets.get(doc.id);
    if (docAssets && SAFE_ID_RE.test(doc.id)) {
      let aIdx = 0;
      for (const [assetPath, buf] of docAssets.entries()) {
        const ext = path.posix.extname(assetPath).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.bin';
        const blobName = `asset_${doc.id}_${aIdx++}${ext}`;
        const fullPath = safeBlobPath(blobName);
        if (fullPath) {
          activeBlobs.add(blobName);
          if (!fs.existsSync(fullPath)) {
            blobsToWrite.push({ fullPath, data: buf });
          }
          assetFiles.push({ asset_path: assetPath, blob_file: blobName });
        }
      }
    }

    persistedDocs.push({
      id: doc.id,
      name: doc.name,
      digest: doc.digest,
      revision: doc.revision,
      kind: doc.kind,
      active: doc.active,
      raw_blob: rawBlob,
      markdown: doc.markdown,
      blocks: doc.blocks,
      original_id: doc.original_id,
      official: doc.official,
      created: doc.created,
      asset_files: assetFiles.length ? assetFiles : undefined,
    });
  }

  const snapshot: PersistedStore = {
    schema: 'biibo-store-v1',
    saved_at: new Date().toISOString(),
    nextTurnId: store.nextTurnId,
    nextSeq: store.nextSeq,
    settings: store.settings,
    coursePlan: store.coursePlan,
    folders: [...store.folders.values()],
    documentInfo: [...store.documentInfo.values()],
    personalNotes: [...store.personalNotes.values()],
    documents: persistedDocs,
    chunks: [...store.chunks.values()],
    conversations: [...store.conversations.values()],
    turns: store.turns,
    records: [...store.records.values()],
  };

  return { snapshot, activeBlobs, blobsToWrite };
}

async function cleanupOrphanBlobsAsync(activeBlobs: Set<string>): Promise<void> {
  try {
    const entries = await fs.promises.readdir(BLOBS_DIR);
    for (const entry of entries) {
      if (!activeBlobs.has(entry)) {
        const fullPath = safeBlobPath(entry);
        if (fullPath) {
          await fs.promises.unlink(fullPath).catch(() => {});
        }
      }
    }
  } catch {
    // Ignore cleanup errors if directory does not exist yet.
  }
}

export async function persistStoreAsync(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (writeInFlight) {
    persistDirty = true;
    return writeInFlight;
  }

  writeInFlight = (async () => {
    try {
      await fs.promises.mkdir(BLOBS_DIR, { recursive: true });
      do {
        persistDirty = false;
        const { snapshot, activeBlobs, blobsToWrite } = buildPersistSnapshot();
        for (const item of blobsToWrite) {
          await fs.promises.writeFile(item.fullPath, item.data);
        }
        const tmpFile = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
        await fs.promises.writeFile(tmpFile, JSON.stringify(snapshot), 'utf-8');
        await fs.promises.rename(tmpFile, STORE_FILE);
        await cleanupOrphanBlobsAsync(activeBlobs);
      } while (persistDirty);
    } catch (err) {
      console.error('[store] Failed to persist local JSON store asynchronously:', err);
    } finally {
      writeInFlight = null;
    }
  })();

  return writeInFlight;
}

export function persistStoreNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  try {
    ensureDataDirs();
    const { snapshot, activeBlobs, blobsToWrite } = buildPersistSnapshot();
    for (const item of blobsToWrite) {
      fs.writeFileSync(item.fullPath, item.data);
    }
    const tmpFile = `${STORE_FILE}.${process.pid}.sync.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(snapshot), 'utf-8');
    fs.renameSync(tmpFile, STORE_FILE);
    for (const entry of fs.readdirSync(BLOBS_DIR)) {
      if (!activeBlobs.has(entry)) {
        const fullPath = safeBlobPath(entry);
        if (fullPath) {
          try {
            fs.unlinkSync(fullPath);
          } catch {
            // ignore
          }
        }
      }
    }
  } catch (err) {
    console.error('[store] Failed to persist local JSON store:', err);
  }
}

export function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistStoreAsync();
  }, 150);
}

export function loadStore(): void {
  if (!fs.existsSync(STORE_FILE)) return;
  try {
    const rawText = fs.readFileSync(STORE_FILE, 'utf-8');
    const data = JSON.parse(rawText) as Partial<PersistedStore>;
    if (!data || data.schema !== 'biibo-store-v1') return;

    store.documents.clear();
    store.chunks.clear();
    store.assets.clear();
    store.conversations.clear();
    store.turns = [];
    store.records.clear();
    store.folders.clear();
    store.documentInfo.clear();
    store.personalNotes.clear();

    if (Array.isArray(data.folders)) {
      for (const f of data.folders) {
        if (f && typeof f.id === 'string' && typeof f.name === 'string') {
          store.folders.set(f.id, {
            id: f.id,
            name: f.name,
            parent_id: typeof f.parent_id === 'string' ? f.parent_id : null,
          });
        }
      }
    }

    if (Array.isArray(data.documents)) {
      for (const d of data.documents) {
        if (!d || typeof d.id !== 'string') continue;
        let raw = Buffer.alloc(0);
        if (typeof d.raw_blob === 'string') {
          const fullPath = safeBlobPath(d.raw_blob);
          if (fullPath && fs.existsSync(fullPath)) {
            raw = fs.readFileSync(fullPath);
          }
        } else if (d.kind !== 'pdf' && typeof d.markdown === 'string') {
          raw = Buffer.from(d.markdown, 'utf-8');
        }

        store.documents.set(d.id, {
          id: d.id,
          name: String(d.name || ''),
          digest: String(d.digest || ''),
          revision: String(d.revision || ''),
          kind: d.kind === 'pdf' || d.kind === 'note' || d.kind === 'personal' ? d.kind : 'text',
          active: Boolean(d.active),
          raw,
          markdown: String(d.markdown || ''),
          blocks: Array.isArray(d.blocks) ? d.blocks : [],
          original_id: typeof d.original_id === 'string' ? d.original_id : null,
          official: Boolean(d.official),
          created: typeof d.created === 'string' ? d.created : new Date().toISOString(),
        });

        if (Array.isArray(d.asset_files) && d.asset_files.length) {
          const assetMap = new Map<string, Buffer>();
          for (const item of d.asset_files) {
            if (!item || typeof item.asset_path !== 'string' || typeof item.blob_file !== 'string') continue;
            const fullPath = safeBlobPath(item.blob_file);
            if (fullPath && fs.existsSync(fullPath)) {
              assetMap.set(item.asset_path, fs.readFileSync(fullPath));
            }
          }
          if (assetMap.size > 0) {
            store.assets.set(d.id, assetMap);
          }
        }
      }
    }

    if (Array.isArray(data.chunks)) {
      for (const c of data.chunks) {
        if (c && typeof c.id === 'string' && typeof c.document_id === 'string') {
          store.chunks.set(c.id, c);
        }
      }
    }

    if (Array.isArray(data.documentInfo)) {
      for (const info of data.documentInfo) {
        if (info && typeof info.document_id === 'string') {
          store.documentInfo.set(info.document_id, {
            document_id: info.document_id,
            summary: typeof info.summary === 'string' ? info.summary : null,
            folder_id: typeof info.folder_id === 'string' ? info.folder_id : null,
          });
        }
      }
    }

    if (Array.isArray(data.personalNotes)) {
      for (const n of data.personalNotes) {
        if (n && typeof n.id === 'string' && typeof n.document_id === 'string') {
          store.personalNotes.set(n.id, {
            id: n.id,
            original_id: typeof n.original_id === 'string' ? n.original_id : null,
            document_id: n.document_id,
            pinned: Boolean(n.pinned),
            role: n.role === 'course_overview' ? 'course_overview' : 'general',
            manually_edited: Boolean(n.manually_edited),
          });
        }
      }
    }

    if (Array.isArray(data.conversations)) {
      for (const c of data.conversations) {
        if (c && typeof c.id === 'string') {
          store.conversations.set(c.id, c);
        }
      }
    }

    if (Array.isArray(data.turns)) {
      store.turns = data.turns.filter((t) => t && typeof t.conversation_id === 'string');
    }

    if (Array.isArray(data.records)) {
      for (const r of data.records) {
        if (r && typeof r.id === 'string') {
          store.records.set(r.id, r);
        }
      }
    }

    if (data.settings && typeof data.settings === 'object') {
      const s = data.settings;
      const provider: ModelProvider =
        typeof s.provider === 'string' && (MODEL_PROVIDERS as readonly string[]).includes(s.provider)
          ? (s.provider as ModelProvider)
          : 'ollama';
      store.settings = {
        mode: s.mode === 'concept' || s.mode === 'debug' ? s.mode : 'hint',
        provider,
        model: typeof s.model === 'string' && s.model.trim() ? s.model : store.settings.model,
        retriever: s.retriever === 'dense' || s.retriever === 'hybrid' ? s.retriever : 'tfidf',
        language: s.language === 'en' ? 'en' : 'zh-Hant',
      };
    }

    if (data.coursePlan && typeof data.coursePlan === 'object') {
      store.coursePlan = data.coursePlan;
    }

    if (typeof data.nextTurnId === 'number' && data.nextTurnId > 0) {
      store.nextTurnId = data.nextTurnId;
    }
    if (typeof data.nextSeq === 'number' && data.nextSeq > 0) {
      store.nextSeq = data.nextSeq;
    }
  } catch (err) {
    console.error('[store] Failed to load local JSON store:', err);
  }
}
