import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  COURSE_PALETTE,
  createCalendarEvent,
  createManualCourse,
  deleteCalendarEvent,
  deleteCoursePlan,
  detectScheduleFromSyllabusText,
  parseExplicitDate,
  projectWeekDates,
  updateCalendarEvent,
  updateCalendarSettings,
  updateFullCourse,
} from '../src/courses.js';
import { loadStore, persistStoreNow, store } from '../src/store.js';

const STORE_FILE = path.join(process.cwd(), 'data', 'biibo-store.json');

function snapshotStoreFile(): { existed: boolean; content: Buffer | null } {
  if (fs.existsSync(STORE_FILE)) {
    return { existed: true, content: fs.readFileSync(STORE_FILE) };
  }
  return { existed: false, content: null };
}

function restoreStoreFile(snap: { existed: boolean; content: Buffer | null }) {
  if (snap.existed && snap.content) {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, snap.content);
  } else if (fs.existsSync(STORE_FILE)) {
    fs.rmSync(STORE_FILE, { force: true });
  }
  loadStore();
}

test('projectWeekDates maps shared/custom anchors across weekdays, Sunday, and cross-year', () => {
  // 2026-09-07 is Monday
  assert.deepEqual(projectWeekDates('2026-09-07', 1, [2, 4]), ['2026-09-08', '2026-09-10']);
  // Anchor on Wednesday 2026-09-09 still anchors Week 1 to Monday 2026-09-07
  assert.deepEqual(projectWeekDates('2026-09-09', 2, [1, 0]), ['2026-09-14', '2026-09-20']);
  // Cross-year projection
  assert.deepEqual(projectWeekDates('2026-12-28', 2, [1, 5]), ['2027-01-04', '2027-01-08']);
  // Explicit date parsing
  assert.equal(parseExplicitDate('2026/11/9'), '2026-11-09');
  assert.equal(parseExplicitDate('Nov. 12, 2026'), '2026-11-12');
  assert.equal(parseExplicitDate('10月15日', 2026), '2026-10-15');
});

test('detectScheduleFromSyllabusText extracts meeting weekdays and Week 1 start date', () => {
  const enSample = `
CS 501 Machine Learning
Class Time: Tue. & Thu. 13:20-16:20
Week 1 (2026/09/08): Linear Models
Week 2 (2026/09/15): Regularization
`;
  const enResult = detectScheduleFromSyllabusText(enSample);
  assert.deepEqual(enResult.detected_weekdays, [2, 4]);
  assert.equal(enResult.detected_start_date, '2026-09-08');

  const zhSample = `
演算法設計與分析
上課時間：每週三 09:10-12:00
第 1 週 2026-09-09 課程介紹
`;
  const zhResult = detectScheduleFromSyllabusText(zhSample);
  assert.deepEqual(zhResult.detected_weekdays, [3]);
  assert.equal(zhResult.detected_start_date, '2026-09-09');

  // Derives weekday from Week 1 date (2026-09-11 is Friday = 5) when no explicit weekday label appears
  const derivedResult = detectScheduleFromSyllabusText('Week 1: 2026-09-11 Introduction');
  assert.deepEqual(derivedResult.detected_weekdays, [5]);
  assert.equal(derivedResult.detected_start_date, '2026-09-11');
});

test('updateFullCourse syncs renamed week folders and evacuates files from deleted weeks to course root', async () => {
  const fileSnap = snapshotStoreFile();
  try {
    const { plan } = await createManualCourse({
      course_title: 'Deep Learning Systems',
      schedule: { color: 'lavender', weekdays: [2, 4], location: 'Room 302' },
      weeks: [
        { week_number: 1, label: 'Week 1', title: 'Intro & Tensors', week_type: 'lecture' },
        { week_number: 2, label: 'Week 2', title: 'Autograd Engine', week_type: 'lecture' },
      ],
    });

    const week1FolderId = plan.weeks[0].folder_id!;
    const week2FolderId = plan.weeks[1].folder_id!;
    assert.ok(week1FolderId && store.folders.has(week1FolderId));
    assert.ok(week2FolderId && store.folders.has(week2FolderId));

    // Place a PDF document and a child subfolder inside Week 2's folder
    const docId = 'test-evac-doc-1';
    const childFolderId = 'test-evac-child-folder';
    store.documents.set(docId, {
      id: docId,
      name: 'autograd-slides.pdf',
      kind: 'pdf',
      original_id: null,
      note_id: null,
      raw_path: null,
      markdown: '# Autograd',
      html: '<h1>Autograd</h1>',
      active: true,
      created_at: new Date().toISOString(),
    });
    store.documentInfo.set(docId, { folder_id: week2FolderId, summary: '' });
    store.folders.set(childFolderId, { id: childFolderId, name: 'Lab Notes', parent_id: week2FolderId });

    // Rename Week 1 AND delete Week 2
    const outcome = await updateFullCourse(plan.id, {
      course_title: 'Deep Learning Systems',
      schedule: { color: 'amber', weekdays: [3], start_date_override: '2026-09-09', location: 'Room 401' },
      weeks: [
        {
          week_number: 1,
          label: 'Week 1',
          title: 'GPU & Tensor Basics',
          week_type: 'lecture',
          folder_id: week1FolderId,
        },
      ],
      exams: [{ title: 'Midterm', date: '2026-11-04', week: 9, notes: 'Ch 1-5' }],
    });

    // 1. Renamed week synced sidebar folder name
    assert.equal(store.folders.get(week1FolderId)?.name, 'Week 1 GPU & Tensor Basics');
    assert.equal(outcome.renamed_folders.length, 1);

    // 2. Deleted week evacuated file & child subfolder safely back to root_folder_id
    assert.equal(outcome.evacuated_files, 1);
    assert.equal(store.documentInfo.get(docId)?.folder_id, plan.root_folder_id);
    assert.equal(store.folders.get(childFolderId)?.parent_id, plan.root_folder_id);
    assert.equal(store.folders.has(week2FolderId), false);
    assert.equal(store.documents.get(docId)?.active, true);

    // 3. Delete course plan keeps root folder and documents intact
    deleteCoursePlan(plan.id);
    assert.equal(store.coursePlans.has(plan.id), false);
    assert.equal(store.folders.has(plan.root_folder_id!), true);
    assert.equal(store.documents.get(docId)?.active, true);
  } finally {
    restoreStoreFile(fileSnap);
  }
});

test('calendar settings, custom events, and course schedules persist across store reloads', async () => {
  const fileSnap = snapshotStoreFile();
  try {
    assert.equal(COURSE_PALETTE.length, 8);
    updateCalendarSettings({ semester_start_date: '2026-09-07', week_starts_on: 1 });
    const { plan: course } = await createManualCourse({
      course_title: 'Convex Optimization',
      schedule: { color: 'terracotta', weekdays: [1, 3], location: 'EE 105' },
      weeks: [{ week_number: 1, label: 'Week 1', title: 'Convex Sets', week_type: 'lecture' }],
    });
    const evt = createCalendarEvent({
      title: 'Homework 1 Due',
      date: '2026-09-21',
      time: '23:59',
      category: 'deadline',
      course_id: course.id,
      notes: 'Submit PDF on portal',
    });
    updateCalendarEvent(evt.id, { completed: true });
    persistStoreNow();

    // Clear in-memory maps and reload from ./data/biibo-store.json
    store.coursePlans.clear();
    store.calendarEvents.clear();
    store.calendarSettings = { semester_start_date: null, week_starts_on: 1 };
    loadStore();

    assert.equal(store.calendarSettings.semester_start_date, '2026-09-07');
    const restoredCourse = store.coursePlans.get(course.id);
    assert.ok(restoredCourse);
    assert.equal(restoredCourse.schedule?.color, 'terracotta');
    assert.deepEqual(restoredCourse.schedule?.weekdays, [1, 3]);
    assert.equal(restoredCourse.schedule?.location, 'EE 105');

    const restoredEvt = store.calendarEvents.get(evt.id);
    assert.ok(restoredEvt);
    assert.equal(restoredEvt.title, 'Homework 1 Due');
    assert.equal(restoredEvt.completed, true);
    assert.equal(restoredEvt.course_id, course.id);

    deleteCalendarEvent(evt.id);
    assert.equal(store.calendarEvents.has(evt.id), false);
  } finally {
    restoreStoreFile(fileSnap);
  }
});
