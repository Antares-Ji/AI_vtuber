/* SPDX-License-Identifier: LGPL-3.0-only */
package example.collectreturn;

import com.google.gson.*;
import dev.mcplayeragent.harness.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.atomic.AtomicInteger;
import static org.junit.jupiter.api.Assertions.*;

class CollectReturnTest {
    @TempDir Path temp;
    private static final String ARGS = "{\"item\":\"minecraft:oak_log\",\"count\":2,\"x\":0,\"y\":64,\"z\":0}";
    private static JsonObject args() { return JsonParser.parseString(ARGS).getAsJsonObject(); }
    private static PlayerEvidence frame(int logs, double x) {
        return new PlayerEvidence(x, 64, .5, 0, 0, 0, 0, "none", "", "", "", "", "",
                Map.of("minecraft:oak_log", logs), Map.of(), Map.of(), 0);
    }
    private static SkillRegistry registry(PlayerTasks.Task pickup, PlayerTasks.Task navigate) {
        var registry = new SkillRegistry();
        registry.register("minecraft:pickup_items", "fixture", "fake", args -> pickup);
        registry.register("minecraft:navigate", "fixture", "fake", args -> navigate);
        ServiceLoader.load(SkillProvider.class).forEach(provider -> provider.register(registry));
        registry.seal(List.of("*")); return registry;
    }
    @Test void externalProviderIsDiscoveredAndVerifiedThroughTheRealHarness() throws Exception {
        var result = ExampleMain.demo(temp, AgentProfile.defaults());
        assertEquals("VERIFIED", result.get("state").getAsString()); assertTrue(result.get("simulation").getAsBoolean());
        assertEquals(3, result.get("steps").getAsInt());
        assertTrue(result.getAsJsonArray("skills").toString().contains("example:collect_return"));
        String events = Files.readString(Path.of(result.get("record_directory").getAsString()).resolve("events.jsonl"));
        assertTrue(events.contains("CONFIGURATION")); assertTrue(events.contains("SKILL_FINISHED"));
    }
    @Test void configuredBudgetInterruptsTheExternalSkillInsteadOfVerifying() throws Exception {
        var profile = AgentProfile.defaults().withOverrides(JsonParser.parseString("{\"limits\":{\"max_actions\":1}}").getAsJsonObject());
        var result = ExampleMain.demo(temp, profile);
        assertEquals("INTERRUPTED", result.get("state").getAsString());
        assertTrue(result.get("end_reason").getAsString().contains("BUDGET_EXHAUSTED"));
        assertEquals(1, result.get("steps").getAsInt());
    }
    @Test void disabledDependencyProducesAnExplicitInterruptedRun() throws Exception {
        var profile = AgentProfile.defaults().withOverrides(JsonParser.parseString("{\"enabled_skills\":[\"example:collect_return\",\"minecraft:navigate\"]}").getAsJsonObject());
        var result = ExampleMain.demo(temp, profile);
        assertEquals("INTERRUPTED", result.get("state").getAsString()); assertEquals(0, result.get("steps").getAsInt());
        assertTrue(result.get("end_reason").getAsString().contains("Disabled skill: minecraft:pickup_items"));
    }
    @Test void immediateChildSuccessMustStillPassInventoryAndPositionChecks() {
        PlayerTasks.Task claimed = (s, last, receipt) -> PlayerTasks.Step.done("claimed");
        var registry = registry(claimed, claimed);
        var collection = registry.start("example:collect_return", args()).next(frame(0, .5), null, "");
        assertEquals(PlayerProgress.Outcome.FAILED, collection.outcome()); assertTrue(collection.detail().contains("COLLECTION_NOT_OBSERVED"));
        var position = registry.start("example:collect_return", args()).next(frame(2, 8), null, "");
        assertEquals(PlayerProgress.Outcome.FAILED, position.outcome()); assertTrue(position.detail().contains("RETURN_NOT_OBSERVED"));
        assertEquals(PlayerProgress.Outcome.SUCCEEDED, registry.start("example:collect_return", args()).next(frame(2, .5), null, "").outcome());
    }
    @Test void childFailureStopsCompositionAndLifecycleHooksReachTheActiveChild() {
        var stops = new AtomicInteger(); var pauses = new AtomicInteger(); var resumes = new AtomicInteger(); var navigations = new AtomicInteger();
        PlayerTasks.Task waiting = new PlayerTasks.Task() {
            public PlayerTasks.Step next(PlayerEvidence s, PlayerProgress.Outcome last, String receipt) {
                return last == PlayerProgress.Outcome.FAILED ? PlayerTasks.Step.failed("blocked")
                        : PlayerTasks.Step.action(PlayerDecision.parse("{\"action\":\"WAIT\",\"ticks\":1}"));
            }
            public void paused() { pauses.incrementAndGet(); }
            public void resumed() { resumes.incrementAndGet(); }
            public void stopped() { stops.incrementAndGet(); }
        };
        var registry = registry(waiting, (s, last, receipt) -> { navigations.incrementAndGet(); return PlayerTasks.Step.done("unexpected"); });
        var task = registry.start("example:collect_return", args()); task.next(frame(0, 8), null, "");
        task.paused(); task.resumed(); assertEquals(1, pauses.get()); assertEquals(1, resumes.get());
        assertEquals(PlayerProgress.Outcome.FAILED, task.next(frame(0, 8), PlayerProgress.Outcome.FAILED, "blocked").outcome());
        task.stopped(); assertEquals(1, stops.get()); assertEquals(0, navigations.get());
        assertThrows(IllegalStateException.class, () -> task.next(frame(0, 8), null, ""));
        var canceled = registry.start("example:collect_return", args()); canceled.next(frame(0, 8), null, "");
        canceled.stopped(); canceled.stopped(); assertEquals(2, stops.get());
    }
    @Test void explicitMissingProfileDoesNotSilentlyRunWithDefaults() {
        assertThrows(java.io.IOException.class, () -> ExampleMain.main(new String[]{temp.toString(), temp.resolve("missing.json").toString()}));
    }
    @Test void factoryRejectsMalformedArgumentsBeforeChildrenRun() {
        var registry = registry((s,l,r) -> { fail("must not execute"); return null; }, (s,l,r) -> null);
        for (String value : List.of("{}", ARGS.replace("\"count\":2", "\"count\":0"), ARGS.replace("\"x\":0", "\"x\":0.2"),
                ARGS.replace("\"count\":2", "\"count\":\"2\""), ARGS.replace("minecraft:oak_log", "oak_log"), ARGS.replace("\"y\":64", "\"y\":null")))
            assertThrows(IllegalArgumentException.class, () -> registry.start("example:collect_return", JsonParser.parseString(value).getAsJsonObject()));
    }
}
