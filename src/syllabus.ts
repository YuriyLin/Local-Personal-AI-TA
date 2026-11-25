const weekMarker = /^(?:#{1,6}\s+)?(?:week\s*|wk\.?\s*)(\d{1,2})\b\s*[:：–-]?\s*(.*)$|^(?:#{1,6}\s+)?第\s*(\d{1,2})\s*[週周]\s*[:：–-]?\s*(.*)$/i;

function marker(line: string, bare = true) {
  const normalized = line.normalize('NFKC');
  const explicit = weekMarker.exec(normalized);
  const numeric = bare ? /^(\d{1,2})(?:[.)]\s+(.+))?$/.exec(normalized) : null;
  const number = Number(explicit?.[1] || explicit?.[3] || numeric?.[1]);
  if (!Number.isInteger(number) || number < 1) return null;
  // Keep original punctuation in the source content.
  const original = explicit && /^(?:#{1,6}\s+)?(?:(?:week\s*|wk\.?\s*)[0-9０-９]{1,2}|第\s*[0-9０-９]{1,2}\s*[週周])\s*[:：–-]?\s*/i.exec(line);
  const numberedPrefix = numeric?.[2] ? /^[0-9０-９]{1,2}[.．)）]\s+/.exec(line) : null;
  const prefix = original || numberedPrefix;
  return { number, text: prefix ? line.slice(prefix[0].length) : (explicit?.[2] || explicit?.[4] || numeric?.[2] || ''), explicit: Boolean(explicit) };
}

function tableLines(rows: string[][]): string[] {
  const first = rows[0].findIndex(cell => /^(?:weeks?|wk\.?|週次|周次|教學週次)$/i.test(cell.normalize('NFKC')));
  if (first >= 0 && rows.slice(1).some(row => marker(row[first] || ''))) {
    return rows.slice(1).flatMap(row => [row[first], ...row.filter((_, i) => i !== first)].filter(Boolean));
  }
  const columns = Array.from({ length: Math.max(...rows.map(row => row.length)) }, (_, i) =>
    rows.map(row => row[i] || '').filter(Boolean));
  const weekColumns = columns.filter(column => column.filter(line => marker(line)).length >= 2);
  if (weekColumns.length >= 2) {
    // A two-column screenshot puts independent, vertically numbered lists side by side.
    const boundary = new Set(weekColumns.map(column => columns.indexOf(column)));
    const sections: string[][] = [];
    for (let start = 0; start < columns.length;) {
      let end = start + 1;
      while (end < columns.length && !boundary.has(end)) end++;
      sections.push(rows.flatMap(row => row.slice(start, end).filter(Boolean)));
      start = end;
    }
    return sections.flat();
  }
  return rows.flat();
}

export function outlineSyllabus(input: string) {
  const lines: string[] = [];
  let rows: string[][] = [];
  for (const line of input.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'));
      if (!cells.every(cell => /^:?-+:?$/.test(cell))) rows.push(cells);
    } else {
      if (rows.length) lines.push(...tableLines(rows));
      rows = [];
      lines.push(line);
    }
  }
  if (rows.length) lines.push(...tableLines(rows));

  const explicit = lines.some(line => marker(line, false));
  const bareNumbers = lines.map(line => marker(line)).filter(m => m && !m.explicit);
  const inferred = !explicit && bareNumbers.length >= 2;
  const preface: string[] = [];
  const weeks: { number: number; items: string[] }[] = [];
  for (const line of lines) {
    const m = marker(line, inferred);
    if (m) weeks.push({ number: m.number, items: m.text ? [m.text] : [] });
    else if (weeks.length) weeks[weeks.length - 1].items.push(line.replace(/^[-*]\s+/, ''));
    else preface.push(line);
  }

  const duplicate = new Set(weeks.map(week => week.number)).size !== weeks.length;
  const ordered = weeks.every((week, i) => !i || week.number > weeks[i - 1].number);
  const gaps = weeks.flatMap((week, i) => i && week.number > weeks[i - 1].number + 1
    ? Array.from({ length: week.number - weeks[i - 1].number - 1 }, (_, j) => weeks[i - 1].number + 1 + j) : []);
  const ready = Boolean(weeks.length && ordered && !duplicate && weeks.every(week => week.items.length));
  const text = weeks.length ? [...preface, ...weeks.flatMap(week => [`Week ${week.number}: ${week.items[0] || ''}`,
    ...week.items.slice(1).map(item => `- ${item}`)])].join('\n') : input.trim();
  return { weeks, preface, text, ready, inferred, gaps };
}

export function syllabusEventType(line: string): 'holiday' | 'exam' | 'activity' | null {
  const text = line.normalize('NFKC').trim().replace(/^[-*]+\s*/, '');
  if (/^(?:no\s+class|holiday|vacation|(?:[^:：]{0,20})?(?:放假|停課|假日|休假))\s*(?:$|[:：.（(])/i.test(text)) return 'holiday';
  if (/^(?:discussions?\s+(?:on|of)\s+(?:the\s+)?(?:midterm|final\s+exam|exam)\b|exam\s+(?:review|discussion)\b|(?:期中考|期末考|考試).{0,12}檢討)/i.test(text)) return 'activity';
  if (/^(?:midterm(?:\s+exam)?|final\s+exam|quiz(?:\s+\d+)?|(?:期中|期末)(?:考試?|測驗)?|小考)\s*(?:$|[:：.(（]|\d)/i.test(text)) return 'exam';
  if (/^(?:submit\b|submission\b|(?:project\s+|group\s+|student\s+)?presentations?\s*(?:$|[:.(])|peer\s+review\b|demo\s+day\b|showcase\b|同儕互評|專題發表|成果發表|期末發表|期末專題|期末報告|口頭報告|專題報告|繳交|提交)/i.test(text)) return 'activity';
  return null;
}

export function syllabusMilestones(outline: ReturnType<typeof outlineSyllabus>) {
  return outline.weeks.flatMap(week => week.items.filter(line => {
    const type = syllabusEventType(line);
    return type === 'exam' || type === 'activity' || /\b(?:deadline|due)\b|繳交|截止/i.test(line);
  }).map(line => {
    const date = line.match(/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b|\d{4}年\s*\d{1,2}月\s*\d{1,2}日/)?.[0] || '';
    const time = line.match(/\bbefore\s+\d{1,2}(?::\d{2})?\s*(?:a\.m\.|p\.m\.|am\b|pm\b)|(?:上午|下午)\s*\d{1,2}(?:[:：]\d{2}|[點時])?/i)?.[0];
    return { title: line.slice(0, 80), date: [date, time].filter(Boolean).join(' '), week: week.number, notes: line };
  }));
}
