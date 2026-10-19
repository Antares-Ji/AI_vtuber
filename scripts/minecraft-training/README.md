# Minecraft survival policy LoRA experiments

These are narrow next-skill selection experiments over structured Minecraft
survival observations. They do not teach Mineflayer execution or guarantee
survival or Nether entry. Label agreement is not gameplay success.

## Frozen v1

The v1 files are historical artifacts. **Do not rerun `build_dataset.py`**:
it rebuilds the v1 `train.jsonl`, `holdout.jsonl`, and manifest. V1's train and
holdout byte hashes are recorded in `manifest-v2.json`; v2 must not alter them.
The frozen v1 schema/prompt is `data/minecraft-training/contract-v1.json`.

## v2 corpus and contract

`freeze_v2_contract.py` snapshots the current 14-action contract into
`contract-v2.json`. `build_v2_dataset.py` creates a separate 124-row
`train-v2.jsonl` and 26-row `development-v2.jsonl`. It combines migrated v1
training examples, the 51 independently authored recovery scenarios, tool-tier
and safe-mining cases, material-consumption recovery, and rich-state examples.
The exact read-only real probe is retained in development only; its training
analogs are independent. States are compacted through Astra's runtime
`compactObservation`, and block distances are recomputed from player position.

Run CPU-only template and tokenization checks before training:

```powershell
runtime/minecraft-training/.venv/Scripts/python.exe scripts/minecraft-training/preflight.py --data data/minecraft-training/train-v2.jsonl --contract data/minecraft-training/contract-v2.json
runtime/minecraft-training/.venv/Scripts/python.exe scripts/minecraft-training/preflight.py --data data/minecraft-training/development-v2.jsonl --contract data/minecraft-training/contract-v2.json
```

## Training and checkpoint selection

The isolated environment reuses the existing Torch/Transformers/bitsandbytes
runtime and has PEFT installed locally. Training requires explicit GPU
authorization, checks free VRAM, and writes a separate PEFT adapter. The base
checkpoint remains unchanged. You can start from the base model by omitting
`--resume-adapter`, or explicitly continue a saved adapter as in the v2 run:

```powershell
runtime/minecraft-training/.venv/Scripts/python.exe scripts/minecraft-training/train_lora.py --allow-gpu-training --min-free-gib 6.0 --data data/minecraft-training/train-v2.jsonl --output runtime/minecraft-training/adapters/minecraft-survival-v2 --resume-adapter runtime/minecraft-training/adapters/minecraft-survival-v1 --epochs 4 --max-length 1536 --experiment minecraft-survival-v2-continued-from-v1 --log-every-steps 4
```

The trainer flushes loss/peak-memory progress every four optimizer steps and
saves a separate checkpoint after each epoch. Select checkpoints using only
`development-v2.jsonl`; do not select by training loss alone. `evaluate.py`
accepts `--data` and `--contract` for development runs. For comparing multiple
PEFT checkpoints without reloading the base model each time, use
`compare_dev_grid.py` with repeated `--adapter name=path` arguments. Preserve
all per-checkpoint predictions and reports.

Keep the independent `holdout.jsonl` out of training and checkpoint tuning.
Reserve its one frozen use for the final independent audit, which should be
reported separately from the development comparison. Do not treat the small
synthetic corpus as evidence of robust behavior in Minecraft.

### Completed v2 run and selection

The completed run continued from the v1 adapter for four epochs (124 optimizer
updates, about 949 seconds); the frozen base model was not changed. Selection
used all 26 rows in `development-v2.jsonl`, never the original holdout. The
same compact prompts were evaluated against the base, v1, and each v2 epoch.
The selected adapter is
`runtime/minecraft-training/adapters/minecraft-survival-v2/checkpoint-epoch-03`.

The selection rule was exact action-object agreement first, progression-case
agreement as a tie-break, then the earlier epoch. Epochs 01, 03, and 04 tied
at 11/26 exact objects (42.3%); epoch 03 tied epoch 04 on progression cases
(6/20 versus epoch 01's 5/20) and was earlier. Epoch 02 had the highest
action-name agreement (21/26, 80.8%) but lower exact-object and progression
scores. Across base, v1, and v2 epoch 03, exact-object scores were 6/26
(23.1%), 10/26 (38.5%), and 11/26 (42.3%); schema-valid output was 25/26,
26/26, and 26/26. All scored 2/2 on the two threat-priority cases. These are
small authored-label agreement metrics, not Minecraft success rates or proof
of generalization. In particular, a different count can still be feasible,
and the 26-row development set is too small to establish a reliable gain.

Full per-checkpoint raw predictions and reports are in
`output/minecraft-training/v2-dev-epoch-01.jsonl` through
`v2-dev-epoch-04.jsonl` and matching `.report.json` files. The comparison and
selection rationale are summarized in `output/minecraft-training/v2-dev-comparison.md`
and `.json`. The final frozen holdout remains unused and must be reserved for
the independent audit.

### Revised v3r1 fresh-base candidate

The first v3 data build is frozen in `train-v3.jsonl` and `development-v3.jsonl`
for traceability, but must not be trained: its source audit found invalid labels.
The replacement `train-v3r1.jsonl` contains 166 rows: 117 audited v2-derived
rows after seven source exclusions, 24 emergency-recovery candidates with four
numeric geometry repairs, and 25 material-recovery/control examples after
removing three duplicate or non-unique prompts. `manifest-v3r1.json` lists
source hashes, excluded IDs and reasons, and corrections. The original source
files remain unchanged.

The 27-row policy development set retains the frozen 26 v2 prompts unchanged
and adds the newer immutable material-consumption probe; the older real probe
already occurs in the frozen set. Seven executor-boundary cases are stored
separately in `executor-diagnostics-v3r1.jsonl`, outside policy score selection.
Only the eat boundary is a supplemental policy reference. The GPU attempt
against the rejected v3 dataset was interrupted before the first checkpoint;
no adapter weights were saved. Its log and status are preserved in
`output/minecraft-training/v3-fresh-attempt-01.aborted.json` and `.log`.

The completed run started from the pristine base (no resume adapter), rank 4,
learning rate `2e-5`, two epochs, and max length 1536. It trained 166 examples
for 84 optimizer steps in 635.6 seconds, with mean loss 0.2601 at epoch 1 and
0.1569 at epoch 2; peak CUDA allocated/reserved memory was 4.34/7.26 GiB.
The frozen training file SHA-256 is
`a6962d31f9e865ef846c72672811ff7b9ba48677dc2905c759275762c940f823`.
Both epoch adapters are saved under
`runtime/minecraft-training/adapters/minecraft-survival-v3r1-fresh-base/`.

Base and both checkpoints were compared on the same 27 development prompts in
one loaded-base process. Epoch 2 was selected: on the frozen broad 26-row slice
it scored 10/26 exact objects, 16/26 action names, 26/26 schema-valid outputs,
4/20 progression cases, and 2/2 threat-priority cases. The base scored 6/26,
11/26, 25/26, 3/20, and 2/2 respectively. Epoch 1 scored 8/26, 17/26, 26/26,
3/20, and 2/2. On the two fixed real regression probes, epoch 2 produced
`gather_wood 4` for the empty-inventory/no-prey/nearby-wood state (count-tolerant
semantic repair) and `craft planks 4` for the failed-table-crafting state
(exact repair). Both probes passed action-class and schema checks. Selection
therefore favors epoch 2 over epoch 1 because it repairs both real probes and
has stronger broad exact-object and progression agreement; it is still a small
development comparison, not proof of gameplay improvement.

The raw outputs and reports are `output/minecraft-training/v3r1-dev-base.jsonl`,
`v3r1-dev-epoch-01.jsonl`, `v3r1-dev-epoch-02.jsonl` and their matching report
files. The comparison is summarized in
`output/minecraft-training/v3r1-dev-comparison.md` and `.json`. The grid ran
directly in a process with the adapters loaded; it did not verify HTTP endpoint
metadata or gameplay. The final frozen holdout was not read. Any later live
result must also account for concurrent executor changes, including navigation
and crafting fixes, and should not attribute those effects to LoRA training.

```powershell
runtime/minecraft-training/.venv/Scripts/python.exe scripts/minecraft-training/train_lora.py --allow-gpu-training --min-free-gib 6.0 --data data/minecraft-training/train-v3r1.jsonl --output runtime/minecraft-training/adapters/minecraft-survival-v3r1-fresh-base --epochs 2 --max-length 1536 --rank 4 --learning-rate 2e-5 --experiment minecraft-survival-v3r1-fresh-base --log-every-steps 4
```
