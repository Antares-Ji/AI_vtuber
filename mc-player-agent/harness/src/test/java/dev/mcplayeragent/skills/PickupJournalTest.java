/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import java.util.UUID;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PickupJournalTest {
    @Test void partialPickupCountsInventoryGainRatherThanStackSizeOrAnimation() {
        var journal=new PickupJournal(); journal.accepted(UUID.randomUUID(),"minecraft:coal",62,64,0,64,0,10);
        assertEquals(2,journal.since(0).getFirst().count());
    }
    @Test void disappearingEntityAndUnchangedInventoryGiveNoPickupCredit() {
        var journal=new PickupJournal(); journal.accepted(UUID.randomUUID(),"minecraft:coal",64,64,0,64,0,10);
        journal.accepted(UUID.randomUUID(),"minecraft:coal",64,63,0,64,0,11);
        assertTrue(journal.since(0).isEmpty());
    }
    @Test void independentCursorsAndBoundedHistoryCannotSilentlyInflateCounts() {
        var journal=new PickupJournal(); UUID entity=UUID.randomUUID();
        journal.accepted(entity,"coal",0,2,0,0,0,1); long cursor=journal.cursor();
        journal.accepted(entity,"coal",2,5,0,0,0,2); assertEquals(3,journal.since(cursor).getFirst().count());
        for(int i=0;i<520;i++) journal.accepted(entity,"coal",0,1,0,0,0,i);
        assertTrue(journal.truncated(cursor)); assertEquals(512,journal.since(0).size());
    }
}
