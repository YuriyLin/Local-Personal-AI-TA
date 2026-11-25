import crypto from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import { Block, DocumentRecord, store } from './store.js';

export const MAX_UPLOAD = 50 * 1024 * 1024;
export const PARSER_REVISION = 'blocks-v1';

const PAGE_LINE_RE = /^<!--\s*page:\s*(\d+)\s*-->$/;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256Digest(data: Buffer | string): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

function stripBom(buf: Buffer): string {
  const str = buf.toString('utf-8');
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

function mimeTypeForMinerU(name: string): { mime: string; isImage: boolean } {
  const ext = path.posix.extname(name).toLowerCase();
  if (ext === '.png') return { mime: 'image/png', isImage: true };
  if (ext === '.jpg' || ext === '.jpeg') return { mime: 'image/jpeg', isImage: true };
  if (ext === '.webp') return { mime: 'image/webp', isImage: true };
  if (ext === '.gif') return { mime: 'image/gif', isImage: true };
  return { mime: 'application/pdf', isImage: false };
}

export async function mineruParse(
  name: string,
  raw: Buffer,
  options?: { ocrMode?: 'auto' | 'ocr' }
): Promise<Buffer> {
  const { mime, isImage } = mimeTypeForMinerU(name);
  const ocrMode = options?.ocrMode ?? (isImage ? 'ocr' : 'auto');
  const base = (process.env.AITA_MINERU_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const origin = new URL(base);
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(origin.hostname) ||
    origin.username
  ) {
    throw new Error('MinerU 位址必須是本機 HTTP 服務。');
  }

  const req = async (method: string, targetPath: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> => {
    const url = new URL(targetPath, `${base}/`);
    if (url.origin !== origin.origin) {
      throw new Error('MinerU 回傳了外部位址。');
    }
    const res = await fetch(url.toString(), {
      ...init,
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || (res.status >= 300 && res.status < 400)) {
      throw new Error(`MinerU HTTP ${res.status}`);
    }
    return res;
  };

  const spec = (await (await req('GET', '/openapi.json', {}, 2500)).json()) as { paths?: Record<string, unknown> };
  const paths = spec.paths || {};

  if ('/v1/tasks' in paths) {
    const taskRes = await req(
      'POST',
      '/v1/tasks',
      {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: [{ file_name: name, bytes: raw.length }],
          output_formats: ['default'],
          ocr_mode: ocrMode,
        }),
      },
      15000
    );
    const task = (await taskRes.json()) as {
      task_id: string;
      files: Array<{ upload?: { url: string; headers?: Record<string, string> } }>;
    };
    const upload = task.files[0]?.upload;
    if (upload) {
      await req('PUT', upload.url, { headers: upload.headers, body: new Uint8Array(raw) }, 45000);
    }
    const deadline = Date.now() + 360_000;
    while (Date.now() < deadline) {
      const statusRes = await req('GET', `/v1/tasks/${task.task_id}`, {}, 10000);
      const status = (await statusRes.json()) as {
        files: Array<{ status: string; result_url?: string }>;
      };
      const item = status.files[0];
      if (item?.status === 'completed' && item.result_url) {
        const resultRes = await req('GET', item.result_url, {}, 60000);
        return Buffer.from(await resultRes.arrayBuffer());
      }
      if (item?.status === 'failed' || item?.status === 'canceled') {
        throw new Error('MinerU 解析失敗，請查看本機 MinerU 日誌。');
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('MinerU 解析逾時。');
  }

  if ('/file_parse' in paths) {
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(raw)], { type: mime }), name);
    form.append('return_content_list', 'true');
    form.append('return_md', 'true');
    form.append('return_images', 'true');
    form.append('table_enable', 'true');
    form.append('formula_enable', 'true');
    if (ocrMode === 'ocr') {
      form.append('parse_method', 'ocr');
    }
    const res = await req('POST', '/file_parse', { body: form }, 360_000);
    return Buffer.from(await res.arrayBuffer());
  }

  throw new Error('服務未提供 /v1/tasks 或 /file_parse。');
}

export async function extractPdfLocally(raw: Buffer): Promise<{ markdown: string; blocks: Block[]; assets: Map<string, Buffer> }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(raw),
    useSystemFonts: true,
    disableFontFace: true,
  });
  const pdf = await loadingTask.promise;
  const blocks: Block[] = [];
  const mdParts: string[] = [];

  try {
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const lines: string[] = [];
      let currentLine = '';
      let lastY: number | null = null;

      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        const text = item.str;
        const transform = 'transform' in item && Array.isArray(item.transform) ? item.transform : null;
        const y: number | null = transform ? Math.round(Number(transform[5])) : lastY;

        if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
          if (currentLine.trim()) lines.push(currentLine.trim());
          currentLine = text;
        } else {
          currentLine += (currentLine && text && !currentLine.endsWith(' ') && !text.startsWith(' ') ? ' ' : '') + text;
        }
        if ('hasEOL' in item && item.hasEOL) {
          if (currentLine.trim()) lines.push(currentLine.trim());
          currentLine = '';
        }
        lastY = y;
      }
      if (currentLine.trim()) lines.push(currentLine.trim());

      const pageText = lines.join('\n').trim();
      const content = pageText || `(PDF Page ${pageNum})`;
      const section = lines[0]?.slice(0, 80) || `Page ${pageNum}`;
      blocks.push({
        text: content,
        page: pageNum,
        section,
        type: 'text',
      });
      mdParts.push(`<!-- page: ${pageNum} -->\n${content}`);
    }
  } finally {
    await loadingTask.destroy();
  }

  return {
    markdown: mdParts.join('\n\n'),
    blocks,
    assets: new Map<string, Buffer>(),
  };
}

export async function unpack(payload: Buffer): Promise<{
  markdown: string;
  structured: unknown;
  assets: Map<string, Buffer>;
}> {
  if (!(payload.length >= 2 && payload[0] === 0x50 && payload[1] === 0x4b)) {
    const parsed = JSON.parse(payload.toString('utf-8')) as Record<string, unknown>;
    const result = (
      parsed.results && typeof parsed.results === 'object'
        ? Object.values(parsed.results as Record<string, unknown>)[0]
        : parsed
    ) as Record<string, unknown>;
    let items: unknown = result.content_list ?? result;
    if (typeof items === 'string') {
      items = JSON.parse(items);
    }
    return {
      markdown: typeof result.md_content === 'string' ? result.md_content : '',
      structured: items,
      assets: new Map(),
    };
  }

  const archive = await JSZip.loadAsync(payload);
  const files = Object.keys(archive.files)
    .filter((f) => !archive.files[f].dir)
    .sort();

  let totalSize = 0;
  for (const f of files) {
    const entry = archive.files[f] as JSZip.JSZipObject & { _data?: { uncompressedSize?: number } };
    totalSize += entry._data?.uncompressedSize ?? 0;
  }
  if (totalSize > 120 * 1024 * 1024) {
    throw new Error('MinerU ZIP 解壓後太大。');
  }

  const structuredFile =
    files.find((f) => path.posix.basename(f) === 'structured_content.json') ||
    files.find((f) => f.endsWith('content_list.json'));
  if (!structuredFile) {
    throw new Error('缺少 MinerU structured_content.json 或 content_list.json。');
  }

  const mdFile =
    files.find((f) => f.endsWith('markdown.md')) || files.find((f) => f.endsWith('.md'));

  const assets = new Map<string, Buffer>();
  for (const f of files) {
    const parts = f.split('/');
    const ext = path.posix.extname(f).toLowerCase();
    if (parts.includes('images') && !parts.includes('..') && IMAGE_EXTENSIONS.has(ext)) {
      const content = await archive.files[f].async('nodebuffer');
      assets.set(`images/${path.posix.basename(f)}`, content);
    }
  }

  const mdText = mdFile ? await archive.files[mdFile].async('string') : '';
  const structuredText = await archive.files[structuredFile].async('string');
  return {
    markdown: mdText,
    structured: JSON.parse(structuredText),
    assets,
  };
}

export function noteBlocks(markdown: string): Block[] {
  let section = '';
  let page: number | null = null;
  let fence = '';
  let buf: string[] = [];
  const blocks: Block[] = [];
  const lines = markdown.split(/\r?\n/);

  for (let pos = 0; pos < lines.length; pos++) {
    const line = lines[pos];
    const marker = /^\s*([~`]{3,})/.exec(line);
    if (marker) {
      if (!fence) {
        fence = marker[1];
      } else if (marker[1].startsWith(fence)) {
        fence = '';
      }
      buf.push(line);
      continue;
    }

    const heading = !fence ? HEADING_RE.exec(line) : null;
    const locator = !fence ? PAGE_LINE_RE.exec(line.trim()) : null;

    if (locator && buf.length === 1 && HEADING_RE.test(buf[0])) {
      page = Number.parseInt(locator[1], 10);
      continue;
    }

    if (heading || locator) {
      if (buf.join('').trim()) {
        blocks.push({ text: buf.join('\n').trim(), section, page, type: 'text' });
      }
      buf = [];
      if (heading) {
        section = heading[2];
        page = null;
        if (pos + 1 < lines.length) {
          const nextPage = PAGE_LINE_RE.exec(lines[pos + 1].trim());
          if (nextPage) {
            page = Number.parseInt(nextPage[1], 10);
          }
        }
        buf = [line];
      } else if (locator) {
        page = Number.parseInt(locator[1], 10);
      }
    } else {
      buf.push(line);
    }
  }

  if (buf.join('').trim()) {
    blocks.push({ text: buf.join('\n').trim(), section, page, type: 'text' });
  }
  return blocks;
}

export function pdfBlocks(structured: unknown): Block[] {
  let section = '';
  const entries: Array<[unknown, Record<string, unknown>]> = [];

  if (structured && typeof structured === 'object' && !Array.isArray(structured) && 'pages' in structured) {
    const pages = (structured as { pages: Array<{ page_idx?: unknown; blocks: Array<Record<string, unknown>> }> }).pages;
    for (const p of pages) {
      for (const b of p.blocks) {
        entries.push([p.page_idx, b]);
      }
    }
  } else if (Array.isArray(structured)) {
    for (const b of structured as Array<Record<string, unknown>>) {
      entries.push([b.page_idx, b]);
    }
  }

  const blocks: Block[] = [];
  for (const [index, block] of entries) {
    const kind = typeof block.type === 'string' ? block.type : '';
    const rawContent = block.content ?? block.text ?? '';
    let content =
      typeof rawContent === 'string'
        ? rawContent
        : Array.isArray(rawContent)
          ? rawContent.map((v) => String(v)).join(' ')
          : '';

    const captionValues = (block.captions || block.image_caption || []) as Array<unknown>;
    const captions = captionValues
      .map((c) => (c && typeof c === 'object' && 'content' in c ? String((c as { content?: unknown }).content || '') : String(c)))
      .join(' ');

    const imageSrc = (block.image_source || block.img_path) as string | undefined;

    if (['doc_title', 'paragraph_title', 'heading', 'title'].includes(kind) || block.text_level) {
      section = content;
      content = `## ${content}`;
    } else if (['equation', 'interline_equation'].includes(kind) && content && !content.startsWith('$')) {
      content = `$$\n${content}\n$$`;
    } else if (kind === 'table') {
      content = typeof block.table_body === 'string' ? block.table_body : content;
    } else if (kind === 'code') {
      content = typeof block.code_body === 'string' ? block.code_body : content;
      if (block.sub_type !== 'algorithm') {
        content = '```\n' + content + '\n```';
      }
    }

    if (imageSrc && (!content || kind === 'image')) {
      const normalized = `images/${path.posix.basename(imageSrc)}`;
      content = `![${captions || 'PDF 圖片'}](${normalized})`;
    }

    const text = [captions, content].filter((t) => t.trim()).join('\n\n');
    if (text.trim()) {
      const page = typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index + 1 : null;
      blocks.push({
        text,
        page,
        section,
        type: kind,
        bbox: block.bbox,
      });
    }
  }

  return blocks;
}

export function chunksFor(blocks: Block[]): Array<[number, string]> {
  const result: Array<[number, string]> = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    const text = block.text;
    const isStructured =
      ['table', 'equation', 'interline_equation', 'code', 'image'].includes(block.type) ||
      text.includes('```') ||
      /^\|.*\|$/m.test(text);
    const sections = isStructured ? [text] : text.split(/\n\s*\n/);
    for (const sec of sections) {
      if (!sec.trim()) continue;
      if (isStructured || sec.length <= 420) {
        result.push([index, sec.trim()]);
        continue;
      }
      for (let offset = 0; offset < sec.length; offset += 380) {
        result.push([index, sec.slice(Math.max(0, offset - 45), offset + 380).trim()]);
      }
    }
  }
  return result;
}

export async function ingestDocument(params: {
  name: string;
  raw: Buffer;
  kind: 'pdf' | 'note' | 'personal' | 'text';
  originalId?: string | null;
  bundle?: Buffer | null;
  official?: boolean;
  noteId?: string | null;
}): Promise<string> {
  const { name, raw, kind, originalId = null, official = false, noteId = null } = params;
  let { bundle = null } = params;
  const digest = sha256Hex(raw);
  let assets = new Map<string, Buffer>();
  let markdown = '';
  let blocks: Block[] = [];
  let revisionData: Buffer;

  if (kind === 'pdf') {
    if (!raw.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new Error('檔案不是有效 PDF。');
    }

    if (bundle) {
      const unpacked = await unpack(bundle);
      markdown = unpacked.markdown;
      assets = unpacked.assets;
      blocks = pdfBlocks(unpacked.structured);
    } else {
      // Try local MinerU first; if unavailable in the cloud environment, extract text directly with PDF.js.
      try {
        bundle = await mineruParse(name, raw);
        const unpacked = await unpack(bundle);
        markdown = unpacked.markdown;
        assets = unpacked.assets;
        blocks = pdfBlocks(unpacked.structured);
      } catch (err) {
        console.warn('[ingest] MinerU unavailable, falling back to local PDF.js:', err instanceof Error ? err.message : err);
        const local = await extractPdfLocally(raw);
        markdown = local.markdown;
        blocks = local.blocks;
        assets = local.assets;
      }
    }

    const canonical = Buffer.from(JSON.stringify(blocks));
    const assetHashes = [...assets.keys()]
      .sort()
      .map((k) => sha256Digest(assets.get(k)!));
    revisionData = Buffer.concat([canonical, Buffer.from(markdown), ...assetHashes]);
  } else {
    markdown = stripBom(raw);
    blocks = noteBlocks(markdown);
    if (kind !== 'note' && kind !== 'personal') {
      blocks = blocks.map((b) => ({ ...b, page: null }));
    }
    revisionData = raw;
  }

  if (!blocks.length) {
    throw new Error('檔案沒有可用文字或來源區塊。');
  }
  markdown = markdown || blocks.map((b) => b.text).join('\n\n');
  const revision = sha256Hex(revisionData);
  const keyParts: unknown[] = [kind, name, digest, revision, originalId, PARSER_REVISION];
  if (official) keyParts.push('official');
  if (noteId) keyParts.push(noteId);
  const documentId = sha256Hex(JSON.stringify(keyParts)).slice(0, 24);

  if (kind === 'note') {
    const original = originalId ? store.documents.get(originalId) : undefined;
    if (!original || original.kind !== 'pdf') {
      throw new Error('筆記需要指定已匯入的原始 PDF。');
    }
    const pages = new Set(original.blocks.map((b) => b.page).filter((p): p is number => p !== null));
    if (
      !blocks.some((b) => b.page !== null) ||
      blocks.some((b) => b.page !== null && !pages.has(b.page))
    ) {
      throw new Error('筆記至少需要一個有效的 <!-- page: N -->，所有頁碼均須可追溯。');
    }
  } else if (kind === 'personal' && originalId) {
    const original = store.documents.get(originalId);
    if (!original || !original.active) {
      throw new Error('找不到關聯的教材，請重新選擇或儲存為獨立筆記。');
    }
  }

  if (!store.documents.has(documentId)) {
    const docRecord: DocumentRecord = {
      id: documentId,
      name,
      digest,
      revision,
      kind,
      active: true,
      raw,
      markdown,
      blocks,
      original_id: originalId,
      official,
      created: new Date().toISOString(),
    };
    store.documents.set(documentId, docRecord);

    const chunkList = chunksFor(blocks);
    chunkList.forEach(([blockId, text], i) => {
      const block = blocks[blockId];
      if (kind === 'note' && !block.page) return;
      const section =
        kind === 'personal'
          ? [name, block.section].filter(Boolean).join(' · ')
          : block.section;
      const chunkId = `${documentId}-${i}`;
      store.chunks.set(chunkId, {
        id: chunkId,
        document_id: documentId,
        position: i,
        section,
        page: block.page,
        text,
        blocks: [blockId],
      });
    });

    if (assets.size > 0) {
      store.assets.set(documentId, assets);
    }
  }

  if (noteId) {
    const doc = store.documents.get(documentId);
    if (doc) doc.active = true;
  } else {
    for (const doc of store.documents.values()) {
      if (doc.name === name && doc.kind === kind && doc.original_id === originalId) {
        doc.active = doc.id === documentId;
      }
    }
  }

  return documentId;
}
