import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outlineSyllabus, syllabusMilestones } from '../src/syllabus.js';
import { classifySyllabusWeek, recommendFolderForMaterial } from '../src/study.js';
import { store } from '../src/store.js';
import type { CoursePlanRecord } from '../src/store.js';

test('syllabus extraction reads numbered screenshot columns independently and keeps source events', () => {
  const outline = outlineSyllabus(`
| 1 | 4 |
| --- | --- |
| Syllabus | Midterm Exam |
| Public Policy | 5 |
| 2 | Discussions on Midterm Exam |
| No Class | Administrative Law |
| 3 | 6 |
| Public Finance | Final Exam (2026.12.14) |
| | Submit report before 8 a.m., 2026.12.18 |
`);
  assert.equal(outline.ready, true);
  assert.equal(outline.inferred, true);
  assert.deepEqual(outline.weeks.map(week => week.number), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(outline.weeks[4].items, ['Discussions on Midterm Exam', 'Administrative Law']);
  assert.deepEqual(syllabusMilestones(outline).map(event => [event.week, event.date]),
    [[4, ''], [5, ''], [6, '2026.12.14'], [6, '2026.12.18 before 8 a.m.']]);
  assert.deepEqual(outlineSyllabus(outline.text).weeks, outline.weeks);
});

test('syllabus previews flag incomplete weeks and support ordinary tables and numbered outlines', () => {
  const outline = outlineSyllabus('| Topic | Week |\n| --- | --- |\n| Piano technique | 1 |\n| Recital | 3 |');
  assert.deepEqual(outline.gaps, [2]);
  assert.deepEqual(outline.weeks[0].items, ['Piano technique']);
  assert.equal(outlineSyllabus('Week 1: Theatre\nWeek 1: Media').ready, false);
  assert.equal(outlineSyllabus('Week 1: Theatre\nWeek 2:').ready, false);
  assert.equal(outlineSyllabus('12.14 Final Exam').ready, false);
  assert.deepEqual(outlineSyllabus('1. Theatre\n2. Media').weeks.map(week => week.number), [1, 2]);
});

test('week classification considers all items and preserves subjects with event-like names', () => {
  assert.deepEqual(classifySyllabusWeek({title: 'Discussions on Midterm Exam', topics: ['行政法'], milestone: null}),
    {week_type: 'lecture', requires_material: true});
  assert.deepEqual(classifySyllabusWeek({title: 'Holiday Law', topics: [], milestone: null}),
    {week_type: 'lecture', requires_material: true});
  assert.deepEqual(classifySyllabusWeek({title: 'Final Exam', topics: ['Submit final project'], milestone: null}),
    {week_type: 'exam', requires_material: false});
});

test('folder recommendation uses the selected course and leaves ambiguous matches unassigned', () => {
  const plans = ['Organic Chemistry', 'Media Law'].map((title, courseIndex): CoursePlanRecord => {
    const weeks = [1, 2].map(week => {
      const id = `${courseIndex}-${week}`;
      store.folders.set(id, {id, name: `${title} ${week}`, parent_id: null});
      return {week_number: week, label: `Week ${week}`, title, week_type: 'lecture' as const,
        requires_material: true, folder_id: id, folder_name: title, topics: [], objectives: [], milestone: null};
    });
    return {id: `${courseIndex}`, root_folder_id: null, course_title: title, summary: '', source_name: '',
      overview_note_id: null, overview_document_id: null, weeks, exams: [], updated_at: ''};
  });
  try {
    assert.equal(recommendFolderForMaterial(plans[1], 'Week 1.pdf')?.folder_id, '1-1');
    assert.equal(recommendFolderForMaterial(plans[1], 'Week 1 and Week 2.pdf'), null);
    assert.equal(recommendFolderForMaterial(plans[1], 'Media Law.pdf'), null);
    assert.equal(recommendFolderForMaterial(plans[1], 'Organic Chemistry.pdf'), null);
  } finally {
    for (const plan of plans) for (const week of plan.weeks) store.folders.delete(week.folder_id!);
  }
});
