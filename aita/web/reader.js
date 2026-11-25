"use strict";

const reader = {doc:null, mode:"original", page:1, total:1, target:null, sequence:0, frame:0};
window.reader = reader;
const layout = document.querySelector(".workspace");
const narrow = matchMedia("(max-width: 900px)");
const readRoot = $("document");
let pdfjs;
let viewTimer;

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function saveLocal(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { throw Error("瀏覽器無法儲存這項變更。"); }
}

const storedPanels = readLocal("biibo-panels", null);
const panelState = {
  library: storedPanels?.library !== false,
  tutor: storedPanels?.tutor !== false
};

const libraryDivider = $("library-resize");
let preferredLibraryWidth = readLocal("biibo-library-width", 268);
if (!Number.isFinite(preferredLibraryWidth)) preferredLibraryWidth = 268;
let libraryWidth = 268;
let libraryDrag;

const divider = $("tutor-resize");
let preferredWidth = readLocal("aita-tutor-width", 390);
if (!Number.isFinite(preferredWidth)) preferredWidth = 390;
let width = 390;
let drag;

function applyLibraryWidth(value) {
  const max = Math.max(200, Math.min(420, layout.clientWidth - (panelState.tutor ? width : 0) - 280));
  libraryWidth = Math.round(Math.min(max, Math.max(200, value)));
  layout.style.setProperty("--library-width", libraryWidth + "px");
  if (libraryDivider) {
    libraryDivider.setAttribute("aria-valuemin", "200");
    libraryDivider.setAttribute("aria-valuemax", String(max));
    libraryDivider.setAttribute("aria-valuenow", String(libraryWidth));
  }
}

function applyWidth(value) {
  const max = Math.max(300, Math.min(780, layout.clientWidth - (panelState.library ? libraryWidth : 0) - 280));
  width = Math.round(Math.min(max, Math.max(300, value)));
  layout.style.setProperty("--tutor-width", width + "px");
  divider.setAttribute("aria-valuemin", "300");
  divider.setAttribute("aria-valuemax", String(max));
  divider.setAttribute("aria-valuenow", String(width));
}

let rightPaneTab = "tutor";

function syncRightPaneTabs() {
  const isNotes = rightPaneTab === "notes";
  const tutorTab = $("right-tab-tutor");
  const notesTab = $("right-tab-notes");
  const tutorPanel = $("tutor-panel");
  const notesPanel = $("notes-panel");
  if (tutorTab) {
    tutorTab.setAttribute("aria-selected", String(!isNotes));
    tutorTab.tabIndex = isNotes ? -1 : 0;
  }
  if (notesTab) {
    notesTab.setAttribute("aria-selected", String(isNotes));
    notesTab.tabIndex = isNotes ? 0 : -1;
  }
  if (tutorPanel) tutorPanel.hidden = isNotes;
  if (notesPanel) notesPanel.hidden = !isNotes;
  const readerNotesBtn = $("reader-notes");
  if (readerNotesBtn) {
    readerNotesBtn.setAttribute("aria-pressed", String(isNotes && (narrow.matches ? layout.dataset.panel === "tutor" : panelState.tutor)));
  }
}

function setRightPaneTab(tab, ensureVisible = false) {
  rightPaneTab = tab === "notes" ? "notes" : "tutor";
  if (ensureVisible) {
    if (narrow.matches) {
      layout.dataset.panel = "tutor";
    } else if (!panelState.tutor) {
      panelState.tutor = true;
      try { saveLocal("biibo-panels", panelState); } catch { /* Keeps session state. */ }
    }
    applyPanelVisibility();
  } else {
    syncRightPaneTabs();
  }
}
window.setRightPaneTab = setRightPaneTab;
window.getRightPaneTab = () => rightPaneTab;

function applyPanelVisibility() {
  layout.dataset.hideLibrary = String(!panelState.library);
  layout.dataset.hideReader = "false";
  layout.dataset.hideTutor = String(!panelState.tutor);
  for (const btn of document.querySelectorAll(".pane-icon-btn[data-toggle-pane]")) {
    const pane = btn.dataset.togglePane;
    btn.setAttribute("aria-pressed", String(Boolean(panelState[pane])));
  }
  const currentPanel = layout.dataset.panel || "library";
  for (const a of document.querySelectorAll(".narrow-nav a")) {
    if (a.hash === "#" + currentPanel) a.setAttribute("aria-current", "location");
    else a.removeAttribute("aria-current");
  }
  applyLibraryWidth(preferredLibraryWidth);
  applyWidth(preferredWidth);
  syncRightPaneTabs();
}

function toggleDesktopPanel(panel) {
  if (!(panel in panelState)) return;
  panelState[panel] = !panelState[panel];
  try { saveLocal("biibo-panels", panelState); } catch { /* Keeps session state. */ }
  applyPanelVisibility();
}

function showPanel(panel, focus = true) {
  layout.dataset.panel = panel;
  if (!narrow.matches && panel in panelState && !panelState[panel]) {
    panelState[panel] = true;
    try { saveLocal("biibo-panels", panelState); } catch { /* Keeps session state. */ }
  }
  applyPanelVisibility();
  if (!focus) return;
  const destination = panel === "library" ? ($("materials").querySelector("[aria-current=true]") || $("materials").querySelector("button") || $("import-open"))
    : panel === "tutor" ? (rightPaneTab === "notes" ? $("note-body") : $("question")) : $("reader");
  destination?.focus({preventScroll:!narrow.matches});
}

for (const btn of document.querySelectorAll(".pane-icon-btn[data-toggle-pane]")) {
  btn.addEventListener("click", () => toggleDesktopPanel(btn.dataset.togglePane));
}
$("right-tab-tutor")?.addEventListener("click", () => setRightPaneTab("tutor", true));
$("right-tab-notes")?.addEventListener("click", () => {
  const sourceId = typeof originalDocument === "function" ? (originalDocument(reader.doc) || reader.doc?.id || null) : null;
  if (typeof openNotes === "function") {
    openNotes(sourceId, "", reader.doc?.note_id || "").catch(report);
  } else {
    setRightPaneTab("notes", true);
  }
});
for (const a of document.querySelectorAll(".narrow-nav a,.skip")) {
  a.addEventListener("click", event => {
    if (!["#library","#reader","#tutor"].includes(a.getAttribute("href"))) return;
    event.preventDefault();
    showPanel(a.hash.slice(1));
  });
}
for (const id of ["library","reader","tutor"]) {
  $(id).addEventListener("focusin", () => {
    if (narrow.matches) showPanel(id, false);
    else layout.dataset.panel = id;
  });
}

applyPanelVisibility();
narrow.addEventListener("change", applyPanelVisibility);
window.addEventListener("resize", () => {
  applyLibraryWidth(preferredLibraryWidth);
  applyWidth(preferredWidth);
});

if (libraryDivider) {
  libraryDivider.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    libraryDrag = {x:event.clientX, width:libraryWidth};
    libraryDivider.setPointerCapture(event.pointerId);
    libraryDivider.classList.add("dragging");
    libraryDivider.focus();
  });
  libraryDivider.addEventListener("pointermove", event => {
    if (libraryDrag) applyLibraryWidth(libraryDrag.width + (event.clientX - libraryDrag.x));
  });
  libraryDivider.addEventListener("lostpointercapture", () => {
    if (!libraryDrag) return;
    libraryDrag = null;
    libraryDivider.classList.remove("dragging");
    try { saveLocal("biibo-library-width", preferredLibraryWidth = libraryWidth); } catch (error) { report(error); }
  });
  libraryDivider.addEventListener("keydown", event => {
    if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
    event.preventDefault();
    applyLibraryWidth({ArrowLeft:libraryWidth-24, ArrowRight:libraryWidth+24, Home:200, End:420}[event.key]);
    try { saveLocal("biibo-library-width", preferredLibraryWidth = libraryWidth); } catch (error) { report(error); }
  });
}

divider.addEventListener("pointerdown", event => {
  if (event.button !== 0) return;
  drag = {x:event.clientX, width};
  divider.setPointerCapture(event.pointerId);
  divider.classList.add("dragging");
  divider.focus();
});
divider.addEventListener("pointermove", event => {
  if (drag) applyWidth(drag.width + drag.x - event.clientX);
});
divider.addEventListener("lostpointercapture", () => {
  if (!drag) return;
  drag = null;
  divider.classList.remove("dragging");
  try { saveLocal("aita-tutor-width", preferredWidth = width); } catch (error) { report(error); }
});
divider.addEventListener("keydown", event => {
  if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
  event.preventDefault();
  applyWidth({ArrowLeft:width+24, ArrowRight:width-24, Home:300, End:780}[event.key]);
  try { saveLocal("aita-tutor-width", preferredWidth = width); } catch (error) { report(error); }
});

/* Center Reader Direct Drag & Drop Upload */
let readerDropDepth = 0;
function readerDropzone() { return $("reader-dropzone"); }
readRoot.addEventListener("dragenter", event => {
  const zone = readerDropzone();
  if (!zone || !event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  readerDropDepth++;
  zone.classList.add("is-dragover");
  const status = $("reader-drop-status");
  if (status) status.textContent = tr("放開即可匯入教材");
});
readRoot.addEventListener("dragover", event => {
  const zone = readerDropzone();
  if (!zone || !event.dataTransfer?.types?.includes("Files")) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "copy";
  zone.classList.add("is-dragover");
});
readRoot.addEventListener("dragleave", () => {
  const zone = readerDropzone();
  if (!zone) return;
  readerDropDepth = Math.max(0, readerDropDepth - 1);
  if (!readerDropDepth) {
    zone.classList.remove("is-dragover");
    const status = $("reader-drop-status");
    if (status) status.textContent = tr("拖曳檔案到此處，或點擊左側「＋ 匯入教材」");
  }
});
readRoot.addEventListener("drop", async event => {
  const zone = readerDropzone();
  if (!zone || !event.dataTransfer?.files?.length) return;
  event.preventDefault();
  readerDropDepth = 0;
  zone.classList.remove("is-dragover");
  const status = $("reader-drop-status");
  const files = [...event.dataTransfer.files];
  const supported = files.filter(f => /\.(pdf|md|txt)$/i.test(f.name));
  if (!supported.length) {
    if (status) status.textContent = tr("僅支援 PDF、Markdown 或 TXT 檔案。");
    return;
  }
  if (status) status.textContent = tr("正在匯入拖曳的檔案…");
  try {
    await uploadMaterialFiles(supported);
    if (status) status.textContent = tr("匯入完成");
  } catch (error) {
    if (status) status.textContent = friendlyError(error, "匯入教材失敗，請確認檔案格式為 PDF、Markdown 或 TXT 後再試。");
    report(error, "匯入教材失敗，請確認檔案格式為 PDF、Markdown 或 TXT 後再試。");
  }
});

function syncSelection() {
  const selected = state.selected;
  readRoot.querySelectorAll("[data-block]").forEach(block => block.classList.toggle("picked",
    selected?.document_id === reader.doc?.id && selected.blocks.includes(Number(block.dataset.block))));
}

async function openDocument(key, target) {
  const sequence = ++reader.sequence;
  if (key !== reader.doc?.id) {
    const doc = await get("/api/documents/" + encodeURIComponent(key));
    if (sequence !== reader.sequence) return;
    reader.loading?.destroy().catch(() => {});
    reader.loading = null;
    reader.doc = {...doc,note_id:state.documents.find(d => d.id === key)?.note_id};
    const saved = readLocal(`aita-reading:${key}`,null);
    reader.mode = saved?.mode === "parsed" ? "parsed" : "original";
    reader.page = Number.isInteger(saved?.page) && saved.page >= 1 ? saved.page : 1;
    reader.unmapped = false;
    reader.total = Math.max(saved?.total || 1,doc.blocks.reduce((max, block) => Math.max(max, block.page || 0), 1));
  }
  state.document = key;
  history.replaceState(history.state,"",`/?document=${encodeURIComponent(key)}`);
  if (target?.page && reader.doc.kind === "pdf") {
    reader.page = target.page;
    reader.unmapped = false;
  }
  if (target && reader.doc.kind === "pdf" && !target.page) {
    reader.mode = "parsed";
    reader.unmapped = true;
  }
  reader.target = target || null;
  $("doc-title").textContent = reader.doc.name;
  document.querySelectorAll(".doc-link").forEach(n => n.setAttribute("aria-current",String(n.dataset.key === key)));
  showPanel("reader");
  renderReader();
  if (typeof renderPromptChips === "function") renderPromptChips();
  if (rightPaneTab === "notes" && typeof window.syncNotesWithReader === "function") {
    window.syncNotesWithReader();
  }
}

function syncReader() {
  const {doc, mode, page, total, unmapped, target} = reader;
  const pdf = doc.kind === "pdf";
  $("view-switch").hidden = $("page-controls").hidden = !pdf;
  $("reader-actions").hidden = false;
  const active = $(mode === "original" ? "original-view" : "parsed-view");
  for (const tab of $("view-switch").querySelectorAll('[role="tab"]')) {
    tab.tabIndex = tab === active ? 0 : -1;
    tab.setAttribute("aria-selected", String(tab === active));
  }
  $("document").setAttribute("aria-labelledby",pdf ? active.id : "doc-title");
  if (pdf) $("document").setAttribute("role","tabpanel");
  else $("document").removeAttribute("role");
  $("page-number").max = total;
  $("page-number").value = page;
  $("page-count").textContent = english() ? `/ ${total}` : `/ ${total} 頁`;
  $("page-prev").disabled = page <= 1 && !unmapped;
  $("page-next").disabled = page >= total && !unmapped;
  $("unmapped-page").hidden = !pdf || mode !== "parsed" || !doc.blocks.some(b => !b.page);
  $("unmapped-page").setAttribute("aria-pressed", String(Boolean(unmapped)));
  $("ask-page").textContent = tr(pdf && !unmapped ? "問這一頁" : "問這份教材");
  $("ask-page").disabled = pdf && unmapped;
  const source = $("source-link");
  const sourcePage = pdf && !unmapped ? page : target?.page;
  source.hidden = !pdf && !doc.original_id;
  source.href = `/api/documents/${doc.original_id || doc.id}/pdf` + (sourcePage ? `#page=${sourcePage}` : "");
  $("reader-notes").hidden = false;
  const quizBtn = $("reader-quiz");
  if (quizBtn) {
    quizBtn.hidden = doc.kind === "personal";
  }
  const notesLabel = $("reader-notes-label");
  if (notesLabel) notesLabel.textContent = tr(doc.kind === "personal" ? "編輯筆記" : "個人筆記");
  const pageInsertBtn = $("note-insert-page");
  if (pageInsertBtn) {
    pageInsertBtn.hidden = !pdf || unmapped;
    if (pdf && !unmapped) pageInsertBtn.textContent = `P.${page}`;
  }
  syncRightPaneTabs();
  if (typeof window.onReaderContextChange === "function") {
    window.onReaderContextChange();
  }
  if (pdf) {
    try { saveLocal(`aita-reading:${doc.id}`,{mode,page,total}); } catch { /* The current page remains usable. */ }
  }
}

const viewTabs = $("view-switch").querySelector(".u039-tabs");
function positionViewPill() {
  const active = viewTabs.querySelector('[aria-selected="true"]');
  const pill = viewTabs.querySelector(".u039-pill");
  pill.style.setProperty("--x",`${active.offsetLeft}px`);
  pill.style.setProperty("--w",`${active.offsetWidth}px`);
}
new ResizeObserver(positionViewPill).observe(viewTabs);
viewTabs.addEventListener("keydown",event => {
  if (!["ArrowLeft","ArrowRight","Home","End"].includes(event.key)) return;
  event.preventDefault();
  const mode = event.key === "Home" ? "original" : event.key === "End" ? "parsed" : reader.mode === "original" ? "parsed" : "original";
  changeMode(mode);
  $(mode === "original" ? "original-view" : "parsed-view").focus();
});

function renderReader() {
  const frame = ++reader.frame;
  clearTimeout(viewTimer);
  reader.renderTask?.cancel();
  reader.textLayer?.cancel();
  clearTextSelection();
  syncReader();
  positionViewPill();
  const isOriginal = reader.doc.kind === "pdf" && reader.mode === "original";
  readRoot.classList.toggle("show-pdf", isOriginal);
  if (isOriginal) {
    readRoot.replaceChildren(element("p", tr("正在載入 PDF…"), "reader-message"));
    renderPdf(frame).catch(() => {
      if (frame !== reader.frame) return;
      const notice = element("div", undefined, "reader-message");
      notice.append(element("p",tr("無法顯示原始 PDF。")), button(tr("切換至解析內容"), () => changeMode("parsed")));
      readRoot.replaceChildren(notice);
      $("reader-status").textContent = tr("無法顯示原始 PDF。");
    });
  } else {
    renderParsed();
  }
  $("reader").scrollTop = 0;
  if (!isOriginal && reader.target) {
    const block = $("block-" + reader.target.block);
    block?.classList.add("citation-block");
    block?.focus({preventScroll:true});
    block?.scrollIntoView({block:"center"});
  }
}

async function loadPdfEngine() {
  pdfjs ||= await import("/pdfjs/build/pdf.min.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/build/pdf.worker.min.mjs";
  return pdfjs;
}

function pdfDocument(engine,id) {
  return engine.getDocument({
    url:`/api/documents/${encodeURIComponent(id)}/pdf`, cMapUrl:"/pdfjs/cmaps/", cMapPacked:true,
    standardFontDataUrl:"/pdfjs/standard_fonts/", wasmUrl:"/pdfjs/wasm/", iccUrl:"/pdfjs/iccs/",
    isEvalSupported:false
  });
}

async function renderPdf(frame) {
  const engine = await loadPdfEngine();
  if (frame !== reader.frame) return;
  const loading = reader.loading ||= pdfDocument(engine,reader.doc.id);
  let pdf;
  try { pdf = await loading.promise; }
  catch (error) {
    if (reader.loading === loading) reader.loading = null;
    throw error;
  }
  if (frame !== reader.frame) return;
  reader.total = pdf.numPages;
  reader.page = Math.min(reader.page, reader.total);
  syncReader();
  const page = await pdf.getPage(reader.page);
  if (frame !== reader.frame) return;
  reader.renderWidth = readRoot.clientWidth;
  const scale = Math.max(1, Math.min(reader.renderWidth, 1100)) / page.getViewport({scale:1}).width;
  const viewport = page.getViewport({scale});
  const surface = element("div", undefined, "pdf-sheet");
  surface.style.setProperty("--total-scale-factor", viewport.scale);
  surface.style.width = `${viewport.width}px`;
  surface.style.height = `${viewport.height}px`;
  const canvas = element("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const ratio = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.ceil(viewport.width * ratio);
  canvas.height = Math.ceil(viewport.height * ratio);
  const layer = element("div", undefined, "textLayer");
  surface.append(canvas, layer);
  readRoot.replaceChildren(surface);
  reader.renderTask = page.render({canvas, viewport, transform:[ratio,0,0,ratio,0,0]});
  reader.textLayer = new pdfjs.TextLayer({textContentSource:page.streamTextContent(), container:layer, viewport});
  await Promise.all([reader.renderTask.promise, reader.textLayer.render()]);
  if (frame === reader.frame) {
    updateMarks();
    $("reader-status").textContent = `PDF ${pageLabel(reader.page)}`;
  }
}

new ResizeObserver(() => {
  const next = readRoot.clientWidth;
  if (!next || reader.mode !== "original" || !readRoot.querySelector(".pdf-sheet")) return;
  clearTimeout(viewTimer);
  if (next !== reader.renderWidth) viewTimer = setTimeout(renderReader, 140);
}).observe(readRoot);

function renderParsed() {
  const root = element("div", undefined, "parsed-page");
  for (const [i, block] of reader.doc.blocks.entries()) {
    if (reader.doc.kind === "pdf" && block.page !== (reader.unmapped ? null : reader.page)) continue;
    if (reader.doc.kind === "pdf" && ["footer","page_number"].includes(block.type)) continue;
    const wrap = element("div", undefined, "block");
    wrap.id = "block-" + i;
    wrap.dataset.block = i;
    wrap.tabIndex = -1;
    wrap.innerHTML = block.html;
    if (!wrap.firstChild) continue;
    for (const heading of wrap.querySelectorAll("h1,h2")) {
      const title = element("h3");
      title.append(...heading.childNodes);
      heading.replaceWith(title);
    }
    root.append(wrap);
  }
  readRoot.replaceChildren(root);
  if (!root.children.length) root.append(element("p",tr("這一頁沒有解析內容。"), "reader-message"));
  math(root);
  syncSelection();
  updateMarks();
  $("reader-status").textContent = reader.doc.kind !== "pdf" ? reader.doc.name :
    reader.unmapped ? tr("頁碼待核的解析內容") : `${pageLabel(reader.page)} · ${tr("解析內容")}`;
}

function changeMode(mode) {
  if (mode === reader.mode) return;
  reader.mode = mode;
  reader.unmapped = false;
  renderReader();
}

function goPage(page) {
  if (!Number.isInteger(page)) return;
  reader.page = Math.max(1, Math.min(reader.total, page));
  reader.target = null;
  reader.unmapped = false;
  renderReader();
}

$("original-view").onclick = () => changeMode("original");
$("parsed-view").onclick = () => changeMode("parsed");
$("page-prev").onclick = () => goPage(reader.page - 1);
$("page-next").onclick = () => goPage(reader.page + 1);
$("page-go").onsubmit = event => { event.preventDefault(); goPage($("page-number").valueAsNumber); };
$("unmapped-page").onclick = () => {
  reader.unmapped = !reader.unmapped;
  reader.target = null;
  renderReader();
};

function useReaderScope(quote = "", blocks = []) {
  let page = reader.doc.kind === "pdf" && !reader.unmapped ? reader.page : null;
  if (["note","personal"].includes(reader.doc.kind) && blocks.length) {
    const sourcePages = new Set(blocks.map(i => reader.doc.blocks[i].page));
    if (sourcePages.size === 1) [page] = sourcePages;
  }
  const label = reader.doc.name + (page ? ` · ${pageLabel(page)}` : "");
  const snippet = quote.trim().slice(0,400);
  setSelection({document_id:reader.doc.id, page, blocks, quote:snippet},
    label + (snippet ? ` · ${snippet.slice(0,90)}${snippet.length > 90 ? "…" : ""}` : ""));
  clearTextSelection();
  setRightPaneTab("tutor", true);
  showPanel("tutor");
}
$("ask-page").onclick = () => useReaderScope();
$("reader-notes").onclick = () => {
  const sourceId = originalDocument(reader.doc) || reader.doc?.id || null;
  openNotes(sourceId, "", reader.doc?.note_id || "").catch(report);
};
document.addEventListener("aita-language",() => {
  if (reader.doc) { syncReader(); positionViewPill(); }
});

let activeText;
let markStyle = "highlight";
let paintedMarks = [];
const selectionTools = $("selection-tools");
const annotationColors = ["yellow","green","blue","rose"];

function textNodes(root) {
  const tree = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement.closest(".katex-mathml") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  const nodes = [];
  while (tree.nextNode()) nodes.push(tree.currentNode);
  return nodes;
}

function readSelection() {
  const selection = window.getSelection();
  const content = readRoot.firstElementChild;
  if (!content || !selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!content.contains(range.startContainer) || !content.contains(range.endContainer)) return null;
  const blocks = [...content.querySelectorAll("[data-block]")].filter(b => range.intersectsNode(b)).map(b => Number(b.dataset.block));
  const nodes = textNodes(content);
  let start = 0;
  let end = 0;
  for (const node of nodes) {
    start += range.startContainer === node ? range.startOffset : range.comparePoint(node,0) < 0 ? node.length : 0;
    end += range.endContainer === node ? range.endOffset : range.comparePoint(node,node.length) <= 0 ? node.length : 0;
  }
  const text = nodes.map(n => n.nodeValue).join("");
  const quote = text.slice(start,end);
  if (!quote.trim()) return null;
  return {quote, blocks, start, prefix:text.slice(Math.max(0,start-32),start), suffix:text.slice(end,end+32),
    rect:range.getBoundingClientRect()};
}

function showTextTools(selection, x, y) {
  activeText = selection;
  if (selection.kind) markStyle = selection.kind;
  $("mark-styles").hidden = $("mark-colors").hidden = !CSS.highlights;
  $("note-text").hidden = !reader.doc;
  $("remove-mark").hidden = selection.index == null;
  $("mark-text").setAttribute("aria-pressed",String(markStyle === "highlight"));
  $("underline-text").setAttribute("aria-pressed",String(markStyle === "underline"));
  for (const btn of $("mark-colors").querySelectorAll("button")) btn.setAttribute("aria-pressed",String(btn.dataset.color === selection.color));
  if (!selectionTools.matches(":popover-open")) selectionTools.showPopover();
  const rect = selection.rect;
  const w = selectionTools.offsetWidth;
  const h = selectionTools.offsetHeight;
  const top = y ?? (rect.top > h + 8 ? rect.top - h - 8 : rect.bottom + 8);
  selectionTools.style.left = `${Math.max(8, Math.min(x ?? rect.left, innerWidth - w - 8))}px`;
  selectionTools.style.top = `${Math.max(8, Math.min(top, innerHeight - h - 8))}px`;
}

function hideTextTools() {
  activeText = null;
  if (selectionTools.matches(":popover-open")) selectionTools.hidePopover();
}

function clearTextSelection() {
  const selection = window.getSelection();
  if (selection?.anchorNode && readRoot.contains(selection.anchorNode)) selection.removeAllRanges();
  hideTextTools();
}

document.addEventListener("selectionchange", () => {
  const selection = readSelection();
  if (selection) showTextTools(selection);
  else if (activeText?.index == null && !selectionTools.contains(document.activeElement)) hideTextTools();
});
readRoot.addEventListener("contextmenu", event => {
  const selection = readSelection() || markAtPoint(event.clientX,event.clientY);
  if (!selection) return;
  event.preventDefault();
  showTextTools(selection, event.clientX, event.clientY);
  $("ask-text").focus();
});
readRoot.addEventListener("click", event => {
  if (readSelection() || event.target.closest("a,button")) return;
  const mark = markAtPoint(event.clientX,event.clientY);
  if (mark) showTextTools(mark);
});
document.addEventListener("pointerdown", event => {
  if (!selectionTools.contains(event.target) && activeText?.index != null) hideTextTools();
});
$("reader").addEventListener("keydown", event => {
  if (event.altKey && event.shiftKey && event.code === "KeyS" && activeText) {
    event.preventDefault();
    $("ask-text").focus();
  }
  if (event.key === "Escape" && activeText) {
    $("reader").focus({preventScroll:true});
    clearTextSelection();
  }
});
selectionTools.addEventListener("mousedown", event => event.preventDefault());
$("ask-text").onclick = () => {
  if (!activeText) return;
  // Keep a long cross-block selection page-scoped instead of dropping later blocks.
  useReaderScope(activeText.quote, activeText.blocks.length <= 40 ? activeText.blocks : []);
};
$("note-text").onclick = () => {
  if (!activeText) return;
  const page = reader.doc.kind === "pdf" && !reader.unmapped ? reader.page :
    reader.doc.blocks[activeText.blocks[0]]?.page;
  const snippet = `## ${tr("引用")}` + (page ? `\n<!-- page: ${page} -->` : "") + `\n\n${quoteLines(activeText.quote)}`;
  clearTextSelection();
  openNotes(originalDocument(reader.doc) || reader.doc?.id || null, snippet).catch(report);
};

function markKey() {
  const page = reader.doc.kind === "pdf" ? reader.unmapped ? "unmapped" : reader.page : "chapters";
  const view = reader.doc.kind === "pdf" && reader.mode === "original" ? ":original" : "";
  return `aita-marks:${reader.doc.id}:${page}${view}`;
}

function rangeAt(nodes, start, end) {
  const range = document.createRange();
  let offset = 0;
  let began = false;
  for (const node of nodes) {
    const next = offset + node.length;
    if (!began && start < next) {
      range.setStart(node,start-offset);
      began = true;
    }
    if (began && end <= next) {
      range.setEnd(node,end-offset);
      return range;
    }
    offset = next;
  }
  return null;
}

function updateMarks() {
  if (!CSS.highlights) return;
  const marks = readLocal(markKey(),[]);
  const root = readRoot.firstElementChild;
  const nodes = textNodes(root);
  const text = nodes.map(n => n.nodeValue).join("");
  const groups = Object.fromEntries(["highlight","underline"].flatMap(kind => annotationColors.map(color => [`aita-${kind}-${color}`,[]])));
  paintedMarks = [];
  for (const [index, mark] of marks.entries()) {
    const {quote, prefix, suffix, start, kind} = mark;
    const color = annotationColors.includes(mark.color) ? mark.color : "yellow";
    const context = prefix + quote + suffix;
    const first = text.indexOf(context);
    const at = text.slice(Math.max(0,start-prefix.length),start+quote.length+suffix.length) === context ? start :
      first >= 0 && text.indexOf(context, first+1) < 0 ? first + prefix.length : -1;
    const range = at < 0 ? null : rangeAt(nodes,at,at+quote.length);
    if (!range || !groups[`aita-${kind}-${color}`]) continue;
    groups[`aita-${kind}-${color}`].push(range);
    paintedMarks.push({...mark,color,range,index});
  }
  for (const [kind,ranges] of Object.entries(groups)) CSS.highlights.set(kind,new Highlight(...ranges));
}

function markAtPoint(x,y) {
  const mark = paintedMarks.findLast(item => [...item.range.getClientRects()].some(rect =>
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom));
  if (!mark) return null;
  const blocks = [...readRoot.querySelectorAll("[data-block]")].filter(b => mark.range.intersectsNode(b)).map(b => Number(b.dataset.block));
  return {...mark,blocks,rect:mark.range.getBoundingClientRect()};
}

function saveMark(color) {
  if (!activeText || !CSS.highlights) return;
  const {quote,prefix,suffix,start,index,blocks,rect} = activeText;
  const key = markKey();
  const marks = readLocal(key, []);
  const existing = index ?? marks.findIndex(m => m.start === start && m.quote === quote);
  const mark = {kind:markStyle,color,quote,prefix,suffix,start};
  if (existing >= 0) marks[existing] = mark;
  else marks.push(mark);
  saveLocal(key,marks);
  updateMarks();
  showTextTools({...mark,index:existing < 0 ? marks.length - 1 : existing,blocks,rect});
  window.getSelection()?.removeAllRanges();
  $("reader-status").textContent = tr(existing >= 0 ? "已更新畫記" : markStyle === "highlight" ? "已加入螢光標記" : "已加入底線");
}

function changeMarkStyle(style) {
  if (!activeText) return;
  markStyle = style;
  if (activeText.index != null) saveMark(activeText.color);
  else showTextTools(activeText);
}
$("mark-text").onclick = () => { try { changeMarkStyle("highlight"); } catch (error) { report(error); } };
$("underline-text").onclick = () => { try { changeMarkStyle("underline"); } catch (error) { report(error); } };
for (const btn of $("mark-colors").querySelectorAll("button")) {
  btn.onclick = () => { try { saveMark(btn.dataset.color); } catch (error) { report(error); } };
}
$("remove-mark").onclick = () => {
  if (activeText?.index == null) return;
  try {
    const key = markKey();
    saveLocal(key,readLocal(key,[]).filter((_,index) => index !== activeText.index));
    updateMarks();
    clearTextSelection();
    $("reader").focus({preventScroll:true});
    $("reader-status").textContent = tr("已移除標記");
  } catch (error) { report(error); }
};
