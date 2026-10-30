/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import dev.mcplayeragent.harness.PlayerEvidence.Point;
import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ShelterLayoutTest {
    private final Point center=new Point(10,64,-20);
    @Test void completeRoofAndWallsLeaveExactlyATwoHighDoorwayAndStandingSpace() {
        var cells=ShelterLayout.shell(center); assertEquals(23,cells.size()); assertEquals(23,new HashSet<>(cells).size());
        assertFalse(cells.contains(center)); assertFalse(cells.contains(new Point(10,65,-20)));
        assertFalse(cells.contains(ShelterLayout.entrance(center))); assertFalse(cells.contains(new Point(10,65,-19)));
        assertEquals(9,cells.stream().filter(p->p.y()==66).count());
    }
    @Test void roofCenterIsLastSoEarlierRoofWorkCanJumpThroughTheOpening() {
        var cells=ShelterLayout.shell(center); assertEquals(new Point(10,66,-20),cells.getLast());
        assertTrue(cells.subList(0,14).stream().allMatch(p->p.y()<66));
    }
    @Test void missingRoofFloorOrOpenDoorCannotBeRecordedAsASafeShelter() {
        Set<Point> solid=new HashSet<>(ShelterLayout.shell(center));
        for(int x=-1;x<=1;x++) for(int z=-1;z<=1;z++) solid.add(new Point(center.x()+x,center.y()-1,center.z()+z));
        assertTrue(ShelterLayout.verified(center,solid::contains,p->!solid.contains(p),true,true));
        assertFalse(ShelterLayout.verified(center,solid::contains,p->!solid.contains(p),false,true));
        Point roof=new Point(10,66,-20); solid.remove(roof);
        assertFalse(ShelterLayout.verified(center,solid::contains,p->!solid.contains(p),true,true));
        solid.add(roof); solid.remove(new Point(10,63,-20));
        assertFalse(ShelterLayout.verified(center,solid::contains,p->!solid.contains(p),true,true));
    }
}
