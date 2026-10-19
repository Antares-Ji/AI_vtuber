"""Fail fast on known state/action contradictions in a Minecraft train JSONL."""
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path

PREY = {"cow", "pig", "sheep", "chicken"}
EMERGENCY_PREY = {"cow", "pig", "sheep"}
SAFE_FOOD = {"cooked_beef", "cooked_porkchop", "cooked_mutton", "cooked_salmon", "cooked_chicken",
             "bread", "baked_potato", "cooked_rabbit", "cooked_cod", "apple", "carrot", "melon_slice",
             "sweet_berries", "beef", "porkchop", "mutton", "cod", "salmon"}
PICKAXE_RANK = {"wooden_pickaxe": 1, "stone_pickaxe": 2, "iron_pickaxe": 3,
                "diamond_pickaxe": 4, "netherite_pickaxe": 5}
MINE_RANK = {"stone": 1, "coal": 1, "iron": 2, "diamond": 3, "obsidian": 4}


def item_names(state):
    names = set()
    for entry in state.get("inventory", []) or []:
        if isinstance(entry, str):
            names.add(entry)
        elif isinstance(entry, dict) and entry.get("count", 1) > 0:
            names.add(entry.get("name", ""))
    for key in ("tools", "equipment"):
        for entry in state.get(key, []) or []:
            names.add(entry if isinstance(entry, str) else entry.get("name", ""))
    held = state.get("heldItem")
    if isinstance(held, str):
        names.add(held)
    elif isinstance(held, dict):
        names.add(held.get("name", ""))
    return {name for name in names if name}


def counts(state):
    result = {}
    for entry in state.get("inventory", []) or []:
        if isinstance(entry, dict):
            result[entry.get("name", "")] = result.get(entry.get("name", ""), 0) + entry.get("count", 0)
    return result


def issues(row):
    state, action = row.get("state") or {}, row.get("action") or {}
    action_name = action.get("action")
    problems = []
    names, inv = item_names(state), counts(state)
    pick_rank = max((rank for item, rank in PICKAXE_RANK.items() if item in names), default=0)

    if action_name == "mine":
        resource = action.get("resource")
        blocks = (state.get("resources") or {}).get(resource)
        if not isinstance(blocks, list) or not blocks:
            problems.append(f"mine:{resource} has no visible resource in state")
        elif not any(b.get("distance") is None or b.get("distance") <= 40 for b in blocks if isinstance(b, dict)):
            problems.append(f"mine:{resource} visible resources are all beyond 40 blocks")
        needed = MINE_RANK.get(resource)
        if needed and pick_rank < needed:
            problems.append(f"mine:{resource} needs pickaxe tier {needed}, state supplies tier {pick_rank}")
    elif action_name == "hunt":
        animals = state.get("animals")
        if not isinstance(animals, list):
            problems.append("hunt has no observed animals field; availability is unknown")
        else:
            emergency = (state.get("health") or 0) <= 6
            max_range = 16 if emergency else 32
            allowed = EMERGENCY_PREY if emergency else PREY
            visible = [a for a in animals if isinstance(a, dict) and a.get("name") in allowed
                       and isinstance(a.get("distance"), (int, float)) and a["distance"] <= max_range]
            if not visible:
                problems.append(f"hunt has no visible eligible prey within {max_range} blocks")
        threats = state.get("threats")
        if not isinstance(threats, list):
            problems.append("hunt has no observed threats field; safety is unknown")
        else:
            limit = 24 if (state.get("health") or 0) <= 6 else 10
            if any(isinstance(t, dict) and isinstance(t.get("distance"), (int, float)) and t["distance"] <= limit for t in threats):
                problems.append(f"hunt has a visible hostile within {limit} blocks")
    elif action_name == "eat":
        if not any(counts_.get(food, 0) > 0 for food in SAFE_FOOD for counts_ in [inv]):
            problems.append("eat has no safe edible item in inventory")
        if state.get("food", 0) >= 20:
            problems.append("eat is labeled when hunger is already full")
    elif action_name == "gather_wood":
        wood = (state.get("resources") or {}).get("wood")
        if not isinstance(wood, list) or not wood:
            problems.append("gather_wood has no visible wood source")
        elif not any(b.get("distance") is None or b.get("distance") <= 40 for b in wood if isinstance(b, dict)):
            problems.append("gather_wood sources are all beyond 40 blocks")
    elif action_name == "dig_staircase":
        if pick_rank < 1:
            problems.append("dig_staircase has no usable pickaxe in supplied inventory/tools")
        if state.get("health", 0) < 12 or state.get("food", 0) < 10:
            problems.append("dig_staircase violates health>=12 or food>=10")
        y = (state.get("position") or {}).get("y")
        steps = action.get("steps", 0)
        if isinstance(y, (int, float)) and y - steps < 50 and counts(state).get("torch", 0) < (steps + 3) // 4:
            problems.append("dig_staircase lacks required torches below y=50")
    elif action_name == "collect_water":
        if inv.get("bucket", 0) <= 0:
            problems.append("collect_water lacks an empty bucket")
        water = (state.get("fluids") or {}).get("water")
        if not isinstance(water, list) or not any(isinstance(x, dict) and (x.get("distance") is None or x.get("distance") <= 24) for x in water):
            problems.append("collect_water has no observed reachable water source")
    elif action_name == "place_water":
        if inv.get("water_bucket", 0) <= 0:
            problems.append("place_water lacks a water bucket")
        lava = (state.get("fluids") or {}).get("lava")
        if not isinstance(lava, list) or not any(isinstance(x, dict) and (x.get("distance") is None or x.get("distance") <= 16) for x in lava):
            problems.append("place_water has no observed cooling site within range")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.data.read_text(encoding="utf-8").splitlines() if line.strip()]
    findings = [(row.get("id", "?"), issue) for row in rows for issue in issues(row)]
    if findings:
        for row_id, issue in findings:
            print(f"ERROR {row_id}: {issue}")
        raise SystemExit(f"semantic preflight failed: {len(findings)} issue(s) across {len(rows)} rows")
    print(f"semantic preflight passed: {len(rows)} rows; mine/hunt/food/wood/staircase/water prerequisites checked")


if __name__ == "__main__":
    main()
