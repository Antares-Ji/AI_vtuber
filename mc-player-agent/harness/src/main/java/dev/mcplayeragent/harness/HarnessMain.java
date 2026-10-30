/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.harness;

import com.google.gson.*;
import dev.mcplayeragent.mission.MissionRun;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Deterministic simulation of the same harness used by the Minecraft adapter. */
public final class HarnessMain {
    private HarnessMain() {}
    public static void main(String[] args) throws Exception {
        if (args.length == 0 || args.length == 1 && args[0].equals("--help")) {
            System.out.println("Usage: demo [output-directory]\nRuns a simulated world; no game, model service or API key required.");
            return;
        }
        if (!args[0].equals("demo") || args.length > 2) throw new IllegalArgumentException("Expected: demo [output-directory]");
        System.out.println(new GsonBuilder().setPrettyPrinting().create().toJson(demo(Path.of(args.length == 2 ? args[1] : "build/demo"))));
    }
    public static JsonObject demo(Path output) throws Exception {
        var world = new DemoWorld();
        try (var recording = MissionRun.start(output, "simulation", "demo", "Collect two simulated logs", "fixture", "deterministic")) {
            var harness = new AgentHarness("Collect two simulated logs", new JsonObject(), state -> CompletableFuture.completedFuture(PlayerPlan.parse("""
                    {"phase":"collect","goal_check":{"type":"item_count","item":"minecraft:oak_log","count":2},
                     "actions":[{"action":"SKILL","text":"collect_demo"},{"action":"DONE"}]}
                    """)), world, recording);
            try {
                for (int tick = 0; tick < 100 && harness.running(); tick++) {
                    var before = world.evidence();
                    PlayerDecision action = harness.tick(before);
                    if (action == null) continue;
                    if (action.action() == PlayerDecision.Kind.MOVE) world.logs++;
                    else if (action.action() != PlayerDecision.Kind.DONE) throw new IllegalStateException("Unexpected demo action");
                    harness.complete(PlayerProgress.Outcome.SUCCEEDED, "Simulated inventory receipt", "demo logs=" + world.logs, before.stableKey(), world.evidence());
                }
                if (harness.running()) throw new IllegalStateException("Demo exceeded 100 ticks");
                recording.flushed().get(5, TimeUnit.SECONDS);
                var summary = recording.snapshot();
                if (!summary.get("state").getAsString().equals("VERIFIED")) throw new IllegalStateException("Demo goal was not verified");
                summary.addProperty("simulation", true); summary.addProperty("record_directory", recording.directory().toAbsolutePath().toString());
                return summary;
            } finally { harness.stop("Demo closed"); }
        }
    }
    private static final class DemoWorld implements AgentHarness.Adapter {
        private int logs;
        public JsonObject observe() { JsonObject state = new JsonObject(); state.addProperty("simulated_logs", logs); return state; }
        public PlayerTasks.Task startSkill(PlayerDecision request) {
            if (!request.text().equals("collect_demo")) throw new IllegalArgumentException("Unknown simulated skill");
            return (state, last, receipt) -> logs < 2
                    ? PlayerTasks.Step.action(PlayerDecision.parse("{\"action\":\"MOVE\",\"forward\":1,\"ticks\":1}"))
                    : PlayerTasks.Step.done("Two simulated logs collected");
        }
        public void remember(JsonObject agenda) {}
        public void cancelAction() {}
        public void message(String stage, String text) {}
        PlayerEvidence evidence() {
            return new PlayerEvidence(logs, 64, 0, 0, 0, 0, 0, "none", "", "logs=" + logs, "", "", "",
                    Map.of("minecraft:oak_log", logs), Map.of(), Map.of(), logs);
        }
    }
}
