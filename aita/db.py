import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent


@contextmanager
def database():
    path = Path(os.environ.get("AITA_DATA", ROOT / "data"))
    path.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path / "aita.sqlite3", timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    try:
        with db:
            yield db
    finally:
        db.close()


def initialize():
    with database() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript("""
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL,
            revision TEXT NOT NULL, kind TEXT NOT NULL, active INTEGER NOT NULL,
            raw BLOB NOT NULL, markdown TEXT NOT NULL, blocks TEXT NOT NULL,
            original_id TEXT REFERENCES documents(id),
            created TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id),
            position INTEGER NOT NULL, section TEXT NOT NULL, page INTEGER,
            text TEXT NOT NULL, blocks TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS chunks_document ON chunks(document_id, position);
        CREATE TABLE IF NOT EXISTS assets (
            document_id TEXT REFERENCES documents(id), path TEXT, content BLOB NOT NULL,
            PRIMARY KEY(document_id, path)
        );
        CREATE TABLE IF NOT EXISTS vectors (
            chunk_id TEXT REFERENCES chunks(id), model TEXT, embedding BLOB NOT NULL,
            PRIMARY KEY(chunk_id, model)
        );
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, message TEXT,
            document_id TEXT REFERENCES documents(id), payload BLOB, options TEXT NOT NULL,
            created TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, created TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS turns (
            id INTEGER PRIMARY KEY, conversation_id TEXT REFERENCES conversations(id),
            question TEXT NOT NULL, answer TEXT NOT NULL, result TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS records (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES folders(id)
        );
        CREATE TABLE IF NOT EXISTS document_info (
            document_id TEXT PRIMARY KEY REFERENCES documents(id),
            summary TEXT, folder_id TEXT REFERENCES folders(id)
        );
        CREATE TABLE IF NOT EXISTS personal_notes (
            id TEXT PRIMARY KEY, original_id TEXT NOT NULL REFERENCES documents(id),
            document_id TEXT NOT NULL REFERENCES documents(id)
        );
        """)
        if "official" not in {r["name"] for r in db.execute("PRAGMA table_info(documents)")}:
            db.execute("ALTER TABLE documents ADD COLUMN official INTEGER NOT NULL DEFAULT 0")
        db.execute("UPDATE jobs SET state='failed', message='服務曾中斷，請重試。' WHERE state IN ('queued','processing')")
