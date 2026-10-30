/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import dev.mcplayeragent.harness.PlayerEvidence.Point;
import java.util.*;
import java.util.function.Predicate;

/** A minimal 3x3 shell with two blocks of headroom, a two-high south doorway and a complete roof. */
public final class ShelterLayout {
    private ShelterLayout() {}
    public static List<Point> shell(Point center) {
        List<Point> out=new ArrayList<>();
        for(int y=0;y<=2;y++) {
            List<Point> layer=new ArrayList<>();
            for(int x=-1;x<=1;x++) for(int z=-1;z<=1;z++) {
                if(y<2&&x==0&&z==0 || y<2&&x==0&&z==1) continue;
                layer.add(new Point(center.x()+x,center.y()+y,center.z()+z));
            }
            layer.sort(Comparator.comparingInt(p->Math.abs(p.x()-center.x())==1&&Math.abs(p.z()-center.z())==1?0:
                    p.x()==center.x()&&p.z()==center.z()?2:1)); out.addAll(layer);
        }
        return List.copyOf(out);
    }
    public static Point entrance(Point center) { return new Point(center.x(),center.y(),center.z()+1); }
    public static boolean verified(Point center,Predicate<Point> solid,Predicate<Point> empty,boolean lowerDoorClosed,boolean upperDoorClosed) {
        if(!lowerDoorClosed||!upperDoorClosed) return false;
        for(int x=-1;x<=1;x++) for(int z=-1;z<=1;z++) if(!solid.test(new Point(center.x()+x,center.y()-1,center.z()+z))) return false;
        for(Point p:shell(center)) if(!solid.test(p)) return false;
        return empty.test(center)&&empty.test(new Point(center.x(),center.y()+1,center.z()));
    }
}
