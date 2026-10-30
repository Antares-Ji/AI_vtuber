/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import dev.mcplayeragent.harness.*;
import dev.mcplayeragent.harness.PlayerTasks.*;
import com.google.gson.JsonObject;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.item.*;
import net.minecraft.world.item.crafting.CraftingRecipe;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.DoorBlock;
import net.minecraft.world.phys.Vec3;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import static dev.mcplayeragent.skills.SurvivalPlayerTasks.*;

/** Builds and verifies a small closed refuge entirely through normal player inventory and placement inputs. */
final class PlayerShelterTask implements Task {
    private static final Minecraft MC=Minecraft.getInstance();
    private final SkillRegistry skills; private final PlayerWorld world; private BlockPos center; private Task child;
    private String wood,material,door; private int gathers; private boolean prepared,gathering;
    private CompletableFuture<Boolean> proof;
    PlayerShelterTask(PlayerWorld world,SkillRegistry skills) { this.world=world; this.skills=skills; }
    @Override public void resumed() { proof=null; if(child!=null) child.resumed(); }
    @Override public void paused() { if(child!=null) child.paused(); }
    @Override public void stopped() { if(child!=null) child.stopped(); }
    @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
        if(child!=null) { Step step=child.next(state,last,receipt); if(step.action()!=null) return step; child.stopped(); child=null;
            if(step.outcome()!=PlayerProgress.Outcome.SUCCEEDED&&!(gathering&&wood()!=null)) return Step.failed(step.detail()); gathering=false; }
        if(!prepared) {
            if(wood==null) wood=wood();
            if(wood==null) {
                if(gathers++>=4) return Step.failed("SHELTER_MATERIALS: no usable wood after gathering attempts");
                JsonObject request=input("SKILL",1); request.addProperty("text","harvest_tree"); child=skills.start(json(request)); gathering=true; return Step.action(action("WAIT"));
            }
            door=wood.substring(0,wood.length()-"_planks".length())+"_door";
            if(count(door)<1) { child=new PlayerCraftTask(world,skills,door,1); return Step.action(action("WAIT")); }
            material=count("minecraft:dirt")>=23?"minecraft:dirt":count("minecraft:cobblestone")>=23?"minecraft:cobblestone":wood;
            if(count(material)<23) { child=new PlayerCraftTask(world,skills,material,23); return Step.action(action("WAIT")); }
            prepared=true;
        }
        if(!MC.player.onGround()) return Step.action(json(input("WAIT",10)));
        if(center==null) {
            BlockPos feet=MC.player.blockPosition();
            search: for(int r=0;r<=10;r++) for(int x=-r;x<=r;x++) for(int z=-r;z<=r;z++) for(int y=-2;y<=2;y++) {
                BlockPos p=feet.offset(x,y,z); if(site(p,world)) { center=p; break search; }
            }
            if(center==null) return Step.failed("NO_SHELTER_SITE: need a flat dry 3x3 floor with clear space above it");
        }
        if(MC.player.position().distanceTo(Vec3.atBottomCenterOf(center))>.55) { child=SurvivalPlayerTasks.walkTo(center); return Step.action(action("WAIT")); }
        for(var p:ShelterLayout.shell(PlayerWorld.point(center))) {
            BlockPos at=PlayerWorld.block(p);
            if(!BuiltInRegistries.BLOCK.getKey(MC.level.getBlockState(at).getBlock()).toString().equals(material)) {
                child=new PlayerPlacementTask(at,material); return Step.action(action("WAIT"));
            }
        }
        BlockPos entry=center.south();
        if(!(MC.level.getBlockState(entry).getBlock() instanceof DoorBlock)) {
            child=new PlayerPlacementTask(entry,door); return Step.action(action("WAIT"));
        }
        if(MC.level.getBlockState(entry).getValue(DoorBlock.OPEN)) return Step.action(lookAt("USE",entry,20));
        if(proof==null) {
            proof=new CompletableFuture<>(); var future=proof; var server=MC.getSingleplayerServer(); var dimension=MC.level.dimension(); BlockPos at=center;
            server.execute(()-> { try { var level=server.getLevel(dimension); future.complete(level!=null&&intact(level,at)); }
                catch(Exception e) { future.completeExceptionally(e); } });
            return Step.action(json(input("WAIT",5)));
        }
        if(!proof.isDone()) return Step.action(json(input("WAIT",5)));
        if(!proof.join()) return Step.failed("SHELTER_NOT_VERIFIED: server did not confirm complete walls, roof and a closed two-high door");
        world.shelter(center); world.event("SHELTER_BUILT","Server verified 3x3 closed refuge",center);
        return Step.done("Server verified shelter at "+center+"; landmark saved for this world and dimension");
    }
    private static int count(String item) { var type=BuiltInRegistries.ITEM.get(ResourceLocation.parse(item)); return MC.player.getInventory().items.stream().filter(s->s.is(type)).mapToInt(ItemStack::getCount).sum(); }
    private static String wood() {
        var planks=MC.player.getInventory().items.stream().filter(s->s.is(ItemTags.PLANKS)).max(Comparator.comparingInt(ItemStack::getCount));
        if(planks.isPresent()) return BuiltInRegistries.ITEM.getKey(planks.get().getItem()).toString();
        for(var stack:MC.player.getInventory().items) if(stack.is(ItemTags.LOGS)) for(var holder:MC.level.getRecipeManager().getRecipes()) {
            if(!(holder.value() instanceof CraftingRecipe recipe)||recipe.isSpecial()||!dev.mcplayeragent.minecraft.RecipeProbe.usableIngredients(recipe)) continue;
            var ingredients=recipe.getIngredients().stream().filter(i->!i.isEmpty()).toList(); var result=dev.mcplayeragent.minecraft.RecipeProbe.resultOf(recipe,MC.level.registryAccess());
            if(ingredients.size()==1&&ingredients.getFirst().test(stack)&&result.is(ItemTags.PLANKS)) return BuiltInRegistries.ITEM.getKey(result.getItem()).toString();
        }
        return null;
    }
    private static boolean site(BlockPos p,PlayerWorld world) {
        for(int x=-1;x<=1;x++) for(int z=-1;z<=1;z++) {
            if(!world.standable(PlayerWorld.point(p.offset(x,0,z)))) return false;
            for(int y=0;y<=2;y++) if(!MC.level.getBlockState(p.offset(x,y,z)).canBeReplaced()||!MC.level.getFluidState(p.offset(x,y,z)).isEmpty()) return false;
        }
        return world.standable(PlayerWorld.point(p.south(2)));
    }
    static boolean intact(BlockPos center) { return intact(MC.level,center); }
    private static boolean intact(Level level,BlockPos center) {
        BlockPos entry=center.south();
        boolean lower=level.getBlockState(entry).getBlock() instanceof DoorBlock&&!level.getBlockState(entry).getValue(DoorBlock.OPEN);
        boolean upper=level.getBlockState(entry.above()).getBlock() instanceof DoorBlock&&!level.getBlockState(entry.above()).getValue(DoorBlock.OPEN);
        return ShelterLayout.verified(PlayerWorld.point(center),p->{ BlockPos at=PlayerWorld.block(p); return level.hasChunkAt(at)&&level.getBlockState(at).isCollisionShapeFullBlock(level,at); },
                p->{ BlockPos at=PlayerWorld.block(p); return level.hasChunkAt(at)&&level.getFluidState(at).isEmpty()&&level.getBlockState(at).getCollisionShape(level,at).isEmpty(); },lower,upper);
    }
    static final class ReturnTask implements Task {
        private final PlayerWorld world; private Task child; private int stage,interactions; private BlockPos center;
        ReturnTask(PlayerWorld world) { this.world=world; }
        @Override public void resumed() { stage=0; child=null; }
        @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
            var close=PlayerSurvivalReflexes.closeMenu(); if(close!=null) return Step.action(close);
            center=world.shelter(); if(center==null) return Step.failed("No shelter recorded in this world/dimension");
            if(child!=null) { var step=child.next(state,last,receipt); if(step.action()!=null) return step; child=null;
                if(step.outcome()!=PlayerProgress.Outcome.SUCCEEDED) return step; stage++; }
            BlockPos entry=center.south(); var door=MC.level.getBlockState(entry);
            if(!(door.getBlock() instanceof DoorBlock)) return Step.failed("Remembered shelter entrance no longer exists");
            if(interactions>4) return Step.failed("Remembered shelter door did not respond; inspect entrance before retrying");
            if(MC.player.position().distanceTo(Vec3.atBottomCenterOf(center))<.65) stage=2;
            if(stage==0) { child=SurvivalPlayerTasks.runTo(center.south(2)); return Step.action(action("WAIT")); }
            if(stage==1) {
                if(!door.getValue(DoorBlock.OPEN)) { interactions++; return Step.action(lookAt("USE",entry,20)); }
                child=SurvivalPlayerTasks.runTo(center); return Step.action(action("WAIT"));
            }
            if(door.getValue(DoorBlock.OPEN)) { interactions++; return Step.action(lookAt("USE",entry,20)); }
            return intact(center)?Step.done("Returned to remembered shelter; closed entrance and checked shell"):Step.failed("Remembered shelter damaged; repair or build another refuge");
        }
    }
}
