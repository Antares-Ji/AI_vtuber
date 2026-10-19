"""Snapshot the v1 (pre-v2 survival skills) decoder contract from its corpus."""
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "minecraft-training" / "contract-v1.json"
TRAIN = ROOT / "data" / "minecraft-training" / "train.jsonl"
EXPORT = ROOT / "scripts" / "minecraft-training" / "export_contract.js"
V1_ACTIONS = {"observe", "eat", "flee", "build_portal", "enter_portal", "explore", "gather_wood", "craft", "mine", "smelt", "hunt"}


def main():
    if OUT.exists():
        raise SystemExit(f"Refusing to overwrite frozen contract: {OUT}")
    current = json.loads(subprocess.check_output(["node", str(EXPORT)], cwd=ROOT, text=True, encoding="utf-8"))
    first = json.loads(TRAIN.read_text(encoding="utf-8").splitlines()[0])
    current["schema"]["oneOf"] = [b for b in current["schema"]["oneOf"] if b["properties"]["action"]["const"] in V1_ACTIONS]
    current["system"] = first["messages"][0]["content"]
    current["version"] = "minecraft-survival-policy-v1"
    current["source_note"] = "Schema branches filtered to the 11 actions present in the saved v1 training prompt; system prompt is copied from train.jsonl. Astra v2 additions are intentionally excluded."
    if len(current["schema"]["oneOf"]) != len(V1_ACTIONS):
        raise SystemExit("Could not reconstruct all 11 v1 action branches")
    OUT.write_text(json.dumps(current, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT.relative_to(ROOT)} with {len(V1_ACTIONS)} v1 action variants")


if __name__ == "__main__":
    main()
