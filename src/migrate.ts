import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { nextSeq, persistStoreNow, store } from './store.js';
import type {
  Block, ChunkRecord, ConversationRecord, DocumentInfoRecord, DocumentRecord,
  FolderRecord, PersonalNoteRecord, Preferences, RecordEntry, TurnRecord,
} from './store.js';

export function migrateLegacyStore(): boolean {
  const filename = path.join(process.env.AITA_DATA || path.join(process.cwd(), 'aita', 'data'), 'aita.sqlite3');
  if (!fs.existsSync(filename)) return false;

  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('BEGIN');
    const rows = <T>(query: string) => db.prepare(query).all() as unknown as T[];
    const settings = rows<{value: string}>('SELECT value FROM settings WHERE id=1')[0];
    if (settings) {
      const old = JSON.parse(settings.value) as Partial<Preferences>;
      store.settings = {
        mode: old.mode === 'concept' || old.mode === 'debug' ? old.mode : 'hint',
        provider: 'ollama',
        model: typeof old.model === 'string' && old.model ? old.model : store.settings.model,
        retriever: old.retriever === 'dense' || old.retriever === 'hybrid' ? old.retriever : 'tfidf',
        language: old.language === 'en' ? 'en' : 'zh-Hant',
      };
    }

    for (const doc of rows<Omit<DocumentRecord, 'raw' | 'blocks'> & { raw: Uint8Array; blocks: string }>(
      'SELECT * FROM documents ORDER BY rowid'
    )) {
      store.documents.set(doc.id, { ...doc, active: Boolean(doc.active), official: Boolean(doc.official),
        raw: Buffer.from(doc.raw), blocks: JSON.parse(doc.blocks) as Block[] });
    }
    for (const chunk of rows<Omit<ChunkRecord, 'blocks'> & {blocks: string}>('SELECT * FROM chunks ORDER BY rowid')) {
      store.chunks.set(chunk.id, { ...chunk, blocks: JSON.parse(chunk.blocks) as number[] });
    }
    for (const asset of rows<{document_id: string; path: string; content: Uint8Array}>('SELECT * FROM assets')) {
      const assets = store.assets.get(asset.document_id) ?? new Map<string, Buffer>();
      assets.set(asset.path, Buffer.from(asset.content));
      store.assets.set(asset.document_id, assets);
    }
    for (const folder of rows<FolderRecord>('SELECT * FROM folders ORDER BY rowid')) store.folders.set(folder.id, folder);
    for (const info of rows<DocumentInfoRecord>('SELECT * FROM document_info')) store.documentInfo.set(info.document_id, info);
    for (const note of rows<PersonalNoteRecord>('SELECT * FROM personal_notes')) {
      store.personalNotes.set(note.id, { ...note, manually_edited: true });
    }
    for (const chat of rows<Omit<ConversationRecord, 'seq'>>('SELECT * FROM conversations ORDER BY rowid')) {
      store.conversations.set(chat.id, { ...chat, seq: nextSeq() });
    }
    for (const row of rows<Omit<TurnRecord, 'result'> & {result: string}>('SELECT * FROM turns ORDER BY id')) {
      store.turns.push({ ...row, result: JSON.parse(row.result) as TurnRecord['result'] });
      store.nextTurnId = Math.max(store.nextTurnId, row.id + 1);
    }
    for (const record of rows<Omit<RecordEntry, 'seq'>>('SELECT * FROM records ORDER BY rowid')) {
      store.records.set(record.id, { ...record, seq: nextSeq() });
    }
  } finally {
    db.close();
  }
  persistStoreNow();
  return true;
}
