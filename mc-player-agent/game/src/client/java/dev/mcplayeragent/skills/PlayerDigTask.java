/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import dev.mcplayeragent.minecraft.DigTime;
import dev.mcplayeragent.harness.*;
import dev.mcplayeragent.harness.PlayerTasks.*;
import com.google.gson.*;
import net.minecraft.client.Minecraft;
import net.minecraft.core.*;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.FallingBlock;
import java.util.*;
import static dev.mcplayeragent.skills.SurvivalPlayerTasks.*;

/** One checked native break, sharing vanilla dig-time formulas and refusing accidental support removal. */
final class PlayerDigTask implements Task {
    private static final Minecraft MC=Minecraft.getInstance();
    private final PlayerWorld world; private final BlockPos target; private final int reserve;
    private final String expected; private boolean issued,broken;
    private final boolean avoidSilk;
    PlayerDigTask(PlayerWorld world,BlockPos target,int reserve) { this(world,target,reserve,false); }
    PlayerDigTask(PlayerWorld world,BlockPos target,int reserve,boolean avoidSilk) { this.world=world; this.target=target; this.reserve=reserve; this.avoidSilk=avoidSilk; expected=id(target); }
    boolean broken() { return broken; }
    @Override public void resumed() { issued=false; }
    static String id(BlockPos p) { return BuiltInRegistries.BLOCK.getKey(MC.level.getBlockState(p).getBlock()).toString(); }
    static Optional<MiningTools.Tool> tool(BlockPos at,int reserve) {
        return tool(at,reserve,false);
    }
    static Optional<MiningTools.Tool> tool(BlockPos at,int reserve,boolean avoidSilk) {
        var state=MC.level.getBlockState(at); var mining=DigTime.Mining.of(MC.player); List<MiningTools.Tool> tools=new ArrayList<>();
        for(int i=0;i<36;i++) {
            ItemStack s=MC.player.getInventory().getItem(i); boolean correct=!state.requiresCorrectToolForDrops()||s.isCorrectToolForDrops(state);
            if(avoidSilk && net.minecraft.world.item.enchantment.EnchantmentHelper.getItemEnchantmentLevel(MC.level.registryAccess().lookupOrThrow(net.minecraft.core.registries.Registries.ENCHANTMENT).getOrThrow(net.minecraft.world.item.enchantment.Enchantments.SILK_TOUCH),s)>0) correct=false;
            int ticks=DigTime.ticks(mining,MC.player.isCreative(),s,state,MC.player.isUnderWater(),MC.player.onGround());
            tools.add(new MiningTools.Tool(i,correct,ticks,s.isDamageableItem(),s.isDamageableItem()?s.getMaxDamage()-s.getDamageValue():Integer.MAX_VALUE));
        }
        return MiningTools.best(tools,reserve);
    }
    String unsafe() {
        if(!MC.level.hasChunkAt(target)) return "UNLOADED_TARGET";
        var state=MC.level.getBlockState(target);
        if(state.getDestroySpeed(MC.level,target)<0) return "UNBREAKABLE";
        if(!MC.level.getFluidState(target).isEmpty()) return "FLUID_TARGET";
        var box=MC.player.getBoundingBox();
        if(target.getY()<MC.player.getY()&&target.getY()+1>=MC.player.getY()-.15&&box.maxX>target.getX()&&box.minX<target.getX()+1&&box.maxZ>target.getZ()&&box.minZ<target.getZ()+1) return "PLAYER_SUPPORT: choose a side or descending staircase";
        if(target.getX()==MC.player.blockPosition().getX()&&target.getZ()==MC.player.blockPosition().getZ()&&target.getY()>MC.player.blockPosition().getY()+1) return "DIRECTLY_OVERHEAD";
        if(MC.level.getBlockEntity(target)!=null) return "BLOCK_ENTITY: mining task does not dismantle containers or machines";
        for(Direction d:Direction.values()) {
            BlockPos p=target.relative(d); if(!MC.level.hasChunkAt(p)) return "UNKNOWN_NEIGHBOUR";
            if(!MC.level.getFluidState(p).isEmpty()) return "FLUID_NEIGHBOUR: exposing water/lava needs another plan";
        }
        if(MC.level.getBlockState(target.above()).getBlock() instanceof FallingBlock) return "FALLING_BLOCK_ABOVE";
        return "";
    }
    @Override public Step next(PlayerEvidence evidence,PlayerProgress.Outcome last,String receipt) {
        if(issued) {
            if(last==PlayerProgress.Outcome.SUCCEEDED) { broken=true; return Step.done("Server confirmed mined "+expected+" at "+target); }
            if(failed(last)) return Step.failed("DIG_FAILED: "+receipt);
        }
        if(MC.level.getBlockState(target).isAir()) return Step.done("Target already absent; not credited as our mined block");
        if(!expected.equals(id(target))) return Step.failed("TARGET_CHANGED: refresh resource observation");
        String danger=unsafe(); if(!danger.isEmpty()) return Step.failed(danger+" at "+target);
        if(!world.visible(target)||MC.player.getEyePosition().distanceTo(net.minecraft.world.phys.Vec3.atCenterOf(target))>MC.player.blockInteractionRange()-.1)
            return Step.failed("NOT_REACHABLE: approach a visible face before mining "+target);
        var best=tool(target,reserve,avoidSilk); if(best.isEmpty()) return Step.failed("CORRECT_TOOL_REQUIRED_OR_LOW_DURABILITY: "+expected);
        ItemStack chosen=MC.player.getInventory().getItem(best.get().slot()).copy();
        var park=PlayerSurvivalReflexes.parkCursor(); if(park!=null) return Step.action(park);
        var select=equip(s->ItemStack.isSameItemSameComponents(s,chosen)); if(select!=null) return Step.action(select);
        var close=PlayerSurvivalReflexes.closeMenu(); if(close!=null) return Step.action(close);
        int budget=(int)Math.min(2400L,Math.max(40L,(long)best.get().ticks()*2+40));
        if(best.get().ticks()>2400) return Step.failed("MINING_TOO_SLOW: check fatigue, water, footing or tool");
        JsonObject action=JsonParser.parseString("{\"action\":\"BREAK\"}").getAsJsonObject();
        PlayerDecision aim=lookAt("BREAK",target,budget); action.addProperty("ticks",budget); action.addProperty("yaw",aim.yaw()); action.addProperty("pitch",aim.pitch());
        action.add("until",blockCondition(target,"minecraft:air")); action.add("requires",blockCondition(target,expected));
        issued=true; return Step.action(json(action));
    }
}
