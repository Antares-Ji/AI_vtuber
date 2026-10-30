/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class InventoryStackPlanTest {
    @Test void mergingPartialsPreservesEveryItemAndEventuallyFreesASlot() {
        int[] counts={50,50,20};
        for(int i=0;i<4;i++) {
            List<InventoryStackPlan.Stack> stacks=new ArrayList<>();
            for(int slot=0;slot<counts.length;slot++) stacks.add(new InventoryStackPlan.Stack(slot,"coal/components-A",counts[slot],64));
            var move=InventoryStackPlan.merge(stacks); if(move.isEmpty()) break;
            int transfer=Math.min(counts[move.get().source()],64-counts[move.get().destination()]);
            counts[move.get().source()]-=transfer; counts[move.get().destination()]+=transfer;
        }
        assertEquals(120,Arrays.stream(counts).sum()); assertTrue(Arrays.stream(counts).anyMatch(n->n==0));
    }
    @Test void differentComponentsAndUnstackableEquipmentAreNeverMerged() {
        assertTrue(InventoryStackPlan.merge(List.of(new InventoryStackPlan.Stack(0,"named-coal-A",20,64),new InventoryStackPlan.Stack(1,"named-coal-B",20,64))).isEmpty());
        assertTrue(InventoryStackPlan.merge(List.of(new InventoryStackPlan.Stack(0,"pick",1,1),new InventoryStackPlan.Stack(1,"pick",1,1))).isEmpty());
    }
}
