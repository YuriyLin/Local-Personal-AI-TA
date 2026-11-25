# BIIBO · 本機個人 AI 助教

[English](../README.md)

BIIBO 是研究所學習助教，結合課程閱讀、個人筆記與 AI 問答。閱讀 PDF 時，可以針對一頁或一段文字請助教提示、解釋概念或協助除錯，再從回答的引用跳回教材。

## 可以做什麼

- 在 `/library` 依名稱或概述搜尋教材、使用類型篩選與文件夾整理，並回到上次閱讀位置。
- 在原始 PDF 與解析內容之間切換，同步 PDF 實體頁碼。反白文字可提問、加四色螢光或底線，也能點選已畫記的文字來編輯。
- 用 Markdown 編輯和預覽筆記，保存選文或助教回答。已儲存的筆記可供助教檢索。對話可匯出成 JSON 或 Markdown。
- 從課綱產生每週學習計畫與預習內容，從教材生成筆記草稿，並進行可回查來源的課後自測。
- 獨立設定介面語言與助教回答語言，皆支援繁體中文及英文。

## 在 Windows 啟動

安裝 Node.js 24、Bun 與 Ollama。啟動 Ollama 後，在 Git 專案根目錄開啟 PowerShell 並執行以下指令。

```powershell
bun install --frozen-lockfile
ollama pull qwen3.5:0.8b
bun run start
```

開啟 [BIIBO 教材庫](http://127.0.0.1:3000/library)，匯入 PDF、UTF-8 Markdown 或 TXT。在「設定」裡確認 Ollama 與模型可用。TF-IDF 可直接使用。若要使用 Dense 或 Hybrid 檢索，先執行 `ollama pull bge-m3`，BIIBO 會自動使用這個 embedding 模型。

| 要做的事 | 操作 |
| --- | --- |
| 匯入 PDF | BIIBO 預設連到 `http://127.0.0.1:8000` 的本機 MinerU。已有解析結果時，可將 PDF 與 MinerU ZIP 一起匯入。MinerU 無法使用時，系統改用 PDF.js 擷取文字。掃描頁與含圖表的版面建議使用 MinerU。 |
| 讓課程筆記連到 PDF | 在 UTF-8 Markdown 的小節標題下單獨一行寫入 `<!-- page: N -->`，匯入時選擇原始 PDF。頁碼依 PDF 檔案的實體順序從 1 開始。 |
| 查詢正式課程規定 | 匯入教師公告時勾選正式來源。若教材證據不足，請查閱原始公告。 |
| 建立學習計畫 | 開啟「匯入 → 課綱規劃」，貼上或上傳後按「預覽課綱」。核對週次、主題與日期。每週以 `Week N` 開頭，同週其他項目另起一行。確認後才儲存，模型可補學習目標。「自動歸檔」以所選課程的週次主題比對教材。 |
| 回顧對話 | 在「對話管理」點標題預覽問答，使用核取方塊選擇要匯出的對話。 |

## 從 Python AITA 升級

BIIBO 首次啟動會以唯讀模式開啟 `aita/data/aita.sqlite3`，建立 `data/biibo-store.json` 和 `data/blobs/`。文件與片段 ID、原始頁碼、分類、筆記、對話和設定會隨資料遷移。若舊版用了自訂位置，請將 `AITA_DATA` 指向含有 SQLite 檔案的資料夾。已有 BIIBO 資料時會優先載入，匯入後兩邊的資料獨立更新。

備份前先關閉 BIIBO，複製整個 `data/`。Git 會忽略新舊兩個資料目錄，向量會按需重新建立。畫記、續讀位置和介面偏好保存在瀏覽器，按網址及埠分開。若要沿用 `127.0.0.1:8766` 的瀏覽器偏好，可關閉舊程式並在 `.env` 設定 `PORT=8766` 再啟動 BIIBO。

## 引擎與隱私

可將 `.env.example` 複製成 `.env`，設定 Ollama、LM Studio 或 MinerU。匯入時若選用 Ollama 或 LM Studio，BIIBO 會嘗試產生教材概述。使用其他引擎時，概述可在教材卡片手動填寫。

在「設定 → 本機 CLI」可選 Antigravity、Codex 或 Claude Code 和推理強度。BIIBO 沿用 CLI 的登入設定。Codex 會自動列出偵測到的模型和可用的推理強度，另有獨立的 Fast 模式選單。「重新偵測」可更新 Codex 清單，Antigravity 可用「取得模型清單」更新。「測試連線」會使用對話框目前選取的設定。

在「設定 → 雲端 API」先選服務商並輸入金鑰，再取得模型清單、測試連線。儲存後，金鑰放在伺服器的 `data/provider-keys.json`，此目錄已排除於 Git。備份時請保護此檔案。留空會沿用已儲存的金鑰或伺服器環境變數。使用 AI 功能時，所選服務可能收到問題與相關教材摘錄。

BIIBO 預設只監聽 loopback。需要對外使用時，設定 `HOST`、`BIIBO_ACCESS_TOKEN`、精確的 HTTPS `BIIBO_PUBLIC_ORIGIN`，並使用保留公開 Host 標頭的反向代理。瀏覽器登入的使用者名稱為 `biibo`，密碼為該 token。API 客戶端可使用 Bearer token。

## 在本機驗證

```powershell
bun run build
bun run test
```

手動驗證可從匯入 PDF 和解析 ZIP 開始。在第 2 頁切換視圖、點「問這一頁」提問，再點回答引用回到來源。聚焦右欄頁籤，按方向鍵切到「個人筆記」，從選文建立筆記。重新整理後確認仍能開啟筆記及對話。

閱讀器使用 [PDF.js](https://github.com/mozilla/pdf.js) 和 [KaTeX](https://katex.org/)。設計參考了 [PaperRead](https://github.com/YuriyLin/PaperRead)、[OpenTutor](https://github.com/zijinz456/OpenTutor)、[haiku.rag](https://github.com/ggozad/haiku.rag) 與 [Lucian UX/UI Prompt #039](https://lucianlabs.dev/uxui-prompt/#039)。
