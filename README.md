# BIIBO · Local Personal AI TA

[繁體中文](aita/README.md)

BIIBO is a personal study assistant and course reader for graduate students. Open a PDF, select a passage, and ask for a hint, a concept explanation, or debugging guidance. Follow the answer’s sources back to the course material or your notes.

## What you can do

- Browse the library at `/library`, search by title or summary, organize materials in folders, and pick up where you left off.
- Switch between the original PDF and parsed content on the same physical page. Ask about a page or selection. Highlight or underline text in four colors.
- Write Markdown notes with a live preview and save passages or tutor replies to them. Saved notes are searchable by the tutor. Export conversations as JSON or Markdown.
- Generate a weekly course plan from a syllabus, preview a week, draft notes from a document, and take a source-linked quiz.
- Use Traditional Chinese or English for the interface and choose the tutor’s response language separately.

## Start on Windows

Install Node.js 24, Bun and Ollama. With Ollama running, open PowerShell at the repository root and run:

```powershell
bun install --frozen-lockfile
ollama pull qwen3.5:0.8b
bun run start
```

Open [BIIBO’s library](http://127.0.0.1:3000/library). Import a PDF, UTF-8 Markdown, or TXT file. In **Settings**, check that Ollama and your model are available. TF-IDF works without an embedding model. For Dense or Hybrid retrieval, run `ollama pull bge-m3`. BIIBO uses that embedding model automatically.

| Task | Where to start |
| --- | --- |
| Import a PDF | BIIBO uses local MinerU at `http://127.0.0.1:8000` by default. You can also import the PDF with its MinerU results ZIP. If MinerU is unavailable, BIIBO falls back to PDF.js text extraction. Use MinerU for scanned pages and structured content such as figures and tables. |
| Link course notes to source pages | In UTF-8 Markdown, put `<!-- page: N -->` on its own line under a section heading. Select the source PDF on import. Number pages from 1 using their physical position in the file. |
| Ask about a course requirement | Mark the original announcement as official during import. When the retrieved sources are insufficient, confirm the rule with the instructor’s announcement. |
| Create a study plan | Open **Import → Syllabus plan**. Upload or paste the syllabus and select **Preview syllabus**. Review the extracted week numbers, topics, and dates. Start each week with `Week N` and put additional items on separate lines. Confirm to save. The model can suggest learning objectives. Auto-file compares each material with the topics of the selected course. |
| Review conversations | Open **Conversations** and select a title to preview the full exchange. Use the checkboxes to select items for export. |

## Upgrade from Python AITA

On the first run, BIIBO reads `aita/data/aita.sqlite3` in read-only mode and creates `data/biibo-store.json` with binary files in `data/blobs/`. It keeps document and chunk IDs, source pages, folders, notes, conversations, and settings. Set `AITA_DATA` to the directory containing your SQLite file if you used a custom location. If the BIIBO store already exists, it takes precedence. The two stores operate independently after the import.

Back up the entire `data/` directory with BIIBO stopped. Both data directories are Git-ignored. Embeddings are rebuilt on demand. Highlights, reading position, and interface preferences are stored in your browser for each address and port. To keep those browser preferences from `127.0.0.1:8766`, close the old app and set `PORT=8766` in `.env` before launching BIIBO.

## Engines and privacy

Copy `.env.example` to `.env` to customize the local Ollama, LM Studio, or MinerU endpoints. The automatic library summary runs with Ollama or LM Studio when selected. Otherwise, the summary stays blank and remains editable.

Use **Settings → Local CLI** to select Antigravity, Codex, or Claude Code and set the reasoning effort. BIIBO uses the CLI’s own login. Codex automatically lists detected models and their reasoning options, and provides a separate Fast mode setting. Use **Refresh models** for Codex or **Fetch models** for Antigravity. **Test connection** uses the selections currently shown in the dialog.

In **Settings → Cloud API**, select a provider, enter its key, fetch the model list, and test the selected model. Saving a key writes it to the Git-ignored `data/provider-keys.json` on the server. Treat that file as a secret when backing up data. Leave the field blank to use a saved key or the provider’s environment variable. An AI request can send your question and relevant excerpts to the selected service.

BIIBO listens on loopback by default. For deliberate network access, set `HOST`, `BIIBO_ACCESS_TOKEN`, and `BIIBO_PUBLIC_ORIGIN` to the exact HTTPS origin, and use a reverse proxy that preserves the public Host header. Sign in with username `biibo` and the token as the password. API clients can send the token as a Bearer credential.

## Verify locally

```powershell
bun run build
bun run test
```

For a manual check, import a PDF and its ZIP, switch views on page 2, ask about that page, and click the source in the reply. Switch to **Personal notes** using the arrow keys, then save an excerpt. Refresh the browser and confirm the note and conversation can be reopened.

The reader uses [PDF.js](https://github.com/mozilla/pdf.js) and [KaTeX](https://katex.org/). The project draws design ideas from [PaperRead](https://github.com/YuriyLin/PaperRead), [OpenTutor](https://github.com/zijinz456/OpenTutor), [haiku.rag](https://github.com/ggozad/haiku.rag) and [Lucian UX/UI Prompt #039](https://lucianlabs.dev/uxui-prompt/#039).
