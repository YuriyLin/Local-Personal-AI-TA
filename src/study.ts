import crypto from 'node:crypto';
import path from 'node:path';
import { extractPdfLocally, ingestDocument, mineruParse, pdfBlocks, unpack } from './ingest.js';
import { renderMarkdown, sanitizeLatexDelimiters } from './markdown.js';
import {
  CourseExamMilestone,
  CoursePlanRecord,
  CourseWeekPlan,
  DocumentRecord,
  nextSeq,
  persistStoreNow,
  schedulePersist,
  store,
  WeekType,
} from './store.js';
import { LlmError, parseJsonFromLlm, runChatCompletion, stripThinkAndFence } from './llm.js';

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
  validPages: Set<number>;
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
      validPages: new Set([match.page]),
      sampledPages: [match.page],
      totalPages,
      pageSlices: [match],
    };
  }

  const sampled = stratifiedSamplePages(slices, budget);
  return {
    contextText: sampled.contextText,
    validPages,
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
 * Deterministic guardrail paired with local LLM classification so holidays,
 * standalone exams, and peer-review/activity weeks never create empty lecture
 * folders or trigger false "missing slides" alerts.
 */
export function classifySyllabusWeek(params: {
  title: string;
  topics: string[];
  milestone: string | null;
  rawType?: unknown;
  rawRequiresMaterial?: unknown;
}): { week_type: WeekType; requires_material: boolean } {
  const combined = `${params.title} ${params.topics.join(' ')}`.trim();
  const titleLower = params.title.toLowerCase();

  const hasSubstantiveTeaching =
    /課程|介紹|導論|前處理|迴歸|分群|特徵|分類|神經網路|語言模型|檢索|建置|本地模型|檢討|講解|實作|分享|分析|設計|代理人|檢測|競賽|理論|演算法|教學|lecture|intro|preprocessing|regression|clustering|classification|selection|dnn|cnn|llm|rag|ollama|implementation|agent|workshop|tutorial/i.test(
      params.title
    );

  const isHoliday =
    /放假|停課|國定假日|假日|休假|春假|溫書假|調整放假|holiday|no\s*class|break|vacation|day\s*off/i.test(
      params.title
    );
  if (isHoliday && !hasSubstantiveTeaching) {
    return { week_type: 'holiday', requires_material: false };
  }

  const isPureExam =
    /期中考|期末考|期中測驗|期末測驗|隨堂測驗|大考|midterm|final\s*exam/i.test(titleLower) &&
    !hasSubstantiveTeaching;
  if (isPureExam) {
    return { week_type: 'exam', requires_material: false };
  }

  const isPureActivity =
    /同儕互評|互評|專題發表|成果發表|期末發表|期末報告|口頭報告|專題報告|peer\s*review|demo\s*day|presentation|showcase/i.test(
      titleLower
    ) && !hasSubstantiveTeaching;
  if (isPureActivity) {
    return { week_type: 'activity', requires_material: false };
  }

  // Respect explicit non-lecture classification from LLM when title has no substantive lecture cues.
  const rawType = typeof params.rawType === 'string' ? params.rawType.toLowerCase().trim() : '';
  if (!hasSubstantiveTeaching && (rawType === 'holiday' || rawType === 'exam' || rawType === 'activity')) {
    return { week_type: rawType, requires_material: false };
  }
  if (!hasSubstantiveTeaching && params.rawRequiresMaterial === false && /考|假|評|發表|報告|review|exam|holiday/i.test(combined)) {
    const inferred: WeekType = /假|holiday/i.test(combined)
      ? 'holiday'
      : /考|exam|midterm|quiz/i.test(combined)
        ? 'exam'
        : 'activity';
    return { week_type: inferred, requires_material: false };
  }

  return { week_type: 'lecture', requires_material: true };
}

function buildOverviewMarkdown(plan: {
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
        ? (en ? 'No class (Holiday)' : '放假停課，免上傳講義')
        : (w.objectives.length ? w.objectives : w.topics).slice(0, 3).join('；').replace(/\|/g, '／') || '—';
    const noteText = (w.milestone || (w.requires_material ? '—' : (en ? 'No slides required' : '免講義'))).replace(/\|/g, '／');
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

export async function generateSyllabusPlan(params: {
  sourceName: string;
  buffer?: Buffer | null;
  text?: string | null;
}): Promise<{
  plan: CoursePlanRecord;
  parser_engine: 'mineru' | 'pdfjs' | 'text';
  created_folders: string[];
  reused_folders: string[];
  skipped_non_material_weeks: number;
  overview_note_id: string;
  overview_document_id: string;
  overview_update_mode: 'created' | 'updated' | 'appended';
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

  const sampled = stratifiedSamplePages(rawSlices, DEFAULT_CONTEXT_BUDGET);
  if (!sampled.contextText || sampled.contextText.replace(/\s+/g, '').length < 20) {
    throw new StudyHttpError(
      422,
      en
        ? 'Please upload a syllabus file/image or paste at least a short weekly outline.'
        : '請上傳課綱檔案／截圖，或貼上包含每週主題的課程大綱文字。'
    );
  }

  const schema = {
    type: 'object',
    properties: {
      course_title: { type: 'string' },
      summary: { type: 'string' },
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
            milestone: { type: 'string' },
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
            week: { type: 'integer' },
            notes: { type: 'string' },
          },
          required: ['title', 'date', 'notes'],
        },
      },
    },
    required: ['course_title', 'summary', 'weeks', 'exams'],
  };

  const system = en
    ? 'You are an academic course planner. Extract every weekly entry and exam schedule strictly from the provided syllabus. Classify each week carefully: "lecture" (requires_material: true) for teaching/lab/guest-sharing weeks (including mixed weeks like "Topic + Quiz"); "holiday" (requires_material: false) for holidays/breaks; "exam" (requires_material: false) for standalone midterm/final exam weeks; "activity" (requires_material: false) for standalone peer review/demo/presentation weeks. Output valid JSON matching the schema.'
    : '你是大學課程規劃助理。請嚴格根據提供的課綱內容，整理出完整的每週規劃與考試／作業時程，並彈性區分每週類型 week_type 與是否需要教材資料夾 requires_material：\n' +
      '- "lecture"（requires_material: true）：有授課、實作、專案或案例分享的週次（若同一週同時有講授與小考／交作業，仍屬 lecture 並把小考或作業填在 milestone）。\n' +
      '- "holiday"（requires_material: false）：國定假日、放假、停課週。\n' +
      '- "exam"（requires_material: false）：純期中考、期末考週（無新教材講授）。\n' +
      '- "activity"（requires_material: false）：純同儕互評、期末報告或專題發表週（無需講義）。\n' +
      '全程使用繁體中文（保留關鍵英文專有名詞），每週標題精簡在 28 字以內，僅輸出符合 JSON schema 的資料。';

  const user = `${en ? 'Syllabus source' : '課綱來源'}：${params.sourceName}\n\n${sampled.contextText}\n\n${
    en
      ? 'Extract course_title, a 1-2 sentence summary, every week in order (week_number, label like "Week 1", concise title, week_type, requires_material, 1-4 topics, 1-3 objectives, milestone if any), and exams/deadlines.'
      : '請完整萃取 course_title（課程名稱）、1–2 句 summary（課程簡介）、依序整理每一週 weeks（week_number、label 如 "Week 1"、精簡 title、week_type、requires_material、topics、objectives、若有考試／小考／專題繳交請填 milestone），以及 exams 考試與重要時程。'
  }`;

  const rawReply = await callStudyLlm({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    format: schema,
    numPredict: 2600,
    temperature: 0.15,
  });

  const parsed = parseModelJson<{
    course_title?: unknown;
    summary?: unknown;
    weeks?: Array<Record<string, unknown>>;
    exams?: Array<Record<string, unknown>>;
  }>(rawReply);

  const rawWeeks = Array.isArray(parsed.weeks) ? parsed.weeks : [];
  if (!rawWeeks.length) {
    throw new StudyHttpError(
      422,
      en
        ? 'No weekly topics could be identified from this syllabus. Please include week numbers or unit headings.'
        : '無法從課綱中辨識出每週主題，請確認內容包含週次或單元名稱。'
    );
  }

  const courseTitle =
    typeof parsed.course_title === 'string' && parsed.course_title.trim()
      ? parsed.course_title.trim().slice(0, 80)
      : params.sourceName.replace(/\.[^.]+$/, '').slice(0, 80) || (en ? 'Course Plan' : '課程規劃');
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 320) : '';

  const createdFolders: string[] = [];
  const reusedFolders: string[] = [];
  let skippedNonMaterialWeeks = 0;

  const existingByKey = new Map<string, { id: string; name: string }>();
  for (const f of store.folders.values()) {
    existingByKey.set(normalizeFolderKey(f.name), { id: f.id, name: f.name });
  }

  const weeks: CourseWeekPlan[] = [];
  const seenWeekNums = new Set<number>();

  rawWeeks.slice(0, 24).forEach((w, index) => {
    let weekNum = typeof w.week_number === 'number' && Number.isInteger(w.week_number) && w.week_number > 0
      ? w.week_number
      : index + 1;
    while (seenWeekNums.has(weekNum)) weekNum++;
    seenWeekNums.add(weekNum);

    const rawLabel = typeof w.label === 'string' && w.label.trim() ? w.label.trim() : `Week ${weekNum}`;
    const label = rawLabel.slice(0, 24);
    const rawTitle = typeof w.title === 'string' && w.title.trim() ? w.title.trim() : (en ? `Unit ${weekNum}` : `單元 ${weekNum}`);
    const title = rawTitle.replace(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：-]?\\s*`, 'i'), '').trim().slice(0, 58) || rawTitle.slice(0, 58);

    const topics = Array.isArray(w.topics)
      ? w.topics.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
      : [];
    const objectives = Array.isArray(w.objectives)
      ? w.objectives.map((o) => String(o).trim()).filter(Boolean).slice(0, 5)
      : [];
    const milestone = typeof w.milestone === 'string' && w.milestone.trim() ? w.milestone.trim().slice(0, 100) : null;

    const classification = classifySyllabusWeek({
      title,
      topics,
      milestone,
      rawType: w.week_type,
      rawRequiresMaterial: w.requires_material,
    });

    let folderId: string | null = null;
    let finalFolderName: string | null = null;

    if (classification.requires_material) {
      const folderName = `${label} ${title}`.trim().slice(0, 80);
      const key = normalizeFolderKey(folderName);
      let existing = existingByKey.get(key);
      if (!existing) {
        const prefix = `${normalizeFolderKey(label)} `;
        for (const [k, v] of existingByKey.entries()) {
          if (k === normalizeFolderKey(label) || k.startsWith(prefix)) {
            existing = v;
            break;
          }
        }
      }

      if (existing) {
        folderId = existing.id;
        finalFolderName = existing.name;
        reusedFolders.push(existing.name);
      } else {
        folderId = uuidHex();
        finalFolderName = folderName;
        store.folders.set(folderId, { id: folderId, name: finalFolderName, parent_id: null });
        existingByKey.set(normalizeFolderKey(finalFolderName), { id: folderId, name: finalFolderName });
        createdFolders.push(finalFolderName);
      }
    } else {
      skippedNonMaterialWeeks++;
    }

    weeks.push({
      week_number: weekNum,
      label,
      title,
      week_type: classification.week_type,
      requires_material: classification.requires_material,
      folder_id: folderId,
      folder_name: finalFolderName,
      topics,
      objectives,
      milestone,
    });
  });

  weeks.sort((a, b) => a.week_number - b.week_number);

  const exams: CourseExamMilestone[] = (Array.isArray(parsed.exams) ? parsed.exams : [])
    .filter((e) => e && typeof e.title === 'string' && e.title.trim())
    .slice(0, 16)
    .map((e) => ({
      title: String(e.title).trim().slice(0, 80),
      date: typeof e.date === 'string' ? e.date.trim().slice(0, 48) : '',
      week: typeof e.week === 'number' && Number.isInteger(e.week) && e.week > 0 ? e.week : null,
      notes: typeof e.notes === 'string' ? e.notes.trim().slice(0, 160) : '',
    }));

  // Stage 2: Create or safely update pinned Course Overview note (Refinement #4 protection).
  const overviewMarkdown = sanitizeLatexDelimiters(
    buildOverviewMarkdown({ course_title: courseTitle, summary, weeks, exams })
  );
  const overviewTitle = en ? `Course Overview · ${courseTitle}` : `課程總覽與時程 · ${courseTitle}`;

  let existingOverview =
    (store.coursePlan?.overview_note_id ? store.personalNotes.get(store.coursePlan.overview_note_id) : undefined) ||
    [...store.personalNotes.values()].find((n) => n.role === 'course_overview');

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

  const plan: CoursePlanRecord = {
    course_title: courseTitle,
    summary,
    source_name: params.sourceName,
    parser_engine: parserEngine,
    overview_note_id: noteId,
    overview_document_id: docId,
    weeks,
    exams,
    updated_at: new Date().toISOString(),
  };
  store.coursePlan = plan;
  persistStoreNow();

  return {
    plan,
    parser_engine: parserEngine,
    created_folders: createdFolders,
    reused_folders: reusedFolders,
    skipped_non_material_weeks: skippedNonMaterialWeeks,
    overview_note_id: noteId,
    overview_document_id: docId,
    overview_update_mode: overviewUpdateMode,
  };
}

export function ensureFolderForWeek(weekNumber: number): {
  folder_id: string;
  folder_name: string;
  week: CourseWeekPlan;
} {
  const plan = store.coursePlan;
  const week = plan?.weeks.find((w) => w.week_number === weekNumber);
  if (!plan || !week) {
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
  const existing = [...store.folders.values()].find((f) => normalizeFolderKey(f.name) === normalizeFolderKey(folderName));
  let folderId: string;
  let finalName: string;
  if (existing) {
    folderId = existing.id;
    finalName = existing.name;
  } else {
    folderId = uuidHex();
    finalName = folderName;
    store.folders.set(folderId, { id: folderId, name: finalName, parent_id: null });
  }
  week.folder_id = folderId;
  week.folder_name = finalName;
  persistStoreNow();
  return { folder_id: folderId, folder_name: finalName, week };
}

// ============================================================
// Feature 1B: Smart Week Folder Recommendation on Material Import
// ============================================================

function tokenizeForMatch(text: string): Set<string> {
  const lower = text.toLowerCase().replace(/[_.\-()/\\[\]]+/g, ' ');
  const tokens = new Set<string>();
  // English / numeric words
  for (const w of lower.match(/[a-z0-9]{2,}/g) || []) {
    if (!['pdf', 'txt', 'md', 'lecture', 'slides', 'notes', 'file', 'copy'].includes(w)) {
      tokens.add(w);
    }
  }
  // CJK 2-grams
  const cjk = lower.replace(/[^\u4e00-\u9fff]+/g, '');
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.add(cjk.slice(i, i + 2));
  }
  return tokens;
}

function detectExplicitWeekNumber(filename: string): number | null {
  const match = /(?:week|wk|w|lec|lecture|ch|chapter|unit)\s*0*(\d{1,2})\b|第\s*0*(\d{1,2})\s*[週周章]/i.exec(filename);
  if (!match) return null;
  const num = Number.parseInt(match[1] || match[2], 10);
  return Number.isInteger(num) && num >= 1 && num <= 24 ? num : null;
}

export function recommendFolderForMaterial(filename: string, preview = ''): {
  folder_id: string;
  folder_name: string;
  week_label: string | null;
  score: number;
  reason: string;
} | null {
  const queryText = `${filename} ${preview.slice(0, 600)}`;
  const queryTokens = tokenizeForMatch(queryText);
  const explicitWeek = detectExplicitWeekNumber(filename);

  type Candidate = { folder_id: string; folder_name: string; week_label: string | null; score: number; reason: string };
  const candidates: Candidate[] = [];

  if (store.coursePlan?.weeks.length) {
    for (const w of store.coursePlan.weeks) {
      if (!w.folder_id) continue;
      const folder = store.folders.get(w.folder_id);
      if (!folder) continue;
      let score = 0;
      const reasons: string[] = [];

      if (explicitWeek !== null && explicitWeek === w.week_number) {
        score += 0.65;
        reasons.push(isEn() ? `Matches ${w.label}` : `檔名符合 ${w.label}`);
      }

      const targetText = `${w.label} ${w.title} ${w.topics.join(' ')} ${w.objectives.join(' ')}`;
      const targetTokens = tokenizeForMatch(targetText);
      let overlap = 0;
      for (const tok of queryTokens) {
        if (targetTokens.has(tok)) overlap++;
      }
      if (overlap > 0 && targetTokens.size > 0) {
        const sim = overlap / Math.sqrt(queryTokens.size * targetTokens.size);
        score += sim * 1.1;
        reasons.push(isEn() ? `Topic match (${w.title})` : `主題符合「${w.title}」`);
      }

      if (score >= 0.16) {
        candidates.push({
          folder_id: folder.id,
          folder_name: folder.name,
          week_label: w.label,
          score,
          reason: reasons.join(' · '),
        });
      }
    }
  } else {
    for (const f of store.folders.values()) {
      const targetTokens = tokenizeForMatch(f.name);
      let overlap = 0;
      for (const tok of queryTokens) {
        if (targetTokens.has(tok)) overlap++;
      }
      if (overlap > 0 && targetTokens.size > 0) {
        const score = overlap / Math.sqrt(queryTokens.size * targetTokens.size);
        if (score >= 0.22) {
          candidates.push({
            folder_id: f.id,
            folder_name: f.name,
            week_label: null,
            score,
            reason: isEn() ? `Matches folder "${f.name}"` : `符合分類「${f.name}」`,
          });
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

// ============================================================
// Feature 1C: Weekly Core Concept Preview (Tutor Handoff)
// ============================================================

export async function generateWeekPreview(params: {
  weekNumber: number;
  conversationId?: string | null;
}): Promise<{
  conversation_id: string;
  question: string;
  answer: string;
  html: string;
  model: string;
  week: CourseWeekPlan;
}> {
  const plan = store.coursePlan;
  const week = plan?.weeks.find((w) => w.week_number === params.weekNumber);
  if (!plan || !week) {
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
      ? 'You are BIIBO, a warm university teaching assistant. Prepare a structured exam revision checklist covering the prior lecture weeks listed below. Use concise Markdown headings, a quick comparison/review table, and 3 high-value self-check questions.'
      : '你是大學課程學習助教 BIIBO。學生即將迎來考試週，請根據前面幾週的授課單元，整理一份清楚的考前複習路線圖。全程使用繁體中文（保留關鍵英文專有名詞），包含：1) 必考核心單元與重點對照表（Markdown 表格）、2) 建議複習順序與易混淆觀念提醒、3) 3 題高價值考前自我檢核問題。';
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
      ? 'You are BIIBO, a helpful university teaching assistant. Give the student a concise preparation checklist and evaluation criteria guide for this project/peer-review/presentation week in clean Markdown.'
      : '你是大學課程學習助教 BIIBO。本週為專題發表／同儕互評／評量活動週，請以清楚的 Markdown 條列幫學生整理：1) 課前準備檢核清單、2) 互評或報告常見評分重點、3) 2 個提問或回饋範例。';
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
      ? 'You are BIIBO, a warm and clear university teaching assistant. The student has not uploaded this week’s slides yet and wants a concise pre-reading concept guide based on the course syllabus. Use clean Markdown with short headings, bullet points, and LaTeX math ($...$) where helpful. End with 2 thought-provoking preview questions.'
      : '你是大學課程學習助教 BIIBO。學生尚未上傳本週講義，想根據課綱先預習本週核心觀念。請全程使用繁體中文（保留關鍵英文專有名詞），以清楚的 Markdown 條列與必要公式（$...$）整理：1) 本週 3–4 個核心觀念速覽、2) 課前先備知識提醒、3) 2 個幫助上課專注的預習引導問題。';
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

  const answer = sanitizeLatexDelimiters(stripThinkAndFence(rawAnswer));
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
    week_preview: { week_number: week.week_number, label: week.label, title: week.title },
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
    ? 'You are BIIBO, an expert study note writer. Draft high-clarity Markdown study notes strictly grounded in the provided [Page N] excerpts. Use Markdown headings, clean tables (| col | col |), and valid paired KaTeX ($...$ and $$...$$). Cite page numbers as (P.N) when helpful. Output ONLY Markdown content without outer code fences.'
    : '你是 BIIBO 筆記整理助教。請嚴格根據下方標有 [Page N] 的教材內容，幫學生擬定一份可直接插入個人筆記的精實 Markdown 草稿。請善用階層標題（## / ###）、Markdown 表格（| 欄位 | ... |）以及正確成對的 LaTeX 語法（行內 $...$、獨立區塊 $$...$$），並在重點處附上來源頁碼 (P.N)。全程使用繁體中文（保留關鍵英文專有名詞），直接輸出 Markdown 本文，不要在外層包覆 ```markdown。';

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

  const safeMarkdown = sanitizeLatexDelimiters(stripThinkAndFence(raw));
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
  validPages: Set<number>;
  fallbackPage: number | null;
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
    ? 'You are a university instructor creating conceptual multiple-choice self-test questions strictly from the supplied [Page N] excerpts. Every question MUST have exactly 4 plausible options (no "A." prefix inside option text), correct_index (0-3), a Socratic hint that guides without revealing the answer, a clear explanation covering why the right option is correct and why distractors are wrong, the exact integer page_ref from [Page N], and a short concept label. Output valid JSON only.'
    : '你是大學課程命題助教，請嚴格根據標有 [Page N] 的教材內容設計互動式課後自測單選題。全程使用繁體中文（保留專有名詞與必要 $LaTeX$ 公式）。每題必須包含：stem（題幹）、options（剛好 4 個具鑑別度選項，文字中不要重複加上 A. B. C. D. 前綴）、correct_index（0–3 整數）、hint（不破題的蘇格拉底引導提示）、explanation（解析正解原因並簡述常見迷思）、page_ref（對應 [Page N] 的整數頁碼）、concept（簡短核心概念名稱）。僅輸出 JSON。';

  const avoidBlock = params.avoidStems.length
    ? `\n\n${en ? 'Do NOT duplicate or rephrase these already-created questions:' : '請勿與以下已出題目重複，改測驗其他概念或段落：'}\n${params.avoidStems
        .map((s, i) => `${i + 1}. ${s}`)
        .join('\n')}`
    : '';

  const user = `${en ? 'Material' : '教材名稱'}：${params.docName}\n${
    en
      ? `Generate exactly ${params.batchCount} multiple-choice questions grounded in the excerpts below.`
      : `請根據以下教材摘錄，精準產出 ${params.batchCount} 題單選測驗題。`
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
    const rawOpts = Array.isArray(item.options)
      ? item.options.map((o) => String(o).replace(/^[A-D][.、):：]\s*/i, '').trim()).filter(Boolean)
      : [];
    if (rawOpts.length < 4) continue;

    const opts = rawOpts.slice(0, 4).map((o) => sanitizeLatexDelimiters(o)) as [string, string, string, string];
    const rawIdx = typeof item.correct_index === 'number' && Number.isInteger(item.correct_index) ? item.correct_index : 0;
    const correctIndex = rawIdx >= 0 && rawIdx <= 3 ? rawIdx : 0;

    const stem = sanitizeLatexDelimiters(item.stem.trim());
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

    let pageRef: number | null =
      typeof item.page_ref === 'number' && Number.isInteger(item.page_ref) && params.validPages.has(item.page_ref)
        ? item.page_ref
        : params.fallbackPage;
    if (pageRef !== null && !params.validPages.has(pageRef)) {
      pageRef = params.fallbackPage;
    }

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
  const fallbackPage = params.scope === 'page' ? (ctx.sampledPages[0] ?? null) : null;

  let questions: QuizQuestionItem[] = [];
  const batched = params.count === 5;

  if (!batched) {
    questions = await generateQuizBatch({
      docName: doc.name,
      contextText: ctx.contextText,
      batchCount: 3,
      validPages: ctx.validPages,
      fallbackPage,
      avoidStems: [],
    });
  } else {
    // Refinement #3: Split 5-question generation into 3 + 2 batches to prevent small-model JSON truncation.
    const slices = ctx.pageSlices;
    let firstContext = ctx.contextText;
    let secondContext = ctx.contextText;

    if (params.scope === 'full' && slices.length >= 4) {
      const mid = Math.ceil(slices.length / 2);
      firstContext = stratifiedSamplePages(slices.slice(0, mid), DEFAULT_CONTEXT_BUDGET).contextText;
      secondContext = stratifiedSamplePages(slices.slice(mid), DEFAULT_CONTEXT_BUDGET).contextText;
    }

    const batch1 = await generateQuizBatch({
      docName: doc.name,
      contextText: firstContext,
      batchCount: 3,
      validPages: ctx.validPages,
      fallbackPage,
      avoidStems: [],
    });

    const needed = Math.max(2, 5 - batch1.length);
    let batch2: QuizQuestionItem[] = [];
    try {
      batch2 = await generateQuizBatch({
        docName: doc.name,
        contextText: secondContext,
        batchCount: needed,
        validPages: ctx.validPages,
        fallbackPage,
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
    sampled_pages: ctx.sampledPages,
    total_pages: ctx.totalPages,
    model: store.settings.model,
    batched,
    questions,
  };
}
