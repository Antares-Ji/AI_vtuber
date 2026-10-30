/* SPDX-License-Identifier: LGPL-3.0-only */
package example.collectreturn;

import com.google.gson.*;
import dev.mcplayeragent.harness.*;
import java.util.Set;

/** An external skill composed solely through the public harness API. */
public final class CollectReturnProvider implements SkillProvider {
    @Override public void register(SkillRegistry registry) {
        registry.register("example:collect_return", "1", "Bring inventory to count, then return. Required args: item (namespaced id), count (1..4096), x/y/z (integer block coordinates). Requires minecraft:pickup_items and minecraft:navigate.",
                args -> new CollectReturnTask(registry, args));
    }
    private static final class CollectReturnTask implements PlayerTasks.Task {
        private final SkillRegistry registry;
        private final String item;
        private final int count, x, y, z;
        private PlayerTasks.Task child;
        private int phase;
        private boolean stopped;
        CollectReturnTask(SkillRegistry registry, JsonObject args) {
            this.registry = registry;
            if (!args.keySet().equals(Set.of("item", "count", "x", "y", "z")))
                throw new IllegalArgumentException("Expected exactly item,count,x,y,z");
            if (!args.get("item").isJsonPrimitive() || !args.getAsJsonPrimitive("item").isString())
                throw new IllegalArgumentException("item must be a namespaced string");
            item = args.get("item").getAsString(); SkillRegistry.requireId(item);
            count = integer(args, "count"); x = integer(args, "x"); y = integer(args, "y"); z = integer(args, "z");
            if (count < 1 || count > 4096) throw new IllegalArgumentException("count must be 1..4096");
        }
        @Override public PlayerTasks.Step next(PlayerEvidence state, PlayerProgress.Outcome last, String receipt) {
            if (stopped) throw new IllegalStateException("Task already stopped");
            if (state == null) return PlayerTasks.Step.action(PlayerDecision.parse("{\"action\":\"WAIT\",\"ticks\":1}"));
            for (int transitions = 0; transitions < 3; transitions++) {
                if (child != null) {
                    var step = child.next(state, last, receipt);
                    if (step.action() != null) return step;
                    var finished = child; child = null; finished.stopped();
                    if (step.outcome() != PlayerProgress.Outcome.SUCCEEDED) return PlayerTasks.Step.failed(step.detail());
                    phase++;
                    if (state.items().getOrDefault(item, 0) < count)
                        return PlayerTasks.Step.failed("COLLECTION_NOT_OBSERVED: inventory is below requested count");
                }
                if (phase == 0 && state.items().getOrDefault(item, 0) >= count) phase = 1;
                if (phase == 2) {
                    double distance = Math.sqrt(Math.pow(state.x() - (x + .5), 2) + Math.pow(state.y() - y, 2) + Math.pow(state.z() - (z + .5), 2));
                    return distance <= .65 ? PlayerTasks.Step.done("Inventory and return position observed")
                            : PlayerTasks.Step.failed("RETURN_NOT_OBSERVED: destination has not been reached");
                }
                JsonObject args = new JsonObject();
                if (phase == 0) {
                    args.addProperty("item", item); args.addProperty("count", count - state.items().getOrDefault(item, 0));
                    args.addProperty("mode", "filtered"); child = registry.start("minecraft:pickup_items", args);
                } else {
                    args.addProperty("x", x); args.addProperty("y", y); args.addProperty("z", z);
                    child = registry.start("minecraft:navigate", args);
                }
                // A completed child's receipt must never be delivered to the next child.
                last = null; receipt = "Child started";
            }
            throw new IllegalStateException("Unexpected task transition count");
        }

        @Override public void paused() { if (child != null) child.paused(); }
        @Override public void resumed() { if (child != null) child.resumed(); }
        @Override public void stopped() {
            stopped = true; var current = child; child = null; if (current != null) current.stopped();
        }
    }
    private static int integer(JsonObject args, String name) {
        if (!args.get(name).isJsonPrimitive() || !args.getAsJsonPrimitive(name).isNumber())
            throw new IllegalArgumentException(name + " must be integer");
        try { return args.get(name).getAsBigDecimal().intValueExact(); }
        catch (ArithmeticException error) { throw new IllegalArgumentException(name + " must be int32", error); }
    }
}
