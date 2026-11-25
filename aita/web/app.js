"use strict";
const $ = id => document.getElementById(id);
const state = {
  documents: [],
  folders: [],
  chats: [],
  records: [],
  conversation: "",
  document: "",
  selected: "",
  turns: [],
  provider: "ollama",
  modelName: "",
  modelOnline: null,
  engines: [],
  draftProvider: "ollama",
  draftGroup: "local"
};
const labels = {pdf:"原始 PDF",note:"課程筆記",personal:"個人筆記",text:"文字教材"};
const modes = {hint:"先給提示",concept:"解釋概念",debug:"協助除錯"};
const json = data => ({headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});

const technicalErrorPattern = /unexpected token|not valid json|<!doctype|<html|syntaxerror|typeerror|referenceerror|failed to fetch|networkerror|load failed|econnrefused|enotfound|etimedout|aborterror|cannot read propert|undefined is not|json\.parse|fetch failed/i;

function friendlyError(error, fallback = "操作暫時無法完成，請稍後再試。") {
  const raw = typeof error === "string" ? error : (error?.message || "");
  const clean = raw.trim();
  if (!clean || technicalErrorPattern.test(clean)) return tr(fallback);
  if (typeof uiStrings === "object" && (uiStrings[clean] || Object.values(uiStrings).includes(clean))) {
    return tr(clean);
  }
  if (/[\u4e00-\u9fff]/.test(clean) && !/(error|exception|stack|sqlite|http\s*\d{3})/i.test(clean)) {
    return tr(clean);
  }
  return tr(fallback);
}

async function api(url, options) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw Error(tr("無法連線到伺服器，請確認網路與本機服務是否正常運作。"));
  }
  if (!response.ok) {
    const contentType = response.headers.get("content-type") || "";
    const error = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : {};
    const detail = typeof error.detail === "string" ? error.detail.trim() : "";
    if (detail && !technicalErrorPattern.test(detail)) {
      throw Error(friendlyError(detail));
    }
    if ([502, 503, 504].includes(response.status)) {
      if (
        url.includes("/models") ||
        url.includes("/engines") ||
        url.includes("/ask") ||
        url.includes("/syllabus") ||
        url.includes("/notes/draft") ||
        url.includes("/quiz")
      ) {
        throw Error(tr("目前無法連線至所選的模型引擎，請至「助教設定」確認服務狀態或切換其他引擎。"));
      }
      throw Error(tr("服務暫時忙碌或無法連線，請稍後再試。"));
    }
    if (response.status === 404) throw Error(tr("找不到對應的教材或資料，請重新整理後再試。"));
    if (response.status === 413) throw Error(tr("檔案大小超過上限，請選擇較小的檔案後再試。"));
    if (response.status === 400 || response.status === 422) throw Error(tr("輸入內容或檔案格式不正確，請確認後再試。"));
    throw Error(tr("系統處理時發生暫時性問題，請稍後再試。"));
  }
  return response;
}

async function parseJson(response, url) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw Error(tr(url.includes("/models")
      ? "目前無法取得本機 Ollama 模型清單，請確認本機服務已啟動。"
      : "伺服器回應格式異常，請稍後再試或重新整理頁面。"));
  }
  try {
    return await response.json();
  } catch {
    throw Error(tr(url.includes("/models")
      ? "目前無法取得本機 Ollama 模型清單，請確認本機服務已啟動。"
      : "伺服器回應格式異常，請稍後再試或重新整理頁面。"));
  }
}

const get = async url => parseJson(await api(url), url);
const post = async (url, data) => parseJson(await api(url, {method:"POST",...json(data)}), url);
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className) {
  const b = element("button",text,className);
  b.type = "button";
  b.addEventListener("click",() => Promise.resolve().then(action).catch(report));
  return b;
}
let errorTimer;
function report(error, fallback) {
  window.clearTimeout(errorTimer);
  const banner = $("error");
  banner.textContent = friendlyError(error, fallback);
  banner.hidden = false;
  errorTimer = window.setTimeout(() => { banner.hidden = true; }, 6500);
}
$("error").addEventListener("click", () => { $("error").hidden = true; });
function math(container) {
  if (!window.katex) return;
  for (const node of container.querySelectorAll(".math")) {
    window.katex.render(node.textContent.trim(),node,{displayMode:node.classList.contains("block"),throwOnError:false,trust:false});
  }
}
function setSelection(value, description = "") {
  state.selected = value;
  $("selection").hidden = !value;
  $("selection-text").textContent = description;
  syncSelection();
}
async function refreshDocuments() {
  [state.documents,state.folders] = await Promise.all([get("/api/documents"),get("/api/folders")]);
  state.documentsReady = true;
  const source = $("original").value;
  $("original").replaceChildren(new Option(tr("一般教材")));
  $("original").options[0].value = "";
  for (const d of state.documents.filter(d => d.kind === "pdf")) $("original").add(new Option(d.name,d.id));
  if ([...$("original").options].some(o => o.value === source)) $("original").value = source;
  renderMaterials();
  renderLibrary();
  renderPromptChips();
  if (typeof window.refreshSyllabusPlan === "function") window.refreshSyllabusPlan().catch(() => {});
}

function suggestedQuestions() {
  const active = window.reader?.doc || state.documents[0] || null;
  if (active?.name) {
    const clean = active.name.replace(/\.(pdf|md|txt)$/i, "").trim();
    const title = clean.length > 34 ? clean.slice(0, 34) + "…" : clean;
    if (english()) {
      return [
        `Summarize the key concepts and structure of "${title}".`,
        `What are the common misconceptions or tricky points in "${title}"?`,
        `Give me 3 practice questions to check my understanding of "${title}".`
      ];
    }
    return [
      `幫我整理《${title}》的核心重點與觀念脈絡`,
      `《${title}》中有哪些容易混淆的概念或常見錯誤？`,
      `根據《${title}》出 3 題練習題幫我檢核理解程度`
    ];
  }
  if (english()) {
    return [
      "Why should we not estimate missing value imputations from the validation set?",
      "How can I tell if my model is overfitting vs. underfitting?",
      "Explain cross-validation intuitively with a simple example."
    ];
  }
  return [
    "為什麼驗證集不能用來估計填補值？",
    "要如何判斷模型出現過擬合（Overfitting）還是欠擬合？",
    "請用簡單的例子解釋交叉驗證（Cross-validation）的原理"
  ];
}

function renderPromptChips() {
  const container = $("prompt-chips");
  if (!container) return;
  container.replaceChildren();
  for (const prompt of suggestedQuestions()) {
    const chip = element("button", prompt, "prompt-chip");
    chip.type = "button";
    chip.addEventListener("click", () => {
      const box = $("question");
      box.value = prompt;
      box.focus();
      $("ask").requestSubmit($("send"));
    });
    container.append(chip);
  }
}

function createMascotVideo(src, poster, altLabel) {
  const video = element("video", undefined, "mascot-video");
  video.autoplay = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.poster = poster;
  if (altLabel) video.setAttribute("aria-label", altLabel);
  const source = element("source");
  source.src = src;
  source.type = "video/mp4";
  video.append(source);
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    video.autoplay = false;
  }
  return video;
}

function showTurns() {
  const area = $("turns");
  area.replaceChildren();
  if (!state.turns.length) {
    const welcome = element("div", undefined, "empty-chat-card");
    const art = element("div", undefined, "empty-art empty-art-tutor");
    art.append(createMascotVideo("/static/assets/biibo-tutor-welcome.mp4?v=3", "/static/assets/biibo-tutor-welcome.jpg", "BIIBO"));
    const chips = element("div", undefined, "prompt-chips");
    chips.id = "prompt-chips";
    chips.setAttribute("role", "group");
    chips.setAttribute("aria-label", tr("建議提問"));
    welcome.append(
      art,
      element("h3", tr("開始與 BIIBO 一起學習")),
      element("p", tr("這裡會顯示你的提問、助教回覆與來源。也可以先從教材選一段。"), "empty-chat"),
      chips
    );
    area.append(welcome);
    renderPromptChips();
  }
  for (const turn of state.turns) {
    const w = element("div", undefined, "turn");
    const userBox = element("div", undefined, "turn-user");
    userBox.append(element("h3", tr("你")), element("p", turn.question));
    const tutorBox = element("div", undefined, "turn-tutor");
    const tutorHead = element("div", undefined, "turn-tutor-head");
    const avatar = element("img", undefined, "turn-avatar");
    avatar.src = "/static/assets/biibo-mascot.png";
    avatar.alt = "";
    avatar.referrerPolicy = "no-referrer";
    avatar.addEventListener("error", () => { avatar.style.display = "none"; });
    tutorHead.append(avatar, element("h3", "BIIBO"));
    const answer = element("div", undefined, "turn-answer");
    answer.innerHTML = turn.html;
    tutorBox.append(tutorHead, answer);
    if (turn.citations?.length) {
      const sources = element("div", undefined, "sources");
      for (const c of turn.citations) {
        const location = c.page ? "PDF " + pageLabel(c.page) : tr("教材段落");
        const label = c.document_kind === "personal" ? tr("個人筆記") + " · " + location : location;
        sources.append(button(c.label + " · " + label, () => openDocument(c.document_id, c)));
      }
      const citation = turn.citations.find(c => c.source_id && (c.page || ["pdf", "note", "personal"].includes(c.document_kind)));
      sources.append(button(tr("加入到筆記"), () => noteFromTurn(turn, citation)));
      tutorBox.append(sources);
      const detail = element("details");
      detail.append(element("summary", tr("查看引用的內容")));
      for (const c of turn.citations) {
        const title = c.document_name && c.document_name !== c.source_name ? `${c.document_name} · ${c.source_name}` : c.source_name;
        detail.append(element("p", c.label + " · " + title), element("blockquote", c.excerpt));
      }
      tutorBox.append(detail);
    }
    if (turn.retrieved_evidence?.length) {
      const detail = element("details");
      detail.append(element("summary", english() ? "View retrieved excerpts" : "查看檢索段落"));
      for (const c of turn.retrieved_evidence) {
        const location = c.page ? `${c.source_name} · ${pageLabel(c.page)}` : c.document_name;
        detail.append(button(location, () => openDocument(c.document_id, c)), element("blockquote", c.excerpt));
      }
      tutorBox.append(detail);
    }
    if (turn.status !== "imported") tutorBox.append(element("div",
      [tr(modes[turn.mode]), turn.retriever, turn.latency_ms == null ? "" : (turn.latency_ms / 1000).toFixed(2) + (english() ? " s" : " 秒")].filter(Boolean).join(" · "), "meta"));
    if (turn.warning) tutorBox.append(element("p", tr(turn.warning), "alert"));
    if (!turn.citations?.length && turn.status === "answered") tutorBox.append(button(tr("加入到筆記"), () => noteFromTurn(turn), "turn-note"));
    w.append(userBox, tutorBox);
    area.append(w);
  }
  math(area);
  area.scrollTop = area.scrollHeight;
}
async function refreshChats() {
  state.chats = await get("/api/conversations");
  $("chats").replaceChildren(new Option(tr("新對話"),""),...state.chats.map(c => new Option(c.title,c.id)));
  $("chats").value = state.conversation;
}
async function changeChat(key) {
  state.conversation = key;
  state.turns = key ? await get("/api/conversations/" + key) : [];
  $("chats").value = key;
  setSelection("");
  showTurns();
}
function bindForm(id, listener, status, fallback = "操作暫時無法完成，請稍後再試。") {
  $(id).addEventListener("submit",async e => {
    e.preventDefault();
    const submit = e.submitter;
    if (!submit || submit.disabled) return;
    submit.disabled = true;
    $(status).textContent = "";
    try { await listener(); } catch (error) { $(status).textContent = friendlyError(error, fallback); }
    finally { submit.disabled = false; }
  });
}
$("chats").addEventListener("change",() => changeChat($("chats").value).catch(report));
$("new-chat").addEventListener("click",() => changeChat("").catch(report));
$("clear-selection").addEventListener("click",() => setSelection(""));

function mountPendingTurn(questionText) {
  const area = $("turns");
  area.querySelector(".empty-chat-card")?.remove();
  const pending = element("div", undefined, "turn turn-pending");
  const userBox = element("div", undefined, "turn-user");
  userBox.append(element("h3", tr("你")), element("p", questionText));
  const tutorBox = element("div", undefined, "turn-tutor");
  const tutorHead = element("div", undefined, "turn-tutor-head");
  const avatar = element("img", undefined, "turn-avatar");
  avatar.src = "/static/assets/biibo-mascot.png";
  avatar.alt = "";
  avatar.referrerPolicy = "no-referrer";
  avatar.addEventListener("error", () => { avatar.style.display = "none"; });
  tutorHead.append(avatar, element("h3", "BIIBO"));
  const stages = element("div", undefined, "thinking-stages");
  const mascotFrame = element("div", undefined, "thinking-mascot-frame");
  mascotFrame.setAttribute("aria-hidden", "true");
  mascotFrame.append(createMascotVideo("/static/assets/biibo-tutor-thinking.mp4?v=2", "/static/assets/biibo-tutor-thinking.jpg"));
  const stageBody = element("div", undefined, "thinking-stage-body");
  const dots = element("span", undefined, "thinking-dots");
  dots.setAttribute("aria-hidden", "true");
  dots.append(element("span"), element("span"), element("span"));
  const stageLabel = element("span", tr("正在檢索教材…"), "thinking-stage-label");
  stageBody.append(dots, stageLabel);
  stages.append(mascotFrame, stageBody);
  tutorBox.append(tutorHead, stages);
  pending.append(userBox, tutorBox);
  area.append(pending);
  area.scrollTop = area.scrollHeight;
  return { pending, stageLabel };
}

bindForm("ask",async () => {
  const questionText = $("question").value;
  $("chat-status").textContent = tr("正在檢索教材…");
  $("chats").disabled = $("new-chat").disabled = true;
  const { pending, stageLabel } = mountPendingTurn(questionText);
  const stageTimers = [
    window.setTimeout(() => {
      stageLabel.textContent = tr("正在思考回覆…");
      $("chat-status").textContent = tr("正在思考回覆…");
    }, 650),
    window.setTimeout(() => {
      stageLabel.textContent = tr("正在整理來源與引用…");
      $("chat-status").textContent = tr("正在整理來源與引用…");
    }, 2200)
  ];
  let replied = false;
  try {
    const reply = await post("/api/ask",{
      question:questionText,conversation_id:state.conversation||null,
      scope:state.selected||null,mode:$("mode").value
    });
    replied = true;
    state.conversation = reply.conversation_id;
    state.turns.push(reply);
    if (reply.status !== "error") {
      $("question").value = "";
      setSelection("");
    }
    showTurns();
    await refreshChats();
    $("chat-status").textContent = reply.status === "error" ? tr("保留問題，可再次送出。") : "";
  } finally {
    for (const id of stageTimers) window.clearTimeout(id);
    pending.remove();
    if (!replied) showTurns();
    $("chats").disabled = $("new-chat").disabled = false;
  }
},"chat-status","無法送出提問，請確認本地模型服務正常後再試。");

let jobTimer;
async function refreshJobs() {
  window.clearTimeout(jobTimer);
  const jobs = await get("/api/jobs");
  const active = jobs.some(j => ["queued","processing"].includes(j.state));
  const place = $("catalog").hidden ? $("jobs") : $("catalog-jobs");
  place.replaceChildren();
  for (const j of jobs.filter(j => j.state !== "ready").slice(0,5)) {
    const line = element("div",j.name+" · "+tr(j.message || (j.state==="queued" ? "排隊中" : "解析中")),"job");
    if (j.state === "failed") line.append(button(tr("重試"),async () => {
      await api("/api/jobs/"+j.id+"/retry",{method:"POST"});
      await refreshJobs();
    }));
    place.append(line);
  }
  await refreshDocuments();
  if (active) jobTimer = window.setTimeout(() => refreshJobs().catch(report),1300);
}

async function uploadMaterialFiles(files, options = {}) {
  const supported = [...files].filter(f => /\.(pdf|md|txt)$/i.test(f.name));
  if (!supported.length) throw Error("僅支援 PDF、Markdown 或 TXT 檔案。");
  for (const file of supported) {
    const form = new FormData();
    form.append("file", file);
    if (options.originalId && !/\.pdf$/i.test(file.name)) form.append("original_id", options.originalId);
    if (options.official && !options.personal) form.append("official", "true");
    if (options.personal && !/\.pdf$/i.test(file.name)) form.append("personal", "true");
    if (options.folderId) form.append("folder_id", options.folderId);
    await api("/api/import", { method: "POST", body: form });
  }
  await refreshJobs();
  return supported;
}

let importKindContext = "";

function importHintForContext() {
  if (importKindContext === "pdf") return tr("僅選擇 PDF 檔案（可多選）");
  if (importKindContext === "personal") return tr("支援 Markdown、TXT 個人文檔（可多選）");
  if (importKindContext === "note" || importKindContext === "text") return tr("支援 Markdown、TXT（可多選）");
  return tr("支援 PDF、Markdown、TXT（可多選）");
}

function updateMaterialFileLabel() {
  const meta = $("material-file-name");
  if (!meta) return;
  const files = [...($("material-file")?.files || [])];
  if (!files.length) meta.textContent = importHintForContext();
  else if (files.length === 1) meta.textContent = files[0].name;
  else meta.textContent = `${files[0].name} (+${files.length - 1})`;
}

const intakeTabs = ["material", "syllabus"];

function selectIntakeTab(panel, focus = false) {
  for (const item of intakeTabs) {
    const active = item === panel;
    const tab = $(`intake-${item}-tab`);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    $(`intake-${item}`).hidden = !active;
    if (active && focus) tab.focus();
  }
}

function showIntakeDialog(panel) {
  selectIntakeTab(panel);
  if (!$("import-dialog").open) $("import-dialog").showModal();
  $(`intake-${panel}-tab`).focus();
}

for (const [index, item] of intakeTabs.entries()) {
  const tab = $(`intake-${item}-tab`);
  tab.addEventListener("click", () => selectIntakeTab(item));
  tab.addEventListener("keydown", event => {
    const next = { Home: 0, End: intakeTabs.length - 1, ArrowLeft: 1 - index, ArrowRight: 1 - index }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectIntakeTab(intakeTabs[next], true);
  });
}

function openImportDialog(kind = "", preselectedFolderId = "") {
  importKindContext = kind || "";
  $("import-form").reset();
  $("import-status").textContent = "";
  $("preview").hidden = true;
  if ($("import-folder-rec")) {
    $("import-folder-rec").hidden = true;
    $("import-folder-rec").replaceChildren();
  }
  const folderSelect = $("import-folder");
  if (folderSelect && typeof folderOptions === "function") {
    const group = kind === "personal" ? "personal" : "course";
    folderSelect.replaceChildren(...folderOptions("未分類", group));
    folderSelect.value = preselectedFolderId && [...folderSelect.options].some(o => o.value === preselectedFolderId)
      ? preselectedFolderId
      : "";
  }
  const fileInput = $("material-file");
  const officialWrap = $("import-official-wrap");
  const originalLabel = $("import-original-label");
  if (officialWrap) officialWrap.hidden = kind === "personal";
  if (originalLabel) {
    originalLabel.textContent = tr(kind === "personal" ? "關聯教材（選填）" : "筆記的原始 PDF（選填）");
  }
  if (kind === "pdf") {
    fileInput.accept = ".pdf";
    $("original").value = "";
  } else if (kind === "personal") {
    fileInput.accept = ".md,.txt";
    $("original").value = "";
    $("official").checked = false;
  } else if (kind === "note") {
    fileInput.accept = ".md,.txt";
    const pdfs = state.documents.filter(d => d.kind === "pdf");
    const activePdf = window.reader?.doc?.kind === "pdf"
      ? window.reader.doc.id
      : window.reader?.doc?.original_id || pdfs[0]?.id || "";
    $("original").value = activePdf;
    $("official").checked = false;
    if (!pdfs.length) {
      $("import-status").textContent = tr("課程筆記需搭配一份原始 PDF，請先匯入原始 PDF 教材。");
    }
  } else if (kind === "text") {
    fileInput.accept = ".md,.txt";
    $("original").value = "";
  } else if (kind === "course") {
    fileInput.accept = ".pdf,.md,.txt";
    $("original").value = "";
  } else {
    fileInput.accept = ".pdf,.md,.txt";
  }
  updateMaterialFileLabel();
  showIntakeDialog("material");
}

document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click",() => b.closest("dialog").close()));
$("import-open").addEventListener("click",() => openImportDialog(""));
$("catalog-import").addEventListener("click",() => openImportDialog(""));
document.querySelectorAll(".empty-import-trigger").forEach(b => b.addEventListener("click",() => openImportDialog("")));
$("material-file").addEventListener("change",async () => {
  updateMaterialFileLabel();
  const f = $("material-file").files[0];
  $("preview").hidden = !f || !/\.(md|txt)$/i.test(f.name);
  let previewText = "";
  if (!$("preview").hidden) {
    previewText = await f.slice(0,5000).text();
    $("preview").textContent = previewText;
  }
  if (f && importKindContext !== "personal" && typeof window.recommendImportFolder === "function") {
    window.recommendImportFolder(f.name, previewText).catch(() => {});
  }
});
$("import-form").addEventListener("reset", () => {
  queueMicrotask(() => {
    updateMaterialFileLabel();
    $("preview").hidden = true;
  });
});

const importDropzone = $("import-dropzone");
if (importDropzone) {
  let dropDepth = 0;
  importDropzone.addEventListener("dragenter", event => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    dropDepth++;
    importDropzone.classList.add("is-dragover");
  });
  importDropzone.addEventListener("dragover", event => {
    if (!event.dataTransfer?.types?.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    importDropzone.classList.add("is-dragover");
  });
  importDropzone.addEventListener("dragleave", () => {
    dropDepth = Math.max(0, dropDepth - 1);
    if (!dropDepth) importDropzone.classList.remove("is-dragover");
  });
  importDropzone.addEventListener("drop", event => {
    event.preventDefault();
    dropDepth = 0;
    importDropzone.classList.remove("is-dragover");
    const files = [...(event.dataTransfer?.files || [])].filter(f => /\.(pdf|md|txt)$/i.test(f.name));
    if (!files.length) {
      $("import-status").textContent = tr("僅支援 PDF、Markdown 或 TXT 檔案。");
      return;
    }
    const dt = new DataTransfer();
    for (const file of files) dt.items.add(file);
    $("material-file").files = dt.files;
    $("import-status").textContent = "";
    $("material-file").dispatchEvent(new Event("change"));
  });
}

bindForm("import-form",async () => {
  const files = [...$("material-file").files];
  if (importKindContext === "note" && !$("original").value) {
    throw Error(tr("課程筆記需搭配一份原始 PDF，請先匯入原始 PDF 教材。"));
  }
  await uploadMaterialFiles(files, {
    originalId: $("original").value,
    official: $("official").checked,
    personal: importKindContext === "personal",
    folderId: $("import-folder")?.value || ""
  });
  importKindContext = "";
  $("import-form").reset();
  $("preview").hidden = true;
  if (!$("intake-material").hidden) $("import-dialog").close();
},"import-status","匯入教材失敗，請確認檔案格式為 PDF、Markdown 或 TXT 後再試。");

function findEngine(providerId) {
  return (state.engines || []).find(e => e.id === providerId) || null;
}

function providerDisplayName(providerId) {
  const eng = findEngine(providerId);
  if (eng) return english() ? eng.name : eng.name_zh;
  const fallback = {
    ollama: "Ollama",
    lmstudio: "LM Studio",
    "antigravity-cli": "Antigravity CLI",
    "claude-code": "Claude Code",
    "codex-cli": "Codex CLI",
    gemini: "Gemini",
    openai: "OpenAI",
    claude: "Claude",
    opencode: "OpenCode",
    deepseek: "DeepSeek",
    openrouter: "OpenRouter"
  };
  return fallback[providerId] || providerId || "AI";
}

function renderModelBadge() {
  const badge = $("model-status-badge");
  const text = $("model-status-text");
  if (!badge || !text) return;
  badge.title = tr("點擊開啟模型設定");
  const pName = providerDisplayName(state.provider);
  const label = state.modelName ? `${pName} · ${state.modelName}` : pName;
  if (state.modelOnline === null) {
    badge.dataset.state = "checking";
    text.textContent = tr("偵測模型中…");
  } else if (state.modelOnline) {
    const group = findEngine(state.provider)?.group;
    badge.dataset.state = group === "cli" || group === "cloud" ? "untested" : "online";
    const status = group === "cli" ? "已偵測 CLI" : group === "cloud" ? "已設定金鑰" : "已就緒";
    text.textContent = `${label} · ${tr(status)}`;
  } else {
    badge.dataset.state = "offline";
    text.textContent = `${label} · ${tr("未就緒")}`;
  }
}

async function checkModelStatus() {
  state.modelOnline = null;
  renderModelBadge();
  try {
    const data = await get("/api/engines");
    if (Array.isArray(data?.engines)) {
      state.engines = data.engines;
    }
    const active = findEngine(state.provider);
    state.modelOnline = Boolean(active?.available);
  } catch {
    state.modelOnline = false;
  }
  renderModelBadge();
}

function setEngineGroupTab(group) {
  state.draftGroup = group;
  for (const tab of document.querySelectorAll(".engine-group-tab")) {
    const selected = tab.dataset.engineGroup === group;
    tab.setAttribute("aria-selected", String(selected));
  }
  renderEngineProviderGrid();
}

function syncCustomModelField() {
  const select = $("model");
  const wrap = $("custom-model-wrap");
  const input = $("custom-model");
  if (!select || !wrap || !input) return;
  const isCustom = select.value === "__custom__";
  wrap.hidden = !isCustom;
  input.required = isCustom;
  if (isCustom && !input.value) {
    input.focus();
  }
}

let cloudKeyProvider = "";
let savedCliOptions = {};
let draftCliOptions = {};

function draftCloudKey(provider) {
  return provider === cloudKeyProvider ? $("cloud-key").value.trim() : "";
}

function readDraftCliOptions() {
  if (findEngine(state.draftProvider)?.group !== "cli") return undefined;
  const options = {};
  if ($("cli-reasoning").value) options.reasoning_effort = $("cli-reasoning").value;
  if (state.draftProvider === "codex-cli" && $("cli-service-tier").value) {
    options.service_tier = $("cli-service-tier").value;
  }
  return options;
}

function syncCliOptions() {
  const provider = state.draftProvider;
  const eng = findEngine(provider);
  const cli = eng?.group === "cli";
  $("cli-options").hidden = !cli;
  $("cli-service-tier-wrap").hidden = provider !== "codex-cli";
  if (!cli) return;

  const model = getSelectedModelValue();
  const catalog = eng.model_capabilities || {};
  const capabilities = Object.hasOwn(catalog, model) ? catalog[model] : undefined;
  const levels = capabilities?.reasoning_levels ?? eng.reasoning_levels ?? [];
  const saved = draftCliOptions[provider] || {};
  const effort = $("cli-reasoning");
  effort.replaceChildren(new Option(tr("沿用 CLI 設定"), ""), ...levels.map(level => new Option(level, level)));
  effort.value = levels.includes(saved.reasoning_effort) ? saved.reasoning_effort : "";
  const tier = $("cli-service-tier");
  const fast = tier.querySelector('option[value="fast"]');
  fast.disabled = capabilities?.fast === false;
  tier.value = !fast.disabled || saved.service_tier !== "fast" ? saved.service_tier || "" : "";
}

function populateModelsForProvider(providerId, preferredModel = "") {
  const select = $("model");
  const customInput = $("custom-model");
  const hint = $("engine-hint");
  if (!select) return;

  const eng = findEngine(providerId);
  const cloud = eng?.group === "cloud";
  const keyInput = $("cloud-key");
  if (cloudKeyProvider !== providerId || !cloud) keyInput.value = "";
  cloudKeyProvider = cloud ? providerId : "";
  $("cloud-key-wrap").hidden = !cloud;
  keyInput.placeholder = tr(eng?.available ? "已設定金鑰，留空沿用" : "輸入所選服務的金鑰");
  $("load-provider-models").hidden = !cloud && providerId !== "antigravity-cli";
  const models = eng ? [...eng.models] : [];
  let defaultModel = preferredModel || (providerId === state.provider ? state.modelName : "") || eng?.default_model || "";
  if (providerId === "antigravity-cli") {
    const legacy = /-(low|medium|high|xhigh|max)$/.exec(defaultModel);
    if (legacy && models.includes(defaultModel.slice(0, legacy.index))) {
      draftCliOptions[providerId] ??= { reasoning_effort: legacy[1] };
      defaultModel = defaultModel.slice(0, legacy.index);
    }
  }

  const isCustomValue = Boolean(defaultModel && !models.includes(defaultModel));
  const list = isCustomValue && !eng?.allow_custom_model ? [defaultModel, ...models] : models;

  select.replaceChildren(...list.map(name => new Option(
    name === "default" && eng?.group === "cli" ? tr("使用 CLI 預設模型") : name, name
  )));
  if (eng?.allow_custom_model) {
    select.add(new Option(english() ? "Custom model…" : "自訂模型名稱…", "__custom__"));
  }

  if (isCustomValue && eng?.allow_custom_model) {
    select.value = "__custom__";
    if (customInput) customInput.value = defaultModel;
  } else {
    select.value = list.includes(defaultModel) ? defaultModel : (list[0] || "");
    if (customInput) customInput.value = "";
  }

  syncCustomModelField();
  syncCliOptions();
  syncAllCustomSelects();

  if (hint && eng) {
    if (eng.group === "cloud") {
      hint.textContent = eng.available
        ? (english()
          ? `${eng.description} — Key configured. Test the model before use.`
          : `${eng.description_zh}。已設定金鑰，可測試模型連線。`)
        : (english()
          ? `${eng.description} — Enter a provider key or set ${eng.env_var} in .env.`
          : `${eng.description_zh}。可在這裡輸入金鑰，或在 .env 設定 ${eng.env_var}。`);
    } else if (eng.group === "cli") {
      const bins = (eng.cli_binaries || []).join(" / ");
      hint.textContent = eng.available
        ? (english()
          ? `${eng.description} — Detected ${eng.detected_binary}. Model access depends on your CLI login.`
          : `${eng.description_zh}。已偵測 ${eng.detected_binary}，請測試確認帳號能使用所選模型。`)
        : (english()
          ? `${eng.description} — Install local CLI (${bins}) and ensure it is on PATH.`
          : `${eng.description_zh}。請於本機安裝指令（${bins}）並加入 PATH 後點擊重新偵測。`);
    } else {
      hint.textContent = eng.available
        ? (english()
          ? `${eng.description} (${eng.endpoint_hint}) — ${eng.status_text_en}.`
          : `${eng.description_zh}（${eng.endpoint_hint}，${eng.status_text}）`)
        : (english()
          ? `${eng.description} (${eng.endpoint_hint}) — Start the local server and click Refresh.`
          : `${eng.description_zh}（${eng.endpoint_hint}）。啟動本機服務後點擊「重新偵測」即可載入模型清單。`);
    }
  }
}

let detectRequestSeq = 0;
let userPickedDraftDuringDetect = false;

function selectEngineProvider(providerId, preferredModel = "") {
  userPickedDraftDuringDetect = true;
  state.draftProvider = providerId;
  const eng = findEngine(providerId);
  if (eng && eng.group !== state.draftGroup) {
    state.draftGroup = eng.group;
    for (const tab of document.querySelectorAll(".engine-group-tab")) {
      tab.setAttribute("aria-selected", String(tab.dataset.engineGroup === eng.group));
    }
  }
  renderEngineProviderGrid();
  populateModelsForProvider(providerId, preferredModel);
  $("settings-status").textContent = "";
}

function renderEngineProviderGrid() {
  const grid = $("engine-provider-grid");
  if (!grid) return;
  const groupEngines = (state.engines || []).filter(e => e.group === state.draftGroup);
  grid.replaceChildren();

  for (const eng of groupEngines) {
    const selected = eng.id === state.draftProvider;
    const card = element("button", undefined, "engine-card" + (selected ? " is-selected" : ""));
    card.type = "button";
    card.setAttribute("role", "radio");
    card.setAttribute("aria-checked", String(selected));

    const head = element("div", undefined, "engine-card-head");
    const nameEl = element("span", english() ? eng.name : eng.name_zh, "engine-card-name");
    const dot = element("span", undefined, "engine-card-dot " + (eng.available ? "is-ready" : "is-offline"));
    dot.setAttribute("aria-hidden", "true");
    head.append(nameEl, dot);

    const sub = element("span", english() ? eng.status_text_en : eng.status_text, "engine-card-status");
    card.append(head, sub);

    card.addEventListener("click", () => {
      selectEngineProvider(eng.id);
    });
    grid.append(card);
  }
}

function getSelectedModelValue() {
  const select = $("model");
  if (!select) return "";
  if (select.value === "__custom__") {
    return ($("custom-model")?.value || "").trim();
  }
  return select.value;
}

async function loadPreferences() {
  const p = await get("/api/settings");
  state.provider = p.provider || "ollama";
  state.draftProvider = state.provider;
  state.modelName = p.model;
  savedCliOptions = p.cli_options || {};
  $("mode").value = $("preferred-mode").value = p.mode;
  $("model").replaceChildren(new Option(p.model, p.model));
  $("retriever").value = p.retriever;
  $("response-language").value = p.language;
  checkModelStatus();
}

async function detectModels(preserveSelection = false) {
  const seq = ++detectRequestSeq;
  userPickedDraftDuringDetect = false;
  const status = $("settings-status");
  const refreshBtn = $("refresh-models");
  if (refreshBtn) refreshBtn.disabled = true;
  status.textContent = tr("正在偵測模型引擎…");

  const initialProvider = preserveSelection ? state.draftProvider : state.provider;
  const initialModel = preserveSelection ? getSelectedModelValue() : state.modelName;

  try {
    const data = await get(preserveSelection ? "/api/engines?refresh=1" : "/api/engines");
    if (seq !== detectRequestSeq) return;
    state.engines = Array.isArray(data?.engines) ? data.engines : [];
    const activeEng = findEngine(state.provider);
    state.modelOnline = Boolean(activeEng?.available);
    renderModelBadge();

    const keepDraft = preserveSelection || userPickedDraftDuringDetect;
    const prevProvider = keepDraft ? state.draftProvider : initialProvider;
    const prevModel = keepDraft ? getSelectedModelValue() : initialModel;

    const targetProvider = findEngine(prevProvider) ? prevProvider : (state.engines[0]?.id || "ollama");
    const targetEng = findEngine(targetProvider);
    state.draftProvider = targetProvider;
    state.draftGroup = targetEng?.group || "local";

    for (const tab of document.querySelectorAll(".engine-group-tab")) {
      tab.setAttribute("aria-selected", String(tab.dataset.engineGroup === state.draftGroup));
    }
    renderEngineProviderGrid();
    populateModelsForProvider(targetProvider, prevModel);
    status.textContent = "";
  } catch (error) {
    if (seq !== detectRequestSeq) return;
    state.modelOnline = false;
    renderModelBadge();
    status.textContent = friendlyError(error, "目前無法偵測模型引擎狀態，請稍後再試。");
  } finally {
    if (seq === detectRequestSeq && refreshBtn) refreshBtn.disabled = false;
  }
}

for (const tab of document.querySelectorAll(".engine-group-tab")) {
  tab.addEventListener("click", () => {
    userPickedDraftDuringDetect = true;
    const nextGroup = tab.dataset.engineGroup;
    setEngineGroupTab(nextGroup);
    const groupEngines = (state.engines || []).filter(e => e.group === nextGroup);
    if (groupEngines.length && !groupEngines.some(e => e.id === state.draftProvider)) {
      const preferred = groupEngines.find(e => e.available) || groupEngines[0];
      selectEngineProvider(preferred.id);
    }
  });
}

$("model")?.addEventListener("change", () => {
  syncCustomModelField();
  syncCliOptions();
  syncAllCustomSelects();
});
$("custom-model").addEventListener("input", () => {
  syncCliOptions();
  syncAllCustomSelects();
});
$("cli-options").addEventListener("change", () => {
  draftCliOptions[state.draftProvider] = readDraftCliOptions();
});

$("load-provider-models").addEventListener("click", async () => {
  const btn = $("load-provider-models");
  const provider = state.draftProvider;
  const status = $("settings-status");
  btn.disabled = true;
  status.textContent = tr("正在取得模型清單…");
  try {
    const { models, model_capabilities } = await post("/api/engines/models", { provider, api_key: draftCloudKey(provider) });
    if (provider !== state.draftProvider || !$("settings-dialog").open) return;
    if (!models.length) throw Error(tr("無法取得模型清單。"));
    const engine = findEngine(provider);
    const current = getSelectedModelValue();
    engine.models = models;
    engine.model_capabilities = model_capabilities;
    populateModelsForProvider(provider, provider === "antigravity-cli" || models.includes(current) ? current : models[0]);
    status.textContent = english() ? `Loaded ${models.length} models.` : `已取得 ${models.length} 個模型。`;
  } catch (error) {
    if (provider === state.draftProvider) status.textContent = friendlyError(error, "無法取得模型清單。");
  } finally {
    btn.disabled = false;
  }
});

$("test-engine")?.addEventListener("click", async () => {
  const btn = $("test-engine");
  const status = $("settings-status");
  const provider = state.draftProvider || state.provider;
  const model = getSelectedModelValue();
  const cliOptions = readDraftCliOptions();
  if (!model) {
    status.textContent = english() ? "Please select or enter a model name first." : "請先選擇或輸入模型名稱。";
    return;
  }
  btn.disabled = true;
  status.textContent = english()
    ? `Testing ${providerDisplayName(provider)} (${model})…`
    : `正在測試 ${providerDisplayName(provider)}（${model}）連線…`;
  try {
    const res = await post("/api/engines/test", { provider, model, api_key: draftCloudKey(provider), cli_options: cliOptions });
    if (provider !== state.draftProvider || model !== getSelectedModelValue()) return;
    const secs = typeof res.latency_ms === "number" ? (res.latency_ms / 1000).toFixed(2) : "0";
    status.textContent = english()
      ? `Connected to ${providerDisplayName(provider)} (${model}) in ${secs}s.`
      : `連線成功！${providerDisplayName(provider)}（${model}）回應耗時 ${secs} 秒。`;
  } catch (error) {
    if (provider === state.draftProvider && model === getSelectedModelValue()) {
      status.textContent = friendlyError(error, "連線測試未通過，請確認引擎服務與設定。");
    }
  } finally {
    btn.disabled = false;
  }
});

function openSettings() {
  draftCliOptions = { ...savedCliOptions };
  $("settings-dialog").showModal();
  detectModels(false);
}
$("settings-open").addEventListener("click", openSettings);
$("settings-dialog").addEventListener("close", () => { $("cloud-key").value = ""; });
$("model-status-badge")?.addEventListener("click", openSettings);
$("refresh-models").onclick = () => detectModels(true);

bindForm("settings-form", async () => {
  const mode = $("preferred-mode").value;
  const provider = state.draftProvider || state.provider || "ollama";
  const model = getSelectedModelValue();
  if (!model) {
    throw Error(english() ? "Please enter a valid model name." : "請選擇或輸入有效的模型名稱。");
  }
  const saved = await parseJson(await api("/api/settings", {
    method: "PUT",
    ...json({
      mode,
      provider,
      model,
      api_key: draftCloudKey(provider),
      cli_options: readDraftCliOptions(),
      retriever: $("retriever").value,
      language: $("response-language").value
    })
  }), "/api/settings");
  state.provider = provider;
  state.modelName = model;
  savedCliOptions = saved.cli_options || {};
  $("mode").value = mode;
  $("settings-dialog").close();
  checkModelStatus();
}, "settings-status", "無法儲存設定，請稍後再試。");
let recordsDeleteConfirmTimer = 0;

function resetRecordsDeleteConfirm() {
  window.clearTimeout(recordsDeleteConfirmTimer);
  const btn = $("records-delete");
  if (!btn) return;
  if (btn.dataset.confirm) $("records-status").textContent = "";
  btn.dataset.confirm = "";
  btn.classList.remove("is-confirming");
  btn.textContent = tr("批量刪除");
}

function selectedRecordItems() {
  const selection = { conversations: [], records: [] };
  for (const b of $("record-list").querySelectorAll("input[type='checkbox']:checked")) {
    selection[b.dataset.kind].push(b.value);
  }
  return selection;
}

let recordPreviewRequest = 0;
let recordsBusy = false;
const recordsMedia = matchMedia("(max-width: 620px)");

function updateRecordSelectionUI() {
  resetRecordsDeleteConfirm();
  const boxes = [...$("record-list").querySelectorAll("input[type='checkbox']")];
  const checkedCount = boxes.filter(b => b.checked).length;
  const selectAll = $("record-select-all");
  selectAll.disabled = !boxes.length || recordsBusy;
  selectAll.checked = boxes.length > 0 && checkedCount === boxes.length;
  selectAll.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
  $("record-selected-count").textContent = english() ? `${checkedCount} selected` : `已選 ${checkedCount} 筆`;
  $("records-delete").disabled = !checkedCount || recordsBusy;
  $("records-export-btn").disabled = !checkedCount || recordsBusy;
}

function recordDate(created) {
  if (!created) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(created) ? created.replace(" ", "T") + "Z" : created;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const locale = english() ? "en" : "zh-TW";
  return { iso: date.toISOString(), label: new Intl.DateTimeFormat(locale, {
    dateStyle: "medium", timeStyle: "short",
  }).format(date), compact: new Intl.DateTimeFormat(locale, {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date) };
}

function showRecordMessage(text) {
  $("record-view").replaceChildren(element("p", text, "record-view-message"));
}

function clearRecordPreview() {
  recordPreviewRequest++;
  $("records-dialog").querySelector(".records-grid").dataset.view = "list";
  $("record-preview-head").hidden = true;
  $("record-preview-title").textContent = tr("對話預覽");
  showRecordMessage(tr("點擊左側任一對話即可預覽完整問答"));
}

function previewMessage(role, html, text, kind) {
  const message = element("section", undefined, `record-message record-message-${kind}`);
  const body = element("div", undefined, "record-message-body");
  if (typeof html === "string") body.innerHTML = html;
  else body.textContent = text || "";
  message.append(element("h4", role), body);
  return message;
}

async function previewRecord(item, kind, trigger) {
  const request = ++recordPreviewRequest;
  for (const old of $("record-list").querySelectorAll("[aria-current]")) old.removeAttribute("aria-current");
  trigger.setAttribute("aria-current", "true");
  $("records-dialog").querySelector(".records-grid").dataset.view = "preview";
  $("record-preview-head").hidden = false;
  $("record-preview-title").textContent = item.title || item.name;
  const date = recordDate(item.created);
  const time = $("record-preview-time");
  time.hidden = !date;
  time.dateTime = date?.iso || "";
  time.textContent = date?.label || "";
  if (recordsMedia.matches) $("record-back").focus();
  showRecordMessage(tr("正在載入對話…"));
  const view = $("record-view");
  view.scrollTop = 0;
  try {
    const result = await get(`/api/${kind}/${encodeURIComponent(item.id)}`);
    if (request !== recordPreviewRequest) return;
    if (kind === "records") {
      view.replaceChildren(previewMessage(tr("匯入紀錄"), result.html, result.content, "tutor"));
    } else if (result.length) {
      view.replaceChildren(...result.flatMap(turn => [
        previewMessage(tr("你"), turn.question_html, turn.question, "you"),
        previewMessage(tr("BIIBO 助教"), turn.html, turn.answer, "tutor"),
      ]));
    } else {
      showRecordMessage(tr("這筆對話尚無問答。"));
    }
    math(view);
  } catch (error) {
    if (request === recordPreviewRequest) showRecordMessage(friendlyError(error, tr("無法載入對話預覽。")));
  }
}

$("record-back").addEventListener("click", () => {
  $("records-dialog").querySelector(".records-grid").dataset.view = "list";
  $("record-list").querySelector('[aria-current="true"]')?.focus();
});
$("records-dialog").addEventListener("close", clearRecordPreview);

async function listRecords() {
  const list = $("record-list");
  state.records = await get("/api/records");
  await refreshChats();
  $("records-status").textContent = "";
  list.replaceChildren();
  clearRecordPreview();
  const items = [[state.chats, "conversations"], [state.records, "records"]];
  for (const [rows, kind] of items) for (const item of rows) {
    const title = item.name || item.title;
    const box = element("input");
    box.type = "checkbox";
    box.dataset.kind = kind;
    box.value = item.id;
    box.setAttribute("aria-label", `${tr("選取對話")} · ${title}`);
    box.addEventListener("change", updateRecordSelectionUI);
    const trigger = element("button", undefined, "record-item-preview");
    trigger.type = "button";
    const text = element("span", undefined, "record-item-text");
    const titleLine = element("span", title, "record-item-title");
    titleLine.title = title;
    text.append(titleLine);
    const source = kind === "records" ? tr("匯入紀錄") : item.source_name || tr("未指定教材");
    const turns = kind === "conversations" ? (english() ? `${item.turn_count} turns` : `${item.turn_count} 則`) : "";
    const date = recordDate(item.created);
    const metaLine = element("span", undefined, "record-item-meta");
    metaLine.title = [source, date?.label, turns].filter(Boolean).join(" · ");
    metaLine.append(element("span", source, "record-item-source"));
    const details = [date?.compact, turns].filter(Boolean).join(" · ");
    if (details) metaLine.append(element("span", "· " + details, "record-item-detail"));
    text.append(metaLine);
    trigger.append(text);
    trigger.addEventListener("click", () => previewRecord(item, kind, trigger));
    const line = element("div", undefined, "record-item-row");
    line.append(box, trigger);
    list.append(line);
  }
  if (!list.childElementCount) list.append(element("p", tr("目前沒有對話紀錄。"), "record-view-message"));
  updateRecordSelectionUI();
}
$("record-select-all")?.addEventListener("change", () => {
  const checked = $("record-select-all").checked;
  for (const box of $("record-list").querySelectorAll("input[type='checkbox']")) {
    box.checked = checked;
  }
  updateRecordSelectionUI();
});
$("records-open").addEventListener("click", async () => {
  try { await listRecords(); $("records-dialog").showModal(); } catch (error) { report(error); }
});
$("records-delete")?.addEventListener("click", async () => {
  const btn = $("records-delete");
  const selection = selectedRecordItems();
  const count = selection.conversations.length + selection.records.length;
  if (!count) {
    $("records-status").textContent = tr("請勾選至少一筆對話。");
    return;
  }
  if (btn.dataset.confirm !== "1") {
    btn.dataset.confirm = "1";
    btn.classList.add("is-confirming");
    btn.textContent = english() ? `Confirm delete (${count})` : `確認刪除 (${count})`;
    $("records-status").textContent = english() ? "Click again to permanently delete selected items." : "再次點擊確認按鈕即可刪除所選對話。";
    recordsDeleteConfirmTimer = window.setTimeout(resetRecordsDeleteConfirm, 4000);
    return;
  }
  resetRecordsDeleteConfirm();
  recordsBusy = true;
  updateRecordSelectionUI();
  try {
    const activeDeleted = state.conversation && selection.conversations.includes(state.conversation);
    const res = await post("/api/records/delete", selection);
    const removed = (res?.deleted?.conversations || 0) + (res?.deleted?.records || 0);
    if (activeDeleted) {
      state.conversation = "";
      state.turns = [];
      setSelection("");
      showTurns();
    }
    await listRecords();
    $("records-status").textContent = english() ? `Deleted ${removed} item(s).` : `已刪除 ${removed} 筆對話。`;
  } catch (error) {
    $("records-status").textContent = friendlyError(error, "無法刪除所選對話，請稍後再試。");
  } finally {
    recordsBusy = false;
    updateRecordSelectionUI();
  }
});
$("records-export").addEventListener("submit", async event => {
  event.preventDefault();
  const selection = { ...selectedRecordItems(), format: $("format").value };
  if (recordsBusy || (!selection.conversations.length && !selection.records.length)) return;
  recordsBusy = true;
  updateRecordSelectionUI();
  $("records-status").textContent = "";
  try {
    const response = await api("/api/records/export", { method: "POST", ...json(selection) });
    const url = URL.createObjectURL(await response.blob());
    const link = element("a");
    link.download = "aita-records." + selection.format;
    link.href = url;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    $("records-status").textContent = friendlyError(error, "無法匯出互動紀錄，請稍後再試。");
  } finally {
    recordsBusy = false;
    updateRecordSelectionUI();
  }
});
document.addEventListener("aita-language", () => {
  refreshJobs().catch(report);
  refreshChats().catch(report);
  showTurns();
  renderModelBadge();
  updateMaterialFileLabel();
  if ($("settings-dialog").open) {
    renderEngineProviderGrid();
    populateModelsForProvider(state.draftProvider, getSelectedModelValue());
  }
  if ($("records-dialog").open) listRecords().catch(report);
  syncAllCustomSelects();
});
renderPromptChips();
renderModelBadge();

const customSelectSyncers = [];
let openSelectCloser = null;

function syncAllCustomSelects() {
  for (let i = customSelectSyncers.length - 1; i >= 0; i--) {
    const entry = customSelectSyncers[i];
    if (!entry.select.isConnected) {
      customSelectSyncers.splice(i, 1);
      continue;
    }
    entry.sync();
  }
}

function enhanceBrandSelect(select) {
  if (!select || select.dataset.biiboEnhanced) return;
  select.dataset.biiboEnhanced = "1";

  const wrap = element("div", undefined, "biibo-select");
  const trigger = element("button", undefined, "biibo-select-trigger");
  trigger.type = "button";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  const labelSpan = element("span", undefined, "biibo-select-label");
  const caret = element("span", undefined, "biibo-select-caret");
  caret.setAttribute("aria-hidden", "true");
  trigger.append(labelSpan, caret);

  const menu = element("div", undefined, "biibo-select-menu");
  menu.setAttribute("role", "listbox");
  menu.hidden = true;

  select.parentNode.insertBefore(wrap, select);
  wrap.append(select, trigger, menu);
  select.classList.add("biibo-native-select");
  select.tabIndex = -1;
  select.setAttribute("aria-hidden", "true");

  const close = () => {
    if (menu.hidden) return;
    menu.hidden = true;
    wrap.classList.remove("is-open", "drop-up");
    trigger.setAttribute("aria-expanded", "false");
    if (openSelectCloser === close) openSelectCloser = null;
  };

  const sync = () => {
    const selected = select.options[select.selectedIndex] || select.options[0];
    labelSpan.replaceChildren();
    if (selected?.dataset?.dot) {
      const dot = element("span", undefined, "biibo-option-dot");
      dot.style.backgroundColor = selected.dataset.dot;
      dot.setAttribute("aria-hidden", "true");
      labelSpan.append(dot);
    }
    labelSpan.append(document.createTextNode(selected ? selected.textContent : ""));
    trigger.disabled = select.disabled;
    const ariaLabel = select.getAttribute("aria-label");
    if (ariaLabel) trigger.setAttribute("aria-label", ariaLabel);

    menu.replaceChildren();
    for (let i = 0; i < select.options.length; i++) {
      const opt = select.options[i];
      const item = element("button", undefined, "biibo-select-option");
      item.type = "button";
      item.setAttribute("role", "option");
      const isSelected = i === select.selectedIndex;
      item.setAttribute("aria-selected", String(isSelected));
      item.disabled = opt.disabled;
      const textWrap = element("span", undefined, "biibo-option-text");
      if (opt.dataset?.dot) {
        const dot = element("span", undefined, "biibo-option-dot");
        dot.style.backgroundColor = opt.dataset.dot;
        dot.setAttribute("aria-hidden", "true");
        textWrap.append(dot);
      }
      textWrap.append(document.createTextNode(opt.textContent || ""));
      const check = element("span", isSelected ? "✓" : "", "biibo-option-check");
      check.setAttribute("aria-hidden", "true");
      item.append(textWrap, check);
      item.addEventListener("click", () => {
        const changed = select.selectedIndex !== i;
        valueDesc.set.call(select, opt.value);
        sync();
        close();
        trigger.focus();
        if (changed) select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      menu.append(item);
    }
  };

  const open = () => {
    if (trigger.disabled) return;
    if (openSelectCloser && openSelectCloser !== close) openSelectCloser();
    sync();
    menu.hidden = false;
    wrap.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const needed = Math.min(240, menu.scrollHeight + 12);
    wrap.classList.toggle("drop-up", spaceBelow < needed && spaceAbove > spaceBelow);
    openSelectCloser = close;
    const active = menu.querySelector('[aria-selected="true"]') || menu.firstElementChild;
    active?.scrollIntoView({ block: "nearest" });
  };

  trigger.addEventListener("click", () => (menu.hidden ? open() : close()));
  trigger.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (menu.hidden) { open(); return; }
      const opts = [...menu.querySelectorAll(".biibo-select-option:not(:disabled)")];
      const cur = opts.findIndex(o => o.getAttribute("aria-selected") === "true");
      const next = e.key === "ArrowDown" ? Math.min(opts.length - 1, cur + 1) : Math.max(0, cur - 1);
      opts[next]?.focus();
    } else if (e.key === "Escape") {
      close();
    }
  });
  menu.addEventListener("keydown", e => {
    const opts = [...menu.querySelectorAll(".biibo-select-option:not(:disabled)")];
    const idx = opts.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); opts[Math.min(opts.length - 1, idx + 1)]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); opts[Math.max(0, idx - 1)]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); opts[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); opts[opts.length - 1]?.focus(); }
    else if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); }
  });

  const valueDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  const idxDesc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");
  Object.defineProperty(select, "value", {
    configurable: true,
    get() { return valueDesc.get.call(this); },
    set(v) { valueDesc.set.call(this, v); sync(); }
  });
  Object.defineProperty(select, "selectedIndex", {
    configurable: true,
    get() { return idxDesc.get.call(this); },
    set(v) { idxDesc.set.call(this, v); sync(); }
  });

  const observer = new MutationObserver(sync);
  observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "aria-label", "data-dot"] });
  select.addEventListener("change", sync);
  select.addEventListener("focus", () => trigger.focus());
  select.form?.addEventListener("reset", () => queueMicrotask(sync));
  customSelectSyncers.push({ select, sync });
  sync();
}

window.enhanceBrandSelect = enhanceBrandSelect;

document.addEventListener("pointerdown", e => {
  if (openSelectCloser && !e.target.closest(".biibo-select")) openSelectCloser();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && openSelectCloser) openSelectCloser();
});

for (const select of document.querySelectorAll("select:not(#format)")) enhanceBrandSelect(select);
