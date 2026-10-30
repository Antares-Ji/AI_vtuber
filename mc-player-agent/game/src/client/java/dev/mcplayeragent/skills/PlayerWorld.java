/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import dev.mcplayeragent.harness.PlayerEvidence.Point;
import com.google.gson.*;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.storage.LevelResource;
import net.minecraft.world.phys.*;
import java.nio.file.*;
import java.util.*;

/** Surface resources seen by rays and an exploration journal, isolated by save, dimension and player. */
final class PlayerWorld {
    private final Minecraft mc = Minecraft.getInstance();
    private final Map<BlockPos, Long> logs = new LinkedHashMap<>(), hints = new LinkedHashMap<>();
    private final Set<Long> explored = new HashSet<>();
    private final Map<BlockPos,JsonObject> minerals=new LinkedHashMap<>();
    private Path file;
    private Path agendaFile;
    private long lastScan = -1000;
    private int direction;
    private JsonObject agenda = new JsonObject();
    private JsonObject landmarks=new JsonObject();
    private JsonArray events=new JsonArray();
    private String worldId="",worldKey="",worldName="";
    private net.minecraft.server.MinecraftServer boundServer;
    private String context="";
    private static BlockPos pos(JsonObject o) { return new BlockPos(o.get("x").getAsInt(),o.get("y").getAsInt(),o.get("z").getAsInt()); }
    private void bind() {
        if (mc.player == null || mc.getSingleplayerServer() == null) return;
        String current=mc.player.getUUID()+"|"+mc.level.dimension().location();
        if(boundServer==mc.getSingleplayerServer()&&current.equals(context)) return;
        worldName=mc.getSingleplayerServer().getWorldData().getLevelName();
        var binding=WorldJournal.bind(mc.getSingleplayerServer().getWorldPath(LevelResource.ROOT),mc.player.getUUID(),mc.level.dimension().location().toString(),worldName);
        Path next=binding.file();
        boundServer=mc.getSingleplayerServer(); context=current;
        file=next; agendaFile=binding.agenda(); logs.clear(); hints.clear(); explored.clear(); minerals.clear(); agenda=new JsonObject(); lastScan=-1000; direction=0;
        worldId=binding.worldId(); worldKey=binding.key(); landmarks=new JsonObject(); events=new JsonArray();
        if (Files.exists(file)) try {
            JsonObject saved=JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            for (JsonElement e:saved.getAsJsonArray("logs")) { JsonObject o=e.getAsJsonObject(); logs.put(pos(o),o.get("seen").getAsLong()); }
            for (JsonElement e:saved.getAsJsonArray("hints")) { JsonObject o=e.getAsJsonObject(); hints.put(pos(o),o.get("seen").getAsLong()); }
            for (JsonElement e:saved.getAsJsonArray("explored")) explored.add(e.getAsLong());
            direction=saved.get("direction").getAsInt();
            if (saved.has("agenda")) agenda=saved.getAsJsonObject("agenda");
            if(saved.has("landmarks")) landmarks=saved.getAsJsonObject("landmarks");
            if(saved.has("events")) events=saved.getAsJsonArray("events");
            if(saved.has("minerals")) for(JsonElement e:saved.getAsJsonArray("minerals")) { var o=e.getAsJsonObject(); minerals.put(pos(o),o); }
        } catch (Exception e) { throw new IllegalStateException("Cannot read player world memory: "+file,e); }
        if(Files.exists(agendaFile)) agenda=WorldJournal.read(agendaFile);
        else if(!agenda.isEmpty()) WorldJournal.write(agendaFile,agenda);
    }
    JsonObject observe() {
        bind(); if (file==null) return new JsonObject();
        scan(); JsonObject o = new JsonObject(); o.add("visible_or_remembered_logs",entries(logs));
        o.add("tree_hints",entries(hints)); o.addProperty("explored_sectors",explored.size());
        o.addProperty("exploration_direction",direction); o.add("agenda",agenda.deepCopy());
        o.addProperty("resource_range",64); o.addProperty("rule","Only line-of-sight observations; old sightings must be rechecked. Tree hints may be leaves without a confirmed trunk.");
        o.addProperty("world_id",worldId); o.addProperty("world_key",worldKey); o.addProperty("world_name",worldName);
        o.addProperty("dimension",mc.level.dimension().location().toString()); o.add("landmarks",landmarks.deepCopy()); o.add("events",events.deepCopy());
        JsonArray ore=new JsonArray(); minerals.values().stream().limit(64).forEach(ore::add); o.add("observed_minerals",ore);
        JsonArray drops=new JsonArray(); mc.level.getEntitiesOfClass(net.minecraft.world.entity.item.ItemEntity.class,mc.player.getBoundingBox().inflate(16),e->e.isAlive()&&visible(e.blockPosition()))
                .stream().sorted(Comparator.comparingDouble(mc.player::distanceToSqr)).limit(32).forEach(e->{
                    JsonObject d=new JsonObject(); d.addProperty("uuid",e.getUUID().toString()); d.addProperty("item",net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(e.getItem().getItem()).toString());
                    d.addProperty("count",e.getItem().getCount()); d.addProperty("x",e.getX()); d.addProperty("y",e.getY()); d.addProperty("z",e.getZ());
                    d.addProperty("moving",e.getDeltaMovement().lengthSqr()>.01); d.addProperty("capacity_estimate",PlayerInventoryTasks.capacity(e.getItem())); drops.add(d);
                }); o.add("visible_drops",drops);
        return o;
    }
    void remember(JsonObject value) { bind(); agenda=value.deepCopy(); WorldJournal.write(agendaFile,agenda); save(); }
    void event(String kind,String detail,BlockPos at) {
        bind(); JsonObject e=new JsonObject(); e.addProperty("kind",kind); e.addProperty("detail",detail);
        e.addProperty("x",at.getX()); e.addProperty("y",at.getY()); e.addProperty("z",at.getZ()); e.addProperty("tick",mc.level.getGameTime());
        events.add(e); while(events.size()>32) events.remove(0);
        if(kind.equals("DEAD")) landmarks.add("last_death",e.deepCopy()); save();
    }
    void shelter(BlockPos center) {
        bind(); JsonObject o=new JsonObject(); o.addProperty("x",center.getX()); o.addProperty("y",center.getY()); o.addProperty("z",center.getZ());
        o.addProperty("verified_tick",mc.level.getGameTime()); landmarks.add("shelter",o); save();
    }
    BlockPos shelter() { bind(); return landmarks.has("shelter")?pos(landmarks.getAsJsonObject("shelter")):null; }
    String key() { bind(); return worldKey; }
    void landmark(String name,BlockPos p) { bind(); JsonObject o=new JsonObject(); o.addProperty("x",p.getX()); o.addProperty("y",p.getY()); o.addProperty("z",p.getZ()); o.addProperty("tick",mc.level.getGameTime()); landmarks.add(name,o); save(); }
    BlockPos landmark(String name) { bind(); return landmarks.has(name)?pos(landmarks.getAsJsonObject(name)):null; }
    BlockPos lastEvent(String kind) { bind(); if(kind.equals("DEAD")&&landmarks.has("last_death")) return pos(landmarks.getAsJsonObject("last_death")); for(int i=events.size()-1;i>=0;i--) { var e=events.get(i).getAsJsonObject(); if(kind.equals(e.get("kind").getAsString())) return pos(e); } return null; }
    private void mineral(BlockPos p,String id) {
        if(!MiningTargets.ore(id)) return;
        JsonObject o=new JsonObject(); o.addProperty("x",p.getX()); o.addProperty("y",p.getY()); o.addProperty("z",p.getZ()); o.addProperty("block",id); o.addProperty("seen",mc.level.getGameTime());
        minerals.put(p.immutable(),o); while(minerals.size()>256) minerals.remove(minerals.keySet().iterator().next());
    }
    List<BlockPos> resources(String query,int radius,BlockPos anchor) {
        bind(); BlockPos feet=mc.player.blockPosition(); List<BlockPos> result=new ArrayList<>();
        // Only visible surfaces are published; breaking a block exposes the next part of a vein.
        for(BlockPos p:BlockPos.betweenClosed(feet.offset(-8,-6,-8),feet.offset(8,8,8))) {
            if(!mc.level.hasChunkAt(p)) continue;
            String id=PlayerDigTask.id(p); if(MiningTargets.matches(query,id)&&visible(p)) { result.add(p.immutable()); mineral(p,id); }
        }
        minerals.entrySet().removeIf(e->mc.level.hasChunkAt(e.getKey())&&visible(e.getKey())&&!MiningTargets.ore(PlayerDigTask.id(e.getKey())));
        for(var e:minerals.entrySet()) if(MiningTargets.matches(query,e.getValue().get("block").getAsString())&&!result.contains(e.getKey())) result.add(e.getKey());
        return result.stream().filter(p->p.distSqr(feet)<=radius*radius).filter(p->anchor==null||p.distSqr(anchor)<=8*8)
                .sorted(Comparator.comparingDouble(p->p.distSqr(feet))).toList();
    }
    void scan() {
        bind(); long time=mc.level.getGameTime(); if (time-lastScan<100) return; lastScan=time;
        logs.entrySet().removeIf(e -> mc.level.hasChunkAt(e.getKey()) && visible(e.getKey()) && !mc.level.getBlockState(e.getKey()).is(BlockTags.LOGS));
        Vec3 eye=mc.player.getEyePosition();
        // Sweep the observation rays without moving the player's camera.
        for (int yaw=0; yaw<360; yaw+=5) for(int pitch:new int[]{-60,-30,-15,0,12,25,40,60,75}) {
            Vec3 end=eye.add(Vec3.directionFromRotation(pitch,yaw).scale(64));
            var hit=mc.level.clip(new ClipContext(eye,end,ClipContext.Block.COLLIDER,ClipContext.Fluid.NONE,mc.player));
            if (hit.getType()!=HitResult.Type.BLOCK || !mc.level.hasChunkAt(hit.getBlockPos())) continue;
            BlockPos p=hit.getBlockPos().immutable(); var state=mc.level.getBlockState(p);
            mineral(p,PlayerDigTask.id(p));
            if(state.is(BlockTags.LOGS)) logs.put(p,time);
            else if(state.is(BlockTags.LEAVES) && hints.keySet().stream().noneMatch(q->q.distSqr(p)<36)) hints.put(p,time);
        }
        // Nearby visible trunk faces resolve leaf-only distant sightings.
        BlockPos feet=mc.player.blockPosition();
        for(BlockPos p:BlockPos.betweenClosed(feet.offset(-7,-2,-7),feet.offset(7,16,7)))
            if(mc.level.hasChunkAt(p) && mc.level.getBlockState(p).is(BlockTags.LOGS) && visible(p)) logs.put(p.immutable(),time);
        explored.add(sector(feet)); trim(logs,256); trim(hints,128); save();
    }
    private static void trim(Map<BlockPos,Long> map,int max) { while(map.size()>max) map.remove(map.keySet().iterator().next()); }
    boolean visible(BlockPos p) {
        return visibleFrom(mc.player.getEyePosition(),p);
    }
    boolean visibleFrom(Vec3 eye,BlockPos p) {
        for (Vec3 end:List.of(Vec3.atCenterOf(p),Vec3.atCenterOf(p).add(0,.4,0))) {
            var hit=mc.level.clip(new ClipContext(eye,end,ClipContext.Block.COLLIDER,ClipContext.Fluid.NONE,mc.player));
            if(hit.getType()==HitResult.Type.MISS || hit.getBlockPos().equals(p)) return true;
        }
        return false;
    }
    BlockPos tree() {
        scan(); BlockPos feet=mc.player.blockPosition();
        return logs.keySet().stream().filter(p->p.distSqr(feet)<128*128)
                .filter(p->!mc.level.hasChunkAt(p)||mc.level.getBlockState(p).is(BlockTags.LOGS))
                .min(Comparator.comparingDouble(p->p.distSqr(feet))).orElseGet(()->hints.keySet().stream()
                        .filter(p->p.distSqr(feet)>9).min(Comparator.comparingDouble(p->p.distSqr(feet))).orElse(null));
    }
    void forget(BlockPos p) { logs.remove(p); hints.entrySet().removeIf(e->e.getKey().distSqr(p)<64); save(); }
    void turnExploration() { direction=(direction+1)%8; save(); }
    BlockPos frontier() {
        scan(); BlockPos feet=mc.player.blockPosition();
        for(int offset=0;offset<8;offset++) {
            int d=(direction+offset)%8;
            for(int radius:new int[]{32,24,16}) {
                int x=feet.getX()+(int)Math.round(Math.sin(d*Math.PI/4)*radius);
                int z=feet.getZ()+(int)Math.round(Math.cos(d*Math.PI/4)*radius);
                for(int y=feet.getY()+6;y>=feet.getY()-6;y--) {
                    BlockPos p=new BlockPos(x,y,z);
                    if(standable(point(p)) && !explored.contains(sector(p))) { direction=d; return p; }
                }
            }
        }
        return null;
    }
    boolean clear(Point p) {
        BlockPos at=block(p);
        if(!mc.level.hasChunkAt(at)||!mc.level.getFluidState(at).isEmpty()) return false;
        var state=mc.level.getBlockState(at);
        if(state.getBlock() instanceof net.minecraft.world.level.block.BaseFireBlock ||state.is(net.minecraft.world.level.block.Blocks.POWDER_SNOW)
                ||state.is(net.minecraft.world.level.block.Blocks.SWEET_BERRY_BUSH)||state.is(net.minecraft.world.level.block.Blocks.WITHER_ROSE)) return false;
        return state.getCollisionShape(mc.level,at).isEmpty() || state.getBlock() instanceof net.minecraft.world.level.block.DoorBlock
                &&state.getValue(net.minecraft.world.level.block.DoorBlock.OPEN);
    }
    boolean standable(Point p) {
        BlockPos floor=block(p).below();
        if(!clear(p)||!clear(new Point(p.x(),p.y()+1,p.z()))||!mc.level.hasChunkAt(floor)) return false;
        var state=mc.level.getBlockState(floor);
        return state.isCollisionShapeFullBlock(mc.level,floor) && !state.is(BlockTags.LEAVES)
                && !state.is(net.minecraft.world.level.block.Blocks.MAGMA_BLOCK)
                && !state.is(net.minecraft.world.level.block.Blocks.CAMPFIRE);
    }
    static Point point(BlockPos p) { return new Point(p.getX(),p.getY(),p.getZ()); }
    static BlockPos block(Point p) { return new BlockPos(p.x(),p.y(),p.z()); }
    private static long sector(BlockPos p) { return ((long)(p.getX()>>4)<<32)^((p.getZ()>>4)&0xffffffffL); }
    private static JsonArray entries(Map<BlockPos,Long> map) {
        JsonArray array=new JsonArray(); map.forEach((p,t)-> { JsonObject o=new JsonObject(); o.addProperty("x",p.getX()); o.addProperty("y",p.getY()); o.addProperty("z",p.getZ()); o.addProperty("seen",t); array.add(o); }); return array;
    }
    private void save() {
        JsonObject o=new JsonObject(); o.add("logs",entries(logs)); o.add("hints",entries(hints));
        JsonArray sectors=new JsonArray(); explored.stream().sorted().forEach(sectors::add); o.add("explored",sectors);
        o.addProperty("direction",direction); o.add("agenda",agenda);
        o.add("landmarks",landmarks); o.add("events",events); o.addProperty("world_id",worldId);
        JsonArray ore=new JsonArray(); minerals.values().forEach(ore::add); o.add("minerals",ore);
        WorldJournal.write(file,o);
    }
}
