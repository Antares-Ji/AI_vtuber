"""Create a reproducible, synthetic-only state-to-skill SFT corpus."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "data" / "minecraft-training"
EXPORT = ROOT / "scripts" / "minecraft-training" / "export_contract.js"
FROZEN_CONTRACT = OUT / "contract-v1.json"
GOAL = "在生存模式自主生存并进入下界"


def contract():
    if FROZEN_CONTRACT.exists():
        return json.loads(FROZEN_CONTRACT.read_text(encoding="utf-8"))
    raw = subprocess.check_output(["node", str(EXPORT)], cwd=ROOT, text=True, encoding="utf-8")
    return json.loads(raw)


def state(*, inv=None, health=20, food=20, day=True, dimension="overworld", threats=None,
          hazards=None, resources=None, animals=None, stations=None, failures=None, visits=None,
          portal=None, x=0, z=0, time=None):
    keys = ["stone", "coal", "iron", "diamond", "obsidian", "gravel", "wood"]
    res = {key: [] for key in keys}
    res.update(resources or {})
    return {
        "connected": True, "mode": "survival", "dimension": dimension,
        "health": health, "food": food, "oxygen": 20,
        "position": {"x": x, "y": 64, "z": z},
        "timeOfDay": time if time is not None else (6000 if day else 18000), "isNight": not day,
        "inventory": [{"name": n, "count": c} for n, c in (inv or {}).items() if c],
        "heldItem": None, "equipment": [],
        "threats": threats or [], "hazards": hazards or [], "resources": res,
        "animals": animals or [], "stations": stations or [],
        "recentExploration": visits or [], "recentFailures": failures or [], "portalSite": portal,
    }


def block(name, x=8, y=64, z=0):
    return {"name": name, "position": {"x": x, "y": y, "z": z}, "distance": round((x*x + z*z) ** .5)}


def add(rows, scenario, action, **kw):
    rows.append({"scenario": scenario, "action": action, "state": state(**kw), "provenance": "synthetic"})


def records():
    train = []
    add(train, "fresh spawn with nearby wood", {"action": "gather_wood", "count": 8}, resources={"wood": [block("oak_log"), block("birch_log", 12, 64, 2)]})
    add(train, "empty inventory and spruce nearby", {"action": "gather_wood", "count": 6}, resources={"wood": [block("spruce_log")]}, x=20, z=-4)
    add(train, "safe daylight start", {"action": "gather_wood", "count": 10}, resources={"wood": [block("oak_log")]}, food=16, time=9000)
    add(train, "logs but no planks", {"action": "craft", "item": "planks", "count": 8}, inv={"oak_log": 3})
    add(train, "planks ready for table", {"action": "craft", "item": "crafting_table", "count": 1}, inv={"oak_planks": 8})
    add(train, "table made and wood available", {"action": "craft", "item": "stick", "count": 8}, inv={"crafting_table": 1, "oak_planks": 8}, stations=[{"name": "crafting_table", "position": {"x": 1, "y": 64, "z": 1}}])
    add(train, "craft first wooden pick", {"action": "craft", "item": "wooden_pickaxe", "count": 1}, inv={"crafting_table": 1, "oak_planks": 8, "stick": 4})
    add(train, "stone exposed with wooden pickaxe", {"action": "mine", "resource": "stone", "count": 8}, inv={"wooden_pickaxe": 1, "stick": 2}, resources={"stone": [block("stone"), block("cobblestone", 9, 64, 1)]})
    add(train, "cobble can upgrade pickaxe", {"action": "craft", "item": "stone_pickaxe", "count": 1}, inv={"crafting_table": 1, "cobblestone": 8, "stick": 4})
    add(train, "cobble and sticks can make furnace", {"action": "craft", "item": "furnace", "count": 1}, inv={"crafting_table": 1, "cobblestone": 9, "stick": 4})
    add(train, "coal exposed with stone pick", {"action": "mine", "resource": "coal", "count": 8}, inv={"stone_pickaxe": 1, "furnace": 1}, resources={"coal": [block("coal_ore")]})
    add(train, "iron exposed with stone pick", {"action": "mine", "resource": "iron", "count": 6}, inv={"stone_pickaxe": 1, "torch": 4}, resources={"iron": [block("iron_ore")]})
    add(train, "smelt collected raw iron", {"action": "smelt", "item": "raw_iron", "count": 3}, inv={"raw_iron": 5, "coal": 4, "furnace": 1})
    add(train, "make iron pick after ingots", {"action": "craft", "item": "iron_pickaxe", "count": 1}, inv={"iron_ingot": 4, "stick": 4, "crafting_table": 1})
    add(train, "diamond visible and mining tier sufficient", {"action": "mine", "resource": "diamond", "count": 3}, inv={"iron_pickaxe": 1, "torch": 8}, resources={"diamond": [block("diamond_ore", 4, 12, 3)]}, x=1)
    add(train, "diamonds collected", {"action": "craft", "item": "diamond_pickaxe", "count": 1}, inv={"diamond": 3, "stick": 4, "crafting_table": 1})
    add(train, "obsidian and diamond pickaxe", {"action": "mine", "resource": "obsidian", "count": 10}, inv={"diamond_pickaxe": 1, "iron_pickaxe": 1}, resources={"obsidian": [block("obsidian", 5, 60, 0)]})
    add(train, "gravel for flint with iron available", {"action": "mine", "resource": "gravel", "count": 8}, inv={"iron_ingot": 2, "stone_pickaxe": 1}, resources={"gravel": [block("gravel")]})
    add(train, "flint and iron for igniter", {"action": "craft", "item": "flint_and_steel", "count": 1}, inv={"iron_ingot": 1, "flint": 1, "crafting_table": 1})
    add(train, "all portal supplies and clear site assumed", {"action": "build_portal"}, inv={"obsidian": 10, "cobblestone": 4, "flint_and_steel": 1})
    add(train, "active portal is nearby", {"action": "enter_portal"}, inv={"iron_pickaxe": 1}, stations=[{"name": "nether_portal", "position": {"x": 2, "y": 64, "z": 0}}])
    add(train, "low food and safe cooked food", {"action": "eat"}, inv={"cooked_beef": 4, "iron_pickaxe": 1}, food=7, health=15)
    add(train, "danger takes priority over mining", {"action": "flee"}, inv={"stone_pickaxe": 1}, health=16, threats=[{"id": 23, "name": "zombie", "distance": 5, "position": {"x": 4, "y": 64, "z": 3}}], resources={"iron": [block("iron_ore")]})
    add(train, "creeper nearby low health", {"action": "flee"}, inv={"cooked_beef": 2}, health=8, food=14, threats=[{"id": 31, "name": "creeper", "distance": 7, "position": {"x": 5, "y": 64, "z": 5}}])
    add(train, "daytime no food and prey visible", {"action": "hunt", "count": 1}, inv={"stone_sword": 1}, food=9, animals=[{"id": 19, "name": "cow", "distance": 7}])
    add(train, "resources depleted go explore", {"action": "explore", "direction": "northeast", "distance": 24}, inv={"wooden_pickaxe": 1}, resources={"wood": [], "stone": []}, visits=[{"direction": "west", "distance": 20}])
    add(train, "failed coal search avoid repeated mining", {"action": "explore", "direction": "south", "distance": 16}, inv={"stone_pickaxe": 1}, failures=[{"action": {"action": "mine", "resource": "coal", "count": 8}, "error": "No safe exposed coal found"}], visits=[{"direction": "north", "distance": 16}])
    add(train, "night without enemies but low food", {"action": "flee"}, inv={"stone_pickaxe": 1}, food=4, day=False, health=11)
    add(train, "needs fresh state after unclear transition", {"action": "observe"}, inv={"iron_pickaxe": 1}, failures=[{"action": {"action": "enter_portal"}, "error": "dimension transition not observed"}], dimension="overworld")
    add(train, "take food before long trip", {"action": "eat"}, inv={"bread": 3, "diamond": 2}, food=8, health=18, resources={"diamond": [block("diamond_ore")]})
    add(train, "first iron ore search has no visible seam", {"action": "explore", "direction": "east", "distance": 32}, inv={"stone_pickaxe": 1}, resources={"iron": []}, visits=[{"direction": "northwest", "distance": 24}])
    add(train, "low oxygen underwater retreat", {"action": "flee"}, health=13, food=16, hazards=[{"name": "water", "position": {"x": 1, "y": 62, "z": 1}}])
    add(train, "hostile priority over low hunger", {"action": "flee"}, inv={"bread": 2}, health=17, food=7, threats=[{"id": 44, "name": "skeleton", "distance": 8, "position": {"x": -5, "y": 64, "z": 6}}])
    add(train, "build portal only when all ingredients present", {"action": "mine", "resource": "obsidian", "count": 10}, inv={"diamond_pickaxe": 1, "obsidian": 3, "cobblestone": 4, "flint_and_steel": 1}, resources={"obsidian": [block("obsidian", 6, 63, -2)]})
    add(train, "smelt fuel limited output", {"action": "smelt", "item": "raw_iron", "count": 2}, inv={"raw_iron": 4, "coal": 2, "furnace": 1})
    add(train, "no animal in night choose safety", {"action": "flee"}, food=6, day=False, health=16)
    add(train, "wood depleted after first direction", {"action": "explore", "direction": "southwest", "distance": 40}, inv={"oak_planks": 2}, resources={"wood": []}, visits=[{"direction": "north", "distance": 40}, {"direction": "east", "distance": 24}])
    add(train, "stone needed but no pickaxe", {"action": "craft", "item": "wooden_pickaxe", "count": 1}, inv={"oak_planks": 5, "stick": 3, "crafting_table": 1}, resources={"stone": [block("stone")]})
    add(train, "food deficit with visible daytime prey", {"action": "hunt", "count": 2}, inv={"iron_sword": 1}, food=5, health=14, animals=[{"id": 52, "name": "pig", "distance": 9}, {"id": 53, "name": "sheep", "distance": 12}])

    holdout = []
    add(holdout, "unseen new spawn biome", {"action": "gather_wood", "count": 7}, resources={"wood": [block("acacia_log", 3, 65, 4)]}, x=100, z=-80, time=7000)
    add(holdout, "extra logs accumulated", {"action": "craft", "item": "planks", "count": 12}, inv={"birch_log": 4})
    add(holdout, "table recipe from alternate wood", {"action": "craft", "item": "crafting_table", "count": 1}, inv={"spruce_planks": 7})
    add(holdout, "stone tool upgrade at high altitude", {"action": "mine", "resource": "stone", "count": 12}, inv={"wooden_pickaxe": 1}, resources={"stone": [block("stone", 10, 91, 10)]}, x=3, z=3)
    add(holdout, "iron with depleted wooden tool", {"action": "craft", "item": "stone_pickaxe", "count": 1}, inv={"cobblestone": 5, "stick": 4, "crafting_table": 1}, resources={"iron": [block("iron_ore")]})
    add(holdout, "raw iron and charcoal ready", {"action": "smelt", "item": "raw_iron", "count": 3}, inv={"raw_iron": 3, "charcoal": 2, "furnace": 1})
    add(holdout, "diamond vein but only stone tool", {"action": "mine", "resource": "iron", "count": 5}, inv={"stone_pickaxe": 1}, resources={"iron": [block("iron_ore")], "diamond": [block("diamond_ore", 6, 12, 1)]})
    add(holdout, "hungry with baked potatoes", {"action": "eat"}, inv={"baked_potato": 2}, food=6, health=17)
    add(holdout, "hostile spider in reach", {"action": "flee"}, inv={"iron_sword": 1}, health=12, threats=[{"id": 91, "name": "spider", "distance": 6, "position": {"x": 4, "y": 65, "z": -4}}])
    add(holdout, "no visible gravel after failed search", {"action": "explore", "direction": "northwest", "distance": 32}, inv={"iron_ingot": 1, "iron_pickaxe": 1}, resources={"gravel": []}, failures=[{"action": {"action": "mine", "resource": "gravel", "count": 8}, "error": "No safe exposed gravel found"}], visits=[{"direction": "southeast", "distance": 24}])
    add(holdout, "distinct direction after iron search fails", {"action": "explore", "direction": "west", "distance": 40}, inv={"stone_pickaxe": 1}, resources={"iron": []}, failures=[{"action": {"action": "mine", "resource": "iron", "count": 6}, "error": "No safe exposed iron found"}], visits=[{"direction": "east", "distance": 40}])
    add(holdout, "night and scarce health", {"action": "flee"}, inv={"apple": 2}, food=8, health=5, day=False)
    add(holdout, "early flint collection", {"action": "mine", "resource": "gravel", "count": 5}, inv={"stone_pickaxe": 1, "iron_ingot": 1}, resources={"gravel": [block("gravel", -8, 64, 1)]}, x=-2)
    add(holdout, "portal supplies but no flint", {"action": "mine", "resource": "gravel", "count": 8}, inv={"obsidian": 10, "cobblestone": 4, "iron_ingot": 1, "diamond_pickaxe": 1}, resources={"gravel": [block("gravel")]})
    add(holdout, "all portal components but location not yet checked", {"action": "build_portal"}, inv={"obsidian": 12, "cobblestone": 4, "flint_and_steel": 1})
    add(holdout, "portal active amid nearby resource clutter", {"action": "enter_portal"}, inv={"diamond": 1, "bread": 2}, stations=[{"name": "nether_portal", "position": {"x": 7, "y": 64, "z": 1}}], resources={"diamond": [block("diamond_ore")]})
    add(holdout, "recently entered nether observe state", {"action": "observe"}, dimension="the_nether", inv={"iron_pickaxe": 1, "cooked_beef": 2})
    add(holdout, "daylight no food and multiple prey", {"action": "hunt", "count": 2}, food=4, animals=[{"id": 72, "name": "cow", "distance": 6}, {"id": 73, "name": "pig", "distance": 9}])
    add(holdout, "smelting output demand with small stock", {"action": "smelt", "item": "raw_iron", "count": 1}, inv={"raw_iron": 2, "coal": 1, "furnace": 1})
    add(holdout, "many enemies despite food available", {"action": "flee"}, inv={"bread": 3, "stone_sword": 1}, food=5, health=15, threats=[{"id": 102, "name": "zombie", "distance": 3, "position": {"x": 2, "y": 64, "z": 1}}, {"id": 103, "name": "creeper", "distance": 8, "position": {"x": -7, "y": 64, "z": 3}}])
    return train, holdout


def valid_action(action, schema):
    branches = schema["oneOf"]
    branch = next((b for b in branches if b["properties"]["action"].get("const") == action.get("action")), None)
    if branch is None or set(action) != set(branch["properties"]):
        raise ValueError(f"Invalid action fields: {action}")
    for name, rule in branch["properties"].items():
        if "enum" in rule and action[name] not in rule["enum"]:
            raise ValueError(f"Invalid {name}={action[name]}")
        if rule.get("type") == "integer" and (type(action[name]) is not int or not rule["minimum"] <= action[name] <= rule["maximum"]):
            raise ValueError(f"Invalid integer range for {name}: {action[name]}")


def main():
    c = contract()
    train, holdout = records()
    for name, rows in (("train", train), ("holdout", holdout)):
        target = OUT / f"{name}.jsonl"
        with target.open("w", encoding="utf-8", newline="\n") as f:
            for i, row in enumerate(rows, 1):
                valid_action(row["action"], c["schema"])
                user = {"goal": GOAL, "state": row["state"], "recentResults": []}
                record = {
                    "id": f"{name}-{i:03d}", "scenario": row["scenario"],
                    "provenance": "synthetic; hand-authored planning label",
                    "messages": [
                        {"role": "system", "content": c["system"]},
                        {"role": "user", "content": json.dumps(user, ensure_ascii=False, separators=(",", ":"))},
                        {"role": "assistant", "content": json.dumps(row["action"], ensure_ascii=False, separators=(",", ":"))},
                    ], "action": row["action"], "state": row["state"]
                }
                f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        print(f"{target.relative_to(ROOT)}: {len(rows)} examples")

    manifest = {
        "name": "minecraft-survival-policy-lora-v1",
        "scope": "Synthetic next-atomic-skill selection for survival progression toward the Nether; this does not train Mineflayer execution or guarantee world-level success.",
        "label_schema_source": "src/minecraft/survival-skills.js SURVIVAL_ACTION_SCHEMA; system prompt from src/minecraft/survival-planner.js SURVIVAL_SYSTEM",
        "contract_snapshot": "data/minecraft-training/contract-v1.json",
        "all_examples_synthetic": True,
        "train_examples": len(train), "holdout_examples": len(holdout),
        "holdout_policy": "Holdout scenarios are separately authored and must not be used for training or tuning.",
        "real_logs_preserved": [
            {"file": "logs/minecraft-session-1791826100048.jsonl", "fact": "One dropped-log collection timed out after wood harvesting."},
            {"file": "logs/minecraft-session-1791826189595.jsonl", "fact": "A later crafting-table task was verified; that session also records repeated hostile deaths."},
            {"file": "logs/minecraft-session-1791827441784.jsonl", "fact": "Defense was enabled, followed by runtime errors and a Spider death."}
        ],
        "logs_are_not_training_labels": True,
        "no_personality_memory_written": True,
        "base_model": r"E:\Qwen3.5-4B",
        "adapter_path": "runtime/minecraft-training/adapters/minecraft-survival-v1"
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{OUT.relative_to(ROOT) / 'manifest.json'}")


if __name__ == "__main__":
    main()
