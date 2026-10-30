/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import java.util.*;

/** Append only confirmed inventory gains, never item disappearance or animation packet amounts. */
public final class PickupJournal {
    public record Entry(long sequence,UUID entity,String item,int count,int x,int y,int z,long tick) {}
    private final ArrayDeque<Entry> entries=new ArrayDeque<>(); private long sequence;
    public long cursor() { return sequence; }
    public void accepted(UUID entity,String item,int before,int after,int x,int y,int z,long tick) {
        int gain=after-before; if(gain<=0) return;
        entries.addLast(new Entry(++sequence,entity,item,gain,x,y,z,tick));
        while(entries.size()>512) entries.removeFirst();
    }
    public List<Entry> since(long cursor) { return entries.stream().filter(e->e.sequence()>cursor).toList(); }
    public boolean truncated(long cursor) { return !entries.isEmpty()&&cursor<entries.getFirst().sequence()-1; }
}
