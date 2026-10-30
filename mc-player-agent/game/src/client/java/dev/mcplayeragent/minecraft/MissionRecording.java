/* SPDX-License-Identifier: LGPL-3.0-only
 * MC Player Agent mission subsystem, implemented in the independent project.
 */
package dev.mcplayeragent.minecraft;
import dev.mcplayeragent.mission.MissionRun;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.world.level.storage.LevelResource;
/** The controller supplies actual receipts; this adapter never receives keys or raw model responses. */
public final class MissionRecording {
    private static MissionRun run;
    private MissionRecording() {}
    public static MissionRun start(String goal,String world,String provider,String model) {
        if(run!=null) run.interrupted("Started another mission");
        var mc=Minecraft.getInstance();
        run=MissionRun.start(mc.getSingleplayerServer().getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize(),world,
                mc.level.dimension().location().toString(),goal,provider,model);
        return run;
    }
    public static void interrupted(String reason) { if(run!=null) run.interrupted(reason); }
    public static JsonObject view() {
        var server=Minecraft.getInstance().getSingleplayerServer();
        if(run==null||server==null||!run.directory().startsWith(server.getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize())) return new JsonObject();
        JsonObject result=run.snapshot(); result.addProperty("record_directory",run.directory().toString());
        result.addProperty("record_problem",run.problem()); return result;
    }
}
