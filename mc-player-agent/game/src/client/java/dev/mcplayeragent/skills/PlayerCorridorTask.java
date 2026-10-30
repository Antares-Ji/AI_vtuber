/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import dev.mcplayeragent.harness.*;
import dev.mcplayeragent.harness.PlayerTasks.*;
import com.google.gson.*;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.Vec3;
import java.util.*;
import static dev.mcplayeragent.skills.SurvivalPlayerTasks.*;

/** A bounded two-high tunnel or descending staircase, checked one cell at a time before walking forward. */
final class PlayerCorridorTask implements Task {
    private static final Minecraft MC=Minecraft.getInstance();
    private final SkillRegistry skills; private final PlayerWorld world; private final BlockPos start; private final boolean descending,harvest,returnHome;
    private final int dx,dz,length,reserve,torchInterval,collectInterval;
    private final PlayerPickupSession session=new PlayerPickupSession(); private final Set<BlockPos> surveyed=new HashSet<>();
    private Task child; private int steps,broken,lastCollect,lastTorch,preparations; private boolean returned,compacted;
    private String failure,notes="";
    PlayerCorridorTask(PlayerWorld world,SkillRegistry skills,JsonObject args,boolean descending) {
        this.world=world; this.skills=skills; this.descending=descending; start=MC.player.blockPosition();
        length=PlayerMineTask.integer(args,"length",8,1,64); reserve=PlayerMineTask.integer(args,"durability_reserve",2,0,1000);
        torchInterval=PlayerMineTask.integer(args,"torch_interval",6,0,64); collectInterval=PlayerMineTask.integer(args,"collect_interval",2,1,16);
        harvest=args.has("harvest_ores")&&args.get("harvest_ores").getAsBoolean(); returnHome=args.has("return_to_entrance")&&args.get("return_to_entrance").getAsBoolean();
        int direction=args.has("direction")?switch(args.get("direction").getAsString()) { case "south"->0;case "west"->1;case "north"->2;case "east"->3;default->throw new IllegalArgumentException("direction must be north/south/east/west"); }
                :Math.floorMod(Math.round(MC.player.getYRot()/90),4);
        dx=new int[]{0,-1,0,1}[direction]; dz=new int[]{1,0,-1,0}[direction];
        if(descending&&start.getY()-length<=MC.level.getMinBuildHeight()+1) throw new IllegalArgumentException("Staircase would reach the world bottom; shorten length");
        world.landmark("mine_entrance",start);
    }
    @Override public void resumed() { if(child!=null) child.resumed(); }
    @Override public void paused() { if(child!=null) child.paused(); }
    @Override public void stopped() { session.close(); if(child!=null) child.stopped(); }
    @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
        if(child!=null) {
            var step=child.next(state,last,receipt); if(step.action()!=null) return step;
            if(step.outcome()!=PlayerProgress.Outcome.SUCCEEDED) {
                if(child instanceof PlayerMineTask) notes=step.detail(); else failure=step.detail();
            } else if(child instanceof PlayerDigTask dig&&dig.broken()) broken++;
            child.stopped(); child=null;
        }
        var proof=session.read(); if(proof==null) return Step.action(json(input("WAIT",2)));
        int picked=proof.entries().stream().mapToInt(PickupJournal.Entry::count).sum();
        String report="steps="+steps+"/"+length+"; broken="+broken+"; confirmed_pickup="+picked+"; entrance="+start+"; "+notes;
        if(failure!=null||proof.truncated()) return Step.failed((failure==null?"Pickup receipt window exceeded":failure)+"; "+report);
        if(steps>lastCollect&&(steps-lastCollect>=collectInterval||steps==length)) {
            lastCollect=steps; JsonObject pickup=new JsonObject(); pickup.addProperty("mode","sweep"); pickup.addProperty("radius",8);
            child=new PlayerPickupTask(world,pickup); return Step.action(json(input("WAIT",10)));
        }
        if(steps==length) {
            if(returnHome&&!returned) { returned=true; child=walkTo(start); return Step.action(action("WAIT")); }
            world.landmark("mine_last_work",PlayerWorld.block(MiningCorridor.step(PlayerWorld.point(start),dx,dz,length,descending)));
            world.event("MINE_CORRIDOR",report,MC.player.blockPosition()); return Step.done(report);
        }
        BlockPos next=PlayerWorld.block(MiningCorridor.step(PlayerWorld.point(start),dx,dz,steps+1,descending));
        if(MC.player.position().distanceTo(Vec3.atBottomCenterOf(next))<.65) { steps++; return Step.action(action("WAIT")); }
        if(torchInterval>0&&steps>0&&steps-lastTorch>=torchInterval&&MC.player.onGround()
                && MC.player.getInventory().items.stream().anyMatch(s->s.is(Items.TORCH))) {
            lastTorch=steps; if(MC.level.getBlockState(MC.player.blockPosition()).canBeReplaced()) { child=new PlayerPlacementTask(MC.player.blockPosition(),"minecraft:torch"); return Step.action(action("WAIT")); }
        }
        if(harvest&&steps>0) {
            for(BlockPos ore:world.resources("all_ores",8,null)) if(surveyed.add(ore)) {
                JsonObject mining=new JsonObject(); mining.addProperty("target",PlayerDigTask.id(ore)); mining.addProperty("count",0); mining.addProperty("max_blocks",8); mining.addProperty("explore",false);
                mining.addProperty("x",ore.getX()); mining.addProperty("y",ore.getY()); mining.addProperty("z",ore.getZ()); child=new PlayerMineTask(world,skills,mining,false,true); return Step.action(action("WAIT"));
            }
        }
        for(var cell:MiningCorridor.clearCells(PlayerWorld.point(next),descending)) {
            BlockPos at=PlayerWorld.block(cell);
            if(!MC.level.hasChunkAt(at)) return Step.failed("Unknown tunnel cell; wait for normal chunk loading: "+at+"; "+report);
            if(world.clear(cell)) continue;
            BlockPos shelter=world.shelter();
            if(shelter!=null&&Math.abs(at.getX()-shelter.getX())<=1&&Math.abs(at.getZ()-shelter.getZ())<=1&&at.getY()>=shelter.getY()&&at.getY()<=shelter.getY()+2)
                return Step.failed("Known shelter lies in tunnel direction; start outside it");
            String id=PlayerDigTask.id(at);
            if(!terrain(id)) return Step.failed("Tunnel encountered non-terrain block "+id+" at "+at+"; choose another route");
            PlayerDigTask dig=new PlayerDigTask(world,at,reserve);
            String hazard=dig.unsafe(); if(!hazard.isEmpty()) return Step.failed(hazard+" at "+at+"; "+report);
            if(PlayerDigTask.tool(at,reserve).isEmpty()) {
                if(preparations++>=3) return Step.failed("No suitable durable tool for tunnel; "+report);
                var block=MC.level.getBlockState(at);
                String tool=block.is(BlockTags.NEEDS_DIAMOND_TOOL)?"diamond_pickaxe":block.is(BlockTags.NEEDS_IRON_TOOL)?"iron_pickaxe":block.is(BlockTags.NEEDS_STONE_TOOL)?"stone_pickaxe":"wooden_pickaxe";
                String wanted="minecraft:"+tool; int owned=MC.player.getInventory().items.stream().filter(s->net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(s.getItem()).toString().equals(wanted)).mapToInt(s->s.getCount()).sum();
                child=new PlayerCraftTask(world,skills,wanted,owned+1); return Step.action(action("WAIT"));
            }
            if(!PlayerInventoryTasks.spaceFor(id)) {
                if(compacted) return Step.failed("Backpack full; mining paused without discarding items; "+report);
                compacted=true; child=new PlayerInventoryTasks.Compact(1); return Step.action(action("WAIT"));
            }
            child=dig; return Step.action(action("WAIT"));
        }
        if(!world.standable(PlayerWorld.point(next))) return Step.failed("NO_SAFE_FLOOR: tunnel opens into a pit/fluid; bridging needs a new plan; "+report);
        child=walkTo(next); return Step.action(action("WAIT"));
    }
    private static boolean terrain(String id) {
        return MiningTargets.ore(id)||Set.of("stone","deepslate","cobblestone","cobbled_deepslate","granite","diorite","andesite","tuff","calcite","dirt","coarse_dirt","rooted_dirt","grass_block","gravel","sand","red_sand","sandstone","red_sandstone","netherrack","basalt","smooth_basalt","blackstone","end_stone","clay","dripstone_block").contains(MiningTargets.normalize(id));
    }
}
