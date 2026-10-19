"""Summarize exact live-probe replays as diagnostics only, with no gold scoring."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "output" / "minecraft-training"
MODELS = ("base", "v4r1", "epoch-01", "epoch-02")
PROBES = [
    ("1791830746219", "resource_access_ambiguous", "Wood was observed but the live trial later encountered high/inaccessible wood; action-path outcome is not a hard model label."),
    ("1791833435547", "material_recovery_clear", "The identical recorded input was previously answered with craft planks 4 by base and v4r1; inspect whether each model chooses a material-feasible recovery. This is a diagnostic reference, not a training row."),
    ("1791836151666", "stage_ambiguous_with_material_check", "Do not score gather-versus-planks as a unique gold action. Independently check whether a proposed planks count exceeds the one observed log; schema validity alone is insufficient."),
    ("1791838384663", "full_food_noop_clear", "Food is already full; avoid an eat no-op. Other useful actions are diagnostic, not exact gold labels."),
]


def main():
    result = {"status": "diagnostic only; no hard action gold, no holdout", "models": MODELS, "probes": []}
    for probe_id, classification, interpretation in PROBES:
        filename = f"live-probe-{probe_id}.json"
        source = OUT / filename
        source_data = json.loads(source.read_text(encoding="utf-8"))
        inventory = source_data.get("state", {}).get("inventory", [])
        log_count = sum(i.get("count", 0) for i in inventory if i.get("name", "").endswith("_log"))
        record = {"source": filename, "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(), "classification": classification, "interpretation": interpretation, "observedLogCount": log_count, "predictions": {}}
        for model in MODELS:
            path = OUT / f"v5r2-dev47-probe-{source.stem}-{model}.json"
            value = json.loads(path.read_text(encoding="utf-8"))
            action = value.get("predicted")
            material_check = None
            if isinstance(action, dict) and action.get("action") == "craft" and action.get("item") == "planks":
                max_planks = log_count * 4
                material_check = {"feasibleFromObservedLogs": type(action.get("count")) is int and action["count"] <= max_planks, "requestedPlanks": action.get("count"), "maxPlanksFromObservedLogs": max_planks}
            record["predictions"][model] = {
                "action": action,
                "schemaValid": value.get("schema_valid"),
                "directGridAdapterContext": value.get("request_metadata"),
                "contextNote": "Local direct-grid evaluator metadata; not an HTTP completion response or endpoint metadata verification.",
                "latencyMs": value.get("latency_ms"),
                "materialCheck": material_check,
            }
        result["probes"].append(record)
    target = OUT / "v5r2-live-probe-diagnostics-summary.json"
    target.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
