/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.harness;

import com.google.gson.*;
import dev.mcplayeragent.mission.MissionRun;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import static org.junit.jupiter.api.Assertions.*;

class AgentHarnessTest {
    @TempDir Path temp;
    private final List<MissionRun> recordings = new ArrayList<>();
    private static final String GOAL = "Collect eight logs";
    private static PlayerEvidence frame(int count) { return PlayerConditionTest.frame(0, 0, "minecraft:air", count); }
    private static PlayerPlan plan(String actions) { return PlayerPlan.parse("{\"goal_check\":{\"type\":\"item_count\",\"item\":\"minecraft:oak_log\",\"count\":8},\"actions\":" + actions + "}"); }
    private MissionRun record() {
        var run = MissionRun.start(temp, "world", "overworld", GOAL, "test", "fixture"); recordings.add(run); return run;
    }
    @AfterEach void flushRecordingsBeforeRemovingTemporaryWorlds() throws Exception {
        for (var run : recordings) { run.close(); run.flushed().get(5, TimeUnit.SECONDS); }
    }
    private static class Host implements AgentHarness.Adapter {
        final List<String> messages = new ArrayList<>();
        JsonObject memory = new JsonObject(); int canceled;
        PlayerTasks.Task skill = (state, last, receipt) -> PlayerTasks.Step.action(PlayerDecision.parse("{\"action\":\"WAIT\"}"));
        public JsonObject observe() { return new JsonObject(); }
        public PlayerTasks.Task startSkill(PlayerDecision request) { return skill; }
        public void remember(JsonObject value) { memory = value.deepCopy(); }
        public void cancelAction() { canceled++; }
        public void message(String stage, String text) { messages.add(stage + ":" + text); }
    }
    @Test void headlessDemoRunsTheFullPlanSkillReceiptAndAcceptanceLoop() throws Exception {
        var result = HarnessMain.demo(temp);
        assertTrue(result.get("simulation").getAsBoolean());
        assertEquals("VERIFIED", result.get("state").getAsString());
        assertEquals(3, result.get("steps").getAsInt());
        assertEquals(1, result.get("model_requests").getAsInt());
        assertTrue(java.nio.file.Files.readString(Path.of(result.get("record_directory").getAsString()).resolve("events.jsonl")).contains("SKILL_FINISHED"));
    }
    @Test void doneUntilAndAnAdapterSuccessCannotBypassTheMissionGoal() {
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> CompletableFuture.completedFuture(plan("[{\"action\":\"DONE\",\"until\":{\"type\":\"screen\",\"screen\":\"none\"}}]")), new Host(), run);
            assertNull(h.tick(frame(0)));
            assertEquals(PlayerDecision.Kind.DONE, h.tick(frame(0)).action());
            h.complete(PlayerProgress.Outcome.SUCCEEDED, "until matched", "claimed success", "same", frame(0));
            assertTrue(h.running()); assertEquals(1, h.progress().failed());
            assertEquals("RUNNING", run.snapshot().get("state").getAsString()); h.stop("test end");
        }
    }
    @Test void doneWithoutAcceptanceIsExplicitlyUnverified() {
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> CompletableFuture.completedFuture(PlayerPlan.parse("{\"action\":\"DONE\"}")), new Host(), run);
            h.tick(frame(8)); h.tick(frame(8));
            h.complete(PlayerProgress.Outcome.SUCCEEDED, "claimed", "claimed", "", frame(8));
            assertFalse(h.running()); assertEquals("UNVERIFIED", run.snapshot().get("state").getAsString());
        }
    }
    @Test void actionIsIssuedOnceUntilItsReceiptArrives() {
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> CompletableFuture.completedFuture(plan("[{\"action\":\"WAIT\"},{\"action\":\"DONE\"}]")), new Host(), run);
            h.tick(frame(0)); assertEquals(PlayerDecision.Kind.WAIT, h.tick(frame(0)).action());
            assertNull(h.tick(frame(0)));
            h.complete(PlayerProgress.Outcome.SUCCEEDED, "waited", "waited", "", frame(8));
            assertEquals(PlayerDecision.Kind.DONE, h.tick(frame(8)).action()); h.stop("test end");
        }
    }
    @Test void backgroundReviewCannotSteerAnActiveSkillOrReplaceItsAcceptance() {
        AtomicLong clock = new AtomicLong(); List<CompletableFuture<PlayerPlan>> calls = new ArrayList<>();
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> { var future = new CompletableFuture<PlayerPlan>(); calls.add(future); return future; }, new Host(), run, clock::get);
            h.tick(frame(0)); calls.getFirst().complete(plan("[{\"action\":\"SKILL\",\"text\":\"collect\"}]"));
            assertEquals(PlayerDecision.Kind.WAIT, h.tick(frame(0)).action());
            clock.set(TimeUnit.SECONDS.toNanos(6)); assertNull(h.tick(frame(0))); assertEquals(2, calls.size());
            calls.get(1).complete(PlayerPlan.parse("{\"goal_check\":{\"type\":\"item_count\",\"item\":\"minecraft:oak_log\",\"count\":0},\"actions\":[{\"action\":\"DROP\"}]}"));
            assertNull(h.tick(frame(0))); assertTrue(h.hasTask()); assertEquals(8, h.goalCheck().value());
            h.complete(PlayerProgress.Outcome.SUCCEEDED, "wait", "wait", "", frame(0));
            assertEquals(PlayerDecision.Kind.WAIT, h.tick(frame(0)).action()); h.stop("test end");
        }
    }
    @Test void interruptedSkillResumesAndLatePlanningDoesNotGainControl() {
        Host host = new Host(); int[] lifecycle = new int[2]; AtomicLong clock = new AtomicLong();
        host.skill = new PlayerTasks.Task() {
            public PlayerTasks.Step next(PlayerEvidence state, PlayerProgress.Outcome last, String receipt) { return PlayerTasks.Step.action(PlayerDecision.parse("{\"action\":\"WAIT\"}")); }
            public void paused() { lifecycle[0]++; }
            public void resumed() { lifecycle[1]++; }
        };
        List<CompletableFuture<PlayerPlan>> calls = new ArrayList<>();
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> { var future = new CompletableFuture<PlayerPlan>(); calls.add(future); return future; }, host, run, clock::get);
            h.tick(frame(0)); calls.getFirst().complete(plan("[{\"action\":\"SKILL\",\"text\":\"collect\"}]")); h.tick(frame(0));
            clock.set(TimeUnit.SECONDS.toNanos(6)); h.tick(frame(0));
            h.interrupt(new PlayerTasks.Interruption(40, "water", (s, last, receipt) -> PlayerTasks.Step.done("safe")));
            assertTrue(calls.get(1).isCancelled());
            assertFalse(calls.get(1).complete(plan("[{\"action\":\"DROP\"}]")));
            assertNull(h.tick(frame(0))); assertFalse(h.emergency()); assertEquals(1, lifecycle[0]); assertEquals(1, lifecycle[1]);
            assertEquals(PlayerDecision.Kind.WAIT, h.tick(frame(0)).action()); h.stop("test end");
        }
    }
    @Test void stoppingSessionCancelsPlanningAndIgnoresLateReplies() {
        var future = new CompletableFuture<PlayerPlan>(); Host host = new Host();
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> future, host, run);
            h.tick(frame(0)); h.stop("manual");
            assertTrue(future.isCancelled()); assertNull(h.tick(frame(0))); assertEquals(1, host.canceled);
            assertEquals("INTERRUPTED", run.snapshot().get("state").getAsString());
        }
    }
    @Test void independentSessionsNeverSharePlansOrGoals() {
        try (var a = record(); var b = record()) {
            var first = new AgentHarness(GOAL, new JsonObject(), s -> CompletableFuture.completedFuture(plan("[{\"action\":\"DONE\"}]")), new Host(), a);
            var second = new AgentHarness("Other goal", new JsonObject(), s -> new CompletableFuture<>(), new Host(), b);
            first.tick(frame(8)); second.tick(frame(0)); first.tick(frame(8));
            first.complete(PlayerProgress.Outcome.SUCCEEDED, "", "", "", frame(8));
            assertTrue(second.running()); assertNull(second.goalCheck()); assertEquals(0, second.progress().steps()); second.stop("test end");
        }
    }
    @Test void failedPlannerStopsBeforeAnyActionAndRecordsFailure() {
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> CompletableFuture.failedFuture(new IllegalArgumentException("bad JSON")), new Host(), run);
            h.tick(frame(0)); assertNull(h.tick(frame(0))); assertFalse(h.running());
            assertEquals(0, h.progress().steps()); assertEquals("INTERRUPTED", run.snapshot().get("state").getAsString());
            assertTrue(h.reason().contains("模型回复格式无效")); assertFalse(h.reason().contains("bad JSON"));
        }
    }
    @Test void laterPlansCannotWeakenEstablishedGoalAcceptance() {
        AtomicLong clock = new AtomicLong(); int[] requests = {0};
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> CompletableFuture.completedFuture(requests[0]++ == 0
                    ? plan("[{\"action\":\"WAIT\"}]")
                    : PlayerPlan.parse("{\"goal_check\":{\"type\":\"item_count\",\"item\":\"minecraft:oak_log\",\"count\":0},\"actions\":[{\"action\":\"DONE\"}]}")), new Host(), run, clock::get);
            h.tick(frame(0)); h.tick(frame(0)); h.complete(PlayerProgress.Outcome.SUCCEEDED, "wait", "wait", "", frame(0));
            clock.set(TimeUnit.SECONDS.toNanos(6)); h.tick(frame(0)); assertEquals(PlayerDecision.Kind.DONE, h.tick(frame(0)).action());
            assertEquals(8, h.goalCheck().value()); assertEquals(PlayerProgress.Outcome.FAILED, h.completion(frame(0))); h.stop("test end");
        }
    }
    @Test void contextResetDiscardsOldActionsEvidenceAndPendingReview() {
        AtomicLong clock = new AtomicLong(); List<CompletableFuture<PlayerPlan>> requests = new ArrayList<>(); Host host = new Host();
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> { var future = new CompletableFuture<PlayerPlan>(); requests.add(future); return future; }, host, run, clock::get);
            h.tick(frame(8)); requests.getFirst().complete(plan("[{\"action\":\"SKILL\",\"text\":\"collect\"},{\"action\":\"DROP\"}]")); h.tick(frame(8));
            clock.set(TimeUnit.SECONDS.toNanos(6)); h.tick(frame(8));
            h.resetContext(new JsonObject(), "nether");
            assertTrue(requests.get(1).isCancelled()); assertFalse(h.hasTask()); assertNull(h.peekNext()); assertNull(h.goalCheck());
            assertNull(h.tick(frame(0))); assertEquals(3, requests.size()); h.stop("test end");
        }
    }
    @Test void modelFailureDuringReviewLeavesTheCurrentSkillRunning() {
        AtomicLong clock = new AtomicLong(); int[] calls = {0}; Host host = new Host();
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> calls[0]++ == 0
                    ? CompletableFuture.completedFuture(plan("[{\"action\":\"SKILL\",\"text\":\"collect\"}]"))
                    : CompletableFuture.failedFuture(new TimeoutException()), host, run, clock::get);
            h.tick(frame(0)); h.tick(frame(0)); clock.set(TimeUnit.SECONDS.toNanos(6)); h.tick(frame(0)); h.tick(frame(0));
            assertTrue(h.running()); assertTrue(h.hasTask()); assertEquals(2, h.progress().requests());
            assertTrue(host.messages.stream().anyMatch(m -> m.contains("当前技能继续执行"))); h.stop("test end");
        }
    }
    @Test void sessionLimitsMustBePositive() {
        assertThrows(IllegalArgumentException.class, () -> new AgentHarness.Limits(0, 1, 1));
        assertThrows(IllegalArgumentException.class, () -> new AgentHarness.Limits(1, 0, 1));
        assertThrows(IllegalArgumentException.class, () -> new AgentHarness.Limits(1, 1, -1));
    }
    @Test void runtimeBudgetCancelsPendingPlanningAndPersistsAnInterruptedResult() throws Exception {
        AtomicLong clock = new AtomicLong(); Host host = new Host(); var future = new CompletableFuture<PlayerPlan>();
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> future, host, run, new AgentHarness.Limits(1000, 2, 2), clock::get);
            h.tick(frame(0)); clock.set(TimeUnit.MILLISECONDS.toNanos(999)); h.tick(frame(0));
            assertTrue(h.running()); clock.set(TimeUnit.SECONDS.toNanos(1)); assertNull(h.tick(frame(0)));
            assertFalse(h.running()); assertTrue(future.isCancelled()); assertEquals(1, host.canceled);
            assertFalse(future.complete(plan("[{\"action\":\"DONE\"}]")));
            run.flushed().get(5, TimeUnit.SECONDS);
            var saved = JsonParser.parseString(java.nio.file.Files.readString(run.directory().resolve("summary.json"))).getAsJsonObject();
            assertEquals("INTERRUPTED", saved.get("state").getAsString());
            assertTrue(saved.get("end_reason").getAsString().contains("BUDGET_EXHAUSTED: RUNTIME_MS"));
        }
    }
    @Test void lateDoneReceiptCannotTurnAnExpiredSessionIntoVerifiedSuccess() {
        AtomicLong clock = new AtomicLong();
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> CompletableFuture.completedFuture(plan("[{\"action\":\"DONE\"}]")),
                    new Host(), run, new AgentHarness.Limits(1000, 1, 1), clock::get);
            h.tick(frame(8)); assertEquals(PlayerDecision.Kind.DONE, h.tick(frame(8)).action());
            clock.set(TimeUnit.SECONDS.toNanos(1));
            h.complete(PlayerProgress.Outcome.SUCCEEDED, "late", "late", "", frame(8));
            assertFalse(h.running()); assertEquals("INTERRUPTED", run.snapshot().get("state").getAsString());
        }
    }
    @Test void actionBudgetStopsAnEndlessSuccessfulSkillAndReleasesItsInput() {
        AtomicLong clock = new AtomicLong(); Host host = new Host(); int[] stopped = {0};
        host.skill = new PlayerTasks.Task() {
            public PlayerTasks.Step next(PlayerEvidence state, PlayerProgress.Outcome last, String receipt) {
                return PlayerTasks.Step.action(PlayerDecision.parse("{\"action\":\"WAIT\"}"));
            }
            public void stopped() { stopped[0]++; }
        };
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> CompletableFuture.completedFuture(plan("[{\"action\":\"SKILL\",\"text\":\"collect\"}]")),
                    host, run, new AgentHarness.Limits(60_000, 10, 2), clock::get);
            h.tick(frame(0));
            for (int i = 0; i < 2; i++) {
                assertEquals(PlayerDecision.Kind.WAIT, h.tick(frame(0)).action());
                h.complete(PlayerProgress.Outcome.SUCCEEDED, "waited", "no world change", "same", frame(0));
            }
            assertNull(h.tick(frame(0))); assertFalse(h.running());
            assertEquals(2, h.progress().steps()); assertEquals(1, stopped[0]); assertEquals(1, host.canceled);
            assertTrue(h.reason().contains("BUDGET_EXHAUSTED: ACTIONS"));
        }
    }
    @Test void requestBudgetIncludesReviewsAndDoesNotDeliverAnActionAfterStopping() {
        AtomicLong clock = new AtomicLong(); Host host = new Host(); int[] calls = {0};
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> {
                calls[0]++; return CompletableFuture.completedFuture(plan("[{\"action\":\"SKILL\",\"text\":\"collect\"}]"));
            }, host, run, new AgentHarness.Limits(60_000, 2, 10), clock::get);
            h.tick(frame(0)); h.tick(frame(0)); clock.set(TimeUnit.SECONDS.toNanos(6));
            assertNull(h.tick(frame(0))); assertEquals(2, calls[0]); h.tick(frame(0));
            h.complete(PlayerProgress.Outcome.SUCCEEDED, "wait", "wait", "", frame(0));
            clock.set(TimeUnit.SECONDS.toNanos(12)); assertNull(h.tick(frame(0)));
            assertFalse(h.running()); assertEquals(2, calls[0]);
            assertEquals(1, h.context().getAsJsonObject("execution_budget").get("actions_issued").getAsInt());
            assertTrue(h.reason().contains("BUDGET_EXHAUSTED: MODEL_REQUESTS"));
        }
    }
    @Test void canceledRequestsStillConsumeBudgetAcrossWorldTransitions() {
        AtomicLong clock = new AtomicLong(); var future = new CompletableFuture<PlayerPlan>(); int[] calls = {0};
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> { calls[0]++; return future; }, new Host(), run,
                    new AgentHarness.Limits(60_000, 1, 10), clock::get);
            h.tick(frame(0)); h.resetContext(new JsonObject(), "nether"); assertTrue(future.isCancelled());
            assertNull(h.tick(frame(0))); assertEquals(1, calls[0]); assertFalse(h.running());
            assertTrue(h.reason().contains("MODEL_REQUESTS"));
        }
    }
    @Test void emergencyAndWorldResetDoNotExtendTheSessionDeadline() {
        AtomicLong clock = new AtomicLong(); Host host = new Host(); int[] stopped = {0};
        PlayerTasks.Task escape = new PlayerTasks.Task() {
            public PlayerTasks.Step next(PlayerEvidence state, PlayerProgress.Outcome last, String receipt) {
                return PlayerTasks.Step.action(PlayerDecision.parse("{\"action\":\"WAIT\"}"));
            }
            public void stopped() { stopped[0]++; }
        };
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> new CompletableFuture<>(), host, run,
                    new AgentHarness.Limits(1000, 5, 5), clock::get);
            h.tick(frame(0)); clock.set(TimeUnit.MILLISECONDS.toNanos(900)); h.resetContext(new JsonObject(), "nether");
            h.interrupt(new PlayerTasks.Interruption(40, "water", escape));
            assertEquals(PlayerDecision.Kind.WAIT, h.tick(frame(0)).action());
            clock.set(TimeUnit.SECONDS.toNanos(1)); assertNull(h.tick(frame(0)));
            assertFalse(h.running()); assertEquals(1, stopped[0]); assertTrue(h.reason().contains("RUNTIME_MS"));
        }
    }
    @Test void lastPermittedActionAndRequestCanStillCompleteTheGoal() {
        AtomicLong clock = new AtomicLong();
        try (var run = record()) {
            var h = new AgentHarness(GOAL, new JsonObject(), s -> CompletableFuture.completedFuture(plan("[{\"action\":\"DONE\"}]")),
                    new Host(), run, new AgentHarness.Limits(1000, 1, 1), clock::get);
            h.tick(frame(8)); assertEquals(PlayerDecision.Kind.DONE, h.tick(frame(8)).action());
            h.complete(PlayerProgress.Outcome.SUCCEEDED, "", "", "", frame(8));
            assertEquals("VERIFIED", run.snapshot().get("state").getAsString());
            var budget = h.context().getAsJsonObject("execution_budget");
            assertEquals(1, budget.get("requests_started").getAsInt()); assertEquals(1, budget.get("actions_issued").getAsInt());
        }
    }
    @Test void exhaustedBudgetsAreIsolatedBetweenSessions() {
        AtomicLong clock = new AtomicLong();
        try (var a = record(); var b = record()) {
            var first = new AgentHarness(GOAL, new JsonObject(), s -> new CompletableFuture<>(), new Host(), a,
                    new AgentHarness.Limits(1, 1, 1), clock::get);
            var second = new AgentHarness(GOAL, new JsonObject(), s -> new CompletableFuture<>(), new Host(), b,
                    new AgentHarness.Limits(1000, 1, 1), clock::get);
            first.tick(frame(0)); second.tick(frame(0)); clock.set(TimeUnit.MILLISECONDS.toNanos(1));
            first.tick(frame(0)); second.tick(frame(0)); assertFalse(first.running()); assertTrue(second.running());
            assertEquals("RUNNING", b.snapshot().get("state").getAsString()); second.stop("test end");
        }
    }
}
