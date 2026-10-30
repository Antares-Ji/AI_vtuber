/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import java.util.*;

/** Merge identical component-bearing stacks; never discard or move anything to a container. */
public final class InventoryStackPlan {
    private InventoryStackPlan() {}
    public record Stack(int slot,Object signature,int count,int maximum) {}
    public record Move(int source,int destination) {}
    public static Optional<Move> merge(List<Stack> stacks) {
        for(Stack destination:stacks.stream().filter(s->s.count()>0&&s.count()<s.maximum()).sorted(Comparator.comparingInt(Stack::count).reversed()).toList()) {
            var source=stacks.stream().filter(s->s.slot()!=destination.slot()&&s.count()>0&&s.count()<s.maximum()&&Objects.equals(s.signature(),destination.signature()))
                    .min(Comparator.comparingInt(Stack::count));
            if(source.isPresent()) return Optional.of(new Move(source.get().slot(),destination.slot()));
        }
        return Optional.empty();
    }
}
