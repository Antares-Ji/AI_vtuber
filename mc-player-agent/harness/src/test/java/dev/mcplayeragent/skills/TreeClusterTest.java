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

class TreeClusterTest {
    @Test void entireTrunkAndBranchesRemainTasksAfterTheBottomLogBreaks() {
        Point root=new Point(0,64,0); Set<Point> wood=new HashSet<>();
        for(int y=64;y<71;y++) wood.add(new Point(0,y,0));
        wood.add(new Point(1,69,0)); wood.add(new Point(2,70,0));
        var first=TreeCluster.collect(root,List.of(),wood::contains,8192);
        assertTrue(first.complete()); assertEquals(9,first.logs().size());
        wood.remove(root);
        var remaining=TreeCluster.collect(root,first.logs(),wood::contains,8192);
        assertEquals(8,remaining.logs().size()); assertTrue(remaining.logs().contains(new Point(2,70,0)));
    }
    @Test void disconnectedTreesAreNotReportedAsPartOfTheCurrentTree() {
        Point root=new Point(0,64,0), other=new Point(5,64,0);
        var cluster=TreeCluster.collect(root,List.of(),Set.of(root,other)::contains,8192);
        assertEquals(Set.of(root),cluster.logs());
    }
    @Test void exhaustedSearchBudgetIsNotMistakenForACompleteTree() {
        var cluster=TreeCluster.collect(new Point(0,0,0),List.of(),p->true,8);
        assertFalse(cluster.complete());
    }
}
