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
import net.minecraft.core.*;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.Vec3;
import java.util.*;
import static dev.mcplayeragent.skills.SurvivalPlayerTasks.*;

/** Discover exposed minerals, commit to a local vein, and account separately for breaks and confirmed pickups. */
final class PlayerMineTask implements Task {
    private static final Minecraft MC=Minecraft.getInstance();
    private final SkillRegistry skills; private final PlayerWorld world; private final String query; private final boolean findOnly,vein,explore;
    private final int count,maxBlocks,radius,reserve,maxExploration;
    private final PlayerPickupSession session=new PlayerPickupSession(); private final Set<BlockPos> blocked=new HashSet<>();
    private Task child; private BlockPos root,target; private int broken,explored,toolPreparations; private boolean compacted;
    private String lastProblem=""; private final long started=MC.level.getGameTime();
    private String terminalFailure;
    private final Map<String,Integer> confirmedItems=new TreeMap<>();
    PlayerMineTask(PlayerWorld world,SkillRegistry skills,JsonObject args,boolean findOnly,boolean vein) {
        this.world=world; this.skills=skills; this.findOnly=findOnly; this.vein=vein;
        query=args.has("target")?args.get("target").getAsString():"coal";
        count=integer(args,"count",vein?0:8,0,4096); maxBlocks=integer(args,"max_blocks",64,1,512);
        radius=integer(args,"radius",32,1,64); reserve=integer(args,"durability_reserve",2,0,1000);
        maxExploration=integer(args,"segments",8,0,32); explore=!args.has("explore")||args.get("explore").getAsBoolean();
        root=args.has("x")?new BlockPos(args.get("x").getAsInt(),args.get("y").getAsInt(),args.get("z").getAsInt()):null;
    }
    static int integer(JsonObject args,String name,int fallback,int min,int max) {
        int value=args.has(name)?args.get(name).getAsBigDecimal().intValueExact():fallback;
        if(value<min||value>max) throw new IllegalArgumentException(name+" must be "+min+".."+max); return value;
    }
    @Override public void paused() { if(child!=null) child.paused(); }
    @Override public void resumed() { if(child!=null) child.resumed(); }
    @Override public void stopped() { session.close(); if(child!=null) child.stopped(); }
    private Step result(boolean success,int picked,String detail) {
        String report=detail+"; query="+query+"; blocks_broken="+broken+"; confirmed_goal_units="+picked+"; actual_items="+confirmedItems+"; "+lastProblem;
        world.event("MINING",report,MC.player.blockPosition()); return success?Step.done(report):Step.failed(report);
    }
    @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
        if(child!=null) {
            var step=child.next(state,last,receipt); if(step.action()!=null) return step;
            Task finished=child; child=null; finished.stopped();
            if(step.outcome()!=PlayerProgress.Outcome.SUCCEEDED) {
                lastProblem=step.detail();
                if(finished instanceof PlayerCraftTask || finished instanceof PlayerInventoryTasks.Compact || finished instanceof PlayerPickupTask)
                    terminalFailure=lastProblem;
                if(target!=null) blocked.add(target);
            } else if(finished instanceof PlayerDigTask dig && dig.broken()) {
                broken++; JsonObject pickup=new JsonObject(); pickup.addProperty("mode","filtered"); pickup.addProperty("resource",query); pickup.addProperty("radius",8);
                child=new PlayerPickupTask(world,pickup); return Step.action(json(input("WAIT",10)));
            }
            target=null;
        }
        var proof=session.read(); if(proof==null) return Step.action(json(input("WAIT",2)));
        confirmedItems.clear(); proof.entries().stream().filter(e->MiningTargets.dropMatches(query,e.item())).forEach(e->confirmedItems.merge(e.item(),e.count(),Integer::sum));
        int picked=MiningTargets.goalUnits(query,confirmedItems);
        if(terminalFailure!=null) return result(false,picked,terminalFailure);
        if(proof.truncated()) return result(false,picked,"Pickup receipt history exceeded; do not invent totals");
        if(!findOnly&&count>0&&picked>=count) return result(true,picked,"Requested resource quantity collected");
        if(broken>=3&&confirmedItems.isEmpty()&&count>0) return result(false,picked,"NO_EXPECTED_DROP_GAIN: inspect loot type, inventory, destruction or competing pickups");
        if(broken>=maxBlocks||MC.level.getGameTime()-started>12000) return result(!vein&&count==0&&broken>0,picked,"Mining work budget reached; further members not evaluated");
        List<BlockPos> resources=world.resources(query,radius,vein?root:null).stream().filter(p->!blocked.contains(p)).toList();
        if(resources.isEmpty()) {
            if(vein&&root!=null) return result(broken>0&&(count==0||picked>=count)&&blocked.isEmpty(),picked,"No further accessible exposed vein members; blocked="+blocked.size()+"; buried/unseen blocks are not asserted empty");
            if(explore&&explored++<maxExploration) {
                BlockPos frontier=world.frontier(); if(frontier!=null) { child=walkTo(frontier); return Step.action(action("WAIT")); }
            }
            return result(false,picked,"NO_EXPOSED_RESOURCE: survey another area or explicitly plan a tunnel/staircase");
        }
        target=resources.getFirst();
        if(!MC.level.hasChunkAt(target)) { blocked.add(target); return Step.action(action("WAIT")); }
        if(!MiningTargets.matches(query,PlayerDigTask.id(target))) { blocked.add(target); return Step.action(action("WAIT")); }
        if(findOnly&&world.visible(target)) { world.landmark("mine_last_found",target); return result(true,picked,"Visible resource confirmed at "+target); }
        if(!world.visible(target)||MC.player.getEyePosition().distanceTo(Vec3.atCenterOf(target))>=MC.player.blockInteractionRange()-.1) {
            BlockPos approach=approach(world,target);
            if(approach==null) { blocked.add(target); lastProblem="NO_SAFE_APPROACH to "+target; return Step.action(action("WAIT")); }
            child=walkTo(approach); return Step.action(action("WAIT"));
        }
        if(root==null) root=target;
        PlayerDigTask dig=new PlayerDigTask(world,target,reserve,MiningTargets.rawGoal(query));
        String hazard=dig.unsafe();
        if(!hazard.isEmpty()) { blocked.add(target); lastProblem=hazard+" at "+target; return Step.action(action("WAIT")); }
        if(PlayerDigTask.tool(target,reserve,MiningTargets.rawGoal(query)).isEmpty()) {
            if(toolPreparations++>=3) return result(false,picked,"No suitable tool with sufficient durability");
            var block=MC.level.getBlockState(target);
            String needed=block.is(BlockTags.NEEDS_DIAMOND_TOOL)?"diamond_pickaxe":block.is(BlockTags.NEEDS_IRON_TOOL)?"iron_pickaxe":block.is(BlockTags.NEEDS_STONE_TOOL)?"stone_pickaxe":"wooden_pickaxe";
            if(needed.equals("stone_pickaxe")&&MC.player.getInventory().items.stream().filter(s->s.is(Items.COBBLESTONE)).mapToInt(s->s.getCount()).sum()<3
                    && MC.player.getInventory().items.stream().anyMatch(s->s.getItem() instanceof net.minecraft.world.item.PickaxeItem)) {
                JsonObject stone=new JsonObject(); stone.addProperty("target","cobblestone"); stone.addProperty("count",3); stone.addProperty("max_blocks",8); stone.addProperty("segments",2);
                child=new PlayerMineTask(world,skills,stone,false,false);
            } else {
                String wanted="minecraft:"+needed;
                int carried=MC.player.getInventory().items.stream().filter(s->net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(s.getItem()).toString().equals(wanted)).mapToInt(s->s.getCount()).sum();
                child=new PlayerCraftTask(world,skills,wanted,carried+1);
            }
            return Step.action(action("WAIT"));
        }
        if(!PlayerInventoryTasks.spaceFor(PlayerDigTask.id(target))) {
            if(compacted) return result(false,picked,"INVENTORY_FULL: store items before continuing mining");
            compacted=true; child=new PlayerInventoryTasks.Compact(1); return Step.action(action("WAIT"));
        }
        child=dig; return Step.action(action("WAIT"));
    }
    static BlockPos approach(PlayerWorld world,BlockPos target) {
        var from=PlayerWorld.point(MC.player.blockPosition());
        var candidates=new ArrayList<BlockPos>();
        for(BlockPos p:BlockPos.betweenClosed(target.offset(-3,-3,-3),target.offset(3,1,3)))
            if(world.standable(PlayerWorld.point(p))&&Vec3.atBottomCenterOf(p).add(0,MC.player.getEyeHeight(),0).distanceTo(Vec3.atCenterOf(target))<MC.player.blockInteractionRange()-.2
                    &&world.visibleFrom(Vec3.atBottomCenterOf(p).add(0,MC.player.getEyeHeight(),0),target)) candidates.add(p.immutable());
        candidates.sort(Comparator.comparingDouble(p->p.distSqr(MC.player.blockPosition())));
        for(BlockPos p:candidates.stream().limit(12).toList()) if(p.equals(MC.player.blockPosition())||!SurfaceRoute.find(from,PlayerWorld.point(p),world::standable,world::clear,4096).isEmpty()) return p;
        return null;
    }
}
