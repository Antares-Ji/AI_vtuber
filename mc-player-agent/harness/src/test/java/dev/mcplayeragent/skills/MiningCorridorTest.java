/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import dev.mcplayeragent.harness.PlayerEvidence.Point;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class MiningCorridorTest {
    @Test void staircaseMovesForwardOneBlockForEachOneBlockDescent() {
        var start=new Point(0,64,0);
        assertEquals(new Point(0,63,-1),MiningCorridor.step(start,0,-1,1,true));
        assertEquals(new Point(0,60,-4),MiningCorridor.step(start,0,-1,4,true));
        assertEquals(new Point(4,64,0),MiningCorridor.step(start,1,0,4,false));
    }
    @Test void staircaseClearsHeadAndFeetBeforeRemovingTheFrontLowerCell() {
        var cells=MiningCorridor.clearCells(new Point(0,63,-1),true);
        assertEquals(new Point(0,65,-1),cells.getFirst()); assertEquals(new Point(0,63,-1),cells.getLast());
        assertTrue(cells.stream().noneMatch(p->p.x()==0&&p.z()==0));
        assertThrows(IllegalArgumentException.class,()->MiningCorridor.step(new Point(0,64,0),0,0,1,true));
    }
}
