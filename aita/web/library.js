"use strict";

const inCatalog = location.pathname === "/library";
const catalog = $("catalog");
let catalogState = history.state?.catalog || {};
const sidebarGroups = {
  course: "課程教材",
  personal: "個人筆記"
};
const groupMaterialActionLabel = {
  course: "匯入課程教材",
  personal: "匯入個人文檔"
};

let folderExpanded = new Set(readLocal("aita-folders-expanded", []));
let folderGroups = readLocal("biibo-folder-groups", readLocal("biibo-folder-kinds", {}));
let groupExpanded = new Set(readLocal("biibo-groups-expanded", ["course", "personal"]));
let dragged = "";
let infoDocument;
let noteSource = null;
let noteExtra = "";
let noteEdition = "";
let noteRead = 0;
let noteDirty = false;
let noteViewMode = readLocal("biibo-note-view-mode", "edit");
if (!["edit", "split", "preview"].includes(noteViewMode)) noteViewMode = "edit";
let notePreviewTimer = 0;
let notePreviewSeq = 0;
let noteDeleteConfirmTimer = 0;

function normalizeGroup(value) {
  return value === "personal" ? "personal" : "course";
}

function docGroupOf(doc) {
  return doc?.kind === "personal" ? "personal" : "course";
}

function folderGroupOf(folder) {
  let cur = folder;
  const seen = new Set();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    const saved = folderGroups?.[cur.id];
    if (saved) return normalizeGroup(saved);
    cur = cur.parent_id ? state.folders.find(f => f.id === cur.parent_id) : null;
  }
  const direct = state.documents.find(d => d.folder_id === folder.id);
  if (direct) return docGroupOf(direct);
  return "course";
}

function folderOptions(placeholder, group = null) {
  const options = [new Option(tr(placeholder),"")];
  const pool = group ? state.folders.filter(f => folderGroupOf(f) === group) : state.folders;
  const poolIds = new Set(pool.map(f => f.id));
  function append(parent, path) {
    const children = parent === null
      ? pool.filter(f => !f.parent_id || !poolIds.has(f.parent_id))
      : pool.filter(f => f.parent_id === parent);
    for (const folder of children) {
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

function dropTarget(target, folder, targetGroup = null) {
  target.title = tr("放在這裡移動教材");
  target.addEventListener("dragover", event => {
    if (!dragged) return;
    const doc = state.documents.find(d => d.id === dragged);
    if (!doc || (targetGroup && docGroupOf(doc) !== targetGroup)) return;
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
    const doc = state.documents.find(d => d.id === id);
    if (!id || !doc || (targetGroup && docGroupOf(doc) !== targetGroup)) return;
    if (folder) folderExpanded.add(folder);
    try { saveLocal("aita-folders-expanded",[...folderExpanded]); } catch (error) { report(error); }
    amendDocument(id,{folder_id:folder}).catch(report);
  });
}

function openDocInfo(doc) {
  infoDocument = doc.id;
  $("doc-folder").replaceChildren(...folderOptions("未分類", docGroupOf(doc)));
  $("doc-folder").value = doc.folder_id || "";
  $("doc-summary").value = doc.summary || "";
  $("doc-info-status").textContent = "";
  $("doc-info-dialog").showModal();
}

function openFolderDialog(defaultGroup = "course") {
  const group = normalizeGroup(defaultGroup);
  $("folder-form").reset();
  $("folder-status").textContent = "";
  if ($("folder-kind")) $("folder-kind").value = group;
  $("folder-parent").replaceChildren(...folderOptions("此類別頂層", group));
  $("folder-dialog").showModal();
  $("folder-name").focus();
}

function docFormatBadge(doc) {
  if (doc.kind === "pdf") return { label: "PDF", cls: "badge-pdf" };
  if (doc.kind === "personal") return { label: tr("筆記"), cls: "badge-personal" };
  if (doc.kind === "note") return { label: tr("筆記"), cls: "badge-note" };
  if (/\.md$/i.test(doc.name || "")) return { label: "MD", cls: "badge-md" };
  return { label: "TXT", cls: "badge-txt" };
}

function materialsList(files) {
  const sorted = [...files].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  const list = element("ul");
  for (const doc of sorted) {
    const row = element("li",undefined, doc.pinned ? "material-row is-pinned" : "material-row");
    const link = element("button", undefined, "doc-link");
    link.type = "button";
    link.dataset.key = doc.id;
    link.draggable = true;
    link.setAttribute("aria-current",String(doc.id === state.document));
    const badge = docFormatBadge(doc);
    link.append(
      element("span", badge.label, `doc-badge ${badge.cls}`),
      element("span", doc.name, "doc-link-name")
    );
    if (doc.pinned) {
      const pin = element("span", undefined, "doc-pin-icon");
      pin.title = english() ? "Pinned overview note" : "置頂課程總覽筆記";
      pin.setAttribute("aria-label", pin.title);
      pin.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 3l5 5-2 2-2-1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4-1-2 2-2z"/></svg>`;
      link.append(pin);
    }
    link.addEventListener("click", () => Promise.resolve().then(() => openDocument(doc.id)).catch(report));
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

let activeKindMenu = null;
let activeKindTrigger = null;

function closeKindAddMenu() {
  if (activeKindMenu) {
    activeKindMenu.remove();
    activeKindMenu = null;
  }
  if (activeKindTrigger) {
    activeKindTrigger.setAttribute("aria-expanded", "false");
    activeKindTrigger = null;
  }
}

function triggerAddMaterialForGroup(group) {
  if (group === "personal") {
    openImportDialog("personal");
    return;
  }
  openImportDialog("course");
}

function openKindAddMenu(group, triggerBtn) {
  const togglingSame = activeKindTrigger === triggerBtn;
  closeKindAddMenu();
  if (togglingSame) return;

  const menu = element("div", undefined, "kind-add-menu");
  menu.id = "kind-add-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", `${tr("新增教材或子資料夾")} · ${tr(sidebarGroups[group])}`);

  const addDocBtn = element("button", undefined, "kind-add-option");
  addDocBtn.type = "button";
  addDocBtn.setAttribute("role", "menuitem");
  addDocBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15h6"/></svg>`;
  addDocBtn.append(element("span", tr(groupMaterialActionLabel[group] || "匯入教材")));
  addDocBtn.addEventListener("click", () => {
    closeKindAddMenu();
    triggerAddMaterialForGroup(group);
  });

  const addSubBtn = element("button", undefined, "kind-add-option");
  addSubBtn.type = "button";
  addSubBtn.setAttribute("role", "menuitem");
  addSubBtn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="M9 14h6"/></svg>`;
  addSubBtn.append(element("span", tr("建立子資料夾")));
  addSubBtn.addEventListener("click", () => {
    closeKindAddMenu();
    openFolderDialog(group);
  });

  menu.append(addDocBtn, addSubBtn);
  document.body.append(menu);

  const rect = triggerBtn.getBoundingClientRect();
  const menuW = menu.offsetWidth || 172;
  const menuH = menu.offsetHeight || 86;
  const left = Math.max(8, Math.min(rect.right - menuW, window.innerWidth - menuW - 8));
  const top = rect.bottom + menuH + 8 <= window.innerHeight
    ? rect.bottom + 6
    : Math.max(8, rect.top - menuH - 6);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  triggerBtn.setAttribute("aria-expanded", "true");
  activeKindMenu = menu;
  activeKindTrigger = triggerBtn;
  addDocBtn.focus();
}

document.addEventListener("pointerdown", event => {
  if (!activeKindMenu) return;
  if (activeKindMenu.contains(event.target) || activeKindTrigger?.contains(event.target)) return;
  closeKindAddMenu();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && activeKindMenu) {
    const trigger = activeKindTrigger;
    closeKindAddMenu();
    trigger?.focus();
  }
});
window.addEventListener("resize", closeKindAddMenu);
$("library")?.addEventListener("scroll", closeKindAddMenu, true);

function renderMaterials() {
  closeKindAddMenu();
  const root = $("materials");
  const content = document.createDocumentFragment();
  for (const [group, label] of Object.entries(sidebarGroups)) {
    const groupDocs = state.documents.filter(d => docGroupOf(d) === group);
    const groupFolders = state.folders.filter(f => folderGroupOf(f) === group);
    const groupFolderIds = new Set(groupFolders.map(f => f.id));
    const rootDocs = groupDocs.filter(d => !d.folder_id || !groupFolderIds.has(d.folder_id));
    const isEmpty = !groupDocs.length && !groupFolders.length;

    const section = element("details", undefined, isEmpty ? "kind-section is-empty" : "kind-section");
    section.dataset.group = group;
    section.open = isEmpty ? false : groupExpanded.has(group);

    const summary = element("summary", undefined, "kind-summary");
    dropTarget(summary, null, group);
    const chevron = element("span", undefined, "kind-chevron");
    chevron.setAttribute("aria-hidden", "true");
    const title = element("span", tr(label), "kind-title");
    const count = element("span", String(groupDocs.length), "kind-count");
    const addBtn = element("button", "＋", "kind-add-folder");
    addBtn.type = "button";
    addBtn.title = tr("新增教材或子資料夾");
    addBtn.setAttribute("aria-haspopup", "menu");
    addBtn.setAttribute("aria-expanded", "false");
    addBtn.setAttribute("aria-label", `${tr("新增教材或子資料夾")} · ${tr(label)}`);
    addBtn.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      openKindAddMenu(group, addBtn);
    });
    summary.append(chevron, title, count, addBtn);

    const body = element("div", undefined, "kind-body");
    if (rootDocs.length) {
      body.append(materialsList(rootDocs));
    }

    if (groupFolders.length) {
      function renderGroupFolders(parent, where) {
        const children = parent === null
          ? groupFolders.filter(f => !f.parent_id || !groupFolderIds.has(f.parent_id))
          : groupFolders.filter(f => f.parent_id === parent);
        for (const folder of children) {
          const node = element("details", undefined, "material-folder");
          node.dataset.folderId = folder.id;
          node.open = folderExpanded.has(folder.id);
          const heading = element("summary", folder.name);
          dropTarget(heading, folder.id, group);
          const files = groupDocs.filter(doc => doc.folder_id === folder.id);
          node.append(heading, materialsList(files));
          renderGroupFolders(folder.id, node);
          node.addEventListener("toggle", () => {
            if (node.open) folderExpanded.add(folder.id);
            else folderExpanded.delete(folder.id);
            try { saveLocal("aita-folders-expanded", [...folderExpanded]); } catch { /* The folder remains usable. */ }
          });
          where.append(node);
        }
      }
      renderGroupFolders(null, body);
    }

    section.addEventListener("toggle", () => {
      if (isEmpty && section.open) {
        section.open = false;
        return;
      }
      if (section.open) groupExpanded.add(group);
      else groupExpanded.delete(group);
      try { saveLocal("biibo-groups-expanded", [...groupExpanded]); } catch { /* The section remains usable. */ }
    });
    section.append(summary, body);
    content.append(section);
  }
  root.replaceChildren(content);
}

window.expandCourseFolder = (folderId) => {
  if (!folderId) return;
  groupExpanded.add("course");
  folderExpanded.add(folderId);
  try {
    saveLocal("biibo-groups-expanded", [...groupExpanded]);
    saveLocal("aita-folders-expanded", [...folderExpanded]);
  } catch { /* Keeps in-memory state. */ }
  renderMaterials();
  const folderNode = $("materials")?.querySelector(`.material-folder[data-folder-id="${CSS.escape(folderId)}"]`);
  if (folderNode) {
    folderNode.open = true;
    folderNode.scrollIntoView({ block: "nearest", behavior: "smooth" });
    folderNode.classList.add("is-spotlight");
    window.setTimeout(() => folderNode.classList.remove("is-spotlight"), 1400);
  }
};

$("folder-open").onclick = () => openFolderDialog("course");
$("folder-kind")?.addEventListener("change", () => {
  $("folder-parent").replaceChildren(...folderOptions("此類別頂層", $("folder-kind").value));
});
bindForm("folder-form",async () => {
  const group = normalizeGroup($("folder-kind")?.value || "course");
  const folder = await post("/api/folders",{name:$("folder-name").value,parent_id:$("folder-parent").value || null});
  folderGroups[folder.id] = group;
  groupExpanded.add(group);
  folderExpanded.add(folder.id);
  try {
    saveLocal("biibo-folder-groups", folderGroups);
    saveLocal("biibo-groups-expanded", [...groupExpanded]);
    saveLocal("aita-folders-expanded", [...folderExpanded]);
  } catch { /* Keeps in-memory classification for this session. */ }
  $("folder-dialog").close();
  await refreshDocuments();
},"folder-status","無法建立分類，請確認名稱後再試。");
bindForm("doc-info-form",async () => {
  await amendDocument(infoDocument,{summary:$("doc-summary").value,folder_id:$("doc-folder").value||null});
  $("doc-info-dialog").close();
},"doc-info-status","無法儲存教材資訊，請稍後再試。");

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
  const card = frame.closest(".catalog-card");
  const count = card.querySelector("[data-pages]");
  count.textContent = pagesLabel(preview.pages);
  const sep = card.querySelector(".meta-sep");
  if (sep) sep.textContent = preview.pages ? "·" : "";
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
  if (!docs.length) {
    if (!state.documents.length) {
      const card = element("div", undefined, "catalog-empty-card");
      const art = element("div", undefined, "empty-art empty-art-library");
      art.append(createMascotVideo("/static/assets/biibo-library-idle.mp4", "/static/assets/biibo-library-empty.jpg", "BIIBO"));
      const cta = button(tr("＋ 匯入教材"), () => $("import-dialog").showModal(), "primary");
      card.append(
        art,
        element("p", "Your Personal Tutor.", "brand-tagline"),
        element("h3", tr("尚未匯入教材。")),
        element("p", tr("匯入 PDF、Markdown 或 TXT，BIIBO 會陪你閱讀並標註可追溯來源。")),
        cta
      );
      items.append(card);
    } else {
      items.append(element("p", tr("找不到符合條件的教材。"), "empty"));
    }
  }
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
    const pageText = pagesLabel(doc.pages);
    const pageCount = element("span", pageText);
    pageCount.dataset.pages = "";
    const sep = element("span", pageText ? "·" : "", "meta-sep");
    sep.setAttribute("aria-hidden", "true");
    meta.append(element("span",tr(labels[doc.kind])), sep, pageCount);
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
  if (doc.kind === "pdf") return doc.id;
  return doc.original_id || null;
}

function quoteLines(text) { return text.trim().split("\n").map(line => "> " + line).join("\n"); }

function updateNoteWordCount() {
  const el = $("note-word-count");
  if (!el) return;
  const text = ($("note-body")?.value || "").replace(/\s+/g, "");
  el.textContent = english() ? `${text.length} ${tr("字")}` : `${text.length} 字`;
}

function setNoteDirty(dirty) {
  noteDirty = dirty;
  const status = $("note-status");
  if (!status) return;
  if (dirty) status.textContent = tr("草稿尚未儲存。");
}

function updateNoteSourceLabel() {
  const sourceEl = $("note-source");
  if (!sourceEl) return;
  if (noteSource) {
    const doc = state.documents.find(d => d.id === noteSource);
    sourceEl.textContent = tr("來源") + " · " + (doc?.name || noteSource);
  } else {
    sourceEl.textContent = tr("獨立筆記");
  }
}

function resetDeleteConfirm() {
  window.clearTimeout(noteDeleteConfirmTimer);
  const del = $("note-delete");
  if (!del) return;
  del.dataset.confirm = "";
  del.classList.remove("is-confirming");
  del.title = tr("刪除筆記");
  del.setAttribute("aria-label", tr("刪除筆記"));
}

function fillNotePicker() {
  const picker = $("note-picker");
  if (!picker) return;
  const allPersonal = state.documents.filter(doc => doc.kind === "personal" && doc.note_id);
  const linked = noteSource ? allPersonal.filter(doc => doc.original_id === noteSource) : allPersonal;
  const others = noteSource ? allPersonal.filter(doc => doc.original_id !== noteSource) : [];
  const opts = [new Option(tr("新增筆記"), "")];
  for (const doc of linked) opts.push(new Option(doc.name, doc.note_id));
  for (const doc of others) opts.push(new Option(`· ${doc.name}`, doc.note_id));
  picker.replaceChildren(...opts);
  if (noteEdition && [...picker.options].some(o => o.value === noteEdition)) {
    picker.value = noteEdition;
  } else {
    picker.value = "";
  }
}

async function refreshNotePreview() {
  const preview = $("note-preview");
  if (!preview) return;
  const markdown = $("note-body").value;
  if (!markdown.trim()) {
    preview.replaceChildren(element("p", tr("尚未輸入內容，開始撰寫後即可即時預覽。"), "notes-preview-empty"));
    return;
  }
  const seq = ++notePreviewSeq;
  try {
    const rendered = await post("/api/markdown/preview", { markdown });
    if (seq !== notePreviewSeq) return;
    preview.innerHTML = rendered.html;
    math(preview);
  } catch (error) {
    if (seq === notePreviewSeq) report(error);
  }
}

function scheduleNotePreview() {
  if (noteViewMode === "edit") return;
  window.clearTimeout(notePreviewTimer);
  notePreviewTimer = window.setTimeout(() => {
    refreshNotePreview().catch(report);
  }, 240);
}

function setNoteViewMode(mode) {
  if (!["edit", "split", "preview"].includes(mode)) return;
  noteViewMode = mode;
  try { saveLocal("biibo-note-view-mode", mode); } catch { /* Keeps session state. */ }
  const ws = $("notes-workspace");
  if (ws) ws.dataset.view = mode;
  for (const btn of document.querySelectorAll("[data-note-view]")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.noteView === mode));
  }
  if (mode !== "edit") {
    refreshNotePreview().catch(report);
  }
}

async function openNotes(sourceId = null, snippet = "", noteId = "") {
  const normalizedSource = sourceId || null;
  if (typeof window.setRightPaneTab === "function") window.setRightPaneTab("notes", true);
  noteSource = normalizedSource;
  noteExtra = snippet || "";
  updateNoteSourceLabel();
  fillNotePicker();
  resetDeleteConfirm();

  if (noteId) {
    await pickNote(noteId);
  } else if (snippet && noteEdition) {
    // Append clipped quote/turn into currently active note instead of overwriting it.
    const body = $("note-body");
    body.value = [body.value.trimEnd(), snippet].filter(Boolean).join("\n\n");
    noteExtra = "";
    setNoteDirty(true);
    updateNoteWordCount();
    scheduleNotePreview();
    body.focus();
    body.setSelectionRange(body.value.length, body.value.length);
    return;
  } else {
    const linkedFirst = normalizedSource
      ? state.documents.find(doc => doc.kind === "personal" && doc.original_id === normalizedSource && doc.note_id)
      : null;
    if (linkedFirst && !snippet) {
      await pickNote(linkedFirst.note_id);
    } else if (linkedFirst && snippet) {
      await pickNote(linkedFirst.note_id);
    } else {
      await pickNote("");
      if (normalizedSource && !$("note-title").value) {
        const docName = state.documents.find(d => d.id === normalizedSource)?.name?.replace(/\.(pdf|md|txt)$/i, "") || "";
        if (docName) $("note-title").value = english() ? `${docName} Notes` : `${docName} 筆記`;
      }
    }
  }
  if (snippet) setNoteDirty(true);
  const focusTarget = $("note-title").value ? $("note-body") : $("note-title");
  if (noteViewMode !== "preview") focusTarget.focus();
}

async function pickNote(key) {
  const request = ++noteRead;
  resetDeleteConfirm();
  const old = key ? await get(`/api/notes/${encodeURIComponent(key)}`) : null;
  if (request !== noteRead) return;
  noteEdition = key || "";
  if (old && old.original_id !== undefined && !noteSource) {
    noteSource = old.original_id || null;
    updateNoteSourceLabel();
  }
  $("note-picker").value = noteEdition;
  $("note-title").value = old?.title || "";
  $("note-body").value = [old?.markdown, noteExtra].filter(Boolean).join("\n\n");
  $("note-delete").hidden = !noteEdition;
  $("note-status").textContent = noteExtra ? tr("草稿尚未儲存。") : "";
  noteDirty = Boolean(noteExtra);
  noteExtra = "";
  updateNoteWordCount();
  if (noteViewMode !== "edit") refreshNotePreview().catch(report);
}

window.syncNotesWithReader = () => {
  if (noteDirty) return;
  const doc = window.reader?.doc;
  if (!doc) return;
  const sourceId = originalDocument(doc) || doc.id || null;
  if (doc.kind === "personal" && doc.note_id) {
    if (noteEdition !== doc.note_id) openNotes(sourceId, "", doc.note_id).catch(report);
    return;
  }
  if (noteSource !== sourceId) {
    noteSource = sourceId;
    updateNoteSourceLabel();
    fillNotePicker();
    const linkedFirst = state.documents.find(d => d.kind === "personal" && d.original_id === sourceId && d.note_id);
    if (linkedFirst) pickNote(linkedFirst.note_id).catch(report);
  }
};

async function noteFromTurn(turn, citation) {
  const source = citation?.source_id || originalDocument(reader.doc) || reader.doc?.id || null;
  const page = citation?.page || (reader.doc?.kind === "pdf" ? reader.page : null);
  const header = `## ${tr("問助教")}` + (page ? `\n<!-- page: ${page} -->` : "");
  const evidence = citation?.excerpt ? `\n\n**${tr("來源")}** · ${citation.source_name}\n\n${quoteLines(citation.excerpt)}` : "";
  await openNotes(source, `${header}\n\n**${tr("問題")}**\n\n${quoteLines(turn.question)}\n\n**${tr("回覆")}**\n\n${quoteLines(turn.answer)}${evidence}`);
}

function applyMarkdownAction(action) {
  const area = $("note-body");
  if (!area) return;
  if (noteViewMode === "preview") setNoteViewMode("edit");
  const startPos = area.selectionStart;
  const endPos = area.selectionEnd;
  const selected = area.value.slice(startPos, endPos);
  const linePrefix = startPos > 0 && area.value[startPos - 1] !== "\n" ? "\n" : "";

  const templates = {
    h1: [linePrefix + "# ", "", "標題"],
    h2: [linePrefix + "## ", "", "小節標題"],
    h3: [linePrefix + "### ", "", "重點標題"],
    bold: ["**", "**", "粗體文字"],
    italic: ["*", "*", "斜體文字"],
    strike: ["~~", "~~", "刪除文字"],
    code: ["`", "`", "code"],
    list: [linePrefix + "- ", "\n", "重點項目"],
    olist: [linePrefix + "1. ", "\n", "步驟項目"],
    task: [linePrefix + "- [ ] ", "\n", "待辦事項"],
    quote: [linePrefix + "> ", "\n", "引用重點"],
    codeblock: [linePrefix + "```\n", "\n```\n", "// 程式碼"],
    math: [linePrefix + "$$\n", "\n$$\n", "E = mc^2"],
    table: [linePrefix + "| 欄位 1 | 欄位 2 |\n| --- | --- |\n| ", " | 內容 |\n", "內容"],
    link: ["[", "](https://)", "連結文字"],
    hr: [linePrefix + "\n---\n\n", "", ""],
    page: () => {
      const p = window.reader?.doc?.kind === "pdf" && !window.reader.unmapped ? window.reader.page : 1;
      return [`${linePrefix}<!-- page: ${p} -->\n**P.${p}** `, "", ""];
    }
  };

  const entry = typeof templates[action] === "function" ? templates[action]() : templates[action];
  if (!entry) return;
  const [before, after, placeholder] = entry;
  const inner = selected || placeholder;
  const replacement = before + inner + after;
  area.setRangeText(replacement, startPos, endPos, "select");
  const innerStart = startPos + before.length;
  const innerEnd = innerStart + inner.length;
  area.focus();
  area.setSelectionRange(innerStart, innerEnd);
  setNoteDirty(true);
  updateNoteWordCount();
  scheduleNotePreview();
}

window.insertIntoPersonalNote = (markdownText, mode = "cursor") => {
  const area = $("note-body");
  if (!area || !markdownText) return;
  if (noteViewMode === "preview") setNoteViewMode("edit");
  const clean = markdownText.trim();
  if (!clean) return;
  if (mode === "append" || !area.value.trim()) {
    area.value = [area.value.trimEnd(), clean].filter(Boolean).join("\n\n");
    const end = area.value.length;
    area.focus();
    area.setSelectionRange(end, end);
  } else {
    const start = area.selectionStart ?? area.value.length;
    const end = area.selectionEnd ?? area.value.length;
    const before = area.value.slice(0, start);
    const after = area.value.slice(end);
    const lead = before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
    const trail = after && !after.startsWith("\n\n") ? (after.startsWith("\n") ? "\n" : "\n\n") : "";
    const inserted = `${lead}${clean}${trail}`;
    area.setRangeText(inserted, start, end, "end");
    area.focus();
  }
  if (!$("note-title").value.trim() && window.reader?.doc?.name) {
    const base = window.reader.doc.name.replace(/\.(pdf|md|txt)$/i, "");
    $("note-title").value = english() ? `${base} Notes` : `${base} 筆記`;
  }
  setNoteDirty(true);
  updateNoteWordCount();
  scheduleNotePreview();
};

function exportCurrentNote() {
  const title = ($("note-title")?.value || "").trim() || "biibo-note";
  const body = $("note-body")?.value || "";
  if (!body.trim()) {
    $("note-status").textContent = tr("請填寫筆記標題和內容。");
    return;
  }
  const safeName = title.replace(/[\\/:*?"<>|]+/g, "_");
  const filename = /\.md$/i.test(safeName) ? safeName : `${safeName}.md`;
  const blob = new Blob([body], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = element("a");
  link.download = filename;
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function deleteCurrentNote() {
  if (!noteEdition) return;
  const del = $("note-delete");
  if (del.dataset.confirm !== "1") {
    del.dataset.confirm = "1";
    del.classList.add("is-confirming");
    del.title = english() ? "Click again to delete" : "再次點擊確認刪除";
    $("note-status").textContent = english() ? "Click delete again to confirm" : "再次點擊垃圾桶確認刪除";
    noteDeleteConfirmTimer = window.setTimeout(resetDeleteConfirm, 3500);
    return;
  }
  resetDeleteConfirm();
  const targetId = noteEdition;
  try {
    await api(`/api/notes/${encodeURIComponent(targetId)}`, { method: "DELETE" });
    noteEdition = "";
    noteDirty = false;
    await refreshDocuments();
    fillNotePicker();
    await pickNote("");
    $("note-status").textContent = tr("已刪除筆記");
  } catch (error) {
    report(error, "無法刪除筆記，請稍後再試。");
  }
}

$("note-picker")?.addEventListener("change", () => pickNote($("note-picker").value).catch(report));
$("note-new")?.addEventListener("click", () => {
  pickNote("").then(() => {
    if (noteSource) {
      const docName = state.documents.find(d => d.id === noteSource)?.name?.replace(/\.(pdf|md|txt)$/i, "") || "";
      if (docName) $("note-title").value = english() ? `${docName} Notes` : `${docName} 筆記`;
    }
    if (noteViewMode === "preview") setNoteViewMode("edit");
    $("note-title").focus();
    $("note-title").select();
  }).catch(report);
});
$("note-export")?.addEventListener("click", exportCurrentNote);
$("note-delete")?.addEventListener("click", () => deleteCurrentNote().catch(report));

for (const btn of document.querySelectorAll("[data-note-view]")) {
  btn.addEventListener("click", () => setNoteViewMode(btn.dataset.noteView));
}
for (const action of $("note-toolbar").querySelectorAll("[data-markdown]")) {
  action.addEventListener("click", () => applyMarkdownAction(action.dataset.markdown));
}
$("note-title")?.addEventListener("input", () => setNoteDirty(true));
$("note-body")?.addEventListener("input", () => {
  setNoteDirty(true);
  updateNoteWordCount();
  scheduleNotePreview();
});
$("note-body")?.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
    const key = event.key.toLowerCase();
    if (key === "b") { event.preventDefault(); applyMarkdownAction("bold"); }
    else if (key === "i") { event.preventDefault(); applyMarkdownAction("italic"); }
    else if (key === "s") { event.preventDefault(); $("notes-form").requestSubmit($("note-save")); }
  } else if (event.key === "Tab") {
    event.preventDefault();
    const area = $("note-body");
    const pos = area.selectionStart;
    area.setRangeText("  ", pos, area.selectionEnd, "end");
    setNoteDirty(true);
    updateNoteWordCount();
    scheduleNotePreview();
  }
});

setNoteViewMode(noteViewMode);
updateNoteWordCount();
document.addEventListener("aita-language", () => {
  updateNoteSourceLabel();
  fillNotePicker();
  updateNoteWordCount();
});

bindForm("notes-form", async () => {
  const note = await post("/api/notes", {
    id: noteEdition || null,
    original_id: noteSource || null,
    title: $("note-title").value,
    markdown: $("note-body").value
  });
  noteEdition = note.id;
  noteExtra = "";
  noteDirty = false;
  await refreshDocuments();
  fillNotePicker();
  $("note-picker").value = note.id;
  $("note-delete").hidden = false;
  $("note-status").textContent = tr("已儲存筆記");
  if (noteViewMode !== "edit") refreshNotePreview().catch(report);
  if (reader.doc?.note_id === note.id) await openDocument(note.document_id);
}, "note-status", "無法儲存筆記，請確認標題與內容後再試。");

if (inCatalog) {
  layout.hidden = true;
  catalog.hidden = false;
  document.body.classList.add("catalog-mode");
  $("library-link").setAttribute("aria-current","location");
  document.querySelector(".skip").href = "#catalog";
  for (const a of document.querySelectorAll('.narrow-nav a[href^="#"]')) {
    a.href = "/" + a.hash;
    a.removeAttribute("aria-current");
  }
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
