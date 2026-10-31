/* SPDX-License-Identifier: LGPL-3.0-only
 * Local director integration added by the AI_vtuber integration project.
 */
package dev.mcplayeragent.control;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonParseException;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutorService;
import java.util.function.LongSupplier;

/** HTTP only queues requests. All Host calls, including status, run from tick(). */
public final class DirectorGateway implements AutoCloseable {
    public record Snapshot(String worldId, String worldName, boolean ready, boolean active,
                           String missionId, String missionState, String reason) {}
    public interface Host {
        Snapshot snapshot();
        void start(String goal);
        void stop(String reason);
    }
    private static final Set<String> TERMINAL = Set.of("VERIFIED", "UNVERIFIED", "INTERRUPTED", "FAILED", "CANCELLED");
    private static final int CAPACITY = 128;
    private final String instanceId = UUID.randomUUID().toString();
    private final byte[] token;
    private final Host host;
    private final LongSupplier clock;
    private final Map<String, Request> requests = new LinkedHashMap<>();
    private final HttpServer server;
    private final ExecutorService workers;
    private Snapshot observed = new Snapshot("", "", false, false, "", "", "WAITING_FOR_CLIENT_TICK");
    private long lastTick = Long.MIN_VALUE;
    private boolean closed;
    private long controlRevision;
    private Thread owner;

    private final class Request {
        final String id, world, goal;
        final long accepted, duration;
        String state = "QUEUED", mission = "", reason = "";
        boolean cancel;
        Request(String id, String world, String goal, long accepted, long duration) {
            this.id=id; this.world=world; this.goal=goal; this.accepted=accepted; this.duration=duration;
        }
        JsonObject json() {
            JsonObject out=new JsonObject(); out.addProperty("id",id); out.addProperty("state",state);
            out.addProperty("instanceId",instanceId); out.addProperty("worldId",world);
            out.addProperty("missionId",mission); out.addProperty("reason",reason);
            out.addProperty("releaseComplete",TERMINAL.contains(state)); return out;
        }
    }
    public DirectorGateway(int port, String secret, Host host) throws IOException {
        this(port,secret,host,System::nanoTime);
    }
    public DirectorGateway(int port, String secret, Host host, LongSupplier clock) throws IOException {
        if(!secret.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("Expected a 256-bit local token");
        this.token=("Bearer "+secret).getBytes(StandardCharsets.UTF_8); this.host=host; this.clock=clock;
        server=HttpServer.create(new InetSocketAddress("127.0.0.1",port),8);
        workers=Executors.newFixedThreadPool(4,r->{Thread t=new Thread(r,"mcplayer-director-http");t.setDaemon(true);return t;});
        server.setExecutor(workers); server.createContext("/",this::handle); server.start();
    }
    public int port() { return server.getAddress().getPort(); }
    public String instanceId() { return instanceId; }

    /** Invoke on the same host thread every client tick, even when no mission is active. */
    public synchronized void tick() {
        if(owner==null) owner=Thread.currentThread();
        if(owner!=Thread.currentThread()) throw new IllegalStateException("Director host thread changed");
        long now=clock.getAsLong(); observed=host.snapshot(); lastTick=now;
        for(Request r:requests.values()) {
            if(TERMINAL.contains(r.state)) continue;
            if(r.state.equals("QUEUED")) {
                if(r.cancel||closed) { end(r,"CANCELLED","CANCELLED_BEFORE_START"); continue; }
                if(now-r.accepted>=Math.min(10_000L,r.duration)*1_000_000L) { end(r,"INTERRUPTED","START_EXPIRED"); continue; }
                if(!observed.ready()||observed.active()||!r.world.equals(observed.worldId())) {
                    end(r,"FAILED","WORLD_OR_CONTROL_NOT_READY"); continue;
                }
                // No other host mutation runs between start and this snapshot.
                // Retain ownership if a failed start left native input active.
                try { host.start(r.goal); observed=host.snapshot(); }
                catch(RuntimeException error) {
                    observed=host.snapshot();
                    if(!observed.active()||!r.world.equals(observed.worldId())) { end(r,"FAILED","HOST_START_FAILED"); continue; }
                    r.cancel=true;
                }
                if(!observed.active()||!r.world.equals(observed.worldId())) {
                    end(r,"FAILED","HOST_DID_NOT_START"); continue;
                }
                if(observed.missionId().isBlank()) r.cancel=true;
                r.mission=observed.missionId(); r.state="RUNNING";
            }
            // Never stop or attribute the result of a mission started via another entry point.
            if(!r.mission.equals(observed.missionId())||!r.world.equals(observed.worldId())) {
                end(r,"INTERRUPTED","MISSION_OWNERSHIP_CHANGED"); continue;
            }
            if(!observed.active()) {
                String state=Set.of("VERIFIED","UNVERIFIED","INTERRUPTED").contains(observed.missionState())?observed.missionState():"INTERRUPTED";
                end(r,state,"HOST_MISSION_ENDED"); continue;
            }
            if(r.cancel||closed||now-r.accepted>=r.duration*1_000_000L) {
                r.state="STOPPING";
                try { host.stop("导演任务停止或时限已到"); observed=host.snapshot(); }
                catch(RuntimeException error) { r.reason="HOST_STOP_PENDING"; continue; }
                if(!observed.active()||!r.mission.equals(observed.missionId())) end(r,"INTERRUPTED","DIRECTOR_STOPPED");
            }
        }
        observed=host.snapshot();
    }
    private static void end(Request r,String state,String reason) { r.state=state; r.reason=reason; }
    private synchronized JsonObject status() {
        JsonObject out=new JsonObject(); out.addProperty("protocol",1); out.addProperty("instanceId",instanceId);
        out.addProperty("controlRevision",controlRevision);
        boolean fresh=lastTick!=Long.MIN_VALUE&&clock.getAsLong()-lastTick<2_000_000_000L;
        out.addProperty("hostFresh",fresh); out.addProperty("ready",!closed&&fresh&&observed.ready());
        out.addProperty("active",observed.active()); out.addProperty("worldId",observed.worldId());
        out.addProperty("worldName",observed.worldName()); out.addProperty("missionId",observed.missionId());
        out.addProperty("missionState",observed.missionState()); out.addProperty("reason",observed.reason()); return out;
    }
    private synchronized JsonObject submit(JsonObject body) {
        exact(body,Set.of("id","instanceId","worldId","goal","durationMs","controlRevision")); checkInstance(body);
        String id=uuid(body,"id"),world=string(body,"worldId",128),goal=string(body,"goal",1000).strip();
        if(world.isBlank()||goal.isBlank()) throw new IllegalArgumentException("World and goal are required");
        if(!body.get("durationMs").isJsonPrimitive()||!body.getAsJsonPrimitive("durationMs").isNumber()) throw new IllegalArgumentException("Expected numeric duration");
        long duration=body.get("durationMs").getAsBigDecimal().longValueExact();
        if(duration<1000||duration>1_200_000) throw new IllegalArgumentException("Invalid mission duration");
        Request old=requests.get(id);
        if(old!=null) {
            if(old.cancel&&old.goal.isEmpty()) return old.json(); // Cancellation tombstone.
            if(!old.world.equals(world)||!old.goal.equals(goal)||old.duration!=duration) throw new Conflict("Request id already used");
            return old.json();
        }
        if(!body.get("controlRevision").isJsonPrimitive()||!body.getAsJsonPrimitive("controlRevision").isNumber()||
                body.get("controlRevision").getAsBigDecimal().longValueExact()!=controlRevision) throw new Conflict("Manual control changed");
        if(closed||requests.size()>=CAPACITY) throw new Conflict("Director request capacity reached");
        Request request=new Request(id,world,goal,clock.getAsLong(),duration); requests.put(id,request); return request.json();
    }
    private synchronized JsonObject cancel(String id,JsonObject body) {
        exact(body,Set.of("instanceId")); checkInstance(body);
        Request r=requests.get(id);
        if(r==null) {
            r=new Request(id,"","",clock.getAsLong(),0); r.cancel=true; end(r,"CANCELLED","CANCELLED_BEFORE_START");
            // At capacity the immutable ledger rejects every new submit for the
            // life of this instance, so even a late POST cannot start this id.
            if(requests.size()<CAPACITY) requests.put(id,r); return r.json();
        }
        r.cancel=true;
        if(r.state.equals("RUNNING")) r.state="STOPPING";
        return r.json();
    }
    private void checkInstance(JsonObject body) {
        if(!instanceId.equals(string(body,"instanceId",36))) throw new Conflict("Director instance changed");
    }
    private synchronized JsonObject request(String id) { Request r=requests.get(id); return r==null?null:r.json(); }
    private static String uuid(JsonObject body,String key) {
        String id=string(body,key,36); if(!UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException("Invalid request id"); return id;
    }
    private static String string(JsonObject body,String key,int max) {
        if(!body.has(key)||!body.get(key).isJsonPrimitive()||!body.getAsJsonPrimitive(key).isString()) throw new IllegalArgumentException("Expected string: "+key);
        String value=body.get(key).getAsString(); if(value.length()>max) throw new IllegalArgumentException("Value too long: "+key); return value;
    }
    private static void exact(JsonObject body,Set<String> keys) {
        if(!body.keySet().equals(keys)) throw new IllegalArgumentException("Unexpected request fields");
    }
    private static final class Conflict extends IllegalArgumentException { Conflict(String message) { super(message); } }
    private boolean trusted(HttpExchange exchange) {
        String hostHeader=exchange.getRequestHeaders().getFirst("Host");
        String auth=exchange.getRequestHeaders().getFirst("Authorization");
        return exchange.getRemoteAddress().getAddress().isLoopbackAddress()
                && ("127.0.0.1:"+port()).equals(hostHeader) && !exchange.getRequestHeaders().containsKey("Origin")
                && auth!=null && MessageDigest.isEqual(token,auth.getBytes(StandardCharsets.UTF_8));
    }
    private static JsonObject body(HttpExchange exchange) throws IOException {
        String type=exchange.getRequestHeaders().getFirst("Content-Type"),length=exchange.getRequestHeaders().getFirst("Content-Length");
        if(type==null||!type.startsWith("application/json")||length==null||exchange.getRequestHeaders().containsKey("Transfer-Encoding")) throw new IllegalArgumentException("Bounded JSON required");
        int size=Integer.parseInt(length); if(size<2||size>8192) throw new IllegalArgumentException("Request body too large");
        byte[] bytes=exchange.getRequestBody().readNBytes(size); if(bytes.length!=size) throw new IllegalArgumentException("Incomplete request");
        var value=JsonParser.parseString(new String(bytes,StandardCharsets.UTF_8));
        if(!value.isJsonObject()) throw new IllegalArgumentException("Expected JSON object");
        return value.getAsJsonObject();
    }
    private void handle(HttpExchange exchange) throws IOException {
        try {
            if(!trusted(exchange)) { reply(exchange,403,"{\"error\":\"Local authenticated client required\"}"); return; }
            String route=exchange.getRequestURI().getPath(),method=exchange.getRequestMethod();
            if(exchange.getRequestURI().getRawQuery()!=null) throw new IllegalArgumentException("Query parameters are not supported");
            if(method.equals("GET")&&route.equals("/status")) { reply(exchange,200,status().toString()); return; }
            if(method.equals("POST")&&route.equals("/requests")) { reply(exchange,202,submit(body(exchange)).toString()); return; }
            String[] parts=route.split("/");
            if(parts.length>=3&&parts[1].equals("requests")) {
                String id=parts[2]; if(!UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException("Invalid id");
                if(parts.length==4&&parts[3].equals("stop")&&method.equals("POST")) { reply(exchange,202,cancel(id,body(exchange)).toString()); return; }
                if(parts.length==3&&method.equals("GET")) {
                    JsonObject result=request(id); reply(exchange,result==null?404:200,result==null?"{\"error\":\"Unknown request\"}":result.toString()); return;
                }
            }
            reply(exchange,404,"{\"error\":\"Unknown route\"}");
        } catch(IllegalArgumentException|IllegalStateException|ArithmeticException|JsonParseException error) {
            reply(exchange,error instanceof Conflict?409:400,"{\"error\":\"Invalid or conflicting request\"}");
        } finally { exchange.close(); }
    }
    private static void reply(HttpExchange exchange,int code,String text) throws IOException {
        byte[] bytes=text.getBytes(StandardCharsets.UTF_8); exchange.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");
        exchange.getResponseHeaders().set("Cache-Control","no-store"); exchange.sendResponseHeaders(code,bytes.length); exchange.getResponseBody().write(bytes);
    }
    /** Called by the host for F8/F9, before tick, so queued starts cannot undo a manual stop. */
    public synchronized void cancelAll() { controlRevision++; for(Request r:requests.values()) r.cancel=true; }
    @Override public void close() {
        synchronized(this) { closed=true; cancelAll(); }
        server.stop(0); workers.shutdownNow();
    }
}
