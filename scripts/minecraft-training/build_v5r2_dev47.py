"""Build the frozen 47-row candidate comparison set; excludes all holdout files."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data" / "minecraft-training"
OUT = ROOT / "output" / "minecraft-training"
SOURCES = [
    ("development-v3r1.jsonl", "legacy27"),
    ("development-v4r1-candidates.jsonl", "v4-allowed-set8"),
    ("development-v5r2-candidates.jsonl", "v5r2-dense12"),
]
EXPECTED = {"legacy27": 27, "v4-allowed-set8": 8, "v5r2-dense12": 12}


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> None:
    rows = []
    input_hashes = {}
    for filename, slice_name in SOURCES:
        raw = (DATA / filename).read_bytes()
        input_hashes[filename] = sha(raw)
        selected = [json.loads(line) for line in raw.decode("utf-8").splitlines() if line.strip()]
        if len(selected) != EXPECTED[slice_name]:
            raise SystemExit(f"{filename}: expected {EXPECTED[slice_name]}, got {len(selected)}")
        for row in selected:
            if "action" not in row or "messages" not in row:
                raise SystemExit(f"{row.get('id')}: incomplete dev record")
            row["comparisonSlice"] = slice_name
            rows.append(row)
    ids = [row["id"] for row in rows]
    if len(rows) != 47 or len(ids) != len(set(ids)):
        raise SystemExit(f"Expected 47 unique IDs; rows={len(rows)} unique={len(set(ids))}")
    payload = "".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in rows).encode("utf-8")
    out = OUT / "v5r2-development47.jsonl"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(payload)
    contract = DATA / "contract-v3r1.json"
    report = {
        "status": "frozen candidate evaluation input; no final holdout used",
        "path": str(out.resolve()),
        "sha256": sha(payload),
        "rows": len(rows),
        "sliceCounts": EXPECTED,
        "inputs": input_hashes,
        "contract": str(contract.resolve()),
        "contractSha256": sha(contract.read_bytes()),
        "holdoutRead": False,
        "purpose": "Same-input base/v4r1/v5r2 checkpoint development comparison only; no automatic deployment.",
    }
    (OUT / "v5r2-development47-manifest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
