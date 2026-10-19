# Minecraft survival v2 development comparison

Checkpoint selection used the 26-row compact development set only. The v1 final holdout was not used. Primary metric is exact action-object agreement; ties use progression exact agreement, then the earlier checkpoint.

| Model | Exact object | Action name | Schema valid | Threat priority | Progression exact |
|---|---:|---:|---:|---:|---:|
| base | 23.1% | 42.3% | 96.2% | 100.0% | 15.0% |
| v1 | 38.5% | 57.7% | 100.0% | 100.0% | 20.0% |
| epoch-01 | 42.3% | 73.1% | 100.0% | 100.0% | 25.0% |
| epoch-02 | 38.5% | 80.8% | 100.0% | 100.0% | 25.0% |
| epoch-03 | 42.3% | 76.9% | 100.0% | 100.0% | 30.0% |
| epoch-04 | 42.3% | 76.9% | 100.0% | 100.0% | 30.0% |

Selected: `checkpoint-epoch-03` (11/26 exact, 6/20 progression). Epochs 01, 03 and 04 tie on exact-object accuracy; epoch 03 wins the progression tie-break over epoch 01 and precedes epoch 04. Epoch 02 has the highest action-name agreement (21/26), but lower exact-object and progression scores.

The probe-derived case is development-only and must not be confused with independent gameplay validation. A model action with a different count may be feasible; exact agreement is a narrow label metric. No result here guarantees real-world Minecraft improvement.
