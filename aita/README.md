# Local Personal AITA

AITA 是本機課程閱讀器和助教。匯入 PDF 後可瀏覽教材、選段提問、沿用近期對話，並從回答回到教材與原始頁。公開版本首次啟動時，請匯入自己的教材。

## Windows 啟動

安裝 Python 3.12、Node.js 24 與 Ollama。在 Ollama 運行時，於 Git 專案根目錄執行。

```powershell
python -m venv .aita-venv
.\.aita-venv\Scripts\python -m pip install -r aita/requirements.txt
npm.cmd --prefix aita ci
ollama pull qwen3.5:0.8b
ollama pull bge-m3
.\.aita-venv\Scripts\python -m uvicorn aita.app:app --host 127.0.0.1 --port 8766
```

開啟 [AITA](http://127.0.0.1:8766)。模型和套件裝好後，教材和問答走本機。一般問答可選 TF-IDF。Dense／Hybrid 才需要 `bge-m3`。

## 閱讀與選字提問

PDF 預設用本機 PDF.js 顯示原始版面。「解析內容」按 PDF 實體頁分組，切換視圖會保留頁碼。可用前後頁按鈕，或輸入頁碼按 Enter。「問這一頁」「開啟原始 PDF」在頁碼列右側，引用可在閱讀器內跳頁。

反白教材文字可提問、加入筆記、加螢光標記或底線。先選樣式，再選四色之一。點已畫記的字可改色、改樣式或移除。畫記綁定文件版本、實體頁與視圖，存在目前的瀏覽器設定檔。原始 PDF 須有可選取的文字層。選字後可按右鍵，或用 `Alt+Shift+S` 聚焦工具。

桌面可拖動閱讀器與助教中間的分隔線，或聚焦分隔線後用方向鍵調整。窄窗可用「閱讀」「問助教」切換面板。頂部「教材庫」進入 [獨立書庫](http://127.0.0.1:8766/library)，可依名稱或概述搜尋、依類型篩選。卡片顯示原始 PDF 封面與頁數，開啟讀過的教材會恢復視圖與頁碼。閱讀區左欄可建立分類與子分類，拖動教材或用教材列的「⋯」移動。

「個人筆記」開啟此 PDF 的 Markdown 編輯器。可從選文或助教回答將內容帶入，預覽後儲存。已儲存的個人筆記會進入 RAG 索引，引用會顯示其來源類型。介面語言可在頂部切換。助教設定可偵測 Ollama 模型、選擇回答語言。互動紀錄介面提供預覽與匯出。

## PDF 與筆記

本專案已用 MinerU 4.2.3 的 `/v1/tasks` 在 Windows 驗證。請在 MinerU 專案另開終端，以 `.mineru\Scripts\mineru-kit.exe api-server --host 127.0.0.1 --port 8000 --tier standard` 啟動。服務網址可由 `AITA_MINERU_URL` 覆蓋，限本機。已有解析 ZIP 時，可以在匯入時同時選擇原始 PDF 與 ZIP。

筆記可用 UTF-8 Markdown 或 TXT。把 `<!-- page: N -->` 放在小節標題下方，匯入時選取筆記所依據的 PDF。頁碼採 PDF 檔案的實體頁，從 1 開始。匯入前可預覽文字。教師發布的正式規定請在匯入時標記，讓詢問作業規定時有對應的證據來源。新匯入教材會嘗試用本機模型產生概述，可在書庫卡片編輯。概述失敗時教材仍可閱讀。

## 驗證與評估

```powershell
.\.aita-venv\Scripts\python -m pip install httpx
.\.aita-venv\Scripts\python -m unittest discover -v -s aita/tests
.\.aita-venv\Scripts\python -m aita.evaluate aita/data/questions.json aita/data/retrieval-results.json --source "your-material.pdf"
```

執行檢索評估前，請先匯入你的 PDF，下載 `bge-m3`，並自備 `aita/data/questions.json`。題集是一組 `[split, topic_id, question, relevant_pdf_pages]` JSON 陣列。無證據題的頁碼陣列留空。課程原檔、筆記、SQLite 與評估明細儲存在 Git 忽略的 `aita/data/`。可設定 `AITA_DATA` 使用另一份資料庫。備份資料庫宜先停止程式。

引用會核對是否為該輪送入的來源，概念是否正確仍需閱讀原文確認。正式規定的辨識使用有限的中英文問句模式，其他表達仍需驗證。4096 context 的長度預算使用保守的 UTF-8 估算，實際 token 數以 Ollama 回傳為準。
