/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import java.util.Map;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class MiningTargetsTest {
    @Test void targetAliasesIncludeVariantsWithoutMatchingUnrelatedMinerals() {
        assertTrue(MiningTargets.matches("iron","minecraft:deepslate_iron_ore"));
        assertTrue(MiningTargets.matches("quartz","minecraft:nether_quartz_ore"));
        assertTrue(MiningTargets.matches("gold","minecraft:nether_gold_ore"));
        assertFalse(MiningTargets.matches("diamond","minecraft:coal_ore"));
        assertTrue(MiningTargets.matches("all_ores","some_mod:tin_ore"));
    }
    @Test void actualLootTypesAreDifferentFromMinedBlockIds() {
        assertTrue(MiningTargets.dropMatches("minecraft:deepslate_iron_ore","minecraft:raw_iron"));
        assertTrue(MiningTargets.dropMatches("lapis","minecraft:lapis_lazuli"));
        assertTrue(MiningTargets.matches("cobblestone","minecraft:stone"));
        assertFalse(MiningTargets.dropMatches("diamond","minecraft:cobblestone"));
    }
    @Test void silkTouchBlocksAndGoldNuggetsAreNotMisreportedAsEquivalentRawItems() {
        assertEquals(0,MiningTargets.goalUnits("coal",Map.of("minecraft:coal_ore",8)));
        assertEquals(2,MiningTargets.goalUnits("gold",Map.of("minecraft:raw_gold",1,"minecraft:gold_nugget",9)));
        assertEquals(0,MiningTargets.goalUnits("gold",Map.of("minecraft:gold_nugget",8)));
        assertEquals(12,MiningTargets.goalUnits("redstone",Map.of("minecraft:redstone",12)));
    }
}
