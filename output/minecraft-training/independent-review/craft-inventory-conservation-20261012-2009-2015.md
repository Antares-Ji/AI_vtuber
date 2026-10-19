# Minecraft crafting inventory audit (read-only)

**Window audited:** 2026-10-12 20:09:20.955–20:15:48.043 UTC (2026-10-13 04:09:20.955–04:15:48.043 Asia/Shanghai).  
**Sources:** `logs/minecraft-autonomy.jsonl`, `logs/minecraft-session-1791830191222.jsonl`, the installed Mineflayer craft/window implementation, and current `src/minecraft/survival-skills.js`. No game actions, code changes outside this report, GPU work, or training-data access were performed.

## Finding

The fully verified craft events in this window conserve ingredients exactly under vanilla recipes. Two failed inventory-grid craft tasks show delayed or incomplete inventory observations:

- Task `95759859-a0a3-4d7f-aed7-682a8fd30522` attempted one spruce-log-to-planks craft. The log disappeared from the bag snapshot, but the four-plank output was not visible when verification timed out. The next model observation still showed five planks; after a later wood-gather action, its inventory snapshot contained the old five plus a separate stack of four planks. Gathering logs does not craft planks. This is consistent with a late inventory update or other inventory/window change, but the logs do not prove the four planks came from this craft.
- At 04:15:41 local time, task `80c0b679-ddb7-40d8-9555-48ac5b3315ca` attempted two stick recipes (requested 8 sticks). The first batch was confirmed; the second was not. The failure snapshot changed sticks 22→26 and no longer listed the 29 planks. For the standard recipe, two batches should consume four planks and add eight sticks, leaving 25 planks and 30 sticks. The observed bag-only delta cannot be explained by recipe consumption alone. It does **not** establish that the 29 planks were destroyed.

The strongest code-level lead is that both audit snapshots and `count()` use `bot.inventory.items()` (`survival-skills.js:43,51`). Mineflayer's `Window.items()` returns only slots in the inventory range (`prismarine-windows/lib/Window.js:414–415`); it excludes crafting-grid/container slots, and it does not include the carried cursor item (`selectedItem`). Thus the log can say “missing from inventory items” without proving an item is gone from the complete window state. A timing/reconciliation issue is also plausible: the craft path calls `bot.craft()` then `_syncWindow(bot.inventory)` and polls that same bag-only count (`survival-skills.js:399–407`). Mineflayer 4.39.0's `_syncWindow` listens for the next `setWindowItems:<windowId>` after sending a no-op click with an impossible state ID (`inventory.js:856–869`); the session does not record packet IDs, full slots, cursor contents, or sync response correlation, so it cannot establish whether a returned snapshot was current for that craft.

## Per-craft conservation

Counts below aggregate duplicate stacks with the same item name. Minecraft recipe expectations are: 1 spruce log → 4 spruce planks; 2 planks → 4 sticks; 4 planks → 1 crafting table; 3 planks + 2 sticks → 1 wooden pickaxe.

| UTC time | Action / task suffix | Bag before → after | Assessment |
|---|---|---|---|
| 20:10:57 | planks ×4 / `9ae3f86c` | log 1 → 0; planks 0 → 4 | Verified; balances |
| 20:11:00 | sticks ×4 / `eecf8446` | planks 4 → 2; sticks 0 → 4 | Verified; balances |
| 20:11:04, 20:11:26 | crafting table ×1 / `cad8ecc4`, `56861c78` | planks 2 unchanged; sticks 4 unchanged | Correctly rejected: needs 4 planks |
| 20:11:12, 20:11:19 | planks ×4 / `9129cc16`, `3ff82c8d` | unchanged | Correctly rejected: no log |
| 20:12:11 | planks ×4 / `21f28764` | planks 2→6; logs 4→3 | Verified; balances |
| 20:12:15 | planks ×4 / `a1e5101d` | planks 6→10; logs 3→2 | Verified; balances |
| 20:12:19 | planks ×4 / `385d0a1c` | planks 10→14; logs 2→1 | Verified; balances |
| 20:12:23 | sticks ×4 / `7b47b5ca` | planks 14→12; sticks 4→8 | Verified; balances |
| 20:12:27 | table ×1 / `034e4c31` | planks 12→8; table 0→1 | Verified; balances |
| 20:12:31 | wooden pickaxe ×1 / `483b0d7c` | planks 8→5; sticks 8→6; pick 0→1 | Verified; balances |
| 20:12:36 | planks ×4 / `95759859` | planks 5→5; logs 1→0 | Failed after sync/poll; output absent at failure. Four planks appear in a separate stack by the end of a later gather; likely delayed/unattributed inventory change, not proof of loss. |
| 20:13:58 | planks ×4 / `d2bdc59c` | planks 9→13; logs 4→3 | Verified; balances (the two pre-existing plank stacks sum to 9) |
| 20:14:02 | planks ×4 / `79ca7e45` | planks 13→17; logs 3→2 | Verified; balances |
| 20:14:06 | planks ×4 / `2609b350` | planks 17→21; logs 2→1 | Verified; balances |
| 20:14:10 | planks ×8 / `40238798` | unchanged | Correctly rejected: only one log, two needed |
| 20:14:17 | sticks ×4 / `d2779208` | planks 21→19; sticks 6→10 | Verified; balances |
| 20:14:20 | sticks ×4 / `7dde8af6` | planks 19→17; sticks 10→14 | Verified; balances |
| 20:15:11 | planks ×4 / `e3f34246` | planks 17→21; logs 5→4 | Verified; balances |
| 20:15:15 | planks ×4 / `ec788267` | planks 21→25; logs 4→3 | Verified; balances |
| 20:15:19 | planks ×8 / `5322c459` | planks 25→33; logs 3→1 | Verified; balances |
| 20:15:22 | planks ×8 / `3f555e57` | unchanged | Correctly rejected: one log, two needed |
| 20:15:30 | sticks ×8 / `31ce3208` | planks 33→29; sticks 14→22 | Both batches verified; balances |
| 20:15:34 | planks ×8 / `a5d3590a` | unchanged | Correctly rejected: one log, two needed |
| 20:15:41 | sticks ×8 / `80c0b679` | planks 29→not listed; sticks 22→26 | First of two batches confirmed (`partialResult.gained=4`, `complete=false`); second unconfirmed. The observed deficit is not attributable to the four-plank recipe cost. |

Wood gathering between crafts is separate from recipe accounting. The 20:13:20 gather result lists `planks:5` and `planks:4` as separate stacks and `spruce_log:3`; the 20:13:23 model observation preserves that split. No log says that gather crafted or directly picked up planks. There are nearby entities generically typed `item` later in the window, but their item name/origin is not recorded, so an environmental drop cannot be ruled in or out.

## Compatibility and limits

Installed package versions are Mineflayer **4.39.0**, minecraft-data **3.117.0**, prismarine-recipe **1.5.0**, prismarine-windows **2.10.0**, and prismarine-item **1.18.0**. `minecraft-data('26.1.2')` resolves to protocol/data metadata for **26.1**. The logs report `server_window_sync` / `native_crafting_table_sync`, indicating this runtime took the explicit-sync path for these operations; nothing in this audit proves a general 26.1.2 incompatibility.

The session records bag snapshots and sync-step names, not full window slots, crafting matrix, cursor item, packet acknowledgements, or item entity names. It also does not record external/manual inventory actions. Therefore the 04:16 state (“stick 26, spruce log 1, wooden pickaxe 1; no planks in `inventory.items()`”) cannot distinguish a carried/crafting-grid stack, a late server/window reconciliation, an external inventory interaction, or an actual server-side removal. No claim of item destruction or training error is supported by these logs.

For a future diagnostic run, log the full `bot.inventory.slots` plus `selectedItem` before/after each craft and every `setWindowItems`/slot update with window ID and state ID. Compare bag, crafting grid, cursor, and server-confirmed deltas separately; do not change behavior based on this audit alone.

## Follow-up evidence: repeated slot-0 timeout (20:18–20:20 UTC)

Root also reported a later same-session task; I checked its read-only session/autonomy records and the same installed code path:

- Task `3be93a33-0ccc-4416-ad2d-7c90e2737090`, craft planks ×4, began 20:18:41.859 with one spruce log and no listed planks. The only step logged was `craft`; there is no `sync_craft_inventory` step. It failed at 20:19:01.889 with `Event updateSlot:0 did not fire within timeout of 20000ms`. Its after-snapshot has no log and 26 planks. The recipe effect is visible in the bag even though Mineflayer reported failure.
- Task `b882e15f-6be5-43f3-b48f-cf443f072d59`, craft sticks ×4, began 20:20:27.915 and failed at 20:20:48.253 with the same slot-0 timeout. The bag changed from 22 to 20 planks while sticks remained 26. For one stick recipe, consuming two planks is expected, but the four-stick output is not in the bag snapshot. Whether it was on the cursor/in crafting slots or otherwise not committed is unobserved.

This confirms the narrow root cause: the installed Mineflayer inventory-crafting path waits for a `updateSlot:0` event after clicking the synthetic crafting-result slot. A 20-second absence of that specific event is being surfaced as craft failure, even when the server inventory snapshot shows the recipe output was actually applied (planks task). For the sticks task, the event absence coincides with consumed input and no output in the bag, so this audit cannot establish the output's location or final server state.

Smallest safe fix direction: for the 2×2 player-inventory crafting path, replace the hard dependency on `updateSlot:0` with a post-click authoritative full-window reconciliation and verify the expected ingredient/output delta in bag slots; record cursor and craft-grid slots too. Correlate that reconciliation to the current click/state ID so a stale or unrelated window update cannot falsely pass. Increasing the timeout alone does not fix an event that the server does not emit.
