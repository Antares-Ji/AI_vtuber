"""Summarize 47-row dev-grid predictions by slice and policy-relevant dimensions."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output" / "minecraft-training"
DATA = OUT / "v5r2-development47.jsonl"
PREFIX = "v5r2-dev47"
MODELS = ("base", "v4r1", "epoch-01", "epoch-02")


def in_set(predicted, expected_set):
    if not isinstance(predicted, dict) or not isinstance(expected_set, dict):
        return False
    if set(predicted) != set(expected_set):
        return False
    for key, allowed in expected_set.items():
        value = predicted.get(key)
        if isinstance(allowed, list):
            if value not in allowed:
                return False
        elif isinstance(allowed, dict) and {"min", "max"} <= set(allowed):
            if type(value) is not int or not allowed["min"] <= value <= allowed["max"]:
                return False
        elif value != allowed:
            return False
    return True


def metrics(rows):
    if not rows:
        return {"n": 0}
    pred = [r.get("predicted") for r in rows]
    exact = [bool(r.get("exact_match")) for r in rows]
    valid = [bool(r.get("schema_valid")) for r in rows]
    accepted = [bool(r.get("schema_valid")) and in_set(r.get("predicted"), r.get("expectedActionSet", r["action"])) for r in rows]
    progression = [i for i, r in enumerate(rows) if r["action"]["action"] not in ("observe", "eat", "flee")]
    threats = [i for i, r in enumerate(rows) if r.get("state", {}).get("threats")]
    fullfood = [i for i, r in enumerate(rows) if r.get("state", {}).get("food") == 20 and any(x.get("result", {}).get("alreadyFull") is True for x in json.loads(r["messages"][1]["content"]).get("recentResults", []))]
    toolcraft = [i for i, r in enumerate(rows) if r["action"].get("item") in ("wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe")]
    recipe_enum = [i for i, r in enumerate(rows) if r["action"].get("item") in ("planks", "stick", "crafting_table")]
    wood_recovery = [i for i, r in enumerate(rows) if r["action"]["action"] in ("gather_wood", "explore") and (not r["state"].get("resources", {}).get("wood") or r["state"].get("recentFailures"))]
    def ratio(ids, values):
        return {"n": len(ids), "pass": sum(values[i] for i in ids), "rate": round(sum(values[i] for i in ids)/len(ids), 4) if ids else None}
    return {
        "n": len(rows),
        "strictSchema": {"pass": sum(valid), "rate": round(sum(valid)/len(rows), 4)},
        "actionName": {"pass": sum(bool(r.get("action_name_match")) for r in rows), "rate": round(sum(bool(r.get("action_name_match")) for r in rows)/len(rows), 4)},
        "exactActionObject": {"pass": sum(exact), "rate": round(sum(exact)/len(rows), 4)},
        "acceptedActionSetOrExact": {"pass": sum(accepted), "rate": round(sum(accepted)/len(rows), 4)},
        "progressionAccepted": ratio(progression, accepted),
        "threatPriorityFlee": {"n": len(threats), "pass": sum(valid[i] and isinstance(pred[i], dict) and pred[i].get("action") == "flee" for i in threats), "rate": round(sum(valid[i] and isinstance(pred[i], dict) and pred[i].get("action") == "flee" for i in threats)/len(threats), 4) if threats else None},
        "fullFoodNoOpAvoided": {"n": len(fullfood), "pass": sum(valid[i] and isinstance(pred[i], dict) and pred[i].get("action") != "eat" for i in fullfood), "rate": round(sum(valid[i] and isinstance(pred[i], dict) and pred[i].get("action") != "eat" for i in fullfood)/len(fullfood), 4) if fullfood else None},
        "toolStageCraftAccepted": ratio(toolcraft, accepted),
        "recipeEnumActionsAccepted": ratio(recipe_enum, accepted),
        "woodRecoverySliceAccepted": ratio(wood_recovery, accepted),
        "latencyMs": {"median": sorted(r["latency_ms"] for r in rows)[len(rows)//2], "mean": round(sum(r["latency_ms"] for r in rows)/len(rows), 1)},
    }


def main():
    source = [json.loads(line) for line in DATA.read_text(encoding="utf-8").splitlines() if line.strip()]
    source_ids = [row["id"] for row in source]
    if len(source) != 47 or len(source_ids) != len(set(source_ids)):
        raise SystemExit(f"Dev input must contain exactly 47 unique rows; found {len(source)} rows, {len(set(source_ids))} unique IDs")
    report = {"evaluationData": str(DATA.resolve()), "evaluationSha256": __import__("hashlib").sha256(DATA.read_bytes()).hexdigest(), "n": len(source), "selectionRule": "Do not select by loss alone. Report slice/action-set semantics and retention of base behavior; final holdout excluded.", "models": {}}
    for model in MODELS:
        path = OUT / f"{PREFIX}-{model}.jsonl"
        predictions = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        predicted_ids = [row["id"] for row in predictions]
        if len(predictions) != 47 or len(predicted_ids) != len(set(predicted_ids)):
            raise SystemExit(f"Expected 47 unique predictions for {model}; found {len(predictions)} rows, {len(set(predicted_ids))} unique IDs")
        by_id = {row["id"]: row for row in predictions}
        if set(by_id) != {row["id"] for row in source}:
            raise SystemExit(f"Row ID mismatch for {model}: {len(by_id)} predictions")
        merged = []
        for row in source:
            result = dict(row)
            result.update(by_id[row["id"]])
            merged.append(result)
        slices = {name: [r for r in merged if r.get("comparisonSlice") == name] for name in ("legacy27", "v4-allowed-set8", "v5r2-dense12")}
        broad26 = [r for r in slices["legacy27"] if r["id"].startswith("development-v2-")]
        two_probes = [r for r in slices["legacy27"] if r["id"] in ("development-v2-0025", "development-v3r1-real-material-probe")]
        report["models"][model] = {
            "all47": metrics(merged),
            "legacyFrozenBroad26": metrics(broad26),
            "legacyRealProbeRows2": metrics(two_probes),
            "v4AllowedSet8": metrics(slices["v4-allowed-set8"]),
            "v5r2Dense12": metrics(slices["v5r2-dense12"]),
            "predictionsById": {r["id"]: r.get("predicted") for r in merged},
        }
    base_predictions = {row["id"]: row for row in [json.loads(line) for line in (OUT / f"{PREFIX}-base.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]}
    v4_predictions = {row["id"]: row for row in [json.loads(line) for line in (OUT / f"{PREFIX}-v4r1.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]}
    for model in MODELS[1:]:
        model_predictions = {row["id"]: row for row in [json.loads(line) for line in (OUT / f"{PREFIX}-{model}.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]}
        regressions, v4_regressions = [], []
        for row in source:
            base_pred = base_predictions[row["id"]]
            v4_pred = v4_predictions[row["id"]]
            model_pred = model_predictions[row["id"]]
            expected = row.get("expectedActionSet", row["action"])
            base_ok = bool(base_pred.get("schema_valid")) and in_set(base_pred.get("predicted"), expected)
            v4_ok = bool(v4_pred.get("schema_valid")) and in_set(v4_pred.get("predicted"), expected)
            model_ok = bool(model_pred.get("schema_valid")) and in_set(model_pred.get("predicted"), expected)
            if base_ok and not model_ok:
                regressions.append({"id": row["id"], "slice": row.get("comparisonSlice"), "scenario": row.get("scenario"), "base": base_pred.get("predicted"), "model": model_pred.get("predicted")})
            if v4_ok and not model_ok:
                v4_regressions.append({"id": row["id"], "slice": row.get("comparisonSlice"), "scenario": row.get("scenario"), "v4r1": v4_pred.get("predicted"), "model": model_pred.get("predicted")})
        report["models"][model]["baseAcceptedToModelRejected"] = regressions
        report["models"][model]["v4r1AcceptedToModelRejected"] = v4_regressions
    out = OUT / "v5r2-development47-summary.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
