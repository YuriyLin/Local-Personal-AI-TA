"use strict";

const uiStrings = Object.fromEntries(`
個人課程助教|Personal course tutor
跳到教材|Skip to the material
教材庫|Library
教材清單|Materials
閱讀|Read
問助教|Tutor
工作區|Workspace
設定|Settings
互動紀錄|Interaction records
切換介面語言|Switch interface language
搜尋教材|Search materials
搜尋名稱或概述|Search titles or summaries
類型|Type
全部教材|All materials
原始 PDF|Original PDF
課程筆記|Course notes
個人筆記|Personal notes
文字教材|Text materials
清除相關筆記篩選|Clear related notes filter
＋ 匯入教材|＋ Import materials
新增分類|New folder
教材與對話保存在這台電腦。|Materials and chats are stored on this computer.
課程閱讀器|Course reader
閱讀模式|Reading view
解析內容|Parsed content
PDF 翻頁|PDF navigation
PDF 實體頁碼|Physical PDF page
上一頁|Previous page
下一頁|Next page
頁碼待核|Unmapped pages
問這一頁|Ask about this page
問這份教材|Ask about this material
開啟原始 PDF ↗|Open original PDF ↗
教材內容|Material content
選擇一份教材|Choose a course material
閱讀 PDF 或選取教材文字向助教提問。|Read a PDF or select text to ask the tutor.
選取文字操作|Text selection actions
畫記樣式|Annotation style
畫記顏色|Annotation colors
螢光標記|Highlight
底線|Underline
黃色|Yellow
綠色|Green
藍色|Blue
粉紅色|Pink
問選取內容|Ask about selection
加入到筆記|Add to notes
移除畫記|Remove annotation
助教欄寬|Tutor pane width
對話|Conversation
新對話|New conversation
新增|New
問答紀錄|Conversation history
這裡會顯示你的提問、助教回覆與來源。也可以先從教材選一段。|Your questions, tutor replies and sources appear here. You can select a passage first.
取消選取|Clear selection
教學方式|Teaching mode
先給提示|Give a hint
解釋概念|Explain a concept
協助除錯|Help debug
你的問題|Your question
例如：為什麼驗證集不能用來估計填補值？|For example, why not estimate missing values from the validation set?
送出問題 →|Send question →
匯入教材|Import materials
教材檔案|Course files
MinerU 解析 ZIP（選填，搭配單一 PDF）|MinerU ZIP (optional, with one PDF)
筆記的原始 PDF（選填）|Source PDF for a note (optional)
一般教材|Standalone material
這份來源是教師發布的正式規定|This source contains official course requirements
關閉|Close
確認匯入|Import
助教設定|Tutor settings
Ollama 模型|Ollama model
重新偵測|Refresh models
教材檢索|Retrieval
語意檢索 · BGE-M3|Semantic · BGE-M3
混合檢索 · RRF|Hybrid · RRF
預設教學方式|Default teaching mode
回應語言|Response language
儲存設定|Save settings
選擇要匯出的紀錄|Select records to export
匯出格式|Export format
下載選取的紀錄|Download selected records
分類名稱|Folder name
上層分類|Parent folder
教材資訊|Material details
分類|Folder
概述|Summary
儲存|Save
已存筆記|Saved notes
筆記標題|Note title
Markdown 工具列|Markdown toolbar
標題|Heading
粗體|Bold
清單|List
引用|Quote
程式碼|Code
預覽|Preview
Markdown 內容|Markdown content
筆記預覽|Note preview
儲存筆記|Save note
根目錄|Top level
未分類|Unfiled
開啟教材|Open material
編輯概述|Edit summary
移動教材|Move material
尚未填寫概述|No summary yet
找不到符合條件的教材。|No materials match these filters.
尚未匯入教材。|No materials imported yet.
載入教材中…|Loading materials…
新增筆記|New note
已儲存筆記|Note saved
開啟筆記編輯器|Edit note
查看引用的內容|View source passages
教材段落|Passage
你|You
助教|Tutor
正在找教材並產生回覆…|Finding sources and generating a reply…
保留問題，可再次送出。|Your question was kept. You can try again.
排隊中|Queued
解析中|Parsing
重試|Retry
目前沒有互動紀錄。|No interaction records yet.
請勾選至少一筆紀錄。|Select at least one record.
正在載入 PDF…|Loading PDF…
無法顯示原始 PDF。|Could not display the original PDF.
切換至解析內容|Switch to parsed content
這一頁沒有解析內容。|No parsed content for this page.
頁碼待核的解析內容|Parsed content without page numbers
瀏覽器無法儲存這項變更。|The browser could not save this change.
已加入螢光標記|Highlight added
已加入底線|Underline added
已移除標記|Annotation removed
已更新畫記|Annotation updated
無法取得本機 Ollama 模型。|Could not detect local Ollama models.
未偵測到本機模型。|No local models found.
請先開啟原始 PDF 或選擇有 PDF 來源的引用。|Open a PDF or select a citation with a PDF source first.
解析 ZIP 須搭配一份 PDF。|A parser ZIP must accompany one PDF.
請填寫筆記標題和內容。|Enter a note title and content.
找不到資料。|Data not found.
請輸入分類名稱。|Enter a folder name.
本機模型回答逾時。請確認 Ollama 的模型狀態後再試。|The local model timed out. Check Ollama and try again.
本機 Ollama 無法回答。請確認服務及所選模型可用。|Ollama could not reply. Check the service and selected model.
模型回傳的回答格式無法驗證。請重試或更換模型。|The model returned an invalid response. Retry or select another model.
語意檢索暫不可用，本次改用 TF-IDF。|Semantic retrieval is unavailable. TF-IDF was used.
請輸入問題，長程式碼可擷取相關片段。|Enter a question. For long code, include the relevant snippet.
助教正在回答另一個問題。|The tutor is answering another question.
所選段落已更新，請重新選取。|The selected passage changed. Select it again.
匯入完成|Import complete
PDF 圖片|PDF image
來源|Source
問題|Question
回覆|Answer
請求未完成|Request did not complete
放在這裡移動教材|Drop here to move the material
沒有教材|No materials
正在偵測本機模型…|Detecting local models…
正在產生教材概述…|Generating a material summary…
請先從教材庫選擇一份教材。|Choose a course material from the library first.
草稿尚未儲存。|Unsaved draft.
目前使用的模型未出現在偵測結果。|The saved model is not in the detected list.
找不到可用的 PDF 文字層。|No selectable PDF text layer was found.
`.trim().split("\n").map(line => line.split("|")));

let interfaceLanguage;
try { interfaceLanguage = localStorage.getItem("aita-interface-language") || "zh-Hant"; }
catch { interfaceLanguage = "zh-Hant"; }
const english = () => interfaceLanguage === "en";
const tr = value => english() ? (uiStrings[value] || value) : value;
const pageLabel = page => english() ? `Page ${page}` : `第 ${page} 頁`;
const staticCopy = [];
const copyWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
while (copyWalker.nextNode()) {
  const node = copyWalker.currentNode;
  if (uiStrings[node.nodeValue.trim()]) staticCopy.push([node,node.nodeValue.trim(),null]);
}
for (const node of document.querySelectorAll("[placeholder],[aria-label]")) {
  for (const name of ["placeholder","aria-label"]) {
    const value = node.getAttribute(name);
    if (uiStrings[value]) staticCopy.push([node,value,name]);
  }
}
function applyLanguage() {
  document.documentElement.lang = interfaceLanguage;
  document.title = "AITA · " + tr("個人課程助教");
  for (const [node,value,attribute] of staticCopy) {
    if (attribute) node.setAttribute(attribute,tr(value));
    else node.nodeValue = tr(value);
  }
  document.getElementById("language-toggle").textContent = english() ? "繁體中文" : "English";
}
applyLanguage();
document.getElementById("language-toggle").addEventListener("click", () => {
  interfaceLanguage = english() ? "zh-Hant" : "en";
  try { localStorage.setItem("aita-interface-language",interfaceLanguage); } catch { /* Applies to this tab. */ }
  applyLanguage();
  document.dispatchEvent(new Event("aita-language"));
});
