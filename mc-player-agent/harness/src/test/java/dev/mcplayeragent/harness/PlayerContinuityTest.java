/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PlayerContinuityTest {
    private static PlayerDecision action(String json) { return PlayerDecision.parse(json); }
    @Test void sameBlockMiningContinuesButNewToolOrTurnOrGoneTargetReleases() {
        var mine = action("{\"action\":\"BREAK\"}");
        assertTrue(PlayerContinuity.mining(mine, mine, 0, 0, 30, false));
        assertFalse(PlayerContinuity.mining(mine, mine, 0, 0, 30, true));
        assertFalse(PlayerContinuity.mining(mine, action("{\"action\":\"BREAK\",\"slot\":2}"), 0, 0, 30, false));
        assertFalse(PlayerContinuity.mining(mine, action("{\"action\":\"BREAK\",\"yaw\":90}"), 0, 0, 30, false));
    }
    @Test void holdUseContinuesOnlyForSameHandAndSelectedItem() {
        var use = action("{\"action\":\"USE\"}");
        assertTrue(PlayerContinuity.use(use, use, 0));
        assertFalse(PlayerContinuity.use(use, action("{\"action\":\"USE\",\"offhand\":true}"), 0));
        assertFalse(PlayerContinuity.use(use, action("{\"action\":\"MOVE\"}"), 0));
    }
    @Test void unrelatedInventoryChangesDoNotConfirmTheClickedSlot() {
        assertFalse(PlayerContinuity.clickedSlotChanged("a;b;cursor=air", "a;c;cursor=air", 0));
        assertTrue(PlayerContinuity.clickedSlotChanged("a;b;cursor=air", "air;b;cursor=a", 0));
    }
}
