/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.mission;
import com.google.gson.*;
import java.nio.file.*;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;
class MissionRunTest {
    @TempDir Path root;
    @Test void configurationRecordsOnlyFingerprintAndSkillVersionsAndCannotBeRewritten() throws Exception {
        try (var r=run("profile")) {
            var profile=dev.mcplayeragent.harness.AgentProfile.defaults().withOverrides(JsonParser.parseString("{\"prompt\":\"private instructions\"}").getAsJsonObject());
            var skills=JsonParser.parseString("[{\"id\":\"example:test\",\"version\":\"1\",\"description\":\"private description\"}]").getAsJsonArray();
            r.configuration(profile.fingerprint(),skills); skills.get(0).getAsJsonObject().addProperty("version","changed");
            assertThrows(IllegalStateException.class,()->r.configuration(profile.fingerprint(),skills));
            r.interrupted("stop"); String stored=saved(r).toString();
            assertTrue(stored.contains(profile.fingerprint())); assertFalse(stored.contains("private")); assertFalse(stored.contains("changed"));
            assertEquals("1",saved(r).getAsJsonArray("skills").get(0).getAsJsonObject().get("version").getAsString());
        }
    }
    private MissionRun run(String world) { return MissionRun.start(root.resolve(world),world,"minecraft:overworld","collect 8 logs","OLLAMA","test-model"); }
    private JsonObject saved(MissionRun r) throws Exception {
        r.flushed().get(5,TimeUnit.SECONDS); return JsonParser.parseString(Files.readString(r.directory().resolve("summary.json"))).getAsJsonObject();
    }
    @Test void modelDoneWithoutLocalEvidenceCannotBeRecordedAsVerified() throws Exception {
        try(var r=run("a")) {
            r.step("DONE","",MissionRun.Result.SENT_UNCONFIRMED,"no acceptance condition",17);
            r.completed(false,"model declaration only");
            assertEquals("UNVERIFIED",saved(r).get("state").getAsString());
            assertEquals(1,saved(r).get("unconfirmed_steps").getAsInt());
        }
    }
    @Test void interruptAndLateCallbacksCannotChangeACompletedRun() throws Exception {
        try(var r=run("a")) {
            r.completed(true,"inventory matched"); r.interrupted("user opened panel"); r.request(false,999,true);
            assertEquals("VERIFIED",saved(r).get("state").getAsString());
            assertEquals(0,saved(r).get("model_requests").getAsInt());
        }
    }
    @Test void separateWorldsAndRepeatedMissionsNeverShareEventFiles() throws Exception {
        try(var a=run("a");var b=run("b");var again=run("a")) {
            a.interrupted("manual stop");b.interrupted("stop");again.interrupted("stop");
            assertNotEquals(a.directory(),b.directory());assertNotEquals(a.directory(),again.directory());
            assertEquals("a",saved(a).get("world_context").getAsString());
            assertEquals("b",saved(b).get("world_context").getAsString());
        }
    }
    @Test void orderedEventsAndLatencyStatisticsSurviveFlush() throws Exception {
        try(var r=run("a")) {
            r.request(false,100,true);r.request(true,300,false);
            r.plan("collect wood",2,false);
            r.step("BREAK","harvest_tree",MissionRun.Result.SUCCEEDED,"block became air",20);
            r.step("MOVE","",MissionRun.Result.NO_PROGRESS,"blocked",21);r.interrupted("stop");
            var s=saved(r);assertEquals(2,s.get("steps").getAsInt());assertEquals(1,s.get("failed_steps").getAsInt());
            assertEquals(200,s.get("average_model_ms").getAsLong());
            var lines=Files.readAllLines(r.directory().resolve("events.jsonl"));
            for(int i=0;i<lines.size();i++) assertEquals(i+1,JsonParser.parseString(lines.get(i)).getAsJsonObject().get("sequence").getAsInt());
            assertEquals("",r.problem());
        }
    }
    @Test void diskFailureIsReportedWithoutBreakingMissionExecution() throws Exception {
        Path file=root.resolve("not-directory");Files.writeString(file,"x");
        try(var r=MissionRun.start(file,"a","minecraft:overworld","test","OLLAMA","test")) {
            r.step("MOVE","",MissionRun.Result.NO_PROGRESS,"blocked",1);r.interrupted("stop");
            assertThrows(java.util.concurrent.ExecutionException.class,()->r.flushed().get(5,TimeUnit.SECONDS));
            assertFalse(r.problem().isEmpty());assertEquals("INTERRUPTED",r.snapshot().get("state").getAsString());
        }
    }
}
