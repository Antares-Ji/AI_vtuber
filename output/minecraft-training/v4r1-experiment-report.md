# Minecraft survival v4r1 experiment

## Training

- Base: `E:\Qwen3.5-4B`; initialized by resuming `minecraft-survival-v3r1-fresh-base/checkpoint-epoch-02`.
- Data: `data/minecraft-training/train-v4r1-replay-candidates.jsonl` (182 examples; frozen 166-row v3r1 prefix plus 16 reviewed v4r1 examples), SHA256 `9f76783df423a873e0d4387763a0b5dec10d8c1a8e3fc0517dd924be3cc032fe`.
- Configuration: rank 4, learning rate `1e-5`, one epoch, max length 1536, 46 optimizer steps.
- Mean training loss: `0.14976`; elapsed `336.3 s`; peak CUDA allocated/reserved `4.34/5.86 GiB`.
- Saved checkpoint: `runtime/minecraft-training/adapters/minecraft-survival-v4r1-replay-candidate/checkpoint-epoch-01`.
- Adapter weights: 21,270,808 bytes, SHA256 `48BBD148184987A3ABDCF2A3E193C61690D36B1F078CE70E18AC62F395D7E14B`. All 128 LoRA-B tensors are nonzero; total L2 difference from v3r1 epoch-02 weights is 2.6742.

## Development comparison

One base-model load served greedy direct-grid comparisons on the same frozen 27 development examples plus 8 independent v4r1 action-set examples. No final holdout data or labels were accessed.

| Slice / metric | Base | v3r1 epoch-02 | v4r1 epoch-01 |
|---|---:|---:|---:|
| Frozen 27: exact action | 7/27 | 11/27 | 12/27 |
| Frozen 27: action name | 12/27 | 17/27 | 20/27 |
| Frozen 27: schema valid | 26/27 | 27/27 | 27/27 |
| New 8: accepted action set | 2/8 | 3/8 | 4/8 |
| New 8: action name | 3/8 | 3/8 | 4/8 |
| New 8: schema valid | 8/8 | 8/8 | 8/8 |
| Combined 35: exact action | 8/35 | 12/35 | 13/35 |
| Combined 35: action name | 15/35 | 20/35 | 24/35 |
| Combined 35: schema valid | 34/35 | 35/35 | 35/35 |
| Visible-hostile priority | 2/2 | 2/2 | 2/2 |

Accepted-action-set scoring on the new development slice allows the reviewed count and direction ranges, so it does not penalize another feasible quantity or legal exploration direction. Mining, exploration, and staircase actions are attempts; these fixtures cannot establish terrain access or successful gameplay.

The third same-state timber-stage probe was evaluated separately as a diagnostic: base chose `gather_wood 12`; both v3r1 and v4r1 chose `craft planks 4`. This state had 26 sticks, one log, no minerals, and a crafting table 18 blocks away. Both replenishing wood and crafting the available planks may be reasonable; the probe is ambiguous and was not used as a binary error or checkpoint-selection criterion.

## Artifacts and limits

- Raw 35-case predictions and direct-grid reports: `output/minecraft-training/v4r1-comparison/`.
- Per-slice semantic summary: `output/minecraft-training/v4r1-comparison-summary.json`.
- Training configuration, run time, data hash, and peak memory: `runtime/minecraft-training/adapters/minecraft-survival-v4r1-replay-candidate/training-report.json`.
- Direct-grid predictions report adapter context locally; they do not verify HTTP endpoint metadata or deployment behavior. The adapter was not deployed. The 35 development examples support candidate comparison only; they do not prove generalization or successful autonomous play.
