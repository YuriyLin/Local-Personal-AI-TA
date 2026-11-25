"use strict";

(() => {
  // ============================================================
  // State
  // ============================================================
  let coursePlan = null;
  let syllabusOpenState = readLocal("biibo-syllabus-open", true);
  let activePreviewWeek = null;
  let pastedSyllabusImage = null;
  let syllabusPreviewUrl = "";

  let draftScope = "page";
  let draftViewMode = "rendered";
  let currentDraft = null;
  let draftBusy = false;

  const quizState = {
    docId: "",
    docName: "",
    scope: "page",
    count: 3,
    questions: [],
    index: 0,
    answers: [],
    hintsShown: [],
    paused: false,
    busy: false,
    autoCloseTimer: 0,
    autoCloseInterval: 0,
    autoCloseRemaining: 0
  };

  // ============================================================
  // Helpers
  // ============================================================
  function activeReadableDoc() {
    const doc = window.reader?.doc;
    if (!doc) return null;
    if (doc.kind === "personal" && doc.original_id) {
      return state.documents.find(d => d.id === doc.original_id) || doc;
    }
    return doc;
  }

  function currentPdfPage() {
    const r = window.reader;
    if (r?.doc?.kind === "pdf" && !r.unmapped && Number.isInteger(r.page) && r.page >= 1) {
      return r.page;
    }
    return null;
  }

  function syncContextLabels() {
    const doc = activeReadableDoc();
    const page = currentPdfPage();
    const isPdf = doc?.kind === "pdf";

    const draftPageBtn = $("draft-scope-page");
    if (draftPageBtn) {
      draftPageBtn.textContent = page
        ? (english() ? `Current page (P.${page})` : `目前頁面 (P.${page})`)
        : tr("目前頁面");
      draftPageBtn.disabled = !isPdf;
      if (!isPdf && draftScope === "page") setDraftScope("full");
    }

    const quizPageBtn = $("quiz-scope-page");
    if (quizPageBtn) {
      quizPageBtn.textContent = page
        ? (english() ? `Current page (P.${page})` : `目前頁面 (P.${page})`)
        : tr("目前頁面");
      quizPageBtn.disabled = !isPdf;
      if (!isPdf && quizState.scope === "page") setQuizScope("full");
    }

    const quizFullBtn = $("quiz-scope-full");
    if (quizFullBtn) {
      quizFullBtn.textContent = isPdf ? tr("整份 PDF") : tr("整份教材");
    }
  }

  window.onReaderContextChange = () => {
    syncContextLabels();
  };

  function isSyllabusImageFile(file) {
    if (!file) return false;
    return (file.type && file.type.startsWith("image/")) || /\.(png|jpe?g|webp|gif)$/i.test(file.name || "");
  }

  function formatByteSize(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  function extensionForImageMime(mime) {
    const m = String(mime || "").toLowerCase();
    if (m.includes("jpeg") || m.includes("jpg")) return ".jpg";
    if (m.includes("webp")) return ".webp";
    if (m.includes("gif")) return ".gif";
    return ".png";
  }

  function revokeSyllabusPreviewUrl() {
    if (syllabusPreviewUrl) {
      URL.revokeObjectURL(syllabusPreviewUrl);
      syllabusPreviewUrl = "";
    }
  }

  function clearSyllabusImagePreview(clearFileInput = false) {
    revokeSyllabusPreviewUrl();
    pastedSyllabusImage = null;
    if (clearFileInput && $("syllabus-file")) {
      $("syllabus-file").value = "";
    }
    const wrap = $("syllabus-image-preview");
    const img = $("syllabus-preview-img");
    if (img) img.removeAttribute("src");
    if (wrap) wrap.hidden = true;
    updateSyllabusFileLabel();
  }

  function showSyllabusImagePreview(file, sourceKind) {
    revokeSyllabusPreviewUrl();
    syllabusPreviewUrl = URL.createObjectURL(file);
    const wrap = $("syllabus-image-preview");
    const img = $("syllabus-preview-img");
    const nameEl = $("syllabus-preview-name");
    const metaEl = $("syllabus-preview-meta");
    if (img) img.src = syllabusPreviewUrl;
    if (nameEl) {
      nameEl.textContent = sourceKind === "clipboard"
        ? (english() ? `Clipboard image · ${file.name}` : `剪貼簿截圖 · ${file.name}`)
        : file.name;
    }
    if (metaEl) {
      const size = formatByteSize(file.size);
      metaEl.textContent = english()
        ? `${size ? `${size} · ` : ""}Ready for BIIBO to read`
        : `${size ? `${size} · ` : ""}已就緒，將由 BIIBO 讀取圖片內容`;
    }
    if (wrap) wrap.hidden = false;
  }

  function attachClipboardImage(blobOrFile) {
    if (!blobOrFile) return false;
    const ext = extensionForImageMime(blobOrFile.type);
    const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const name = blobOrFile.name && /\.(png|jpe?g|webp|gif)$/i.test(blobOrFile.name)
      ? blobOrFile.name
      : `clipboard-syllabus-${stamp}${ext}`;
    const file = new File([blobOrFile], name, { type: blobOrFile.type || "image/png" });
    if ($("syllabus-file")) $("syllabus-file").value = "";
    pastedSyllabusImage = file;
    showSyllabusImagePreview(file, "clipboard");
    updateSyllabusFileLabel();
    $("syllabus-status").textContent = english()
      ? "Clipboard image attached. Click Start AI Planning for BIIBO to read it."
      : "已貼上剪貼簿圖片，點擊「開始 AI 規劃」即可由 BIIBO 讀取並規劃。";
    return true;
  }

  // ============================================================
  // Feature 1: Syllabus Upload, Weekly Cards, Gaps & Preview Handoff
  // ============================================================
  function getWeekCardVisual(week) {
    const weekType = week.week_type || "lecture";
    const count = Number(week.material_count || 0);
    if (weekType === "holiday") {
      return {
        cardClass: "week-card is-holiday",
        statusClass: "week-card-status is-holiday",
        statusText: english() ? "Holiday · No slides" : "放假 · 免講義"
      };
    }
    if (weekType === "exam") {
      if (count > 0) {
        return {
          cardClass: "week-card is-ready",
          statusClass: "week-card-status is-ready",
          statusText: english() ? `${count} file${count > 1 ? "s" : ""}` : `${count} 份資料`
        };
      }
      return {
        cardClass: "week-card is-exam",
        statusClass: "week-card-status is-exam",
        statusText: english() ? "Exam · Review plan" : "考試週 · 考前複習"
      };
    }
    if (weekType === "activity") {
      if (count > 0) {
        return {
          cardClass: "week-card is-ready",
          statusClass: "week-card-status is-ready",
          statusText: english() ? `${count} file${count > 1 ? "s" : ""}` : `${count} 份資料`
        };
      }
      return {
        cardClass: "week-card is-activity",
        statusClass: "week-card-status is-activity",
        statusText: english() ? "Activity · Checklist" : "活動週 · 準備清單"
      };
    }
    if (week.has_gap) {
      return {
        cardClass: "week-card is-gap",
        statusClass: "week-card-status is-gap",
        statusText: english() ? "Missing slides · Preview" : "尚缺講義 · 點擊預習"
      };
    }
    return {
      cardClass: "week-card is-ready",
      statusClass: "week-card-status is-ready",
      statusText: english() ? `${count} slides` : `${count} 份講義`
    };
  }

  function renderSyllabusPanel() {
    const panel = $("syllabus-panel");
    if (!panel) return;
    if (!coursePlan || !Array.isArray(coursePlan.weeks) || !coursePlan.weeks.length) {
      panel.hidden = true;
      panel.replaceChildren();
      return;
    }

    panel.hidden = false;
    const materialWeeks = coursePlan.weeks.filter(w => w.requires_material !== false);
    const nonMaterialCount = coursePlan.weeks.length - materialWeeks.length;
    const gapCount = materialWeeks.filter(w => w.has_gap).length;
    const readyCount = materialWeeks.length - gapCount;

    const metaText = english()
      ? (nonMaterialCount > 0
        ? `${readyCount}/${materialWeeks.length} lectures ready · ${gapCount} missing · ${nonMaterialCount} non-lecture`
        : `${readyCount}/${materialWeeks.length} ready · ${gapCount} missing`)
      : (nonMaterialCount > 0
        ? `授課 ${readyCount}/${materialWeeks.length} 堂就緒 · 缺 ${gapCount} 堂 · ${nonMaterialCount} 週免講義`
        : `已就緒 ${readyCount}/${materialWeeks.length} 週 · 缺 ${gapCount} 週`);

    const details = element("details", undefined, "syllabus-card-shell");
    details.open = Boolean(syllabusOpenState);
    details.addEventListener("toggle", () => {
      syllabusOpenState = details.open;
      try { saveLocal("biibo-syllabus-open", syllabusOpenState); } catch { /* ignore */ }
    });

    const summary = element("summary", undefined, "syllabus-summary");
    const chevron = element("span", undefined, "kind-chevron");
    chevron.setAttribute("aria-hidden", "true");
    const titleWrap = element("span", undefined, "syllabus-summary-text");
    titleWrap.append(
      element("span", coursePlan.course_title, "syllabus-course-title"),
      element("span", metaText, "syllabus-course-meta")
    );
    summary.append(chevron, titleWrap);

    const body = element("div", undefined, "syllabus-body");

    const topRow = element("div", undefined, "syllabus-toolbar");
    if (coursePlan.overview_document_id) {
      const overviewBtn = button(
        english() ? "Overview note" : "開啟課程總覽筆記",
        () => openDocument(coursePlan.overview_document_id),
        "syllabus-link-btn"
      );
      topRow.append(overviewBtn);
    }
    const reuploadBtn = button(
      english() ? "Update syllabus" : "更新課綱",
      () => openSyllabusDialog(),
      "syllabus-link-btn"
    );
    topRow.append(reuploadBtn);
    body.append(topRow);

    const list = element("ul", undefined, "syllabus-week-list");
    for (const week of coursePlan.weeks) {
      const visual = getWeekCardVisual(week);
      const li = element("li", undefined, "syllabus-week-item");
      const btn = element("button", undefined, visual.cardClass);
      btn.type = "button";
      btn.setAttribute("aria-label", `${week.label} ${week.title}`);

      const rowTop = element("div", undefined, "week-card-top");
      rowTop.append(
        element("span", week.label, "week-card-label"),
        element("span", visual.statusText, visual.statusClass)
      );

      const titleEl = element("div", week.title, "week-card-title");
      btn.append(rowTop, titleEl);

      if (week.milestone) {
        btn.append(element("div", week.milestone, "week-card-milestone"));
      }

      btn.addEventListener("click", () => handleWeekCardClick(week));
      li.append(btn);
      list.append(li);
    }

    body.append(list);
    details.append(summary, body);
    panel.replaceChildren(details);
  }

  function handleWeekCardClick(week) {
    if (week.folder_id && week.material_count > 0) {
      hideWeekPreviewBanner();
      if (typeof window.expandCourseFolder === "function") {
        window.expandCourseFolder(week.folder_id);
      }
      const firstDoc = week.materials?.[0];
      if (firstDoc?.id && state.document !== firstDoc.id) {
        openDocument(firstDoc.id).catch(report);
      }
      return;
    }

    // Switch right pane to Tutor and display tailored guidance for lecture gap, exam, activity, or holiday.
    activePreviewWeek = week;
    if (typeof window.setRightPaneTab === "function") {
      window.setRightPaneTab("tutor", true);
    }
    showWeekPreviewBanner(week);
  }

  function showWeekPreviewBanner(week) {
    const banner = $("week-preview-banner");
    if (!banner) return;
    const weekType = week.week_type || "lecture";
    banner.dataset.weekType = weekType;

    const goBtn = $("week-preview-go");
    const uploadBtn = $("week-preview-upload");
    const topicsText = (week.topics || []).slice(0, 4).join(" · ");
    const objText = (week.objectives || [])[0] || "";

    $("week-preview-title").textContent = week.title;

    if (weekType === "holiday") {
      $("week-preview-kicker").textContent = english()
        ? `${week.label} · Holiday (no slides required)`
        : `${week.label} · 放假停課（免預設講義）`;
      $("week-preview-desc").textContent = english()
        ? "This week is a holiday, so BIIBO skipped creating an empty folder and won't flag it as missing slides."
        : "本週為放假週，系統已彈性略過資料夾建立且不計入學習缺口。如需補課或放補充資料，仍可隨時建立分類。";
      if (goBtn) {
        goBtn.hidden = !coursePlan?.overview_document_id;
        goBtn.textContent = english() ? "Open course overview note" : "檢視課程總覽筆記";
      }
      if (uploadBtn) {
        uploadBtn.textContent = week.folder_id
          ? (english() ? "Upload supplemental file" : "上傳補充資料")
          : (english() ? "Create folder anyway" : "仍要建立此週分類");
      }
    } else if (weekType === "exam") {
      $("week-preview-kicker").textContent = english()
        ? `${week.label} · Exam week (no lecture folder needed)`
        : `${week.label} · 考試週（已自動略過空資料夾）`;
      $("week-preview-desc").textContent =
        topicsText || objText || (english()
          ? "Ask BIIBO to synthesize a focused exam study plan from earlier weeks, or create a folder if you want to upload past exams."
          : "這週為考試週，不強制要求課程講義。可請 BIIBO 彙整先前週次的考前重點，或按需建立分類上傳考古題／重點整理。");
      if (goBtn) {
        goBtn.hidden = false;
        goBtn.textContent = english() ? "Build exam review roadmap" : "幫我規劃考前重點複習";
      }
      if (uploadBtn) {
        uploadBtn.textContent = week.folder_id
          ? (english() ? "Upload exam prep files" : "上傳考前複習資料")
          : (english() ? "Create folder & upload" : "為此週建立分類並上傳");
      }
    } else if (weekType === "activity") {
      $("week-preview-kicker").textContent = english()
        ? `${week.label} · Activity / review week`
        : `${week.label} · 評量／活動週（免預設講義）`;
      $("week-preview-desc").textContent =
        topicsText || objText || (english()
          ? "No lecture slides required. Ask BIIBO for a preparation checklist, or create a folder to store project rubrics or slides."
          : "本週為專題互評或活動週，不計入缺講義警告。可請 BIIBO 整理準備清單，或按需建立分類存放評分表與簡報。");
      if (goBtn) {
        goBtn.hidden = false;
        goBtn.textContent = english() ? "Generate prep checklist" : "整理本週活動準備清單";
      }
      if (uploadBtn) {
        uploadBtn.textContent = week.folder_id
          ? (english() ? "Upload activity files" : "上傳活動相關資料")
          : (english() ? "Create folder & upload" : "為此週建立分類並上傳");
      }
    } else {
      $("week-preview-kicker").textContent = english()
        ? `${week.label} · Slides not uploaded yet`
        : `${week.label} · 尚缺講義`;
      $("week-preview-desc").textContent =
        topicsText || objText || (english()
          ? "Preview the core ideas from the syllabus before class."
          : "這週尚未匯入課程講義，可先請 BIIBO 依課綱帶你預習核心觀念。");
      if (goBtn) {
        goBtn.hidden = false;
        goBtn.textContent = english() ? "Preview this week's core concepts" : "先幫我預習本週核心觀念";
      }
      if (uploadBtn) {
        uploadBtn.textContent = english() ? "Upload week slides" : "上傳本週講義";
      }
    }

    banner.hidden = false;
    (goBtn && !goBtn.hidden ? goBtn : uploadBtn)?.focus();
  }

  function hideWeekPreviewBanner() {
    activePreviewWeek = null;
    const banner = $("week-preview-banner");
    if (banner) banner.hidden = true;
  }

  async function runWeekPreview() {
    if (!activePreviewWeek) return;
    const week = activePreviewWeek;
    if ((week.week_type || "lecture") === "holiday") {
      if (coursePlan?.overview_document_id) {
        hideWeekPreviewBanner();
        await openDocument(coursePlan.overview_document_id);
      }
      return;
    }

    const btn = $("week-preview-go");
    const status = $("chat-status");
    if (btn) btn.disabled = true;
    if (status) {
      const actionLabel = week.week_type === "exam"
        ? (english() ? `BIIBO is building an exam review plan for ${week.label}…` : `BIIBO 正在幫你規劃 ${week.label} 考前複習重點…`)
        : week.week_type === "activity"
          ? (english() ? `BIIBO is preparing a checklist for ${week.label}…` : `BIIBO 正在幫你整理 ${week.label} 活動準備清單…`)
          : (english() ? `BIIBO is preparing a preview for ${week.label}…` : `BIIBO 正在幫你整理 ${week.label} 預習重點…`);
      status.textContent = actionLabel;
    }

    try {
      const reply = await post("/api/syllabus/preview", {
        week_number: week.week_number,
        conversation_id: state.conversation || null
      });
      state.conversation = reply.conversation_id;
      state.turns = await get(`/api/conversations/${encodeURIComponent(state.conversation)}`);
      await refreshChats();
      showTurns();
      hideWeekPreviewBanner();
      if (status) status.textContent = "";
    } catch (error) {
      if (status) status.textContent = "";
      report(error, "目前尚未連線到本機 Ollama 服務，請確認 Ollama 已啟動後再試。");
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function openUploadForActiveWeek() {
    if (!activePreviewWeek) {
      openImportDialog("course", "");
      return;
    }
    const week = activePreviewWeek;
    let folderId = week.folder_id || "";
    if (!folderId) {
      const uploadBtn = $("week-preview-upload");
      if (uploadBtn) uploadBtn.disabled = true;
      try {
        const res = await post(`/api/syllabus/weeks/${encodeURIComponent(week.week_number)}/folder`, {});
        folderId = res.folder_id || "";
        if (res.plan) {
          coursePlan = res.plan;
          activePreviewWeek = coursePlan.weeks.find(w => w.week_number === week.week_number) || week;
        }
        await refreshDocuments();
        renderSyllabusPanel();
        if (activePreviewWeek) showWeekPreviewBanner(activePreviewWeek);
      } catch (error) {
        report(error, "無法為此週建立分類資料夾，請稍後再試。");
        return;
      } finally {
        if (uploadBtn) uploadBtn.disabled = false;
      }
    }
    openImportDialog("course", folderId);
  }

  window.refreshSyllabusPlan = async () => {
    try {
      const data = await get("/api/syllabus/plan");
      coursePlan = data?.plan || null;
      renderSyllabusPanel();
    } catch {
      // Ignore silent refresh error on startup.
    }
  };

  function updateSyllabusFileLabel() {
    const meta = $("syllabus-file-name");
    const file = $("syllabus-file")?.files?.[0] || pastedSyllabusImage;
    if (!meta) return;
    if (file) {
      meta.textContent = pastedSyllabusImage && !$("syllabus-file")?.files?.[0]
        ? (english() ? `Clipboard image: ${file.name}` : `已貼上剪貼簿圖片：${file.name}`)
        : file.name;
    } else {
      meta.textContent = english()
        ? "Supports PDF, PNG/JPG/WebP images, Markdown, TXT"
        : "支援 PDF、PNG/JPG/WebP 截圖、Markdown、TXT";
    }
  }

  function openSyllabusDialog() {
    $("syllabus-form").reset();
    clearSyllabusImagePreview(false);
    $("syllabus-status").textContent = "";
    $("syllabus-stages").hidden = true;
    for (const li of $("syllabus-stages").querySelectorAll("li")) {
      li.classList.remove("is-active", "is-done");
    }
    updateSyllabusFileLabel();
    $("syllabus-dialog").showModal();
  }

  function setSyllabusStage(stageNum) {
    const list = $("syllabus-stages");
    if (!list) return;
    list.hidden = false;
    for (const li of list.querySelectorAll("li")) {
      const n = Number(li.dataset.stage);
      li.classList.toggle("is-done", n < stageNum);
      li.classList.toggle("is-active", n === stageNum);
    }
  }

  $("syllabus-open")?.addEventListener("click", openSyllabusDialog);
  $("syllabus-dialog")?.addEventListener("close", () => {
    clearSyllabusImagePreview(false);
  });

  $("syllabus-file")?.addEventListener("change", () => {
    const file = $("syllabus-file")?.files?.[0];
    pastedSyllabusImage = null;
    if (file && isSyllabusImageFile(file)) {
      showSyllabusImagePreview(file, "file");
    } else {
      clearSyllabusImagePreview(false);
    }
    updateSyllabusFileLabel();
    $("syllabus-status").textContent = "";
  });

  $("syllabus-preview-clear")?.addEventListener("click", () => {
    clearSyllabusImagePreview(true);
    $("syllabus-status").textContent = "";
  });

  $("syllabus-dialog")?.addEventListener("paste", event => {
    const items = event.clipboardData?.items;
    if (!items || !items.length) return;
    for (const item of items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const imgFile = item.getAsFile();
        if (imgFile) {
          event.preventDefault();
          attachClipboardImage(imgFile);
          return;
        }
      }
    }
  });

  $("syllabus-paste-btn")?.addEventListener("click", async () => {
    const status = $("syllabus-status");
    if (!navigator.clipboard?.read) {
      status.textContent = english()
        ? "Press Ctrl+V (or Cmd+V) directly inside this window to paste a clipboard image."
        : "請直接在此視窗按下 Ctrl+V（Mac 為 Cmd+V）貼上剪貼簿圖片。";
      $("syllabus-text")?.focus();
      return;
    }
    try {
      const clipItems = await navigator.clipboard.read();
      for (const item of clipItems) {
        const imgType = item.types.find(t => t.startsWith("image/"));
        if (imgType) {
          const blob = await item.getType(imgType);
          attachClipboardImage(blob);
          return;
        }
      }
      status.textContent = english()
        ? "No image found in clipboard. Copy a screenshot first, then paste."
        : "剪貼簿中沒有圖片，請先截圖或複製圖片後再試。";
    } catch {
      status.textContent = english()
        ? "Clipboard access requires keyboard paste: press Ctrl+V (or Cmd+V) here."
        : "瀏覽器限制直接讀取剪貼簿，請直接按下 Ctrl+V（Mac 為 Cmd+V）貼上圖片。";
      $("syllabus-text")?.focus();
    }
  });

  const syllabusDropzone = $("syllabus-dropzone");
  if (syllabusDropzone) {
    let depth = 0;
    syllabusDropzone.addEventListener("dragenter", e => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      depth++;
      syllabusDropzone.classList.add("is-dragover");
    });
    syllabusDropzone.addEventListener("dragover", e => {
      if (!e.dataTransfer?.types?.includes("Files")) return;
      e.preventDefault();
      syllabusDropzone.classList.add("is-dragover");
    });
    syllabusDropzone.addEventListener("dragleave", () => {
      depth = Math.max(0, depth - 1);
      if (!depth) syllabusDropzone.classList.remove("is-dragover");
    });
    syllabusDropzone.addEventListener("drop", e => {
      e.preventDefault();
      depth = 0;
      syllabusDropzone.classList.remove("is-dragover");
      const file = [...(e.dataTransfer?.files || [])].find(
        f => /\.(pdf|md|txt|png|jpe?g|webp|gif)$/i.test(f.name) || (f.type && f.type.startsWith("image/"))
      );
      if (!file) {
        $("syllabus-status").textContent = english()
          ? "Only PDF, images (PNG/JPG/WebP/GIF), Markdown, or TXT are supported."
          : "僅支援 PDF、圖片（PNG/JPG/WebP/GIF）、Markdown 或 TXT 檔案。";
        return;
      }
      pastedSyllabusImage = null;
      const dt = new DataTransfer();
      dt.items.add(file);
      $("syllabus-file").files = dt.files;
      if (isSyllabusImageFile(file)) {
        showSyllabusImagePreview(file, "file");
      } else {
        clearSyllabusImagePreview(false);
      }
      updateSyllabusFileLabel();
      $("syllabus-status").textContent = "";
    });
  }

  $("syllabus-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const selectedFile = $("syllabus-file")?.files?.[0] || null;
    const activeFile = selectedFile || pastedSyllabusImage;
    const text = ($("syllabus-text")?.value || "").trim();
    const status = $("syllabus-status");
    const submitBtn = $("syllabus-submit");

    if (!activeFile && !text) {
      status.textContent = english()
        ? "Please upload a syllabus file/image, paste a screenshot, or enter text."
        : "請先上傳課綱檔案／截圖、貼上剪貼簿圖片，或貼上課程大綱文字。";
      return;
    }

    submitBtn.disabled = true;
    setSyllabusStage(1);
    const isImageOrPdf = activeFile && (isSyllabusImageFile(activeFile) || /\.pdf$/i.test(activeFile.name || ""));
    status.textContent = isImageOrPdf
      ? (english()
        ? "BIIBO is reading your syllabus and building the weekly plan…"
        : "BIIBO 正在讀取課綱內容並建立每週規劃…")
      : (english()
        ? "BIIBO is analyzing your syllabus and building the weekly plan…"
        : "BIIBO 正在分析課綱並建立每週規劃…");

    const stageTimer = window.setTimeout(() => setSyllabusStage(2), 2000);

    try {
      let result;
      if (activeFile) {
        const form = new FormData();
        form.append("file", activeFile, activeFile.name || "syllabus.png");
        if (text) form.append("text", text);
        const res = await api("/api/syllabus/plan", { method: "POST", body: form });
        result = await parseJson(res, "/api/syllabus/plan");
      } else {
        result = await post("/api/syllabus/plan", { text, name: english() ? "Pasted Syllabus" : "課程大綱" });
      }

      window.clearTimeout(stageTimer);
      setSyllabusStage(3);
      coursePlan = result.plan;
      syllabusOpenState = true;
      try {
        saveLocal("biibo-syllabus-open", true);
        const groups = readLocal("biibo-groups-expanded", ["course", "personal"]);
        const nextGroups = [...new Set([...groups, "course", "personal"])];
        saveLocal("biibo-groups-expanded", nextGroups);
      } catch { /* ignore */ }

      await refreshDocuments();
      renderSyllabusPanel();

      const folderTotal = (result.created_folders?.length || 0) + (result.reused_folders?.length || 0);
      const skippedCount = Number(result.skipped_non_material_weeks || 0);
      let summaryMsg;
      if (result.overview_update_mode === "appended") {
        summaryMsg = english()
          ? `Prepared ${folderTotal} lecture folder(s)${skippedCount ? ` (skipped ${skippedCount} holiday/exam/activity week(s))` : ""} and appended updates to your edited overview note.`
          : `已整理 ${folderTotal} 堂授課分類${skippedCount ? `、略過 ${skippedCount} 週假／考／活動週` : ""}，並保留原有總覽筆記於文末附加更新。`;
      } else {
        summaryMsg = english()
          ? `Created/matched ${folderTotal} lecture folder(s)${skippedCount ? `, flexibly skipped ${skippedCount} non-lecture week(s),` : ""} and pinned your course overview note.`
          : `已為 ${folderTotal} 堂授課週建立分類${skippedCount ? `、彈性略過 ${skippedCount} 週假／考／活動週` : ""}，並置頂課程總覽筆記。`;
      }

      status.textContent = summaryMsg;
      window.setTimeout(() => {
        if ($("syllabus-dialog").open) $("syllabus-dialog").close();
      }, 1100);
    } catch (error) {
      window.clearTimeout(stageTimer);
      $("syllabus-stages").hidden = true;
      status.textContent = friendlyError(
        error,
        "無法完成課綱規劃，請確認本機 MinerU 與 Ollama 服務狀態後再試。"
      );
    } finally {
      submitBtn.disabled = false;
    }
  });

  $("week-preview-close")?.addEventListener("click", hideWeekPreviewBanner);
  $("week-preview-go")?.addEventListener("click", () => runWeekPreview().catch(report));
  $("week-preview-upload")?.addEventListener("click", () => openUploadForActiveWeek().catch(report));

  // ============================================================
  // Smart Week Folder Recommendation on Material Import
  // ============================================================
  window.recommendImportFolder = async (filename, previewText = "") => {
    const box = $("import-folder-rec");
    const select = $("import-folder");
    if (!box || !select) return;
    box.hidden = true;
    box.replaceChildren();
    try {
      const data = await post("/api/syllabus/recommend-folder", {
        filename,
        preview: previewText.slice(0, 800)
      });
      const rec = data?.recommendation;
      if (!rec || !rec.folder_id) return;
      if (![...select.options].some(o => o.value === rec.folder_id)) return;

      // Auto-select if user hasn't manually chosen a folder yet.
      if (!select.value) {
        select.value = rec.folder_id;
      }

      const textSpan = element(
        "span",
        english()
          ? `Recommended folder: ${rec.folder_name} (${rec.reason})`
          : `推薦歸檔至：${rec.folder_name}（${rec.reason}）`,
        "import-folder-rec-text"
      );
      const applyBtn = button(
        select.value === rec.folder_id
          ? (english() ? "Clear" : "改回未分類")
          : (english() ? "Apply" : "套用推薦"),
        () => {
          if (select.value === rec.folder_id) {
            select.value = "";
            applyBtn.textContent = english() ? "Apply" : "套用推薦";
          } else {
            select.value = rec.folder_id;
            applyBtn.textContent = english() ? "Clear" : "改回未分類";
          }
        },
        "import-folder-rec-btn"
      );
      box.replaceChildren(textSpan, applyBtn);
      box.hidden = false;
    } catch {
      // Optional recommendation; never block upload.
    }
  };

  // ============================================================
  // Feature 2: BIIBO Note Draft (Markdown + LaTeX + Tables)
  // ============================================================
  function setDraftScope(scope) {
    draftScope = scope === "full" ? "full" : "page";
    for (const btn of document.querySelectorAll("[data-draft-scope]")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.draftScope === draftScope));
    }
  }

  function setDraftView(mode) {
    draftViewMode = mode === "raw" ? "raw" : "rendered";
    for (const btn of document.querySelectorAll("[data-draft-view]")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.draftView === draftViewMode));
    }
    $("draft-preview-rendered").hidden = draftViewMode === "raw";
    $("draft-preview-raw").hidden = draftViewMode !== "raw";
  }

  function toggleDraftDrawer(forceOpen) {
    const drawer = $("note-draft-drawer");
    const toggleBtn = $("note-draft-toggle");
    if (!drawer || !toggleBtn) return;
    const nextOpen = typeof forceOpen === "boolean" ? forceOpen : drawer.hidden;
    drawer.hidden = !nextOpen;
    toggleBtn.setAttribute("aria-expanded", String(nextOpen));
    if (nextOpen) {
      syncContextLabels();
      $("draft-status").textContent = "";
    }
  }

  async function runNoteDraft() {
    if (draftBusy) return;
    const doc = activeReadableDoc();
    const status = $("draft-status");
    if (!doc) {
      status.textContent = english()
        ? "Open a course material in the center reader first."
        : "請先在中間閱讀器開啟一份教材，再請 BIIBO 幫你擬定草稿。";
      return;
    }

    const scope = doc.kind === "pdf" ? draftScope : "full";
    const page = scope === "page" ? currentPdfPage() : null;
    const style = $("draft-style")?.value || "structured";

    draftBusy = true;
    $("draft-generate-btn").disabled = true;
    $("draft-regenerate").disabled = true;
    status.textContent = english()
      ? "BIIBO is drafting Markdown + LaTeX notes for you…"
      : "BIIBO 正在閱讀教材並以 Markdown / LaTeX / 表格擬定草稿…";

    try {
      const result = await post("/api/notes/draft", {
        document_id: doc.id,
        scope,
        page,
        style
      });
      currentDraft = result;
      $("draft-preview-rendered").innerHTML = result.html;
      math($("draft-preview-rendered"));
      $("draft-preview-raw").textContent = result.markdown;

      const pagesDesc = result.scope === "page"
        ? (english() ? `Page ${result.page}` : `第 ${result.page} 頁`)
        : result.total_pages > result.sampled_pages.length
          ? (english()
            ? `Sampled ${result.sampled_pages.length} of ${result.total_pages} pages (P.${result.sampled_pages.join(", ")})`
            : `整份教材（共 ${result.total_pages} 頁，均勻抽樣 P.${result.sampled_pages.join("、")}）`)
          : (english()
            ? `Full material (${result.total_pages} pages)`
            : `整份教材（共 ${result.total_pages} 頁）`);

      $("draft-preview-meta").textContent = `${doc.name} · ${pagesDesc}`;
      $("note-draft-preview-wrap").hidden = false;
      setDraftView("rendered");
      status.textContent = "";
    } catch (error) {
      status.textContent = friendlyError(
        error,
        "目前尚未連線到本機 Ollama 服務，請確認 Ollama 已啟動後再試。"
      );
    } finally {
      draftBusy = false;
      $("draft-generate-btn").disabled = false;
      $("draft-regenerate").disabled = false;
    }
  }

  $("note-draft-toggle")?.addEventListener("click", () => toggleDraftDrawer());
  for (const btn of document.querySelectorAll("[data-draft-scope]")) {
    btn.addEventListener("click", () => setDraftScope(btn.dataset.draftScope));
  }
  for (const btn of document.querySelectorAll("[data-draft-view]")) {
    btn.addEventListener("click", () => setDraftView(btn.dataset.draftView));
  }
  $("draft-generate-btn")?.addEventListener("click", () => runNoteDraft().catch(report));
  $("draft-regenerate")?.addEventListener("click", () => runNoteDraft().catch(report));
  $("draft-insert-cursor")?.addEventListener("click", () => {
    if (!currentDraft?.markdown) return;
    if (typeof window.insertIntoPersonalNote === "function") {
      window.insertIntoPersonalNote(currentDraft.markdown, "cursor");
    }
    $("note-draft-preview-wrap").hidden = true;
    toggleDraftDrawer(false);
    $("note-status").textContent = english()
      ? "Draft inserted at cursor. Remember to save."
      : "已將草稿插入游標位置，記得點擊「儲存筆記」。";
  });
  $("draft-append-end")?.addEventListener("click", () => {
    if (!currentDraft?.markdown) return;
    if (typeof window.insertIntoPersonalNote === "function") {
      window.insertIntoPersonalNote(currentDraft.markdown, "append");
    }
    $("note-draft-preview-wrap").hidden = true;
    toggleDraftDrawer(false);
    $("note-status").textContent = english()
      ? "Draft appended to note. Remember to save."
      : "已將草稿附加到筆記尾端，記得點擊「儲存筆記」。";
  });
  $("draft-discard")?.addEventListener("click", () => {
    currentDraft = null;
    $("note-draft-preview-wrap").hidden = true;
    toggleDraftDrawer(false);
  });

  // ============================================================
  // Feature 3: PDF Self-Test Q&A Focus Modal + Pause Bar + Auto-Collapse
  // ============================================================
  function clearQuizAutoClose() {
    window.clearTimeout(quizState.autoCloseTimer);
    window.clearInterval(quizState.autoCloseInterval);
    quizState.autoCloseTimer = 0;
    quizState.autoCloseInterval = 0;
    const bar = $("quiz-autoclose-bar");
    if (bar) bar.hidden = true;
  }

  function setQuizScope(scope) {
    quizState.scope = scope === "full" ? "full" : "page";
    for (const btn of document.querySelectorAll("[data-quiz-scope]")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.quizScope === quizState.scope));
    }
  }

  function setQuizCount(count) {
    quizState.count = Number(count) === 5 ? 5 : 3;
    for (const btn of document.querySelectorAll("[data-quiz-count]")) {
      btn.setAttribute("aria-pressed", String(Number(btn.dataset.quizCount) === quizState.count));
    }
  }

  function showQuizView(view) {
    $("quiz-setup").hidden = view !== "setup";
    $("quiz-loading").hidden = view !== "loading";
    $("quiz-stage").hidden = view !== "stage";
    $("quiz-summary").hidden = view !== "summary";
  }

  function hidePausedBar() {
    quizState.paused = false;
    const bar = $("quiz-paused-bar");
    if (bar) bar.hidden = true;
  }

  function showPausedBar() {
    quizState.paused = true;
    const bar = $("quiz-paused-bar");
    if (!bar) return;
    const idx = Math.min(quizState.index + 1, quizState.questions.length);
    const total = quizState.questions.length;
    $("quiz-paused-text").textContent = english()
      ? `Quiz paused (${idx}/${total}) · Click to continue`
      : `測驗暫停中（第 ${idx} / ${total} 題）· 點此繼續`;
    bar.hidden = false;
  }

  function resetQuizSession() {
    clearQuizAutoClose();
    hidePausedBar();
    quizState.questions = [];
    quizState.index = 0;
    quizState.answers = [];
    quizState.hintsShown = [];
    $("quiz-status").textContent = "";
    showQuizView("setup");
  }

  function openQuizDialog() {
    const doc = activeReadableDoc();
    if (!doc) {
      report("請先從教材庫選擇一份教材。");
      return;
    }

    // Resume seamlessly if paused on the same document.
    if (quizState.paused && quizState.docId === doc.id && quizState.questions.length) {
      hidePausedBar();
      $("quiz-doc-name").textContent = quizState.docName;
      showQuizView("stage");
      renderCurrentQuestion();
      $("quiz-dialog").showModal();
      return;
    }

    clearQuizAutoClose();
    quizState.docId = doc.id;
    quizState.docName = doc.name;
    $("quiz-doc-name").textContent = doc.name;
    syncContextLabels();

    if (quizState.questions.length && quizState.docId === doc.id && quizState.answers.some(a => a === null)) {
      showQuizView("stage");
      renderCurrentQuestion();
    } else {
      resetQuizSession();
    }
    $("quiz-dialog").showModal();
  }

  async function startQuizGeneration() {
    if (quizState.busy) return;
    const doc = activeReadableDoc();
    if (!doc) return;

    quizState.docId = doc.id;
    quizState.docName = doc.name;
    const scope = doc.kind === "pdf" ? quizState.scope : "full";
    const page = scope === "page" ? currentPdfPage() : null;

    quizState.busy = true;
    clearQuizAutoClose();
    hidePausedBar();
    $("quiz-status").textContent = "";
    $("quiz-loading-text").textContent = quizState.count === 5
      ? (english()
        ? "BIIBO is reading the material and preparing 5 self-test questions…"
        : "BIIBO 正在閱讀教材並為你設計 5 題課後自測…")
      : (english()
        ? "BIIBO is reading the material and preparing 3 self-test questions…"
        : "BIIBO 正在閱讀教材並為你設計 3 題課後自測…");
    showQuizView("loading");

    try {
      const data = await post(`/api/documents/${encodeURIComponent(doc.id)}/quiz`, {
        scope,
        page,
        count: quizState.count
      });
      quizState.questions = data.questions || [];
      quizState.index = 0;
      quizState.answers = new Array(quizState.questions.length).fill(null);
      quizState.hintsShown = new Array(quizState.questions.length).fill(false);
      showQuizView("stage");
      renderCurrentQuestion();
    } catch (error) {
      showQuizView("setup");
      $("quiz-status").textContent = friendlyError(
        error,
        "目前尚未連線到本機 Ollama 服務，請確認 Ollama 已啟動後再試。"
      );
    } finally {
      quizState.busy = false;
    }
  }

  function renderCurrentQuestion() {
    const q = quizState.questions[quizState.index];
    if (!q) return;
    const total = quizState.questions.length;
    const answered = quizState.answers[quizState.index];
    const hintShown = quizState.hintsShown[quizState.index];

    $("quiz-progress-label").textContent = english()
      ? `Question ${quizState.index + 1} / ${total}`
      : `第 ${quizState.index + 1} / ${total} 題`;
    $("quiz-concept-label").textContent = q.concept || "";
    $("quiz-progress-fill").style.width = `${Math.round(((quizState.index + 1) / total) * 100)}%`;

    const stemEl = $("quiz-stem");
    stemEl.innerHTML = q.stem_html;
    math(stemEl);

    const optRoot = $("quiz-options");
    optRoot.replaceChildren();
    const letters = ["A", "B", "C", "D"];

    q.options_html.forEach((optHtml, optIdx) => {
      const btn = element("button", undefined, "quiz-option");
      btn.type = "button";
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(answered === optIdx));

      if (answered !== null) {
        btn.disabled = true;
        if (optIdx === q.correct_index) btn.classList.add("is-correct");
        else if (optIdx === answered) btn.classList.add("is-wrong");
      }

      const key = element("span", letters[optIdx], "quiz-option-key");
      const body = element("span", undefined, "quiz-option-body");
      body.innerHTML = optHtml;
      btn.append(key, body);

      if (answered !== null && (optIdx === q.correct_index || optIdx === answered)) {
        const mark = element(
          "span",
          optIdx === q.correct_index ? "✓" : "✕",
          optIdx === q.correct_index ? "quiz-option-mark is-correct" : "quiz-option-mark is-wrong"
        );
        btn.append(mark);
      }

      btn.addEventListener("click", () => selectQuizOption(optIdx));
      optRoot.append(btn);
    });
    math(optRoot);

    const hintBtn = $("quiz-hint-btn");
    const hintBox = $("quiz-hint-box");
    hintBtn.hidden = answered !== null || hintShown;
    hintBox.hidden = !hintShown;
    if (hintShown) {
      hintBox.innerHTML = `<strong>${english() ? "Hint" : "解題提示"}：</strong>` + q.hint_html;
      math(hintBox);
    }

    $("quiz-page-meta").textContent = q.page_ref ? `P.${q.page_ref}` : "";

    const feedback = $("quiz-feedback");
    if (answered !== null) {
      const isRight = answered === q.correct_index;
      feedback.hidden = false;
      feedback.classList.toggle("is-correct", isRight);
      feedback.classList.toggle("is-wrong", !isRight);
      $("quiz-feedback-head").textContent = isRight
        ? (english() ? "✓ Correct — Great grasp of this concept!" : "✓ 答對了！觀念很清楚")
        : (english()
          ? `✕ Not quite — Correct answer is ${letters[q.correct_index]}`
          : `✕ 再核對一下 — 正確答案是 ${letters[q.correct_index]}`);
      const fbBody = $("quiz-feedback-body");
      fbBody.innerHTML = q.explanation_html;
      math(fbBody);

      const jumpBtn = $("quiz-jump-page");
      if (q.page_ref) {
        jumpBtn.hidden = false;
        jumpBtn.textContent = english()
          ? `Jump to P.${q.page_ref} source`
          : `P.${q.page_ref} 原文對照`;
      } else {
        jumpBtn.hidden = true;
      }
    } else {
      feedback.hidden = true;
    }

    const nextBtn = $("quiz-next-btn");
    nextBtn.disabled = answered === null;
    nextBtn.textContent = quizState.index + 1 >= total ? tr("查看結果") : tr("下一題 →");
  }

  function selectQuizOption(optIdx) {
    if (quizState.answers[quizState.index] !== null) return;
    quizState.answers[quizState.index] = optIdx;
    renderCurrentQuestion();
  }

  function jumpToQuizSourcePage() {
    const q = quizState.questions[quizState.index];
    if (!q?.page_ref) return;
    // Refinement #3: Pause quiz into floating bar and preserve progress while jumping PDF reader.
    $("quiz-dialog").close();
    showPausedBar();
    if (window.reader?.doc?.id === quizState.docId && typeof goPage === "function") {
      goPage(q.page_ref);
    } else {
      openDocument(quizState.docId, { page: q.page_ref }).catch(report);
    }
  }

  function formatQuestionAsNoteMarkdown(q, userAnswerIdx) {
    const letters = ["A", "B", "C", "D"];
    const lines = [
      `## ${english() ? "Self-Test Review" : "課後自測重點"} · ${q.concept}`
    ];
    if (q.page_ref) lines.push(`<!-- page: ${q.page_ref} -->`);
    lines.push("", `**Q：** ${q.stem}`, "");
    q.options.forEach((opt, i) => {
      const marker = i === q.correct_index ? "✓" : i === userAnswerIdx ? "✕" : " ";
      lines.push(`- [${marker}] **${letters[i]}.** ${opt}`);
    });
    lines.push("", `> **${english() ? "Explanation" : "解析"}：** ${q.explanation}`);
    return lines.join("\n");
  }

  function clipCurrentQuestionToNotes() {
    const q = quizState.questions[quizState.index];
    if (!q) return;
    const md = formatQuestionAsNoteMarkdown(q, quizState.answers[quizState.index]);
    $("quiz-dialog").close();
    if (quizState.answers.some(a => a === null)) showPausedBar();
    openNotes(quizState.docId, md).catch(report);
  }

  function renderQuizSummary() {
    hidePausedBar();
    showQuizView("summary");
    const total = quizState.questions.length;
    let correct = 0;
    const wrongItems = [];
    quizState.questions.forEach((q, i) => {
      if (quizState.answers[i] === q.correct_index) correct++;
      else wrongItems.push({ q, answer: quizState.answers[i] });
    });

    const pct = total ? Math.round((correct / total) * 100) : 0;
    $("quiz-score-value").textContent = `${correct} / ${total} (${pct}%)`;
    $("quiz-score-desc").textContent =
      correct === total
        ? (english()
          ? "Excellent! You nailed every question in this check."
          : "太棒了！這輪測驗全部答對，核心觀念都掌握得非常穩固。")
        : (english()
          ? `Review the ${wrongItems.length} concept(s) below or ask BIIBO for a guided walkthrough.`
          : `有 ${wrongItems.length} 題可以再複習，建議收入筆記或直接請 BIIBO 針對弱點引導。`);

    const weakWrap = $("quiz-weak-wrap");
    const weakList = $("quiz-weak-list");
    weakList.replaceChildren();
    if (wrongItems.length) {
      weakWrap.hidden = false;
      const seen = new Set();
      for (const item of wrongItems) {
        const key = item.q.concept;
        if (seen.has(key)) continue;
        seen.add(key);
        const li = element("li");
        li.textContent = item.q.page_ref ? `${key} (P.${item.q.page_ref})` : key;
        weakList.append(li);
      }
    } else {
      weakWrap.hidden = true;
    }

    $("quiz-mistakes-note").hidden = wrongItems.length === 0;
    $("quiz-ask-weak").hidden = wrongItems.length === 0;

    // Auto-collapse countdown (3.5s, cancelable).
    clearQuizAutoClose();
    const bar = $("quiz-autoclose-bar");
    const txt = $("quiz-autoclose-text");
    bar.hidden = false;
    quizState.autoCloseRemaining = 4;
    const renderCountdown = () => {
      txt.textContent = english()
        ? `Auto-closing in ${quizState.autoCloseRemaining}s…`
        : `${quizState.autoCloseRemaining} 秒後自動收合回到閱讀器…`;
    };
    renderCountdown();
    quizState.autoCloseInterval = window.setInterval(() => {
      quizState.autoCloseRemaining -= 1;
      if (quizState.autoCloseRemaining > 0) renderCountdown();
    }, 1000);
    quizState.autoCloseTimer = window.setTimeout(() => {
      clearQuizAutoClose();
      if ($("quiz-dialog").open) $("quiz-dialog").close();
    }, 3600);
  }

  $("reader-quiz")?.addEventListener("click", openQuizDialog);
  $("quiz-close-btn")?.addEventListener("click", () => {
    clearQuizAutoClose();
    const hasUnfinished = quizState.questions.length > 0 && !$("quiz-stage").hidden && quizState.answers.some(a => a === null);
    $("quiz-dialog").close();
    if (hasUnfinished) showPausedBar();
  });
  $("quiz-dialog")?.addEventListener("cancel", () => {
    clearQuizAutoClose();
    const hasUnfinished = quizState.questions.length > 0 && !$("quiz-stage").hidden && quizState.answers.some(a => a === null);
    if (hasUnfinished) showPausedBar();
  });

  $("quiz-resume-main")?.addEventListener("click", () => {
    if (!quizState.questions.length) {
      hidePausedBar();
      return;
    }
    hidePausedBar();
    $("quiz-doc-name").textContent = quizState.docName;
    showQuizView("stage");
    renderCurrentQuestion();
    $("quiz-dialog").showModal();
  });
  $("quiz-discard-btn")?.addEventListener("click", () => {
    resetQuizSession();
  });

  for (const btn of document.querySelectorAll("[data-quiz-scope]")) {
    btn.addEventListener("click", () => setQuizScope(btn.dataset.quizScope));
  }
  for (const btn of document.querySelectorAll("[data-quiz-count]")) {
    btn.addEventListener("click", () => setQuizCount(btn.dataset.quizCount));
  }
  $("quiz-start-btn")?.addEventListener("click", () => startQuizGeneration().catch(report));
  $("quiz-hint-btn")?.addEventListener("click", () => {
    quizState.hintsShown[quizState.index] = true;
    renderCurrentQuestion();
  });
  $("quiz-jump-page")?.addEventListener("click", jumpToQuizSourcePage);
  $("quiz-clip-note")?.addEventListener("click", clipCurrentQuestionToNotes);
  $("quiz-reset-btn")?.addEventListener("click", resetQuizSession);
  $("quiz-next-btn")?.addEventListener("click", () => {
    if (quizState.index + 1 >= quizState.questions.length) {
      renderQuizSummary();
    } else {
      quizState.index += 1;
      renderCurrentQuestion();
    }
  });
  $("quiz-stay-btn")?.addEventListener("click", clearQuizAutoClose);
  $("quiz-retry-btn")?.addEventListener("click", () => {
    clearQuizAutoClose();
    resetQuizSession();
  });
  $("quiz-mistakes-note")?.addEventListener("click", () => {
    clearQuizAutoClose();
    const wrongMd = quizState.questions
      .map((q, i) => (quizState.answers[i] !== q.correct_index ? formatQuestionAsNoteMarkdown(q, quizState.answers[i]) : ""))
      .filter(Boolean)
      .join("\n\n---\n\n");
    if (!wrongMd) return;
    $("quiz-dialog").close();
    openNotes(quizState.docId, wrongMd).catch(report);
  });
  $("quiz-ask-weak")?.addEventListener("click", () => {
    clearQuizAutoClose();
    const concepts = [...new Set(
      quizState.questions
        .filter((q, i) => quizState.answers[i] !== q.correct_index)
        .map(q => q.concept)
    )];
    const prompt = english()
      ? `I missed self-test questions on: ${concepts.join(", ")}. Can you explain these concepts with a simple example?`
      : `我剛剛在課後自測中對「${concepts.join("、")}」還不夠熟悉，可以幫我重新釐清這些概念並舉個短例子嗎？`;
    $("quiz-dialog").close();
    if (typeof window.setRightPaneTab === "function") window.setRightPaneTab("tutor", true);
    const box = $("question");
    if (box) {
      box.value = prompt;
      box.focus();
      $("ask").requestSubmit($("send"));
    }
  });

  // ============================================================
  // Init & Language Sync
  // ============================================================
  document.addEventListener("aita-language", () => {
    renderSyllabusPanel();
    syncContextLabels();
    updateSyllabusFileLabel();
    if (activePreviewWeek) showWeekPreviewBanner(activePreviewWeek);
    if (quizState.paused) showPausedBar();
  });

  window.refreshSyllabusPlan();
})();
