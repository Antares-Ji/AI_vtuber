/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import com.google.gson.JsonObject;
import java.util.Objects;
import java.util.function.Supplier;
import java.util.function.Consumer;

/** Content supplies resumable tasks; the controller remains the sole owner of native inputs. */
public final class PlayerTasks {
    public interface Task {
        Step next(PlayerEvidence state, PlayerProgress.Outcome last, String receipt);
        default void resumed() {}
        default void paused() {}
        default void stopped() {}
        default int priority() { return 0; }
    }
    public record Interruption(int priority,String reason,Task task) {}
    public record Step(PlayerDecision action, PlayerProgress.Outcome outcome, String detail) {
        public static Step action(PlayerDecision action) { return new Step(action, null, ""); }
        public static Step done(String detail) { return new Step(null, PlayerProgress.Outcome.SUCCEEDED, detail); }
        public static Step failed(String detail) { return new Step(null, PlayerProgress.Outcome.FAILED, detail); }
    }
    private final SkillRegistry skills;
    private final Supplier<JsonObject> observer;
    private final Consumer<JsonObject> memory;
    private final Supplier<Interruption> emergencies;
    private final Runnable stuck;
    public PlayerTasks(SkillRegistry skills, Supplier<JsonObject> observer, Consumer<JsonObject> memory,
                       Supplier<Interruption> emergencies, Runnable stuck) {
        this.skills = Objects.requireNonNull(skills); this.observer = Objects.requireNonNull(observer);
        this.memory = Objects.requireNonNull(memory); this.emergencies = Objects.requireNonNull(emergencies);
        this.stuck = Objects.requireNonNull(stuck);
    }
    public Task start(PlayerDecision request) { return skills.start(request); }
    public JsonObject observe() { return observer.get(); }
    public void remember(JsonObject agenda) { memory.accept(agenda); }
    public Interruption emergency() { return emergencies.get(); }
    public void movementFailed() { stuck.run(); }
    public com.google.gson.JsonArray catalog() { return skills.catalog(); }
}
