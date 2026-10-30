/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import java.util.*;

public final class MiningTools {
    private MiningTools() {}
    public record Tool(int slot,boolean harvestable,int ticks,boolean damageable,int durability) {}
    public static Optional<Tool> best(List<Tool> tools,int reserve) {
        return tools.stream().filter(t->t.harvestable()&&t.ticks()>0&&t.ticks()<Integer.MAX_VALUE)
                .filter(t->!t.damageable()||t.durability()>reserve)
                .min(Comparator.comparingInt(Tool::ticks).thenComparingInt(t->t.damageable()?1:0).thenComparing(Comparator.comparingInt(Tool::durability).reversed()));
    }
}
