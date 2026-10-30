/* SPDX-License-Identifier: LGPL-3.0-only
 * Scheduling extracted from PlayerControl; origin: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import com.google.gson.*;
import dev.mcplayeragent.harness.PlayerProgress.Outcome;
import dev.mcplayeragent.mission.MissionRun;
import java.util.ArrayDeque;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.LongSupplier;

/** One session, driven only by its host thread. Model futures never mutate session state. */
public final class AgentHarness {
    /** Hard per-session ceilings, independent of model instructions and world transitions. */
    public record Limits(long maxRuntimeMillis, int maxModelRequests, int maxActions) {
        public Limits {
            if (maxRuntimeMillis <= 0 || maxModelRequests <= 0 || maxActions <= 0)
                throw new IllegalArgumentException("Session limits must be positive");
        }
    }
    public static final Limits DEFAULT_LIMITS = new Limits(TimeUnit.MINUTES.toMillis(20), 120, 2000);
    @FunctionalInterface public interface Planner {
        CompletableFuture<PlayerPlan> plan(JsonObject observation);
    }
    public interface Adapter {
        JsonObject observe();
        PlayerTasks.Task startSkill(PlayerDecision request);
        void remember(JsonObject agenda);
        void cancelAction();
        void message(String stage, String text);
    }
    private final String goal;
    private final Planner planner;
    private final Adapter adapter;
    private final MissionRun recording;
    private final LongSupplier clock;
    private final Limits limits;
    private final long started;
    private int requestsStarted, actionsIssued;
    private final PlayerProgress progress = new PlayerProgress();
    private final ArrayDeque<PlayerDecision> plan = new ArrayDeque<>();
    private final ArrayDeque<String> receipts = new ArrayDeque<>();
    private CompletableFuture<PlayerPlan> pending;
    private long sent, nextPlanning;
    private boolean running = true, reviewing, emergency;
    private int emergencyPriority;
    private PlayerTasks.Task task, suspended;
    private String taskName = "", suspendedName = "", phase = "", reason = "";
    private String receipt = "Takeover started; no action executed", latestOutcome = "";
    private JsonArray agenda = new JsonArray();
    private PlayerDecision action;
    private Outcome taskOutcome;
    private PlayerEvidence initialEvidence;
    private PlayerCondition goalCheck;

    public AgentHarness(String goal, JsonObject saved, Planner planner, Adapter adapter, MissionRun recording) {
        this(goal, saved, planner, adapter, recording, DEFAULT_LIMITS, System::nanoTime);
    }
    public AgentHarness(String goal, JsonObject saved, Planner planner, Adapter adapter, MissionRun recording, Limits limits) {
        this(goal, saved, planner, adapter, recording, limits, System::nanoTime);
    }
    AgentHarness(String goal, JsonObject saved, Planner planner, Adapter adapter, MissionRun recording, LongSupplier clock) {
        this(goal, saved, planner, adapter, recording, DEFAULT_LIMITS, clock);
    }
    AgentHarness(String goal, JsonObject saved, Planner planner, Adapter adapter, MissionRun recording, Limits limits, LongSupplier clock) {
        if (goal == null || goal.isBlank()) throw new IllegalArgumentException("Mission goal cannot be blank");
        this.goal = goal; this.planner = Objects.requireNonNull(planner); this.adapter = Objects.requireNonNull(adapter);
        this.recording = Objects.requireNonNull(recording); this.clock = Objects.requireNonNull(clock);
        this.limits = Objects.requireNonNull(limits); started = clock.getAsLong();
        restore(saved);
    }
    private void restore(JsonObject saved) {
        if (saved.has("goal") && goal.equals(saved.get("goal").getAsString())) {
            if (saved.has("phase")) phase = saved.get("phase").getAsString();
            if (saved.has("steps")) agenda = saved.getAsJsonArray("steps").deepCopy();
        }
    }
    public boolean running() { return running; }
    public String reason() { return reason; }
    public String taskName() { return taskName; }
    public boolean hasTask() { return task != null; }
    public boolean emergency() { return emergency; }
    public int priority() { return emergency ? emergencyPriority : task == null ? 0 : task.priority(); }
    public PlayerProgress progress() { return progress; }
    public PlayerCondition goalCheck() { return goalCheck; }
    public String phase() { return phase; }
    public PlayerDecision peekNext() { return plan.peekFirst(); }
    public void evidence(PlayerEvidence now) { if (initialEvidence == null && now != null) initialEvidence = now; }

    /** Returns each action once; the adapter must acknowledge it before another is issued. */
    public PlayerDecision tick(PlayerEvidence now) {
        if (!running) return null;
        evidence(now);
        try {
            if (!withinRuntime()) return null;
            consumeReply();
            if (!running) return null;
            PlayerDecision issued = null;
            if (action == null && task != null) issued = advance(now);
            if (running && action == null && task == null && !plan.isEmpty()) {
                PlayerDecision next = plan.removeFirst();
                if (next.action() == PlayerDecision.Kind.SKILL) {
                    task = Objects.requireNonNull(adapter.startSkill(next), "Skill factory returned null");
                    taskName = next.text(); taskOutcome = null;
                    recording.transition("SKILL_STARTED", taskName);
                    adapter.message("技能", "持续执行：" + taskName);
                    issued = advance(now);
                } else issued = action = next;
            }
            if (issued != null && actionsIssued >= limits.maxActions()) {
                exhaust("ACTIONS", limits.maxActions()); return null;
            }
            if (running && pending == null && !emergency && clock.getAsLong() >= nextPlanning
                    && (task != null || action == null && plan.isEmpty())) request(task != null);
            if (!running) return null;
            if (issued != null) actionsIssued++;
            return issued;
        } catch (RuntimeException error) {
            stop("任务调度失败：" + error.getMessage());
            adapter.message("错误", reason);
            return null;
        }
    }
    private void request(boolean review) {
        if (requestsStarted >= limits.maxModelRequests()) { exhaust("MODEL_REQUESTS", limits.maxModelRequests()); return; }
        JsonObject state = adapter.observe().deepCopy();
        for (var entry : context().entrySet()) state.add(entry.getKey(), entry.getValue());
        if (review) {
            JsonObject compact = new JsonObject();
            for (String key : java.util.List.of("goal", "phase", "agenda", "active_skill", "previous_receipt",
                    "execution_metrics", "execution_budget", "x", "y", "z", "health", "food", "air", "in_water", "inventory", "latest_outcome"))
                if (state.has(key)) compact.add(key, state.get(key));
            state = compact;
        }
        state.addProperty("review_only", review);
        reviewing = review; sent = clock.getAsLong(); nextPlanning = sent + TimeUnit.SECONDS.toNanos(5);
        if (!review) adapter.message("规划", "正在根据实际进度安排后续任务…");
        requestsStarted++;
        pending = Objects.requireNonNull(planner.plan(state), "Planner returned null").orTimeout(120, TimeUnit.SECONDS);
    }
    private void consumeReply() {
        if (pending == null || !pending.isDone()) return;
        var finished = pending; pending = null;
        boolean review = reviewing; reviewing = false;
        long millis = Math.max(0, TimeUnit.NANOSECONDS.toMillis(clock.getAsLong() - sent));
        progress.request(millis);
        PlayerPlan response;
        try { response = Objects.requireNonNull(finished.join(), "Empty model plan"); }
        catch (RuntimeException error) {
            recording.request(review, millis, false);
            String failure = PlayerModelConnection.error(error);
            if (review) {
                nextPlanning = clock.getAsLong() + TimeUnit.SECONDS.toNanos(5);
                adapter.message("进度", failure + "，当前技能继续执行");
            } else stop(failure);
            return;
        }
        recording.request(review, millis, true);
        recording.plan(response.phase(), response.actions().size(), review);
        if (!response.agenda().isEmpty()) agenda = response.agenda().deepCopy();
        if (!review && !response.phase().isBlank()) phase = response.phase();
        remember();
        if (review) { adapter.message("进度", response.summary()); return; }
        if (goalCheck == null) goalCheck = response.goalCheck();
        else if (response.goalCheck() != null && !goalCheck.equals(response.goalCheck()))
            adapter.message("验收", "保留本次任务已建立的验收条件；更换目标请开始新任务");
        plan.addAll(response.actions());
        adapter.message("计划", response.summary().isBlank() ? "接下来执行 " + plan.size() + " 个动作" : response.summary());
    }
    private PlayerDecision advance(PlayerEvidence now) {
        var step = task.next(now, taskOutcome, receipt); taskOutcome = null;
        if (step.action() != null) return action = step.action();
        var finished = task; task = null; finished.stopped();
        receipt = "skill=" + taskName + "; status=" + step.outcome() + "; " + step.detail();
        addReceipt(receipt); recording.transition("SKILL_FINISHED", receipt);
        adapter.message("技能反馈", receipt); remember();
        if (reviewing) { cancelPlanning(); nextPlanning = 0; }
        if (emergency) {
            emergency = false; emergencyPriority = 0;
            if (step.outcome() != Outcome.SUCCEEDED) { stop("未能安全脱险：" + step.detail()); return null; }
            task = suspended; taskName = suspendedName; suspended = null; suspendedName = "";
            if (task != null) { task.resumed(); adapter.message("恢复", "重新核验并继续 " + taskName); }
            nextPlanning = 0;
        } else {
            if (step.outcome() != Outcome.SUCCEEDED) plan.clear();
            task = null; taskName = "";
        }
        return null;
    }
    public Outcome completion(PlayerEvidence now) {
        if (goalCheck == null) return Outcome.SENT_UNCONFIRMED;
        return now != null && initialEvidence != null && goalCheck.matches(now, initialEvidence)
                ? Outcome.SUCCEEDED : Outcome.FAILED;
    }
    public static String completionDetail(Outcome result) {
        return switch (result) {
            case SUCCEEDED -> "Goal condition verified from observed state";
            case SENT_UNCONFIRMED -> "Model declared done without a verifiable goal condition";
            default -> "GOAL_NOT_MET: completion predicate is false";
        };
    }
    public void complete(Outcome outcome, String detail, String actualReceipt, String startKey, PlayerEvidence now) {
        if (!running || action == null) throw new IllegalStateException("No action awaiting a receipt");
        if (!withinRuntime()) return;
        PlayerDecision finished = action;
        if (finished.action() == PlayerDecision.Kind.DONE) { outcome = completion(now); detail = completionDetail(outcome); }
        boolean failed = outcome == Outcome.FAILED || outcome == Outcome.NO_PROGRESS || outcome == Outcome.TIMED_OUT;
        progress.record(finished.toString(), startKey, outcome, detail); latestOutcome = outcome.name();
        receipt = finished.action() == PlayerDecision.Kind.DONE ? detail : actualReceipt;
        addReceipt(receipt);
        recording.step(finished.action().name(), taskName, MissionRun.Result.valueOf(outcome.name()), detail, now == null ? -1 : now.serverTick());
        action = null;
        if (task != null) taskOutcome = outcome;
        else if (failed) plan.clear();
        if (finished.action() == PlayerDecision.Kind.DONE && !failed) {
            recording.completed(outcome == Outcome.SUCCEEDED, detail);
            stop(outcome == Outcome.SUCCEEDED ? "目标已按验收条件完成" : "模型报告完成，缺少验收条件，请核对游戏状态");
        } else if (failed && task == null && progress.blocked(finished.toString(), startKey))
            stop("同一状态下重复失败两次，已停止无效重试；请调整目标或方法");
    }
    public void interrupt(PlayerTasks.Interruption urgent) {
        if (!running || urgent.priority() <= priority()) return;
        if (!emergency) { suspended = task; suspendedName = taskName; if (task != null) task.paused(); else plan.clear(); }
        else if (task != null) task.stopped();
        cancelPlanning(); adapter.cancelAction(); action = null;
        receipt = "INTERRUPTED: " + urgent.reason(); addReceipt(receipt);
        recording.transition("EMERGENCY", urgent.reason());
        task = urgent.task(); taskName = "应急：" + urgent.reason(); taskOutcome = null;
        emergency = true; emergencyPriority = urgent.priority();
        adapter.message("遇险", urgent.reason() + "，暂停原任务");
    }
    public void resetContext(JsonObject saved, String dimension) {
        releaseTasks(); cancelPlanning(); adapter.cancelAction(); action = null; plan.clear();
        initialEvidence = null; goalCheck = null; phase = ""; agenda = new JsonArray(); nextPlanning = 0;
        restore(saved); recording.transition("WORLD_CHANGED", dimension);
        receipt = "Player respawned or changed dimension; reset local progress baseline"; addReceipt(receipt);
    }
    public void stop(String why) {
        if (!running) return;
        running = false; reason = why;
        try { releaseTasks(); }
        finally { cancelPlanning(); plan.clear(); action = null; recording.interrupted(why); adapter.cancelAction(); }
    }
    private void releaseTasks() {
        var current = task; var paused = suspended;
        task = suspended = null; taskName = suspendedName = ""; taskOutcome = null; emergency = false; emergencyPriority = 0;
        try { if (current != null) current.stopped(); }
        finally { if (paused != null && paused != current) paused.stopped(); }
    }
    private void cancelPlanning() { var old = pending; pending = null; reviewing = false; if (old != null) old.cancel(true); }
    private long elapsedMillis() { return Math.max(0, TimeUnit.NANOSECONDS.toMillis(clock.getAsLong() - started)); }
    private boolean withinRuntime() {
        if (elapsedMillis() < limits.maxRuntimeMillis()) return true;
        exhaust("RUNTIME_MS", limits.maxRuntimeMillis()); return false;
    }
    private void exhaust(String budget, long maximum) {
        stop("BUDGET_EXHAUSTED: " + budget + "; limit=" + maximum + "; 已达到任务上限，请缩小目标后重新开始");
        adapter.message("停止", reason);
    }
    private void addReceipt(String value) { receipts.addLast(value); while (receipts.size() > 12) receipts.removeFirst(); }
    public JsonObject memory() {
        JsonObject saved = new JsonObject(); saved.addProperty("goal", goal); saved.addProperty("phase", phase);
        saved.add("steps", agenda.deepCopy()); JsonArray history = new JsonArray(); receipts.forEach(history::add);
        saved.add("verified_receipts", history); return saved;
    }
    private void remember() { adapter.remember(memory()); }
    public JsonObject context() {
        JsonObject state = new JsonObject(); state.addProperty("goal", goal); state.addProperty("phase", phase);
        state.add("agenda", agenda.deepCopy()); state.addProperty("active_skill", taskName);
        state.addProperty("emergency_active", emergency); state.addProperty("suspended_skill", suspendedName);
        state.addProperty("previous_receipt", receipt); state.addProperty("latest_outcome", latestOutcome);
        if (goalCheck != null) state.add("goal_check", goalCheck.json());
        JsonObject budget = new JsonObject(); budget.addProperty("max_runtime_ms", limits.maxRuntimeMillis());
        budget.addProperty("elapsed_ms", elapsedMillis()); budget.addProperty("max_model_requests", limits.maxModelRequests());
        budget.addProperty("requests_started", requestsStarted); budget.addProperty("max_actions", limits.maxActions());
        budget.addProperty("actions_issued", actionsIssued); state.add("execution_budget", budget);
        JsonObject metrics = new JsonObject(); metrics.addProperty("requests", progress.requests()); metrics.addProperty("steps", progress.steps());
        metrics.addProperty("success", progress.succeeded()); metrics.addProperty("failed", progress.failed()); metrics.addProperty("skipped", progress.skipped());
        metrics.addProperty("working_ticks", progress.activeTicks()); metrics.addProperty("idle_ticks", progress.idleTicks()); state.add("execution_metrics", metrics);
        JsonArray history = new JsonArray(); receipts.forEach(history::add); state.add("recent_receipts", history);
        JsonArray failures = new JsonArray(); progress.recentFailures().forEach(failures::add); state.add("recent_failures", failures);
        return state;
    }
}
