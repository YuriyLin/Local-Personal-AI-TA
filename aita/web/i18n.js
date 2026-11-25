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
BIIBO 助教|BIIBO Tutor
閱讀 PDF 或選取教材文字向 BIIBO 助教提問。|Read a PDF or select text to ask BIIBO.
開始與 BIIBO 一起學習|Start learning with BIIBO
匯入 PDF、Markdown 或 TXT，BIIBO 會陪你閱讀並標註可追溯來源。|Import PDF, Markdown, or TXT materials. BIIBO helps you read and trace every citation.
書庫總覽|Library Catalog
顯示面板|Toggle panes
教材庫欄寬|Library pane width
直接將教材檔案拖曳至此|Drop course materials here
支援 PDF、Markdown（.md）與 TXT，放開即可匯入閱讀；也可以從左側教材庫選擇既有教材。|Supports PDF, Markdown (.md), and TXT. Release to import right away, or pick a file from the left sidebar.
拖曳檔案到此處，或點擊左側「＋ 匯入教材」|Drop files here, or click "+ Import materials" on the left
放開即可匯入教材|Release to import files
正在匯入拖曳的檔案…|Importing dropped files…
僅支援 PDF、Markdown 或 TXT 檔案。|Only PDF, Markdown, or TXT files are supported.
選擇檔案或拖曳至此|Choose files or drag here
支援 PDF、Markdown、TXT（可多選）|Supports PDF, Markdown, TXT (multiple)
所屬教材類型|Material category
此類別頂層|Top level of category
新增子分類|Add subfolder
目前沒有教材|No files yet
偵測模型中…|Checking model…
服務已連線|Connected
未偵測到本地模型|Local model offline
點擊開啟模型設定|Click to open model settings
建議提問|Suggested questions
正在檢索教材…|Searching materials…
正在思考回覆…|Thinking through the answer…
正在整理來源與引用…|Organizing citations…
收合或展開左側欄|Toggle left sidebar
收合／展開左側欄|Toggle left sidebar
收合或展開右側欄|Toggle right sidebar
收合／展開右側欄|Toggle right sidebar
無法連線到伺服器，請確認網路與本機服務是否正常運作。|Cannot reach the server. Please check your network or local service.
目前尚未連線到本機 Ollama 服務，請確認 Ollama 已啟動後再試。|Local Ollama service is not connected. Please start Ollama and try again.
無法連線至本機 Ollama 服務，請確認 Ollama 已啟動後再點擊重新偵測。|Cannot connect to local Ollama. Please make sure Ollama is running and try refreshing.
目前無法取得本機 Ollama 模型清單，請確認本機服務已啟動。|Unable to load local Ollama models. Please check that Ollama is running.
服務暫時忙碌或無法連線，請稍後再試。|The service is temporarily unavailable. Please try again shortly.
找不到對應的教材或資料，請重新整理後再試。|The requested material or item could not be found. Please refresh and try again.
檔案大小超過上限，請選擇較小的檔案後再試。|The file is too large. Please choose a smaller file.
輸入內容或檔案格式不正確，請確認後再試。|Invalid input or unsupported file format. Please check and try again.
系統處理時發生暫時性問題，請稍後再試。|Something went wrong while processing your request. Please try again shortly.
伺服器回應格式異常，請稍後再試或重新整理頁面。|Received an unexpected server response. Please refresh and try again.
操作暫時無法完成，請稍後再試。|Could not complete this action right now. Please try again.
無法儲存設定，請稍後再試。|Could not save settings right now. Please try again.
匯入教材失敗，請確認檔案格式為 PDF、Markdown 或 TXT 後再試。|Import failed. Please make sure the file is PDF, Markdown, or TXT.
無法送出提問，請確認本地模型服務正常後再試。|Could not send your question. Please check your local model service and try again.
無法建立分類，請確認名稱後再試。|Could not create the folder. Please check the name and try again.
無法儲存教材資訊，請稍後再試。|Could not save material details. Please try again.
無法儲存筆記，請確認標題與內容後再試。|Could not save the note. Please check the title and content.
無法匯出互動紀錄，請稍後再試。|Could not export interaction records. Please try again.
新增教材或子資料夾|Add material or subfolder
建立子資料夾|New subfolder
匯入原始 PDF|Import original PDF
匯入課程筆記|Import course notes
新增個人筆記|New personal note
匯入文字教材|Import text material
僅選擇 PDF 檔案（可多選）|Choose PDF files (multiple)
支援 Markdown、TXT（可多選）|Supports Markdown, TXT (multiple)
課程筆記需搭配一份原始 PDF，請先匯入原始 PDF 教材。|Course notes must be linked to an original PDF. Please import a PDF first.
個人筆記需關聯一份原始 PDF，請先匯入原始 PDF 教材。|Personal notes must be linked to an original PDF. Please import a PDF first.
課程教材|Course materials
所屬區塊|Section
匯入課程教材|Import course material
匯入個人文檔|Import personal document
支援 Markdown、TXT 個人文檔（可多選）|Supports personal Markdown, TXT files (multiple)
關聯教材（選填）|Linked material (optional)
筆記|NOTE
編輯筆記|Edit note
右側工作區|Right workspace
獨立筆記|Standalone note
輸入筆記標題…|Enter note title…
使用 Markdown 撰寫論文與課程筆記，支援 $LaTeX$ 公式、表格、待辦清單與引用…|Write study or paper notes in Markdown — supports $LaTeX$ math, tables, checklists, and quotes…
編輯|Edit
雙欄|Split
筆記檢視模式|Note view mode
匯出 Markdown|Export Markdown
刪除筆記|Delete note
已刪除筆記|Note deleted
無法刪除筆記，請稍後再試。|Could not delete the note. Please try again.
尚未輸入內容，開始撰寫後即可即時預覽。|Nothing to preview yet. Start writing in Markdown to see a live preview.
插入目前 PDF 頁碼標記|Insert current PDF page anchor
大標題 (H1)|Heading 1
中標題 (H2)|Heading 2
小標題 (H3)|Heading 3
粗體 (Ctrl+B)|Bold (Ctrl+B)
斜體 (Ctrl+I)|Italic (Ctrl+I)
刪除線|Strikethrough
行內程式碼|Inline code
項目清單|Bullet list
編號清單|Numbered list
待辦核取清單|Task checklist
引用區塊|Blockquote
程式碼區塊|Code block
數學公式 (LaTeX)|Math formula (LaTeX)
插入表格|Insert table
插入連結|Insert link
分隔線|Horizontal divider
字|chars
對話管理|Conversations
管理已儲存的對話|Manage saved conversations
全選|Select all
已選 0 筆|0 selected
批量匯出|Export selected
批量刪除|Delete selected
目前沒有對話紀錄。|No conversations yet.
請勾選至少一筆對話。|Select at least one conversation.
無法刪除所選對話，請稍後再試。|Could not delete the selected conversations. Please try again.
收合左側欄|Collapse left sidebar
展開左側欄|Expand left sidebar
收合右側欄|Collapse right sidebar
展開右側欄|Expand right sidebar
課綱規劃|Syllabus plan
課後自測|Self-test
測驗暫停中 · 點此繼續|Quiz paused · Click to resume
結束|End
結束測驗|End quiz
先幫我預習本週核心觀念|Preview this week's core concepts
上傳本週講義|Upload week slides
BIIBO 幫你寫草稿|Draft with BIIBO
目前頁面|Current page
整份教材|Full material
結構化重點整理|Structured summary
公式與推導整理|Formulas & derivations
考前速記表|Exam cheat sheet
生成草稿|Generate draft
原始碼|Raw
插入游標位置|Insert at cursor
附加到筆記尾端|Append to end
重新生成|Regenerate
歸檔分類（選填）|Target folder (optional)
上傳課程大綱 · AI 初步規劃|Upload Syllabus · AI Planning
開始 AI 規劃|Start AI planning
選擇課綱檔案或拖曳至此|Choose syllabus file or drag here
課後自測 Q&A|Self-Test Q&A
測驗範圍|Quiz scope
整份 PDF|Full PDF
題數|Questions
3 題|3 Qs
5 題|5 Qs
開始出題|Generate quiz
先看提示|Show hint
對照原文|View source page
收入個人筆記|Clip to notes
重新設定|Reset
下一題 →|Next →
查看結果|View results
測驗完成|Quiz complete
建議再複習的概念|Concepts to review
把錯題加入筆記|Save misses to notes
針對弱點問 BIIBO|Ask BIIBO about gaps
再測一次|Try again
保持開啟|Keep open
尚缺講義|Missing slides
課綱檔案或截圖（PDF / 圖片 / MD / TXT）|Syllabus file or image (PDF / Image / MD / TXT)
選擇檔案、圖片或拖曳至此|Choose file, image, or drag here
支援 PDF、PNG/JPG/WebP 截圖、Markdown、TXT|Supports PDF, PNG/JPG/WebP images, Markdown, TXT
或直接貼上課綱文字／剪貼簿截圖（Ctrl+V / Cmd+V）|Or paste syllabus text / clipboard screenshot (Ctrl+V / Cmd+V)
貼上剪貼簿圖片|Paste clipboard image
移除圖片|Remove image
由 BIIBO 幫你出題，卡關可先看解題提示，並附上原文頁碼；中途跳回講義對照時會自動保留作答進度。|BIIBO creates the quiz for you with step-by-step hints and source page references; jumping back to the slides automatically saves your progress.
上傳 PDF 或課綱截圖後，由 BIIBO 讀取內容並建立授課週次分類與置頂總覽筆記；放假、純考試與互評週會自動略過空資料夾，不誤報缺講義。|Upload a PDF or syllabus screenshot and BIIBO will organize lecture folders and a pinned course overview—while automatically skipping holidays, exams, and review weeks.
AI 模型引擎|AI model engine
模型引擎類型|Engine category
模型引擎來源|Model provider
本地模型|Local models
本機 CLI|Local CLI
雲端 API|Cloud API
使用模型|Model
自訂模型名稱|Custom model name
測試連線|Test connection
正在偵測模型引擎…|Detecting model engines…
已就緒|Ready
未就緒|Not ready
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
for (const node of document.querySelectorAll("[placeholder],[aria-label],[title]")) {
  for (const name of ["placeholder","aria-label","title"]) {
    const value = node.getAttribute(name);
    if (uiStrings[value]) staticCopy.push([node,value,name]);
  }
}
function applyLanguage() {
  document.documentElement.lang = interfaceLanguage;
  document.title = english() ? "BIIBO · Your Personal Tutor." : "BIIBO · 個人課程助教";
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
