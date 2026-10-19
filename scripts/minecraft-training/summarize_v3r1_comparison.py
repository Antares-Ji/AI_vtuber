"""Summarize v3r1 dev-grid results by broad policy and real-probe slices."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output/minecraft-training"
PREFIX = "v3r1-dev"
MODELS = ("base", "epoch-01", "epoch-02")


def load(model):
    path = OUT / f"{PREFIX}-{model}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def summarize(rows):
    if not rows:
        return {"n": 0}
    progress = [row for row in rows if row.get("expected", {}).get("action") not in ("flee", "eat", "observe")]
    threat = [row for row in rows if row.get("threat_priority_case")]
    result = {
        "n": len(rows),
        "exact_action_object": sum(bool(row.get("exact_match")) for row in rows),
        "action_name": sum(bool(row.get("action_name_match")) for row in rows),
        "schema_valid": sum(bool(row.get("schema_valid")) for row in rows),
        "exact_action_object_rate": sum(bool(row.get("exact_match")) for row in rows) / len(rows),
        "action_name_rate": sum(bool(row.get("action_name_match")) for row in rows) / len(rows),
        "schema_valid_rate": sum(bool(row.get("schema_valid")) for row in rows) / len(rows),
        "progression_cases": len(progress),
        "progression_exact": sum(bool(row.get("exact_match")) for row in progress),
        "progression_exact_rate": sum(bool(row.get("exact_match")) for row in progress) / len(progress) if progress else None,
        "threat_cases": len(threat),
        "threat_priority_passes": sum(bool(row.get("threat_priority_pass")) for row in threat),
        "threat_priority_rate": sum(bool(row.get("threat_priority_pass")) for row in threat) / len(threat) if threat else None,
    }
    return result


def main():
    runs = {model: load(model) for model in MODELS}
    lookup = {model: {row["id"]: row for row in rows} for model, rows in runs.items()}
    broad_ids = [row["id"] for row in runs["base"] if row["id"].startswith("development-v2-")]
    probe_ids = ["development-v2-0025", "development-v3r1-real-material-probe"]
    summary = {"evaluation_data": "data/minecraft-training/development-v3r1.jsonl",
               "contract": "data/minecraft-training/contract-v3r1.json",
               "selection_note": "Report the 26-row broad slice and the two real probes separately; do not use executor diagnostics as policy labels or touch the frozen final holdout.",
               "models": {}}
    baseline_ids = set(lookup["base"])
    for model in MODELS:
        rows = lookup[model]
        if set(rows) != baseline_ids:
            raise SystemExit(f"Row IDs differ for {model}")
        broad = [rows[row_id] for row_id in broad_ids]
        probes = [rows[row_id] for row_id in probe_ids]
        wood = rows["development-v2-0025"].get("predicted") or {}
        planks = rows["development-v3r1-real-material-probe"].get("predicted") or {}
        repairs = {
            "no_animals_nearby_wood": bool(rows["development-v2-0025"].get("schema_valid") and wood.get("action") == "gather_wood" and type(wood.get("count")) is int and 1 <= wood["count"] <= 12),
            "logs_planks_table_failure": bool(rows["development-v3r1-real-material-probe"].get("schema_valid") and planks.get("action") == "craft" and planks.get("item") == "planks" and type(planks.get("count")) is int and 1 <= planks["count"] <= 16),
        }
        agreement_with_base = sum(
            rows[row_id].get("predicted") == lookup["base"][row_id].get("predicted")
            for row_id in broad_ids if model != "base"
        )
        summary["models"][model] = {
            "all_27": summarize(list(rows.values())),
            "frozen_broad_26": summarize(broad),
            "two_real_probes": summarize(probes),
            "probe_predictions": {row_id: rows[row_id].get("predicted") for row_id in probe_ids},
            "real_probe_semantic_repairs": repairs,
            "both_real_probes_repaired": all(repairs.values()),
            "real_probe_repair_count": sum(repairs.values()),
            "broad_prediction_objects_matching_base": agreement_with_base if model != "base" else 26,
        }
    path = OUT / "v3r1-dev-comparison.json"
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    md = ["# v3r1 fresh-base development comparison", "",
          "The final frozen holdout was not read. The 26 frozen v2 development prompts and two real probes are reported separately. The seven executor diagnostics are excluded from policy scoring.", "",
          "| Model | Broad exact | Broad action name | Broad schema valid | Progression exact | Threat priority | Probe repairs | Base object agreement |",
          "|---|---:|---:|---:|---:|---:|---:|---:|"]
    for model in MODELS:
        result = summary["models"][model]
        broad = result["frozen_broad_26"]
        progression = f"{broad['progression_exact']}/{broad['progression_cases']} ({broad['progression_exact_rate']:.1%})" if broad["progression_cases"] else "n/a"
        threat = f"{broad['threat_priority_passes']}/{broad['threat_cases']} ({broad['threat_priority_rate']:.1%})" if broad["threat_cases"] else "n/a"
        md.append(f"| {model} | {broad['exact_action_object']}/26 ({broad['exact_action_object_rate']:.1%}) | {broad['action_name']}/26 ({broad['action_name_rate']:.1%}) | {broad['schema_valid']}/26 ({broad['schema_valid_rate']:.1%}) | {progression} | {threat} | {result['real_probe_repair_count']}/2 | {result['broad_prediction_objects_matching_base']}/26 |")
    md += ["", "Probe checks use action-class semantics with legal count ranges, not exact quantity agreement. A feasible action can still fail Mineflayer pathing or world-state verification. These metrics are development evidence only, not a guarantee of gameplay improvement.", ""]
    (OUT / "v3r1-dev-comparison.md").write_text("\n".join(md), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
