/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import java.util.List;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class MiningToolsTest {
    @Test void fastestWrongTierToolNeverDestroysTheResource() {
        var wrong=new MiningTools.Tool(0,false,5,true,100);
        var correct=new MiningTools.Tool(1,true,20,true,50);
        assertEquals(correct,MiningTools.best(List.of(wrong,correct),2).orElseThrow());
    }
    @Test void durabilityReserveAndUnbreakableTargetsAreRespected() {
        assertTrue(MiningTools.best(List.of(new MiningTools.Tool(0,true,10,true,2)),2).isEmpty());
        assertTrue(MiningTools.best(List.of(new MiningTools.Tool(0,true,Integer.MAX_VALUE,false,100)),2).isEmpty());
        assertTrue(MiningTools.best(List.of(new MiningTools.Tool(0,true,10,true,2)),0).isPresent());
    }
    @Test void equalSpeedUsesANonDamageableOptionBeforeWearingATool() {
        var hand=new MiningTools.Tool(4,true,20,false,Integer.MAX_VALUE);
        assertEquals(hand,MiningTools.best(List.of(new MiningTools.Tool(0,true,20,true,100),hand),2).orElseThrow());
    }
}
