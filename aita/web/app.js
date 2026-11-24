"use strict";
const $ = id => document.getElementById(id);
const state = {documents: [], chats: [], records: [], conversation: "", document: "", selected: "", turns: []};
const labels = {pdf:"原始 PDF",note:"課程筆記",personal:"個人筆記",text:"文字教材"};
const modes = {hint:"先給提示",concept:"解釋概念",debug:"協助除錯"};
const json = data => ({headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});

async function api(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Error(typeof error.detail === "string" ? tr(error.detail) : `${tr("請求未完成")} (${response.status}).`);
  }
  return response;
}
const get = async url => (await api(url)).json();
const post = async (url, data) => (await api(url, {method:"POST",...json(data)})).json();
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
function report(error) {
  $("error").textContent = tr(error.message);
  $("error").hidden = false;
}
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
}
function showTurns() {
  const area = $("turns");
  area.replaceChildren();
  if (!state.turns.length) area.append(element("p",tr("這裡會顯示你的提問、助教回覆與來源。也可以先從教材選一段。"),"empty-chat"));
  for (const turn of state.turns) {
    const w = element("div",undefined,"turn");
    w.append(element("h3",tr("你")),element("p",turn.question),element("h3",tr("助教")));
    const answer = element("div");
    answer.innerHTML = turn.html;
    w.append(answer);
    if (turn.citations?.length) {
      const sources = element("div",undefined,"sources");
      for (const c of turn.citations) {
        const location = c.page ? "PDF " + pageLabel(c.page) : tr("教材段落");
        const label = c.document_kind === "personal" ? tr("個人筆記") + " · " + location : location;
        sources.append(button(c.label + " · " + label,() => openDocument(c.document_id,c)));
      }
      const citation = turn.citations.find(c => c.source_id && (c.page || ["pdf","note","personal"].includes(c.document_kind)));
      sources.append(button(tr("加入到筆記"),() => noteFromTurn(turn,citation)));
      w.append(sources);
      const detail = element("details");
      detail.append(element("summary",tr("查看引用的內容")));
      for (const c of turn.citations) {
        const title = c.document_name && c.document_name !== c.source_name ? `${c.document_name} · ${c.source_name}` : c.source_name;
        detail.append(element("p",c.label + " · " + title),element("blockquote",c.excerpt));
      }
      w.append(detail);
    }
    if (turn.status !== "imported") w.append(element("div",
      [tr(modes[turn.mode]),turn.retriever,turn.latency_ms == null ? "" : (turn.latency_ms/1000).toFixed(2) + (english() ? " s" : " 秒")].filter(Boolean).join(" · "),"meta"));
    if (turn.warning) w.append(element("p",tr(turn.warning),"alert"));
    if (!turn.citations?.length && turn.status === "answered") w.append(button(tr("加入到筆記"),() => noteFromTurn(turn),"turn-note"));
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
function bindForm(id, listener, status) {
  $(id).addEventListener("submit",async e => {
    e.preventDefault();
    const submit = e.submitter;
    if (!submit || submit.disabled) return;
    submit.disabled = true;
    $(status).textContent = "";
    try { await listener(); } catch (error) { $(status).textContent = tr(error.message); }
    finally { submit.disabled = false; }
  });
}
$("chats").addEventListener("change",() => changeChat($("chats").value).catch(report));
$("new-chat").addEventListener("click",() => changeChat("").catch(report));
$("clear-selection").addEventListener("click",() => setSelection(""));
bindForm("ask",async () => {
  $("chat-status").textContent = tr("正在找教材並產生回覆…");
  $("chats").disabled = $("new-chat").disabled = true;
  try {
    const reply = await post("/api/ask",{
      question:$("question").value,conversation_id:state.conversation||null,
      scope:state.selected||null,mode:$("mode").value
    });
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
    $("chats").disabled = $("new-chat").disabled = false;
  }
},"chat-status");

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
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click",() => b.closest("dialog").close()));
$("import-open").addEventListener("click",() => $("import-dialog").showModal());
$("catalog-import").addEventListener("click",() => $("import-dialog").showModal());
$("material-file").addEventListener("change",async () => {
  const f = $("material-file").files[0];
  $("preview").hidden = !f || !/\.(md|txt)$/i.test(f.name);
  if (!$("preview").hidden) $("preview").textContent = await f.slice(0,5000).text();
});
bindForm("import-form",async () => {
  const files = [...$("material-file").files];
  const bundle = $("bundle-file").files[0];
  if (bundle && (files.length !== 1 || !/\.pdf$/i.test(files[0].name))) throw Error("解析 ZIP 須搭配一份 PDF。");
  for (const file of files) {
    const form = new FormData();
    form.append("file",file);
    if (bundle) form.append("bundle",bundle);
    const original = $("original").value;
    if (original && !/\.pdf$/i.test(file.name)) form.append("original_id",original);
    if ($("official").checked) form.append("official","true");
    await api("/api/import",{method:"POST",body:form});
  }
  $("import-form").reset();
  $("preview").hidden = true;
  $("import-dialog").close();
  await refreshJobs();
},"import-status");
async function loadPreferences() {
  const p = await get("/api/settings");
  $("mode").value = $("preferred-mode").value = p.mode;
  $("model").replaceChildren(new Option(p.model,p.model));
  $("retriever").value = p.retriever;
  $("response-language").value = p.language;
}
async function detectModels() {
  const select = $("model");
  const current = select.value;
  const status = $("settings-status");
  $("refresh-models").disabled = true;
  status.textContent = tr("正在偵測本機模型…");
  try {
    const installed = await get("/api/models");
    const available = [...new Set([current,...installed])].filter(Boolean);
    select.replaceChildren(...available.map(name => new Option(name,name)));
    select.value = current || available[0] || "";
    status.textContent = !installed.length ? tr("未偵測到本機模型。") :
      current && !installed.includes(current) ? tr("目前使用的模型未出現在偵測結果。") : "";
  } catch (error) { status.textContent = tr(error.message); }
  finally { $("refresh-models").disabled = false; }
}
$("settings-open").addEventListener("click",() => { $("settings-dialog").showModal(); detectModels(); });
$("refresh-models").onclick = detectModels;
bindForm("settings-form",async () => {
  const mode = $("preferred-mode").value;
  await api("/api/settings",{method:"PUT",...json({mode,model:$("model").value,retriever:$("retriever").value,language:$("response-language").value})});
  $("mode").value = mode;
  $("settings-dialog").close();
},"settings-status");
async function listRecords() {
  state.records = await get("/api/records");
  await refreshChats();
  $("record-list").replaceChildren();
  $("record-view").hidden = true;
  const items = [[state.chats,"conversations"],[state.records,"records"]];
  for (const [rows,kind] of items) for (const r of rows) {
    const box = element("input");
    box.type = "checkbox";
    box.id = "record-" + r.id;
    box.dataset.kind = kind;
    box.value = r.id;
    const label = element("label",r.name || r.title);
    label.htmlFor = box.id;
    const line = element("div");
    line.append(box,label,button(tr("預覽"),async () => {
      const result = await get("/api/" + kind + "/" + r.id);
      $("record-view").textContent = kind === "records" ? result.content : result.map(t => tr("你") + ": " + t.question + "\n" + tr("助教") + ": " + t.answer).join("\n\n");
      $("record-view").hidden = false;
    }));
    $("record-list").append(line);
  }
  if (!$("record-list").children.length) $("record-list").append(element("p",tr("目前沒有互動紀錄。"),"small"));
}
$("records-open").addEventListener("click",async () => {
  try { await listRecords(); $("records-dialog").showModal(); } catch (error) { report(error); }
});
bindForm("records-export",async () => {
  const selection = {conversations:[],records:[],format:$("format").value};
  for (const b of $("record-list").querySelectorAll("input:checked")) selection[b.dataset.kind].push(b.value);
  if (!selection.conversations.length && !selection.records.length) throw Error("請勾選至少一筆紀錄。");
  const response = await api("/api/records/export",{method:"POST",...json(selection)});
  const url = URL.createObjectURL(await response.blob());
  const link = element("a");
  link.download = "aita-records." + selection.format;
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url),1000);
},"records-status");
document.addEventListener("aita-language", () => {
  refreshJobs().catch(report);
  refreshChats().catch(report);
  showTurns();
  if ($("records-dialog").open) listRecords().catch(report);
});
