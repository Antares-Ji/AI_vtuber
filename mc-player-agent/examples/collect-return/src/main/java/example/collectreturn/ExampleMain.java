/* SPDX-License-Identifier: LGPL-3.0-only */
package example.collectreturn;

import com.google.gson.*;
import dev.mcplayeragent.harness.*;
import dev.mcplayeragent.mission.MissionRun;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;

/** Explicit simulation: fake native skills and receipts, real extension loading and harness lifecycle. */
public final class ExampleMain {
    private ExampleMain() {}
    public static void main(String[] args) throws Exception {
        if (args.length > 2) throw new IllegalArgumentException("Expected: [output-directory] [profile.json]");
        var profile = AgentProfile.defaults();
        if (args.length == 2) {
            try (var reader = java.nio.file.Files.newBufferedReader(Path.of(args[1]))) {
                profile = AgentProfile.parse(JsonParser.parseReader(reader).getAsJsonObject());
            }
        }
        var result = demo(Path.of(args.length > 0 ? args[0] : "build/demo"), profile);
        System.out.println(new GsonBuilder().setPrettyPrinting().create().toJson(result));
        if (!result.get("state").getAsString().equals("VERIFIED")) throw new IllegalStateException("Example did not verify its goal");
    }
    public static JsonObject demo(Path output, AgentProfile profile) throws Exception {
        var world = new SimulatedWorld(profile);
        try (var recording = MissionRun.start(output, "simulation", "example", "Collect two logs and return", "fixture", "deterministic")) {
            recording.configuration(profile.fingerprint(), world.skills.catalog());
            var harness = new AgentHarness("Collect two logs and return", new JsonObject(), state -> CompletableFuture.completedFuture(PlayerPlan.parse("""
                    {"goal_check":{"type":"position","x":0.5,"y":64,"z":0.5,"tolerance":0.65},
                     "actions":[{"action":"SKILL","text":"example:collect_return","args":{"item":"minecraft:oak_log","count":2,"x":0,"y":64,"z":0}},{"action":"DONE"}]}
                    """)), world, recording, profile.limits());
            try {
                for (int tick = 0; tick < 100 && harness.running(); tick++) {
                    var before = world.evidence(); var action = harness.tick(before);
                    if (action == null) continue;
                    switch (action.action()) {
                        case WAIT -> world.logs = 2;
                        case MOVE -> world.x = .5;
                        case DONE -> {}
                        default -> throw new IllegalStateException("Unexpected simulated action: " + action.action());
                    }
                    harness.complete(PlayerProgress.Outcome.SUCCEEDED, "Simulated receipt", "simulated", before.stableKey(), world.evidence());
                }
                if (harness.running()) harness.stop("Example exceeded 100 simulation ticks");
                recording.flushed().get(5, TimeUnit.SECONDS);
                JsonObject result = recording.snapshot(); result.addProperty("simulation", true);
                result.addProperty("record_directory", recording.directory().toAbsolutePath().toString()); return result;
            } finally { harness.stop("Example closed"); }
        }
    }
    private static final class SimulatedWorld implements AgentHarness.Adapter {
        private final SkillRegistry skills = new SkillRegistry();
        private int logs;
        private double x = 8;
        SimulatedWorld(AgentProfile profile) {
            skills.register("minecraft:pickup_items", "fixture", "Fake pickup", args -> (state, last, receipt) ->
                    logs >= 2 ? PlayerTasks.Step.done("Simulated pickup") : PlayerTasks.Step.action(PlayerDecision.parse("{\"action\":\"WAIT\",\"ticks\":1}")));
            skills.register("minecraft:navigate", "fixture", "Fake navigation", args -> (state, last, receipt) ->
                    x == .5 ? PlayerTasks.Step.done("Simulated return") : PlayerTasks.Step.action(PlayerDecision.parse("{\"action\":\"MOVE\",\"ticks\":1,\"forward\":1}")));
            for (var provider : ServiceLoader.load(SkillProvider.class)) provider.register(skills);
            skills.seal(profile.enabledSkills());
        }
        public JsonObject observe() { JsonObject result = new JsonObject(); result.add("available_skills", skills.catalog()); return result; }
        public PlayerTasks.Task startSkill(PlayerDecision request) { return skills.start(request); }
        public void remember(JsonObject agenda) {}
        public void cancelAction() {}
        public void message(String stage, String text) {}
        PlayerEvidence evidence() {
            return new PlayerEvidence(x, 64, .5, 0, 0, 0, 0, "none", "", "logs=" + logs, "", "", "",
                    Map.of("minecraft:oak_log", logs), Map.of(), Map.of(), logs);
        }
    }
}
