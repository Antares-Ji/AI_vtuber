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
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.inventory.CraftingMenu;
import net.minecraft.world.inventory.InventoryMenu;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.crafting.*;
import net.minecraft.world.level.block.Blocks;
import java.util.*;
import static dev.mcplayeragent.skills.SurvivalPlayerTasks.*;

/** Recipe-book placement followed by a verified shift-take; no cursor juggling or outside-slot clicks. */
final class PlayerCraftTask implements Task {
    private final Minecraft mc=Minecraft.getInstance(); private final SkillRegistry skills; private final PlayerWorld world;
    private final String item; private final int count;
    private List<CraftDependencies.Formula> formulas;
    private CraftDependencies.Job job;
    private Task child; private int stage, beforeCount, retries, gathers; private BlockPos table;
    private boolean gathering; private String gatheringNote="";
    PlayerCraftTask(PlayerWorld world,SkillRegistry skills,String item,int count) {
        this.world=world; this.skills=skills; this.item=item.contains(":")?item:"minecraft:"+item; this.count=count;
        if(count<1||count>4096) throw new IllegalArgumentException("count must be 1..4096");
    }
    @Override public void resumed() { stage=0; job=null; retries=0; if(child!=null) child.resumed(); }
    @Override public void paused() { if(child!=null) child.paused(); }
    @Override public void stopped() { if(child!=null) child.stopped(); }
    @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
        if(state==null) return Step.action(action("WAIT"));
        if(child!=null) { Step step=child.next(state,last,receipt); if(step.action()!=null) return step; child.stopped(); child=null;
            if(step.outcome()!=PlayerProgress.Outcome.SUCCEEDED) {
                if(!gathering||mc.player.getInventory().items.stream().noneMatch(s->s.is(net.minecraft.tags.ItemTags.LOGS))) return Step.failed(step.detail());
                gatheringNote="; gathering partially finished: "+step.detail();
            }
            gathering=false;
        }
        if(!mc.player.containerMenu.getCarried().isEmpty()) return Step.failed("CURSOR_OCCUPIED: keep the carried stack; return it to inventory before crafting, never discard it");
        if(state.items().getOrDefault(item,0)>=count) {
            if(mc.screen!=null) return Step.action(action("CLOSE"));
            return Step.done("Verified inventory: "+item+" >= "+count+gatheringNote);
        }
        if(stage==1) {
            var output=mc.player.containerMenu.getSlot(0).getItem();
            if(output.isEmpty()||!BuiltInRegistries.ITEM.getKey(output.getItem()).toString().equals(job.item())) {
                if(++retries<3) return Step.action(json(input("WAIT",10)));
                return Step.failed("RECIPE_NOT_PLACED: "+job.recipe()+"; recipe may be locked or materials/grid changed. Items were retained.");
            }
            JsonObject click=input("CLICK",1); click.addProperty("menu",mc.player.containerMenu.containerId);
            click.addProperty("index",0); click.addProperty("button",0); click.addProperty("click","QUICK_MOVE"); stage=2;
            return Step.action(json(click));
        }
        if(stage==2) {
            if(state.items().getOrDefault(job.item(),0)<=beforeCount) {
                if(++retries<3) return Step.action(json(input("WAIT",10)));
                return Step.failed("OUTPUT_NOT_COLLECTED: inventory did not gain "+job.item()+"; check free space. No items dropped.");
            }
            stage=0; retries=0; job=null;
        }
        if(failed(last)) return Step.failed("CRAFT_STEP_FAILED: "+receipt+"; preserve items and replan, do not repeat slot clicks");
        if(mc.player.containerMenu instanceof CraftingMenu || mc.player.containerMenu instanceof InventoryMenu) {
            int cells=mc.player.containerMenu instanceof CraftingMenu?9:4;
            for(int i=1;i<=cells;i++) if(mc.player.containerMenu.getSlot(i).hasItem()) {
                JsonObject clear=input("CLICK",1); clear.addProperty("menu",mc.player.containerMenu.containerId);
                clear.addProperty("index",i); clear.addProperty("click","QUICK_MOVE"); return Step.action(json(clear));
            }
        }
        if(formulas==null) formulas=formulas();
        var plan=CraftDependencies.plan(item,count,state.items(),formulas);
        if(!plan.missing().isEmpty()) {
            boolean logs=plan.missing().keySet().stream().anyMatch(id->id.endsWith("_log")||id.endsWith("_stem"));
            if(logs&&gathers++<8) {
                JsonObject request=input("SKILL",1); request.addProperty("text","harvest_tree");
                gathering=true; child=skills.start(json(request)); return Step.action(action("WAIT"));
            }
            return Step.failed("MISSING_MATERIALS: "+plan.missing()+"; dependency plan="+plan.jobs()+". Gather raw materials, then resume this target.");
        }
        if(plan.jobs().isEmpty()) return Step.failed("No usable crafting recipe for "+item);
        job=plan.jobs().getFirst();
        if(job.grid()>2&&!(mc.player.containerMenu instanceof CraftingMenu)) return openTable(state);
        if(job.grid()<=2 && !(mc.player.containerMenu instanceof CraftingMenu) && !(mc.player.containerMenu instanceof InventoryMenu))
            return Step.action(action("CLOSE"));
        if(mc.screen==null) return Step.action(action("INVENTORY"));
        JsonObject fill=input("CRAFT",20); fill.addProperty("menu",mc.player.containerMenu.containerId); fill.addProperty("text",job.recipe());
        beforeCount=state.items().getOrDefault(job.item(),0); stage=1; retries=0; return Step.action(json(fill));
    }
    private Step openTable(PlayerEvidence state) {
        if(table!=null&&mc.level.getBlockState(table).is(Blocks.CRAFTING_TABLE)) {
            if(mc.screen!=null) return Step.action(action("CLOSE"));
            return Step.action(lookAt("USE",table,20));
        }
        BlockPos feet=mc.player.blockPosition();
        for(BlockPos p:BlockPos.betweenClosed(feet.offset(-4,-2,-4),feet.offset(4,2,4)))
            if(mc.level.getBlockState(p).is(Blocks.CRAFTING_TABLE)&&world.visible(p)
                    &&mc.player.getEyePosition().distanceTo(net.minecraft.world.phys.Vec3.atCenterOf(p))<mc.player.blockInteractionRange()-.1) {
                table=p.immutable(); return Step.action(action("WAIT"));
            }
        if(state.items().getOrDefault("minecraft:crafting_table",0)<1) {
            child=new PlayerCraftTask(world,skills,"minecraft:crafting_table",1); return Step.action(action("WAIT"));
        }
        PlayerDecision select=equip(s->s.is(Items.CRAFTING_TABLE)); if(select!=null) return Step.action(select);
        if(mc.screen!=null) return Step.action(action("CLOSE"));
        for(int[] d:new int[][]{{1,0},{-1,0},{0,1},{0,-1}}) {
            BlockPos p=feet.offset(d[0],0,d[1]); if(!world.standable(PlayerWorld.point(p))) continue;
            table=p;
            PlayerDecision aim=lookAt("PLACE",p.below(),20); JsonObject o=input("PLACE",20);
            o.addProperty("yaw",aim.yaw()); o.addProperty("pitch",aim.pitch()); o.add("until",blockCondition(p,"minecraft:crafting_table"));
            return Step.action(json(o));
        }
        return Step.failed("NO_TABLE_SPACE: need a clear adjacent surface for crafting table");
    }
    private List<CraftDependencies.Formula> formulas() {
        List<CraftDependencies.Formula> out=new ArrayList<>();
        for(var holder:mc.level.getRecipeManager().getRecipes()) {
            if(!(holder.value() instanceof CraftingRecipe recipe)||recipe.isSpecial()||!dev.mcplayeragent.minecraft.RecipeProbe.usableIngredients(recipe)) continue;
            var result=dev.mcplayeragent.minecraft.RecipeProbe.resultOf(recipe,mc.level.registryAccess());
            if(result.isEmpty()) continue;
            List<List<String>> ingredients=new ArrayList<>();
            for(var ingredient:recipe.getIngredients()) if(!ingredient.isEmpty()) ingredients.add(Arrays.stream(ingredient.getItems())
                    .map(s->BuiltInRegistries.ITEM.getKey(s.getItem()).toString()).distinct().toList());
            if(!ingredients.isEmpty()) out.add(new CraftDependencies.Formula(holder.id().toString(),BuiltInRegistries.ITEM.getKey(result.getItem()).toString(),
                    result.getCount(),recipe.canCraftInDimensions(2,2)?2:3,ingredients));
        }
        return List.copyOf(out);
    }
}
