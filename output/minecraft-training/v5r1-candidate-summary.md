# v5r1 candidate data (not trained)

This is a review package for a future small continuation experiment. It does not authorize or start training. The 32 new synthetic rows are appended after the unchanged 182-row v4r1 replay to make a 214-row candidate replay. Twelve separate synthetic rows are development-only and do not overlap normalized prompts with train or the previous 182 rows.

Training categories are balanced as follows: 8 full-food/low-food contrasts, 8 tool-tier and prerequisite cases, 6 wood-depletion and recovery cases, 6 recipe-hint versus action-enum cases, and 4 stage-progress cases. Development rows use accepted action sets for legal counts and directions where one exact value is not unique.

The six-result histories are generated from no-inventory-change observations/exploration, with consistent failure context and state. Three full-food cases record `alreadyFull=true` with food remaining at 20, while three low-food cases record an increase from 5–8 to 13–16 after eating. This distinguishes a full-food no-op from useful low-food recovery. Root's separate raw-rabbit case is excluded: the model's low-food `eat` choice is reasonable, while the executor currently rejects raw rabbit because it is missing from `FOODS`; it should be attributed to executor support, not trained as a model error.

CPU semantic preflight passed for strict action schema, action/material and pickaxe-tier prerequisites, six-result/state consistency, `recentExploration`, recipe hints, block distances, registry durability, runtime prompt compaction, and duplicate prompts. The source `train-v4r1-replay-candidates.jsonl` remains the byte-identical first 182 rows of the replay candidate. Astra's independent semantic review is still pending.

Using the Qwen tokenizer and inference chat template, new train prompts are 1,586–2,112 tokens (31/32 within the 1,800–2,600 live target); development prompts are 1,871–2,097. The longest complete sequence is 2,129 tokens, and 2304 covers every new train/dev row without cutting assistant labels. This is a coverage measurement only; the final training length/configuration awaits independent review and GPU-memory preflight.

Hashes and row details are in [manifest-v5r1-candidates.json](../../data/minecraft-training/manifest-v5r1-candidates.json). The CPU reports are [semantic preflight](v5r1-candidate-semantic-preflight.json) and [token audit](v5r1-candidate-token-audit.json).
