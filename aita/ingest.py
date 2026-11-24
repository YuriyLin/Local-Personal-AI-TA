import hashlib
from contextlib import nullcontext
import io
import json
import os
import re
import time
import zipfile
from pathlib import PurePosixPath
from urllib.parse import urljoin, urlsplit

import requests

from .db import database

MAX_UPLOAD = 50 * 1024 * 1024
PARSER_REVISION = "blocks-v1"
PAGE = re.compile(r"^<!--\s*page:\s*(\d+)\s*-->$", re.M)
HEADING = re.compile(r"^(#{1,6})\s+(.+)$")
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


def local_http():
    client = requests.Session()
    client.trust_env = False
    client.max_redirects = 0
    return client


def mineru_parse(name, raw):
    base = os.getenv("AITA_MINERU_URL", "http://127.0.0.1:8000").rstrip("/")
    origin = urlsplit(base)
    if origin.scheme != "http" or origin.hostname not in {"127.0.0.1", "localhost", "::1"} or origin.username:
        raise ValueError("MinerU 位址必須是本機 HTTP 服務。")
    with local_http() as client:
        def request(method, path, **kwargs):
            url = urljoin(base + "/", path)
            target = urlsplit(url)
            if (target.scheme, target.netloc) != (origin.scheme, origin.netloc):
                raise ValueError("MinerU 回傳了外部位址。")
            response = client.request(method, url, allow_redirects=False, **kwargs)
            if not response.ok or response.is_redirect:
                raise ValueError(f"MinerU HTTP {response.status_code}")
            return response

        paths = request("GET", "/openapi.json", timeout=5).json()["paths"]
        if "/v1/tasks" in paths:
            task = request("POST", "/v1/tasks", timeout=15, json={
                "files": [{"file_name": name, "bytes": len(raw)}],
                "output_formats": ["default"], "ocr_mode": "auto",
            }).json()
            upload = task["files"][0].get("upload")
            if upload:
                request("PUT", upload["url"], headers=upload.get("headers"), data=raw, timeout=45)
            deadline = time.monotonic() + 360
            while time.monotonic() < deadline:
                status = request("GET", f"/v1/tasks/{task['task_id']}", timeout=10).json()
                item = status["files"][0]
                if item["status"] == "completed":
                    return request("GET", item["result_url"], timeout=60).content
                if item["status"] in {"failed", "canceled"}:
                    raise ValueError("MinerU 解析失敗，請查看本機 MinerU 日誌。")
                time.sleep(1)
            raise ValueError("MinerU 解析逾時。")
        if "/file_parse" in paths:
            response = request("POST", "/file_parse", timeout=360,
                               files={"files": (name, raw, "application/pdf")},
                               data={"return_content_list": "true", "return_md": "true",
                                     "return_images": "true", "table_enable": "true", "formula_enable": "true"})
            return response.content
        raise ValueError("服務未提供 /v1/tasks 或 /file_parse。")


def unpack(payload):
    if not payload.startswith(b"PK"):
        result = json.loads(payload)
        if "results" in result:
            result = next(iter(result["results"].values()))
        items = result.get("content_list", result)
        items = json.loads(items) if isinstance(items, str) else items
        return result.get("md_content", ""), items, {}
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        if sum(i.file_size for i in archive.infolist()) > 120 * 1024 * 1024:
            raise ValueError("MinerU ZIP 解壓後太大。")
        files = sorted(archive.namelist())
        structured = next((f for f in files if PurePosixPath(f).name == "structured_content.json"), None)
        structured = structured or next((f for f in files if f.endswith("content_list.json")), None)
        if not structured:
            raise ValueError("缺少 MinerU structured_content.json 或 content_list.json。")
        md = next((f for f in files if f.endswith("markdown.md")), None)
        md = md or next((f for f in files if f.endswith(".md")), None)
        assets = {}
        for f in files:
            path = PurePosixPath(f)
            if "images" in path.parts and ".." not in path.parts and path.suffix.lower() in IMAGE_EXTENSIONS:
                assets["images/" + path.name] = archive.read(f)
        return archive.read(md).decode("utf-8") if md else "", json.loads(archive.read(structured)), assets


def note_blocks(markdown):
    section, page, fence = "", None, ""
    buf = []
    lines = markdown.splitlines()
    for pos, line in enumerate(lines):
        marker = re.match(r"^\s*([~\x60]{3,})", line)
        if marker:
            if not fence:
                fence = marker[1]
            elif marker[1].startswith(fence):
                fence = ""
            buf.append(line)
            continue
        heading = HEADING.match(line) if not fence else None
        locator = PAGE.fullmatch(line.strip()) if not fence else None
        if locator and len(buf) == 1 and HEADING.match(buf[0]):
            page = int(locator[1])
            continue
        if heading or locator:
            if "".join(buf).strip():
                yield {"text": "\n".join(buf).strip(), "section": section, "page": page, "type": "text"}
            buf = []
            if heading:
                section, page = heading[2], None
                if pos + 1 < len(lines) and (next_page := PAGE.fullmatch(lines[pos + 1].strip())):
                    page = int(next_page[1])
                buf = [line]
            else:
                page = int(locator[1])
        else:
            buf.append(line)
    if "".join(buf).strip():
        yield {"text": "\n".join(buf).strip(), "section": section, "page": page, "type": "text"}


def pdf_blocks(structured):
    section = ""
    if isinstance(structured, dict):
        entries = ((p.get("page_idx"), b) for p in structured["pages"] for b in p["blocks"])
    else:
        entries = ((b.get("page_idx"), b) for b in structured)
    for index, block in entries:
        kind = block.get("type", "")
        content = block.get("content", block.get("text", "")) or ""
        if not isinstance(content, str):
            content = " ".join(str(v) for v in content) if isinstance(content, list) else ""
        caption_values = block.get("captions") or block.get("image_caption") or []
        captions = " ".join(c.get("content", "") if isinstance(c, dict) else str(c) for c in caption_values)
        image = block.get("image_source") or block.get("img_path")
        if kind in {"doc_title", "paragraph_title", "heading", "title"} or block.get("text_level"):
            section = content
            content = "## " + content
        elif kind in {"equation", "interline_equation"} and content and not content.startswith("$"):
            content = "$$\n" + content + "\n$$"
        elif kind == "table":
            content = block.get("table_body") or content
        elif kind == "code":
            content = block.get("code_body") or content
            if block.get("sub_type") != "algorithm":
                content = "\x60\x60\x60\n" + content + "\n\x60\x60\x60"
        if image and (not content or kind == "image"):
            image = "images/" + PurePosixPath(image).name
            content = f"![{captions or 'PDF 圖片'}]({image})"
        text = "\n\n".join(t for t in (captions, content) if t.strip())
        if text.strip():
            yield {"text": text, "page": index + 1 if type(index) is int and index >= 0 else None,
                   "section": section, "type": kind, "bbox": block.get("bbox")}


def chunks_for(blocks):
    for index, block in enumerate(blocks):
        text = block["text"]
        # Keep tables, equations and fenced code intact. Long prose is split within its source block.
        structured = block["type"] in {"table", "equation", "interline_equation", "code", "image"} or "\x60\x60\x60" in text or bool(re.search(r"(?m)^\|.*\|$", text))
        sections = [text] if structured else re.split(r"\n\s*\n", text)
        for section in sections:
            if not section.strip():
                continue
            if structured or len(section) <= 420:
                yield index, section.strip()
                continue
            for offset in range(0, len(section), 380):
                yield index, section[max(0, offset - 45):offset + 380].strip()


def ingest(name, raw, kind, original_id=None, bundle=None, official=False, *, note_id=None, connection=None):
    digest = hashlib.sha256(raw).hexdigest()
    assets = {}
    if kind == "pdf":
        if not raw.startswith(b"%PDF-"):
            raise ValueError("檔案不是有效 PDF。")
        bundle = bundle or mineru_parse(name, raw)
        markdown, structured, assets = unpack(bundle)
        blocks = list(pdf_blocks(structured))
        # ZIP metadata such as job IDs must not create duplicate revisions.
        canonical = json.dumps(blocks, ensure_ascii=False, sort_keys=True).encode()
        revision_data = canonical + markdown.encode() + b"".join(hashlib.sha256(assets[k]).digest() for k in sorted(assets))
    else:
        markdown = raw.decode("utf-8-sig")
        blocks = list(note_blocks(markdown))
        if kind not in {"note", "personal"}:
            blocks = [{**b, "page": None} for b in blocks]
        revision_data = raw
    if not blocks:
        raise ValueError("檔案沒有可用文字或來源區塊。")
    markdown = markdown or "\n\n".join(b["text"] for b in blocks)
    revision = hashlib.sha256(revision_data).hexdigest()
    parts = [kind, name, digest, revision, original_id, PARSER_REVISION]
    key = json.dumps(parts + (["official"] if official else []) + ([note_id] if note_id else []))
    document_id = hashlib.sha256(key.encode()).hexdigest()[:24]
    with (database() if connection is None else nullcontext(connection)) as db:
        if connection is None:
            db.execute("BEGIN IMMEDIATE")
        if kind in {"note", "personal"}:
            original = db.execute("SELECT blocks FROM documents WHERE id=? AND kind='pdf'", (original_id,)).fetchone()
            if not original:
                raise ValueError("筆記需要指定已匯入的原始 PDF。")
            pages = {b["page"] for b in json.loads(original["blocks"])}
            if kind == "note" and (not any(b["page"] for b in blocks) or any(b["page"] and b["page"] not in pages for b in blocks)):
                raise ValueError("筆記至少需要一個有效的 <!-- page: N -->，所有頁碼均須可追溯。")
        exists = db.execute("SELECT 1 FROM documents WHERE id=?", (document_id,)).fetchone()
        if not exists:
            db.execute("""INSERT INTO documents (id,name,digest,revision,kind,active,raw,markdown,blocks,original_id,official)
                          VALUES (?,?,?,?,?,1,?,?,?,?,?)""",
                       (document_id, name, digest, revision, kind, raw, markdown, json.dumps(blocks, ensure_ascii=False), original_id, int(official)))
            for i, (block_id, text) in enumerate(chunks_for(blocks)):
                block = blocks[block_id]
                # Unlocated note sections may be read in the UI but cannot serve as PDF evidence.
                if kind == "note" and not block["page"]:
                    continue
                section = " · ".join(filter(None, (name, block["section"]))) if kind == "personal" else block["section"]
                db.execute("INSERT INTO chunks VALUES (?,?,?,?,?,?,?)",
                           (f"{document_id}-{i}", document_id, i, section, block["page"], text, json.dumps([block_id])))
            db.executemany("INSERT INTO assets VALUES (?,?,?)", [(document_id, p, b) for p, b in assets.items()])
        if note_id:
            db.execute("UPDATE documents SET active=1 WHERE id=?", (document_id,))
        else:
            db.execute("UPDATE documents SET active=(id=?) WHERE name=? AND kind=? AND original_id IS ?",
                       (document_id, name, kind, original_id))
    return document_id
