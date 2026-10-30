/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import dev.mcplayeragent.harness.PlayerEvidence.Point;
import java.util.*;

/** Clear head space before feet space; a descending step is always ahead, never directly below the player. */
public final class MiningCorridor {
    private MiningCorridor() {}
    public static Point step(Point start,int dx,int dz,int index,boolean descending) {
        if(Math.abs(dx)+Math.abs(dz)!=1||index<1) throw new IllegalArgumentException("Need a cardinal direction and positive step");
        return new Point(start.x()+dx*index,start.y()-(descending?index:0),start.z()+dz*index);
    }
    public static List<Point> clearCells(Point feet,boolean descending) {
        return descending?List.of(new Point(feet.x(),feet.y()+2,feet.z()),new Point(feet.x(),feet.y()+1,feet.z()),feet)
                :List.of(new Point(feet.x(),feet.y()+1,feet.z()),feet);
    }
}
