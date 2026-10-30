/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.harness;

import com.google.gson.*;
import org.junit.jupiter.api.Test;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class SkillRegistryTest {
    private static PlayerTasks.Task done(String value) { return (s, last, receipt) -> PlayerTasks.Step.done(value); }
    @Test void aliasesAndCatalogUseTheSameRegisteredFactory() {
        var registry = new SkillRegistry();
        registry.register("minecraft:harvest_tree", "1", "Collect logs; optional x/y/z", args -> done("tree"));
        registry.seal(List.of("*"));
        var request = PlayerDecision.parse("{\"action\":\"SKILL\",\"text\":\"harvest_tree\"}");
        assertEquals("tree", registry.start(request).next(null, null, "").detail());
        assertEquals("minecraft:harvest_tree", registry.catalog().get(0).getAsJsonObject().get("id").getAsString());
        var catalog = registry.catalog(); catalog.remove(0); assertEquals(1, registry.catalog().size());
    }
    @Test void selectionIsPerInstanceAndDisabledSkillsNeverInvokeTheirFactory() {
        var calls = new AtomicInteger(); var first = new SkillRegistry(); var second = new SkillRegistry();
        first.register("example:test", "1", "test", args -> { calls.incrementAndGet(); return done("first"); });
        second.register("example:test", "2", "test", args -> done("second"));
        first.seal(List.of()); second.seal(List.of("example:test"));
        assertThrows(IllegalArgumentException.class, () -> first.start("example:test", new JsonObject()));
        assertEquals(0, calls.get()); assertEquals("second", second.start("example:test", new JsonObject()).next(null, null, "").detail());
    }
    @Test void setupErrorsAreExplicitAndRegistrationCannotChangeDuringExecution() {
        var registry = new SkillRegistry();
        assertThrows(IllegalArgumentException.class, () -> registry.register("invalid", "1", "test", args -> done("")));
        registry.register("example:test", "1", "test", args -> done(""));
        assertThrows(IllegalArgumentException.class, () -> registry.register("example:test", "2", "test", args -> done("")));
        assertThrows(IllegalStateException.class, () -> registry.start("example:test", new JsonObject()));
        assertThrows(IllegalArgumentException.class, () -> registry.seal(List.of("example:missing")));
        registry.seal(List.of("*"));
        assertThrows(IllegalStateException.class, () -> registry.register("example:late", "1", "late", args -> done("")));
        assertThrows(IllegalStateException.class, () -> registry.seal(List.of()));
        assertThrows(IllegalArgumentException.class, () -> registry.start("example:missing", new JsonObject()));
        assertThrows(IllegalArgumentException.class, () -> registry.start(PlayerDecision.parse("{\"action\":\"WAIT\"}")));
    }
    @Test void argumentsAreCopiedAndFactoryValidationIsNotSwallowed() {
        var registry = new SkillRegistry();
        registry.register("example:test", "1", "needs count", args -> {
            if (!args.has("count")) throw new IllegalArgumentException("count is required");
            args.remove("count"); return done("validated");
        });
        registry.register("example:null", "1", "broken", args -> null); registry.seal(List.of("*"));
        assertThrows(IllegalArgumentException.class, () -> registry.start("example:test", new JsonObject()));
        JsonObject args = new JsonObject(); args.addProperty("count", 2); registry.start("example:test", args);
        assertEquals(2, args.get("count").getAsInt());
        assertThrows(NullPointerException.class, () -> registry.start("example:null", args));
    }
}
