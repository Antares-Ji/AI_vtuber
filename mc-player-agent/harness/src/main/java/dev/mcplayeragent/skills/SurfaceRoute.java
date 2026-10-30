/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import dev.mcplayeragent.harness.PlayerEvidence.Point;
import java.util.*;
import java.util.function.Predicate;

/** Bounded walking search for native player inputs: no digging, teleporting or unknown chunks. */
public final class SurfaceRoute {
    private SurfaceRoute() {}
    private record Node(Point point, double cost, double score) {}
    public static List<Point> find(Point start, Point goal, Predicate<Point> standable, Predicate<Point> clear, int budget) {
        var open = new PriorityQueue<Node>(Comparator.comparingDouble(Node::score));
        Map<Point, Double> costs = new HashMap<>(); Map<Point, Point> parents = new HashMap<>();
        costs.put(start, 0D); open.add(new Node(start, 0, distance(start, goal)));
        while (!open.isEmpty() && budget-- > 0) {
            Node n = open.remove();
            if (n.cost() > costs.getOrDefault(n.point(), Double.MAX_VALUE)) continue;
            if (n.point().equals(goal)) {
                var path = new ArrayList<Point>(); Point p = goal;
                while (!p.equals(start)) { path.add(p); p = parents.get(p); }
                Collections.reverse(path); return path;
            }
            for (int[] d : new int[][]{{1,0},{-1,0},{0,1},{0,-1}}) {
                for (int dy : new int[]{0,1,-1}) {
                    Point p = new Point(n.point().x()+d[0], n.point().y()+dy, n.point().z()+d[1]);
                    if (!standable.test(p)) continue;
                    // A step up also needs clearance above the starting head.
                    if (dy > 0 && !clear.test(new Point(n.point().x(), n.point().y()+2, n.point().z()))) continue;
                    double cost = n.cost()+1+Math.abs(dy)*0.4;
                    if (cost < costs.getOrDefault(p, Double.MAX_VALUE)) {
                        costs.put(p, cost); parents.put(p,n.point()); open.add(new Node(p,cost,cost+distance(p,goal)));
                    }
                    break;
                }
            }
        }
        return List.of();
    }
    private static double distance(Point a, Point b) { return Math.abs(a.x()-b.x())+Math.abs(a.z()-b.z())+Math.abs(a.y()-b.y())*0.4; }
    /** Merge a straight run into one committed waypoint instead of asking the model to steer each block. */
    public static Point waypoint(Point start, List<Point> path) {
        if (path.isEmpty()) return start;
        Point result = path.getFirst(); int dx = result.x()-start.x(), dz = result.z()-start.z();
        if (result.y()!=start.y()) return result;
        for (int i=1; i<Math.min(12,path.size()); i++) {
            Point next=path.get(i), previous=path.get(i-1);
            if (next.y()!=start.y() || next.x()-previous.x()!=dx || next.z()-previous.z()!=dz) break;
            result=next;
        }
        return result;
    }
}
