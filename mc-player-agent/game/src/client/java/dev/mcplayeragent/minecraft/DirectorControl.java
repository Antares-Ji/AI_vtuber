/* SPDX-License-Identifier: LGPL-3.0-only
 * Local director integration added by the AI_vtuber integration project.
 */
package dev.mcplayeragent.minecraft;

import com.google.gson.JsonParser;
import dev.mcplayeragent.control.DirectorGateway;
import dev.mcplayeragent.harness.AgentProfile;
import dev.mcplayeragent.harness.PlayerModelConnection.Backend;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;
import net.minecraft.client.Minecraft;
import net.minecraft.world.level.storage.LevelResource;
import org.slf4j.LoggerFactory;

/** Optional loopback task API; all game access stays on the normal client tick. */
public final class DirectorControl implements DirectorGateway.Host {
    private static DirectorGateway gateway;
    private Object saveServer;
    private String worldId="";
    private DirectorControl() {}
    public static void initialize() {
        var config=AgentPaths.clientDir().resolve("director.json");
        if(!Files.isRegularFile(config)||gateway!=null) return;
        try {
            var settings=JsonParser.parseString(Files.readString(config)).getAsJsonObject();
            if(!settings.has("enabled")||!settings.get("enabled").getAsBoolean()) return;
            int port=settings.has("port")?settings.get("port").getAsInt():17650;
            if(port<1024||port>65535) throw new IllegalArgumentException("Invalid director port");
            var tokenFile=AgentPaths.clientDir().resolve("director-token.txt");
            if(!Files.exists(tokenFile)) {
                byte[] bytes=new byte[32];new SecureRandom().nextBytes(bytes);
                Files.writeString(tokenFile,HexFormat.of().formatHex(bytes),StandardOpenOption.CREATE_NEW);
            }
            String token=Files.readString(tokenFile).strip();
            gateway=new DirectorGateway(port,token,new DirectorControl());
            Runtime.getRuntime().addShutdownHook(new Thread(()->gateway.close(),"mcplayer-director-shutdown"));
            LoggerFactory.getLogger("mcplayeragent").info("Local director task API listening on port {}",port);
        } catch(Exception error) {
            // No token, model key, user goal or filesystem location is logged.
            LoggerFactory.getLogger("mcplayeragent").warn("Local director task API unavailable ({})",error.getClass().getSimpleName());
        }
    }
    public static void cancelAll() { if(gateway!=null) gateway.cancelAll(); }
    public static void tick() { if(gateway!=null) gateway.tick(); }
    @Override public DirectorGateway.Snapshot snapshot() {
        var mc=Minecraft.getInstance();var server=mc.getSingleplayerServer();
        if(server==null||mc.player==null||mc.level==null) {
            saveServer=null;worldId="";
            return new DirectorGateway.Snapshot("","",false,PlayerControl.active(),"","","NO_LOCAL_WORLD");
        }
        if(saveServer!=server) {
            try {
                String save=server.getWorldPath(LevelResource.ROOT).toRealPath().toString();
                worldId=HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(save.getBytes(StandardCharsets.UTF_8)));
                saveServer=server;
            } catch(Exception error) {return new DirectorGateway.Snapshot("","",false,PlayerControl.active(),"","","SAVE_UNAVAILABLE");}
        }
        var record=MissionRecording.view();
        String mission=record.has("mission_id")?record.get("mission_id").getAsString():"";
        String state=record.has("state")?record.get("state").getAsString():"";
        boolean configured=PlayerControl.backend()==Backend.DEEPSEEK&&PlayerControl.hasDeepSeekKey();
        boolean foreground=mc.isWindowActive()&&mc.screen==null;
        String reason=!configured?"DEEPSEEK_NOT_CONFIGURED":!foreground?"GAME_NOT_READY":"";
        return new DirectorGateway.Snapshot(worldId,server.getWorldData().getLevelName(),configured&&foreground,
                PlayerControl.active(),mission,state,reason);
    }
    @Override public void start(String goal) {
        if(PlayerControl.active()||!snapshot().ready()) throw new IllegalStateException("Client unavailable");
        try {
            // Read the actual profile again at execution time, before changing the
            // saved agenda. The HTTP API cannot select a provider or submit keys.
            if(AgentProfile.load(AgentPaths.clientDir().resolve("player-control.json")).connection().backend()!=Backend.DEEPSEEK)
                throw new IllegalStateException("DeepSeek required");
            if(!PlayerControl.configureGoal(goal)) throw new IllegalStateException("Invalid profile or goal");
            PlayerControl.start();
            if(PlayerControl.backend()!=Backend.DEEPSEEK) throw new IllegalStateException("Provider changed");
        } catch(Exception error) {
            if(PlayerControl.active()) PlayerControl.stop("导演任务启动失败");
            throw new IllegalStateException("Director start failed");
        }
    }
    @Override public void stop(String reason) { PlayerControl.stop(reason); }
}
