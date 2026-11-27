/* SPDX-License-Identifier: LGPL-3.0-only
 * Local director integration tests, not live Minecraft acceptance.
 */
package dev.mcplayeragent.control;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class DirectorGatewayTest {
    static final String TOKEN="ab".repeat(32);
    final AtomicLong clock=new AtomicLong();
    final FakeHost host=new FakeHost();
    final HttpClient http=HttpClient.newHttpClient();
    DirectorGateway gateway;
    final class FakeHost implements DirectorGateway.Host {
        String world="save-A",mission="",state="";
        boolean ready=true,active,stopAcknowledged=true,startFails,partialStartFails;
        int starts,stops;
        final Thread owner=Thread.currentThread();
        public DirectorGateway.Snapshot snapshot() {
            assertSame(owner,Thread.currentThread());
            return new DirectorGateway.Snapshot(world,"World A",ready,active,mission,state,"");
        }
        public void start(String goal) {
            assertSame(owner,Thread.currentThread()); starts++;
            if(startFails) throw new IllegalStateException("rolled back");
            active=true;mission=UUID.randomUUID().toString();state="RUNNING";
            if(partialStartFails) throw new IllegalStateException("partial start");
        }
        public void stop(String reason) {
            assertSame(owner,Thread.currentThread()); stops++;
            if(stopAcknowledged) {active=false;state="INTERRUPTED";}
        }
    }
    @BeforeEach void open() throws Exception {gateway=new DirectorGateway(0,TOKEN,host,clock::get);gateway.tick();}
    @AfterEach void close() {gateway.close();}
    HttpResponse<String> call(String method,String route,String body,String token,boolean origin) throws Exception {
        var builder=HttpRequest.newBuilder(URI.create("http://127.0.0.1:"+gateway.port()+route))
                .header("Authorization","Bearer "+token).header("Content-Type","application/json");
        if(origin) builder.header("Origin","http://localhost");
        builder.method(method,body==null?HttpRequest.BodyPublishers.noBody():HttpRequest.BodyPublishers.ofString(body));
        return http.send(builder.build(),HttpResponse.BodyHandlers.ofString());
    }
    JsonObject get(String route) throws Exception {var r=call("GET",route,null,TOKEN,false);assertEquals(200,r.statusCode());return JsonParser.parseString(r.body()).getAsJsonObject();}
    JsonObject body(String id) {
        JsonObject b=new JsonObject();b.addProperty("id",id);b.addProperty("instanceId",gateway.instanceId());
        b.addProperty("worldId","save-A");b.addProperty("goal","Collect wood");b.addProperty("durationMs",1000);b.addProperty("controlRevision",0);return b;
    }
    String submit() throws Exception {
        String id=UUID.randomUUID().toString();assertEquals(202,call("POST","/requests",body(id).toString(),TOKEN,false).statusCode());return id;
    }
    JsonObject stop(String id) throws Exception {
        JsonObject b=new JsonObject();b.addProperty("instanceId",gateway.instanceId());
        var r=call("POST","/requests/"+id+"/stop",b.toString(),TOKEN,false);
        assertEquals(202,r.statusCode());return JsonParser.parseString(r.body()).getAsJsonObject();
    }
    String state(String id) throws Exception {return get("/requests/"+id).get("state").getAsString();}
    @Test void httpOnlyQueuesAndHostRunsOnTick() throws Exception {
        String id=submit();assertEquals(0,host.starts);assertEquals("QUEUED",state(id));
        gateway.tick();assertEquals(1,host.starts);assertEquals("RUNNING",state(id));
    }
    @Test void duplicateDoesNotRestartAndConflictingPayloadIsRejected() throws Exception {
        String id=submit();gateway.tick();
        assertEquals(202,call("POST","/requests",body(id).toString(),TOKEN,false).statusCode());gateway.tick();assertEquals(1,host.starts);
        JsonObject b=body(id);b.addProperty("goal","Other goal");
        assertEquals(409,call("POST","/requests",b.toString(),TOKEN,false).statusCode());
    }
    @Test void worldChangeRejectsQueuedTask() throws Exception {String id=submit();host.world="save-B";gateway.tick();assertEquals("FAILED",state(id));assertEquals(0,host.starts);}
    @Test void externalMissionIsNeverReplaced() throws Exception {String id=submit();host.active=true;host.mission="manual";gateway.tick();assertEquals("FAILED",state(id));assertEquals(0,host.starts);assertEquals(0,host.stops);}
    @Test void cancelBeforeLateSubmitCreatesTombstone() throws Exception {
        String id=UUID.randomUUID().toString();assertTrue(stop(id).get("releaseComplete").getAsBoolean());
        assertEquals(202,call("POST","/requests",body(id).toString(),TOKEN,false).statusCode());gateway.tick();assertEquals(0,host.starts);assertEquals("CANCELLED",state(id));
    }
    @Test void cancellationWaitsForHostRelease() throws Exception {
        String id=submit();gateway.tick();host.stopAcknowledged=false;stop(id);gateway.tick();
        assertEquals("STOPPING",state(id));assertFalse(get("/requests/"+id).get("releaseComplete").getAsBoolean());
        host.stopAcknowledged=true;gateway.tick();assertEquals("INTERRUPTED",state(id));assertEquals(2,host.stops);
    }
    @Test void durationExpiresBeforeStartWithoutAnyInput() throws Exception {String id=submit();clock.set(1_000_000_000L);gateway.tick();assertEquals("INTERRUPTED",state(id));assertEquals(0,host.starts);}
    @Test void runningDurationStopsHost() throws Exception {String id=submit();gateway.tick();clock.set(1_000_000_000L);gateway.tick();assertEquals("INTERRUPTED",state(id));assertEquals(1,host.stops);}
    @Test void lostOwnershipDoesNotStopReplacement() throws Exception {String id=submit();gateway.tick();host.mission="manual";stop(id);gateway.tick();assertEquals("INTERRUPTED",state(id));assertEquals(0,host.stops);}
    @Test void onlyActualSameMissionResultIsReported() throws Exception {String id=submit();gateway.tick();host.active=false;host.state="VERIFIED";gateway.tick();assertEquals("VERIFIED",state(id));}
    @Test void idleWithoutVerifiedReceiptIsInterrupted() throws Exception {String id=submit();gateway.tick();host.active=false;host.state="RUNNING";gateway.tick();assertEquals("INTERRUPTED",state(id));}
    @Test void manualStopCancelsQueuedRequests() throws Exception {String id=submit();gateway.cancelAll();gateway.tick();assertEquals("CANCELLED",state(id));assertEquals(0,host.starts);}
    @Test void staleHostIsNotReady() throws Exception {clock.set(2_000_000_000L);assertFalse(get("/status").get("ready").getAsBoolean());}
    @Test void malformedPayloadsAre400AndServiceRemainsAvailable() throws Exception {
        for(String payload:new String[]{"[]","null","{broken"}) assertEquals(400,call("POST","/requests",payload,TOKEN,false).statusCode());
        for(String value:new String[]{"null","[]","1.2","\"1000\""}) {
            JsonObject b=body(UUID.randomUUID().toString());b.add("durationMs",JsonParser.parseString(value));
            assertEquals(400,call("POST","/requests",b.toString(),TOKEN,false).statusCode());
        }
        assertTrue(get("/status").get("ready").getAsBoolean());
    }
    @Test void authenticationAndBrowserOriginAreRejected() throws Exception {
        assertEquals(403,call("GET","/status",null,"wrong",false).statusCode());
        assertEquals(403,call("GET","/status",null,TOKEN,true).statusCode());
    }
    @Test void instanceMismatchIsRejected() throws Exception {JsonObject b=body(UUID.randomUUID().toString());b.addProperty("instanceId",UUID.randomUUID().toString());assertEquals(409,call("POST","/requests",b.toString(),TOKEN,false).statusCode());}
    @Test void fullLedgerStillAcknowledgesUnknownCancellationAndRejectsLateStart() throws Exception {
        for(int i=0;i<128;i++) stop(UUID.randomUUID().toString());
        String id=UUID.randomUUID().toString();assertTrue(stop(id).get("releaseComplete").getAsBoolean());
        assertEquals(409,call("POST","/requests",body(id).toString(),TOKEN,false).statusCode());
    }
    @Test void atomicStartFailureDoesNotPretendToRun() throws Exception {host.startFails=true;String id=submit();gateway.tick();assertEquals("FAILED",state(id));assertFalse(host.active);}
    @Test void failedPartialStartRetainsOwnershipUntilInputStops() throws Exception {
        host.partialStartFails=true;host.stopAcknowledged=false;String id=submit();gateway.tick();
        assertEquals("STOPPING",state(id));assertFalse(get("/requests/"+id).get("releaseComplete").getAsBoolean());
        host.stopAcknowledged=true;gateway.tick();assertEquals("INTERRUPTED",state(id));assertFalse(host.active);
    }
    @Test void delayedStartCannotUndoF9AfterCancellationWasProcessed() throws Exception {
        JsonObject delayed=body(UUID.randomUUID().toString());gateway.cancelAll();gateway.tick();
        assertEquals(409,call("POST","/requests",delayed.toString(),TOKEN,false).statusCode());assertEquals(0,host.starts);
    }
}
