# STS2 historical evidence audit — 2026-11-01

## Scope and evidential status

Read-only audit of existing project documentation, autonomy JSONL and selected learning JSON; no live service calls, game inputs, service changes, or manual screenshot interpretation. Statements about pixels below are attributed to the stored documentation/model/OCR records. Historical human verification was not independently repeated. Runtime artifacts are local and may be ignored by Git; the accompanying `historical-summary.json` records paths, SHA256 hashes, line numbers and extracted observation summaries so that claims remain traceable.

The available evidence does **not** establish autonomous full-game completion or a win rate. Task starts/resumes are not independent games. The 48-floor historical settlement belongs to a different, Codex-supervised run. “Learning” generally means evidence retention, retrieval and prompt/validation revisions; the native-run documents explicitly deny weight fine-tuning. A small earlier YOLO prototype training experiment is separate from Qwen/DeepSeek policy learning.

## Distinct historical systems

| Period / source | Decision maker | Observation / execution | Supported interpretation |
|---|---|---|---|
| 2026-10-21 user play, then explicit takeover; `docs/sts2-learning-and-input.md` | Before 09:28:15Z the user; later game agent with official DeepSeek | Game MCP state/action interface; local YOLO/Qwen reader separately | User actions cannot be credited to AI. Later MCP progress is structured-interface automation, not proof of native mouse play or pure vision. |
| 2026-10-24 knowledge/summarizer | DeepSeek analysis; read-only summarizer | Catalog export, game interface and separate OCR memories | Useful hypotheses and retrieval, not demonstrated training improvement or independent full-run result. |
| 2026-10-26 native drag and floors 19–48; `docs/sts2-native-drag-2026-10-26.md`, `docs/sts2-native-learning-2026-10-26.md` | Codex/conversation agent supervised and chose actions | Native client screenshots; local Qwen assisted reading/selected localization; project Win32 input | Demonstrates native input and supervised progression. Qwen observation is not Qwen autonomous strategy. Crops and named localization targets sometimes supplied by supervising agent. |
| 2026-10-30 onward director native API experiment; `docs/sts2-api-autonomy-validation-20261030.md` | DeepSeek role API; planner variants Flash/Pro with changing thinking settings | Local Qwen3-VL-4B NF4 + same-frame OCR/CV initially; native input | Gameplay choice delegated to role API; Codex starts/stops, diagnoses and changes code between segments. Does not imply an uninterrupted autonomous benchmark. |
| Cloud phase, beginning log `1793419983818.jsonl` | DeepSeek role planner, separately from observer | Official DeepSeek Flash image observation + local OCR/CV; native input | Cloud observation must be called cloud, not local model inference. Same-frame consistency is not independent ground truth. |

The imported MC Harness architecture has its own structured observation/action/server-receipt semantics. Nothing here validates MC or BetterGI/Genshin gameplay, and it must not be relabeled pure vision.

## The 48-floor record

`docs/sts2-native-learning-2026-10-26.md:69` explicitly attributes the run to Codex supervision, local Qwen reading and native execution. Final section reports queen defeat frame/run `1793043293517950400`, subsequent story damage of 1447 and zero player HP, settlement title **“胜利……？”**, 48 floors, 704 gold, four elites and three bosses; references `1793043447448297600` and `1793043564449434800`. It is a documented supervised result with an ambiguous narrative title, not independent evidence that the later director/DeepSeek framework cleared a game. Zero HP in this narrative also shows why a terminal rule cannot equate HP=0 with defeat without corroborating text. Historical selected-card audit counts (17 observations, 16 card kinds, 14 exact fields at last update) are a curated small sample, not general accuracy.

## Native API chronology and latest outcomes

The directory contains 155 numeric autonomy JSONL files. This audit enumerated **67 segments** from the first 2026-10-30 API trial log `1793388525484.jsonl` through latest `1793464975561.jsonl`. The 88 earlier files are not classified here as live independent trials; their number is not a game denominator. Each included segment has a hash and event counts in the JSON companion. Event-less observation/decision entries are counted separately from rejection events; planning kind counts are not physical-action counts.

Before the defeat, documented two reward transitions were frames `1793390822625229000` and `1793412202134874300` (`docs/sts2-api-autonomy-validation-20261030.md:392`). This supports two completed battles in that inherited game, not two floors or a full clear. Floor count is not reliably recorded. Multiple starts, repairs, foreground loss and repeated observations interrupt this same trajectory.

Cloud trial `1793420472793.jsonl` (job `3d558e04-4481-4777-bfda-71e3dc2c50dd`) began at 3/80 HP and ran approximately 204.5 seconds. `learning/cloud-trial-outcome-20261030.json` records two actual drags (defend and bash), a turn-end click and defeat reported by cloud vision, with independent OCR file `ocr-1793420722596680300.json` reading 0/80 and settlement text. It is a loss of an inherited near-death state, not a fresh-start policy trial. Its formal Skill state was documented UNVERIFIED; do not convert that to a completed success.

The following settlement/retry logs are continuations of that defeat. They include stop decisions, malformed cloud JSON, menu/unlock confusion and chapter-opening narrative. `docs/sts2-defeat-retry-20261030.md:21` explicitly says “第4章 - 开放” was unlock content, not reaching chapter four in a new adventure. The document's line 29 and `learning/ocr-1793421766210591300.json` identify a genuine new start: 80/80 HP, 99 gold, seed `ZH3C3M86F1`, distinct from defeated `35A4QGBA4D`. Thereafter the apparent intended event choice and resulting delete-card screen did not match; button text/coordinate association remained a confound (line 40).

Latest logs extend past the final written defeat-retry note:

| Autonomy log | UTC first/last event | Stored observations / physical receipts | End state |
|---|---|---|---|
| `1793422373744.jsonl` | Oct 31 04:52:53.755–04:55:31.159 | Map click then battle; nine accepted observation/decisions; eight input-completed receipts: one click, four moves, three down/up drag sequences | Error: zero energy and end-turn button not located. Map-to-battle observations supersede the earlier “map still blocked” note for this specific layout; no reward or full clear. |
| `1793464683486.jsonl` | Oct 31 16:38:03.500–16:39:07.904 | Three accepted decisions; two moves and one end-turn click receipt; initial model/OCR HP 80/80, energy 0 | Same zero-energy/end-turn-location error. No game outcome. |
| `1793464975561.jsonl` | Oct 31 16:42:55.576–16:47:36.524 | 16 accepted decisions: seven hover, seven drag, two click. Fourteen input-completed receipts: seven moves, **five down/up sequences**, two clicks. Two additional drag choices only prepared start points. | `stopped`, error null. Last accepted observation remains battle: 73/80 HP, zero energy, enemy OCR/model 5/38. Later drag rejected, `inputSent:false` (line 311). No reward/terminal transition; game outcome censored. |

These three segments appear to resume the same newly seeded trajectory, based on continuity of scene/HP/energy and no intervening recorded new-start transition. The audit does not assert exhaustive identity across the approximately 11-hour gap or exclude unlogged human intervention. It does not count these as three games.

The latest autonomy-linked physical input receipt is `runtime/game-input/runs/1793465237865483400/result.json` (latest log line 294): `held_keys:[]`, `held_buttons:[]`, `evidence_error:null`, `status:awaiting_visual_review`, `game_verified:false`. This supports controller release at receipt completion, not a live measurement of global keyboard state. The current stop route is `src/api/game-input.js:127`: `autonomous.stop()`, STOP-file write, and `releaseComplete:!busy`; API busy state and historical receipt have different meanings.

## Protocol changes that affect interpretation

Latest log `1793464975561.jsonl` has `vision_provider` at line 2 declaring DeepSeek/Flash, and decision model fields likewise DeepSeek Flash. It contains seven `battle_rules_reused` events, with `currentNumericalEffectsVerified:false` (first at line 86), and historical descriptions tagged `rule_source:battle_memory` / `description_is_historical:true`. It also records 16 `post_hover_frame_reused` events with `allActionTypes:true` (first line 18). Thus older documentation's strict wording about fresh standalone capture after every non-hover input and all card effects being current-frame cannot be carried forward unchanged. The report must distinguish new image observations from historically recalled rules. No claim is made here about correctness or the full safety semantics of the changed code; that requires separate code audit and paired replay.

Rejected decisions remain useful boundary evidence, not successful gameplay: the latest log has two `rejected_decision` entries and one `rejected_card_drag`. The latter follows a plan whose expected HP reduction and previous-outcome narrative were not independently verified. Enemy HP outputs fluctuate between unknown and conflicting-looking values; only supported parsed fields are retained, and expected damage is not a measured result.

## Performance evidence and confounds

`learning/throughput-profile-1793418194543023100.json` is an earlier **49-segment** snapshot, not the latest 67-segment total: elapsed 28,973.25 s; log-creation-to-last-event intervals 12,035.5 s; between-segment time 16,937.75 s. Its 273 physical receipts sum to 351.19 s, mean 1.29 s; 199 planned hovers, 52 planned drags include 15 preparations. Gaps include development, tests, waits and restarts, with no precise attribution. Saved-frame replays share sources with online records, so summed model time is not an exact exclusive wall-clock decomposition.

Selected six-frame interface comparisons report local 4B NF4 42.010 s, local 8B NF4 42.545 s and cloud Flash 8.997 s (78.6% less than 4B). Sources are `capacity-assessment-*.json`, `capacity-comparison-summary-20261030.json` and `docs/sts2-cloud-vision-20261030.md:25`. These are convenience difficulty cases without independent annotation; cloud encoding/wrapping/preprocessing differs. They support measured request latency in those cases, not recognition accuracy, parameter-size causality, win rate or whole-game speed. BF16/NF4, hardware sharing, prompt/crop changes and output schema adaptation are not isolated. The three-pair capture-speed comparison (2778→1266 ms average) only measures screenshot-stage latency, not policy progress.

## Required limits for the stage report

- No fabricated win rate, confidence interval, general OCR/VLM accuracy, or number of independent completed games. Independent game denominator remains null.
- Distinguish input receipts, subsequent model/OCR observations, documented historical manual review, simulation tests, replay predictions and terminal outcomes.
- Treat code/prompt/validation changes, planner swaps, cloud switch, inherited game state, foreground interruptions and supervisor-driven restarts as confounds rather than controlled interventions.
- Avoid adjacent-frame train/test splits; future evaluation should hold out complete battles/games/seeds. No native policy fine-tuning success is established here.
- The latest artifact timestamp is Oct 31 16:47:36.524Z; this is a historical cutoff, not evidence of current runtime state on Nov 1.

## Reproduction

From project root, through the WSL launcher, run `python3 docs/research/sts2-20261101/summarize_history.py` then `python3 docs/research/sts2-20261101/enrich_history.py`. Both scripts read artifacts and write only the report directory. The first regenerates segment extraction; the second attaches interpretation, selected-source hashes and physical receipt classification. `audit_history.py` and `receipt_details.py` are exploratory read-only extractors. No script calls the director, vision service, game, or input API.
