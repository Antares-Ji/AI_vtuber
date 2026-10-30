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
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.world.item.ItemStack;
import java.util.*;
import static dev.mcplayeragent.skills.SurvivalPlayerTasks.*;

final class PlayerInventoryTasks {
    private static final Minecraft MC=Minecraft.getInstance();
    private PlayerInventoryTasks() {}
    private record Signature(net.minecraft.world.item.Item item,net.minecraft.core.component.DataComponentMap components) {}
    static int capacity(ItemStack item) {
        int total=0; for(int i=0;i<36;i++) { var s=MC.player.getInventory().getItem(i);
            if(s.isEmpty()) total+=Math.min(64,item.getMaxStackSize());
            else if(ItemStack.isSameItemSameComponents(s,item)) total+=Math.max(0,s.getMaxStackSize()-s.getCount()); }
        return total;
    }
    static boolean spaceFor(String block) {
        for(var s:MC.player.getInventory().items) if(s.isEmpty()||s.getCount()<s.getMaxStackSize()&&MiningTargets.dropMatches(block,net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(s.getItem()).toString())) return true;
        return false;
    }
    static final class Compact implements Task {
        private final int wanted; private int stage,merges; private InventoryStackPlan.Move move;
        Compact(int wanted) { if(wanted<1||wanted>36) throw new IllegalArgumentException("free_slots must be 1..36"); this.wanted=wanted; }
        @Override public void resumed() { stage=0; }
        private static int index(int slot) { return slot<9?36+slot:slot; }
        private static PlayerDecision click(int slot) { JsonObject o=input("CLICK",1); o.addProperty("menu",0); o.addProperty("index",index(slot)); return json(o); }
        @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
            if(failed(last)) return Step.failed("Inventory merge failed; keep items and inspect cursor: "+receipt);
            if(stage==1) {
                var carried=MC.player.containerMenu.getCarried(); var target=MC.player.getInventory().getItem(move.destination());
                if(carried.isEmpty()||!ItemStack.isSameItemSameComponents(carried,target)) return Step.failed("Inventory changed during merge; nothing discarded");
                stage=2; return Step.action(click(move.destination()));
            }
            if(stage==2) {
                stage=3; if(!MC.player.containerMenu.getCarried().isEmpty()) return Step.action(click(move.source()));
            }
            if(stage==3) { stage=0; merges++; }
            var park=PlayerSurvivalReflexes.parkCursor(); if(park!=null) return Step.action(park);
            int free=0; for(int i=0;i<36;i++) if(MC.player.getInventory().getItem(i).isEmpty()) free++;
            if(free>=wanted) {
                var close=PlayerSurvivalReflexes.closeMenu(); if(close!=null) return Step.action(close);
                return Step.done("Compacted backpack with native slot clicks; free_slots="+free+"; discarded=0");
            }
            if(merges>=36) return Step.failed("No more safe compaction progress; discarded=0");
            if(!(MC.screen instanceof InventoryScreen)) {
                var close=PlayerSurvivalReflexes.closeMenu(); return Step.action(close==null?action("INVENTORY"):close);
            }
            List<InventoryStackPlan.Stack> stacks=new ArrayList<>();
            for(int i=0;i<36;i++) { var s=MC.player.getInventory().getItem(i); if(!s.isEmpty()) stacks.add(new InventoryStackPlan.Stack(i,new Signature(s.getItem(),s.getComponents()),s.getCount(),s.getMaxStackSize())); }
            var pair=InventoryStackPlan.merge(stacks); if(pair.isEmpty()) return Step.failed("INVENTORY_FULL_NO_SAFE_MERGE: store items or explicitly choose what to discard");
            move=pair.get(); stage=1; return Step.action(click(move.source()));
        }
    }
}
