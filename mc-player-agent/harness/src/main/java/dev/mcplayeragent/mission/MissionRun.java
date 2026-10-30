/* SPDX-License-Identifier: LGPL-3.0-only
 * MC Player Agent mission subsystem, implemented in the independent project.
 */
package dev.mcplayeragent.mission;

import com.google.gson.*;
import java.nio.file.*;
import java.io.IOException;
import java.util.UUID;
import java.util.concurrent.*;

/** One immutable mission identity. A model declaration alone is never verified success. */
public final class MissionRun implements AutoCloseable {
    public enum State { RUNNING, VERIFIED, UNVERIFIED, INTERRUPTED }
    public enum Result { SUCCEEDED, ALREADY_SATISFIED, FAILED, TIMED_OUT, NO_PROGRESS, SENT_UNCONFIRMED, CONTINUING }
    private final String id=UUID.randomUUID().toString();
    private final Path directory;
    private final long started=System.currentTimeMillis();
    private final JsonObject summary=new JsonObject();
    private final ThreadPoolExecutor writer=new ThreadPoolExecutor(1,1,0,TimeUnit.SECONDS,new ArrayBlockingQueue<>(256),
            Thread.ofPlatform().daemon(true).name("mcplayeragent-journal-",0).factory(),new ThreadPoolExecutor.AbortPolicy());
    private CompletableFuture<Void> tail=CompletableFuture.completedFuture(null);
    private volatile String problem="";
    private State state=State.RUNNING;
    private long sequence,steps,success,failed,unconfirmed,requests,requestMillis;

    private MissionRun(Path save,String world,String dimension,String goal,String provider,String model) {
        directory=save.resolve("mcplayeragent/runs").resolve(id);
        summary.addProperty("schema",1); summary.addProperty("mission_id",id);
        summary.addProperty("world_context",world); summary.addProperty("initial_dimension",dimension);
        summary.addProperty("goal",goal); summary.addProperty("provider",provider); summary.addProperty("model",model);
        summary.addProperty("started_at",java.time.Instant.ofEpochMilli(started).toString());
        emit("MISSION_STARTED",new JsonObject());
    }
    public static MissionRun start(Path save,String world,String dimension,String goal,String provider,String model) {
        if(goal==null||goal.isBlank()) throw new IllegalArgumentException("Mission goal cannot be blank");
        return new MissionRun(save,world,dimension,goal,provider,model);
    }
    public Path directory() { return directory; }
    public String problem() { return problem; }
    public synchronized JsonObject snapshot() { update(); return summary.deepCopy(); }
    public synchronized void configuration(String fingerprint, JsonArray skills) {
        if (state != State.RUNNING || summary.has("profile_sha256")) throw new IllegalStateException("Configuration already recorded or mission ended");
        if (fingerprint == null || !fingerprint.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Expected SHA-256 profile fingerprint");
        JsonArray versions = new JsonArray();
        for (JsonElement entry : skills) {
            JsonObject skill = entry.getAsJsonObject(), version = new JsonObject();
            version.add("id", skill.get("id").deepCopy()); version.add("version", skill.get("version").deepCopy()); versions.add(version);
        }
        summary.addProperty("profile_sha256", fingerprint); summary.add("skills", versions);
        emit("CONFIGURATION", new JsonObject());
    }
    private void update() {
        summary.addProperty("state",state.name()); summary.addProperty("events",sequence);
        summary.addProperty("steps",steps); summary.addProperty("successful_steps",success);
        summary.addProperty("failed_steps",failed); summary.addProperty("unconfirmed_steps",unconfirmed);
        summary.addProperty("model_requests",requests); summary.addProperty("model_ms",requestMillis);
        summary.addProperty("average_model_ms",requests==0?0:requestMillis/requests);
        if(state==State.RUNNING) summary.addProperty("elapsed_ms",Math.max(0,System.currentTimeMillis()-started));
    }
    public synchronized void request(boolean review,long millis,boolean ok) {
        if(state!=State.RUNNING) return;
        requests++; requestMillis+=Math.max(0,millis);
        JsonObject e=new JsonObject(); e.addProperty("review",review); e.addProperty("latency_ms",Math.max(0,millis));
        e.addProperty("ok",ok); emit("MODEL_RESPONSE",e);
    }
    public synchronized void plan(String phase,int count,boolean review) {
        if(state!=State.RUNNING) return;
        summary.addProperty("phase",phase); JsonObject e=new JsonObject(); e.addProperty("phase",phase);
        e.addProperty("actions",count); e.addProperty("review",review); emit("PLAN_ACCEPTED",e);
    }
    public synchronized void step(String action,String skill,Result result,String reason,long serverTick) {
        if(state!=State.RUNNING) return;
        steps++;
        switch(result) {
            case SUCCEEDED,ALREADY_SATISFIED -> success++;
            case FAILED,TIMED_OUT,NO_PROGRESS -> failed++;
            case SENT_UNCONFIRMED -> unconfirmed++;
            default -> {}
        }
        JsonObject e=new JsonObject(); e.addProperty("action",action); e.addProperty("skill",skill);
        e.addProperty("result",result.name()); e.addProperty("reason",reason); e.addProperty("server_tick",serverTick);
        summary.addProperty("last_action",action); summary.addProperty("last_result",result.name());
        summary.addProperty("last_reason",reason); emit("STEP_RESULT",e);
    }
    public synchronized void transition(String kind,String detail) {
        if(state!=State.RUNNING) return;
        if(!java.util.Set.of("SKILL_STARTED","SKILL_FINISHED","EMERGENCY","WORLD_CHANGED").contains(kind))
            throw new IllegalArgumentException("Unknown transition");
        JsonObject e=new JsonObject(); e.addProperty("detail",detail); emit(kind,e);
    }
    /** verified must originate from the local acceptance-condition check, never from the model. */
    public synchronized void completed(boolean verified,String reason) {
        finish(verified?State.VERIFIED:State.UNVERIFIED,reason);
    }
    public synchronized void interrupted(String reason) { finish(State.INTERRUPTED,reason); }
    private void finish(State end,String reason) {
        if(state!=State.RUNNING) return;
        state=end; summary.addProperty("end_reason",reason);
        summary.addProperty("elapsed_ms",Math.max(0,System.currentTimeMillis()-started));
        summary.addProperty("ended_at",java.time.Instant.now().toString());
        emit("MISSION_ENDED",new JsonObject()); writer.shutdown();
    }
    private void emit(String type,JsonObject payload) {
        payload.addProperty("sequence",++sequence); payload.addProperty("type",type);
        payload.addProperty("mission_id",id); payload.addProperty("at",java.time.Instant.now().toString());
        update(); String line=payload+"\n",snapshot=summary.toString();
        try {
            tail=CompletableFuture.runAsync(()->{
                try {
                    Files.createDirectories(directory);
                    Files.writeString(directory.resolve("events.jsonl"),line,StandardOpenOption.CREATE,StandardOpenOption.APPEND);
                    Path temp=directory.resolve("summary.json.tmp"),target=directory.resolve("summary.json");
                    Files.writeString(temp,snapshot);
                    try { Files.move(temp,target,StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE); }
                    catch(AtomicMoveNotSupportedException e) { Files.move(temp,target,StandardCopyOption.REPLACE_EXISTING); }
                } catch(IOException e) { problem="任务记录写入失败："+e.getClass().getSimpleName(); throw new CompletionException(e); }
            },writer);
        } catch(RejectedExecutionException e) {
            problem="任务记录队列已满，部分事件未保存";
            tail=CompletableFuture.failedFuture(e);
        }
    }
    /** For tests/tools; callers on the game thread must not block on this future. */
    public synchronized CompletableFuture<Void> flushed() { return tail; }
    @Override public void close() { interrupted("Recorder closed"); }
}
