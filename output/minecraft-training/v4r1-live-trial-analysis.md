# v4r1 live-window audit (development only)

The frozen window ran from `2026-10-12T20:49:48.913Z` through `20:52:56.072Z`. It contains 24 model requests, 24 completions, 24 decisions, and 23 `model_action_result` events. The session log supplies the final action's cancellation settlement: request `b7232c56-c2c3-42f9-81fc-6f254127e2fa`, task `3e8853f4-81a5-4894-8acd-7207a1035601`, `explore east 20` started at `20:52:51.492Z`, then failed with `This operation was aborted` at `20:52:56.067Z` and finished `cancelled` at `20:52:56.068Z`. Thus the autonomy log is missing one action-result event, while the action is resolved as canceled through the session log.

The two-source task counts are 18 completed, 5 failed, and 1 canceled. Decisions were 19 explore, 2 gather_wood, and 3 mine. The exact request/completion/decision/result trace is in `data/minecraft-training/v4r1-live-trial-20261012-dev-only-r1.jsonl`; the cancellation event pair is in `data/minecraft-training/v4r1-live-trial-20261012-window-settlement-r1.jsonl`.

## Input-integrity checks

All 24 recorded request states exactly match the runtime's compacted decision observation. All 24 `recentResults` histories match the preceding recorded action results, all system messages match the runtime survival prompt, all completion JSON matches the recorded action, and all response metadata identifies the v4r1 adapter. Each request contains only one system and one user message, not an accumulated chat transcript.

Tokenizing the actual requests with the Qwen processor gives 1,654–2,635 prompt tokens (mean 2,175), with no truncation configured. The sampled prompt size is far below the tokenizer's advertised 262,144-token limit. The first four explore actions therefore do not show evidence of request corruption or truncation. They began with an empty inventory and visible wood 17–30 blocks away; those logs were mostly 4–8 blocks above the player, so visibility alone does not establish a safe harvest path. All four exploration actions completed movement without inventory gain.

## Decision and execution evidence

- Step 5 chose `gather_wood 4` with visible logs 8–10 blocks away. The skill rejected high targets and exhausted path-search budget; it removed no blocks. Treat this as an executor reachability failure, not a demonstrated model error.
- Step 12 chose `gather_wood 4` with an empty wood list, empty inventory, and the previous gather failure in `recentFailures`. The skill returned “no exposed reachable resource; explore elsewhere.” This is the clearest model-selection error in the 24-decision window: the prompt and history were consistent, but the model ignored them.
- Steps 19, 21, and 22 chose `mine stone 4` with no pickaxe in inventory/tools. All three failed path preflight. Steps 21 and 22 repeated the same mine action at the same position against the same visible stones after a failure. Treat the absent pickaxe and repeated failure history as feasibility signals; the logged path-search error alone does not prove which guard stopped the action first.
- The final `explore east 20` was canceled during navigation. Its `skill_failed` event shows inventory changing from empty to one rabbit plus one rabbit hide while the action was being canceled. No hunt decision or hunt skill occurs in this window, so the item source is unknown and is not attributed to model hunting.

## Separate exact-state diagnostic

The independent probe `output/minecraft-training/live-probe-1791838384663.json` is outside the 24-decision trace and remains dev-only. It records full hunger (`food=20`), one rabbit and one rabbit hide, and visible wood 31 blocks away. Base chose `gather_wood 4`; v4r1 chose `eat`. The history-ablation replay also chose `eat`, so history cleanup alone does not remove this behavior. The executor reported `alreadyFull` and made no inventory change. This exact state is diagnostic evidence, not a training row.

## Candidate coverage for future review

Any future data proposal should use independent counterfactual states, not copy the exact live probes:

1. Full hunger with raw food present and no emergency: label actions that make useful progress, and explicitly reject `eat`; vary food item, inventory, and nearby resource layout.
2. No pickaxe with visible stone: prefer obtaining a tool/materials or safe exploration; include separate cases with and without reachable wood, and with a previous failed mining attempt.
3. No visible wood after a gather failure: prefer exploration, then make wood visible only in separate cases where gathering can be attempted. Do not turn high or unreachable logs into a universal gather gold.
4. `recipeHints` listing a species-specific ingredient such as `cherry_planks`: keep the action enum at the allowed generic item `planks`; vary wood species so the model learns the distinction between ingredient names and action names.

The later 20:55 follow-up also contains repeated schema-invalid `craft cherry_planks` completions; it belongs to a separate live segment and was not merged into this frozen 24-step trace. No training or endpoint calls were made for this audit, and no final holdout data was opened.

Detailed checks and token counts: `output/minecraft-training/v4r1-live-trial-r1-audit.json` and `output/minecraft-training/v4r1-live-trial-r1-token-audit.json`.

## Training context coverage (CPU-only audit; no holdout)

I tokenized the 166-row frozen v3r1 corpus and the 182-row v4r1 replay candidate using the same Qwen processor/chat-template path as `train_lora.py`. At its configured `--max-length 1536`, v4r1 rows span 1,020–1,331 total tokens (prompt 1,013–1,314; assistant labels 7–19 tokens). All 182 prompts and all assistant labels fit completely; no training labels are truncated. The frozen v3r1 corpus also fits all 166 rows (1,020–1,315 total tokens).

The 24 live prompts span 1,654–2,635 tokens. All 24 exceed the largest v4r1 training prompt by at least 340 tokens, and all exceed `max_length=1536`. This is a training-context coverage gap, not evidence of live inference truncation: the tokenizer advertises a 262,144-token limit and the request path had no client truncation configured. Current v4r1 training states are also much sparser: across 182 rows, resource lists contain a mean 0.3 entities (90th percentile 1; maximum 3); only 27 rows contain a `recipeHint` (maximum 1); only 7 user messages include any `recentResults` (maximum 3). `recentFailures` appear in 56 rows, up to 5.

For a future independently reviewed candidate, generate dense but plausible counterfactual states with several visible resource entities, both `craftable` and `recipeHints`, and six recent results containing a mix of successes and failures. Keep exact live probes dev-only. Tokenize with the same runtime prompt builder before training, target the observed live range, and set `max_length` above the longest complete prompt plus assistant target (likely at least 3,000 after measurement); reject any example where truncation removes prompt fields or assistant labels. The dev scorer should separate legal/action-feasible choices from guaranteed executor success and use action sets where direction or count is not uniquely determined.
