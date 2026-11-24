# Local Personal AI TA

A local course reader and AI tutor for Windows. Import your own materials, ask about a passage or a full PDF page, and follow the tutor’s citations back to the source. The browser supports English and Traditional Chinese.

## Features

- Read original PDFs with PDF.js or switch to parsed content at the same page.
- Search the library, resume reading, organize materials in folders, and highlight or underline text.
- Write Markdown notes linked to a PDF. Save selections and tutor replies as notes that can be retrieved in future conversations.
- Use TF-IDF, dense retrieval, or hybrid retrieval. Choose hint, concept, or debugging mode and export interaction records.

## Run on Windows

Install Python 3.12, Node.js 24, and [Ollama](https://ollama.com/download). Run these commands in the repository root with Ollama running.

```powershell
python -m venv .aita-venv
.\.aita-venv\Scripts\python.exe -m pip install -r aita/requirements.txt
npm.cmd --prefix aita ci
ollama pull qwen3.5:0.8b
.\.aita-venv\Scripts\python.exe -m uvicorn aita.app:app --host 127.0.0.1 --port 8766
```

Open the [local library](http://127.0.0.1:8766/library). To try the tutor, import a Markdown or TXT file and ask a question that its contents support. For direct PDF imports, run a local MinerU API or supply the PDF with a compatible MinerU results ZIP. The default MinerU address is `http://127.0.0.1:8000`. Dense and hybrid retrieval require `ollama pull bge-m3`.

See the [Traditional Chinese usage guide](aita/README.md) for PDF import, notes, and evaluation instructions.

## Test

```powershell
.\.aita-venv\Scripts\python.exe -m pip install httpx
.\.aita-venv\Scripts\python.exe -m unittest discover -v -s aita/tests
```

Unit and API tests use temporary databases and simulated model and parser responses. Imported materials and conversations are stored in the Git-ignored `aita/data/` by default. The public checkout starts with an empty library.

## Credits

The reader and tutor use [PDF.js](https://github.com/mozilla/pdf.js), [KaTeX](https://katex.org/), [Ollama](https://ollama.com/), and [MinerU](https://github.com/opendatalab/MinerU). [PaperRead](https://github.com/YuriyLin/PaperRead), [OpenTutor](https://github.com/zijinz456/OpenTutor), and [haiku.rag](https://github.com/ggozad/haiku.rag) informed the design. The view switch adapts [Lucian UX/UI Prompt #039](https://lucianlabs.dev/uxui-prompt/#039).
