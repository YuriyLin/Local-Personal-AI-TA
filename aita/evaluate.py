"""Evaluate retrieval using [split, topic_id, question, relevant_pdf_pages] JSON rows."""
import argparse
import json
from pathlib import Path
from statistics import mean, median
from time import perf_counter

from . import tutor


def evaluate(questions, rows):
    output = {}
    for method in ("tfidf", "dense", "hybrid"):
        runs = []
        for split, topic, question, expected in questions:
            start = perf_counter()
            evidence, used, warning = tutor.retrieve(rows, question, method)
            if method != used:
                raise RuntimeError(f"{method} benchmark cannot use {used}: {warning}")
            pages = [e["page"] for e in evidence]
            runs.append({"split": split, "id": topic, "expected": expected, "pages": pages,
                         "hit": bool(set(pages) & set(expected)), "recall": len(set(pages) & set(expected)) / len(expected) if expected else None,
                         "latency_ms": round((perf_counter() - start) * 1000)})
        output[method] = {}
        for split in ("dev", "test"):
            batch = [r for r in runs if r["split"] == split]
            answerable = [r for r in batch if r["expected"]]
            unanswered = [r for r in batch if not r["expected"]]
            output[method][split] = {
                "hits": sum(r["hit"] for r in answerable), "answerable": len(answerable),
                "recall": round(mean(r["recall"] for r in answerable), 3),
                "no_answer_with_candidates": sum(bool(r["pages"]) for r in unanswered),
                "no_answer": len(unanswered), "median_ms": median(r["latency_ms"] for r in batch),
            }
        output[method]["runs"] = runs
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("questions", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--source", required=True, help="Exact PDF file name as shown in AITA")
    args = parser.parse_args()
    questions = json.loads(args.questions.read_text(encoding="utf-8"))
    all_rows = [r for r in tutor.evidence_rows() if r["source_name"] == args.source]
    if not any(r["kind"] == "pdf" for r in all_rows):
        parser.error("Import the specified PDF before running an evaluation.")
    subsets = {"original": [r for r in all_rows if r["kind"] == "pdf"], "original_and_notes": all_rows}
    # Warm the local embedding index before measuring individual query latency.
    tutor.dense_scores(all_rows, questions[0][2])
    results = {name: evaluate(questions, rows) for name, rows in subsets.items()}
    args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: {method: r["test"] for method, r in v.items()} for k, v in results.items()}, indent=2))


if __name__ == "__main__":
    main()
