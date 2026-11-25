import crypto from 'node:crypto';
import path from 'node:path';
import { extractPdfLocally, ingestDocument, mineruParse, pdfBlocks, unpack } from './ingest.js';
import { renderMarkdown, sanitizeLatexDelimiters } from './markdown.js';
import {
  CourseExamMilestone,
  CoursePlanRecord,
  CourseWeekPlan,
  DocumentRecord,
  FolderRecord,
  nextSeq,
  persistStoreNow,
  schedulePersist,
  store,
  WeekType,
} from './store.js';
import { LlmError, parseJsonFromLlm, runChatCompletion, stripThinkAndFence } from './llm.js';
import { tfidfTextScores } from './tutor.js';
import { outlineSyllabus, syllabusEventType, syllabusMilestones } from './syllabus.js';
import {
  detectScheduleFromSyllabusText,
  ensureCourseSchedule,
  isValidIsoDate,
  normalizeWeekdays,
  pickNextCourseColor,
} from './courses.js';

const DEFAULT_CONTEXT_BUDGET = 4500;
const LONG_LLM_TIMEOUT_MS = 90_000;

export class StudyHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const uuidHex = (): string => crypto.randomUUID().replace(/-/g, '');

function isEn(): boolean {
  return store.settings.language === 'en';
}

function llmFriendlyError(err: unknown): StudyHttpError {
  if (err instanceof StudyHttpError) return err;
  if (err instanceof LlmError) return new StudyHttpError(err.status, err.message);
  const en = isEn();
  const isTimeout =
    err instanceof Error &&
    (err.name === 'TimeoutError' || err.name === 'AbortError' || /timeout|aborted/i.test(err.message));
  if (isTimeout) {
    return new StudyHttpError(
      504,
      en
        ? 'The AI engine took too long to respond. Try Current Page or switch models in Settings.'
        : '模型生成逾時，建議先改選「目前頁面」或於「設定」切換其他模型引擎後再試。'
    );
  }
  return new StudyHttpError(
    503,
    en
      ? 'Unable to reach the configured AI engine. Check Settings to switch providers or verify service status.'
      : '目前無法連線至所選的模型引擎，請至「設定」確認服務狀態或切換其他引擎。'
  );
}

async function callStudyLlm(params: {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  format?: Record<string, unknown> | 'json';
  numPredict?: number;
  temperature?: number;
  timeoutMs?: number;
}): Promise<string> {
  try {
    const result = await runChatCompletion({
      messages: params.messages,
      jsonSchema: params.format && typeof params.format === 'object' ? params.format : undefined,
      expectJson: Boolean(params.format),
      maxTokens: params.numPredict ?? 1600,
      temperature: params.temperature ?? 0.25,
      timeoutMs: params.timeoutMs ?? LONG_LLM_TIMEOUT_MS,
    });
    return result.text;
  } catch (err) {
    throw llmFriendlyError(err);
  }
}

function parseModelJson<T>(raw: string): T {
  try {
    return parseJsonFromLlm<T>(raw);
  } catch (err) {
    throw llmFriendlyError(err);
  }
}

export interface PageSlice {
  page: number;
  text: string;
}

export interface DocumentContextResult {
  contextText: string;
  sampledPages: number[];
  totalPages: number;
  pageSlices: PageSlice[];
}

function cleanPageText(text: string): string {
  return text.replace(/<!--\s*page:\s*\d+\s*-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
}

function trimCleanly(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('。'), cut.lastIndexOf('. '));
  if (lastBreak > maxChars * 0.6) {
    return `${cut.slice(0, lastBreak + 1).trim()} …`;
  }
  return `${cut.trim()} …`;
}

/**
 * Evenly samples pages across the whole document when total text exceeds
 * `budget` characters (default 4,500), always prefixing each segment with
 * `[Page N]` so model page references stay grounded and accurate.
 */
export function stratifiedSamplePages(pages: PageSlice[], budget = DEFAULT_CONTEXT_BUDGET): {
  contextText: string;
  sampledPages: number[];
} {
  const nonEmpty = pages.filter((p) => p.text.trim().length > 0);
  if (!nonEmpty.length) {
    return { contextText: '', sampledPages: [] };
  }

  const fullFormatted = nonEmpty.map((p) => `[Page ${p.page}]\n${p.text}`);
  const fullJoined = fullFormatted.join('\n\n');
  if (fullJoined.length <= budget) {
    return {
      contextText: fullJoined,
      sampledPages: nonEmpty.map((p) => p.page),
    };
  }

  const total = nonEmpty.length;
  const maxSampleCount = Math.min(total, Math.max(3, Math.min(12, Math.floor(budget / 320))));
  const chosenIndices: number[] = [];
  if (maxSampleCount === 1) {
    chosenIndices.push(0);
  } else {
    const seen = new Set<number>();
    for (let i = 0; i < maxSampleCount; i++) {
      const idx = Math.round((i * (total - 1)) / (maxSampleCount - 1));
      if (!seen.has(idx)) {
        seen.add(idx);
        chosenIndices.push(idx);
      }
    }
  }

  const perPageBudget = Math.max(220, Math.floor((budget - chosenIndices.length * 16) / chosenIndices.length));
  const segments: string[] = [];
  const sampledPages: number[] = [];

  for (const idx of chosenIndices) {
    const slice = nonEmpty[idx];
    sampledPages.push(slice.page);
    segments.push(`[Page ${slice.page}]\n${trimCleanly(slice.text, perPageBudget)}`);
  }

  return {
    contextText: segments.join('\n\n'),
    sampledPages,
  };
}

export function extractDocumentPageSlices(doc: DocumentRecord): PageSlice[] {
  const byPage = new Map<number, string[]>();
  let hasRealPages = false;
  for (const b of doc.blocks) {
    if (['footer', 'page_number'].includes(b.type)) continue;
    if (typeof b.page === 'number' && Number.isInteger(b.page) && b.page >= 1) {
      hasRealPages = true;
      const arr = byPage.get(b.page) || [];
      arr.push(b.text);
      byPage.set(b.page, arr);
    }
  }

  if (hasRealPages && byPage.size > 0) {
    return [...byPage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([page, texts]) => ({ page, text: cleanPageText(texts.join('\n\n')) }))
      .filter((p) => p.text.length > 0);
  }

  // Fallback for non-paged markdown/text: divide into logical ~900-char sections numbered from 1.
  const full = cleanPageText(doc.markdown || doc.blocks.map((b) => b.text).join('\n\n'));
  if (!full) return [];
  const sections: PageSlice[] = [];
  const paragraphs = full.split(/\n\s*\n/);
  let buf = '';
  let pseudoPage = 1;
  for (const para of paragraphs) {
    if (buf.length > 0 && buf.length + para.length > 900) {
      sections.push({ page: pseudoPage++, text: buf.trim() });
      buf = para;
    } else {
      buf = buf ? `${buf}\n\n${para}` : para;
    }
  }
  if (buf.trim()) sections.push({ page: pseudoPage, text: buf.trim() });
  return sections;
}

export function buildDocumentContext(
  doc: DocumentRecord,
  scope: 'page' | 'full',
  page: number | null,
  budget = DEFAULT_CONTEXT_BUDGET
): DocumentContextResult {
  const slices = extractDocumentPageSlices(doc);
  const validPages = new Set(slices.map((s) => s.page));
  const totalPages = slices.length;

  if (!slices.length) {
    throw new StudyHttpError(
      422,
      isEn() ? 'This document has no readable text yet.' : '這份教材目前沒有可供分析的文字內容。'
    );
  }

  if (scope === 'page') {
    const targetPage = page && validPages.has(page) ? page : slices[0].page;
    const match = slices.find((s) => s.page === targetPage) || slices[0];
    const body = trimCleanly(match.text, budget - 20);
    return {
      contextText: `[Page ${match.page}]\n${body}`,
      sampledPages: [match.page],
      totalPages,
      pageSlices: [match],
    };
  }

  const sampled = stratifiedSamplePages(slices, budget);
  return {
    contextText: sampled.contextText,
    sampledPages: sampled.sampledPages,
    totalPages,
    pageSlices: slices,
  };
}

// ============================================================
// Feature 1: Syllabus Upload -> 3-Stage AI Initial Planning
// ============================================================

function formatTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function weekTypeLabel(weekType: WeekType, en: boolean): string {
  if (weekType === 'holiday') return en ? 'Holiday' : '放假';
  if (weekType === 'exam') return en ? 'Exam' : '考試';
  if (weekType === 'activity') return en ? 'Activity' : '評量／活動';
  return en ? 'Lecture' : '課程';
}

const IMAGE_SYLLABUS_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function isImageMagic(buf: Buffer): boolean {
  if (buf.length < 4) return false;
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // GIF: 47 49 46 38
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // WEBP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    buf.subarray(8, 12).equals(Buffer.from('WEBP'))
  ) {
    return true;
  }
  return false;
}

function splitTextToSlices(text: string, startPage = 1): PageSlice[] {
  const slices: PageSlice[] = [];
  const chunks = text.split(/\n\s*\n/).filter((c) => c.trim());
  let page = startPage;
  let buf = '';
  for (const c of chunks) {
    if (buf && buf.length + c.length > 850) {
      slices.push({ page: page++, text: buf.trim() });
      buf = c;
    } else {
      buf = buf ? `${buf}\n\n${c}` : c;
    }
  }
  if (buf.trim()) slices.push({ page, text: buf.trim() });
  return slices;
}

async function extractSlicesFromMinerU(sourceName: string, buffer: Buffer, ocrMode: 'auto' | 'ocr'): Promise<PageSlice[]> {
  const bundle = await mineruParse(sourceName, buffer, { ocrMode });
  const unpacked = await unpack(bundle);
  const blocks = pdfBlocks(unpacked.structured);
  const byPage = new Map<number, string[]>();
  for (const b of blocks) {
    if (!b.text.trim()) continue;
    const p = b.page ?? 1;
    const arr = byPage.get(p) || [];
    arr.push(b.text);
    byPage.set(p, arr);
  }
  if (byPage.size > 0) {
    return [...byPage.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([page, texts]) => ({ page, text: cleanPageText(texts.join('\n\n')) }))
      .filter((s) => s.text.length > 0);
  }
  if (unpacked.markdown.trim()) {
    return splitTextToSlices(cleanPageText(unpacked.markdown));
  }
  return [];
}

/**
 * A mixed week retains its teaching content regardless of the course subject.
 */
export function classifySyllabusWeek(params: {
  title: string;
  topics: string[];
  milestone: string | null;
}): { week_type: WeekType; requires_material: boolean } {
  const types = [params.title, ...params.topics].filter(line => line.trim())
    .flatMap(line => line.split(/\s+\+\s+|[；;]/)).map(syllabusEventType);
  if (!types.length || types.includes(null)) return { week_type: 'lecture', requires_material: true };
  if (types.includes('exam')) return { week_type: 'exam', requires_material: false };
  return { week_type: types.every(type => type === 'holiday') ? 'holiday' : 'activity', requires_material: false };
}

export function buildOverviewMarkdown(plan: {
  course_title: string;
  summary: string;
  weeks: CourseWeekPlan[];
  exams: CourseExamMilestone[];
}): string {
  const en = isEn();
  const lines: string[] = [];
  lines.push(`# ${plan.course_title}${en ? ' — Course Overview & Schedule' : ' — 課程總覽與考試時程'}`);
  if (plan.summary) {
    lines.push('', `> ${plan.summary}`);
  }

  lines.push('', en ? '## Weekly Learning Plan' : '## 每週學習目標與單元規劃', '');
  lines.push(
    en
      ? '| Week | Type | Topic | Learning Objectives | Key Notes |'
      : '| 週次 | 類型 | 單元主題 | 核心學習目標 | 重要進度 |'
  );
  lines.push('| --- | --- | --- | --- | --- |');
  for (const w of plan.weeks) {
    const typeText = weekTypeLabel(w.week_type, en);
    const safeTitle = w.title.replace(/\|/g, '／');
    const objText =
      w.week_type === 'holiday'
        ? (en ? 'Holiday' : '放假')
        : (w.objectives.length ? w.objectives : w.topics).slice(0, 3).join('；').replace(/\|/g, '／') || '—';
    const noteText = (w.milestone || '—').replace(/\|/g, '／');
    lines.push(`| ${w.label} | ${typeText} | ${safeTitle} | ${objText} | ${noteText} |`);
  }

  lines.push('', en ? '## Exams & Major Milestones' : '## 考試與重要時程表', '');
  if (plan.exams.length) {
    lines.push(en ? '| Milestone | Date / Week | Details |' : '| 項目 | 日期／週次 | 說明 |');
    lines.push('| --- | --- | --- |');
    for (const ex of plan.exams) {
      const when = [ex.date, ex.week ? `Week ${ex.week}` : ''].filter(Boolean).join(' · ') || '—';
      lines.push(
        `| ${ex.title.replace(/\|/g, '／')} | ${when.replace(/\|/g, '／')} | ${(ex.notes || '—').replace(/\|/g, '／')} |`
      );
    }
  } else {
    lines.push(
      en
        ? '- No explicit exam dates were listed in the syllabus. You can add them directly here.'
        : '- 課綱中未列出明確考試日期，歡迎直接在此補充期中／期末與作業截止日。'
    );
  }

  return lines.join('\n');
}

function normalizeFolderKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function syllabusWeekTitle(items: string[]): string {
  return items.find(item => !syllabusEventType(item) && !/^(?:syllabus|course outline|課綱|課程大綱)$/i.test(item)) || items[0];
}

async function extractRawSyllabusContent(params: {
  sourceName: string;
  buffer?: Buffer | null;
  text?: string | null;
}): Promise<{
  rawSlices: PageSlice[];
  sourceText: string;
  parserEngine: 'mineru' | 'pdfjs' | 'text';
}> {
  const en = isEn();
  let rawSlices: PageSlice[] = [];
  let parserEngine: 'mineru' | 'pdfjs' | 'text' = 'text';

  if (params.buffer && params.buffer.length > 0) {
    const ext = path.posix.extname(params.sourceName).toLowerCase();
    const isPdf = ext === '.pdf' || params.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'));
    const isImg = IMAGE_SYLLABUS_EXTS.has(ext) || isImageMagic(params.buffer);

    if (isPdf) {
      // Use MinerU as the primary PDF parsing engine (with OCR/table/formula), fallback to PDF.js only if MinerU is offline.
      try {
        rawSlices = await extractSlicesFromMinerU(params.sourceName, params.buffer, 'auto');
        parserEngine = 'mineru';
      } catch (err) {
        console.warn('[study] MinerU unavailable for syllabus PDF, falling back to PDF.js:', err instanceof Error ? err.message : err);
        const extracted = await extractPdfLocally(params.buffer);
        rawSlices = extracted.blocks
          .filter((b) => b.text.trim())
          .map((b, i) => ({ page: b.page ?? i + 1, text: cleanPageText(b.text) }));
        parserEngine = 'pdfjs';
      }
    } else if (isImg) {
      if (!isImageMagic(params.buffer)) {
        throw new StudyHttpError(
          415,
          en ? 'Unsupported or corrupted image file.' : '圖片檔案格式不正確或已損毀，請改用 PNG、JPG 或 WebP。'
        );
      }
      try {
        rawSlices = await extractSlicesFromMinerU(params.sourceName, params.buffer, 'ocr');
        parserEngine = 'mineru';
      } catch {
        const mineruBase = (process.env.AITA_MINERU_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
        throw new StudyHttpError(
          503,
          en
            ? `Image OCR requires local MinerU (${mineruBase}). Start MinerU or paste the syllabus text directly.`
            : `圖片課綱 OCR 辨識需使用本機 MinerU（${mineruBase}），目前無法連線至 MinerU 服務；請先啟動本機 MinerU，或直接貼上課綱文字。`
        );
      }
    } else {
      const decoded = params.buffer.toString('utf-8').replace(/^\uFEFF/, '').trim();
      rawSlices = splitTextToSlices(decoded);
      parserEngine = 'text';
    }
  }

  if (params.text && params.text.trim()) {
    const startPage = rawSlices.length ? rawSlices[rawSlices.length - 1].page + 1 : 1;
    rawSlices = [...rawSlices, ...splitTextToSlices(params.text.trim(), startPage)];
  }

  const sourceText = rawSlices.map((slice) => slice.text).join('\n\n').trim();
  if (!sourceText) {
    throw new StudyHttpError(
      422,
      en ? 'No readable text was found. Paste the syllabus text to continue.' : '找不到可讀的課綱文字，請貼上原文後再試。'
    );
  }

  return { rawSlices, sourceText, parserEngine };
}

export async function extractSyllabusSource(params: {
  sourceName: string;
  buffer?: Buffer | null;
  text?: string | null;
}) {
  const en = isEn();
  const { sourceText, parserEngine } = await extractRawSyllabusContent(params);
  const outline = outlineSyllabus(sourceText);
  if (outline.text.length > 80_000) {
    throw new StudyHttpError(
      422,
      en ? 'The syllabus is too long to process in one import.' : '課綱內容超過單次匯入長度，請先精簡後再試。'
    );
  }
  return { ...outline, parser_engine: parserEngine };
}

interface RawLlmSyllabusWeek {
  week_number?: unknown;
  label?: unknown;
  title?: unknown;
  week_type?: unknown;
  requires_material?: unknown;
  topics?: unknown;
  objectives?: unknown;
  milestone?: unknown;
}

interface RawLlmSyllabusExam {
  title?: unknown;
  date?: unknown;
  week?: unknown;
  notes?: unknown;
}

interface RawLlmSyllabusPlan {
  course_title?: unknown;
  summary?: unknown;
  detected_weekdays?: unknown;
  detected_start_date?: unknown;
  weeks?: RawLlmSyllabusWeek[];
  exams?: RawLlmSyllabusExam[];
}

interface PlannedUnitDraft {
  week_number: number;
  label: string;
  title: string;
  week_type: WeekType;
  requires_material: boolean;
  topics: string[];
  objectives: string[];
  milestone: string | null;
}

function cleanStringList(input: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const cleaned = item.replace(/\s+/g, ' ').trim().slice(0, maxLen);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeLlmWeekType(raw: unknown): WeekType | null {
  if (raw === 'lecture' || raw === 'holiday' || raw === 'exam' || raw === 'activity') return raw;
  return null;
}

function buildFallbackUnits(sourceText: string, en: boolean): {
  prefaceTitle: string;
  units: PlannedUnitDraft[];
  exams: CourseExamMilestone[];
} {
  const outline = outlineSyllabus(sourceText);
  const prefaceTitle =
    outline.preface
      .find((line) => !/^(?:#{1,6}\s*)?(?:syllabus|course outline|課程大綱|課綱)$/i.test(line))
      ?.replace(/^#{1,6}\s+/, '')
      .slice(0, 80) || '';

  const units: PlannedUnitDraft[] = [];
  const usedNumbers = new Set<number>();

  if (outline.weeks.length > 0) {
    let fallbackNum = 1;
    for (const week of outline.weeks) {
      const items = week.items.filter((item) => item.trim());
      if (!items.length) continue;
      let weekNum = Number.isInteger(week.number) && week.number >= 1 ? week.number : fallbackNum;
      while (usedNumbers.has(weekNum)) weekNum++;
      usedNumbers.add(weekNum);
      fallbackNum = Math.max(fallbackNum, weekNum + 1);

      const title = syllabusWeekTitle(items).slice(0, 120);
      const topics = items.filter((line) => line !== title).slice(0, 6);
      const milestoneItems = items.filter((line) => {
        const t = syllabusEventType(line);
        return t === 'exam' || t === 'activity' || /\b(?:deadline|due)\b|繳交|截止/i.test(line);
      });
      const milestone = milestoneItems.join(' / ').slice(0, 160) || null;
      const classification = classifySyllabusWeek({ title, topics, milestone });
      units.push({
        week_number: weekNum,
        label: `Week ${weekNum}`,
        title,
        week_type: classification.week_type,
        requires_material: classification.requires_material,
        topics,
        objectives: [],
        milestone,
      });
    }
    return { prefaceTitle, units, exams: syllabusMilestones(outline) };
  }

  // Flexible fallback for unstructured syllabi without explicit week numbers.
  const candidateLines = sourceText
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•\d.)、\s]+/, '').replace(/^#{1,6}\s+/, '').trim())
    .filter((line) => line.length >= 2 && !/^\|?[-:\s|]+\|?$/.test(line))
    .slice(0, 24);

  candidateLines.forEach((line, idx) => {
    const num = idx + 1;
    const title = line.slice(0, 100);
    const classification = classifySyllabusWeek({ title, topics: [], milestone: null });
    units.push({
      week_number: num,
      label: en ? `Unit ${num}` : `單元 ${num}`,
      title,
      week_type: classification.week_type,
      requires_material: classification.requires_material,
      topics: [],
      objectives: [],
      milestone: classification.week_type === 'exam' || classification.week_type === 'activity' ? title : null,
    });
  });

  return { prefaceTitle, units, exams: [] };
}

export async function generateSyllabusPlan(params: {
  sourceName: string;
  buffer?: Buffer | null;
  text?: string | null;
  existingPlan?: CoursePlanRecord;
  title?: string;
  reviewedParser?: 'mineru' | 'pdfjs' | 'text';
}) {
  const en = isEn();
  // Stage 1: Parse syllabus via MinerU (PDF/Image OCR) or local text/PDF fallback.
  const { rawSlices, sourceText, parserEngine } = await extractRawSyllabusContent(params);
  if (sourceText.length > 80_000) {
    throw new StudyHttpError(
      422,
      en ? 'The syllabus is too long to process in one import.' : '課綱內容超過單次匯入長度，請先精簡後再試。'
    );
  }

  const sampled = stratifiedSamplePages(rawSlices, 6000);
  const llmInput = sampled.contextText || trimCleanly(sourceText, 6000);

  // Stage 2: Automatic LLM planning (flexible for any course length/schedule; no fixed 16-week rule).
  let llmCourseTitle = '';
  let llmSummary = '';
  let llmDetectedWeekdays: number[] = [];
  let llmDetectedStartDate: string | null = null;
  let plannedUnits: PlannedUnitDraft[] = [];
  let exams: CourseExamMilestone[] = [];
  let llmPlanned = false;

  try {
    const raw = await callStudyLlm({
      messages: [
        {
          role: 'system',
          content: en
            ? [
                'You are an academic course syllabus planner. Parse the provided syllabus text (extracted from PDF/OCR/text) into a structured JSON course plan.',
                'Important rules:',
                '1. Follow the ACTUAL schedule and unit count in the source syllabus. Do NOT assume 16 weeks or invent missing weeks—courses may have 4, 8, 12, 16, 18 weeks, bi-weekly sessions, or module/unit lists.',
                '2. Preserve real unit/week numbers when present, or assign sequential numbers starting from 1 if the syllabus uses dates or named modules.',
                '3. Classify each entry accurately with week_type: "lecture" (teaching content/slides/labs), "holiday" (no class/holiday), "exam" (pure midterm/final/quiz without lecture), or "activity" (pure peer review, presentation, or project submission without lecture). If a week mixes lecture content with a quiz or exam review, classify as "lecture".',
                '4. Set requires_material to true ONLY for "lecture" entries, and false for "holiday", "exam", and "activity".',
                '5. Provide 1 concise learning objective for each "lecture" entry (empty array for non-lecture entries), plus key topics and any milestone/date noted in the source.',
                '6. Extract major exams, project deadlines, and milestones into the exams array. Never fabricate dates.',
                '7. If the syllabus states class meeting weekday(s) (e.g., "Tue. 13:20-16:20", "Mon/Wed"), return detected_weekdays as integers (0=Sun, 1=Mon, ..., 6=Sat). If Week 1 has an explicit calendar date (e.g., 2026/09/08), return detected_start_date as "YYYY-MM-DD", otherwise null. Never guess dates not in the source.',
                'Return strict JSON only.',
              ].join('\n')
            : [
                '你是專業的課程大綱規劃助教，請將 MinerU／文字解析後的課綱內容整理為結構化 JSON 課程規劃。',
                '重要規則：',
                '1. 完全依照課綱原文實際的週次、堂數或單元規則規劃，切勿假設固定 16 週，也不要憑空補造未出現的週次（不同課程可能是 6 週、8 週、12 週、16 週、18 週或以單元／日期編排）。',
                '2. 若原文有明確週次編號請保留；若原文以日期或主題單元編排，請依序給予 1, 2, 3... 編號與合適的 label（例如 Week 1 或 單元 1）。',
                '3. 精準分類每週／每單元的 week_type："lecture"（有授課或教材內容）、"holiday"（放假／停課）、"exam"（純考試／期中考／期末考）、"activity"（純報告／發表／同儕互評／繳交專題）。若同週同時有授課內容與小考或期中考檢討，請歸類為 "lecture"。',
                '4. 只有 "lecture" 的 requires_material 為 true；放假、純考試與純活動設為 false。',
                '5. 為每個 "lecture" 單元撰寫 1 句精簡的繁體中文核心學習目標（objectives），非授課週留空陣列；並保留原文的 topics 與重要進度 milestone。',
                '6. 將期中／期末考、小考、專題繳交與報告等重要時程整理到 exams 陣列，切勿捏造日期。',
                '7. 若課綱開頭或排程有寫明上課星期（如「週二 13:20-16:20」、「Tue./Thu.」），請在 detected_weekdays 輸出整數陣列（0=週日, 1=週一 ... 6=週六）；若第 1 週有明確開課日期（如 2026/09/08），請在 detected_start_date 輸出 "YYYY-MM-DD"，否則輸出 null，切勿猜測未出現的日期。',
                '請只輸出符合格式規範的 JSON。',
              ].join('\n'),
        },
        {
          role: 'user',
          content: `${en ? 'Syllabus source' : '課綱來源'} (${params.sourceName}):\n\n${llmInput}`,
        },
      ],
      format: {
        type: 'object',
        properties: {
          course_title: { type: 'string' },
          summary: { type: 'string' },
          detected_weekdays: { type: 'array', items: { type: 'integer' } },
          detected_start_date: { type: ['string', 'null'] },
          weeks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                week_number: { type: 'integer' },
                label: { type: 'string' },
                title: { type: 'string' },
                week_type: { type: 'string', enum: ['lecture', 'holiday', 'exam', 'activity'] },
                requires_material: { type: 'boolean' },
                topics: { type: 'array', items: { type: 'string' } },
                objectives: { type: 'array', items: { type: 'string' } },
                milestone: { type: ['string', 'null'] },
              },
              required: ['week_number', 'label', 'title', 'week_type', 'requires_material', 'topics', 'objectives'],
            },
          },
          exams: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                date: { type: 'string' },
                week: { type: ['integer', 'null'] },
                notes: { type: 'string' },
              },
              required: ['title', 'date', 'notes'],
            },
          },
        },
        required: ['course_title', 'summary', 'weeks', 'exams'],
      },
      numPredict: 3200,
      temperature: 0.15,
      timeoutMs: 90_000,
    });

    const parsed = parseModelJson<RawLlmSyllabusPlan>(raw);
    if (parsed && Array.isArray(parsed.weeks) && parsed.weeks.length > 0) {
      llmCourseTitle = typeof parsed.course_title === 'string' ? parsed.course_title.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      llmSummary = typeof parsed.summary === 'string' ? parsed.summary.replace(/\s+/g, ' ').trim().slice(0, 320) : '';
      if (Array.isArray(parsed.detected_weekdays) && parsed.detected_weekdays.length > 0) {
        const cleanedDays = parsed.detected_weekdays
          .map((d) => Number(d))
          .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
        if (cleanedDays.length) llmDetectedWeekdays = [...new Set(cleanedDays)].sort((a, b) => a - b);
      }
      if (typeof parsed.detected_start_date === 'string') {
        const trimmedDate = parsed.detected_start_date.trim();
        if (isValidIsoDate(trimmedDate)) llmDetectedStartDate = trimmedDate;
      }

      const usedNumbers = new Set<number>();
      let nextNum = 1;
      for (const item of parsed.weeks) {
        const title = typeof item?.title === 'string' ? item.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
        if (!title) continue;
        let weekNum = typeof item.week_number === 'number' && Number.isInteger(item.week_number) && item.week_number >= 1
          ? item.week_number
          : nextNum;
        while (usedNumbers.has(weekNum)) weekNum++;
        usedNumbers.add(weekNum);
        nextNum = Math.max(nextNum, weekNum + 1);

        const label =
          typeof item.label === 'string' && item.label.trim()
            ? item.label.replace(/\s+/g, ' ').trim().slice(0, 32)
            : `Week ${weekNum}`;
        const topics = cleanStringList(item.topics, 6, 140);
        const milestone =
          typeof item.milestone === 'string' && item.milestone.trim()
            ? item.milestone.replace(/\s+/g, ' ').trim().slice(0, 160)
            : null;

        const inferred = classifySyllabusWeek({ title, topics, milestone });
        const modelType = normalizeLlmWeekType(item.week_type);
        const weekType: WeekType = modelType || inferred.week_type;
        const requiresMaterial = weekType === 'lecture';
        const objectives = requiresMaterial ? cleanStringList(item.objectives, 3, 160) : [];

        plannedUnits.push({
          week_number: weekNum,
          label,
          title,
          week_type: weekType,
          requires_material: requiresMaterial,
          topics,
          objectives,
          milestone,
        });
      }

      if (Array.isArray(parsed.exams)) {
        for (const ex of parsed.exams) {
          const title = typeof ex?.title === 'string' ? ex.title.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
          if (!title) continue;
          const date = typeof ex.date === 'string' ? ex.date.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
          const week = typeof ex.week === 'number' && Number.isInteger(ex.week) && ex.week >= 1 ? ex.week : null;
          const notes = typeof ex.notes === 'string' ? ex.notes.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
          exams.push({ title, date, week, notes });
        }
      }

      if (plannedUnits.length > 0) {
        llmPlanned = true;
      }
    }
  } catch (err) {
    console.warn('[study] LLM syllabus planning unavailable, falling back to automatic parser:', err instanceof Error ? err.message : err);
  }

  let fallbackPrefaceTitle = '';
  if (!plannedUnits.length) {
    const fallback = buildFallbackUnits(sourceText, en);
    fallbackPrefaceTitle = fallback.prefaceTitle;
    plannedUnits = fallback.units;
    exams = fallback.exams;
  }

  if (!plannedUnits.length) {
    throw new StudyHttpError(
      422,
      en ? 'Could not identify any course units in the syllabus.' : '無法從課綱內容整理出課程單元，請補充更完整的課程大綱。'
    );
  }

  const previous = params.existingPlan;
  const courseTitle =
    params.title ||
    previous?.course_title ||
    llmCourseTitle ||
    fallbackPrefaceTitle ||
    params.sourceName.replace(/\.[^.]+$/, '').slice(0, 80) ||
    (en ? 'Course Plan' : '課程規劃');

  const teachingUnits = plannedUnits.filter((unit) => unit.requires_material);
  const summary =
    llmSummary ||
    [...new Set(teachingUnits.map((unit) => unit.title))]
      .slice(0, 4)
      .join(en ? ', ' : '、')
      .slice(0, 320);

  // Stage 3: Create/reuse course folders and pinned Course Overview note.
  const createdFolders: string[] = [];
  const reusedFolders: string[] = [];
  let skippedNonMaterialWeeks = 0;

  const existingRoot = previous?.root_folder_id ? store.folders.get(previous.root_folder_id) : undefined;
  const rootFolder: FolderRecord = existingRoot || { id: uuidHex(), name: courseTitle, parent_id: null };
  const newFolders: FolderRecord[] = [];
  const priorWeeks = new Map(previous?.weeks.map((week) => [week.week_number, week]));
  const reservedFolders = otherCourseFolders(previous?.id);
  const childFoldersByName = new Map(
    [...store.folders.values()]
      .filter((folder) => folder.parent_id === rootFolder.id && !reservedFolders.has(folder.id))
      .map((folder) => [normalizeFolderKey(folder.name), folder])
  );
  const assignedFolders = new Set<string>();

  const weeks: CourseWeekPlan[] = [];
  for (const unit of plannedUnits) {
    const prior = priorWeeks.get(unit.week_number);
    const unchangedContent = prior?.title === unit.title && prior.topics.join('\n') === unit.topics.join('\n');

    let folderId: string | null = null;
    let finalFolderName: string | null = null;

    if (unit.requires_material) {
      const folderName = `${unit.label} ${unit.title}`.trim().slice(0, 80);
      const previousFolderId = prior?.folder_id;
      const existing =
        (previousFolderId && !reservedFolders.has(previousFolderId) ? store.folders.get(previousFolderId) : undefined) ||
        childFoldersByName.get(normalizeFolderKey(folderName));

      if (existing && !assignedFolders.has(existing.id)) {
        folderId = existing.id;
        finalFolderName = existing.name;
        reusedFolders.push(existing.name);
      } else {
        folderId = uuidHex();
        finalFolderName = folderName;
        newFolders.push({ id: folderId, name: finalFolderName, parent_id: rootFolder.id });
        createdFolders.push(finalFolderName);
      }
      assignedFolders.add(folderId);
    } else {
      skippedNonMaterialWeeks++;
      const priorId = prior?.folder_id;
      const existing = priorId && !reservedFolders.has(priorId) && store.folders.get(priorId);
      if (existing && !assignedFolders.has(existing.id)) {
        folderId = existing.id;
        finalFolderName = existing.name;
        assignedFolders.add(existing.id);
      }
    }

    weeks.push({
      week_number: unit.week_number,
      label: unit.label,
      title: unit.title,
      week_type: unit.week_type,
      requires_material: unit.requires_material,
      folder_id: folderId,
      folder_name: finalFolderName,
      topics: unit.topics,
      objectives: !unit.requires_material
        ? []
        : unit.objectives.length
          ? unit.objectives
          : unchangedContent
            ? prior.objectives
            : [],
      milestone: unit.milestone,
    });
  }

  // Create or safely update pinned Course Overview note (Refinement #4 protection).
  const overviewMarkdown = sanitizeLatexDelimiters(
    buildOverviewMarkdown({ course_title: courseTitle, summary, weeks, exams })
  );
  const overviewTitle = en ? `Course Overview · ${courseTitle}` : `課程總覽與時程 · ${courseTitle}`;

  const existingOverview = previous?.overview_note_id ? store.personalNotes.get(previous.overview_note_id) : undefined;

  let overviewUpdateMode: 'created' | 'updated' | 'appended' = 'created';
  let finalMarkdown = overviewMarkdown;
  let finalTitle = overviewTitle.slice(0, 160);
  let keepManuallyEdited = false;

  if (existingOverview) {
    const prevDoc = store.documents.get(existingOverview.document_id);
    if (existingOverview.manually_edited && prevDoc) {
      const updateHeading = en
        ? `## Syllabus Update (${formatTimestamp()})`
        : `## 課綱更新（${formatTimestamp()}）`;
      finalMarkdown = `${prevDoc.markdown.trimEnd()}\n\n---\n\n${updateHeading}\n\n${overviewMarkdown}`;
      finalTitle = prevDoc.name;
      overviewUpdateMode = 'appended';
      keepManuallyEdited = true;
    } else {
      overviewUpdateMode = 'updated';
    }
  }

  const noteId = existingOverview?.id || uuidHex();
  const docId = await ingestDocument({
    name: finalTitle,
    raw: Buffer.from(finalMarkdown, 'utf-8'),
    kind: 'personal',
    originalId: null,
    noteId,
  });

  if (existingOverview && existingOverview.document_id !== docId) {
    const oldDoc = store.documents.get(existingOverview.document_id);
    if (oldDoc) oldDoc.active = false;
  }

  store.personalNotes.set(noteId, {
    id: noteId,
    original_id: null,
    document_id: docId,
    pinned: true,
    role: 'course_overview',
    manually_edited: keepManuallyEdited,
  });

  const heuristicSchedule = detectScheduleFromSyllabusText(sourceText);
  const detectedWeekdays = llmDetectedWeekdays.length
    ? llmDetectedWeekdays
    : heuristicSchedule.detected_weekdays;
  const detectedStartDate = llmDetectedStartDate || heuristicSchedule.detected_start_date;

  const existingSchedule = previous ? ensureCourseSchedule(previous, 0) : null;
  const finalSchedule = existingSchedule?.manual_override
    ? existingSchedule
    : {
        color: existingSchedule?.color || pickNextCourseColor(previous?.id),
        weekdays: normalizeWeekdays(detectedWeekdays.length ? detectedWeekdays : existingSchedule?.weekdays || [1]),
        start_date_override: detectedStartDate ?? existingSchedule?.start_date_override ?? null,
        location: existingSchedule?.location || '',
        manual_override: false,
      };

  if (!store.calendarSettings.semester_start_date && detectedStartDate) {
    store.calendarSettings.semester_start_date = detectedStartDate;
  }

  const plan: CoursePlanRecord = {
    id: previous?.id || uuidHex(),
    root_folder_id: rootFolder.id,
    course_title: courseTitle,
    summary,
    source_name: params.sourceName,
    parser_engine: params.reviewedParser ?? parserEngine,
    overview_note_id: noteId,
    overview_document_id: docId,
    weeks,
    exams,
    schedule: finalSchedule,
    updated_at: new Date().toISOString(),
  };
  if (!existingRoot) store.folders.set(rootFolder.id, rootFolder);
  else if (courseTitle !== previous?.course_title && rootFolder.name === previous?.course_title) {
    rootFolder.name = courseTitle;
  }
  for (const folder of newFolders) store.folders.set(folder.id, folder);
  store.coursePlans.set(plan.id, plan);
  persistStoreNow();

  return {
    plan,
    parser_engine: plan.parser_engine,
    enriched: llmPlanned,
    planned_by: llmPlanned ? 'llm' : 'fallback',
    created_folders: createdFolders,
    reused_folders: reusedFolders,
    skipped_non_material_weeks: skippedNonMaterialWeeks,
    overview_note_id: noteId,
    overview_document_id: docId,
    overview_update_mode: overviewUpdateMode,
  };
}

export function otherCourseFolders(courseId?: string): Set<string | null> {
  const ids = new Set<string | null>();
  for (const course of store.coursePlans.values()) {
    if (course.id === courseId) continue;
    ids.add(course.root_folder_id);
    for (const week of course.weeks) ids.add(week.folder_id);
  }
  return ids;
}

export function ensureFolderForWeek(plan: CoursePlanRecord, weekNumber: number): {
  folder_id: string;
  folder_name: string;
  week: CourseWeekPlan;
} {
  const week = plan.weeks.find((w) => w.week_number === weekNumber);
  if (!week) {
    throw new StudyHttpError(404, isEn() ? 'Week plan not found.' : '找不到對應的週次規劃。');
  }
  if (week.folder_id && store.folders.has(week.folder_id)) {
    return {
      folder_id: week.folder_id,
      folder_name: week.folder_name || store.folders.get(week.folder_id)!.name,
      week,
    };
  }
  const folderName = `${week.label} ${week.title}`.trim().slice(0, 80);
  if (!plan.root_folder_id || !store.folders.has(plan.root_folder_id)) {
    plan.root_folder_id = uuidHex();
    store.folders.set(plan.root_folder_id, { id: plan.root_folder_id, name: plan.course_title, parent_id: null });
  }
  const reservedFolders = otherCourseFolders(plan.id);
  const existing = [...store.folders.values()].find((f) =>
    f.parent_id === plan.root_folder_id && normalizeFolderKey(f.name) === normalizeFolderKey(folderName)
    && !reservedFolders.has(f.id) && !plan.weeks.some(other => other.folder_id === f.id));
  let folderId: string;
  let finalName: string;
  if (existing) {
    folderId = existing.id;
    finalName = existing.name;
  } else {
    folderId = uuidHex();
    finalName = folderName;
    store.folders.set(folderId, { id: folderId, name: finalName, parent_id: plan.root_folder_id });
  }
  week.folder_id = folderId;
  week.folder_name = finalName;
  schedulePersist();
  return { folder_id: folderId, folder_name: finalName, week };
}

// ============================================================
// Feature 1B: Smart Week Folder Recommendation on Material Import
// ============================================================

function archiveKeywords(text: string): string {
  return text.normalize('NFKC').toLowerCase()
    .replace(/\.(pdf|txt|md)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function matchCourseWeek(weeks: CourseWeekPlan[], filename: string, heading: string, preview: string) {
  const explicit = new Set([...filename.normalize('NFKC').matchAll(/\b(?:week|wk)\s*0*(\d{1,2})\b|第\s*0*(\d{1,2})\s*[週周]/gi)]
    .map(match => Number(match[1] || match[2])));
  if (explicit.size) {
    const week = explicit.size === 1 ? weeks.find(item => explicit.has(item.week_number)) : undefined;
    return week ? { week, score: 1, margin: 1, explicit: true } : null;
  }
  const title = archiveKeywords(filename + ' ' + heading);
  const topics = weeks.map(w => archiveKeywords([w.title, ...w.topics].join(' ')));
  const byTitle = tfidfTextScores(weeks.map(w => archiveKeywords(w.title)), title);
  const byTopics = tfidfTextScores(topics, title);
  const byExcerpt = tfidfTextScores(topics, archiveKeywords(preview.slice(0, 1200)));
  const ranked = weeks.map((week, i) => ({
    week, score: 0.5 * byTitle[i] + 0.35 * byTopics[i] + 0.15 * byExcerpt[i],
  })).sort((a, b) => b.score - a.score);
  const first = ranked[0];
  if (!first) return null;
  return { ...first, margin: first.score - (ranked[1]?.score || 0), explicit: false };
}

export function recommendFolderForMaterial(plan: CoursePlanRecord | undefined, filename: string, preview = ''): {
  folder_id: string;
  folder_name: string;
  week_label: string | null;
  score: number;
  reason: string;
} | null {
  const weeks = plan?.weeks.filter(w => w.folder_id && store.folders.has(w.folder_id) && w.week_type !== 'holiday');
  if (weeks?.length) {
    const match = matchCourseWeek(weeks, filename, '', preview);
    if (!match || (!match.explicit && (match.score < 0.20 || match.margin < 0.045))) return null;
    const { week, score, explicit } = match;
    const folder = store.folders.get(week.folder_id!)!;
    return {
      folder_id: folder.id, folder_name: folder.name, week_label: week.label, score,
      reason: explicit ? (isEn() ? 'Week number in filename' : '符合檔名週次')
        : (isEn() ? `Topic match (${week.title})` : `主題符合「${week.title}」`),
    };
  }
  if (plan || store.coursePlans.size) return null;
  const folders = [...store.folders.values()];
  const similarities = tfidfTextScores(folders.map(f => archiveKeywords(f.name)), archiveKeywords(filename + ' ' + preview.slice(0, 600)));
  const score = Math.max(0, ...similarities);
  if (score < 0.22) return null;
  const folder = folders[similarities.indexOf(score)];
  return {
    folder_id: folder.id, folder_name: folder.name, week_label: null, score,
    reason: isEn() ? `Matches folder "${folder.name}"` : `符合分類「${folder.name}」`,
  };
}

export function archiveCourseMaterials(plan: CoursePlanRecord) {
  const weeks = plan.weeks.filter(w => w.week_type !== 'holiday');
  if (!weeks?.length) {
    throw new StudyHttpError(409, isEn() ? 'Create a syllabus plan before auto-filing.' : '請先建立課綱規劃再自動歸檔。');
  }
  const assignments: Array<{ name: string; week_label: string; folder_name: string }> = [];
  const remaining: string[] = [];
  const eligible = [...store.documents.values()].filter(doc => {
    const folderId = store.documentInfo.get(doc.id)?.folder_id;
    return doc.active && doc.kind !== 'personal' && (folderId
      ? folderId === plan.root_folder_id
      : store.coursePlans.size === 1);
  });

  for (const doc of eligible) {
    const info = store.documentInfo.get(doc.id);
    const blocks = doc.blocks.filter(b => !['footer', 'page_number'].includes(b.type));
    const heading = blocks.find(b => /^\s*#{1,6} /.test(b.text))?.text.split('\n')[0].slice(0, 180) || '';
    const excerpt = info?.summary || blocks.slice(0, 12).map(b => b.text).join(' ').slice(0, 1200);
    const match = matchCourseWeek(weeks, doc.name, heading, excerpt);
    if (!match || (!match.explicit && (match.score < 0.2 || match.margin < 0.045))) {
      remaining.push(doc.name);
      continue;
    }
    const folder = ensureFolderForWeek(plan, match.week.week_number);
    store.documentInfo.set(doc.id, { document_id: doc.id, summary: info?.summary ?? null, folder_id: folder.folder_id });
    assignments.push({ name: doc.name, week_label: match.week.label, folder_name: folder.folder_name });
  }
  if (assignments.length) schedulePersist();
  return { assignments, remaining };
}

// ============================================================
// Feature 1C: Weekly Core Concept Preview (Tutor Handoff)
// ============================================================

export function cleanGeneratedMarkdown(raw: string): string {
  let fence = '';
  const markdown = stripThinkAndFence(raw).split('\n').map(line => {
    const marker = /^ {0,3}([\x60]{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      return line;
    }
    return fence ? line : line.replace(/^( {0,3}#{1,6})(?:[ \t]+#{1,6})+[ \t]+(?=\S)/, '$1 ');
  }).join('\n');
  return sanitizeLatexDelimiters(markdown);
}

export async function generateWeekPreview(params: {
  plan: CoursePlanRecord;
  weekNumber: number;
  conversationId?: string | null;
}): Promise<{ note_id: string; document_id: string; week: CourseWeekPlan } | {
  conversation_id: string;
  question: string;
  answer: string;
  html: string;
  model: string;
  week: CourseWeekPlan;
}> {
  const plan = params.plan;
  const week = plan.weeks.find((w) => w.week_number === params.weekNumber);
  if (!week) {
    throw new StudyHttpError(404, isEn() ? 'Week plan not found.' : '找不到對應的週次規劃。');
  }

  const en = isEn();
  const isExam = week.week_type === 'exam';
  const isActivity = week.week_type === 'activity';

  let question: string;
  let system: string;
  let user: string;

  if (isExam) {
    const priorLectures = plan.weeks
      .filter((w) => w.week_number < week.week_number && w.requires_material)
      .slice(-8);
    question = en
      ? `Build an exam revision roadmap for ${week.label}: ${week.title}`
      : `幫我規劃考前重點複習：${week.label} ${week.title}`;
    system = en
      ? 'You are BIIBO, a warm teaching assistant for graduate coursework. Prepare a structured exam revision checklist covering the prior lecture weeks listed below. Use concise Markdown headings, a quick comparison/review table, and 3 high-value self-check questions.'
      : '你是研究所課程學習助教 BIIBO。學生即將迎來考試週，請根據前面幾週的授課單元，整理一份清楚的考前複習路線圖。全程使用繁體中文（保留關鍵英文專有名詞），包含：1) 必考核心單元與重點對照表（Markdown 表格）、2) 建議複習順序與易混淆觀念提醒、3) 3 題高價值考前自我檢核問題。';
    user = [
      `${en ? 'Course' : '課程名稱'}：${plan.course_title}`,
      `${en ? 'Exam Week' : '考試週次'}：${week.label} — ${week.title}`,
      priorLectures.length
        ? `${en ? 'Covered Units' : '涵蓋範圍單元'}：\n${priorLectures
            .map((w) => `- ${w.label} ${w.title}${w.topics.length ? `（${w.topics.join('、')}）` : ''}`)
            .join('\n')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  } else if (isActivity) {
    question = en
      ? `Help me prepare for ${week.label}: ${week.title}`
      : `幫我整理本週活動準備清單：${week.label} ${week.title}`;
    system = en
      ? 'Write a concise Markdown personal note for this graduate course activity. Use Markdown headings, - [ ] checklist items, common evaluation criteria, and two feedback examples. Use no HTML. Mark any unconfirmed requirements for the student to verify.'
      : '請寫一份研究所課程活動的繁體中文 Markdown 個人筆記。使用 Markdown 標題、- [ ] 勾選清單、常見評分重點及兩個回饋範例。只用純 Markdown。未確認的課程規定請標示待核對。';
    user = [
      `${en ? 'Course' : '課程名稱'}：${plan.course_title}`,
      `${en ? 'Activity Week' : '活動週次'}：${week.label} — ${week.title}`,
      week.objectives.length ? `${en ? 'Objectives' : '目標'}：${week.objectives.join('；')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } else {
    question = en
      ? `Preview core concepts for ${week.label}: ${week.title}`
      : `先幫我預習本週核心觀念：${week.label} ${week.title}`;
    system = en
      ? 'You are BIIBO, a warm and clear teaching assistant for graduate coursework. The student has not uploaded this week’s slides yet and wants a concise pre-reading concept guide based on the course syllabus. Use clean Markdown with short headings, bullet points, and LaTeX math ($...$) where helpful. End with 2 thought-provoking preview questions.'
      : '你是研究所課程學習助教 BIIBO。學生尚未上傳本週講義，想根據課綱先預習本週核心觀念。請全程使用繁體中文（保留關鍵英文專有名詞），以清楚的 Markdown 條列與必要公式（$...$）整理：1) 本週 3–4 個核心觀念速覽、2) 課前先備知識提醒、3) 2 個幫助上課專注的預習引導問題。';
    user = [
      `${en ? 'Course' : '課程名稱'}：${plan.course_title}`,
      `${en ? 'Week' : '週次單元'}：${week.label} — ${week.title}`,
      week.topics.length ? `${en ? 'Key Topics' : '涵蓋主題'}：${week.topics.join('、')}` : '',
      week.objectives.length ? `${en ? 'Learning Objectives' : '學習目標'}：${week.objectives.join('；')}` : '',
      week.milestone ? `${en ? 'Milestone' : '本週進度／考試'}：${week.milestone}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const rawAnswer = await callStudyLlm({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    numPredict: 1200,
    temperature: 0.3,
  });

  const answer = cleanGeneratedMarkdown(rawAnswer);
  if (isActivity) {
    const noteId = uuidHex();
    const title = `${week.label} · ${en ? 'Activity preparation' : '活動準備清單'} · ${week.title}`.slice(0, 160);
    const documentId = await ingestDocument({
      name: title, raw: Buffer.from(answer, 'utf-8'), kind: 'personal', noteId,
    });
    store.personalNotes.set(noteId, {
      id: noteId, original_id: null, document_id: documentId, role: 'general', manually_edited: false,
    });
    schedulePersist();
    return { note_id: noteId, document_id: documentId, week };
  }

  const convId =
    params.conversationId && store.conversations.has(params.conversationId)
      ? params.conversationId
      : uuidHex();

  if (!store.conversations.has(convId)) {
    store.conversations.set(convId, {
      id: convId,
      title: `${week.label} ${week.title}`.slice(0, 55),
      created: new Date().toISOString(),
      seq: nextSeq(),
    });
  }

  const result: Record<string, unknown> = {
    model: store.settings.model,
    citations: [],
    prompt_tokens: null,
    output_tokens: null,
    answer,
    status: 'answered',
    mode: 'concept',
    retriever: 'syllabus',
    warning: null,
    week_preview: { course_id: plan.id, week_number: week.week_number, label: week.label, title: week.title },
  };

  store.turns.push({
    id: store.nextTurnId++,
    conversation_id: convId,
    question,
    answer,
    result,
  });
  schedulePersist();

  return {
    conversation_id: convId,
    question,
    answer,
    html: renderMarkdown(answer),
    model: store.settings.model,
    week,
  };
}

// ============================================================
// Feature 2: BIIBO Note Draft (Markdown + LaTeX + Tables)
// ============================================================

export type DraftStyle = 'structured' | 'formulas' | 'cheatsheet';

export async function generateNoteDraft(params: {
  documentId: string;
  scope: 'page' | 'full';
  page: number | null;
  style: DraftStyle;
}): Promise<{
  markdown: string;
  html: string;
  scope: 'page' | 'full';
  page: number | null;
  sampled_pages: number[];
  total_pages: number;
  model: string;
}> {
  const doc = store.documents.get(params.documentId);
  if (!doc || !doc.active) {
    throw new StudyHttpError(404, isEn() ? 'Material not found.' : '找不到指定的教材，請先在中間閱讀器開啟教材。');
  }

  const ctx = buildDocumentContext(doc, params.scope, params.page, DEFAULT_CONTEXT_BUDGET);
  const en = isEn();

  const styleGuideZh: Record<DraftStyle, string> = {
    structured:
      '結構化重點整理：包含「## 核心概念」、「## 關鍵方法／步驟比較（必須使用 Markdown 表格）」、「## 重要公式與符號（若有，請用 $...$ 或 $$...$$）」與「## 易混淆重點與自我檢核」。',
    formulas:
      '公式與推導整理：聚焦數學定義、符號對照表（Markdown 表格）、核心公式（使用 $$...$$ 獨立區塊）與直覺解讀，並標註來源頁碼 (P.N)。',
    cheatsheet:
      '考前速記表：以精簡條列與 1–2 張高密度 Markdown 比較表格為主，列出定義、條件、優缺點、公式與考點提醒，方便快速複習。',
  };

  const styleGuideEn: Record<DraftStyle, string> = {
    structured:
      'Structured study guide with "## Core Concepts", "## Key Comparison Table" (Markdown table), "## Key Formulas & Notation" ($...$ / $$...$$), and "## Takeaways & Checkpoints".',
    formulas:
      'Formula & derivation guide: symbol definition Markdown table, display equations using $$...$$, step-by-step intuition, and (P.N) references.',
    cheatsheet:
      'Exam cheat sheet: ultra-concise bullets plus 1-2 dense Markdown comparison tables covering definitions, conditions, formulas, pros/cons, and exam pitfalls.',
  };

  const system = en
    ? 'You are BIIBO, an assistant preparing graduate-level study notes. Draft high-clarity Markdown study notes strictly grounded in the provided [Page N] excerpts. Use Markdown headings, clean tables (| col | col |), and valid paired KaTeX ($...$ and $$...$$). Cite page numbers as (P.N) when helpful. Output ONLY Markdown content without outer code fences.'
    : '你是研究所的 BIIBO 筆記整理助教。請嚴格根據下方標有 [Page N] 的教材內容，幫學生擬定一份可直接插入個人筆記的精實 Markdown 草稿。請善用階層標題（## / ###）、Markdown 表格（| 欄位 | ... |）以及正確成對的 LaTeX 語法（行內 $...$、獨立區塊 $$...$$），並在重點處附上來源頁碼 (P.N)。全程使用繁體中文（保留關鍵英文專有名詞），直接輸出 Markdown 本文，不要在外層包覆 ```markdown。';

  const scopeDesc =
    params.scope === 'page'
      ? en
        ? `Current Page (Page ${ctx.sampledPages[0]})`
        : `目前頁面（第 ${ctx.sampledPages[0]} 頁）`
      : en
        ? `Full Material (${ctx.sampledPages.length} evenly sampled pages out of ${ctx.totalPages})`
        : `整份教材（共 ${ctx.totalPages} 頁，均勻抽樣第 ${ctx.sampledPages.join('、')} 頁）`;

  const user = `${en ? 'Material' : '教材名稱'}：${doc.name}\n${en ? 'Scope' : '整理範圍'}：${scopeDesc}\n${
    en ? 'Style' : '草稿風格'
  }：${en ? styleGuideEn[params.style] : styleGuideZh[params.style]}\n\n${
    en ? 'Excerpts:' : '教材內容摘錄：'
  }\n${ctx.contextText}`;

  const raw = await callStudyLlm({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    numPredict: 1800,
    temperature: 0.25,
  });

  const safeMarkdown = cleanGeneratedMarkdown(raw);
  return {
    markdown: safeMarkdown,
    html: renderMarkdown(safeMarkdown, doc.id),
    scope: params.scope,
    page: params.scope === 'page' ? ctx.sampledPages[0] ?? params.page : null,
    sampled_pages: ctx.sampledPages,
    total_pages: ctx.totalPages,
    model: store.settings.model,
  };
}

// ============================================================
// Feature 3: PDF Self-Test Q&A Quiz (Batched 3+2 for 5 Questions)
// ============================================================

export interface QuizQuestionItem {
  id: string;
  stem: string;
  stem_html: string;
  options: [string, string, string, string];
  options_html: [string, string, string, string];
  correct_index: number;
  hint: string;
  hint_html: string;
  explanation: string;
  explanation_html: string;
  page_ref: number | null;
  concept: string;
}

async function generateQuizBatch(params: {
  docName: string;
  contextText: string;
  batchCount: number;
  sampledPages: number[];
  avoidStems: string[];
}): Promise<QuizQuestionItem[]> {
  const en = isEn();
  const schema = {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            stem: { type: 'string' },
            options: { type: 'array', items: { type: 'string' } },
            correct_index: { type: 'integer' },
            hint: { type: 'string' },
            explanation: { type: 'string' },
            page_ref: { type: 'integer' },
            concept: { type: 'string' },
          },
          required: ['stem', 'options', 'correct_index', 'hint', 'explanation', 'page_ref', 'concept'],
        },
      },
    },
    required: ['questions'],
  };

  const system = en
    ? 'You are a graduate-level instructor creating conceptual multiple-choice self-test questions strictly from the supplied [Page N] excerpts. Every question MUST have exactly 4 plausible options (no "A." prefix inside option text), correct_index (0-3), a Socratic hint that guides without revealing the answer, a clear explanation covering why the right option is correct and why distractors are wrong, the exact integer page_ref from [Page N], and a short concept label. Output valid JSON only.'
    : '你是研究所課程命題助教，請嚴格根據標有 [Page N] 的教材內容設計互動式課後自測單選題。全程使用繁體中文（保留專有名詞與必要 $LaTeX$ 公式）。每題必須包含：stem（題幹）、options（剛好 4 個具鑑別度選項，文字中不要重複加上 A. B. C. D. 前綴）、correct_index（0–3 整數）、hint（不破題的蘇格拉底引導提示）、explanation（解析正解原因並簡述常見迷思）、page_ref（對應 [Page N] 的整數頁碼）、concept（簡短核心概念名稱）。僅輸出 JSON。';

  const avoidBlock = params.avoidStems.length
    ? `\n\n${en ? 'Do NOT duplicate or rephrase these already-created questions:' : '請勿與以下已出題目重複，改測驗其他概念或段落：'}\n${params.avoidStems
        .map((s, i) => `${i + 1}. ${s}`)
        .join('\n')}`
    : '';

  const user = `${en ? 'Material' : '教材名稱'}：${params.docName}\n${
    en
      ? `Generate exactly ${params.batchCount} grounded multiple-choice questions. Put only the question text in stem. Keep the options and answer index in their own fields.`
      : `請根據以下教材摘錄產出 ${params.batchCount} 題單選題。stem 只寫題目文字。選項與正解索引填在各自欄位。`
  }${avoidBlock}\n\n${params.contextText}`;

  const raw = await callStudyLlm({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: schema,
    numPredict: params.batchCount <= 2 ? 1200 : 1700,
    temperature: 0.3,
  });

  const parsed = parseModelJson<{ questions?: Array<Record<string, unknown>> }>(raw);
  const items = Array.isArray(parsed.questions) ? parsed.questions : [];
  const results: QuizQuestionItem[] = [];

  for (const item of items) {
    if (!item || typeof item.stem !== 'string' || !item.stem.trim()) continue;
    const { correct_index: correctIndex, page_ref: pageRef } = item;
    if (typeof correctIndex !== 'number' || !Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex > 3) continue;
    if (typeof pageRef !== 'number' || !params.sampledPages.includes(pageRef)) continue;
    if (!Array.isArray(item.options) || item.options.length !== 4 || item.options.some((o) => typeof o !== 'string')) continue;
    const opts = item.options.map((o: string) => sanitizeLatexDelimiters(o.replace(/^[A-D][.、):：]\s*/i, '').trim())) as [string, string, string, string];
    if (opts.some((o) => !o) || new Set(opts).size !== 4) continue;

    const stem = cleanGeneratedMarkdown(item.stem.replace(
      /(?:^|\n)[ \t]*(?:[-*] +)?["\x60*]*(?:options|correct_index)["\x60*]*[ \t]*[:：][\s\S]*$/i, ''
    ).trim());
    if (!stem.trim()) continue;
    const hint = sanitizeLatexDelimiters(
      typeof item.hint === 'string' && item.hint.trim()
        ? item.hint.trim()
        : en
          ? 'Re-read the key definition on the cited page and check what assumption changes.'
          : '先回想教材中該概念的核心定義與前提條件，排除與條件矛盾的選項。'
    );
    const explanation = sanitizeLatexDelimiters(
      typeof item.explanation === 'string' && item.explanation.trim()
        ? item.explanation.trim()
        : en
          ? 'Check the cited page in the material to review the supporting explanation.'
          : '請點擊頁碼對照原文段落確認推導細節。'
    );
    const concept =
      typeof item.concept === 'string' && item.concept.trim()
        ? item.concept.trim().slice(0, 40)
        : en
          ? 'Core Concept'
          : '核心概念';

    results.push({
      id: uuidHex().slice(0, 12),
      stem,
      stem_html: renderMarkdown(stem),
      options: opts,
      options_html: [
        renderMarkdown(opts[0]),
        renderMarkdown(opts[1]),
        renderMarkdown(opts[2]),
        renderMarkdown(opts[3]),
      ],
      correct_index: correctIndex,
      hint,
      hint_html: renderMarkdown(hint),
      explanation,
      explanation_html: renderMarkdown(explanation),
      page_ref: pageRef,
      concept,
    });

    if (results.length >= params.batchCount) break;
  }

  return results;
}

export async function generateDocumentQuiz(params: {
  documentId: string;
  scope: 'page' | 'full';
  page: number | null;
  count: 3 | 5;
}): Promise<{
  document_id: string;
  document_name: string;
  scope: 'page' | 'full';
  page: number | null;
  sampled_pages: number[];
  total_pages: number;
  model: string;
  batched: boolean;
  questions: QuizQuestionItem[];
}> {
  const doc = store.documents.get(params.documentId);
  if (!doc || !doc.active) {
    throw new StudyHttpError(404, isEn() ? 'Material not found.' : '找不到指定的教材。');
  }

  const ctx = buildDocumentContext(doc, params.scope, params.page, DEFAULT_CONTEXT_BUDGET);
  if (params.scope === 'page' && params.page !== null && ctx.sampledPages[0] !== params.page) {
    throw new StudyHttpError(422, isEn() ? 'This page has no readable text.' : '這一頁沒有可供出題的文字。');
  }

  let questions: QuizQuestionItem[] = [];
  let sampledPages = ctx.sampledPages;
  const batched = params.count === 5;

  if (!batched) {
    questions = await generateQuizBatch({
      docName: doc.name,
      contextText: ctx.contextText,
      batchCount: 3,
      sampledPages: ctx.sampledPages,
      avoidStems: [],
    });
  } else {
    // Refinement #3: Split 5-question generation into 3 + 2 batches to prevent small-model JSON truncation.
    const slices = ctx.pageSlices;
    let firstContext = { contextText: ctx.contextText, sampledPages: ctx.sampledPages };
    let secondContext = firstContext;

    if (params.scope === 'full' && slices.length >= 4) {
      const mid = Math.ceil(slices.length / 2);
      firstContext = stratifiedSamplePages(slices.slice(0, mid), DEFAULT_CONTEXT_BUDGET);
      secondContext = stratifiedSamplePages(slices.slice(mid), DEFAULT_CONTEXT_BUDGET);
    }
    sampledPages = [...new Set([...firstContext.sampledPages, ...secondContext.sampledPages])];

    const batch1 = await generateQuizBatch({
      docName: doc.name,
      ...firstContext,
      batchCount: 3,
      avoidStems: [],
    });

    const needed = Math.max(2, 5 - batch1.length);
    let batch2: QuizQuestionItem[] = [];
    try {
      batch2 = await generateQuizBatch({
        docName: doc.name,
        ...secondContext,
        batchCount: needed,
        avoidStems: batch1.map((q) => q.stem),
      });
    } catch (err) {
      if (!batch1.length) throw err;
    }

    questions = [...batch1, ...batch2].slice(0, 5);
  }

  if (!questions.length) {
    throw new StudyHttpError(
      502,
      isEn()
        ? 'Could not generate valid quiz questions from this excerpt. Try switching scope or regenerating.'
        : '這段教材暫時無法產出有效選擇題，請嘗試切換範圍或重新生成。'
    );
  }

  return {
    document_id: doc.id,
    document_name: doc.name,
    scope: params.scope,
    page: params.scope === 'page' ? ctx.sampledPages[0] ?? params.page : null,
    sampled_pages: sampledPages,
    total_pages: ctx.totalPages,
    model: store.settings.model,
    batched,
    questions,
  };
}
