import crypto from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import { Block, DocumentRecord, store } from './store.js';

export const MAX_UPLOAD = 50 * 1024 * 1024;
export const PARSER_REVISION = 'blocks-v1';
export const CHUNKER_VERSION = 'semantic-v2';

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

export interface SemanticChunk {
  blocks: number[];
  text: string;
  section: string;
  page: number | null;
}

const SEMANTIC_TARGET_CHARS = 620;
const SEMANTIC_MAX_CHARS = 840;
const OVERLAP_MIN_CHARS = 75;
const OVERLAP_MAX_CHARS = 150;

const ANSWER_BOUNDARY_RE = /^\s*[#*\s]*(?:答案|answer|solution)\s*[:：]/i;
const STRUCTURED_BLOCK_TYPES = new Set(['table', 'equation', 'interline_equation', 'code', 'image']);
const HEADING_BLOCK_TYPES = new Set(['doc_title', 'paragraph_title', 'heading', 'title']);
const EXCLUDED_BLOCK_TYPES = new Set(['footer', 'page_number']);

function isHeadingOnlyText(text: string): boolean {
  const trimmed = text.trim();
  return /^#{1,6}\s+\S/.test(trimmed) && !trimmed.includes('\n');
}

function isHeadingBlock(block: Block): boolean {
  return HEADING_BLOCK_TYPES.has(block.type) || isHeadingOnlyText(block.text);
}

function isAtomicStructuredBlock(block: Block): boolean {
  if (STRUCTURED_BLOCK_TYPES.has(block.type)) return true;
  const trimmed = block.text.trim();
  if (/^\$\$[\s\S]*\$\$$/.test(trimmed)) return true;
  return false;
}

interface TextUnit {
  blockIdx: number;
  text: string;
  atomic: boolean;
  isHeading: boolean;
}

// Parse a single block into paragraph / fenced-code / display-math / table / heading units without splitting atomic elements.
function extractUnitsFromBlock(block: Block, blockIdx: number): TextUnit[] {
  const raw = block.text.trim();
  if (!raw) return [];
  if (isAtomicStructuredBlock(block)) {
    return [{ blockIdx, text: raw, atomic: true, isHeading: false }];
  }
  if (isHeadingBlock(block) && !raw.includes('\n')) {
    return [{ blockIdx, text: raw, atomic: false, isHeading: true }];
  }

  const lines = raw.split(/\r?\n/);
  const units: TextUnit[] = [];
  let buf: string[] = [];
  let fence = '';
  let inMath = false;
  let inTable = false;

  const flushBuf = (atomic: boolean) => {
    const joined = buf.join('\n').trim();
    buf = [];
    if (!joined) return;
    units.push({
      blockIdx,
      text: joined,
      atomic,
      isHeading: !atomic && isHeadingOnlyText(joined),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Fenced code blocks
    const fenceMatch = /^\s*([`~]{3,})/.exec(line);
    if (fenceMatch && !inMath) {
      if (!fence) {
        if (buf.length) flushBuf(inTable);
        inTable = false;
        fence = fenceMatch[1];
        buf.push(line);
      } else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) {
        buf.push(line);
        fence = '';
        flushBuf(true);
      } else {
        buf.push(line);
      }
      continue;
    }
    if (fence) {
      buf.push(line);
      continue;
    }

    // Display math blocks ($$ ... $$)
    if (trimmed === '$$' || (trimmed.startsWith('$$') && !trimmed.slice(2).includes('$$'))) {
      if (!inMath) {
        if (buf.length) flushBuf(inTable);
        inTable = false;
        inMath = true;
        buf.push(line);
      } else {
        buf.push(line);
        inMath = false;
        flushBuf(true);
      }
      continue;
    }
    if (inMath) {
      buf.push(line);
      continue;
    }
    if (/^\$\$[\s\S]+\$\$$/.test(trimmed)) {
      if (buf.length) flushBuf(inTable);
      inTable = false;
      units.push({ blockIdx, text: trimmed, atomic: true, isHeading: false });
      continue;
    }

    // Markdown table rows
    const isTableLine = /^\|.*\|$/.test(trimmed);
    if (isTableLine) {
      if (!inTable && buf.length) flushBuf(false);
      inTable = true;
      buf.push(line);
      continue;
    }
    if (inTable) {
      flushBuf(true);
      inTable = false;
    }

    // Blank line ends paragraph
    if (!trimmed) {
      if (buf.length) flushBuf(false);
      continue;
    }

    // Standalone markdown heading line
    if (/^#{1,6}\s+\S/.test(trimmed)) {
      if (buf.length) flushBuf(false);
      units.push({ blockIdx, text: trimmed, atomic: false, isHeading: true });
      continue;
    }

    buf.push(line);
  }

  if (buf.length) {
    flushBuf(Boolean(fence) || inMath || inTable);
  }
  return units;
}

// Split prose into complete sentences while avoiding decimals (3.14) and common abbreviations (e.g., i.e., Fig.).
function splitIntoSentences(text: string): string[] {
  const sentences: string[] = [];
  const abbrRe = /(?:^|[\s(])(?:e\.g|i\.e|vs|etc|fig|eq|dr|mr|ms|prof|no|vol|sec|ch|al|st)\.$/i;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1] || '';
    const prev = text[i - 1] || '';

    // CJK sentence-ending punctuation
    if (ch === '。' || ch === '！' || ch === '？' || ch === '；') {
      let end = i + 1;
      while (end < text.length && /[」』”’）)\]]/.test(text[end])) end++;
      const piece = text.slice(start, end).trim();
      if (piece) sentences.push(piece);
      while (end < text.length && /\s/.test(text[end])) end++;
      start = end;
      i = end - 1;
      continue;
    }

    // Latin sentence-ending punctuation followed by whitespace or end of string
    if ((ch === '.' || ch === '!' || ch === '?' || ch === ';') && (next === '' || /\s/.test(next) || /[)"'\]」』]/.test(next))) {
      // Skip decimal numbers like 3.14 or numbered list prefixes like "1. "
      if (ch === '.' && /\d/.test(prev) && (/\d/.test(next) || /^\s*\d+\.$/.test(text.slice(start, i + 1)))) {
        continue;
      }
      if (ch === '.' && abbrRe.test(text.slice(Math.max(start, i - 10), i + 1))) {
        continue;
      }
      let end = i + 1;
      while (end < text.length && /[)"'\]」』]/.test(text[end])) end++;
      if (end < text.length && !/\s/.test(text[end])) continue;
      const piece = text.slice(start, end).trim();
      if (piece) sentences.push(piece);
      while (end < text.length && /\s/.test(text[end])) end++;
      start = end;
      i = end - 1;
    }
  }

  const tail = text.slice(start).trim();
  if (tail) sentences.push(tail);
  return sentences.length ? sentences : [text.trim()].filter(Boolean);
}

function splitLongSentence(sentence: string, maxChars: number): string[] {
  if (sentence.length <= maxChars) return [sentence];

  // Try clause punctuation first (commas, colons, CJK commas).
  const clauses = sentence
    .split(/(?<=[，、：:,])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (clauses.length > 1) {
    const packed: string[] = [];
    let current = '';
    for (const clause of clauses) {
      if (!current) {
        current = clause;
      } else if (current.length + 1 + clause.length <= maxChars) {
        current = `${current} ${clause}`;
      } else {
        packed.push(current);
        current = clause;
      }
    }
    if (current) packed.push(current);
    if (packed.every((p) => p.length <= maxChars)) return packed;
  }

  // Fallback: split on whitespace word boundaries, or hard slice only for unbroken strings.
  const out: string[] = [];
  let pos = 0;
  while (pos < sentence.length) {
    let end = Math.min(sentence.length, pos + maxChars);
    if (end < sentence.length) {
      const spaceIdx = sentence.lastIndexOf(' ', end);
      if (spaceIdx > pos + Math.floor(maxChars * 0.55)) {
        end = spaceIdx;
      }
    }
    const part = sentence.slice(pos, end).trim();
    if (part) out.push(part);
    pos = end;
    while (pos < sentence.length && sentence[pos] === ' ') pos++;
  }
  return out;
}

function splitOversizedProse(text: string): string[] {
  // First preserve list-item or line boundaries if the paragraph is a multi-line list.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const isListLike =
    lines.length > 1 &&
    lines.filter((l) => /^(?:[-*+•]|\d+[.)、]|\([A-Za-z0-9]+\))\s+/.test(l)).length >= 2;

  const segments: string[] = [];
  if (isListLike) {
    for (const line of lines) {
      if (line.length <= SEMANTIC_MAX_CHARS) {
        segments.push(line);
      } else {
        for (const s of splitIntoSentences(line)) {
          segments.push(...splitLongSentence(s, SEMANTIC_TARGET_CHARS));
        }
      }
    }
  } else {
    for (const s of splitIntoSentences(text)) {
      segments.push(...splitLongSentence(s, SEMANTIC_TARGET_CHARS));
    }
  }

  const sep = isListLike ? '\n' : ' ';
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  const trailingOverlap = (parts: string[]): string[] => {
    const picked: string[] = [];
    let total = 0;
    for (let i = parts.length - 1; i >= 0; i--) {
      const seg = parts[i];
      if (picked.length >= 2) break;
      if (total > 0 && total + seg.length + 1 > OVERLAP_MAX_CHARS) break;
      if (picked.length === 0 && seg.length > OVERLAP_MAX_CHARS + 30) break;
      picked.unshift(seg);
      total += seg.length + (picked.length > 1 ? 1 : 0);
      if (total >= OVERLAP_MIN_CHARS) break;
    }
    return picked;
  };

  for (const seg of segments) {
    const addedLen = current.length ? currentLen + sep.length + seg.length : seg.length;
    if (current.length > 0 && addedLen > SEMANTIC_TARGET_CHARS && currentLen >= Math.floor(SEMANTIC_TARGET_CHARS * 0.5)) {
      chunks.push(current.join(sep).trim());
      const overlap = trailingOverlap(current);
      // Only carry overlap if it leaves room for the new segment without exceeding max.
      const overlapLen = overlap.reduce((sum, s) => sum + s.length, 0) + Math.max(0, overlap.length - 1) * sep.length;
      if (overlap.length > 0 && overlapLen + sep.length + seg.length <= SEMANTIC_MAX_CHARS) {
        current = [...overlap, seg];
        currentLen = overlapLen + sep.length + seg.length;
      } else {
        current = [seg];
        currentLen = seg.length;
      }
    } else {
      current.push(seg);
      currentLen = addedLen;
    }
  }

  if (current.length) {
    const finalText = current.join(sep).trim();
    // Avoid emitting a tiny orphan tail if it comfortably fits the previous chunk.
    if (chunks.length > 0 && finalText.length < 140 && chunks[chunks.length - 1].length + sep.length + finalText.length <= SEMANTIC_MAX_CHARS + 60) {
      chunks[chunks.length - 1] = `${chunks[chunks.length - 1]}${sep}${finalText}`.trim();
    } else if (finalText) {
      chunks.push(finalText);
    }
  }
  return chunks;
}

function uniqueSorted(nums: number[]): number[] {
  return [...new Set(nums)].sort((a, b) => a - b);
}

export function semanticChunksFor(blocks: Block[]): SemanticChunk[] {
  const results: SemanticChunk[] = [];

  interface SectionGroup {
    page: number | null;
    section: string;
    units: TextUnit[];
  }

  const flushGroup = (group: SectionGroup | null) => {
    if (!group || group.units.length === 0) return;

    let pendingTexts: string[] = [];
    let pendingBlocks: number[] = [];
    let pendingLen = 0;
    let pendingHeadingOnly = false;
    let activeHeading: string | null = null;

    const emitPending = () => {
      const text = pendingTexts.join('\n\n').trim();
      if (text) {
        results.push({
          blocks: uniqueSorted(pendingBlocks),
          text,
          section: group.section,
          page: group.page,
        });
      }
      pendingTexts = [];
      pendingBlocks = [];
      pendingLen = 0;
      pendingHeadingOnly = false;
    };

    const appendUnit = (unit: TextUnit) => {
      pendingTexts.push(unit.text);
      pendingBlocks.push(unit.blockIdx);
      pendingLen = pendingTexts.reduce((sum, s) => sum + s.length, 0) + Math.max(0, pendingTexts.length - 1) * 2;
      pendingHeadingOnly = pendingHeadingOnly && unit.isHeading;
    };

    for (const unit of group.units) {
      if (unit.isHeading) {
        if (pendingTexts.length && !pendingHeadingOnly) {
          emitPending();
        }
        activeHeading = unit.text;
        pendingTexts.push(unit.text);
        pendingBlocks.push(unit.blockIdx);
        pendingLen = pendingTexts.reduce((sum, s) => sum + s.length, 0) + Math.max(0, pendingTexts.length - 1) * 2;
        pendingHeadingOnly = true;
        continue;
      }

      if (unit.atomic) {
        if (pendingHeadingOnly) {
          // Attach heading directly above the atomic table/equation/code block.
          appendUnit(unit);
          emitPending();
        } else {
          if (pendingTexts.length) emitPending();
          results.push({
            blocks: [unit.blockIdx],
            text: unit.text,
            section: group.section,
            page: group.page,
          });
        }
        continue;
      }

      // Normal prose unit
      if (unit.text.length > SEMANTIC_MAX_CHARS) {
        const prefixText = pendingHeadingOnly ? pendingTexts.join('\n\n') : null;
        const prefixBlocks = pendingHeadingOnly ? [...pendingBlocks] : [];
        if (pendingTexts.length && !pendingHeadingOnly) {
          emitPending();
        } else if (pendingHeadingOnly) {
          pendingTexts = [];
          pendingBlocks = [];
          pendingLen = 0;
          pendingHeadingOnly = false;
        }

        const pieces = splitOversizedProse(unit.text);
        pieces.forEach((piece, idx) => {
          const textWithHeading =
            idx === 0 && prefixText
              ? `${prefixText}\n\n${piece}`
              : idx > 0 && activeHeading && piece.length + activeHeading.length + 2 <= SEMANTIC_MAX_CHARS + 80
                ? `${activeHeading}\n\n${piece}`
                : piece;
          const contributing = idx === 0 ? uniqueSorted([...prefixBlocks, unit.blockIdx]) : [unit.blockIdx];
          results.push({
            blocks: contributing,
            text: textWithHeading.trim(),
            section: group.section,
            page: group.page,
          });
        });
        continue;
      }

      // Fit prose unit into pending chunk if under soft ceiling or heading-only
      const projectedLen = pendingTexts.length ? pendingLen + 2 + unit.text.length : unit.text.length;
      if (pendingTexts.length === 0 || pendingHeadingOnly || projectedLen <= SEMANTIC_TARGET_CHARS || (projectedLen <= SEMANTIC_MAX_CHARS && pendingLen < 320)) {
        if (pendingTexts.length === 0) pendingHeadingOnly = false;
        appendUnit(unit);
        pendingHeadingOnly = false;
      } else {
        // Carry trailing sentence overlap from the flushed chunk if it is prose-only and concise.
        const prevText = pendingTexts.join('\n\n').trim();
        emitPending();
        const prevSentences = splitIntoSentences(prevText);
        const lastSentence = prevSentences[prevSentences.length - 1] || '';
        const shouldCarry =
          lastSentence.length >= OVERLAP_MIN_CHARS &&
          lastSentence.length <= OVERLAP_MAX_CHARS &&
          !isHeadingOnlyText(lastSentence) &&
          !lastSentence.includes('```') &&
          lastSentence.length + 2 + unit.text.length <= SEMANTIC_MAX_CHARS;
        if (shouldCarry) {
          pendingTexts.push(lastSentence);
          pendingLen = lastSentence.length;
        }
        appendUnit(unit);
        pendingHeadingOnly = false;
      }
    }

    emitPending();
  };

  let currentGroup: SectionGroup | null = null;

  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx];
    const trimmed = block.text.trim();
    if (!trimmed) continue;

    // Keep footer/page_number blocks isolated so evidenceRows() can filter them out cleanly.
    if (EXCLUDED_BLOCK_TYPES.has(block.type)) {
      flushGroup(currentGroup);
      currentGroup = null;
      results.push({
        blocks: [idx],
        text: trimmed,
        section: block.section,
        page: block.page,
      });
      continue;
    }

    const units = extractUnitsFromBlock(block, idx);
    if (!units.length) continue;

    const startsAnswer = ANSWER_BOUNDARY_RE.test(trimmed);
    const sameGroup =
      currentGroup !== null &&
      !startsAnswer &&
      currentGroup.page === block.page &&
      currentGroup.section === block.section;

    if (!sameGroup) {
      flushGroup(currentGroup);
      currentGroup = {
        page: block.page,
        section: block.section,
        units: [...units],
      };
    } else {
      currentGroup!.units.push(...units);
    }
  }

  flushGroup(currentGroup);
  return results;
}

export function chunksFor(blocks: Block[]): Array<[number, string]> {
  return semanticChunksFor(blocks).map((chunk) => [chunk.blocks[0] ?? 0, chunk.text]);
}

function indexDocumentChunks(doc: DocumentRecord): number {
  const chunkList = semanticChunksFor(doc.blocks);
  let count = 0;
  chunkList.forEach((chunk, i) => {
    if (doc.kind === 'note' && !chunk.page) return;
    const section =
      doc.kind === 'personal'
        ? [doc.name, chunk.section].filter(Boolean).join(' · ')
        : chunk.section;
    const chunkId = `${doc.id}-${i}`;
    store.chunks.set(chunkId, {
      id: chunkId,
      document_id: doc.id,
      position: i,
      section,
      page: chunk.page,
      text: chunk.text,
      blocks: chunk.blocks,
    });
    count++;
  });
  return count;
}

export function rebuildDocumentChunks(doc: DocumentRecord): number {
  for (const [chunkId, chunk] of [...store.chunks.entries()]) {
    if (chunk.document_id === doc.id) {
      store.chunks.delete(chunkId);
    }
  }
  return indexDocumentChunks(doc);
}

export function rebuildAllChunks(): { documents: number; chunks: number } {
  let documents = 0;
  let chunks = 0;
  for (const doc of store.documents.values()) {
    if (!doc.blocks || doc.blocks.length === 0) continue;
    chunks += rebuildDocumentChunks(doc);
    documents++;
  }
  store.chunkerVersion = CHUNKER_VERSION;
  return { documents, chunks };
}

export function migrateChunksIfNeeded(): { migrated: boolean; documents: number; chunks: number } {
  if (store.chunkerVersion === CHUNKER_VERSION) {
    return { migrated: false, documents: 0, chunks: 0 };
  }
  if (store.documents.size === 0) {
    store.chunkerVersion = CHUNKER_VERSION;
    return { migrated: false, documents: 0, chunks: 0 };
  }
  const result = rebuildAllChunks();
  return { migrated: true, ...result };
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
    indexDocumentChunks(docRecord);
    if (!store.chunkerVersion) {
      store.chunkerVersion = CHUNKER_VERSION;
    }

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
