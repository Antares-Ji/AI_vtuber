/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import dev.mcplayeragent.harness.PlayerEvidence.Point;
import java.util.*;
import java.util.function.Predicate;

/** Retains connected trunk and branch members even after the original bottom log has been removed. */
public final class TreeCluster {
    private TreeCluster() {}
    public record Cluster(Set<Point> logs,boolean complete) {}
    public static Cluster collect(Point root,Collection<Point> previous,Predicate<Point> isLog,int budget) {
        ArrayDeque<Point> pending=new ArrayDeque<>(); Set<Point> visited=new HashSet<>(),logs=new LinkedHashSet<>();
        pending.add(root); pending.addAll(previous);
        while(!pending.isEmpty()&&visited.size()<budget) {
            Point p=pending.removeFirst(); if(!visited.add(p)) continue;
            if(Math.abs(p.x()-root.x())>7||Math.abs(p.z()-root.z())>7||Math.abs(p.y()-root.y())>32) continue;
            if(!isLog.test(p)) continue; logs.add(p);
            for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++) for(int z=-1;z<=1;z++)
                if(x!=0||y!=0||z!=0) pending.add(new Point(p.x()+x,p.y()+y,p.z()+z));
        }
        return new Cluster(Collections.unmodifiableSet(logs),pending.isEmpty());
    }
}
