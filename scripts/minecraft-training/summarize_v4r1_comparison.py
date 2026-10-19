"""Summarize the fixed v4r1 comparison by unchanged and new dev slices."""
from __future__ import annotations
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DEV_OLD = ROOT / "data/minecraft-training/development-v3r1.jsonl"
DEV_NEW = ROOT / "data/minecraft-training/development-v4r1-candidates.jsonl"
RAW = ROOT / "output/minecraft-training/v4r1-comparison"
OUT = ROOT / "output/minecraft-training/v4r1-comparison-summary.json"

def read(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

def action_set_match(pred, accepted):
    if not isinstance(pred, dict) or not isinstance(accepted, dict):
        return False
    if pred.get("action") != accepted.get("action"):
        return False
    for key in ("resource", "item"):
        if key in accepted and pred.get(key) != accepted[key]:
            return False
    for key in ("direction",):
        allowed = accepted.get(key)
        if isinstance(allowed, list) and pred.get(key) not in allowed:
            return False
        if isinstance(allowed, str) and pred.get(key) != allowed:
            return False
    for key in ("count", "distance", "steps"):
        rule = accepted.get(key)
        if isinstance(rule, dict):
            value = pred.get(key)
            if not isinstance(value, (int, float)) or not rule.get("min", float("-inf")) <= value <= rule.get("max", float("inf")):
                return False
        elif rule is not None and pred.get(key) != rule:
            return False
    return True

def summarize(rows, raw):
    pred_by_id = {r["id"]: r for r in raw}
    cases = []
    for row in rows:
        result = pred_by_id[row["id"]]
        pred = result.get("predicted")
        expected = row["action"]
        allowed = row.get("expectedActionSet", expected)
        semantic = action_set_match(pred, allowed)
        cases.append({
            "id": row["id"], "expected": expected, "accepted": allowed, "predicted": pred,
            "schema_valid": result.get("schema_valid", False), "exact_match": result.get("exact_match", False),
            "action_name_match": result.get("action_name_match", False), "accepted_action_set_match": semantic,
            "threat": result.get("threat_priority_case", False), "threat_pass": result.get("threat_priority_pass"),
            "progression": result.get("progression_case", False), "latency_ms": result.get("latency_ms")
        })
    n = len(cases)
    threat = [c for c in cases if c["threat"]]
    progression = [c for c in cases if c["progression"]]
    return {
        "n": n,
        "exact": sum(c["exact_match"] for c in cases),
        "action_name": sum(c["action_name_match"] for c in cases),
        "schema_valid": sum(c["schema_valid"] for c in cases),
        "accepted_action_set": sum(c["accepted_action_set_match"] for c in cases),
        "threat_cases": len(threat), "threat_pass": sum(c["threat_pass"] is True for c in threat),
        "progression_cases": len(progression), "progression_exact": sum(c["exact_match"] for c in progression),
        "progression_action_set": sum(c["accepted_action_set_match"] for c in progression),
        "cases": cases
    }

def main():
    old, new = read(DEV_OLD), read(DEV_NEW)
    summary = {"selection_data_only": True, "final_holdout_accessed": False, "slices": {}}
    for model in ("base", "v3r1", "v4r1"):
        raw = read(RAW / f"v4r1-all35-{model}.jsonl")
        by_id = {r["id"]: r for r in raw}
        summary["slices"][model] = {
            "frozen_v3r1_27": summarize(old, [by_id[r["id"]] for r in old]),
            "new_v4r1_8": summarize(new, [by_id[r["id"]] for r in new]),
            "combined_35": summarize(old + new, raw)
        }
    OUT.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for model, data in summary["slices"].items():
        print(model, json.dumps({k: {m: v[m] for m in ("n", "exact", "action_name", "schema_valid", "accepted_action_set", "threat_cases", "threat_pass", "progression_cases", "progression_exact", "progression_action_set")} for k, v in data.items()}, ensure_ascii=False))
    print(f"report: {OUT}")

if __name__ == "__main__":
    main()
