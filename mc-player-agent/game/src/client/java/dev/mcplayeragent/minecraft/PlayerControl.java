/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.minecraft;

import dev.mcplayeragent.harness.ModelTransport;
import dev.mcplayeragent.harness.AgentHarness;
import dev.mcplayeragent.harness.AgentProfile;
import dev.mcplayeragent.harness.SkillProvider;
import dev.mcplayeragent.skills.SurvivalPlayerTasks;
import dev.mcplayeragent.minecraft.AgentCredentials;
import dev.mcplayeragent.minecraft.AgentPaths;
import dev.mcplayeragent.minecraft.PlayerAccess;
import dev.mcplayeragent.harness.PlayerDecision;
import dev.mcplayeragent.harness.PlayerPlan;
import dev.mcplayeragent.harness.PlayerCondition;
import dev.mcplayeragent.harness.PlayerEvidence;
import dev.mcplayeragent.harness.PlayerProgress;
import dev.mcplayeragent.harness.PlayerContinuity;
import dev.mcplayeragent.harness.PlayerTasks;
import dev.mcplayeragent.harness.PlayerProgress.Outcome;
import java.util.Set;
import java.util.HashSet;
import dev.mcplayeragent.harness.PlayerModelConnection;
import dev.mcplayeragent.harness.PlayerModelConnection.Backend;
import com.google.gson.*;
import net.minecraft.client.CameraType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.Input;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.util.Mth;
import net.minecraft.world.phys.*;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Client-owned native controls; all callbacks are marshalled to the client thread. */
public final class PlayerControl {
    private static final Logger LOG = LoggerFactory.getLogger("mcplayeragent");
    private static final ModelTransport HTTP = new ModelTransport();
    private static final String KEY_SERVICE = "player-deepseek";
    private static final String PROMPT = """
            You operate the signed-in Minecraft Java player from structured game observations.
            Follow the user's goal and optional instructions. You have unrestricted native game actions;
            actual server permissions, reach, inventory, recipe and physics requirements still apply.
            Respond ONLY with JSON: {"summary":"先朝向目标，方便接下来交互。","actions":[{"action":"LOOK","yaw":0,"pitch":0,"ticks":1}]}.
            summary is a short public explanation of what you will do and the main reason, in the
            user's language (one sentence, preferably under 80 Chinese characters). Do not include
            private reasoning, hidden deliberation or scratch work. Only give the concise decision summary.
            Optional root fields: phase (current task stage) and goal_check (an observable completion condition).
            Optional action fields: until (completion condition), requires (precondition).
            Conditions: {"type":"position","x":1,"y":64,"z":3,"tolerance":0.35},
            {"type":"distance","value":4}, {"type":"block","x":1,"y":63,"z":3,"block":"minecraft:air"},
            {"type":"item_count","item":"minecraft:oak_log","count":8}, {"type":"menu","value":0},
            {"type":"screen","screen":"none"}, {"type":"yaw","value":180,"tolerance":1}.
            MOVE with until=position is locally steered toward the destination; it is not a pathfinder.
            Position y is feet height. item_count supports op=gte (default), lte or eq.
            Use reachable short waypoints. ticks is the work deadline; LOOK turns smoothly and completes
            when aligned. BREAK/PLACE and inventory changes wait for authoritative server confirmation.
            Use goal_check to verify DONE. On NO_PROGRESS/FAILED, choose another method; do not repeat
            identical failed actions in unchanged state. Keep phase consistent until its objective is achieved.
            Return one action or a sequence; observe again after the sequence. Use short sequences when
            new state, an opened menu or a changed target is needed. All fields except action are optional.
            Native controls: INPUT / MOVE / WAIT / LOOK use ticks (default 20, 20 ticks per second),
            forward [-1,1], strafe [-1,1], jump, sneak, sprint, attack, use (boolean), slot [0,8].
            These input fields may combine on any action. Respect execution_budget and stop when the host ends the session. Omitted yaw/pitch/slot
            preserve their current values. Absolute yaw: 0 south, +90 west, -90 east, +/-180 north;
            pitch [-90,90], positive looks down. Strafe +1 means left. Keep ticks responsive to feedback.
            BREAK holds mining on one crosshair block until it changes or ticks expire. Use >=100 ticks
            for hand-mining wood; partial mining progress resets on release. INPUT with attack=true can
            keep mining changing crosshair targets or attack entities. ATTACK attacks the crosshair entity.
            USE / PLACE right-click the crosshair entity/block or use the held item; offhand=true selects
            the offhand. USE holds an active bow/food/shield until ticks expire, releasing at the end.
            DROP drops selected item (all=true drops the stack); SWAP swaps the offhand; SELECT changes slot.
            INVENTORY opens the player's native inventory; CLOSE closes the current GUI.
            CLICK performs a native inventory action: menu=observed menu.id, index=observed slot index
            (-999 means outside), button=0 left/1 right/hotbar index for SWAP, click=PICKUP / QUICK_MOVE /
            SWAP / THROW / QUICK_CRAFT / PICKUP_ALL / CLONE. Use observed menu indices, not inventory indices.
            CRAFT with menu and text=recipe id fills the native crafting grid, all=true fills all possible;
            then inspect state and CLICK the result slot to collect. RECIPES with text=search substring
            returns recipe ids and ingredient alternatives. Manual slot clicks can also arrange recipes.
            GUI_CLICK clicks an observed screen widget: screen=observed screen.class, index=widget index,
            button=mouse button. TEXT types text into the focused game widget. KEY presses a native GUI
            key: screen=observed class, index=GLFW keycode (Enter257, Escape256, Tab258, Backspace259,
            Delete261, A65); button=modifier bits (Shift1, Ctrl2, Alt4). These do not run OS commands.
            COMMAND sends text as a Minecraft command using the player's existing permissions; CHAT
            sends text as game chat. Neither grants cheats or operator rights. Prefer ticks=1 for instant
            actions and WAIT for server replies. GUI buttons can respawn a dead player. DONE ends the task.
            Nearby blocks [dx,dy,dz,id] are relative to feet, x,z=-2..2 and y=-1..2; air omitted,
            unloaded=unknown. Inventory and menu slots, GUI widgets, nearby entities and action receipts
            are provided. Never claim success from merely sending a packet; verify observed outcomes.
            Before acting, check if the goal is already achieved and use DONE instead of repeating it.
            You now have durable task skills. Prefer them over hand-written LOOK/MOVE/CLICK sequences:
            {"action":"SKILL","text":"find_tree"} searches visible resources and explores when none are known.
            {"action":"SKILL","text":"harvest_tree"} commits to one whole connected tree, approaches it,
            removes ALL reachable trunk/branch logs, collects nearby drops and may scaffold using carried
            dirt/cobblestone/planks. Optional args {"x":1,"y":64,"z":3} chooses an observed trunk.
            A partial tree is a FAILURE with remaining logs; never equate one broken log with a finished tree.
            {"action":"SKILL","text":"explore","args":{"segments":12}} keeps exploring safe surface
            waypoints until it finds tree evidence or reports a genuine route/search limit.
            {"action":"SKILL","text":"navigate","args":{"x":20,"y":64,"z":30}} follows a surface route.
            {"action":"SKILL","text":"craft_item","args":{"item":"minecraft:wooden_pickaxe","count":1}}
            derives recipe dependencies, can gather missing logs, makes intermediate planks/sticks/table,
            opens/places a table when required, fills the recipe and shift-takes verified output.
            Use RECIPES for facts; do not guess recipe layouts, menu indices, or use THROW/outside clicks
            to make inventory space. DROP is only for an intentional user/task decision to discard an item.
            Keep an ordered long-term agenda array of {"goal":"...","status":"pending/active/done"}:
            include material/tool prerequisites and observable completion criteria in goal descriptions.
            Continue the first unfinished prerequisite; preserve the main user goal across replies and failures.
            world_memory has dated sightings and a saved agenda. Recheck remembered resources before use.
            Read skill/actual receipts before marking agenda steps done. Failures should alter the route or
            prerequisite, not restart the entire task. If review_only=true, the active skill KEEPS control:
            update agenda and give a concise progress summary, with actions:[{"action":"WAIT","ticks":1}].
            Review actions are ignored. Never try to steer or replace an active skill during a review.
            Planning is checked about every five seconds when no request is outstanding, while task
            execution continues. Spend low-effort thinking on dependencies and recovery, not new headings
            every few blocks. Do not oscillate LOOK actions to search: resource scans do not rotate the camera.
            Additional survival skills: SKILL text=escape, avoid_monsters, eat, build_shelter, return_shelter.
            Local survival reflexes pause your skill before a model reply arrives. Interruptions are
            recorded, and resumption rechecks actual state. Never assume an interrupted interaction
            completed, and never blindly repeat a previously sent command or drop.
            build_shelter prepares materials for a minimal 3x3 refuge with two-block headroom, full
            roof and wooden door, verifies the server structure and records its landmark.
            return_shelter rechecks the entrance and closes it after entry. Wooden doors are not
            proof against every mob/difficulty. Plan food, lighting and stronger shelter improvements.
            Task goals are isolated by save and player; landmarks/resources are dimension-specific.
            Treat stored shelter/danger/death coordinates as dated observations to recheck.
            Near nightfall or with low food/health, prioritise refuge and supplies over exploration.
            Preserve unfinished user commitments after recovery.
            Mining skills (all use SKILL with args): find_ore {target:"iron",radius:32,segments:8},
            mine_resource {target:"coal",count:16,max_blocks:64}, mine_vein {target:"iron",count:0},
            mine_block {x:1,y:64,z:3}, dig_tunnel {direction:"north",length:12,torch_interval:6,
            collect_interval:2,harvest_ores:true,return_to_entrance:true}, dig_stairs with the same args,
            and return_mine. Resources are observed through visible surfaces only; mine_vein follows
            newly exposed members and cannot assert buried blocks absent. count is additional confirmed
            pickup units for mine_resource; count=0 on a vein means exposed members until its block budget.
            Target names include coal, iron, copper, gold, redstone, lapis, diamond, emerald, quartz,
            ancient_debris, cobblestone, all_ores or an exact block id. Tool harvest tier, durability,
            nearby fluids, falling roof blocks and player support are checked before each native break.
            A staircase descends forward, not straight below the body. Work stops at unsafe floors,
            containers, unknown chunks, missing materials or insufficient tools; choose another plan.
            Inventory skills: pickup_items {mode:"nearest|filtered|sweep",item:"minecraft:coal",
            items:["minecraft:coal","minecraft:raw_iron"],radius:12,count:8}; omit item/items for any.
            Omit count or use 0 to sweep the eligible area; nearest stops after a verified pickup.
            recover_drops {radius:24} approaches this dimension's recorded death position in stages,
            then sweeps remaining visible items. Drops are transient, may merge, drift or be taken by
            others; old death coordinates do not guarantee loot remains. compact_inventory {free_slots:1}
            merges identical stacks with components preserved and NEVER discards anything.
            Pickup uses normal player collision, waits for delay and confirms actual server inventory gains.
            A disappeared entity or pickup animation is not proof. Mine receipts separate broken blocks
            from confirmed gains; partial collection, full bags and inaccessible loot are reported honestly.
            """;
    private static Backend backend = Backend.DEEPSEEK;
    private static final String DEFAULT_GOAL="在保证安全的前提下收集基础材料并建立庇护所";
    private static String goal = DEFAULT_GOAL;
    private static String endpoint = "https://api.deepseek.com";
    private static String model = "deepseek-flash";
    private static String extraPrompt = "";
    private static String status = "未接管";
    private static boolean chatSummary = true;
    private static boolean loaded, active, used;
    private static long epoch;
    private static LocalPlayer owner;
    private static ClientLevel level;
    private static net.minecraft.server.MinecraftServer server;
    private static CameraType previousCamera;
    private static CompletableFuture<?> pending;
    private static PlayerDecision decision;
    private static int remaining, elapsed, heartbeat;
    private static long completedActions;
    private static Vec3 before, origin;
    private static float originYaw, originPitch;
    private static BlockPos target;
    private static String beforeBlock = "", result = "", receipt = "No action executed yet";
    private static final ArrayDeque<String> receipts = new ArrayDeque<>();
    private static PlayerProgress progress = new PlayerProgress();
    private static PlayerEvidence evidence, baseline;
    private static AgentHarness harness;
    private static PlayerTasks tasks = SurvivalPlayerTasks.create(java.util.List.of("*"), java.util.List.of());
    private static String phase = "", startKey = "", expectedBlock = "";
    private static long stepRevision;
    private static boolean evidencePending, targetReady, miningGone, awaitingFinalProof;
    private static int sampleCooldown, aimStable, entityTarget = -1, workTicks, motionTicks, evidenceRevision, workEvidenceRevision, finalWait;
    private static float aimYaw, aimPitch, entityHealth;
    private static Vec3 motionPoint;
    private static double motionDistance;
    private static final Set<PlayerEvidence.Point> watchedBlocks = new HashSet<>();
    private static String boundMemoryKey="";
    private static net.minecraft.server.MinecraftServer boundMemoryServer;
    private static boolean authorized;
    private static int reflexTick;
    private static JsonArray agenda = new JsonArray();

    private PlayerControl() {}
    private static Path config() { return AgentPaths.clientDir().resolve("player-control.json"); }
    private static void load() {
        if (loaded) return;
        loaded = true;
        try { applyProfile(AgentProfile.load(config())); }
        catch (Exception e) { status = "配置读取失败，请检查 player-control.json：" + e.getMessage(); LOG.error("Cannot load player control settings", e); }
    }
    private static void applyProfile(AgentProfile profile) {
        backend = profile.connection().backend(); endpoint = profile.connection().endpoint(); model = profile.connection().model();
        extraPrompt = profile.prompt(); chatSummary = profile.chatSummary();
    }
    public static String goal() { load(); bindWorldGoal(); return goal; }
    private static void bindWorldGoal() {
        Minecraft mc=Minecraft.getInstance(); if(mc.player==null||mc.getSingleplayerServer()==null) return;
        JsonObject memory=tasks.observe(); if(!memory.has("world_key")) return;
        String key=memory.get("world_key").getAsString(); if(key.equals(boundMemoryKey)&&boundMemoryServer==mc.getSingleplayerServer()) return;
        boundMemoryServer=mc.getSingleplayerServer();
        boundMemoryKey=key; phase=""; agenda=new JsonArray(); receipts.clear();
        goal=DEFAULT_GOAL;
        if(memory.has("agenda")) {
            JsonObject saved=memory.getAsJsonObject("agenda");
            if(saved.has("goal")) goal=saved.get("goal").getAsString();
            if(saved.has("phase")) phase=saved.get("phase").getAsString();
            if(saved.has("steps")) agenda=saved.getAsJsonArray("steps").deepCopy();
        }
    }
    public static String endpoint() { load(); return endpoint; }
    public static String model() { load(); return model; }
    public static Backend backend() { load(); return backend; }
    public static String extraPrompt() { load(); return extraPrompt; }
    public static String status() { return status; }
    public static boolean chatSummaryEnabled() { load(); return chatSummary; }
    public static boolean active() { return active; }
    private static PlayerModelConnection connection() { return new PlayerModelConnection(backend, endpoint, model); }
    private static String apiKey() {
        if (backend == Backend.OLLAMA) return "ollama";
        String saved = AgentCredentials.get(KEY_SERVICE);
        if (saved != null && !saved.isBlank()) return saved;
        String environment = System.getenv("DEEPSEEK_API_KEY");
        return environment == null ? "" : environment.strip();
    }
    public static boolean hasKey() { return !apiKey().isBlank(); }
    public static boolean hasDeepSeekKey() {
        String saved = AgentCredentials.get(KEY_SERVICE);
        String environment = System.getenv("DEEPSEEK_API_KEY");
        return saved != null && !saved.isBlank() || environment != null && !environment.isBlank();
    }
    public static boolean configureGoal(String newGoal) {
        try {
            if (newGoal.isBlank()) throw new IllegalArgumentException("目标不能为空");
            var profile = AgentProfile.load(config());
            bindWorldGoal(); applyProfile(profile); loaded = true; rememberGoal(newGoal);
            return true;
        } catch (Exception e) { status = "目标或配置读取失败: " + e.getMessage(); LOG.error("Cannot configure mission goal", e); return false; }
    }
    private static void rememberGoal(String newGoal) {
        if(!goal.equals(newGoal.strip())) { phase=""; agenda=new JsonArray(); receipts.clear(); }
        goal = newGoal.strip();
        if(Minecraft.getInstance().getSingleplayerServer()!=null) rememberAgenda();
    }
    public static boolean configure(String newGoal, Backend newBackend, String newEndpoint, String newModel,
                                    String newKey, String newPrompt, boolean newChatSummary) {
        try {
            var connection = new PlayerModelConnection(newBackend, newEndpoint, newModel);
            if (newGoal.isBlank()) throw new IllegalArgumentException("目标不能为空");
            JsonObject o = new JsonObject(); o.addProperty("backend", newBackend.name());
            o.addProperty("endpoint", connection.endpoint()); o.addProperty("model", connection.model()); o.addProperty("prompt", newPrompt);
            o.addProperty("chat_summary", newChatSummary);
            var profile = AgentProfile.load(config()).withOverrides(o);
            bindWorldGoal();
            if (newBackend == Backend.DEEPSEEK && !newKey.isBlank()) AgentCredentials.put(KEY_SERVICE, newKey);
            profile.save(config());
            applyProfile(profile); loaded = true; rememberGoal(newGoal);
            return true;
        } catch (Exception e) { status = "设置失败: " + e.getMessage(); LOG.error("Cannot configure player control", e); return false; }
    }
    public static void testConnection() {
        try {
            var connection = connection(); String key = apiKey();
            if (key.isBlank()) { status = "请先填写 DeepSeek API Key"; return; }
            long marker = epoch; status = "连接测试中";
            HTTP.post(connection.url(), key, connection.request("Return JSON only: {\"ok\":true}", new JsonObject()))
                    .orTimeout(90, TimeUnit.SECONDS).whenComplete((reply, error) -> Minecraft.getInstance().execute(() -> {
                        if (active || marker != epoch) return;
                        if (error == null) {
                            try { JsonParser.parseString(PlayerModelConnection.PROVIDER.parseResponseBody(reply).content()).getAsJsonObject();
                                status = "连接成功: " + connection.model(); }
                            catch (RuntimeException e) { status = "连接成功，但模型返回格式无效"; }
                        } else { status = PlayerModelConnection.error(error); LOG.warn("Player model connection test failed: {}", status); }
                    }));
        } catch (RuntimeException e) { status = "连接设置无效: " + e.getMessage(); }
    }
    public static void start() {
        Minecraft mc = Minecraft.getInstance(); stop("准备接管"); load();
        if (mc.player == null || mc.level == null || mc.getSingleplayerServer() == null) {
            say("当前支持单人世界及本机开局域网的房主"); return;
        }
        try { bindWorldGoal(); } catch(RuntimeException e) { LOG.error("World memory binding failed",e); say("存档记忆读取失败，请查看日志"); return; }
        final AgentProfile profile;
        try {
            profile = AgentProfile.load(config());
            var selectedTasks = SurvivalPlayerTasks.create(profile.enabledSkills(),
                    java.util.ServiceLoader.load(SkillProvider.class, PlayerControl.class.getClassLoader()));
            applyProfile(profile); tasks = selectedTasks;
        } catch (Exception | LinkageError | java.util.ServiceConfigurationError error) {
            LOG.error("Agent profile or skill registration failed", error);
            say("配置或技能加载失败，未接管：" + error.getMessage()); return;
        }
        if (!hasKey()) { say("请在 F8 面板填写 DeepSeek API Key"); return; }
        active = true; epoch++; owner = mc.player; level = mc.level; server = mc.getSingleplayerServer();
        owner.setSprinting(false); origin = owner.position(); completedActions = 0; receipts.clear();
        originYaw = yaw(); originPitch = owner.getXRot(); heartbeat = 0;
        previousCamera = mc.options.getCameraType(); mc.options.setCameraType(CameraType.FIRST_PERSON);
        receipt = "Takeover started; no action executed";
        progress = new PlayerProgress(); evidence = null; baseline = null;
        phase = ""; stepRevision++; evidencePending = false; sampleCooldown = 0;
        motionPoint = null; motionTicks = 0;
        harness = null; authorized=false; reflexTick=0;
        agenda = new JsonArray();
        JsonObject memory;
        try { memory=tasks.observe(); }
        catch(RuntimeException e) { LOG.error("Player memory could not be opened",e); stop("世界记忆读取失败，请查看日志"); return; }
        if(memory.has("agenda")) {
            JsonObject saved=memory.getAsJsonObject("agenda");
            if(saved.has("goal") && goal.equals(saved.get("goal").getAsString())) {
                if(saved.has("steps")) agenda=saved.getAsJsonArray("steps").deepCopy();
                if(saved.has("phase")) phase=saved.get("phase").getAsString();
            }
        }
        say("全操作模式已开始：F9 或人工输入立即停止");
        var recording = MissionRecording.start(goal,boundMemoryKey,backend.name(),model);
        recording.configuration(profile.fingerprint(), tasks.catalog());
        var modelConnection = profile.connection(); String key = apiKey();
        final String sessionPrompt = PROMPT + "\nUser instructions:\n" + profile.prompt()
                + "\nOnly use skills in this enabled catalog; descriptions specify arguments. Native actions and emergency reflexes remain available.\n" + tasks.catalog();
        harness = new AgentHarness(goal, memory.has("agenda") ? memory.getAsJsonObject("agenda") : new JsonObject(),
                state -> HTTP.post(modelConnection.url(), key, modelConnection.request(sessionPrompt, state))
                        .thenApply(reply -> {
                            if(reply.has("usage")) LOG.info("Player model usage: {}", reply.get("usage"));
                            return PlayerPlan.parse(PlayerModelConnection.PROVIDER.parseResponseBody(reply).content());
                        }), new AgentHarness.Adapter() {
                    public JsonObject observe() { return snapshot(); }
                    public PlayerTasks.Task startSkill(PlayerDecision request) { return tasks.start(request); }
                    public void remember(JsonObject memory) { tasks.remember(memory); }
                    public void cancelAction() { PlayerControl.cancelAction(); }
                    public void message(String stage, String text) { status = text; chat(stage, text); }
                }, recording, profile.limits());
        progress = harness.progress();
        LOG.info("Player takeover started: backend={}, model={}, goal={}", backend, model, goal);
        // Bind the actual integrated-server player before accepting native action receipts.
        long session = epoch; var uuid = owner.getUUID(); CompletableFuture<Boolean> authorization = new CompletableFuture<>();
        pending = authorization;
        server.execute(() -> {
            try { var player = server.getPlayerList().getPlayer(uuid);
                authorization.complete(player != null && PlayerAccess.authorize(player, uuid)); }
            catch (Exception e) { authorization.completeExceptionally(e); }
        });
        authorization.orTimeout(10, TimeUnit.SECONDS).whenComplete((allowed, error) -> mc.execute(() -> {
            if (!active || epoch != session) return;
            pending = null;
            if (error != null || !allowed) { stop("无法取得玩家控制授权"); return; }
            authorized=true;
            driveHarness();
        }));
    }
    public static void stop(String reason) {
        Minecraft mc = Minecraft.getInstance(); boolean wasActive = active;
        if (harness != null) {
            try { harness.stop(reason); }
            catch (RuntimeException e) { LOG.error("Harness cleanup failed",e); }
            JsonObject saved = harness.memory(); phase = saved.get("phase").getAsString(); agenda = saved.getAsJsonArray("steps").deepCopy();
            receipts.clear(); saved.getAsJsonArray("verified_receipts").forEach(e -> receipts.addLast(e.getAsString()));
        }
        active = false; epoch++; if (pending != null) pending.cancel(true); pending = null; decision = null;
        remaining = 0; target = null; stepRevision++; evidencePending = false; authorized=false;
        if (wasActive) {
            MissionRecording.interrupted(reason);
            if (mc.gameMode != null) {
                mc.gameMode.stopDestroyBlock();
                if (owner != null && owner.isUsingItem()) mc.gameMode.releaseUsingItem(owner);
            }
            if (owner != null) {
                owner.input.forwardImpulse = 0; owner.input.leftImpulse = 0; owner.input.jumping = false;
                owner.input.shiftKeyDown = false; owner.setSprinting(false);
            }
            if (previousCamera != null) mc.options.setCameraType(previousCamera);
            say(reason); LOG.info("Player takeover stopped: {}", reason);
            LOG.info("Player metrics: requests={} request_ms={} steps={} success={} failed={} skipped={} working_ticks={} idle_ticks={}",
                    progress.requests(), progress.requestMillis(), progress.steps(), progress.succeeded(), progress.failed(),
                    progress.skipped(), progress.activeTicks(), progress.idleTicks());
        }
        owner = null; level = null; server = null;
    }
    public static boolean ownsMining() {
        return active && decision != null && !miningGone
                && (target == null || !level.isEmptyBlock(target))
                && (decision.action() == PlayerDecision.Kind.BREAK || decision.attack()) && !manual(Minecraft.getInstance());
    }
    public static boolean holdsUse() {
        return active && decision != null && used && (decision.action() == PlayerDecision.Kind.USE || decision.use())
                && !manual(Minecraft.getInstance());
    }
    private static boolean positionMove() {
        return decision != null && decision.action() == PlayerDecision.Kind.MOVE && decision.until() != null
                && decision.until().type() == PlayerCondition.Type.POSITION;
    }
    public static void input(Input input) {
        if (!active) return;
        Minecraft mc = Minecraft.getInstance();
        if (manual(mc)) { stop("人工输入，已交还控制"); return; }
        if (mc.player != owner || mc.level != level) return;
        boolean ready = decision != null && baseline != null && !awaitingFinalProof;
        float forward = ready ? decision.forward() : 0;
        if (ready && positionMove()) {
            if (forward == 0) forward = 1;
            if (PlayerCondition.angleError(owner.getYRot(), aimYaw) > 25) forward = 0;
        }
        if(ready&&harness.emergency()&&PlayerCondition.angleError(owner.getYRot(),aimYaw)>25) forward=0;
        input.forwardImpulse = forward; input.leftImpulse = ready ? decision.strafe() : 0;
        input.jumping = ready && decision.jump(); input.shiftKeyDown = ready && decision.sneak();
        input.up = input.forwardImpulse > 0; input.down = input.forwardImpulse < 0;
        input.left = input.leftImpulse > 0; input.right = input.leftImpulse < 0;
        if (ready) owner.setSprinting(decision.sprint());
    }
    private static boolean manual(Minecraft mc) {
        var o = mc.options;
        for (var key : o.keyHotbarSlots) if (key.isDown()) return true;
        return o.keyUp.isDown() || o.keyDown.isDown() || o.keyLeft.isDown() || o.keyRight.isDown()
                || o.keyJump.isDown() || o.keyShift.isDown() || o.keySprint.isDown() || o.keyAttack.isDown()
                || o.keyUse.isDown() || o.keyDrop.isDown() || o.keyPickItem.isDown()
                || o.keySwapOffhand.isDown() || o.keyTogglePerspective.isDown();
    }
    public static void mouseMoved() { if (active) stop("鼠标输入，已交还控制"); }
    private static String screenId() {
        var screen = Minecraft.getInstance().screen; return screen == null ? "none" : screen.getClass().getName();
    }
    private static PlayerEvidence observed() {
        return evidence == null ? null : evidence.withView(yaw(), owner.getXRot(), screenId(), PlayerActions.guiSignature());
    }
    private static void pollEvidence() {
        if (evidencePending || decision == null) return;
        evidencePending = true;
        long session = epoch, step = stepRevision;
        var uuid = owner.getUUID(); var dimension = level.dimension();
        Set<PlayerEvidence.Point> points = Set.copyOf(watchedBlocks);
        Set<Integer> entities = entityTarget < 0 ? Set.of() : Set.of(entityTarget);
        var mc = Minecraft.getInstance(); var integrated = server;
        integrated.execute(() -> {
            PlayerEvidence captured = null; Exception failure = null;
            try {
                var player = integrated.getPlayerList().getPlayer(uuid);
                if (player != null && player.level().dimension().equals(dimension)) captured = PlayerFeedback.capture(player, points, entities);
            } catch (Exception e) { failure = e; }
            PlayerEvidence sample = captured; Exception error = failure;
            mc.execute(() -> {
                if (!active || epoch != session) return;
                if (sample != null && (evidence == null || sample.serverTick() >= evidence.serverTick())) {
                    evidence = sample; evidenceRevision++;
                }
                if (stepRevision != step) return;
                evidencePending = false;
                if (error != null) { LOG.error("Player server observation failed", error); stop("服务器状态读取失败，已停止"); return; }
                if (sample == null) return;
                if (baseline == null) {
                    baseline = observed(); startKey = baseline.stableKey();
                    harness.evidence(baseline);
                    initMotionWindow();
                }
            });
        });
    }
    public static void tick() {
        if (!active) return;
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.level == null || mc.getSingleplayerServer() != server) { stop("离开当前世界，已停止"); return; }
        if (manual(mc)) { stop("人工输入，已交还控制"); return; }
        if (mc.player != owner || mc.level != level) {
            epoch++; stepRevision++; if (pending != null) pending.cancel(true); pending = null;
            owner = mc.player; level = mc.level; evidence = baseline = null; evidencePending = false;
            origin = owner.position(); motionPoint = null; motionTicks = 0;
            try {
                bindWorldGoal(); JsonObject memory = tasks.observe();
                harness.resetContext(memory.has("agenda") ? memory.getAsJsonObject("agenda") : new JsonObject(), level.dimension().location().toString());
            } catch(RuntimeException e) { LOG.error("World transition failed",e); stop("存档记忆切换失败"); return; }
            receipt = "Player respawned or changed dimension; reset local progress baseline; position=" + owner.position();
            LOG.info("Player action receipt: {}", receipt);
        }
        if(authorized && ++reflexTick%5==0) {
            try { var urgent=tasks.emergency();
                if(urgent!=null) harness.interrupt(urgent);
            } catch(RuntimeException e) { LOG.error("Survival reflex failed",e); stop("遇险检测失败，请查看日志"); return; }
        }
        progress.tick(decision != null && baseline != null);
        driveHarness();
        if(!active) return;
        if (decision != null) {
            if (--sampleCooldown <= 0) { sampleCooldown = 3; pollEvidence(); }
            if (baseline != null) {
                elapsed++;
                steer();
                PlayerDecision running = decision;
                if (workTicks == 0 && !preconditions()) {
                    finish(Outcome.FAILED, "PRECONDITION_CHANGED: refresh the plan");
                } else if (workTicks == 0 && satisfiedWithoutAction()) {
                    finish(Outcome.ALREADY_SATISFIED, "Expected result already observed; skipped duplicate action");
                } else if (progress.blocked(decision.toString(), startKey)) {
                    finish(Outcome.NO_PROGRESS, "REPEATED_FAILURE: this action already failed twice in unchanged state; choose another method");
                } else if (aimStable > 0 || !needsAim()) {
                    if (used) inspectResult();
                    if (decision == running) execute();
                    if (decision == running) {
                        workTicks++;
                        inspectResult();
                        if (decision == running) inspectMotion();
                        if (decision == running && --remaining <= 0) deadline();
                    }
                }
                if (decision == running && elapsed > Math.max(80L, (long) decision.ticks() + 40))
                    finish(Outcome.TIMED_OUT, "Aiming/observation deadline exceeded");
            }
            // Install the next committed action before the next native input sample: no zero-input gap.
            if (active && decision == null) driveHarness();
        }
        if (active && ++heartbeat % 20 == 0) owner.displayClientMessage(Component.literal("[MC Player Agent] " + status + " | F9 停止"), true);
    }
    private static void driveHarness() {
        if (!active || !authorized || harness == null) return;
        PlayerDecision next = harness.tick(observed());
        if (!harness.running()) { stop(harness.reason()); return; }
        if (next != null) begin(next);
    }
    private static void cancelAction() {
        Minecraft mc=Minecraft.getInstance();
        if(mc.gameMode!=null) { mc.gameMode.stopDestroyBlock(); if(owner!=null && owner.isUsingItem()) mc.gameMode.releaseUsingItem(owner); }
        if(owner!=null) { owner.input.forwardImpulse=0; owner.input.leftImpulse=0; owner.input.jumping=false; owner.setSprinting(false); }
        decision=null; baseline=null; remaining=0; stepRevision++; evidencePending=false;
    }
    private static void rememberAgenda() {
        if(active && harness!=null) { tasks.remember(harness.memory()); return; }
        JsonObject memory=new JsonObject(); memory.addProperty("goal",goal); memory.addProperty("phase",phase);
        memory.add("steps",agenda.deepCopy()); JsonArray history=new JsonArray(); receipts.forEach(history::add);
        memory.add("verified_receipts",history); tasks.remember(memory);
    }
    private static void watch(PlayerCondition condition) {
        if (condition != null && condition.type() == PlayerCondition.Type.BLOCK) watchedBlocks.add(condition.point());
    }
    private static void begin(PlayerDecision requested) {
        decision = requested; stepRevision++; baseline = null; evidencePending = false; sampleCooldown = 0;
        if(harness.hasTask()) status="技能 "+harness.taskName()+" · "+actionLabel(decision.action());
        remaining = Math.max(decision.ticks(), confirmationAction() ? 20 : 1);
        elapsed = workTicks = aimStable = finalWait = 0;
        used = owner.isUsingItem() && (decision.action() == PlayerDecision.Kind.USE || decision.use());
        targetReady = miningGone = awaitingFinalProof = false;
        workEvidenceRevision = evidenceRevision;
        target = null; entityTarget = -1; entityHealth = Float.NaN; beforeBlock = expectedBlock = result = "";
        before = owner.position(); watchedBlocks.clear(); watch(decision.until()); watch(decision.requires()); watch(harness.goalCheck());
        aimYaw = Float.isNaN(decision.yaw()) ? yaw() : decision.yaw();
        aimPitch = Float.isNaN(decision.pitch()) ? owner.getXRot() : decision.pitch();
        if (decision.action() == PlayerDecision.Kind.LOOK && decision.until() != null
                && decision.until().type() == PlayerCondition.Type.YAW) aimYaw = (float) decision.until().value();
        // Selection is a native action; take the baseline before changing it.
        LOG.info("Player intent: step={} phase={} {}", stepRevision, harness.phase(), decision);
        if (evidence != null && evidence.blocks().keySet().containsAll(watchedBlocks)) {
            baseline = observed(); startKey = baseline.stableKey();
            initMotionWindow();
            harness.evidence(baseline);
        }
        pollEvidence();
    }
    private static void initMotionWindow() {
        if (motionPoint == null) {
            motionPoint = new Vec3(baseline.x(), baseline.y(), baseline.z());
            motionDistance = positionMove() ? decision.until().distanceTo(baseline) : 0;
        }
    }
    private static boolean needsAim() {
        return decision.action() == PlayerDecision.Kind.LOOK || decision.action() == PlayerDecision.Kind.BREAK
                || decision.action() == PlayerDecision.Kind.PLACE || decision.action() == PlayerDecision.Kind.USE
                || decision.action() == PlayerDecision.Kind.ATTACK || decision.attack() || decision.use();
    }
    private static boolean confirmationAction() {
        return switch (decision.action()) {
            case BREAK, PLACE, CLICK, CRAFT, DROP, SWAP, SELECT, INVENTORY, CLOSE, USE, ATTACK, DONE -> true;
            default -> decision.until() != null;
        };
    }
    private static void steer() {
        if (positionMove()) {
            double dx = decision.until().x() - owner.getX(), dz = decision.until().z() - owner.getZ();
            if (dx * dx + dz * dz > 0.01) aimYaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
        }
        if (decision.slot() >= 0) owner.getInventory().selected = decision.slot();
        owner.setYRot(Mth.approachDegrees(owner.getYRot(), aimYaw, 12));
        owner.setXRot(Mth.approach(owner.getXRot(), aimPitch, 8));
        aimStable = PlayerCondition.angleError(owner.getYRot(), aimYaw) < 0.7 && Math.abs(owner.getXRot() - aimPitch) < 0.7 ? aimStable + 1 : 0;
    }
    private static boolean preconditions() {
        return decision.requires() == null || decision.requires().matches(baseline, baseline);
    }
    private static boolean satisfiedWithoutAction() {
        if (decision.action() == PlayerDecision.Kind.DONE) return false;
        PlayerEvidence now = observed();
        if (decision.until() != null) return decision.until().matches(now, baseline);
        return switch (decision.action()) {
            case LOOK -> PlayerCondition.angleError(baseline.yaw(), aimYaw) < 0.7 && Math.abs(baseline.pitch() - aimPitch) < 0.7;
            case SELECT -> decision.slot() >= 0 && baseline.slot() == decision.slot();
            case INVENTORY -> Minecraft.getInstance().screen instanceof net.minecraft.client.gui.screens.inventory.InventoryScreen;
            case CLOSE -> Minecraft.getInstance().screen == null;
            default -> false;
        };
    }
    private static boolean bindTarget() {
        Minecraft mc = Minecraft.getInstance(); mc.gameRenderer.pick(1);
        if (decision.action() == PlayerDecision.Kind.PLACE || decision.action() == PlayerDecision.Kind.BREAK) {
            if (target == null) {
                if (!(mc.hitResult instanceof BlockHitResult hit) || hit.getType() != HitResult.Type.BLOCK) {
                    finish(Outcome.FAILED, "NO_TARGET: no block in reach"); return false;
                }
                if (decision.action() == PlayerDecision.Kind.PLACE) {
                    var stack = decision.offhand() ? owner.getOffhandItem() : owner.getMainHandItem();
                    if (!(stack.getItem() instanceof net.minecraft.world.item.BlockItem item)) {
                        finish(Outcome.FAILED, "PLACE needs a block item; use USE for other interactions"); return false;
                    }
                    var hand = decision.offhand() ? net.minecraft.world.InteractionHand.OFF_HAND : net.minecraft.world.InteractionHand.MAIN_HAND;
                    target = new net.minecraft.world.item.context.BlockPlaceContext(owner, hand, stack, hit).getClickedPos().immutable();
                    expectedBlock = BuiltInRegistries.BLOCK.getKey(item.getBlock()).toString();
                } else target = hit.getBlockPos().immutable();
                if (decision.until() != null && decision.until().type() == PlayerCondition.Type.BLOCK
                        && !decision.until().point().equals(PlayerFeedback.point(target))) {
                    finish(Outcome.FAILED, "WRONG_TARGET: crosshair does not match requested block coordinate"); return false;
                }
                watchedBlocks.add(PlayerFeedback.point(target)); pollEvidence();
            }
            String state = evidence.blocks().get(PlayerFeedback.point(target));
            if (state == null) return false;
            if (!targetReady) { beforeBlock = state; targetReady = true; startKey += ":target=" + target + ":" + state; }
        }
        if (decision.action() == PlayerDecision.Kind.ATTACK || decision.attack()) {
            if (entityTarget < 0 && mc.hitResult instanceof EntityHitResult hit) {
                entityTarget = hit.getEntity().getId(); pollEvidence(); return false;
            }
            if (entityTarget >= 0) {
                Float health = evidence.entityHealth().get(entityTarget);
                if (health == null) return false;
                if (Float.isNaN(entityHealth)) { entityHealth = health; startKey += ":entity=" + entityTarget + ":hp=" + health; }
                if (decision.action() == PlayerDecision.Kind.ATTACK && (!(mc.hitResult instanceof EntityHitResult hit)
                        || hit.getEntity().getId() != entityTarget)) return false;
            } else if (decision.action() == PlayerDecision.Kind.ATTACK) {
                finish(Outcome.FAILED, "NO_ENTITY_TARGET: aim at a reachable entity before ATTACK"); return false;
            }
        }
        return true;
    }
    private static void execute() {
        Minecraft mc = Minecraft.getInstance();
        try {
            if (decision.action() == PlayerDecision.Kind.DONE) {
                if (harness.goalCheck() == null) finish(Outcome.SENT_UNCONFIRMED, "Model declared done without a verifiable goal condition");
                return;
            }
            if (!bindTarget()) return;
            if (!used) workEvidenceRevision = evidenceRevision;
            if (decision.action() == PlayerDecision.Kind.BREAK) {
                String serverBlock = evidence.blocks().get(PlayerFeedback.point(target));
                if ("minecraft:air".equals(serverBlock)) {
                    miningGone = true; mc.gameMode.stopDestroyBlock(); return;
                }
                if (!beforeBlock.equals(serverBlock)) { finish(Outcome.FAILED, "TARGET_REPLACED: original block changed to another block"); return; }
                if (!(mc.hitResult instanceof BlockHitResult hit) || !hit.getBlockPos().equals(target)) {
                    if (level.isEmptyBlock(target)) return; // Wait for server acknowledgement of the predicted break.
                    finish(Outcome.FAILED, "TARGET_LOST: refresh position or aim before continuing"); return;
                }
                result = PlayerActions.attack();
            } else if (decision.action() == PlayerDecision.Kind.ATTACK || decision.attack()) result = PlayerActions.attack();
            if (!used) {
                if (decision.action() == PlayerDecision.Kind.USE || decision.action() == PlayerDecision.Kind.PLACE || decision.use()) result = PlayerActions.use(decision);
                else if (decision.action() != PlayerDecision.Kind.BREAK && decision.action() != PlayerDecision.Kind.ATTACK) result = PlayerActions.once(decision);
                used = true;
            }
        } catch (RuntimeException e) { finish(Outcome.FAILED, "Native action rejected: " + e.getMessage()); }
    }
    private static void inspectResult() {
        PlayerEvidence now = observed();
        if (decision.action() == PlayerDecision.Kind.DONE) {
            Outcome accepted = harness.completion(now);
            if (accepted == Outcome.SUCCEEDED) finish(accepted, AgentHarness.completionDetail(accepted));
            return;
        }
        if (decision.until() != null) {
            if (decision.until().matches(now, baseline)) { finish(Outcome.SUCCEEDED, "Completion condition verified"); return; }
        } else {
            boolean success = switch (decision.action()) {
                case LOOK -> aimStable >= 1;
                case BREAK -> miningGone;
                case PLACE -> target != null && expectedBlock.equals(evidence.blocks().get(PlayerFeedback.point(target)));
                case SELECT -> decision.slot() >= 0 && evidence.slot() == decision.slot();
                case DROP -> !baseline.inventory().equals(evidence.inventory());
                case SWAP -> !baseline.hand().equals(evidence.hand()) || !baseline.offhand().equals(evidence.offhand());
                case CLICK -> used && PlayerContinuity.clickedSlotChanged(baseline.menuContents(), evidence.menuContents(), decision.index());
                case CRAFT -> used && !baseline.menuContents().equals(evidence.menuContents());
                case USE -> used && !baseline.inventory().equals(evidence.inventory());
                case INVENTORY -> !"none".equals(screenId()) && !screenId().equals(baseline.screen());
                case CLOSE -> "none".equals(screenId());
                case GUI_CLICK, TEXT, KEY -> !now.gui().equals(baseline.gui()) || !now.menuContents().equals(baseline.menuContents());
                case ATTACK -> entityTarget >= 0 && evidence.entityHealth().getOrDefault(entityTarget, entityHealth) < entityHealth;
                default -> false;
            };
            if (success) { finish(Outcome.SUCCEEDED, "Observed result verified"); return; }
        }
    }
    private static void inspectMotion() {
        PlayerEvidence now = observed();
        boolean moving = decision.forward() != 0 || decision.strafe() != 0 || positionMove();
        if (moving && ++motionTicks >= 40) {
            Vec3 current = new Vec3(now.x(), now.y(), now.z());
            double improvement = positionMove() ? motionDistance - decision.until().distanceTo(now) : current.distanceTo(motionPoint);
            if (improvement < 0.12) { finish(Outcome.NO_PROGRESS, "STUCK: no useful movement for 40 active ticks; change route, jump or position"); return; }
            motionPoint = current; motionDistance = positionMove() ? decision.until().distanceTo(now) : 0; motionTicks = 0;
        }
    }
    private static boolean carriesMining(PlayerDecision next) {
        return PlayerContinuity.mining(decision, next, owner.getInventory().selected, aimYaw, aimPitch, miningGone);
    }
    private static void deadline() {
        if (evidenceRevision <= workEvidenceRevision && finalWait++ < 10) {
            awaitingFinalProof = true;
            remaining = 1; pollEvidence(); return;
        }
        PlayerEvidence now = observed();
        if (decision.action() == PlayerDecision.Kind.BREAK && carriesMining(harness.peekNext())) {
            finish(Outcome.CONTINUING, "Continue the same mining stroke without resetting progress"); return;
        }
        if (decision.action() == PlayerDecision.Kind.DONE) {
            if (harness.goalCheck() == null) finish(Outcome.SENT_UNCONFIRMED, "Model declared done without a verifiable goal condition");
            else finish(Outcome.FAILED, "GOAL_NOT_MET: completion predicate is false");
            return;
        }
        if (decision.until() != null) { finish(Outcome.TIMED_OUT, "Completion predicate not reached before deadline"); return; }
        if (decision.action() == PlayerDecision.Kind.MOVE || decision.action() == PlayerDecision.Kind.INPUT) {
            boolean movement = decision.forward() != 0 || decision.strafe() != 0;
            finish(movement && now.distance(baseline) < Math.min(0.08, 0.01 * workTicks) ? Outcome.NO_PROGRESS
                    : decision.attack() || decision.use() ? Outcome.SENT_UNCONFIRMED : Outcome.SUCCEEDED,
                    movement ? "Movement measured against server position" : "Native input interval completed");
        } else if (decision.action() == PlayerDecision.Kind.USE) finish(Outcome.SENT_UNCONFIRMED, "Use interval completed; release/interaction effects still need observation");
        else if (confirmationAction()) finish(Outcome.NO_PROGRESS, "NO_EFFECT: server has not confirmed the requested change; refresh state and choose another method");
        else finish(decision.action() == PlayerDecision.Kind.WAIT ? Outcome.SUCCEEDED : Outcome.SENT_UNCONFIRMED,
                "Input/query/GUI packet sent; unobservable effects are not reported as confirmed success; " + result);
    }
    private static void finish(Outcome outcome, String detail) {
        Minecraft mc = Minecraft.getInstance(); PlayerDecision finished = decision;
        if (finished.action() == PlayerDecision.Kind.DONE) {
            outcome = harness.completion(observed()); detail = AgentHarness.completionDetail(outcome);
        }
        boolean failed = outcome == Outcome.FAILED || outcome == Outcome.NO_PROGRESS || outcome == Outcome.TIMED_OUT;
        double moved = observed() == null || baseline == null ? owner.position().distanceTo(before) : observed().distance(baseline);
        receipt = "status=" + outcome + "; action=" + finished.action() + "; detail=" + detail + "; ticks=" + workTicks
                + "; moved=" + moved + "; yaw=" + yaw() + "; pitch=" + owner.getXRot()
                + "; server_tick=" + (evidence == null ? -1 : evidence.serverTick())
                + "; target_before=" + beforeBlock + "; target_after=" + (target == null || evidence == null ? "none" : evidence.blocks().get(PlayerFeedback.point(target)));
        if (finished.action() == PlayerDecision.Kind.RECIPES) receipt += "; recipes=" + (result.length() > 1800 ? result.substring(0, 1800) : result);
        LOG.info("Player action receipt: step={} {}", stepRevision, receipt);
        completedActions++;
        if (outcome != Outcome.ALREADY_SATISFIED && (!harness.hasTask() || failed)) chat("反馈", actionLabel(finished.action()) + "：" + outcome + "，" + PlayerPlan.displayText(detail));
        if(!harness.emergency() && outcome==Outcome.NO_PROGRESS && (finished.action()==PlayerDecision.Kind.MOVE||finished.action()==PlayerDecision.Kind.INPUT)
                &&(finished.forward()!=0||finished.strafe()!=0||finished.until()!=null&&finished.until().type()==PlayerCondition.Type.POSITION)) tasks.movementFailed();
        PlayerDecision next = failed && !harness.hasTask() ? null : harness.peekNext();
        if (mc.gameMode != null) {
            if (!carriesMining(next)) mc.gameMode.stopDestroyBlock();
            boolean continueUse = PlayerContinuity.use(finished, next, owner.getInventory().selected);
            if (owner.isUsingItem() && !continueUse) mc.gameMode.releaseUsingItem(owner);
        }
        if (next == null || !next.sprint()) owner.setSprinting(false);
        boolean continuousMove = next != null && (next.forward() != 0 || next.strafe() != 0
                || next.action() == PlayerDecision.Kind.MOVE && next.until() != null && next.until().type() == PlayerCondition.Type.POSITION)
                && java.util.Objects.equals(finished.until(), next.until());
        if (!continuousMove) { motionPoint = null; motionTicks = 0; }
        decision = null; baseline = null; target = null; remaining = 0; stepRevision++; evidencePending = false;
        harness.complete(outcome, detail, receipt, startKey, observed());
        if (!harness.running()) stop(harness.reason());
    }

    private static JsonObject snapshot() {
        JsonObject s = new JsonObject();
        PlayerActions.observe(s);
        s.add("world_memory", tasks.observe());
        s.add("available_skills", tasks.catalog());
        s.addProperty("game_mode", Minecraft.getInstance().gameMode.getPlayerMode().getName());
        s.addProperty("can_use_commands", owner.hasPermissions(2));
        s.addProperty("day_time", level.getDayTime()); s.addProperty("raining", level.isRaining());
        s.addProperty("dimension", level.dimension().location().toString());
        if (harness != null) harness.context().entrySet().forEach(e -> s.add(e.getKey(),e.getValue()));
        else s.addProperty("goal",goal);
        s.addProperty("task_start_position", origin.toString());
        s.addProperty("task_start_yaw", originYaw); s.addProperty("task_start_pitch", originPitch);
        s.addProperty("completed_actions", completedActions);
        s.addProperty("x", owner.getX()); s.addProperty("y", owner.getY()); s.addProperty("z", owner.getZ());
        s.addProperty("yaw", yaw()); s.addProperty("pitch", owner.getXRot());
        s.addProperty("facing", owner.getDirection().getName());
        s.addProperty("health", owner.getHealth()); s.addProperty("food", owner.getFoodData().getFoodLevel());
        s.addProperty("air", owner.getAirSupply()); s.addProperty("in_water", owner.isInWater());
        s.addProperty("on_ground", owner.onGround()); s.addProperty("selected_slot", owner.getInventory().selected);
        JsonArray inventory = new JsonArray();
        for (int i = 0; i < owner.getInventory().items.size(); i++) {
            var stack = owner.getInventory().getItem(i);
            if (stack.isEmpty()) continue;
            JsonObject item = new JsonObject(); item.addProperty("slot", i);
            item.addProperty("item", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
            item.addProperty("count", stack.getCount()); inventory.add(item);
        }
        s.add("inventory", inventory);
        JsonArray blocks = new JsonArray();
        BlockPos feet = owner.blockPosition();
        for (int x = -2; x <= 2; x++) for (int z = -2; z <= 2; z++) for (int y = -1; y <= 2; y++) {
            BlockPos p = feet.offset(x, y, z);
            boolean available = level.hasChunkAt(p);
            if (available && level.getBlockState(p).isAir()) continue;
            JsonArray b = new JsonArray(); b.add(x); b.add(y); b.add(z); b.add(available ? block(p) : "unloaded"); blocks.add(b);
        }
        s.add("nearby_blocks", blocks);
        var hit = Minecraft.getInstance().hitResult;
        if (hit instanceof BlockHitResult b && hit.getType() == HitResult.Type.BLOCK) {
            JsonObject crosshair = new JsonObject(); crosshair.addProperty("pos", b.getBlockPos().toShortString());
            crosshair.addProperty("face", b.getDirection().getName()); crosshair.addProperty("block", block(b.getBlockPos()));
            s.add("crosshair", crosshair);
        }
        JsonArray entities = new JsonArray();
        level.getEntities(owner, owner.getBoundingBox().inflate(6)).stream().limit(12).forEach(e -> {
            JsonObject entity = new JsonObject(); entity.addProperty("type", BuiltInRegistries.ENTITY_TYPE.getKey(e.getType()).toString());
            entity.addProperty("x", e.getX()); entity.addProperty("y", e.getY()); entity.addProperty("z", e.getZ()); entities.add(entity);
        });
        s.add("nearby_entities", entities);
        // Keep unchanged terrain before changing player telemetry to preserve the model's prefix cache.
        JsonObject ordered = new JsonObject();
        ordered.add("goal", s.remove("goal")); ordered.add("nearby_blocks", s.remove("nearby_blocks"));
        s.entrySet().forEach(e -> ordered.add(e.getKey(), e.getValue()));
        return ordered;
    }

    private static String block(BlockPos pos) { return BuiltInRegistries.BLOCK.getKey(level.getBlockState(pos).getBlock()).toString(); }
    private static String actionLabel(PlayerDecision.Kind kind) {
        return switch (kind) {
            case INPUT, MOVE -> "移动/按键";
            case WAIT -> "等待"; case LOOK -> "转向"; case BREAK -> "挖掘";
            case PLACE -> "放置/右键"; case USE -> "使用物品/交互"; case ATTACK -> "攻击";
            case SELECT -> "选择快捷栏"; case DROP -> "丢弃物品"; case SWAP -> "交换副手";
            case INVENTORY -> "打开背包"; case CLOSE -> "关闭界面";
            case CLICK -> "操作背包槽位"; case CRAFT -> "填充合成配方"; case RECIPES -> "查询配方";
            case GUI_CLICK -> "点击界面"; case TEXT -> "输入文字"; case KEY -> "界面按键";
            case COMMAND -> "发送游戏指令"; case CHAT -> "发送游戏聊天"; case DONE -> "结束任务"; case SKILL -> "持续技能";
        };
    }
    private static void chat(String stage, String text) {
        if (!chatSummary) return;
        var player = Minecraft.getInstance().player;
        if (player != null) player.displayClientMessage(Component.literal("[MC Player Agent · " + stage + "] ")
                .withStyle(net.minecraft.ChatFormatting.AQUA)
                .append(Component.literal(PlayerPlan.displayText(text)).withStyle(net.minecraft.ChatFormatting.GRAY)), false);
    }
    private static float yaw() {
        float wrapped = Mth.wrapDegrees(owner.getYRot());
        return wrapped == -180 ? 180 : wrapped;
    }
    private static void say(String text) {
        status = text;
        var player = Minecraft.getInstance().player;
        if (player != null) player.displayClientMessage(Component.literal("[MC Player Agent] " + text), false);
    }
}
