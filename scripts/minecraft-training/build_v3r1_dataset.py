"""Build audited v3r1 data while preserving all earlier datasets verbatim."""
from __future__ import annotations

import copy
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data/minecraft-training"
OUTPUT = ROOT / "output/minecraft-training"
sys.path.insert(0, str(ROOT / "scripts/minecraft-training"))
from build_v3_dataset import (  # noqa: E402
    material_recovery_examples, compact_states, make_record, read_jsonl,
)

EXCLUDED_SOURCE_IDS = {
    "train-v2-0015": "resource lies beyond the observation/action range; do not invent a nearer resource",
    "train-v2-0043": "coal mining requires a pickaxe; state has none in inventory/tools/heldItem/equipment",
    "train-v2-0044": "coal mining requires a pickaxe; state has none in inventory/tools/heldItem/equipment",
    "train-v2-0061": "resource lies beyond the observation/action range; do not invent a nearer resource",
    "train-v2-0062": "resource lies beyond the observation/action range; do not invent a nearer resource",
    "train-v2-0087": "lava fixture lies beyond the observation/cooling-site range; do not invent a nearer hazard",
    "train-v2-0107": "hunt requires a visible allowed animal; state animals is empty",
}
EXCLUDED_MATERIAL_IDS = {
    "MAT3-17": "duplicate normalized input/action of MAT3-13",
    "MAT3-20": "duplicate normalized input/action of MAT3-16",
    "MAT3-24": "duplicate normalized input with non-unique direction label also represented by MAT3-21",
}
GEOMETRY_REPAIRS = {"ER3-006", "ER3-007", "ER3-015", "ER3-023"}


def normalize_review_geometry(row):
    """Repair only four explicit source type errors; never alter other coordinates."""
    row = copy.deepcopy(row)
    for key in ("threats", "hazards"):
        for item in row["state"].get(key, []):
            position = item.get("position")
            if not isinstance(position, dict) or "z" not in position:
                continue
            z = position["z"]
            if z is None or isinstance(z, str):
                try:
                    position["z"] = float(z) if z is not None else 0
                except ValueError:
                    raise SystemExit(f"Unrepairable z coordinate for {row['id']}: {z!r}")
                if position["z"].is_integer() if isinstance(position["z"], float) else False:
                    position["z"] = int(position["z"])
    return row


def executor_diagnostics(cases):
    result = []
    disposition = {
        "ER3-DEV-01": ("inconsistent-observation", "Threat is absent from the model-visible state; do not score hunt as policy gold."),
        "ER3-DEV-02": ("inconsistent-observation", "Threat is absent from the model-visible state; do not score hunt as policy gold."),
        "ER3-DEV-03": ("unverified-boundary", "Review geometry alone does not establish a successful hunt or visible hostile."),
        "ER3-DEV-04": ("non-unique-direction", "Same model-visible input as DEV-06; direction label is arbitrary."),
        "ER3-DEV-05": ("executor-refusal", "Adjacent lava makes emergencyExplore fail its verified-safe-stand guard."),
        "ER3-DEV-06": ("non-unique-direction", "Same model-visible input as DEV-04; direction label is arbitrary."),
        "ER3-DEV-07": ("supplemental-policy-check", "Eat is a reasonable low-health action when the supplied food is safe and available."),
    }
    for row in cases:
        kind, note = disposition[row["id"]]
        record = {"id": row["id"], "scenario": row["scenario"], "provenance": row["provenance"],
                  "diagnosticType": kind, "state": row["state"],
                  "attemptedAction": row["action"], "notes": note}
        if row["id"] == "ER3-DEV-07":
            record["supplementalPolicyReference"] = {"action": "eat"}
        if row["id"] == "ER3-DEV-05":
            record["expectedExecutorResult"] = "rejected: unsafe adjacent lava / no verified safe short route"
        result.append(record)
    return result


def main():
    contract_path = DATA / "contract-v3r1.json"
    if not contract_path.exists():
        subprocess.check_call(["python", str(ROOT / "scripts/minecraft-training/freeze_v3r1_contract.py")], cwd=ROOT)
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    source_train_path = DATA / "train-v2.jsonl"
    source_dev_path = DATA / "development-v2.jsonl"
    candidate_path = DATA / "emergency-recovery-v3-candidates.json"
    material = material_recovery_examples(read_jsonl(source_train_path)[0]["state"])

    source_train = [row for row in read_jsonl(DATA / "train-v2.jsonl") if row["id"] not in EXCLUDED_SOURCE_IDS]
    candidates_doc = json.loads(candidate_path.read_text(encoding="utf-8"))
    candidates = [normalize_review_geometry(row) if row["id"] in GEOMETRY_REPAIRS else row
                  for row in candidates_doc["trainingCandidates"]]
    material = [row for row in material if row["id"] not in EXCLUDED_MATERIAL_IDS]
    sources = []
    for row in source_train:
        payload = json.loads(row["messages"][1]["content"])
        sources.append({**row, "userPayload": payload})
    sources.extend(candidates)
    sources.extend(material)

    states = compact_states([row["state"] for row in sources])
    train = [make_record(row, contract, state) for row, state in zip(sources, states)]

    # Policy dev keeps the frozen 26-row v2 slice unchanged plus one new real
    # base-reference prompt. The older real probe is already in those 26 rows.
    dev = read_jsonl(source_dev_path)
    probe_path = OUTPUT / "live-probe-1791833435547.json"
    probe = json.loads(probe_path.read_text(encoding="utf-8"))
    action = json.loads(probe["results"][0]["content"])
    messages = copy.deepcopy(probe["messages"])
    messages.append({"role": "assistant", "content": json.dumps(action, ensure_ascii=False, separators=(",", ":"))})
    dev.append({"id": "development-v3r1-real-material-probe",
                "scenario": "真实只读材料消耗失败快照；参考为同输入历史基座动作",
                "provenance": f"real; read-only historical probe; same-input base response; source={probe_path.relative_to(ROOT).as_posix()}",
                "rationale": "基座曾选craft planks，v2 adapter误选crafting_table；仅作不回归检查，不证明成功。",
                "action": action, "state": probe["state"], "messages": messages})

    branches = {b["properties"]["action"].get("const"): b["properties"] for b in contract["schema"]["oneOf"]}
    for row in train + dev:
        action = row["action"]
        props = branches.get(action.get("action"))
        if not props or set(action) != set(props):
            raise SystemExit(f"Invalid action keys/schema in {row['id']}: {action}")
        for key, rule in props.items():
            if "enum" in rule and action[key] not in rule["enum"]:
                raise SystemExit(f"Invalid enum in {row['id']}: {action}")
            if rule.get("type") == "integer" and (type(action[key]) is not int or not rule["minimum"] <= action[key] <= rule["maximum"]):
                raise SystemExit(f"Invalid integer in {row['id']}: {action}")

    train_path, dev_path = DATA / "train-v3r1.jsonl", DATA / "development-v3r1.jsonl"
    train_path.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in train), encoding="utf-8", newline="\n")
    dev_path.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in dev), encoding="utf-8", newline="\n")
    diagnostics_path = DATA / "executor-diagnostics-v3r1.jsonl"
    dev_cases = candidates_doc["suggestedDevelopmentCases"]
    diagnostics = executor_diagnostics(dev_cases)
    diagnostics_path.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n" for row in diagnostics), encoding="utf-8", newline="\n")

    manifest = {
        "experiment": "minecraft-survival-policy-v3r1-fresh-base",
        "contract": "data/minecraft-training/contract-v3r1.json",
        "contract_sha256": hashlib.sha256(contract_path.read_bytes()).hexdigest(),
        "train_examples": len(train), "development_examples": len(dev),
        "training_composition": {"audited_v2_training_derived": len(source_train),
                                 "emergency_recovery_synthetic_candidates": len(candidates),
                                 "material_recovery_and_positive_controls_synthetic": len(material)},
        "excluded_source_ids": EXCLUDED_SOURCE_IDS,
        "excluded_duplicate_material_ids": EXCLUDED_MATERIAL_IDS,
        "corrected_input_ids": {key: "converted malformed threat/hazard z coordinate to numeric 0; source candidate retained unchanged" for key in sorted(GEOMETRY_REPAIRS)},
        "source_hashes": {"train-v2.jsonl": hashlib.sha256(source_train_path.read_bytes()).hexdigest(),
                          "development-v2.jsonl": hashlib.sha256(source_dev_path.read_bytes()).hexdigest(),
                          "emergency-recovery-v3-candidates.json": hashlib.sha256(candidate_path.read_bytes()).hexdigest()},
        "development_composition": {"frozen_v2_rows_unchanged": 26, "new_real_material_probe": 1},
        "executor_diagnostics": {"path": diagnostics_path.relative_to(ROOT).as_posix(),
                                 "count": len(diagnostics), "excluded_from_policy_score": True,
                                 "supplemental_policy_reference": "ER3-DEV-07 only; report separately"},
        "initialization": "fresh base; no v1/v2 adapter resume",
        "holdout_used": False,
        "limitations": "Synthetic training examples and 27 development prompts (26 frozen plus one real immutable prompt). Metrics measure label agreement, not gameplay success. Executor boundary diagnostics are not policy gold; no final holdout was accessed.",
    }
    (DATA / "manifest-v3r1.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
