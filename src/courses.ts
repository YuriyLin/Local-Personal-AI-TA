import crypto from 'node:crypto';
import { ingestDocument } from './ingest.js';
import {
  COURSE_COLOR_IDS,
  CalendarEventCategory,
  CalendarEventRecord,
  CourseColorId,
  CourseExamMilestone,
  CoursePlanRecord,
  CourseSchedule,
  CourseWeekPlan,
  FolderRecord,
  WeekType,
  persistStoreNow,
  store,
} from './store.js';
import { sanitizeLatexDelimiters } from './markdown.js';
import {
  StudyHttpError,
  buildOverviewMarkdown,
  otherCourseFolders,
} from './study.js';

const uuidHex = (): string => crypto.randomUUID().replace(/-/g, '');
const isEn = (): boolean => store.settings.language === 'en';

export interface CourseColorPaletteEntry {
  id: CourseColorId;
  label_zh: string;
  label_en: string;
  accent: string;
  tint: string;
  ink: string;
  border: string;
}

export const COURSE_PALETTE: readonly CourseColorPaletteEntry[] = [
  {
    id: 'mint',
    label_zh: '森綠',
    label_en: 'Forest Mint',
    accent: '#2d8f74',
    tint: 'rgba(45, 143, 116, 0.12)',
    ink: '#1b5e4b',
    border: 'rgba(45, 143, 116, 0.28)',
  },
  {
    id: 'lavender',
    label_zh: '薰衣草',
    label_en: 'Lavender',
    accent: '#7a68b8',
    tint: 'rgba(122, 104, 184, 0.13)',
    ink: '#4b3a84',
    border: 'rgba(122, 104, 184, 0.30)',
  },
  {
    id: 'amber',
    label_zh: '暖琥珀',
    label_en: 'Warm Amber',
    accent: '#c88a2e',
    tint: 'rgba(200, 138, 46, 0.13)',
    ink: '#7a4d0c',
    border: 'rgba(200, 138, 46, 0.32)',
  },
  {
    id: 'slate',
    label_zh: '海霧藍',
    label_en: 'Slate Blue',
    accent: '#3b7ea1',
    tint: 'rgba(59, 126, 161, 0.12)',
    ink: '#1f526e',
    border: 'rgba(59, 126, 161, 0.28)',
  },
  {
    id: 'rose',
    label_zh: '豆沙紅',
    label_en: 'Dusty Rose',
    accent: '#c46572',
    tint: 'rgba(196, 101, 114, 0.12)',
    ink: '#842d3a',
    border: 'rgba(196, 101, 114, 0.30)',
  },
  {
    id: 'sage',
    label_zh: '鼠尾草',
    label_en: 'Sage',
    accent: '#5a8a63',
    tint: 'rgba(90, 138, 99, 0.12)',
    ink: '#2f5a38',
    border: 'rgba(90, 138, 99, 0.28)',
  },
  {
    id: 'indigo',
    label_zh: '岩灰藍',
    label_en: 'Indigo Slate',
    accent: '#5c6f82',
    tint: 'rgba(92, 111, 130, 0.12)',
    ink: '#334354',
    border: 'rgba(92, 111, 130, 0.28)',
  },
  {
    id: 'terracotta',
    label_zh: '珊瑚橘',
    label_en: 'Terracotta',
    accent: '#cc734c',
    tint: 'rgba(204, 115, 76, 0.13)',
    ink: '#873a19',
    border: 'rgba(204, 115, 76, 0.32)',
  },
] as const;

export const VALID_EVENT_CATEGORIES = new Set<CalendarEventCategory>(['todo', 'deadline', 'exam', 'reminder']);
const VALID_WEEK_TYPES = new Set<WeekType>(['lecture', 'holiday', 'exam', 'activity']);

export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isValidTime(value: unknown): value is string {
  if (value === '' || value === null || value === undefined) return true;
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function normalizeColorId(raw: unknown, fallbackIndex = 0): CourseColorId {
  if (typeof raw === 'string' && (COURSE_COLOR_IDS as readonly string[]).includes(raw)) {
    return raw as CourseColorId;
  }
  return COURSE_COLOR_IDS[Math.abs(fallbackIndex) % COURSE_COLOR_IDS.length];
}

export function normalizeWeekdays(raw: unknown, fallback: number[] = [1]): number[] {
  if (!Array.isArray(raw)) return [...fallback];
  const unique = [...new Set(raw.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))].sort(
    (a, b) => a - b
  );
  return unique.length ? unique : [...fallback];
}

export function pickNextCourseColor(excludeCourseId?: string): CourseColorId {
  const counts = new Map<CourseColorId, number>(COURSE_COLOR_IDS.map((id) => [id, 0]));
  for (const plan of store.coursePlans.values()) {
    if (plan.id === excludeCourseId) continue;
    const color = plan.schedule?.color;
    if (color && counts.has(color)) counts.set(color, (counts.get(color) || 0) + 1);
  }
  let best: CourseColorId = COURSE_COLOR_IDS[0];
  let minCount = Infinity;
  for (const id of COURSE_COLOR_IDS) {
    const c = counts.get(id) || 0;
    if (c < minCount) {
      minCount = c;
      best = id;
    }
  }
  return best;
}

export function ensureCourseSchedule(plan: CoursePlanRecord, index = 0): CourseSchedule {
  const s = plan.schedule;
  return {
    color: normalizeColorId(s?.color, index),
    weekdays: normalizeWeekdays(s?.weekdays, [1]),
    start_date_override: isValidIsoDate(s?.start_date_override) ? s.start_date_override : null,
    location: typeof s?.location === 'string' ? s.location.trim().slice(0, 120) : '',
    manual_override: Boolean(s?.manual_override),
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatUtcDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function addUtcDays(isoDate: string, deltaDays: number): string | null {
  if (!isValidIsoDate(isoDate)) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return formatUtcDate(dt);
}

/**
 * Projects a course's Week N onto actual ISO YYYY-MM-DD dates using the Monday of the
 * anchor week (effectiveStart = start_date_override || semester_start_date) plus weekdays (0=Sun..6=Sat).
 */
export function projectWeekDates(
  effectiveStart: string | null,
  weekNumber: number,
  weekdays: number[]
): string[] {
  if (!isValidIsoDate(effectiveStart) || !Number.isInteger(weekNumber) || weekNumber < 1) return [];
  const days = normalizeWeekdays(weekdays, [1]);
  const [y, m, d] = effectiveStart.split('-').map(Number);
  const anchor = new Date(Date.UTC(y, m - 1, d));
  const anchorDow = anchor.getUTCDay(); // 0=Sun .. 6=Sat
  const diffToMonday = anchorDow === 0 ? -6 : 1 - anchorDow;
  const week1Monday = new Date(Date.UTC(y, m - 1, d + diffToMonday));
  const weekOffsetDays = (weekNumber - 1) * 7;

  const dates = days.map((wd) => {
    const dayInMonWeek = wd === 0 ? 6 : wd - 1;
    const dt = new Date(
      Date.UTC(
        week1Monday.getUTCFullYear(),
        week1Monday.getUTCMonth(),
        week1Monday.getUTCDate() + weekOffsetDays + dayInMonWeek
      )
    );
    return formatUtcDate(dt);
  });
  return [...new Set(dates)].sort();
}

const MONTH_NAME_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

export function parseExplicitDate(raw: string, fallbackYear?: number): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.normalize('NFKC');

  // YYYY-MM-DD, YYYY/M/D, YYYY.M.D
  const ymd = text.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
  if (ymd) {
    const candidate = `${ymd[1]}-${pad2(Number(ymd[2]))}-${pad2(Number(ymd[3]))}`;
    if (isValidIsoDate(candidate)) return candidate;
  }

  // YYYY年M月D日
  const zh = text.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
  if (zh) {
    const candidate = `${zh[1]}-${pad2(Number(zh[2]))}-${pad2(Number(zh[3]))}`;
    if (isValidIsoDate(candidate)) return candidate;
  }

  // Sep 8, 2026 / September 8 2026
  const mdy = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+|\s+)(20\d{2})\b/i);
  if (mdy) {
    const month = MONTH_NAME_MAP[mdy[1].toLowerCase()];
    if (month) {
      const candidate = `${mdy[3]}-${pad2(month)}-${pad2(Number(mdy[2]))}`;
      if (isValidIsoDate(candidate)) return candidate;
    }
  }

  // 8 Sep 2026
  const dmy = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?,?\s+(20\d{2})\b/i);
  if (dmy) {
    const month = MONTH_NAME_MAP[dmy[2].toLowerCase()];
    if (month) {
      const candidate = `${dmy[3]}-${pad2(month)}-${pad2(Number(dmy[1]))}`;
      if (isValidIsoDate(candidate)) return candidate;
    }
  }

  // Optional year-less formats when fallbackYear is provided (e.g. "10月15日", "11/12")
  if (fallbackYear && Number.isInteger(fallbackYear)) {
    const zhShort = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (zhShort) {
      const candidate = `${fallbackYear}-${pad2(Number(zhShort[1]))}-${pad2(Number(zhShort[2]))}`;
      if (isValidIsoDate(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * Deterministic extractor for course meeting weekdays (0..6) and Week 1 / start date (YYYY-MM-DD)
 * from syllabus headers and Week 1 lines. Used both to complement LLM extraction and as offline fallback.
 */
export function detectScheduleFromSyllabusText(sourceText: string): {
  detected_weekdays: number[];
  detected_start_date: string | null;
} {
  const normalized = sourceText.normalize('NFKC');
  const lines = normalized.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const headerSlice = lines.slice(0, 28);

  const weekdaySet = new Set<number>();

  const extractWeekdaysFromLine = (line: string) => {
    const zhMatches = line.matchAll(/(?:每?星期|每?週|每?周|禮拜)([一二三四五六日天](?:[\s、,，/＆&與和]+[一二三四五六日天])*)/g);
    const zhMap: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
    for (const m of zhMatches) {
      for (const ch of m[1]) {
        if (ch in zhMap) weekdaySet.add(zhMap[ch]);
      }
    }

    const enPatterns: Array<[RegExp, number]> = [
      [/\b(?:sun(?:day)?)\b/i, 0],
      [/\b(?:mon(?:day)?)\b/i, 1],
      [/\b(?:tue(?:s|sday)?)\b/i, 2],
      [/\b(?:wed(?:nesday)?)\b/i, 3],
      [/\b(?:thu(?:r|rs|rsday)?)\b/i, 4],
      [/\b(?:fri(?:day)?)\b/i, 5],
      [/\b(?:sat(?:urday)?)\b/i, 6],
    ];
    // Only scan English weekday tokens on lines that look like schedule/time/class metadata (avoid matching "Holiday" or random prose).
    const looksLikeTimeLine =
      /(?:time|schedule|class|lecture|meeting|hour|room|上課|時間|時段|節次|\d{1,2}:\d{2}|\b(?:am|pm)\b|^(?:mon|tue|wed|thu|fri|sat|sun)\b)/i.test(
        line
      );
    if (looksLikeTimeLine) {
      for (const [re, dow] of enPatterns) {
        if (re.test(line)) weekdaySet.add(dow);
      }
    }
  };

  for (const line of headerSlice) {
    // Stop header scan once we're deep past Week 2
    if (/^(?:#{1,6}\s*)?(?:week\s*3|第\s*3\s*[週周])/i.test(line)) break;
    extractWeekdaysFromLine(line);
  }

  let detectedStartDate: string | null = null;
  // Priority 1: explicit Week 1 line with a full date
  for (const line of lines.slice(0, 60)) {
    if (/(?:^|\b)(?:week\s*1|wk\.?\s*1|第\s*1\s*[週周])(?:\s|$|[:：(（–-])/i.test(line)) {
      const found = parseExplicitDate(line);
      if (found) {
        detectedStartDate = found;
        break;
      }
    }
  }
  // Priority 2: explicit start date label in header (e.g. "Start Date: 2026-09-08", "開學日：2026/09/07")
  if (!detectedStartDate) {
    for (const line of headerSlice) {
      if (/(?:start\s*date|first\s*(?:day|class)|開學|第一週|第1週|起始日)/i.test(line)) {
        const found = parseExplicitDate(line);
        if (found) {
          detectedStartDate = found;
          break;
        }
      }
    }
  }

  // If we found an explicit Week 1 date and no weekday text was listed, infer weekday from Week 1 date!
  if (weekdaySet.size === 0 && detectedStartDate) {
    const [y, m, d] = detectedStartDate.split('-').map(Number);
    weekdaySet.add(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
  }

  return {
    detected_weekdays: [...weekdaySet].sort((a, b) => a - b),
    detected_start_date: detectedStartDate,
  };
}

function formatTimestamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function normalizeFolderKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

function cleanStringArray(input: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const trimmed = item.replace(/\s+/g, ' ').trim().slice(0, maxLen);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
    if (out.length >= maxItems) break;
  }
  return out;
}

export interface EditableWeekInput {
  prev_week_number?: unknown;
  folder_id?: unknown;
  week_number?: unknown;
  label?: unknown;
  title?: unknown;
  week_type?: unknown;
  topics?: unknown;
  objectives?: unknown;
  milestone?: unknown;
}

export interface EditableExamInput {
  title?: unknown;
  date?: unknown;
  week?: unknown;
  notes?: unknown;
}

export interface CourseMutationPayload {
  course_title?: unknown;
  summary?: unknown;
  schedule?: {
    color?: unknown;
    weekdays?: unknown;
    start_date_override?: unknown;
    location?: unknown;
  };
  weeks?: EditableWeekInput[];
  exams?: EditableExamInput[];
}

function validateCourseScheduleInput(
  raw: CourseMutationPayload['schedule'],
  fallback: CourseSchedule
): CourseSchedule {
  if (!raw || typeof raw !== 'object') return fallback;
  const color = normalizeColorId(raw.color, COURSE_COLOR_IDS.indexOf(fallback.color));
  let weekdays = fallback.weekdays;
  if (raw.weekdays !== undefined) {
    if (!Array.isArray(raw.weekdays)) {
      throw new StudyHttpError(422, isEn() ? 'Invalid class weekdays.' : '上課星期格式不正確。');
    }
    const validDays = [...new Set(raw.weekdays.filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))].sort(
      (a, b) => a - b
    );
    if (!validDays.length) {
      throw new StudyHttpError(422, isEn() ? 'Select at least one class weekday.' : '請至少選擇一個上課星期。');
    }
    weekdays = validDays;
  }

  let startOverride = fallback.start_date_override;
  if (raw.start_date_override !== undefined) {
    if (raw.start_date_override === null || raw.start_date_override === '') {
      startOverride = null;
    } else if (isValidIsoDate(raw.start_date_override)) {
      startOverride = raw.start_date_override;
    } else {
      throw new StudyHttpError(422, isEn() ? 'Invalid start date (use YYYY-MM-DD).' : '開學日格式須為 YYYY-MM-DD。');
    }
  }

  const location =
    typeof raw.location === 'string' ? raw.location.replace(/\s+/g, ' ').trim().slice(0, 120) : fallback.location;

  return {
    color,
    weekdays,
    start_date_override: startOverride,
    location,
    manual_override: true,
  };
}

function validateExamsInput(raw: unknown): CourseExamMilestone[] {
  if (!Array.isArray(raw)) return [];
  const exams: CourseExamMilestone[] = [];
  for (const item of raw.slice(0, 40)) {
    if (!item || typeof item !== 'object') continue;
    const ex = item as EditableExamInput;
    const title = typeof ex.title === 'string' ? ex.title.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    if (!title) continue;
    let date = '';
    if (typeof ex.date === 'string' && ex.date.trim()) {
      const trimmed = ex.date.trim().slice(0, 60);
      date = parseExplicitDate(trimmed) || trimmed;
    }
    const week =
      typeof ex.week === 'number' && Number.isInteger(ex.week) && ex.week >= 1 && ex.week <= 60 ? ex.week : null;
    const notes = typeof ex.notes === 'string' ? ex.notes.replace(/\s+/g, ' ').trim().slice(0, 180) : '';
    exams.push({ title, date, week, notes });
  }
  return exams;
}

async function syncOverviewNote(params: {
  existingNoteId: string | null;
  courseTitle: string;
  summary: string;
  weeks: CourseWeekPlan[];
  exams: CourseExamMilestone[];
}): Promise<{ noteId: string; docId: string; updateMode: 'created' | 'updated' | 'appended' }> {
  const en = isEn();
  const overviewMarkdown = sanitizeLatexDelimiters(
    buildOverviewMarkdown({
      course_title: params.courseTitle,
      summary: params.summary,
      weeks: params.weeks,
      exams: params.exams,
    })
  );
  const overviewTitle = en
    ? `Course Overview · ${params.courseTitle}`
    : `課程總覽與時程 · ${params.courseTitle}`;

  const existingOverview = params.existingNoteId ? store.personalNotes.get(params.existingNoteId) : undefined;
  let updateMode: 'created' | 'updated' | 'appended' = 'created';
  let finalMarkdown = overviewMarkdown;
  let finalTitle = overviewTitle.slice(0, 160);
  let keepManuallyEdited = false;

  if (existingOverview) {
    const prevDoc = store.documents.get(existingOverview.document_id);
    if (existingOverview.manually_edited && prevDoc) {
      const heading = en
        ? `## Course Update (${formatTimestamp()})`
        : `## 課綱調整（${formatTimestamp()}）`;
      finalMarkdown = `${prevDoc.markdown.trimEnd()}\n\n---\n\n${heading}\n\n${overviewMarkdown}`;
      finalTitle = prevDoc.name;
      updateMode = 'appended';
      keepManuallyEdited = true;
    } else {
      updateMode = 'updated';
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

  return { noteId, docId, updateMode };
}

export async function createManualCourse(payload: CourseMutationPayload) {
  const en = isEn();
  const courseTitle =
    typeof payload.course_title === 'string'
      ? payload.course_title.replace(/\s+/g, ' ').trim().slice(0, 80)
      : '';
  if (!courseTitle) {
    throw new StudyHttpError(422, en ? 'Please enter a course title.' : '請輸入課程名稱。');
  }
  const summary =
    typeof payload.summary === 'string' ? payload.summary.replace(/\s+/g, ' ').trim().slice(0, 320) : '';

  const defaultSchedule: CourseSchedule = {
    color: pickNextCourseColor(),
    weekdays: [1],
    start_date_override: null,
    location: '',
    manual_override: true,
  };
  const schedule = validateCourseScheduleInput(payload.schedule, defaultSchedule);

  const rootFolder: FolderRecord = { id: uuidHex(), name: courseTitle, parent_id: null };
  store.folders.set(rootFolder.id, rootFolder);

  const rawWeeks = Array.isArray(payload.weeks) && payload.weeks.length
    ? payload.weeks
    : [
        {
          week_number: 1,
          label: 'Week 1',
          title: en ? 'Course Introduction' : '課程介紹與導論',
          week_type: 'lecture' as WeekType,
          topics: [],
          objectives: [],
          milestone: null,
        },
      ];

  const usedNumbers = new Set<number>();
  let nextNum = 1;
  const weeks: CourseWeekPlan[] = [];
  const createdFolders: string[] = [];

  for (const item of rawWeeks.slice(0, 48)) {
    const title = typeof item?.title === 'string' ? item.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    if (!title) continue;
    let weekNum =
      typeof item.week_number === 'number' && Number.isInteger(item.week_number) && item.week_number >= 1
        ? item.week_number
        : nextNum;
    while (usedNumbers.has(weekNum)) weekNum++;
    usedNumbers.add(weekNum);
    nextNum = Math.max(nextNum, weekNum + 1);

    const label =
      typeof item.label === 'string' && item.label.trim()
        ? item.label.replace(/\s+/g, ' ').trim().slice(0, 32)
        : `Week ${weekNum}`;
    const weekType: WeekType = VALID_WEEK_TYPES.has(item.week_type as WeekType)
      ? (item.week_type as WeekType)
      : 'lecture';
    const requiresMaterial = weekType === 'lecture';
    const topics = cleanStringArray(item.topics, 8, 140);
    const objectives = requiresMaterial ? cleanStringArray(item.objectives, 4, 160) : [];
    const milestone =
      typeof item.milestone === 'string' && item.milestone.trim()
        ? item.milestone.replace(/\s+/g, ' ').trim().slice(0, 160)
        : null;

    let folderId: string | null = null;
    let folderName: string | null = null;
    if (requiresMaterial) {
      folderId = uuidHex();
      folderName = `${label} ${title}`.trim().slice(0, 80);
      store.folders.set(folderId, { id: folderId, name: folderName, parent_id: rootFolder.id });
      createdFolders.push(folderName);
    }

    weeks.push({
      week_number: weekNum,
      label,
      title,
      week_type: weekType,
      requires_material: requiresMaterial,
      folder_id: folderId,
      folder_name: folderName,
      topics,
      objectives,
      milestone,
    });
  }

  weeks.sort((a, b) => a.week_number - b.week_number);
  const exams = validateExamsInput(payload.exams);

  const overview = await syncOverviewNote({
    existingNoteId: null,
    courseTitle,
    summary,
    weeks,
    exams,
  });

  const plan: CoursePlanRecord = {
    id: uuidHex(),
    root_folder_id: rootFolder.id,
    course_title: courseTitle,
    summary,
    source_name: en ? 'Manual Course Plan' : '手動建立課程',
    parser_engine: 'text',
    overview_note_id: overview.noteId,
    overview_document_id: overview.docId,
    weeks,
    exams,
    schedule,
    updated_at: new Date().toISOString(),
  };

  store.coursePlans.set(plan.id, plan);
  if (!store.calendarSettings.semester_start_date && schedule.start_date_override) {
    store.calendarSettings.semester_start_date = schedule.start_date_override;
  }
  persistStoreNow();

  return {
    plan,
    created_folders: createdFolders,
    overview_update_mode: overview.updateMode,
  };
}

/**
 * Full course & syllabus update with strict folder/file protection:
 * 1. Renaming a week's label or title automatically syncs its sidebar folder name.
 * 2. Deleting a week NEVER deletes uploaded PDFs or notes — any files or subfolders inside
 *    the removed week folder are automatically moved back to the course root folder before
 *    removing the emptied week folder.
 */
export async function updateFullCourse(courseId: string, payload: CourseMutationPayload) {
  const en = isEn();
  const previous = store.coursePlans.get(courseId);
  if (!previous) {
    throw new StudyHttpError(404, en ? 'Course not found.' : '找不到這門課程。');
  }

  const courseTitle =
    typeof payload.course_title === 'string' && payload.course_title.trim()
      ? payload.course_title.replace(/\s+/g, ' ').trim().slice(0, 80)
      : previous.course_title;
  if (!courseTitle) {
    throw new StudyHttpError(422, en ? 'Course title cannot be empty.' : '課程名稱不可為空白。');
  }
  const summary =
    typeof payload.summary === 'string'
      ? payload.summary.replace(/\s+/g, ' ').trim().slice(0, 320)
      : previous.summary;

  const existingSchedule = ensureCourseSchedule(previous);
  const schedule = validateCourseScheduleInput(payload.schedule, existingSchedule);

  const reservedFolders = otherCourseFolders(previous.id);
  let rootFolder = previous.root_folder_id ? store.folders.get(previous.root_folder_id) : undefined;
  if (!rootFolder) {
    rootFolder = { id: uuidHex(), name: courseTitle, parent_id: null };
    store.folders.set(rootFolder.id, rootFolder);
  } else if (rootFolder.name !== courseTitle) {
    rootFolder.name = courseTitle;
  }

  const prevByNumber = new Map<number, CourseWeekPlan>(previous.weeks.map((w) => [w.week_number, w]));
  const prevByFolderId = new Map<string, CourseWeekPlan>();
  for (const w of previous.weeks) {
    if (w.folder_id) prevByFolderId.set(w.folder_id, w);
  }

  const existingChildFoldersByName = new Map<string, FolderRecord>(
    [...store.folders.values()]
      .filter((f) => f.parent_id === rootFolder!.id && !reservedFolders.has(f.id))
      .map((f) => [normalizeFolderKey(f.name), f])
  );

  const assignedFolderIds = new Set<string>();
  const createdFolders: string[] = [];
  const renamedFolders: Array<{ id: string; from: string; to: string }> = [];
  const removedFolders: string[] = [];
  let evacuatedFiles = 0;

  const nextWeeks: CourseWeekPlan[] = [];
  const usedWeekNumbers = new Set<number>();

  if (Array.isArray(payload.weeks)) {
    let fallbackNum = 1;
    for (const raw of payload.weeks.slice(0, 60)) {
      if (!raw || typeof raw !== 'object') continue;
      const title = typeof raw.title === 'string' ? raw.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
      if (!title) continue;

      let weekNum =
        typeof raw.week_number === 'number' && Number.isInteger(raw.week_number) && raw.week_number >= 1
          ? raw.week_number
          : fallbackNum;
      while (usedWeekNumbers.has(weekNum)) weekNum++;
      usedWeekNumbers.add(weekNum);
      fallbackNum = Math.max(fallbackNum, weekNum + 1);

      const label =
        typeof raw.label === 'string' && raw.label.trim()
          ? raw.label.replace(/\s+/g, ' ').trim().slice(0, 32)
          : `Week ${weekNum}`;
      const weekType: WeekType = VALID_WEEK_TYPES.has(raw.week_type as WeekType)
        ? (raw.week_type as WeekType)
        : 'lecture';
      const requiresMaterial = weekType === 'lecture';
      const topics = cleanStringArray(raw.topics, 8, 140);
      const objectives = requiresMaterial ? cleanStringArray(raw.objectives, 4, 160) : [];
      const milestone =
        typeof raw.milestone === 'string' && raw.milestone.trim()
          ? raw.milestone.replace(/\s+/g, ' ').trim().slice(0, 160)
          : null;

      // Match prior week reliably by folder_id -> prev_week_number -> week_number
      const rawFolderId = typeof raw.folder_id === 'string' && raw.folder_id ? raw.folder_id : null;
      const prevNum =
        typeof raw.prev_week_number === 'number' && Number.isInteger(raw.prev_week_number)
          ? raw.prev_week_number
          : null;
      const matchedPrev =
        (rawFolderId && prevByFolderId.get(rawFolderId)) ||
        (prevNum !== null ? prevByNumber.get(prevNum) : undefined) ||
        prevByNumber.get(weekNum);

      let folderId: string | null = null;
      let folderName: string | null = null;
      const desiredFolderName = `${label} ${title}`.trim().slice(0, 80);

      const candidatePrevFolder =
        matchedPrev?.folder_id &&
        !reservedFolders.has(matchedPrev.folder_id) &&
        matchedPrev.folder_id !== rootFolder.id &&
        !assignedFolderIds.has(matchedPrev.folder_id)
          ? store.folders.get(matchedPrev.folder_id)
          : undefined;

      if (requiresMaterial) {
        const existing =
          candidatePrevFolder ||
          (() => {
            const byName = existingChildFoldersByName.get(normalizeFolderKey(desiredFolderName));
            return byName && !assignedFolderIds.has(byName.id) ? byName : undefined;
          })();

        if (existing) {
          folderId = existing.id;
          if (existing.name !== desiredFolderName) {
            renamedFolders.push({ id: existing.id, from: existing.name, to: desiredFolderName });
            existing.name = desiredFolderName;
          }
          folderName = existing.name;
        } else {
          folderId = uuidHex();
          folderName = desiredFolderName;
          store.folders.set(folderId, { id: folderId, name: folderName, parent_id: rootFolder.id });
          createdFolders.push(folderName);
        }
        assignedFolderIds.add(folderId);
      } else if (candidatePrevFolder) {
        // Non-material week retains its existing folder link ONLY if files already live there; rename to stay in sync.
        const hasFiles = [...store.documentInfo.values()].some((info) => info.folder_id === candidatePrevFolder.id);
        if (hasFiles) {
          folderId = candidatePrevFolder.id;
          if (candidatePrevFolder.name !== desiredFolderName) {
            renamedFolders.push({ id: candidatePrevFolder.id, from: candidatePrevFolder.name, to: desiredFolderName });
            candidatePrevFolder.name = desiredFolderName;
          }
          folderName = candidatePrevFolder.name;
          assignedFolderIds.add(folderId);
        }
      }

      nextWeeks.push({
        week_number: weekNum,
        label,
        title,
        week_type: weekType,
        requires_material: requiresMaterial,
        folder_id: folderId,
        folder_name: folderName,
        topics,
        objectives,
        milestone,
      });
    }
    nextWeeks.sort((a, b) => a.week_number - b.week_number);
  } else {
    for (const w of previous.weeks) {
      if (w.folder_id) assignedFolderIds.add(w.folder_id);
      nextWeeks.push(w);
    }
  }

  // Folder & File Sync Protection for deleted weeks:
  // Move any documents or nested folders inside removed week folders safely back to rootFolder.id.
  for (const prevWeek of previous.weeks) {
    const oldFolderId = prevWeek.folder_id;
    if (!oldFolderId || assignedFolderIds.has(oldFolderId)) continue;
    if (oldFolderId === rootFolder.id || reservedFolders.has(oldFolderId)) continue;

    const oldFolder = store.folders.get(oldFolderId);
    if (!oldFolder) continue;

    for (const info of store.documentInfo.values()) {
      if (info.folder_id === oldFolderId) {
        info.folder_id = rootFolder.id;
        evacuatedFiles++;
      }
    }
    for (const child of store.folders.values()) {
      if (child.parent_id === oldFolderId && child.id !== rootFolder.id) {
        child.parent_id = rootFolder.id;
      }
    }
    store.folders.delete(oldFolderId);
    removedFolders.push(oldFolder.name);
  }

  const nextExams = payload.exams !== undefined ? validateExamsInput(payload.exams) : previous.exams;

  const overview = await syncOverviewNote({
    existingNoteId: previous.overview_note_id,
    courseTitle,
    summary,
    weeks: nextWeeks,
    exams: nextExams,
  });

  const updated: CoursePlanRecord = {
    ...previous,
    root_folder_id: rootFolder.id,
    course_title: courseTitle,
    summary,
    overview_note_id: overview.noteId,
    overview_document_id: overview.docId,
    weeks: nextWeeks,
    exams: nextExams,
    schedule,
    updated_at: new Date().toISOString(),
  };

  store.coursePlans.set(updated.id, updated);
  persistStoreNow();

  return {
    plan: updated,
    evacuated_files: evacuatedFiles,
    renamed_folders: renamedFolders,
    created_folders: createdFolders,
    removed_folders: removedFolders,
    overview_update_mode: overview.updateMode,
  };
}

export function deleteCoursePlan(courseId: string): { deleted: boolean } {
  const existing = store.coursePlans.get(courseId);
  if (!existing) {
    throw new StudyHttpError(404, isEn() ? 'Course not found.' : '找不到這門課程。');
  }
  store.coursePlans.delete(courseId);
  // Keep all uploaded PDFs, notes, and folders intact; only detach calendar event links.
  for (const evt of store.calendarEvents.values()) {
    if (evt.course_id === courseId) {
      evt.course_id = null;
      evt.updated_at = new Date().toISOString();
    }
  }
  persistStoreNow();
  return { deleted: true };
}

export function updateCalendarSettings(input: { semester_start_date?: unknown }) {
  const raw = input.semester_start_date;
  if (raw === null || raw === '') {
    store.calendarSettings.semester_start_date = null;
  } else if (isValidIsoDate(raw)) {
    store.calendarSettings.semester_start_date = raw;
  } else {
    throw new StudyHttpError(422, isEn() ? 'Invalid semester start date (YYYY-MM-DD).' : '全學期開學基準日格式須為 YYYY-MM-DD。');
  }
  persistStoreNow();
  return store.calendarSettings;
}

export function createCalendarEvent(input: {
  title?: unknown;
  date?: unknown;
  time?: unknown;
  category?: unknown;
  course_id?: unknown;
  notes?: unknown;
}): CalendarEventRecord {
  const en = isEn();
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  if (!title) {
    throw new StudyHttpError(422, en ? 'Please enter an event title.' : '請輸入事件標題。');
  }
  if (!isValidIsoDate(input.date)) {
    throw new StudyHttpError(422, en ? 'Please select a valid date (YYYY-MM-DD).' : '請選擇正確的日期（YYYY-MM-DD）。');
  }
  if (!isValidTime(input.time)) {
    throw new StudyHttpError(422, en ? 'Invalid time format (HH:MM).' : '時間格式須為 HH:MM。');
  }
  const category: CalendarEventCategory = VALID_EVENT_CATEGORIES.has(input.category as CalendarEventCategory)
    ? (input.category as CalendarEventCategory)
    : 'todo';
  const courseId =
    typeof input.course_id === 'string' && input.course_id && store.coursePlans.has(input.course_id)
      ? input.course_id
      : null;
  const notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 500) : '';
  const now = new Date().toISOString();

  const event: CalendarEventRecord = {
    id: uuidHex(),
    title,
    date: input.date,
    time: typeof input.time === 'string' ? input.time : '',
    category,
    course_id: courseId,
    notes,
    completed: false,
    created_at: now,
    updated_at: now,
  };
  store.calendarEvents.set(event.id, event);
  persistStoreNow();
  return event;
}

export function updateCalendarEvent(
  eventId: string,
  input: {
    title?: unknown;
    date?: unknown;
    time?: unknown;
    category?: unknown;
    course_id?: unknown;
    notes?: unknown;
    completed?: unknown;
  }
): CalendarEventRecord {
  const en = isEn();
  const existing = store.calendarEvents.get(eventId);
  if (!existing) {
    throw new StudyHttpError(404, en ? 'Calendar event not found.' : '找不到這筆行事曆事件。');
  }
  if (input.title !== undefined) {
    const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    if (!title) throw new StudyHttpError(422, en ? 'Event title cannot be empty.' : '事件標題不可為空白。');
    existing.title = title;
  }
  if (input.date !== undefined) {
    if (!isValidIsoDate(input.date)) {
      throw new StudyHttpError(422, en ? 'Invalid date (YYYY-MM-DD).' : '日期格式須為 YYYY-MM-DD。');
    }
    existing.date = input.date;
  }
  if (input.time !== undefined) {
    if (!isValidTime(input.time)) {
      throw new StudyHttpError(422, en ? 'Invalid time format (HH:MM).' : '時間格式須為 HH:MM。');
    }
    existing.time = typeof input.time === 'string' ? input.time : '';
  }
  if (input.category !== undefined) {
    if (!VALID_EVENT_CATEGORIES.has(input.category as CalendarEventCategory)) {
      throw new StudyHttpError(422, en ? 'Invalid event category.' : '無效的事件類型。');
    }
    existing.category = input.category as CalendarEventCategory;
  }
  if (input.course_id !== undefined) {
    existing.course_id =
      typeof input.course_id === 'string' && input.course_id && store.coursePlans.has(input.course_id)
        ? input.course_id
        : null;
  }
  if (input.notes !== undefined) {
    existing.notes = typeof input.notes === 'string' ? input.notes.trim().slice(0, 500) : '';
  }
  if (input.completed !== undefined) {
    existing.completed = Boolean(input.completed);
  }
  existing.updated_at = new Date().toISOString();
  persistStoreNow();
  return existing;
}

export function deleteCalendarEvent(eventId: string): { deleted: boolean } {
  const existing = store.calendarEvents.get(eventId);
  if (!existing) {
    throw new StudyHttpError(404, isEn() ? 'Calendar event not found.' : '找不到這筆行事曆事件。');
  }
  store.calendarEvents.delete(eventId);
  persistStoreNow();
  return { deleted: true };
}
