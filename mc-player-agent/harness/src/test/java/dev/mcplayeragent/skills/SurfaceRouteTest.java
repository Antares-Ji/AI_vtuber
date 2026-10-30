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

class SurfaceRouteTest {
    @Test void longFlatTravelCommitsToStraightRunsInsteadOfRepeatedTwoStepTurns() {
        Point start=new Point(0,64,0), goal=new Point(30,64,0);
        var path=SurfaceRoute.find(start,goal,p->p.y()==64&&Math.abs(p.x())<=32&&Math.abs(p.z())<=4,p->true,4096);
        assertEquals(30,path.size()); assertEquals(new Point(12,64,0),SurfaceRoute.waypoint(start,path));
        assertEquals(goal,path.getLast());
    }
    @Test void obstaclesAreRoutedAroundAndUnknownTerrainIsNotTraversed() {
        Point start=new Point(0,64,0), goal=new Point(5,64,0);
        var path=SurfaceRoute.find(start,goal,p->p.y()==64&&p.x()>=0&&p.x()<=5&&Math.abs(p.z())<=2&&!(p.x()==2&&p.z()==0),p->true,4096);
        assertFalse(path.isEmpty()); assertFalse(path.contains(new Point(2,64,0)));
        assertTrue(SurfaceRoute.find(start,goal,p->p.x()<2&&p.y()==64,p->true,40).isEmpty());
    }
    @Test void stepUpNeedsHeadClearanceAndNeverWalksAcrossATwoBlockFall() {
        Point a=new Point(0,64,0), b=new Point(1,65,0);
        Set<Point> floor=Set.of(a,b);
        assertEquals(List.of(b),SurfaceRoute.find(a,b,floor::contains,p->true,30));
        assertTrue(SurfaceRoute.find(a,b,floor::contains,p->false,30).isEmpty());
        Point deep=new Point(1,62,0);
        assertTrue(SurfaceRoute.find(a,deep,Set.of(a,deep)::contains,p->true,30).isEmpty());
    }
}
