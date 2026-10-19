"""Summarize base-versus-adapter holdout reports without changing either."""
import argparse
import json
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("baseline", type=Path)
    p.add_argument("adapter", type=Path)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    base, tuned = json.loads(a.baseline.read_text(encoding="utf-8")), json.loads(a.adapter.read_text(encoding="utf-8"))
    for key in ("holdout_file", "n", "synthetic_holdout_only"):
        if base.get(key) != tuned.get(key):
            raise SystemExit(f"Cannot compare runs: field {key!r} differs ({base.get(key)!r} vs {tuned.get(key)!r}).")
    metrics = ["exact_action_object_accuracy", "strict_json_schema_valid_rate", "threat_priority_accuracy", "progression_exact_accuracy"]
    report = {
        "baseline": str(a.baseline), "adapter": str(a.adapter), "holdout_file": base["holdout_file"], "n": base["n"],
        "metrics": {key: {"base": base.get(key), "adapter": tuned.get(key), "delta": (tuned.get(key) - base.get(key)) if base.get(key) is not None and tuned.get(key) is not None else None} for key in metrics},
        "interpretation": "Small synthetic holdout comparison. A positive delta is agreement improvement on these authored labels only; it does not prove better Minecraft gameplay or generalization.",
    }
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
