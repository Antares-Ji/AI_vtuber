"""Freeze the current survival planner/schema contract without touching v1."""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data/minecraft-training/contract-v2.json"

def main():
    raw = subprocess.check_output(["node", str(ROOT / "scripts/minecraft-training/export_contract.js")], cwd=ROOT)
    contract = json.loads(raw)
    contract["version"] = 2
    contract["schema_source"] = "src/minecraft/survival-skills.js"
    contract["system_source"] = "src/minecraft/survival-planner.js"
    contract["source_sha256"] = {
        path.relative_to(ROOT).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in (ROOT / "src/minecraft/survival-skills.js", ROOT / "src/minecraft/survival-planner.js")
    }
    OUT.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{OUT.relative_to(ROOT)} schema actions={len(contract['schema']['oneOf'])}")

if __name__ == "__main__":
    main()
