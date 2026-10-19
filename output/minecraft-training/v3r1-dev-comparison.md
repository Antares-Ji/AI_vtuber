# v3r1 fresh-base development comparison

The final frozen holdout was not read. The 26 frozen v2 development prompts and two real probes are reported separately. The seven executor diagnostics are excluded from policy scoring.

| Model | Broad exact | Broad action name | Broad schema valid | Progression exact | Threat priority | Probe repairs | Base object agreement |
|---|---:|---:|---:|---:|---:|---:|---:|
| base | 6/26 (23.1%) | 11/26 (42.3%) | 25/26 (96.2%) | 3/20 (15.0%) | 2/2 (100.0%) | 2/2 | 26/26 |
| epoch-01 | 8/26 (30.8%) | 17/26 (65.4%) | 26/26 (100.0%) | 3/20 (15.0%) | 2/2 (100.0%) | 1/2 | 8/26 |
| epoch-02 | 10/26 (38.5%) | 16/26 (61.5%) | 26/26 (100.0%) | 4/20 (20.0%) | 2/2 (100.0%) | 2/2 | 5/26 |

Probe checks use action-class semantics with legal count ranges, not exact quantity agreement. A feasible action can still fail Mineflayer pathing or world-state verification. These metrics are development evidence only, not a guarantee of gameplay improvement.
