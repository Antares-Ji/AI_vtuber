"""Build a fresh-base v3 corpus without mutating v1/v2/final-holdout files."""
from __future__ import annotations

import copy
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data/minecraft-training"
OUTPUT = ROOT / "output/minecraft-training"
GOAL = "在生存模式自主生存并进入下界"


def read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def inventory(**items):
    return [{"name": name, "count": count} for name, count in items.items() if count]


def material_recovery_examples(template):
    rows = []

    def mk_state(logs, planks, *, failures=0, nearby_wood=False, table=False):
        s = copy.deepcopy(template)
        s["position"] = {"x": 0, "y": 64, "z": 0}
        s["health"], s["food"], s["isNight"] = 20, 19, False
        s["inventory"] = inventory(spruce_log=logs, spruce_planks=planks, stick=4)
        s["stations"] = ([{"name": "crafting_table", "position": {"x": 1, "y": 64, "z": 0}}]
                          if table else [])
        s["resources"] = {k: [] for k in ("stone", "coal", "iron", "diamond", "obsidian", "gravel", "wood")}
        if nearby_wood:
            s["resources"]["wood"] = [{"name": "spruce_log", "position": {"x": 4, "y": 64, "z": 0}, "distance": 4}]
        s["craftable"] = ([{"item": "planks", "outputPerCraft": 4, "requiresTable": False}]
                          if logs else [])
        s["recipeHints"] = ([{"item": "crafting_table", "missing": [{"name": "spruce_planks", "count": 4-planks}], "oneRecipeExample": True}]
                            if planks < 4 else [])
        s["recentFailures"] = [
            {"action": {"action": "craft", "item": "crafting_table", "count": 1},
             "error": "Missing ingredients for crafting_table", "position": {"x": 0, "y": 64, "z": 0}}
            for _ in range(failures)
        ]
        return s

    # Failed craft recovery: varying log/plank counts and repeated failures.
    for i, (logs, planks, failures) in enumerate([
        (1, 0, 1), (2, 0, 2), (3, 0, 4), (4, 0, 1),
        (1, 1, 2), (2, 1, 3), (3, 1, 1), (4, 1, 4),
        (1, 2, 1), (2, 2, 4), (3, 2, 2), (2, 3, 5),
    ], 1):
        rows.append({"id": f"MAT3-{i:02d}", "scenario": "合成材料纠错：工作台多次缺木板，先把原木转成木板",
                     "provenance": "synthetic; hand-authored varied-count material-recovery counterfactual",
                     "rationale": "近期工作台制作失败且当前木板仍不足四块；先用已有原木制作木板，不重复失败的工作台动作。",
                     "state": mk_state(logs, planks, failures=failures),
                     "action": {"action": "craft", "item": "planks", "count": 4}})

    # No logs, but visible wood makes gathering the correct recovery step.
    for i, planks in enumerate((0, 1, 2, 3, 0, 2, 1, 3), 13):
        rows.append({"id": f"MAT3-{i:02d}", "scenario": "合成材料纠错：原木耗尽但附近仍有可达树木",
                     "provenance": "synthetic; hand-authored varied-count material-recovery counterfactual",
                     "rationale": "木板不足且库存没有原木；附近有可达木材，先补充原木再合成。",
                     "state": mk_state(0, planks, failures=1 + i % 4, nearby_wood=True),
                     "action": {"action": "gather_wood", "count": 4 if i % 2 else 6}})

    # No materials or reachable wood: change plan rather than repeating craft.
    for i in range(21, 25):
        rows.append({"id": f"MAT3-{i:02d}", "scenario": "合成材料纠错：无原木且周围没有木材",
                     "provenance": "synthetic; hand-authored no-resource recovery counterfactual",
                     "rationale": "当前材料不足且没有附近木材，停止重复合成并换未探索方向寻找资源。",
                     "state": mk_state(0, i % 3, failures=2 + i % 3),
                     "action": {"action": "explore", "direction": ("north", "east", "south", "west")[i-21], "distance": 16}})

    # Positive controls prevent a blanket ban on crafting tables.
    for i, planks in enumerate((4, 5, 8, 12), 25):
        s = mk_state(0, planks)
        s["inventory"] = inventory(spruce_planks=planks, stick=4)
        s["craftable"] = [{"item": "crafting_table", "outputPerCraft": 1, "requiresTable": False}]
        s["recipeHints"] = []
        s["recentFailures"] = []
        rows.append({"id": f"MAT3-{i:02d}", "scenario": "材料充足且尚无工作台时制作工作台",
                     "provenance": "synthetic; hand-authored positive material-feasibility control",
                     "rationale": "有至少四块木板、没有工作台且没有重复失败，制作工作台是可行的下一步。",
                     "state": s, "action": {"action": "craft", "item": "crafting_table", "count": 1}})
    return rows


def compact_states(states):
    js = ROOT / "scripts/minecraft-training/compact_observations.js"
    result = subprocess.check_output(["node", str(js)], cwd=ROOT,
                                     input=json.dumps(states, ensure_ascii=False), text=True, encoding="utf-8")
    return json.loads(result)


def make_record(row, contract, state, *, user_payload=None):
    action = row["action"]
    payload = user_payload or row.get("userPayload") or {"goal": GOAL, "state": state, "recentResults": row.get("recentResults", [])}
    payload = {**payload, "state": state}
    return {"id": row["id"], "scenario": row["scenario"], "provenance": row["provenance"],
            "rationale": row.get("rationale", ""), "action": action, "state": state,
            "messages": [{"role": "system", "content": contract["system"]},
                         {"role": "user", "content": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))},
                         {"role": "assistant", "content": json.dumps(action, ensure_ascii=False, separators=(",", ":"))}]}


def main():
    contract_path = DATA / "contract-v3.json"
    if not contract_path.exists():
        subprocess.check_call(["python", str(ROOT / "scripts/minecraft-training/freeze_v3_contract.py")], cwd=ROOT)
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    original_train = DATA / "train-v2.jsonl"
    candidates_path = DATA / "emergency-recovery-v3-candidates.json"
    source_train = read_jsonl(original_train)
    candidates = json.loads(candidates_path.read_text(encoding="utf-8"))["trainingCandidates"]

    # Re-render the balanced v2 examples under the frozen current v3 contract.
    train_sources = []
    for row in source_train:
        payload = json.loads(row["messages"][1]["content"])
        train_sources.append({**row, "userPayload": payload})
    train_sources.extend(candidates)
    template = copy.deepcopy(source_train[0]["state"])
    materials = material_recovery_examples(template)
    train_sources.extend(materials)

    compact_train_states = compact_states([row["state"] for row in train_sources])
    train = [make_record(row, contract, state) for row, state in zip(train_sources, compact_train_states)]

    # Retain all frozen v2 development prompts unchanged for broad regression
    # comparison. The older live probe is already represented there, so only
    # add the new exact material-consumption probe.
    dev = read_jsonl(DATA / "development-v2.jsonl")
    new_probe_path = OUTPUT / "live-probe-1791833435547.json"
    probe = json.loads(new_probe_path.read_text(encoding="utf-8"))
    action = json.loads(probe["results"][0]["content"])
    messages = copy.deepcopy(probe["messages"])
    messages.append({"role": "assistant", "content": json.dumps(action, ensure_ascii=False, separators=(",", ":"))})
    dev.append({"id": "development-v3-real-probe-material-recovery",
                "scenario": "真实只读工作台材料失败快照；expected为同输入下基座决策",
                "provenance": f"real; read-only historical probe; expected action from base metadata; source={new_probe_path.relative_to(ROOT).as_posix()}",
                "rationale": "保留历史prompt与状态；基座选择craft planks，v2 adapter重复craft crafting_table。用于回归检测，不证明动作成功。",
                "action": action, "state": probe["state"], "messages": messages})

    # Seven independent executor-boundary examples are a separate dev slice.
    emergency_dev = json.loads(candidates_path.read_text(encoding="utf-8"))["suggestedDevelopmentCases"]
    compact_emergency_states = compact_states([row["state"] for row in emergency_dev])
    dev.extend(make_record(row, contract, state) for row, state in zip(emergency_dev, compact_emergency_states))

    # Strict schema check using the frozen v3 JSON Schema branches.
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

    train_path, dev_path = DATA / "train-v3.jsonl", DATA / "development-v3.jsonl"
    train_path.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in train), encoding="utf-8", newline="\n")
    dev_path.write_text("".join(json.dumps(r, ensure_ascii=False, separators=(",", ":")) + "\n" for r in dev), encoding="utf-8", newline="\n")
    manifest = {
        "experiment": "minecraft-survival-policy-v3-fresh-base",
        "contract": "data/minecraft-training/contract-v3.json",
        "contract_sha256": hashlib.sha256(contract_path.read_bytes()).hexdigest(),
        "train_examples": len(train), "development_examples": len(dev),
        "training_composition": {"reformatted_v2_training_only": len(source_train),
                                 "emergency_recovery_candidates_synthetic": len(candidates),
                                 "material_recovery_and_positive_controls_synthetic": len(materials)},
        "source_hashes": {"train-v2.jsonl": hashlib.sha256(original_train.read_bytes()).hexdigest(),
                          "emergency-recovery-v3-candidates.json": hashlib.sha256(candidates_path.read_bytes()).hexdigest()},
        "development_composition": {"frozen_v2_development_rows_unchanged": 26,
                                     "new_immutable_real_material_probe": 1,
                                     "independent_emergency_boundary_cases": len(emergency_dev)},
        "development_sources": ["data/minecraft-training/development-v2.jsonl",
                                "output/minecraft-training/live-probe-1791833435547.json",
                                "data/minecraft-training/emergency-recovery-v3-candidates.json:suggestedDevelopmentCases"],
        "development_expected_policy": "Frozen v2 rows remain unchanged; the older live probe is already represented there. The new live prompt uses the same-input historical base response as reference. Seven independent boundary cases are reported separately.",
        "initialization": "fresh base only; no v1/v2 adapter resume",
        "holdout_used": False,
        "limitations": "Synthetic training examples, a frozen 26-row development comparison, one additional fixed real read-only prompt, and seven independent synthetic executor boundary cases. Label agreement and two historical outputs do not guarantee Minecraft survival improvement. Do not use final holdout for selection.",
    }
    (DATA / "manifest-v3.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
