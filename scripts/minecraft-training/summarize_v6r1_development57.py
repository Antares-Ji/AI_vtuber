"""Schema-gated summary for the frozen 57-row v6r1 development grid."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output" / "minecraft-training"
DATA = OUT / "v6r1-development57.jsonl"
PREFIX = "v6r1-dev57"
MODELS = ("v4r1", "v6r1-epoch01")


def in_set(predicted, expected_set):
    if not isinstance(predicted, dict) or not isinstance(expected_set, dict) or set(predicted) != set(expected_set):
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


def accepted(row):
    return bool(row.get("schema_valid")) and in_set(row.get("predicted"), row.get("expectedActionSet", row["action"]))


def metrics(rows):
    if not rows:
        return {"n": 0}
    valid = [bool(r.get("schema_valid")) for r in rows]
    ok = [accepted(r) for r in rows]
    action_name = [valid[i] and isinstance(rows[i].get("predicted"), dict) and rows[i]["predicted"].get("action") == rows[i]["action"].get("action") for i in range(len(rows))]
    threats = [i for i, r in enumerate(rows) if r.get("state", {}).get("threats")]
    fullfood = [i for i, r in enumerate(rows) if r.get("state", {}).get("food") == 20 and any(x.get("result", {}).get("alreadyFull") is True for x in json.loads(r["messages"][1]["content"]).get("recentResults", []))]
    low_food = [i for i, r in enumerate(rows) if r.get("action", {}).get("action") == "eat" and r.get("state", {}).get("food", 20) < 20]
    toolcraft = [i for i, r in enumerate(rows) if r.get("action", {}).get("item") in ("wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe")]
    recipe = [i for i, r in enumerate(rows) if r.get("action", {}).get("item") in ("planks", "stick", "crafting_table")]
    wood_recovery = [i for i, r in enumerate(rows) if r.get("action", {}).get("action") == "gather_wood"]

    def rate(indices, values):
        total = sum(values[i] for i in indices)
        return {"n": len(indices), "pass": total, "rate": round(total / len(indices), 4) if indices else None}

    latency = [float(r["latency_ms"]) for r in rows if isinstance(r.get("latency_ms"), (int, float))]
    latency.sort()
    return {
        "n": len(rows),
        "strictSchema": {"pass": sum(valid), "rate": round(sum(valid) / len(rows), 4)},
        "actionNameSchemaGated": {"pass": sum(action_name), "rate": round(sum(action_name) / len(rows), 4)},
        "acceptedActionSetOrExactSchemaGated": {"pass": sum(ok), "rate": round(sum(ok) / len(rows), 4)},
        "threatPriorityFleeSchemaGated": rate(threats, [valid[i] and isinstance(rows[i].get("predicted"), dict) and rows[i]["predicted"].get("action") == "flee" for i in range(len(rows))]),
        "fullFoodNoOpAvoided": rate(fullfood, [valid[i] and isinstance(rows[i].get("predicted"), dict) and rows[i]["predicted"].get("action") != "eat" for i in range(len(rows))]),
        "lowFoodExpectedEatAccepted": rate(low_food, ok),
        "toolTierCraftAccepted": rate(toolcraft, ok),
        "recipePrerequisiteAccepted": rate(recipe, ok),
        "gatherWoodRecoveryAccepted": rate(wood_recovery, ok),
        "latencyMs": {"n": len(latency), "median": latency[len(latency) // 2] if latency else None, "mean": round(sum(latency) / len(latency), 1) if latency else None},
    }


def load_jsonl(path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main():
    source = load_jsonl(DATA)
    ids = [r["id"] for r in source]
    if len(source) != 57 or len(set(ids)) != 57:
        raise SystemExit(f"Frozen evaluation input must be 57 unique rows; found {len(source)} rows/{len(set(ids))} IDs")
    merged_by_model = {}
    report = {"evaluationData": str(DATA.resolve()), "evaluationSha256": hashlib.sha256(DATA.read_bytes()).hexdigest(), "n": 57,
              "slices": {"previousFrozen47": 47, "newV6r1IndependentDev10": 10},
              "selectionRule": "Development-only semantic comparison; schema validity gates every accepted action; report v4r1 row regressions and v6-specific dimensions; no final holdout or training-fit live probes used.",
              "models": {}}
    for model in MODELS:
        predictions = load_jsonl(OUT / f"{PREFIX}-{model}.jsonl")
        pids = [r["id"] for r in predictions]
        if len(predictions) != 57 or len(set(pids)) != 57 or set(pids) != set(ids):
            raise SystemExit(f"{model}: expected exactly 57 unique, matching prediction IDs; found {len(predictions)} rows/{len(set(pids))} IDs")
        by_id = {r["id"]: r for r in predictions}
        merged = []
        for row in source:
            result = dict(row)
            result.update(by_id[row["id"]])
            merged.append(result)
        merged_by_model[model] = merged
        old = [r for r in merged if r.get("comparisonSlice")]
        new = [r for r in merged if r["id"].startswith("v6r1-dev-")]
        old_slices = {name: [r for r in old if r.get("comparisonSlice") == name] for name in ("legacy27", "v4-allowed-set8", "v5r2-dense12")}
        new_action_groups = {
            "recipeRecovery": [r for r in new if r["action"].get("item") in ("planks", "stick", "crafting_table")],
            "toolTierCraft": [r for r in new if r["action"].get("item") in ("wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe")],
            "woodRecovery": [r for r in new if r["action"].get("action") == "gather_wood"],
            "foodRecovery": [r for r in new if r["action"].get("action") == "eat"],
            "resourceMining": [r for r in new if r["action"].get("action") == "mine"],
        }
        report["models"][model] = {"all57": metrics(merged), "previousFrozen47": metrics(old), "newV6r1Dev10": metrics(new),
                                   "previousSlices": {name: metrics(rows) for name, rows in old_slices.items()},
                                   "newActionGroups": {name: metrics(rows) for name, rows in new_action_groups.items()},
                                   "predictionsById": {r["id"]: r.get("predicted") for r in merged}}
    v4 = {r["id"]: r for r in merged_by_model["v4r1"]}
    for model in ("v6r1-epoch01",):
        by_id = {r["id"]: r for r in merged_by_model[model]}
        regressions, fixes = [], []
        for source_row in source:
            old, new = v4[source_row["id"]], by_id[source_row["id"]]
            old_ok, new_ok = accepted(old), accepted(new)
            item = {"id": source_row["id"], "slice": source_row.get("comparisonSlice", "newV6r1Dev10"), "scenario": source_row.get("scenario"),
                    "v4r1": old.get("predicted"), model: new.get("predicted"), "v4r1SchemaValid": old.get("schema_valid"), "modelSchemaValid": new.get("schema_valid")}
            if old_ok and not new_ok:
                regressions.append(item)
            if not old_ok and new_ok:
                fixes.append(item)
        report["models"][model]["v4r1AcceptedToRejected"] = regressions
        report["models"][model]["v4r1RejectedToAccepted"] = fixes
    out = OUT / "v6r1-development57-summary.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
