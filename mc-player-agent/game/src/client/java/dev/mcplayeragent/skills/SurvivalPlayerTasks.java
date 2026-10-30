/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import dev.mcplayeragent.harness.*;
import dev.mcplayeragent.harness.PlayerEvidence.Point;
import dev.mcplayeragent.harness.PlayerTasks.*;
import com.google.gson.*;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.phys.*;
import net.minecraft.world.level.ClipContext;
import java.util.*;

/** Survival task content. Every emitted step is executed and acknowledged by the native-input controller. */
public final class SurvivalPlayerTasks {
    private static final Minecraft MC=Minecraft.getInstance();
    private static final PlayerWorld WORLD=new PlayerWorld();
    private SurvivalPlayerTasks() {}
    public static PlayerTasks create(List<String> enabled, Iterable<SkillProvider> providers) {
        var skills=new SkillRegistry();
        skills.register("minecraft:find_tree","1","Find and approach a tree; optional args x,y,z",args->new TreeTask(skills,false,args));
        skills.register("minecraft:harvest_tree","1","Harvest a connected tree and collect drops; optional x,y,z",args->new TreeTask(skills,true,args));
        skills.register("minecraft:explore","1","Find tree evidence; segments 1..128, default 8",args->new ExploreTask(args.has("segments")?integer(args,"segments"):8));
        skills.register("minecraft:navigate","1","Surface navigation; required integer x,y,z",args->new WalkTask(new BlockPos(integer(args,"x"),integer(args,"y"),integer(args,"z")),false));
        skills.register("minecraft:craft_item","1","Craft inventory target; item required, count default 1",args->new PlayerCraftTask(WORLD,skills,text(args,"item"),args.has("count")?integer(args,"count"):1));
        skills.register("minecraft:escape","1","Escape immediate hazards; no args",args->new PlayerSurvivalReflexes.EscapeTask(WORLD));
        skills.register("minecraft:avoid_monsters","1","Flee nearby monsters; no args",args->new PlayerSurvivalReflexes.FleeTask(WORLD));
        skills.register("minecraft:eat","1","Eat carried food; no args",args->new PlayerSurvivalReflexes.EatTask());
        skills.register("minecraft:build_shelter","1","Build and verify a basic shelter; no args",args->new PlayerShelterTask(WORLD,skills));
        skills.register("minecraft:return_shelter","1","Return to this world's shelter; no args",args->new PlayerShelterTask.ReturnTask(WORLD));
        skills.register("minecraft:find_ore","1","Find visible ore; target,radius,segments",args->new PlayerMineTask(WORLD,skills,args,true,false));
        skills.register("minecraft:mine_resource","1","Collect confirmed resources; target,count,max_blocks",args->new PlayerMineTask(WORLD,skills,args,false,false));
        skills.register("minecraft:mine_vein","1","Mine exposed vein; target,count,max_blocks",args->new PlayerMineTask(WORLD,skills,args,false,true));
        skills.register("minecraft:mine_block","1","Mine one observed block; required x,y,z",args->new PlayerExactMineTask(WORLD,args));
        skills.register("minecraft:dig_tunnel","1","Dig safe corridor; direction,length,torch_interval,collect_interval,harvest_ores,return_to_entrance",args->new PlayerCorridorTask(WORLD,skills,args,false));
        skills.register("minecraft:dig_stairs","1","Dig descending corridor; same arguments as dig_tunnel",args->new PlayerCorridorTask(WORLD,skills,args,true));
        skills.register("minecraft:pickup_items","1","Collect visible drops; mode,item/items,radius,count",args->new PlayerPickupTask(WORLD,args));
        skills.register("minecraft:recover_drops","1","Recover drops near this dimension's death position; radius",args->{ args.addProperty("mode","recover"); return new PlayerPickupTask(WORLD,args); });
        skills.register("minecraft:compact_inventory","1","Merge identical stacks; free_slots default 1",args->new PlayerInventoryTasks.Compact(PlayerMineTask.integer(args,"free_slots",1,1,36)));
        skills.register("minecraft:return_mine","1","Return to the remembered mine entrance; no args",args->{
            BlockPos entrance=WORLD.landmark("mine_entrance");
            if(entrance==null) throw new IllegalArgumentException("No mine entrance recorded in current world/dimension");
            return walkTo(entrance);
        });
        for(var provider:providers) provider.register(skills);
        skills.seal(enabled);
        var reflexes=new PlayerSurvivalReflexes(WORLD);
        return new PlayerTasks(skills,WORLD::observe,WORLD::remember,reflexes::poll,reflexes::stuck);
    }
    static Task walkTo(BlockPos destination) { return new WalkTask(destination,false); }
    static Task runTo(BlockPos destination) { return new WalkTask(destination,false,true); }
    private static String text(JsonObject o,String key) { return o.get(key).getAsString(); }
    private static int integer(JsonObject o,String key) { return o.get(key).getAsBigDecimal().intValueExact(); }
    static boolean failed(PlayerProgress.Outcome outcome) {
        return outcome==PlayerProgress.Outcome.FAILED||outcome==PlayerProgress.Outcome.NO_PROGRESS||outcome==PlayerProgress.Outcome.TIMED_OUT;
    }
    static PlayerDecision action(String action) { JsonObject o=new JsonObject(); o.addProperty("action",action); o.addProperty("ticks",1); return PlayerDecision.parse(o.toString()); }
    static PlayerDecision json(JsonObject o) { return PlayerDecision.parse(o.toString()); }
    static JsonObject input(String action,int ticks) { JsonObject o=new JsonObject(); o.addProperty("action",action); o.addProperty("ticks",ticks); return o; }
    static JsonObject blockCondition(BlockPos p,String block) {
        JsonObject o=new JsonObject(); o.addProperty("type","block"); o.addProperty("x",p.getX()); o.addProperty("y",p.getY()); o.addProperty("z",p.getZ()); o.addProperty("block",block); return o;
    }
    static PlayerDecision lookAt(String action,BlockPos p,int ticks) {
        Vec3 eye=MC.player.getEyePosition(), aim=Vec3.atCenterOf(p);
        // Prefer an actually visible face, not a center ray hidden by a neighbouring leaf.
        for(Vec3 offset:List.of(new Vec3(0,0,0),new Vec3(.499,0,0),new Vec3(-.499,0,0),new Vec3(0,.499,0),new Vec3(0,-.499,0),new Vec3(0,0,.499),new Vec3(0,0,-.499))) {
            Vec3 end=Vec3.atCenterOf(p).add(offset);
            var hit=MC.level.clip(new ClipContext(eye,end,ClipContext.Block.COLLIDER,ClipContext.Fluid.NONE,MC.player));
            if(hit.getType()==HitResult.Type.BLOCK&&hit.getBlockPos().equals(p)) { aim=end; break; }
        }
        Vec3 d=aim.subtract(eye); JsonObject o=input(action,ticks);
        o.addProperty("yaw",Math.toDegrees(Math.atan2(-d.x,d.z)));
        o.addProperty("pitch",-Math.toDegrees(Math.atan2(d.y,Math.sqrt(d.x*d.x+d.z*d.z))));
        if(action.equals("BREAK")) o.add("until",blockCondition(p,"minecraft:air"));
        return json(o);
    }
    static PlayerDecision equip(java.util.function.Predicate<net.minecraft.world.item.ItemStack> predicate) {
        for(int i=0;i<36;i++) if(predicate.test(MC.player.getInventory().getItem(i))) {
            if(i<9) { if(MC.player.getInventory().selected==i) return null;
                JsonObject o=input("SELECT",1); o.addProperty("slot",i); return json(o); }
            if(!(MC.screen instanceof net.minecraft.client.gui.screens.inventory.InventoryScreen)) return action("INVENTORY");
            JsonObject o=input("CLICK",1); o.addProperty("menu",0); o.addProperty("index",i);
            o.addProperty("click","SWAP"); o.addProperty("button",MC.player.getInventory().selected); return json(o);
        }
        throw new IllegalStateException("Required item is not in the player's inventory");
    }
    private static final class WalkTask implements Task {
        private final BlockPos destination; private final boolean near;
        private final boolean sprint;
        private int attempts; private Point waypoint; private double lastDistance=Double.MAX_VALUE;
        private final Set<Point> blocked=new HashSet<>();
        WalkTask(BlockPos destination,boolean near) { this(destination,near,false); }
        WalkTask(BlockPos destination,boolean near,boolean sprint) { this.destination=destination; this.near=near; this.sprint=sprint; }
        @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
            if(MC.screen!=null) return Step.action(action("CLOSE"));
            BlockPos feet=MC.player.blockPosition();
            if((near && Math.hypot(feet.getX()-destination.getX(),feet.getZ()-destination.getZ())<2.2)
                    || (!near && MC.player.position().distanceTo(Vec3.atBottomCenterOf(destination))<.65)) return Step.done("Destination reached");
            if(failed(last)) { if(waypoint!=null) blocked.add(waypoint); if(++attempts>4) return Step.failed("NO_ROUTE: walking repeatedly blocked; "+destination); }
            Point from=PlayerWorld.point(feet); List<Point> best=List.of();
            for(int radius=near?1:0;radius<=(near?3:0);radius++) {
                for(int dx=-radius;dx<=radius;dx++) for(int dz=-radius;dz<=radius;dz++) {
                    if(Math.abs(dx)!=radius&&Math.abs(dz)!=radius) continue;
                    for(int y=near?feet.getY()+6:destination.getY();y>=(near?feet.getY()-6:destination.getY());y--) {
                        Point to=new Point(destination.getX()+dx,y,destination.getZ()+dz);
                        if(!WORLD.standable(to)||blocked.contains(to)) continue;
                        List<Point> path=SurfaceRoute.find(from,to,p->!blocked.contains(p)&&WORLD.standable(p),WORLD::clear,4096);
                        if(!path.isEmpty()&&(best.isEmpty()||path.size()<best.size())) best=path;
                    }
                }
                if(!best.isEmpty()) break;
            }
            if(best.isEmpty()) return Step.failed("NO_ROUTE: no loaded walkable surface to "+destination+"; water, falls and unknown chunks require another route");
            waypoint=SurfaceRoute.waypoint(from,best);
            JsonObject o=input("MOVE",180); o.addProperty("forward",1); o.addProperty("jump",waypoint.y()>from.y());
            o.addProperty("sprint",sprint&&MC.player.getFoodData().getFoodLevel()>6);
            JsonObject until=new JsonObject(); until.addProperty("type","position"); until.addProperty("x",waypoint.x()+.5);
            until.addProperty("y",waypoint.y()); until.addProperty("z",waypoint.z()+.5); until.addProperty("tolerance",.45); o.add("until",until);
            double distance=MC.player.position().distanceTo(Vec3.atBottomCenterOf(destination));
            if(distance>=lastDistance-.05 && ++attempts>12) return Step.failed("NO_PROGRESS toward committed destination");
            lastDistance=distance; return Step.action(json(o));
        }
    }
    private static final class ExploreTask implements Task {
        private final int segments; private int completed, failures; private WalkTask walking;
        ExploreTask(int segments) { if(segments<1||segments>128) throw new IllegalArgumentException("segments must be 1..128"); this.segments=segments; }
        @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
            WORLD.scan();
            if(WORLD.tree()!=null) return Step.done("Visible or remembered tree located: "+WORLD.tree());
            if(completed>=segments) return Step.failed("NO_TREE after "+completed+" exploration legs; explored sectors retained, extend exploration or ask owner");
            if(walking==null) { BlockPos frontier=WORLD.frontier(); if(frontier==null) return Step.failed("No unvisited safe frontier in loaded terrain; water/cliffs need a different travel method"); walking=new WalkTask(frontier,false); }
            Step step=walking.next(state,last,receipt);
            if(step.action()!=null) return step;
            completed++; walking=null;
            if(step.outcome()!=PlayerProgress.Outcome.SUCCEEDED) { WORLD.turnExploration(); if(++failures>6) return Step.failed(step.detail()); }
            return Step.action(action("WAIT"));
        }
    }
    private static final class TreeTask implements Task {
        private final SkillRegistry skills;
        private final boolean harvest; private final Set<BlockPos> tree=new LinkedHashSet<>();
        private BlockPos root; private Task child; private int broken, failures, emptyScans; private BlockPos mining;
        private final int startLogs; private int scaffold; private boolean clusterComplete, identified;
        private final ArrayDeque<BlockPos> supports=new ArrayDeque<>();
        private boolean collectedDrops;
        TreeTask(SkillRegistry skills,boolean harvest,JsonObject args) {
            this.skills=skills;
            this.harvest=harvest; root=args.has("x")?new BlockPos(integer(args,"x"),integer(args,"y"),integer(args,"z")):null;
            startLogs=logCount();
        }
        @Override public void resumed() {
            mining=null;
            if(child instanceof PillarTask pillar) {
                if(pillar.base!=null && !MC.level.isEmptyBlock(pillar.base) && !supports.contains(pillar.base)) supports.addLast(pillar.base);
                child=null;
            } else if(child!=null) child.resumed();
        }
        @Override public void paused() { if(child!=null) child.paused(); }
        @Override public void stopped() { if(child!=null) child.stopped(); }
        private static int logCount() { int count=0; for(var s:MC.player.getInventory().items) if(s.is(net.minecraft.tags.ItemTags.LOGS)) count+=s.getCount(); return count; }
        @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
            if(mining!=null) {
                if(!MC.level.getBlockState(mining).is(BlockTags.LOGS)) broken++;
                if(failed(last)&&++failures>4) return Step.failed("TREE_PARTIAL: target could not be mined; remaining="+tree.size()+"; "+receipt);
                mining=null;
            }
            if(child!=null) {
                Step step=child.next(state,last,receipt); if(step.action()!=null) return step;
                child.stopped();
                if(child instanceof PillarTask pillar && step.outcome()==PlayerProgress.Outcome.SUCCEEDED) supports.addLast(pillar.base);
                child=null;
                if(step.outcome()!=PlayerProgress.Outcome.SUCCEEDED) return Step.failed("TREE_PARTIAL: "+step.detail());
            }
            WORLD.scan();
            if(root==null) { root=WORLD.tree(); if(root==null) { child=new ExploreTask(12); return Step.action(action("WAIT")); } }
            // A distant leaf sighting is a hint; first approach it, then locate an actual trunk.
            if(Math.hypot(root.getX()-MC.player.getX(),root.getZ()-MC.player.getZ())>3) {
                child=new WalkTask(root,true); return Step.action(action("WAIT"));
            }
            if(!identified && !MC.level.getBlockState(root).is(BlockTags.LOGS)&&tree.isEmpty()) {
                BlockPos found=WORLD.tree();
                if(found!=null&&MC.level.getBlockState(found).is(BlockTags.LOGS)) root=found;
                else { WORLD.forget(root); root=null; if(++emptyScans>6) return Step.failed("Leaf hints did not reveal a trunk; choose another search area"); return Step.action(action("WAIT")); }
            }
            if(MC.level.getBlockState(root).is(BlockTags.LOGS)) identified=true;
            if(!harvest) return Step.done("Tree reached: "+root);
            discover(); tree.removeIf(p->!MC.level.getBlockState(p).is(BlockTags.LOGS));
            if(tree.isEmpty()) {
                if(!clusterComplete) return Step.failed("TREE_PARTIAL: connected cluster exceeded observation budget; inspect remaining branches");
                if(!supports.isEmpty()) { child=new DescendTask(supports.removeLast()); return Step.action(action("WAIT")); }
                if(!collectedDrops) {
                    collectedDrops=true; JsonObject pickup=new JsonObject(); pickup.addProperty("mode","filtered"); pickup.addProperty("radius",8);
                    JsonArray wood=new JsonArray(); net.minecraft.core.registries.BuiltInRegistries.ITEM.stream()
                            .filter(i->new net.minecraft.world.item.ItemStack(i).is(net.minecraft.tags.ItemTags.LOGS))
                            .forEach(i->wood.add(net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(i).toString())); pickup.add("items",wood);
                    child=new PlayerPickupTask(WORLD,pickup); return Step.action(json(input("WAIT",10)));
                }
                WORLD.forget(root);
                int collected=logCount()-startLogs;
                if(collected<broken && emptyScans++<3) {
                    BlockPos pickup=root;
                    if(!WORLD.standable(PlayerWorld.point(pickup))) {
                        for(int[] d:new int[][]{{1,0},{-1,0},{0,1},{0,-1}}) {
                            BlockPos candidate=root.offset(d[0],0,d[1]);
                            if(WORLD.standable(PlayerWorld.point(candidate))) { pickup=candidate; break; }
                        }
                    }
                    child=new WalkTask(pickup,false); return Step.action(json(input("WAIT",12)));
                }
                return Step.done("Tree logs exhausted; broken="+broken+", collected_delta="+collected+". Dropped items outside pickup range remain in world.");
            }
            BlockPos target=tree.stream().filter(p->MC.player.getEyePosition().distanceTo(Vec3.atCenterOf(p))<MC.player.blockInteractionRange()-.1)
                    .min(Comparator.comparingDouble(p->p.distSqr(MC.player.blockPosition()))).orElse(null);
            if(target==null) {
                if(!MC.player.getInventory().items.stream().anyMatch(TreeTask::scaffoldItem)) {
                    String planks=scaffoldPlanks();
                    if(planks!=null) { child=new PlayerCraftTask(WORLD,skills,planks,4); return Step.action(action("WAIT")); }
                }
                if(scaffold++<8 && MC.player.getInventory().items.stream().anyMatch(TreeTask::scaffoldItem)) {
                    child=new PillarTask(); return Step.action(action("WAIT"));
                }
                return Step.failed("TREE_PARTIAL: "+tree.size()+" upper logs remain outside native reach; need scaffold blocks or higher approach; root="+root);
            }
            var hit=MC.level.clip(new ClipContext(MC.player.getEyePosition(),Vec3.atCenterOf(target),ClipContext.Block.COLLIDER,ClipContext.Fluid.NONE,MC.player));
            if(hit.getType()==HitResult.Type.BLOCK&&!hit.getBlockPos().equals(target)) {
                if(MC.level.getBlockState(hit.getBlockPos()).is(BlockTags.LEAVES)) return Step.action(lookAt("BREAK",hit.getBlockPos(),240));
                child=new WalkTask(target,true); return Step.action(action("WAIT"));
            }
            // Choose an available axe; using the main hand remains valid when none is carried.
            if(MC.player.getInventory().items.stream().anyMatch(s->s.getItem() instanceof net.minecraft.world.item.AxeItem)) {
                PlayerDecision equip=equip(s->s.getItem() instanceof net.minecraft.world.item.AxeItem); if(equip!=null) return Step.action(equip);
            }
            if(MC.screen!=null) return Step.action(action("CLOSE"));
            mining=target; return Step.action(lookAt("BREAK",target,240));
        }
        private static boolean scaffoldItem(net.minecraft.world.item.ItemStack s) {
            return s.is(net.minecraft.world.item.Items.DIRT)||s.is(net.minecraft.world.item.Items.COBBLESTONE)
                    ||s.is(net.minecraft.tags.ItemTags.PLANKS);
        }
        private static String scaffoldPlanks() {
            for(var held:MC.player.getInventory().items) if(held.is(net.minecraft.tags.ItemTags.LOGS))
                for(var holder:MC.level.getRecipeManager().getRecipes()) {
                    if(!(holder.value() instanceof net.minecraft.world.item.crafting.CraftingRecipe recipe)
                            ||recipe.isSpecial()||!recipe.canCraftInDimensions(2,2)
                            ||!dev.mcplayeragent.minecraft.RecipeProbe.usableIngredients(recipe)) continue;
                    var ingredients=recipe.getIngredients().stream().filter(i->!i.isEmpty()).toList();
                    var out=dev.mcplayeragent.minecraft.RecipeProbe.resultOf(recipe,MC.level.registryAccess());
                    if(ingredients.size()==1&&ingredients.getFirst().test(held)&&out.is(net.minecraft.tags.ItemTags.PLANKS))
                        return net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(out.getItem()).toString();
                }
            return null;
        }
        private void discover() {
            var cluster=TreeCluster.collect(PlayerWorld.point(root),tree.stream().map(PlayerWorld::point).toList(),p->{
                BlockPos at=PlayerWorld.block(p); return MC.level.hasChunkAt(at)&&MC.level.getBlockState(at).is(BlockTags.LOGS);
            },8192);
            tree.clear(); cluster.logs().forEach(p->tree.add(PlayerWorld.block(p))); clusterComplete=cluster.complete();
        }
    }
    static final class PillarTask implements Task {
        private BlockPos base; private int stage;
        @Override public void resumed() { stage=0; }
        @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
            if(failed(last)) return Step.failed("Scaffold native action failed: "+receipt);
            if(stage==0) {
                PlayerDecision select=equip(TreeTask::scaffoldItem); if(select!=null) return Step.action(select);
                if(MC.screen!=null) return Step.action(action("CLOSE"));
                if(!MC.player.onGround()) return Step.failed("Scaffold requires stable ground");
                base=MC.player.blockPosition(); stage=1; JsonObject look=input("LOOK",30); look.addProperty("pitch",90); return Step.action(json(look));
            }
            if(stage==1) { stage=2; JsonObject jump=input("INPUT",5); jump.addProperty("jump",true); return Step.action(json(jump)); }
            if(stage==2) {
                stage=3; JsonObject place=input("PLACE",20); place.addProperty("pitch",90);
                var stack=MC.player.getMainHandItem();
                if(!(stack.getItem() instanceof net.minecraft.world.item.BlockItem block)) return Step.failed("Scaffold item changed");
                place.add("until",blockCondition(base,net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(block.getBlock()).toString()));
                return Step.action(json(place));
            }
            if(stage++==3) return Step.action(json(input("WAIT",12)));
            return MC.player.getY()>=base.getY()+.8?Step.done("Scaffold raised feet by one block; support remains in world at "+base):Step.failed("Scaffold did not raise the player");
        }
    }
    private static final class DescendTask implements Task {
        private final BlockPos support; private int stage;
        DescendTask(BlockPos support) { this.support=support; }
        @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
            if(failed(last)) return Step.failed("Could not remove own scaffold: "+support+"; "+receipt);
            if(stage==0) {
                stage=1;
                if(MC.level.isEmptyBlock(support)) return Step.action(json(input("WAIT",15)));
                if(!MC.player.blockPosition().below().equals(support)) return Step.failed("Own scaffold is no longer directly below player; inspect route before descending");
                return Step.action(lookAt("BREAK",support,240));
            }
            if(stage++==1) return Step.action(json(input("WAIT",15)));
            return MC.player.onGround()?Step.done("Removed own scaffold one block at a time: "+support):Step.failed("No stable landing after scaffold removal");
        }
    }
}
