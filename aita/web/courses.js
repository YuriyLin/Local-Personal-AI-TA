"use strict";

(() => {
  const inCourses = location.pathname === "/courses";
  const page = $("courses-page");
  if (!page) return;

  // ============================================================
  // Palette fallback (mirrors server COURSE_PALETTE WCAG AA pairs)
  // ============================================================
  const DEFAULT_PALETTE = [
    { id: "mint", label_zh: "森綠", label_en: "Forest Mint", accent: "#2d8f74", tint: "#e6f5f0", ink: "#1b5e4b", border: "#b8e2d4" },
    { id: "lavender", label_zh: "薰衣草紫", label_en: "Soft Lavender", accent: "#7b63c7", tint: "#f0ecfb", ink: "#4a368a", border: "#d6cbf5" },
    { id: "amber", label_zh: "暖琥珀", label_en: "Warm Amber", accent: "#c88a2e", tint: "#fdf3e2", ink: "#7c4f0e", border: "#ecd1a2" },
    { id: "slate", label_zh: "晴空藍", label_en: "Sky Slate", accent: "#4a78a8", tint: "#eaf2fa", ink: "#244b73", border: "#c1d8ef" },
    { id: "rose", label_zh: "豆沙紅", label_en: "Dusty Rose", accent: "#c46572", tint: "rgba(196, 101, 114, 0.12)", ink: "#842d3a", border: "rgba(196, 101, 114, 0.30)" },
    { id: "sage", label_zh: "鼠尾草綠", label_en: "Sage Moss", accent: "#5c8c61", tint: "#ebf4ec", ink: "#2d5732", border: "#c3ddc6" },
    { id: "indigo", label_zh: "暮光靛", label_en: "Dusk Indigo", accent: "#5a67b8", tint: "#eceefb", ink: "#2f3a80", border: "#c7cdf2" },
    { id: "terracotta", label_zh: "珊瑚橘", label_en: "Soft Terracotta", accent: "#cc734c", tint: "#fcefEA", ink: "#823c1e", border: "#f1cbb9" }
  ];

  const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
  const WEEKDAY_ZH_SHORT = ["日", "一", "二", "三", "四", "五", "六"];
  const WEEKDAY_ZH_FULL = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const WEEKDAY_EN_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const WEEKDAY_EN_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const MONTH_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  // ============================================================
  // State
  // ============================================================
  let coursesData = [];
  let calendarSettings = { semester_start_date: null, week_starts_on: 1 };
  let customEvents = [];
  let palette = DEFAULT_PALETTE;
  let paletteMap = new Map(palette.map(entry => [entry.id, entry]));

  const now = new Date();
  let viewYear = now.getFullYear();
  let viewMonth = now.getMonth(); // 0..11
  let selectedDate = toLocalIso(now);

  const hiddenCourseIds = new Set();
  let activeTypeFilter = "all"; // all | lecture | exam | holiday | activity | custom

  // Course editor modal state
  let editorCourseId = null; // null = creating manual course
  let editorTab = "basic";
  let editorColor = "mint";
  let editorWeekdays = [1];
  let editorWeeks = [];
  let editorExams = [];
  let deleteConfirmTimer = 0;
  let deleteArmed = false;

  // Custom event modal state
  let editingEventId = null;

  // ============================================================
  // Date Math (UTC-safe to match src/courses.ts)
  // ============================================================
  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function toLocalIso(date) {
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
  }

  function isValidIso(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [y, m, d] = value.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function parseUtcDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function formatUtcIso(dt) {
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  }

  function addUtcDays(iso, days) {
    const dt = parseUtcDate(iso);
    dt.setUTCDate(dt.getUTCDate() + days);
    return formatUtcIso(dt);
  }

  function diffUtcDays(fromIso, toIso) {
    const a = parseUtcDate(fromIso).getTime();
    const b = parseUtcDate(toIso).getTime();
    return Math.round((b - a) / 86_400_000);
  }

  function projectWeekDates(anchorIso, weekNumber, weekdays) {
    if (!isValidIso(anchorIso) || !Number.isInteger(weekNumber) || weekNumber < 1) return [];
    const anchor = parseUtcDate(anchorIso);
    const anchorDay = anchor.getUTCDay();
    const daysSinceMonday = anchorDay === 0 ? 6 : anchorDay - 1;
    const mondayOfWeek1 = new Date(anchor.getTime());
    mondayOfWeek1.setUTCDate(anchor.getUTCDate() - daysSinceMonday);

    const days = Array.isArray(weekdays) && weekdays.length ? weekdays : [1];
    const results = [];
    for (const wd of days) {
      const offsetInWeek = wd === 0 ? 6 : wd - 1;
      const dt = new Date(mondayOfWeek1.getTime());
      dt.setUTCDate(mondayOfWeek1.getUTCDate() + (weekNumber - 1) * 7 + offsetInWeek);
      results.push(formatUtcIso(dt));
    }
    return [...new Set(results)].sort();
  }

  function parseExplicitDate(raw, fallbackYear) {
    const text = String(raw || "").trim();
    if (!text) return null;
    const isoMatch = text.match(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    if (isoMatch) {
      const iso = `${isoMatch[1]}-${pad2(isoMatch[2])}-${pad2(isoMatch[3])}`;
      if (isValidIso(iso)) return iso;
    }
    const year = fallbackYear || new Date().getFullYear();
    const zhMatch = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
    if (zhMatch) {
      const iso = `${year}-${pad2(zhMatch[1])}-${pad2(zhMatch[2])}`;
      if (isValidIso(iso)) return iso;
    }
    const mdMatch = text.match(/(?:^|\s)(\d{1,2})\/(\d{1,2})(?:\b|$)/);
    if (mdMatch) {
      const iso = `${year}-${pad2(mdMatch[1])}-${pad2(mdMatch[2])}`;
      if (isValidIso(iso)) return iso;
    }
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
    const enMatch = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?\b/i);
    if (enMatch) {
      const m = months[enMatch[1].toLowerCase()];
      const y = enMatch[3] ? Number(enMatch[3]) : year;
      const iso = `${y}-${pad2(m)}-${pad2(enMatch[2])}`;
      if (isValidIso(iso)) return iso;
    }
    return null;
  }

  function getPalette(colorId) {
    return paletteMap.get(colorId) || palette[0] || DEFAULT_PALETTE[0];
  }

  function formatWeekdayList(weekdays) {
    const days = Array.isArray(weekdays) && weekdays.length ? weekdays : [1];
    const sorted = [...new Set(days)].sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b));
    if (english()) {
      return sorted.map(d => WEEKDAY_EN_SHORT[d]).join(", ");
    }
    return `每週${sorted.map(d => WEEKDAY_ZH_SHORT[d]).join("、")}`;
  }

  function formatDisplayDate(iso) {
    if (!isValidIso(iso)) return iso;
    const dt = parseUtcDate(iso);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth();
    const d = dt.getUTCDate();
    if (english()) return `${MONTH_EN[m]} ${d}, ${y}`;
    return `${y} 年 ${m + 1} 月 ${d} 日`;
  }

  function formatDisplayWeekday(iso) {
    if (!isValidIso(iso)) return "";
    const wd = parseUtcDate(iso).getUTCDay();
    return english() ? WEEKDAY_EN_FULL[wd] : WEEKDAY_ZH_FULL[wd];
  }

  function weekTypeLabel(type) {
    const map = english()
      ? { lecture: "Lecture", holiday: "Holiday", exam: "Exam", activity: "Activity" }
      : { lecture: "授課", holiday: "放假", exam: "考試", activity: "活動" };
    return map[type] || map.lecture;
  }

  function customCategoryLabel(cat) {
    const map = english()
      ? { todo: "To-do", deadline: "Due", exam: "Exam", reminder: "Note" }
      : { todo: "待辦", deadline: "截止", exam: "考試", reminder: "提醒" };
    return map[cat] || map.todo;
  }

  function customCategoryColors(cat, course) {
    if (cat === "exam") {
      return { accent: "#c8433e", tint: "#fdeeed", ink: "#8f2420", border: "#f2c1be", dot: course ? getPalette(course.schedule?.color).accent : "#c8433e" };
    }
    if (cat === "deadline") {
      return { accent: "#c88a2e", tint: "#fdf3e2", ink: "#7c4f0e", border: "#ecd1a2", dot: course ? getPalette(course.schedule?.color).accent : "#c88a2e" };
    }
    if (cat === "reminder") {
      return { accent: "#7b63c7", tint: "#f0ecfb", ink: "#4a368a", border: "#d6cbf5", dot: course ? getPalette(course.schedule?.color).accent : "#7b63c7" };
    }
    if (course) {
      const p = getPalette(course.schedule?.color);
      return { accent: p.accent, tint: p.tint, ink: p.ink, border: p.border, dot: p.accent };
    }
    return { accent: "#2d8f74", tint: "#e6f5f0", ink: "#1b5e4b", border: "#b8e2d4", dot: "#2d8f74" };
  }

  // ============================================================
  // Calendar Event Projection & Filtering
  // ============================================================
  function buildAllCalendarItems() {
    const byDate = new Map();
    const pushItem = (date, item) => {
      if (!isValidIso(date)) return;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push(item);
    };

    const courseById = new Map(coursesData.map(c => [c.id, c]));

    for (const course of coursesData) {
      if (hiddenCourseIds.has(course.id)) continue;
      const p = getPalette(course.schedule?.color);
      const anchor = course.schedule?.start_date_override || calendarSettings.semester_start_date;
      const weekdays = course.schedule?.weekdays?.length ? course.schedule.weekdays : [1];
      const anchorYear = anchor && isValidIso(anchor) ? Number(anchor.slice(0, 4)) : viewYear;

      const examWeekDateMap = new Map();
      if (anchor && isValidIso(anchor)) {
        for (const week of course.weeks || []) {
          const dates = projectWeekDates(anchor, week.week_number, weekdays);
          const type = week.week_type || "lecture";
          // Lectures & holidays appear on all meeting weekdays; pure exams/activities appear on the primary meeting day.
          const targetDates = (type === "lecture" || type === "holiday") ? dates : dates.slice(0, 1);
          for (const d of targetDates) {
            if (type === "exam") examWeekDateMap.set(`${d}::${week.title.toLowerCase()}`, true);
            pushItem(d, {
              id: `week-${course.id}-${week.week_number}-${d}`,
              date: d,
              kind: "course_week",
              eventType: type,
              visualWeight: type === "exam" ? 3 : type === "lecture" ? 1 : 2,
              course,
              week,
              palette: p,
              title: week.title,
              shortLabel: `W${week.week_number}`,
              time: ""
            });
          }
        }
      }

      for (let i = 0; i < (course.exams || []).length; i++) {
        const ex = course.exams[i];
        let date = parseExplicitDate(ex.date, anchorYear);
        if (!date && ex.week && anchor && isValidIso(anchor)) {
          const projected = projectWeekDates(anchor, ex.week, weekdays);
          date = projected[0] || null;
        }
        if (!date) continue;
        if (examWeekDateMap.has(`${date}::${String(ex.title || "").toLowerCase()}`)) continue;
        pushItem(date, {
          id: `exam-${course.id}-${i}-${date}`,
          date,
          kind: "course_exam",
          eventType: "exam",
          visualWeight: 3,
          course,
          exam: ex,
          palette: p,
          title: ex.title,
          shortLabel: ex.week ? `W${ex.week}` : "",
          time: ""
        });
      }
    }

    for (const evt of customEvents) {
      if (evt.course_id && hiddenCourseIds.has(evt.course_id)) continue;
      const linkedCourse = evt.course_id ? courseById.get(evt.course_id) || null : null;
      const colors = customCategoryColors(evt.category, linkedCourse);
      pushItem(evt.date, {
        id: `custom-${evt.id}`,
        date: evt.date,
        kind: "custom",
        eventType: evt.category === "exam" ? "exam" : "custom",
        customCategory: evt.category,
        visualWeight: 3,
        course: linkedCourse,
        event: evt,
        palette: colors,
        title: evt.title,
        shortLabel: customCategoryLabel(evt.category),
        time: evt.time || ""
      });
    }

    // Apply type filter & sort within each date by visualWeight DESC -> time ASC -> title
    const filtered = new Map();
    for (const [date, list] of byDate.entries()) {
      const kept = list.filter(item => {
        if (activeTypeFilter === "all") return true;
        if (activeTypeFilter === "custom") return item.kind === "custom";
        if (activeTypeFilter === "exam") return item.eventType === "exam";
        return item.kind === "course_week" && item.eventType === activeTypeFilter;
      });
      if (!kept.length) continue;
      kept.sort((a, b) => {
        if (b.visualWeight !== a.visualWeight) return b.visualWeight - a.visualWeight;
        if (a.time && b.time && a.time !== b.time) return a.time.localeCompare(b.time);
        if (a.time && !b.time) return -1;
        if (!a.time && b.time) return 1;
        return a.title.localeCompare(b.title);
      });
      filtered.set(date, kept);
    }
    return filtered;
  }

  function findNextMilestone(course) {
    const today = toLocalIso(new Date());
    const anchor = course.schedule?.start_date_override || calendarSettings.semester_start_date;
    const weekdays = course.schedule?.weekdays?.length ? course.schedule.weekdays : [1];
    const anchorYear = anchor && isValidIso(anchor) ? Number(anchor.slice(0, 4)) : new Date().getFullYear();

    const candidates = [];
    for (const ex of course.exams || []) {
      let date = parseExplicitDate(ex.date, anchorYear);
      if (!date && ex.week && anchor && isValidIso(anchor)) {
        date = projectWeekDates(anchor, ex.week, weekdays)[0] || null;
      }
      if (date && date >= today) {
        candidates.push({ title: ex.title, date, days: diffUtcDays(today, date) });
      }
    }
    if (anchor && isValidIso(anchor)) {
      for (const week of course.weeks || []) {
        if (week.week_type !== "exam" && !week.milestone) continue;
        const date = projectWeekDates(anchor, week.week_number, weekdays)[0];
        if (date && date >= today) {
          candidates.push({
            title: week.milestone || week.title,
            date,
            days: diffUtcDays(today, date)
          });
        }
      }
    }
    candidates.sort((a, b) => a.date.localeCompare(b.date));
    return candidates[0] || null;
  }

  // ============================================================
  // Rendering: Course Overview Cards
  // ============================================================
  function renderCoursesGrid() {
    const grid = $("courses-grid");
    const empty = $("courses-empty");
    const headerActions = $("courses-header-actions");
    if (!grid || !empty) return;

    if (!coursesData.length) {
      grid.hidden = true;
      empty.hidden = false;
      if (headerActions) headerActions.hidden = true;
      grid.replaceChildren();
      return;
    }

    grid.hidden = false;
    empty.hidden = true;
    if (headerActions) headerActions.hidden = false;
    const frag = document.createDocumentFragment();

    for (const course of coursesData) {
      const p = getPalette(course.schedule?.color);
      const weeks = course.weeks || [];
      const lectureWeeks = weeks.filter(w => w.requires_material !== false && (w.week_type || "lecture") === "lecture");
      const readyWeeks = lectureWeeks.filter(w => Number(w.material_count || 0) > 0);
      const missingCount = Math.max(0, lectureWeeks.length - readyWeeks.length);
      const pct = lectureWeeks.length ? Math.round((readyWeeks.length / lectureWeeks.length) * 100) : 100;

      const card = element("article", undefined, "course-card");
      card.style.setProperty("--course-accent", p.accent);
      card.style.setProperty("--course-tint", p.tint);
      card.style.setProperty("--course-ink", p.ink);
      card.style.setProperty("--course-border", p.border);

      // Header: color dot + title + schedule info
      const head = element("div", undefined, "course-card-head");
      const titleGroup = element("div", undefined, "course-card-title-group");
      const dot = element("span", undefined, "course-color-dot");
      dot.setAttribute("aria-hidden", "true");
      const titleEl = element("h3", course.course_title, "course-card-title");
      titleGroup.append(dot, titleEl);

      const scheduleMeta = element("p", undefined, "course-card-schedule");
      const schedParts = [formatWeekdayList(course.schedule?.weekdays)];
      if (course.schedule?.location) schedParts.push(course.schedule.location);
      if (course.schedule?.start_date_override) {
        schedParts.push(english()
          ? `Starts ${course.schedule.start_date_override}`
          : `開學 ${course.schedule.start_date_override}`);
      }
      scheduleMeta.textContent = schedParts.join(" · ");
      head.append(titleGroup, scheduleMeta);

      // Unboxed inline metadata row (zero-pill discipline)
      const metaRow = element("p", undefined, "course-card-meta");
      const metaParts = english()
        ? [
            `${weeks.length} units`,
            `${readyWeeks.length}/${lectureWeeks.length} slides ready`,
            missingCount > 0 ? `${missingCount} missing` : "All caught up"
          ]
        : [
            `${weeks.length} 週單元`,
            `${readyWeeks.length}/${lectureWeeks.length} 講義已備齊`,
            missingCount > 0 ? `尚缺 ${missingCount} 份` : "講義已全數備齊"
          ];
      metaRow.textContent = metaParts.join(" · ");

      // Progress track
      const progWrap = element("div", undefined, "course-progress-wrap");
      const track = element("div", undefined, "course-progress-track");
      track.setAttribute("role", "progressbar");
      track.setAttribute("aria-valuemin", "0");
      track.setAttribute("aria-valuemax", "100");
      track.setAttribute("aria-valuenow", String(pct));
      const fill = element("div", undefined, "course-progress-fill");
      fill.style.width = `${pct}%`;
      track.append(fill);
      const pctLabel = element("span", `${pct}%`, "course-progress-pct");
      progWrap.append(track, pctLabel);

      // Next milestone or summary
      const next = findNextMilestone(course);
      const footInfo = element("p", undefined, next ? "course-card-milestone" : "course-card-summary");
      if (next) {
        const dayText = next.days === 0
          ? (english() ? "Today" : "就是今天")
          : (english() ? `in ${next.days}d` : `還有 ${next.days} 天`);
        footInfo.textContent = english()
          ? `Next: ${next.title} · ${next.date} (${dayText})`
          : `近期里程碑：${next.title} · ${next.date}（${dayText}）`;
      } else {
        footInfo.textContent = course.summary || (english() ? "No upcoming milestones scheduled." : "尚未設定近期考試或里程碑。");
      }

      // Action bar
      const actions = element("div", undefined, "course-card-actions");
      const openWs = element("a", english() ? "Workspace" : "進入工作區", "course-card-btn is-primary");
      openWs.href = `/?course=${encodeURIComponent(course.id)}`;

      const editBtn = button(
        english() ? "Edit schedule" : "編輯課綱與排程",
        () => openCourseEditor(course),
        "course-card-btn"
      );

      const reimportBtn = button(
        english() ? "Re-import" : "更新課綱",
        () => {
          if (typeof window.openSyllabusDialogForCourse === "function") {
            window.openSyllabusDialogForCourse(course);
          }
        },
        "course-card-btn"
      );

      actions.append(openWs, editBtn, reimportBtn);
      card.append(head, metaRow, progWrap, footInfo, actions);
      frag.append(card);
    }

    grid.replaceChildren(frag);
  }

  // ============================================================
  // Rendering: Calendar Filters & Monthly Grid
  // ============================================================
  function renderCalendarFilters() {
    const typeContainer = $("cal-type-filters");
    if (typeContainer) {
      const types = english()
        ? [
            ["all", "All"],
            ["lecture", "Lectures"],
            ["exam", "Exams"],
            ["holiday", "Holidays"],
            ["activity", "Activities"],
            ["custom", "Custom"]
          ]
        : [
            ["all", "全部"],
            ["lecture", "授課"],
            ["exam", "考試"],
            ["holiday", "放假"],
            ["activity", "活動"],
            ["custom", "自訂"]
          ];
      const frag = document.createDocumentFragment();
      for (const [id, label] of types) {
        const btn = button(label, () => {
          activeTypeFilter = id;
          renderCalendar();
        }, "cal-type-btn");
        btn.setAttribute("aria-pressed", String(activeTypeFilter === id));
        frag.append(btn);
      }
      typeContainer.replaceChildren(frag);
    }

    const courseContainer = $("cal-course-filters");
    if (courseContainer) {
      if (!coursesData.length) {
        courseContainer.hidden = true;
        courseContainer.replaceChildren();
      } else {
        courseContainer.hidden = false;
        const frag = document.createDocumentFragment();
        for (const course of coursesData) {
          const p = getPalette(course.schedule?.color);
          const visible = !hiddenCourseIds.has(course.id);
          const chip = element("button", undefined, `cal-course-toggle${visible ? " is-active" : ""}`);
          chip.type = "button";
          chip.setAttribute("aria-pressed", String(visible));
          chip.style.setProperty("--course-accent", p.accent);
          chip.style.setProperty("--course-tint", p.tint);
          chip.style.setProperty("--course-ink", p.ink);
          chip.style.setProperty("--course-border", p.border);
          const dot = element("span", undefined, "cal-course-dot");
          dot.setAttribute("aria-hidden", "true");
          const name = element("span", course.course_title, "cal-course-name");
          chip.append(dot, name);
          chip.addEventListener("click", () => {
            if (hiddenCourseIds.has(course.id)) hiddenCourseIds.delete(course.id);
            else hiddenCourseIds.add(course.id);
            renderCalendar();
          });
          frag.append(chip);
        }
        courseContainer.replaceChildren(frag);
      }
    }

    // Gentle inline nudge if courses exist without any start date anchor
    const notice = $("cal-anchor-notice");
    if (notice) {
      const unanchored = coursesData.filter(c => !(c.schedule?.start_date_override || calendarSettings.semester_start_date));
      if (unanchored.length > 0) {
        notice.hidden = false;
        notice.textContent = english()
          ? `Set a "Semester start date" above (or a custom start date in a course's editor) to place ${unanchored.length} course${unanchored.length > 1 ? "s" : ""} onto the calendar.`
          : `請在右上方設定「全學期開學基準日」（或在課程編輯器自訂開學日），即可將 ${unanchored.length} 門課程的每週進度自動對映到月行事曆。`;
      } else {
        notice.hidden = true;
        notice.textContent = "";
      }
    }
  }

  function renderWeekdayHeader() {
    const header = $("cal-weekdays");
    if (!header) return;
    const labelsList = english()
      ? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
      : ["週一", "週二", "週三", "週四", "週五", "週六", "週日"];
    header.replaceChildren(...labelsList.map((txt, idx) =>
      element("div", txt, `cal-weekday-cell${idx >= 5 ? " is-weekend" : ""}`)
    ));
  }

  function buildCellEventNode(item) {
    if (item.visualWeight === 1) {
      // Low weight: subtle unboxed dot + single-line text for regular lectures
      const row = element("div", undefined, "cal-evt-lecture");
      const dot = element("span", undefined, "cal-evt-dot");
      dot.style.backgroundColor = item.palette.accent;
      const text = element("span", `${item.shortLabel} ${item.title}`, "cal-evt-text");
      row.append(dot, text);
      return row;
    }

    if (item.visualWeight === 2) {
      // Mid weight: soft hairline tag for holiday / activity
      const tag = element("div", undefined, `cal-evt-mid is-${item.eventType}`);
      const prefix = element("span", weekTypeLabel(item.eventType), "cal-evt-prefix");
      const text = element("span", item.title, "cal-evt-text");
      tag.append(prefix, text);
      return tag;
    }

    // High weight: paired ~12% tint + deep WCAG AA ink + crisp border
    const completed = item.kind === "custom" && Boolean(item.event?.completed);
    const block = element("div", undefined, `cal-evt-high${completed ? " is-completed" : ""}`);
    block.style.backgroundColor = item.palette.tint;
    block.style.color = item.palette.ink;
    block.style.borderColor = item.palette.border;

    const prefixLabel = item.kind === "custom"
      ? customCategoryLabel(item.customCategory)
      : weekTypeLabel("exam");
    const prefix = element("span", prefixLabel, "cal-evt-prefix");
    const text = element("span", item.title, "cal-evt-text");
    block.append(prefix, text);
    return block;
  }

  function renderCalendar() {
    renderCalendarFilters();
    renderWeekdayHeader();

    const titleEl = $("cal-month-title");
    if (titleEl) {
      titleEl.textContent = english()
        ? `${MONTH_EN[viewMonth]} ${viewYear}`
        : `${viewYear} 年 ${viewMonth + 1} 月`;
    }

    const itemsByDate = buildAllCalendarItems();
    const grid = $("cal-grid");
    if (!grid) return;

    const firstOfMonth = new Date(Date.UTC(viewYear, viewMonth, 1));
    const firstWeekday = firstOfMonth.getUTCDay();
    const leadingDays = firstWeekday === 0 ? 6 : firstWeekday - 1;
    const gridStartIso = addUtcDays(formatUtcIso(firstOfMonth), -leadingDays);
    const todayIso = toLocalIso(new Date());

    const frag = document.createDocumentFragment();
    for (let i = 0; i < 42; i++) {
      const iso = addUtcDays(gridStartIso, i);
      const dt = parseUtcDate(iso);
      const inCurrentMonth = dt.getUTCMonth() === viewMonth && dt.getUTCFullYear() === viewYear;
      const isToday = iso === todayIso;
      const isSelected = iso === selectedDate;
      const dayItems = itemsByDate.get(iso) || [];

      const cell = element("button", undefined, "calendar-cell");
      cell.type = "button";
      cell.dataset.date = iso;
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-selected", String(isSelected));
      cell.setAttribute("aria-label", `${formatDisplayDate(iso)}${dayItems.length ? `, ${dayItems.length}` : ""}`);
      if (!inCurrentMonth) cell.classList.add("is-outside");
      if (isToday) cell.classList.add("is-today");
      if (isSelected) cell.classList.add("is-selected");

      const topRow = element("div", undefined, "cal-cell-top");
      const dayNum = element("span", String(dt.getUTCDate()), "cal-day-num");
      topRow.append(dayNum);
      if (isToday) {
        topRow.append(element("span", english() ? "Today" : "今", "cal-today-mark"));
      }

      const listWrap = element("div", undefined, "cal-cell-events");
      const visible = dayItems.slice(0, 3);
      for (const item of visible) {
        listWrap.append(buildCellEventNode(item));
      }
      if (dayItems.length > 3) {
        listWrap.append(element("div", `+${dayItems.length - 3}`, "cal-evt-more"));
      }

      cell.append(topRow, listWrap);
      cell.addEventListener("click", () => {
        selectedDate = iso;
        if (!inCurrentMonth) {
          viewYear = dt.getUTCFullYear();
          viewMonth = dt.getUTCMonth();
        }
        renderCalendar();
      });
      frag.append(cell);
    }

    grid.replaceChildren(frag);
    renderDayDetailPanel(itemsByDate.get(selectedDate) || []);
  }

  // ============================================================
  // Rendering: Selected Day Detail Panel
  // ============================================================
  function renderDayDetailPanel(items) {
    const weekdayEl = $("cal-day-weekday");
    const titleEl = $("cal-day-title");
    const container = $("cal-day-items");
    if (!container) return;

    if (weekdayEl) weekdayEl.textContent = formatDisplayWeekday(selectedDate);
    if (titleEl) titleEl.textContent = formatDisplayDate(selectedDate);

    if (!items.length) {
      const emptyBox = element("div", undefined, "cal-day-empty");
      emptyBox.append(
        element("p", english() ? "No classes or events on this date." : "這一天沒有排定的課程或事件。"),
        element("p", english() ? "Click “+ Add event” above to record a deadline, exam, or study reminder." : "可點擊上方「＋ 新增事件」記錄作業截止、考試或讀書待辦。", "cal-day-empty-sub")
      );
      container.replaceChildren(emptyBox);
      return;
    }

    const frag = document.createDocumentFragment();
    for (const item of items) {
      const card = element("article", undefined, `cal-detail-card is-weight-${item.visualWeight}`);

      if (item.kind === "course_week") {
        const { course, week, palette: p } = item;
        const head = element("div", undefined, "cal-detail-head");
        const courseBadge = element("span", undefined, "cal-detail-course");
        const dot = element("span", undefined, "cal-course-dot");
        dot.style.backgroundColor = p.accent;
        courseBadge.append(dot, document.createTextNode(`${course.course_title} · ${week.label}`));

        const typeTag = element("span", weekTypeLabel(week.week_type), "cal-detail-type");
        if (week.week_type === "exam") {
          typeTag.style.backgroundColor = p.tint;
          typeTag.style.color = p.ink;
          typeTag.style.borderColor = p.border;
        }
        head.append(courseBadge, typeTag);

        const titleEl2 = element("h4", week.title, "cal-detail-title");
        card.append(head, titleEl2);

        const descParts = [];
        if (week.milestone) descParts.push(week.milestone);
        if (week.objectives?.length) descParts.push(week.objectives[0]);
        else if (week.topics?.length) descParts.push(week.topics.slice(0, 3).join(" · "));
        if (descParts.length) {
          card.append(element("p", descParts.join(" — "), "cal-detail-desc"));
        }

        // Slide readiness line
        if (week.requires_material !== false && (week.week_type || "lecture") === "lecture") {
          const matStatus = element(
            "p",
            week.material_count > 0
              ? (english() ? `${week.material_count} lecture file${week.material_count > 1 ? "s" : ""} ready` : `已備齊 ${week.material_count} 份本週講義`)
              : (english() ? "Slides not uploaded yet" : "尚未上傳本週講義"),
            `cal-detail-mat${week.has_gap ? " is-gap" : ""}`
          );
          card.append(matStatus);
        }

        const actions = element("div", undefined, "cal-detail-actions");
        if (week.materials?.length > 0) {
          const openSlide = element("a", english() ? "Open slides" : "開啟本週講義", "cal-detail-btn is-primary");
          openSlide.href = `/?course=${encodeURIComponent(course.id)}&doc=${encodeURIComponent(week.materials[0].id)}`;
          actions.append(openSlide);
        } else if (week.week_type !== "holiday") {
          const previewLink = element(
            "a",
            week.week_type === "exam"
              ? (english() ? "Exam review with BIIBO" : "請 BIIBO 規劃考前複習")
              : week.week_type === "activity"
                ? (english() ? "Prepare checklist" : "產生課堂準備清單")
                : (english() ? "Pre-class preview" : "BIIBO 課前預習"),
            "cal-detail-btn is-primary"
          );
          previewLink.href = `/?course=${encodeURIComponent(course.id)}&previewWeek=${encodeURIComponent(week.week_number)}`;
          actions.append(previewLink);

          const uploadLink = element("a", english() ? "Upload slides" : "上傳講義", "cal-detail-btn");
          uploadLink.href = `/?course=${encodeURIComponent(course.id)}&uploadWeek=${encodeURIComponent(week.week_number)}`;
          actions.append(uploadLink);
        }

        const editBtn = button(english() ? "Edit unit" : "微調本週", () => {
          openCourseEditor(course, "weeks");
        }, "cal-detail-btn");
        actions.append(editBtn);

        card.append(actions);
      } else if (item.kind === "course_exam") {
        const { course, exam, palette: p } = item;
        card.style.borderColor = p.border;
        const head = element("div", undefined, "cal-detail-head");
        const courseBadge = element("span", undefined, "cal-detail-course");
        const dot = element("span", undefined, "cal-course-dot");
        dot.style.backgroundColor = p.accent;
        courseBadge.append(dot, document.createTextNode(`${course.course_title}${exam.week ? ` · Week ${exam.week}` : ""}`));

        const typeTag = element("span", weekTypeLabel("exam"), "cal-detail-type");
        typeTag.style.backgroundColor = p.tint;
        typeTag.style.color = p.ink;
        typeTag.style.borderColor = p.border;
        head.append(courseBadge, typeTag);

        card.append(head, element("h4", exam.title, "cal-detail-title"));
        if (exam.notes) card.append(element("p", exam.notes, "cal-detail-desc"));

        const actions = element("div", undefined, "cal-detail-actions");
        if (course.overview_document_id) {
          const ovLink = element("a", english() ? "Open overview note" : "開啟課程總覽筆記", "cal-detail-btn is-primary");
          ovLink.href = `/?course=${encodeURIComponent(course.id)}&doc=${encodeURIComponent(course.overview_document_id)}`;
          actions.append(ovLink);
        }
        actions.append(button(english() ? "Edit milestones" : "編輯時程", () => openCourseEditor(course, "exams"), "cal-detail-btn"));
        card.append(actions);
      } else if (item.kind === "custom") {
        const { event: evt, course, palette: colors } = item;
        card.style.borderColor = colors.border;
        if (evt.completed) card.classList.add("is-completed");

        const head = element("div", undefined, "cal-detail-head");
        const leftMeta = element("span", undefined, "cal-detail-course");
        const dot = element("span", undefined, "cal-course-dot");
        dot.style.backgroundColor = colors.dot;
        const metaText = [
          course ? course.course_title : (english() ? "Personal" : "個人行程"),
          evt.time || ""
        ].filter(Boolean).join(" · ");
        leftMeta.append(dot, document.createTextNode(metaText));

        const catTag = element("span", customCategoryLabel(evt.category), "cal-detail-type");
        catTag.style.backgroundColor = colors.tint;
        catTag.style.color = colors.ink;
        catTag.style.borderColor = colors.border;
        head.append(leftMeta, catTag);

        const titleRow = element("label", undefined, "cal-detail-check-row");
        const check = element("input");
        check.type = "checkbox";
        check.checked = Boolean(evt.completed);
        check.addEventListener("change", async () => {
          check.disabled = true;
          try {
            const res = await parseJson(
              await api(`/api/calendar/events/${encodeURIComponent(evt.id)}`, {
                method: "PATCH",
                ...json({ completed: check.checked })
              }),
              `/api/calendar/events/${evt.id}`
            );
            const idx = customEvents.findIndex(e => e.id === evt.id);
            if (idx >= 0 && res.event) customEvents[idx] = res.event;
            renderCalendar();
          } catch (error) {
            check.checked = !check.checked;
            report(error);
          } finally {
            check.disabled = false;
          }
        });
        const titleSpan = element("span", evt.title, "cal-detail-title");
        titleRow.append(check, titleSpan);

        card.append(head, titleRow);
        if (evt.notes) card.append(element("p", evt.notes, "cal-detail-desc"));

        const actions = element("div", undefined, "cal-detail-actions");
        actions.append(button(english() ? "Edit" : "編輯", () => openEventDialog(evt), "cal-detail-btn"));
        card.append(actions);
      }

      frag.append(card);
    }

    container.replaceChildren(frag);
  }

  // ============================================================
  // Full Course & Syllabus Editor Dialog
  // ============================================================
  function setEditorTab(tab) {
    editorTab = tab;
    for (const btn of document.querySelectorAll(".ce-tab")) {
      const active = btn.dataset.ceTab === tab;
      btn.setAttribute("aria-selected", String(active));
      btn.tabIndex = active ? 0 : -1;
    }
    for (const id of ["basic", "weeks", "exams"]) {
      const panel = $(`ce-panel-${id}`);
      if (panel) panel.hidden = id !== tab;
    }
    if (tab === "exams") {
      renderEditorExamsList();
    }
  }

  function renderEditorColorGrid() {
    const grid = $("ce-color-grid");
    if (!grid) return;
    const frag = document.createDocumentFragment();
    for (const entry of palette) {
      const selected = editorColor === entry.id;
      const btn = element("button", undefined, `ce-color-swatch${selected ? " is-selected" : ""}`);
      btn.type = "button";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(selected));
      if (selected) {
        btn.style.backgroundColor = entry.tint;
        btn.style.color = entry.ink;
        btn.style.borderColor = entry.accent;
      }

      const dot = element("span", undefined, "ce-color-dot");
      dot.style.backgroundColor = entry.accent;
      const lbl = element("span", english() ? entry.label_en : entry.label_zh, "ce-color-label");
      btn.append(dot, lbl);
      if (selected) {
        const check = element("span", "✓", "ce-color-check");
        check.setAttribute("aria-hidden", "true");
        btn.append(check);
      }
      btn.addEventListener("click", () => {
        editorColor = entry.id;
        renderEditorColorGrid();
      });
      frag.append(btn);
    }
    grid.replaceChildren(frag);
  }

  function renderEditorWeekdays() {
    const wrap = $("ce-weekdays");
    if (!wrap) return;
    const frag = document.createDocumentFragment();
    for (const wd of WEEKDAY_ORDER) {
      const checked = editorWeekdays.includes(wd);
      const btn = element("button", english() ? WEEKDAY_EN_SHORT[wd] : `週${WEEKDAY_ZH_SHORT[wd]}`, `ce-weekday-btn${checked ? " is-selected" : ""}`);
      btn.type = "button";
      btn.setAttribute("aria-pressed", String(checked));
      btn.addEventListener("click", () => {
        if (editorWeekdays.includes(wd)) {
          if (editorWeekdays.length > 1) {
            editorWeekdays = editorWeekdays.filter(d => d !== wd);
          }
        } else {
          editorWeekdays = [...editorWeekdays, wd].sort((a, b) => a - b);
        }
        renderEditorWeekdays();
      });
      frag.append(btn);
    }
    wrap.replaceChildren(frag);
  }

  function syncEditorStartDateControls() {
    const toggle = $("ce-use-custom-start");
    const input = $("ce-start-date");
    const hint = $("ce-start-hint");
    if (!toggle || !input || !hint) return;
    input.classList.toggle("is-muted-start", !toggle.checked);
    if (toggle.checked) {
      hint.textContent = english()
        ? "Overrides the global semester start date for this course only."
        : "將僅套用於此課程，覆寫上方全學期開學基準日。";
    } else {
      hint.textContent = calendarSettings.semester_start_date
        ? (english()
          ? `Following global anchor (${calendarSettings.semester_start_date}) — click date to customize.`
          : `沿用全學期開學基準日（${calendarSettings.semester_start_date}），點擊日期欄即可自訂。`)
        : (english()
          ? "No global semester start date set — click date to customize."
          : "尚未設定全學期開學基準日，點擊日期欄即可自訂。");
    }
  }

  function renderEditorWeeksList() {
    const list = $("ce-weeks-list");
    if (!list) return;
    if (!editorWeeks.length) {
      list.replaceChildren(element("p", english() ? "No weekly units yet. Click “+ Add week” or batch generate below." : "尚未建立週次單元，點擊下方「＋ 新增週次」或批次產生。", "ce-empty-list"));
      return;
    }

    const frag = document.createDocumentFragment();
    const typeSelects = [];
    editorWeeks.forEach((week, idx) => {
      const row = element("div", undefined, "ce-week-row");

      const topLine = element("div", undefined, "ce-week-row-top");

      // Single compact "Week [ 1 ]" prefix group (auto-syncs label)
      const prefixBox = element("div", undefined, "ce-week-prefix-box");
      const prefixText = element("span", "Week", "ce-week-prefix");
      const numInput = element("input", undefined, "ce-week-num");
      numInput.type = "number";
      numInput.min = "1";
      numInput.max = "99";
      numInput.value = String(week.week_number);
      numInput.setAttribute("aria-label", english() ? "Week number" : "週次編號");
      numInput.addEventListener("input", () => {
        const v = Number(numInput.value);
        if (Number.isInteger(v) && v >= 1) {
          week.week_number = v;
          week.label = `Week ${v}`;
        }
      });
      prefixBox.append(prefixText, numInput);

      const titleInput = element("input", undefined, "ce-week-title");
      titleInput.type = "text";
      titleInput.maxLength = 120;
      titleInput.value = week.title || "";
      titleInput.placeholder = english() ? "Unit title" : "單元主題標題";
      titleInput.setAttribute("aria-label", english() ? "Unit title" : "單元主題");
      titleInput.addEventListener("input", () => { week.title = titleInput.value; });

      const typeSelect = element("select", undefined, "ce-week-type");
      typeSelect.setAttribute("aria-label", english() ? "Week type" : "類型");
      for (const [val, zh, en, dotColor] of [
        ["lecture", "授課", "Lecture", "#2d8f74"],
        ["exam", "考試", "Exam", "#c8433e"],
        ["holiday", "放假", "Holiday", "#94a39d"],
        ["activity", "活動", "Activity", "#7b63c7"]
      ]) {
        const opt = new Option(english() ? en : zh, val);
        opt.dataset.dot = dotColor;
        if (week.week_type === val) opt.selected = true;
        typeSelect.append(opt);
      }
      typeSelect.addEventListener("change", () => {
        week.week_type = typeSelect.value;
        week.requires_material = week.week_type === "lecture";
      });
      typeSelects.push(typeSelect);

      const delBtn = button("×", () => {
        editorWeeks.splice(idx, 1);
        renderEditorWeeksList();
      }, "ce-row-remove");
      delBtn.title = english() ? "Remove week" : "刪除此週";
      delBtn.setAttribute("aria-label", english() ? "Remove week" : "刪除此週");

      topLine.append(prefixBox, titleInput, typeSelect, delBtn);

      const subLine = element("div", undefined, "ce-week-row-sub");
      const milestoneInput = element("input", undefined, "ce-week-milestone");
      milestoneInput.type = "text";
      milestoneInput.maxLength = 160;
      milestoneInput.value = week.milestone || "";
      milestoneInput.placeholder = english() ? "Milestone / assignment note (optional)" : "重要進度或作業備註（選填）";
      milestoneInput.addEventListener("input", () => { week.milestone = milestoneInput.value; });

      const topicsInput = element("input", undefined, "ce-week-topics");
      topicsInput.type = "text";
      topicsInput.maxLength = 300;
      topicsInput.value = (week.topics || []).join("；");
      topicsInput.placeholder = english() ? "Key topics separated by ;" : "關鍵主題（以分號分隔，選填）";
      topicsInput.addEventListener("input", () => {
        week.topics = topicsInput.value.split(/[;；]/).map(s => s.trim()).filter(Boolean);
      });

      subLine.append(milestoneInput, topicsInput);
      row.append(topLine, subLine);

      if (Number(week.material_count || 0) > 0) {
        const warn = element(
          "p",
          english()
            ? `${week.material_count} slide file(s) in this folder — deleting this week moves them safely to the course root.`
            : `此週資料夾含 ${week.material_count} 份檔案（刪除週次時會自動移回課程根目錄保存）。`,
          "ce-week-file-note"
        );
        row.append(warn);
      }

      frag.append(row);
    });
    list.replaceChildren(frag);
    if (typeof window.enhanceBrandSelect === "function") {
      for (const sel of typeSelects) window.enhanceBrandSelect(sel);
    }
    if (typeof syncAllCustomSelects === "function") syncAllCustomSelects();
  }

  function batchGenerateWeeks(targetCount) {
    const existing = new Set(editorWeeks.map(w => Number(w.week_number)));
    let added = 0;
    for (let n = 1; n <= targetCount; n++) {
      if (existing.has(n)) continue;
      editorWeeks.push({
        week_number: n,
        label: `Week ${n}`,
        title: english() ? `Week ${n} Topic` : `第 ${n} 週主題`,
        week_type: "lecture",
        requires_material: true,
        folder_id: null,
        folder_name: null,
        topics: [],
        objectives: [],
        milestone: "",
        material_count: 0
      });
      added++;
    }
    editorWeeks.sort((a, b) => (Number(a.week_number) || 0) - (Number(b.week_number) || 0));
    renderEditorWeeksList();
    const status = $("ce-status");
    if (status) {
      status.classList.add("is-info");
      status.textContent = added > 0
        ? (english() ? `Generated ${added} missing week(s) up to Week ${targetCount}.` : `已批次補齊 ${added} 週，目前共涵蓋至第 ${targetCount} 週。`)
        : (english() ? `Weeks 1–${targetCount} are already present.` : `第 1–${targetCount} 週已全數存在。`);
      window.setTimeout(() => {
        status.classList.remove("is-info");
        if (status.textContent.includes(String(targetCount))) status.textContent = "";
      }, 3000);
    }
  }

  function renderEditorExamsList() {
    const list = $("ce-exams-list");
    if (!list) return;
    if (!editorExams.length) {
      list.replaceChildren(element("p", english() ? "No exams or milestones yet." : "尚未建立考試或里程碑項目。", "ce-empty-list"));
      return;
    }

    const sortedWeeks = [...editorWeeks].sort((a, b) => (Number(a.week_number) || 0) - (Number(b.week_number) || 0));
    const frag = document.createDocumentFragment();
    const weekSelects = [];

    editorExams.forEach((ex, idx) => {
      const row = element("div", undefined, "ce-exam-row");

      const topLine = element("div", undefined, "ce-exam-row-top");
      const titleInput = element("input", undefined, "ce-exam-title");
      titleInput.type = "text";
      titleInput.maxLength = 80;
      titleInput.value = ex.title || "";
      titleInput.placeholder = english() ? "Midterm / Project Due" : "期中考／專題繳交";
      titleInput.setAttribute("aria-label", english() ? "Milestone title" : "里程碑名稱");
      titleInput.addEventListener("input", () => { ex.title = titleInput.value; });

      // Real native date picker (consistent across the app)
      const dateInput = element("input", undefined, "ce-exam-date");
      dateInput.type = "date";
      dateInput.value = isValidIso(ex.date) ? ex.date : (parseExplicitDate(ex.date) || "");
      dateInput.setAttribute("aria-label", english() ? "Explicit date" : "明確日期");
      dateInput.addEventListener("change", () => { ex.date = dateInput.value; });
      dateInput.addEventListener("input", () => { ex.date = dateInput.value; });

      // Linked week dropdown populated from Tab 2 weekly units
      const weekSelect = element("select", undefined, "ce-exam-week");
      weekSelect.setAttribute("aria-label", english() ? "Linked week" : "關聯週次");
      weekSelect.append(new Option(english() ? "No linked week" : "不指定週次", ""));
      const knownWeekNums = new Set();
      for (const w of sortedWeeks) {
        knownWeekNums.add(w.week_number);
        const shortTitle = (w.title || "").trim();
        const label = shortTitle
          ? (english() ? `Week ${w.week_number} · ${shortTitle}` : `第 ${w.week_number} 週 · ${shortTitle}`)
          : (english() ? `Week ${w.week_number}` : `第 ${w.week_number} 週`);
        const opt = new Option(label, String(w.week_number));
        if (ex.week === w.week_number) opt.selected = true;
        weekSelect.append(opt);
      }
      if (ex.week && !knownWeekNums.has(ex.week)) {
        const opt = new Option(english() ? `Week ${ex.week}` : `第 ${ex.week} 週`, String(ex.week));
        opt.selected = true;
        weekSelect.append(opt);
      }
      weekSelect.addEventListener("change", () => {
        const v = Number(weekSelect.value);
        ex.week = Number.isInteger(v) && v >= 1 ? v : null;
      });
      weekSelects.push(weekSelect);

      const delBtn = button("×", () => {
        editorExams.splice(idx, 1);
        renderEditorExamsList();
      }, "ce-row-remove");
      delBtn.title = english() ? "Remove milestone" : "刪除此項目";
      delBtn.setAttribute("aria-label", english() ? "Remove milestone" : "刪除此項目");

      topLine.append(titleInput, dateInput, weekSelect, delBtn);

      const notesInput = element("input", undefined, "ce-exam-notes");
      notesInput.type = "text";
      notesInput.maxLength = 180;
      notesInput.value = ex.notes || "";
      notesInput.placeholder = english() ? "Details / coverage (optional)" : "考試範圍、地點或繳交說明（選填）";
      notesInput.setAttribute("aria-label", english() ? "Milestone notes" : "備註說明");
      notesInput.addEventListener("input", () => { ex.notes = notesInput.value; });

      row.append(topLine, notesInput);
      frag.append(row);
    });
    list.replaceChildren(frag);
    if (typeof window.enhanceBrandSelect === "function") {
      for (const sel of weekSelects) window.enhanceBrandSelect(sel);
    }
    if (typeof syncAllCustomSelects === "function") syncAllCustomSelects();
  }

  function resetDeleteArm() {
    deleteArmed = false;
    window.clearTimeout(deleteConfirmTimer);
    const delBtn = $("ce-delete-course");
    if (delBtn) {
      delBtn.textContent = tr("刪除課程規劃");
      delBtn.classList.remove("is-armed");
    }
  }

  function openCourseEditor(course = null, initialTab = "basic") {
    editorCourseId = course ? course.id : null;
    resetDeleteArm();
    $("ce-status").textContent = "";

    const dialogTitle = $("course-editor-title");
    const dialogSub = $("course-editor-sub");
    const delBtn = $("ce-delete-course");
    const saveBtn = $("ce-save-btn");

    if (course) {
      dialogTitle.textContent = english() ? "Edit course & schedule" : "編輯課綱與排程";
      dialogSub.textContent = course.course_title;
      delBtn.hidden = false;
      saveBtn.textContent = english() ? "Save changes" : "儲存變更";

      $("ce-title").value = course.course_title || "";
      $("ce-summary").value = course.summary || "";
      editorColor = course.schedule?.color || "mint";
      editorWeekdays = Array.isArray(course.schedule?.weekdays) && course.schedule.weekdays.length
        ? [...course.schedule.weekdays]
        : [1];
      const hasCustomStart = Boolean(course.schedule?.start_date_override);
      $("ce-use-custom-start").checked = hasCustomStart;
      $("ce-start-date").value = course.schedule?.start_date_override || calendarSettings.semester_start_date || "";
      $("ce-location").value = course.schedule?.location || "";

      editorWeeks = (course.weeks || []).map(w => ({
        week_number: w.week_number,
        label: w.label,
        title: w.title,
        week_type: w.week_type || "lecture",
        requires_material: w.requires_material !== false && (w.week_type || "lecture") === "lecture",
        folder_id: w.folder_id || null,
        folder_name: w.folder_name || null,
        topics: [...(w.topics || [])],
        objectives: [...(w.objectives || [])],
        milestone: w.milestone || "",
        material_count: w.material_count || 0
      }));
      editorExams = (course.exams || []).map(e => ({
        title: e.title || "",
        date: e.date || "",
        week: e.week || null,
        notes: e.notes || ""
      }));
    } else {
      dialogTitle.textContent = english() ? "Create new course" : "手動新增課程";
      dialogSub.textContent = english() ? "Set schedule, color tag, and weekly units" : "設定課程色標、上課星期與每週單元";
      delBtn.hidden = true;
      saveBtn.textContent = english() ? "Create course" : "建立課程";

      $("ce-title").value = "";
      $("ce-summary").value = "";
      const used = new Set(coursesData.map(c => c.schedule?.color));
      const nextColor = palette.find(entry => !used.has(entry.id)) || palette[coursesData.length % palette.length];
      editorColor = nextColor?.id || "mint";
      editorWeekdays = [1];
      $("ce-use-custom-start").checked = false;
      $("ce-start-date").value = calendarSettings.semester_start_date || "";
      $("ce-location").value = "";

      editorWeeks = [
        {
          week_number: 1,
          label: "Week 1",
          title: english() ? "Course Introduction" : "課程導論",
          week_type: "lecture",
          requires_material: true,
          folder_id: null,
          folder_name: null,
          topics: [],
          objectives: [],
          milestone: "",
          material_count: 0
        }
      ];
      editorExams = [];
    }

    renderEditorColorGrid();
    renderEditorWeekdays();
    syncEditorStartDateControls();
    renderEditorWeeksList();
    renderEditorExamsList();
    setEditorTab(initialTab);
    $("course-editor-dialog").showModal();
  }

  // ============================================================
  // Custom Calendar Event Dialog
  // ============================================================
  function syncEventTimeClear() {
    const input = $("cal-evt-time");
    const clearBtn = $("cal-evt-time-clear");
    if (!input || !clearBtn) return;
    clearBtn.hidden = !input.value;
  }

  function populateEventCourseSelect(selectedCourseId) {
    const sel = $("cal-evt-course");
    if (!sel) return;
    const personalOpt = new Option(english() ? "No linked course" : "不指定課程（個人行程）", "");
    personalOpt.dataset.dot = "#94a39d";
    const courseOpts = coursesData.map(c => {
      const opt = new Option(c.course_title, c.id);
      opt.dataset.dot = getPalette(c.schedule?.color).accent;
      return opt;
    });
    sel.replaceChildren(personalOpt, ...courseOpts);
    sel.value = selectedCourseId || "";
  }

  function openEventDialog(evt = null) {
    editingEventId = evt ? evt.id : null;
    $("cal-evt-status").textContent = "";
    const titleEl = $("cal-evt-dialog-title");
    const delBtn = $("cal-evt-delete");

    if (evt) {
      titleEl.textContent = english() ? "Edit custom event" : "編輯自訂事件";
      delBtn.hidden = false;
      $("cal-evt-title").value = evt.title || "";
      $("cal-evt-date").value = evt.date || selectedDate;
      $("cal-evt-time").value = evt.time || "";
      $("cal-evt-category").value = evt.category || "todo";
      populateEventCourseSelect(evt.course_id || "");
      $("cal-evt-notes").value = evt.notes || "";
    } else {
      titleEl.textContent = english() ? "New custom event" : "新增自訂事件";
      delBtn.hidden = true;
      $("cal-evt-title").value = "";
      $("cal-evt-date").value = selectedDate;
      $("cal-evt-time").value = "";
      $("cal-evt-category").value = "todo";
      populateEventCourseSelect("");
      $("cal-evt-notes").value = "";
    }

    syncEventTimeClear();
    if (typeof syncAllCustomSelects === "function") syncAllCustomSelects();
    $("calendar-event-dialog").showModal();
    $("cal-evt-title").focus();
  }

  // ============================================================
  // Data Loading
  // ============================================================
  async function loadCoursesData() {
    const data = await get("/api/courses");
    coursesData = Array.isArray(data.courses) ? data.courses : [];
    calendarSettings = data.calendar_settings || { semester_start_date: null, week_starts_on: 1 };
    customEvents = Array.isArray(data.events) ? data.events : [];
    if (Array.isArray(data.palette) && data.palette.length) {
      palette = data.palette;
      paletteMap = new Map(palette.map(entry => [entry.id, entry]));
    }

    const startInput = $("semester-start-input");
    if (startInput && document.activeElement !== startInput) {
      startInput.value = calendarSettings.semester_start_date || "";
    }

    renderCoursesGrid();
    renderCalendar();
  }

  window.refreshCoursesView = async () => {
    if (!inCourses) return;
    await loadCoursesData();
  };

  // ============================================================
  // Event Listeners (only active when on /courses or dialogs used)
  // ============================================================
  $("semester-start-input")?.addEventListener("change", async event => {
    const value = event.currentTarget.value.trim() || null;
    const status = $("semester-start-status");
    if (status) status.textContent = english() ? "Saving…" : "儲存中…";
    try {
      const res = await parseJson(
        await api("/api/calendar/settings", {
          method: "PATCH",
          ...json({ semester_start_date: value })
        }),
        "/api/calendar/settings"
      );
      calendarSettings = res.calendar_settings || calendarSettings;
      if (status) {
        status.textContent = english() ? "Saved" : "已儲存";
        window.setTimeout(() => {
          if (status.textContent === "已儲存" || status.textContent === "Saved") status.textContent = "";
        }, 2000);
      }
      renderCoursesGrid();
      renderCalendar();
    } catch (error) {
      if (status) status.textContent = "";
      report(error);
    }
  });

  $("courses-import-syllabus")?.addEventListener("click", () => window.openNewSyllabusImport?.());
  $("courses-empty-import")?.addEventListener("click", () => window.openNewSyllabusImport?.());
  $("courses-create-btn")?.addEventListener("click", () => openCourseEditor(null, "basic"));
  $("courses-empty-create")?.addEventListener("click", () => openCourseEditor(null, "basic"));

  $("cal-prev-month")?.addEventListener("click", () => {
    viewMonth -= 1;
    if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
    renderCalendar();
  });
  $("cal-next-month")?.addEventListener("click", () => {
    viewMonth += 1;
    if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
    renderCalendar();
  });
  $("cal-today-btn")?.addEventListener("click", () => {
    const today = new Date();
    viewYear = today.getFullYear();
    viewMonth = today.getMonth();
    selectedDate = toLocalIso(today);
    renderCalendar();
  });
  $("cal-add-event-btn")?.addEventListener("click", () => openEventDialog(null));

  // Course Editor modal interactions
  for (const tabBtn of document.querySelectorAll(".ce-tab")) {
    tabBtn.addEventListener("click", () => setEditorTab(tabBtn.dataset.ceTab));
  }
  $("ce-use-custom-start")?.addEventListener("change", syncEditorStartDateControls);
  const activateCustomStart = () => {
    const toggle = $("ce-use-custom-start");
    if (toggle && !toggle.checked) {
      toggle.checked = true;
      syncEditorStartDateControls();
    }
  };
  $("ce-start-date")?.addEventListener("pointerdown", activateCustomStart);
  $("ce-start-date")?.addEventListener("focus", activateCustomStart);
  $("ce-start-date")?.addEventListener("input", activateCustomStart);

  $("ce-add-week")?.addEventListener("click", () => {
    const maxNum = editorWeeks.reduce((m, w) => Math.max(m, Number(w.week_number) || 0), 0);
    const nextNum = maxNum + 1;
    editorWeeks.push({
      week_number: nextNum,
      label: `Week ${nextNum}`,
      title: "",
      week_type: "lecture",
      requires_material: true,
      folder_id: null,
      folder_name: null,
      topics: [],
      objectives: [],
      milestone: "",
      material_count: 0
    });
    renderEditorWeeksList();
    const list = $("ce-weeks-list");
    const lastTitle = list?.querySelector(".ce-week-row:last-child .ce-week-title");
    lastTitle?.focus();
  });

  $("ce-batch-16")?.addEventListener("click", () => batchGenerateWeeks(16));
  $("ce-batch-18")?.addEventListener("click", () => batchGenerateWeeks(18));

  $("ce-add-exam")?.addEventListener("click", () => {
    editorExams.push({ title: "", date: "", week: null, notes: "" });
    renderEditorExamsList();
    const list = $("ce-exams-list");
    const lastTitle = list?.querySelector(".ce-exam-row:last-child .ce-exam-title");
    lastTitle?.focus();
  });

  $("ce-delete-course")?.addEventListener("click", async () => {
    if (!editorCourseId) return;
    const btn = $("ce-delete-course");
    if (!deleteArmed) {
      deleteArmed = true;
      btn.textContent = english() ? "Click again to confirm delete" : "再次點擊確認刪除（保留檔案）";
      btn.classList.add("is-armed");
      deleteConfirmTimer = window.setTimeout(resetDeleteArm, 4500);
      return;
    }
    resetDeleteArm();
    btn.disabled = true;
    try {
      await parseJson(
        await api(`/api/courses/${encodeURIComponent(editorCourseId)}`, { method: "DELETE" }),
        `/api/courses/${editorCourseId}`
      );
      $("course-editor-dialog").close();
      await loadCoursesData();
      if (typeof window.refreshSyllabusPlan === "function") await window.refreshSyllabusPlan();
    } catch (error) {
      $("ce-status").textContent = friendlyError(error);
    } finally {
      btn.disabled = false;
    }
  });

  $("course-editor-dialog")?.addEventListener("close", resetDeleteArm);

  $("course-editor-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const status = $("ce-status");
    const saveBtn = $("ce-save-btn");
    const title = $("ce-title").value.trim();
    if (!title) {
      setEditorTab("basic");
      status.textContent = english() ? "Please enter a course name." : "請輸入課程名稱。";
      $("ce-title").focus();
      return;
    }

    const useCustomStart = $("ce-use-custom-start").checked;
    const startVal = useCustomStart ? ($("ce-start-date").value.trim() || null) : null;
    const payload = {
      course_title: title,
      summary: $("ce-summary").value.trim(),
      schedule: {
        color: editorColor,
        weekdays: editorWeekdays,
        start_date_override: startVal,
        location: $("ce-location").value.trim(),
        manual_override: true
      },
      weeks: editorWeeks
        .filter(w => (w.title || "").trim())
        .map(w => ({
          week_number: Number(w.week_number) || 1,
          label: (w.label || `Week ${w.week_number}`).trim(),
          title: w.title.trim(),
          week_type: w.week_type || "lecture",
          folder_id: w.folder_id || null,
          topics: w.topics || [],
          objectives: w.objectives || [],
          milestone: (w.milestone || "").trim() || null
        })),
      exams: editorExams
        .filter(e => (e.title || "").trim())
        .map(e => ({
          title: e.title.trim(),
          date: (e.date || "").trim(),
          week: e.week ? Number(e.week) : null,
          notes: (e.notes || "").trim()
        }))
    };

    if (!payload.weeks.length) {
      setEditorTab("weeks");
      status.textContent = english() ? "Please keep at least one weekly unit with a title." : "請至少保留一個填寫標題的週次單元。";
      return;
    }

    saveBtn.disabled = true;
    status.textContent = english() ? "Saving…" : "儲存中…";
    try {
      if (editorCourseId) {
        const result = await parseJson(
          await api(`/api/courses/${encodeURIComponent(editorCourseId)}`, {
            method: "PUT",
            ...json(payload)
          }),
          `/api/courses/${editorCourseId}`
        );
        $("course-editor-dialog").close();
        await loadCoursesData();
        if (typeof window.refreshSyllabusPlan === "function") await window.refreshSyllabusPlan();
        if (result.evacuated_files > 0) {
          const msg = english()
            ? `Saved course. ${result.evacuated_files} file(s) from deleted week(s) were moved safely to the course root folder.`
            : `已儲存課程變更，並將已刪除週次中的 ${result.evacuated_files} 份檔案安全退回課程根目錄。`;
          const s = $("semester-start-status");
          if (s) {
            s.textContent = msg;
            window.setTimeout(() => { if (s.textContent === msg) s.textContent = ""; }, 5000);
          }
        }
      } else {
        await post("/api/courses", payload);
        $("course-editor-dialog").close();
        await loadCoursesData();
        if (typeof window.refreshSyllabusPlan === "function") await window.refreshSyllabusPlan();
      }
    } catch (error) {
      status.textContent = friendlyError(error);
    } finally {
      saveBtn.disabled = false;
    }
  });

  // Custom Event modal interactions
  $("cal-evt-time")?.addEventListener("input", syncEventTimeClear);
  $("cal-evt-time")?.addEventListener("change", syncEventTimeClear);
  $("cal-evt-time-clear")?.addEventListener("click", () => {
    const input = $("cal-evt-time");
    if (!input) return;
    input.value = "";
    syncEventTimeClear();
    input.focus();
  });

  $("calendar-event-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const status = $("cal-evt-status");
    const saveBtn = $("cal-evt-save");
    const title = $("cal-evt-title").value.trim();
    const date = $("cal-evt-date").value.trim();
    if (!title || !isValidIso(date)) {
      status.textContent = english() ? "Please enter a title and valid date." : "請輸入事件標題與有效日期。";
      return;
    }
    const payload = {
      title,
      date,
      time: $("cal-evt-time").value.trim() || null,
      category: $("cal-evt-category").value || "todo",
      course_id: $("cal-evt-course").value || null,
      notes: $("cal-evt-notes").value.trim()
    };

    saveBtn.disabled = true;
    status.textContent = english() ? "Saving…" : "儲存中…";
    try {
      if (editingEventId) {
        await parseJson(
          await api(`/api/calendar/events/${encodeURIComponent(editingEventId)}`, {
            method: "PATCH",
            ...json(payload)
          }),
          `/api/calendar/events/${editingEventId}`
        );
      } else {
        await post("/api/calendar/events", payload);
      }
      selectedDate = date;
      const dt = parseUtcDate(date);
      viewYear = dt.getUTCFullYear();
      viewMonth = dt.getUTCMonth();
      $("calendar-event-dialog").close();
      await loadCoursesData();
    } catch (error) {
      status.textContent = friendlyError(error);
    } finally {
      saveBtn.disabled = false;
    }
  });

  $("cal-evt-delete")?.addEventListener("click", async () => {
    if (!editingEventId) return;
    const btn = $("cal-evt-delete");
    btn.disabled = true;
    try {
      await parseJson(
        await api(`/api/calendar/events/${encodeURIComponent(editingEventId)}`, { method: "DELETE" }),
        `/api/calendar/events/${editingEventId}`
      );
      $("calendar-event-dialog").close();
      await loadCoursesData();
    } catch (error) {
      $("cal-evt-status").textContent = friendlyError(error);
    } finally {
      btn.disabled = false;
    }
  });

  // ============================================================
  // Route Activation & Language Reactivity
  // ============================================================
  if (inCourses) {
    if (layout) layout.hidden = true;
    if (catalog) catalog.hidden = true;
    page.hidden = false;
    document.body.classList.add("courses-mode");
    $("courses-link")?.setAttribute("aria-current", "location");
    const skip = document.querySelector(".skip");
    if (skip) skip.href = "#courses-page";
    for (const a of document.querySelectorAll('.narrow-nav a[href^="#"]')) {
      a.href = "/" + a.hash;
      a.removeAttribute("aria-current");
    }

    loadCoursesData().catch(report);

    document.addEventListener("aita-language", () => {
      renderCoursesGrid();
      renderCalendar();
      if ($("course-editor-dialog")?.open) {
        renderEditorColorGrid();
        renderEditorWeekdays();
        syncEditorStartDateControls();
        renderEditorWeeksList();
        renderEditorExamsList();
      }
    });
  }
})();
