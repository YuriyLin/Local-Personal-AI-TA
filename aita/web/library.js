"use strict";

const inCatalog = location.pathname === "/library";
const catalog = $("catalog");
let catalogState = history.state?.catalog || {};
let folderExpanded = new Set(readLocal("aita-folders-expanded", []));
let dragged = "";
let infoDocument;
let noteSource;
let noteExtra = "";
let noteEdition = "";
let noteRead = 0;

function folderOptions(placeholder) {
  const options = [new Option(tr(placeholder),"")];
  function append(parent, path) {
    for (const folder of state.folders.filter(f => f.parent_id === parent)) {
      options.push(new Option(path + folder.name,folder.id));
      append(folder.id,path + folder.name + " / ");
    }
  }
  append(null, "");
  return options;
}

async function amendDocument(id, changes) {
  await api(`/api/documents/${id}/info`, {method:"PATCH",...json(changes)});
  await refreshDocuments();
}

function dropTarget(target, folder) {
  target.title = tr("放在這裡移動教材");
  target.addEventListener("dragover", event => {
    if (!dragged) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    target.classList.add("drop-target");
  });
  target.addEventListener("dragleave", () => target.classList.remove("drop-target"));
  target.addEventListener("drop", event => {
    event.preventDefault();
    target.classList.remove("drop-target");
    const id = dragged;
    dragged = "";
    if (!id || !state.documents.some(d => d.id === id)) return;
    if (folder) folderExpanded.add(folder);
    try { saveLocal("aita-folders-expanded",[...folderExpanded]); } catch (error) { report(error); }
    amendDocument(id,{folder_id:folder}).catch(report);
  });
}

function openDocInfo(doc) {
  infoDocument = doc.id;
  $("doc-folder").replaceChildren(...folderOptions("未分類"));
  $("doc-folder").value = doc.folder_id || "";
  $("doc-summary").value = doc.summary || "";
  $("doc-info-status").textContent = "";
  $("doc-info-dialog").showModal();
}

function materialsList(files) {
  const list = element("ul");
  for (const doc of files) {
    const row = element("li",undefined,"material-row");
    const link = button(doc.name,() => openDocument(doc.id),"doc-link");
    link.dataset.key = doc.id;
    link.draggable = true;
    link.setAttribute("aria-current",String(doc.id === state.document));
    link.addEventListener("dragstart",event => {
      dragged = doc.id;
      event.dataTransfer.setData("text/plain",doc.name);
      event.dataTransfer.effectAllowed = "move";
    });
    link.addEventListener("dragend",() => {
      dragged = "";
      document.querySelectorAll(".drop-target").forEach(target => target.classList.remove("drop-target"));
    });
    const move = button("⋯",() => openDocInfo(doc),"material-move");
    move.setAttribute("aria-label",tr("移動教材") + " · " + doc.name);
    row.append(link,move);
    list.append(row);
  }
  return list;
}

function renderMaterials() {
  const root = $("materials");
  const content = document.createDocumentFragment();
  function renderFolders(parent, where) {
    for (const folder of state.folders.filter(f => f.parent_id === parent)) {
      const node = element("details",undefined,"material-folder");
      node.open = folderExpanded.has(folder.id);
      const heading = element("summary",folder.name);
      dropTarget(heading,folder.id);
      const files = state.documents.filter(doc => doc.folder_id === folder.id);
      node.append(heading,materialsList(files));
      renderFolders(folder.id,node);
      node.addEventListener("toggle",() => {
        if (node.open) folderExpanded.add(folder.id);
        else folderExpanded.delete(folder.id);
        try { saveLocal("aita-folders-expanded",[...folderExpanded]); } catch { /* The folder remains usable. */ }
      });
      where.append(node);
    }
  }
  if (state.folders.length) {
    content.append(element("h3",tr("分類")));
    renderFolders(null,content);
  }
  for (const [kind,label] of Object.entries(labels)) {
    const items = state.documents.filter(d => d.kind === kind && !d.folder_id);
    if (!items.length && !state.folders.length) continue;
    const heading = element("h3",tr(label));
    dropTarget(heading,null);
    content.append(heading,materialsList(items));
  }
  if (!state.documents.length) content.append(element("p",tr("尚未匯入教材。"),"small"));
  root.replaceChildren(content);
}

$("folder-open").onclick = () => {
  $("folder-form").reset();
  $("folder-status").textContent = "";
  $("folder-parent").replaceChildren(...folderOptions("根目錄"));
  $("folder-dialog").showModal();
};
bindForm("folder-form",async () => {
  const folder = await post("/api/folders",{name:$("folder-name").value,parent_id:$("folder-parent").value || null});
  folderExpanded.add(folder.id);
  $("folder-dialog").close();
  await refreshDocuments();
},"folder-status");
bindForm("doc-info-form",async () => {
  await amendDocument(infoDocument,{summary:$("doc-summary").value,folder_id:$("doc-folder").value||null});
  $("doc-info-dialog").close();
},"doc-info-status");

const previewJobs = new Map();
const thumbs = new IntersectionObserver(entries => {
  for (const entry of entries) if (entry.isIntersecting) {
    thumbs.unobserve(entry.target);
    drawThumbnail(entry.target).catch(() => {});
  }
},{rootMargin:"120px"});

async function drawThumbnail(frame) {
  const id = frame.dataset.document;
  const key = `aita-thumbnail:${id}`;
  const cached = readLocal(key,null);
  if (!previewJobs.has(id)) previewJobs.set(id,cached ? Promise.resolve(cached) : makeThumbnail(id));
  let preview;
  try { preview = await previewJobs.get(id); }
  catch (error) { previewJobs.delete(id); throw error; }
  if (!frame.isConnected) return;
  const img = element("img");
  img.alt = "";
  img.src = preview.data;
  frame.replaceChildren(img);
  const count = frame.closest(".catalog-card").querySelector("[data-pages]");
  count.textContent = pagesLabel(preview.pages);
}

async function makeThumbnail(id) {
  const engine = await loadPdfEngine();
  const task = pdfDocument(engine,id);
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    const base = page.getViewport({scale:1});
    const viewport = page.getViewport({scale:Math.min(540/base.width,520/base.height)});
    const canvas = element("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({canvas,viewport}).promise;
    const preview = {data:canvas.toDataURL("image/webp",.79),pages:pdf.numPages};
    try { saveLocal(`aita-thumbnail:${id}`,preview); } catch { /* Cache remains in this tab. */ }
    return preview;
  } finally { await task.destroy(); }
}

const pagesLabel = pages => pages ? english() ? `${pages} pages` : `${pages} 頁` : "";
const relatedLabel = count => english() ? `${count} related ${count === 1 ? "note" : "notes"}` : `${count} 份相關筆記`;
const resumeLabel = page => english() ? `Continue reading · ${pageLabel(page)}` : `繼續閱讀 · ${pageLabel(page)}`;

function saveCatalogPosition() {
  if (!inCatalog) return;
  catalogState = {search:$("library-search").value,kind:$("library-kind").value,
    related:catalogState.related || "",scroll:window.scrollY};
  history.replaceState({catalog:catalogState},"");
}

function renderLibrary() {
  if (!inCatalog) return;
  thumbs.disconnect();
  const filter = $("library-kind").value;
  const query = $("library-search").value.trim().toLocaleLowerCase();
  const related = catalogState.related;
  const order = Object.keys(labels);
  const docs = state.documents.filter(doc => (!filter || doc.kind === filter) && (!related || doc.original_id === related) &&
    `${doc.name}\n${doc.summary || ""}`.toLocaleLowerCase().includes(query))
    .sort((a,b) => order.indexOf(a.kind)-order.indexOf(b.kind) || a.name.localeCompare(b.name));
  $("clear-related").hidden = !related;
  const items = $("catalog-documents");
  items.replaceChildren();
  if (!state.documentsReady) {
    const loading = element("p",tr("載入教材中…"),"small");
    loading.setAttribute("role","status");
    items.append(loading);
    return;
  }
  if (!docs.length) items.append(element("p",tr(state.documents.length ? "找不到符合條件的教材。" : "尚未匯入教材。"),"empty"));
  for (const doc of docs) {
    const card = element("article",undefined,"catalog-card");
    const url = `/?document=${encodeURIComponent(doc.id)}`;
    const cover = element("a",undefined,"catalog-cover");
    cover.href = url;
    cover.setAttribute("aria-label",tr("開啟教材") + " · " + doc.name);
    cover.addEventListener("click",saveCatalogPosition);
    if (doc.kind === "pdf") {
      cover.dataset.document = doc.id;
      cover.classList.add("pdf-cover");
      cover.append(element("span","PDF"));
    } else {
      const preview = doc.preview || "";
      const heading = /^#+\s+([^\n]+)/.exec(preview);
      cover.append(element("strong",heading?.[1] || doc.name),
        element("span",preview.slice(heading?.[0].length || 0).replace(/^#+\s*/gm,"").trim().slice(0,180) || tr(labels[doc.kind])));
    }
    const content = element("div",undefined,"catalog-content");
    const meta = element("p",undefined,"small catalog-meta");
    const pageCount = element("span",pagesLabel(doc.pages));
    pageCount.dataset.pages = "";
    meta.append(element("span",tr(labels[doc.kind])),pageCount);
    const name = element("h3");
    const title = element("a",doc.name);
    title.href = url;
    title.addEventListener("click",saveCatalogPosition);
    name.append(title);
    const summary = element("p",doc.summary || tr("尚未填寫概述"),"catalog-summary");
    const actions = element("div",undefined,"catalog-actions");
    const resume = readLocal(`aita-reading:${doc.id}`,null);
    const open = element("a",doc.kind === "pdf" && resume?.page ? resumeLabel(resume.page) : tr("開啟教材"),"button-link primary");
    open.href = url;
    open.addEventListener("click",saveCatalogPosition);
    actions.append(open,button(tr("編輯概述"),() => openDocInfo(doc)));
    const count = state.documents.filter(item => item.original_id === doc.id).length;
    if (count) actions.append(button(relatedLabel(count),() => {
      catalogState.related = doc.id;
      $("library-kind").value = "";
      $("library-search").value = "";
      window.scrollTo(0,0);
      saveCatalogPosition();
      renderLibrary();
      $("clear-related").focus();
    }));
    content.append(meta,name,summary,actions);
    card.append(cover,content);
    items.append(card);
    if (doc.kind === "pdf") thumbs.observe(cover);
  }
}

function applyCatalogFilters() {
  $("library-search").value = catalogState.search || "";
  $("library-kind").value = catalogState.kind || "";
}

$("library-search").oninput = $("library-kind").onchange = () => { saveCatalogPosition(); renderLibrary(); };
$("clear-related").onclick = () => {
  catalogState.related = "";
  saveCatalogPosition();
  renderLibrary();
  $("library-search").focus();
};

function originalDocument(doc) {
  if (!doc) return null;
  return doc.kind === "pdf" ? doc.id : doc.original_id;
}

function quoteLines(text) { return text.trim().split("\n").map(line => "> " + line).join("\n"); }

async function openNotes(originalId, snippet = "", noteId = "") {
  if (!originalId) throw Error("請先開啟原始 PDF 或選擇有 PDF 來源的引用。");
  noteSource = originalId;
  noteExtra = snippet;
  $("note-source").textContent = tr("來源") + " · " + (state.documents.find(d => d.id === originalId)?.name || originalId);
  fillNotePicker();
  await pickNote(noteId);
  if (!$("notes-dialog").open) $("notes-dialog").showModal();
  $(noteId ? "note-body" : "note-title").focus();
}

function fillNotePicker() {
  const options = state.documents.filter(doc => doc.kind === "personal" && doc.original_id === noteSource);
  $("note-picker").replaceChildren(new Option(tr("新增筆記"),""),...options.map(doc => new Option(doc.name,doc.note_id)));
}

async function pickNote(key) {
  const request = ++noteRead;
  const old = key ? await get(`/api/notes/${encodeURIComponent(key)}`) : null;
  if (request !== noteRead) return;
  noteEdition = key;
  $("note-picker").value = key;
  $("note-title").value = old?.title || "";
  $("note-body").value = [old?.markdown,noteExtra].filter(Boolean).join("\n\n");
  $("note-status").textContent = "";
  toggleNotePreview(false);
}

async function noteFromTurn(turn,citation) {
  const source = citation?.source_id || originalDocument(reader.doc);
  const page = citation?.page || (reader.doc?.kind === "pdf" ? reader.page : null);
  const header = `## ${tr("問助教")}` + (page ? `\n<!-- page: ${page} -->` : "");
  const evidence = citation?.excerpt ? `\n\n**${tr("來源")}** · ${citation.source_name}\n\n${quoteLines(citation.excerpt)}` : "";
  await openNotes(source,`${header}\n\n**${tr("問題")}**\n\n${quoteLines(turn.question)}\n\n**${tr("回覆")}**\n\n${quoteLines(turn.answer)}${evidence}`);
}

async function toggleNotePreview(show) {
  if (show) {
    const preview = await post("/api/markdown/preview",{markdown:$("note-body").value});
    $("note-preview").innerHTML = preview.html;
    math($("note-preview"));
  }
  $("preview-note").setAttribute("aria-pressed",String(show));
  $("note-preview").hidden = !show;
}

$("note-picker").onchange = () => pickNote($("note-picker").value).catch(report);
$("preview-note").onclick = () => toggleNotePreview($("note-preview").hidden).catch(report);
for (const action of $("note-toolbar").querySelectorAll("[data-markdown]")) {
  action.onclick = () => {
    const area = $("note-body");
    const selected = area.value.slice(area.selectionStart,area.selectionEnd);
    const [start,end] = {heading:["\n## ","\n"],bold:["**","**"],list:["\n- ","\n"],
      quote:["\n> ","\n"],code:["`","`"]}[action.dataset.markdown];
    area.setRangeText(start+selected+end,area.selectionStart,area.selectionEnd,"end");
    area.focus();
  };
}

bindForm("notes-form",async () => {
  const note = await post("/api/notes",{id:noteEdition||null,original_id:noteSource,title:$("note-title").value,markdown:$("note-body").value});
  noteEdition = note.id;
  noteExtra = "";
  await refreshDocuments();
  fillNotePicker();
  $("note-picker").value = note.id;
  $("note-status").textContent = tr("已儲存筆記");
  if (reader.doc?.note_id === note.id) await openDocument(note.document_id);
},"note-status");

if (inCatalog) {
  layout.hidden = true;
  catalog.hidden = false;
  document.body.classList.add("catalog-mode");
  $("library-link").setAttribute("aria-current","location");
  document.querySelector(".skip").href = "#catalog";
  for (const a of document.querySelectorAll('.masthead nav a[href^="#"]')) a.href = "/" + a.hash;
  history.scrollRestoration = "manual";
  applyCatalogFilters();
  window.addEventListener("pagehide",saveCatalogPosition);
  window.addEventListener("pageshow",() => {
    requestAnimationFrame(() => {
      catalogState = history.state?.catalog || {};
      applyCatalogFilters();
      renderLibrary();
      window.scrollTo(0,catalogState.scroll || 0);
    });
  });
}

Promise.all([refreshJobs(),refreshChats(),loadPreferences()]).then(async () => {
  if (inCatalog) { requestAnimationFrame(() => window.scrollTo(0,catalogState.scroll || 0)); return; }
  const initial = new URLSearchParams(location.search).get("document");
  if (initial) await openDocument(initial);
  else if (["#reader","#tutor"].includes(location.hash)) showPanel(location.hash.slice(1));
}).catch(report);
