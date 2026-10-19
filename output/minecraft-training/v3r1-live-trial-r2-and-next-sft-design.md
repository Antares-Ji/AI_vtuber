# v3r1 live trial r2 and next small SFT design

## Complete live window

`data/minecraft-training/live-trial-v3r1-20261012-candidates-r2.json` is the separate full-window extraction. It contains all 35 model decisions and their terminal outcomes from 20:09:22.698Z through 20:15:47.789Z, with 24 `completed` and 11 `failed` results. It supersedes the scope of the initial 19-row extraction for analysis, but does not overwrite it. Every row remains a development candidate with `trainingEligible: false`.

The loop started with empty history and ended at step 35 with a failed `craft stick 8`; the executor reported a partial four-stick gain and a server inventory verification failure. The records retain those contradictory terminal and partial-evidence fields separately. Earlier in the sequence, the model recovered from a missing-ingredient table attempt by gathering logs, crafted a crafting table and wooden pickaxe, then spent much of the remaining window on repeated plank/stick crafts and further failed batch requests. The actual item counts and errors are included per step, so review should distinguish model choice, executor success/failure, and inventory confirmation.

The same-state probe `live-probe-1791836151666.json` is embedded separately in r2 as an immutable development-only comparison. Base returned `gather_wood 12`; epoch-02 returned `craft planks 4`. Both remained in the wood stage. This is one input with two outputs, not evidence that the base or adapter has a general capability advantage. The logged state has a wooden pickaxe and nearby wood, but no visible mineral targets. Treat this as a prompt for a broader, controlled development set, not a training label.

Each loop prompt is reconstructed from the logged decision observation and prior result history with `decisionMessages`. The request bodies were not persisted, so this is not a byte-for-byte prompt archive. The separate probe retains its actual logged messages. No frozen v1/v2/v3r1 dataset was edited, and the final 20-row holdout was not read.

## Existing v3r1 training balance

I counted only the 166 records in frozen `train-v3r1.jsonl`. The most common labels are `explore` 35, `eat` 16, `flee` 16, `gather_wood` 13, and `craft planks` 13. Directly pre-pick wood-stage labels (`gather_wood`, `craft planks`, `craft stick`, `craft crafting_table`, `craft wooden_pickaxe`) total 43/166 (25.9%); this is not a count-only case where wood actions dominate the whole corpus.

The stage coverage after a wooden pickaxe exists is sparse: only 9/166 rows contain one. Their labels are `mine stone` 4, `explore` 2, `craft stone_pickaxe` 2, and `craft stick` 1; none labels gather wood, planks, or crafting-table production at that stage. Only 3/9 have any planks, 0/9 have logs, and 5/9 have a crafting table in inventory or listed as a station. Thus the evidence points to a post-pickaxe state-coverage gap, especially states with both surplus wood and a usable tool, rather than excessive wood/planks label counts overall. The exact A/B state is also outside that sparse inventory profile: it has a wooden pickaxe, one log, 26 sticks, nearby wood, and no observed minerals. The 35 live rows add real evidence but remain development-only.

For additional context, any-tier pickaxe states number 52, but include 29 stone-pickaxe, 11 iron-pickaxe, and 3 diamond-pickaxe states, plus the 9 wooden-pickaxe states; do not use that aggregate to imply balanced early-to-mid-game transitions.

## Proposed next small training candidate set

This is a proposal only; no rows are added to a training file by this document. Avoid simply adding more `gather_wood` or `craft planks` rows. If approved, create a versioned set of 16 independent synthetic counterfactuals that fills the post-pickaxe coverage gap and preserves legitimate material-recovery actions:

| Slice | Approx. rows | Candidate lesson |
|---|---:|---|
| Visible, harvestable resources | 5 | With a wooden pickaxe and visible reachable stone/coal, choose `mine`; include iron only with stone-or-better, diamond only with iron-or-better. Vary counts, position, and durability. |
| Resource absent, materials sufficient | 4 | With pickaxe/table and surplus logs/planks/sticks, but no visible minerals, stop crafting consumables and choose `explore`. Several directions can be reasonable; rotate labels, mark direction non-unique, and score the action family/feasible-direction set. |
| Legitimate material replenishment | 3 | Preserve exceptions: when logs/planks/sticks are genuinely insufficient for the next supported recipe and reachable wood is observed, gather wood; when logs exist but planks are needed, craft a feasible batch. Vary exact quantities and required next recipe so replenishment remains useful rather than automatic. |
| Staircase-positive attempts | 2 | Use a pickaxe, health >=12, food >=10, a cardinal direction, and 1–8 steps. If `position.y - steps < 50`, require `ceil(steps/4)` torches. These are permitted attempts only; local terrain must still pass executor checks. |
| Staircase/resource guards | 2 | Cover missing torches below y=50 or a failed health/food/tool/resource-tier gate. Label an alternative only if supported by the state; otherwise mark uncertain cases out of training. |

Do not copy the exact state or either exact A/B response into training. Keep the 35-row live trajectory and same-state comparison in development. If a development reference needs an expected action for the A/B state, label it as a policy review target with multiple acceptable choices (likely a safe exploration decision given no visible minerals); do not automatically canonize either output. Keep the original independent holdout sealed.

Score new samples on two axes: **execution feasibility** (schema, available materials, tool tier, visible target and safety preconditions) and **useful progress** toward acquiring the next supported resource/tool or making safe exploration progress. A completed `craft planks` may be feasible but redundant; a partial `gather_wood` may be useful despite incomplete count; a failed action can reflect pathing or server-window verification rather than a bad model choice. Keep those outcomes separate. Frontend is independently checking crafting inventory conservation, so the final stick/plank partial-verification anomaly remains unresolved here.

## Feasible semantic audit before any training

1. Validate every action with the current `SURVIVAL_ACTION_SCHEMA`, and verify the serialized assistant action equals the structured `action` field. Rebuild `messages` from each exact stored state and history; mark all synthetic provenance explicitly.
2. For mining, recompute each listed target distance from its position and player position, require it to fall within the observation and skill limits, and require the appropriate held/inventory tool tier for the requested resource. Because state records do not prove exposure, path reachability, or loaded-world safety, classify these as feasible attempts rather than guaranteed harvests.
3. For staircase positives, validate cardinal direction and 1–8 steps, a pickaxe, health/food gates, and the underground torch formula. Check any listed hazards, fluids, and falling-block evidence. Since the schema does not expose all blocks surrounding each step, never claim static fixture data proves terrain safety; keep actual terrain as an executor-time precondition.
4. For anti-repeat/material cases, recompute recipe affordability from the inventory and observed stations, verify existing tools/stations are not duplicated, and inspect recent failures/history for repeated impossible crafts. Avoid rows whose item stacks or recipe names conflict with the Minecraft registry.
5. Normalize model-input messages and reject train/dev overlap and duplicate prompts. Keep synthetic training counterfactuals separate from exact real development records; report schema, material/tool precondition, geometry, and ambiguity checks separately.

Only after review of this proposal and an independently audited candidate file should a fresh-base, short-run experiment be considered. This task did not start or authorize GPU work.
