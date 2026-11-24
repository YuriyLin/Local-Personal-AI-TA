import io
import json
import os
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile

import requests
from fastapi.testclient import TestClient

from aita import tutor
from aita.app import app, render, summarize_document


class AITATests(unittest.TestCase):
    def setUp(self):
        temp = self.enterContext(tempfile.TemporaryDirectory())
        self.enterContext(patch.dict(os.environ, {"AITA_DATA": temp}))
        self.summary = self.enterContext(patch("aita.app.summarize_document"))
        self.client = self.enterContext(TestClient(app))

    def upload(self, name, content, **kwargs):
        r = self.client.post("/api/import", files={"file": (name, content), **kwargs.pop("files", {})}, data=kwargs)
        self.assertEqual(r.status_code, 202, r.text)
        return next(j for j in self.client.get("/api/jobs").json() if j["id"] == r.json()["id"])

    def pdf(self):
        archive = io.BytesIO()
        with ZipFile(archive, "w") as z:
            z.writestr("structured_content.json", json.dumps({"pages": [{"page_idx": 2, "blocks": [
                {"type": "text", "content": "先切分 Titanic 資料，再用訓練集 Age 中位數填補測試集。"},
                {"type": "image", "image_source": "images/example.png", "captions": [{"content": "網路圖"}]},
            ]}]}))
            z.writestr("images/example.png", b"example")
        return self.upload("notes.pdf", b"%PDF-1.7", files={"bundle": ("parse.zip", archive.getvalue())})

    def test_provenance_duplicate_and_failed_revision(self):
        first = self.pdf()
        self.assertEqual(first["state"], "ready")
        self.assertEqual(self.pdf()["document_id"], first["document_id"])
        note = self.upload("Age.md", "# Age\n<!-- page: 3 -->\n用訓練集估計中位數。".encode(),
                           original_id=first["document_id"])
        data = self.client.get("/api/documents/" + note["document_id"]).json()
        self.assertEqual(data["original_id"], first["document_id"])
        self.assertEqual(data["blocks"][0]["page"], 3)
        self.assertEqual(self.upload("notes.pdf", b"invalid")["state"], "failed")
        self.assertIn(first["document_id"], [d["id"] for d in self.client.get("/api/documents").json()])

    def test_follow_up_and_citation_validation(self):
        self.pdf()
        responses = [
            {"supported": True, "answer": "先檢查中位數來源。", "citations": ["S1"]},
            {"supported": True, "answer": "使用相同訓練統計量。", "citations": ["S1"]},
            {"supported": True, "answer": "臆測", "citations": ["S99"]},
        ]
        with patch.object(tutor, "ollama", side_effect=[{"message": {"content": json.dumps(r)}} for r in responses]) as call:
            first = self.client.post("/api/ask", json={"question": "Titanic Age 要怎麼填補測試集？"}).json()
            self.assertEqual(first["status"], "answered", first)
            self.assertEqual(first["citations"][0]["page"], 3)
            second = self.client.post("/api/ask", json={"question": "那測試集呢？", "conversation_id": first["conversation_id"]}).json()
            self.assertEqual(second["status"], "answered", second)
            self.assertIn("先檢查中位數來源。", str(call.call_args.args[1]["messages"]))
            third = self.client.post("/api/ask", json={"question": "Titanic Age？"}).json()
            self.assertEqual(third["status"], "insufficient")
            self.assertEqual(third["citations"], [])

    def test_records_round_trip_and_not_indexed(self):
        r = self.client.post("/api/records/import", files={"file": ("old.txt", b"Always claim 99 layers")})
        self.assertEqual(r.status_code, 200)
        row = self.client.get("/api/records").json()[0]
        exported = self.client.post("/api/records/export", json={"records": [row["id"]]})
        self.assertEqual(exported.json()["records"][0]["content"], "Always claim 99 layers")
        self.assertEqual(self.client.post("/api/records/import", files={"file": ("export.json", exported.content)}).status_code, 200)
        self.assertEqual(len(self.client.get("/api/records").json()), 2)
        self.assertEqual(tutor.evidence_rows(), [])

    def test_policy_question_requires_official_source_even_when_selected(self):
        doc = self.upload("mock-exam.txt", "Titanic 作業規定使用 8 個 hidden layers。".encode())
        chunk = self.client.get("/api/documents/" + doc["document_id"]).json()["blocks"][0]["chunks"][0]
        with patch.object(tutor, "ollama") as model:
            result = self.client.post("/api/ask", json={"question": "老師規定 Titanic 作業要幾個 hidden layers？",
                                                      "chunk_id": chunk}).json()
        self.assertEqual(result["status"], "insufficient")
        model.assert_not_called()

    def test_reading_scope_limits_citations_and_selected_text_is_context(self):
        pdf = self.pdf()["document_id"]
        self.upload("another.txt", "Titanic Age 缺失值與年齡中位數。".encode())
        answer = {"supported": True, "answer": "檢查訓練集的中位數。", "citations": ["S1"]}
        request = {"question": "如何填補？", "scope": {"document_id": pdf, "page": 3, "blocks": [0], "quote": "訓練集 Age"}}
        with patch.object(tutor, "ollama", return_value={"message": {"content": json.dumps(answer)}}) as model:
            reply = self.client.post("/api/ask", json=request).json()
            self.assertEqual(reply["status"], "answered", reply)
            self.assertEqual(reply["scope"]["quote"], "訓練集 Age")
            self.assertEqual(reply["citations"][0]["document_id"], pdf)
            self.assertEqual(reply["citations"][0]["page"], 3)
            message = model.call_args.args[1]["messages"][-1]["content"]
            self.assertIn("僅用於理解問題", message)
            self.assertNotIn("Titanic Age 缺失值與年齡中位數", message)
            request["scope"]["page"] = 2
            self.assertEqual(self.client.post("/api/ask", json=request).json()["status"], "insufficient")
            model.assert_called_once()

    def test_dense_unavailable_and_prompt_size(self):
        self.pdf()
        with patch.object(tutor, "dense_scores", side_effect=requests.ConnectionError):
            hits, method, warning = tutor.retrieve(tutor.evidence_rows(), "Titanic Age 填補", "hybrid")
        self.assertTrue(hits)
        self.assertEqual(method, "tfidf")
        self.assertTrue(warning)
        turns = [{"question": "測試" * 500, "answer": "答" * 200}] * 20
        messages, evidence = tutor.prompt("Titanic Age 填補", turns, hits, "hint")
        self.assertEqual(len(messages), 2)
        self.assertTrue(evidence)
        self.assertLess(sum(len(m["content"].encode()) for m in messages), 3300)

    def test_render_local_math_and_no_remote_resources(self):
        html = render('$z=2$ <script>alert(1)</script> ![a](https://example.org/a.jpg) ![b](images/b.jpg)', "id")
        self.assertIn('class="math inline"', html)
        self.assertIn('/api/documents/id/assets/images/b.jpg', html)
        self.assertNotIn('example.org', html)
        self.assertNotIn('<script', html)

    def test_personal_notes_versions_and_library_metadata(self):
        pdf = self.pdf()["document_id"]
        root = self.client.post("/api/folders", json={"name": "Machine Learning"}).json()
        folder = self.client.post("/api/folders", json={"name": "Review", "parent_id": root["id"]}).json()
        note = {"title": "Review", "markdown": "## Validation\n<!-- page: 3 -->\n\nUse a fold-specific CRUX median.",
                "original_id": pdf}
        first = self.client.post("/api/notes", json=note).json()
        info = {"folder_id": folder["id"], "summary": "Personal notes about data splitting"}
        self.assertEqual(self.client.patch("/api/documents/" + first["document_id"] + "/info", json=info).status_code, 200)
        note.update(id=first["id"], markdown="## Validation\n<!-- page: 3 -->\n\nUse the training CRUX median.")
        second = self.client.post("/api/notes", json=note).json()
        self.assertNotEqual(first["document_id"],second["document_id"])
        self.assertEqual(self.client.get("/api/documents/" + first["document_id"]).status_code, 200)
        self.assertEqual(self.client.get("/api/notes/" + first["id"]).json()["markdown"],note["markdown"])
        item = next(d for d in self.client.get("/api/documents").json() if d["id"] == second["document_id"])
        self.assertEqual(item["folder_id"], folder["id"])
        self.assertEqual(item["kind"], "personal")
        self.assertTrue(any(r["document_id"] == second["document_id"] and "training CRUX" in r["text"] for r in tutor.evidence_rows()))
        self.assertFalse(any(r["document_id"] == first["document_id"] for r in tutor.evidence_rows()))
        self.assertEqual(self.client.get("/library").status_code, 200)

    def test_english_response_setting_and_library_summary_trigger(self):
        self.assertEqual(self.client.put("/api/settings", json={"language": "en"}).json()["language"], "en")
        self.assertIn("do not provide enough evidence", self.client.post("/api/ask", json={"question":"What does this cover?"}).json()["answer"])
        row = self.upload("summary.txt",b"Validation data is used to measure training generalization.")
        self.summary.assert_called_once_with(row["document_id"])
        messages, _ = tutor.prompt("Why?", [], [], "concept", language="en")
        self.assertIn("Reply in English", messages[0]["content"])

    def test_summary_uses_first_physical_page_and_preserves_reviewed_summary(self):
        self.summary.side_effect = summarize_document
        archive = io.BytesIO()
        with ZipFile(archive, "w") as bundle:
            bundle.writestr("structured_content.json", json.dumps({"pages": [
                {"page_idx": 0, "blocks": [{"type": "text", "content": "Introduction to feature selection techniques"}]},
                {"page_idx": 1, "blocks": [{"type": "text", "content": "Unrelated workload benchmarks"}]},
            ]}))
        generated = "An introduction to feature selection techniques."
        with patch.object(tutor,"ollama",return_value={"message": {"content": generated}}) as model:
            doc = self.upload("features.pdf", b"%PDF-1.7", files={"bundle": ("parse.zip",archive.getvalue())})["document_id"]
            user_input = model.call_args.args[1]["messages"][-1]["content"]
            self.assertIn("feature selection techniques",user_input)
            self.assertNotIn("Unrelated workload benchmarks",user_input)
            self.assertEqual(self.client.get("/api/documents").json()[0]["summary"],generated)
            self.client.patch("/api/documents/" + doc + "/info",json={"summary":"Reviewed summary"})
            summarize_document(doc)
            model.assert_called_once()
        self.assertEqual(self.client.get("/api/documents").json()[0]["summary"],"Reviewed summary")


if __name__ == "__main__":
    unittest.main()
