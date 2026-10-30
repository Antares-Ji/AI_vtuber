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
import net.minecraft.core.component.DataComponents;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.*;
import net.minecraft.world.entity.projectile.Projectile;
import net.minecraft.world.item.*;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.*;
import java.util.*;
import static dev.mcplayeragent.skills.SurvivalPlayerTasks.*;

/** Fast local survival policies. They emit the same checked native steps as ordinary tasks. */
final class PlayerSurvivalReflexes {
    private static final Minecraft MC=Minecraft.getInstance();
    private final PlayerWorld world;
    private String context="",lastEvent=""; private long eventTick=-1000; private boolean stuck;
    PlayerSurvivalReflexes(PlayerWorld world) { this.world=world; }
    void stuck() { stuck=true; }
    Interruption poll() {
        String key=world.key(); if(!key.equals(context)) { context=key; lastEvent=""; eventTick=-1000; stuck=false; }
        var p=MC.player; var mobs=hostiles(); double distance=mobs.stream().mapToDouble(p::distanceTo).min().orElse(1000);
        boolean creeper=mobs.stream().anyMatch(m->m instanceof Creeper c && p.distanceTo(c)<7 && c.getSwelling(1)>0);
        var state=new SurvivalPolicy.State(p.isDeadOrDying(),p.isInWall(),p.isInLava(),p.isUnderWater(),p.getAirSupply(),p.isOnFire(),creeper,
                projectile(),distance,stuck,p.getHealth(),p.getFoodData().getFoodLevel(),food()!=null);
        var choice=SurvivalPolicy.choose(state); if(choice.need()==SurvivalPolicy.Need.NONE) return null;
        String reason=switch(choice.need()) {
            case DEAD -> "死亡位置已记录"; case SUFFOCATING -> "窒息脱困"; case LAVA -> "离开岩浆";
            case DROWNING -> "溺水换气与上岸"; case CREEPER -> "躲避正在引爆的苦力怕";
            case FIRE -> "寻找灭火机会";
            case PROJECTILE -> "躲避飞行物并寻找掩体"; case HOSTILE -> "避开附近敌对生物";
            case STUCK -> "移动卡住，尝试脱困"; case FOOD -> "安全进食"; default -> "";
        };
        long now=MC.level.getGameTime();
        if(!reason.equals(lastEvent)||now-eventTick>=200) { world.event(choice.need().name(),reason,p.blockPosition()); eventTick=now; lastEvent=reason; }
        Task task=switch(choice.need()) {
            case DEAD -> (s,last,receipt)->Step.failed("Player died; death position recorded. Respawn manually, then resume the saved goal.");
            case SUFFOCATING,LAVA,DROWNING,FIRE -> new EscapeTask(world,false);
            case STUCK -> { stuck=false; yield new EscapeTask(world,true); }
            case CREEPER,PROJECTILE,HOSTILE -> new FleeTask(world);
            case FOOD -> new EatTask();
            default -> throw new IllegalStateException("Unexpected survival need");
        };
        return new Interruption(choice.priority(),reason,task);
    }
    static List<Mob> hostiles() {
        return MC.level.getEntitiesOfClass(Mob.class,MC.player.getBoundingBox().inflate(18),m->m instanceof Enemy && m.isAlive()
                && !(m instanceof EnderMan e&&!e.isCreepy()) && !(m instanceof ZombifiedPiglin z&&!z.isAggressive())
                && !(m instanceof Spider s&&!s.isAggressive()&&MC.level.isDay()) && MC.player.hasLineOfSight(m)).stream()
                .sorted(Comparator.comparingDouble(MC.player::distanceToSqr)).limit(12).toList();
    }
    private static boolean projectile() {
        return !incoming().isEmpty();
    }
    private static List<Projectile> incoming() {
        return MC.level.getEntitiesOfClass(Projectile.class,MC.player.getBoundingBox().inflate(6),p->p.getOwner()!=MC.player
                && p.getDeltaMovement().lengthSqr()>.02 && p.getDeltaMovement().dot(MC.player.getEyePosition().subtract(p.position()))>0);
    }
    static Item food() {
        return MC.player.getInventory().items.stream().filter(s->!s.isEmpty()&&s.has(DataComponents.FOOD))
                .filter(s->!Set.of(Items.ROTTEN_FLESH,Items.POISONOUS_POTATO,Items.PUFFERFISH,Items.SPIDER_EYE,Items.CHORUS_FRUIT,Items.CHICKEN,Items.SUSPICIOUS_STEW).contains(s.getItem()))
                .max(Comparator.comparingInt(s->s.get(DataComponents.FOOD).nutrition())).map(ItemStack::getItem).orElse(null);
    }
    static PlayerDecision parkCursor() {
        var menu=MC.player.containerMenu; var carried=menu.getCarried(); if(carried.isEmpty()) return null;
        for(int i=0;i<menu.slots.size();i++) {
            var slot=menu.getSlot(i);
            if(slot.container!=MC.player.getInventory()||!slot.mayPlace(carried)) continue;
            if(slot.hasItem()&&(!ItemStack.isSameItemSameComponents(slot.getItem(),carried)||slot.getItem().getCount()>=slot.getMaxStackSize(carried))) continue;
            JsonObject click=input("CLICK",1); click.addProperty("menu",menu.containerId); click.addProperty("index",i); return json(click);
        }
        throw new IllegalStateException("No slot to safely return the cursor stack; no item was discarded");
    }
    static PlayerDecision closeMenu() {
        var park=parkCursor(); if(park!=null) return park;
        return MC.screen==null?null:action("CLOSE");
    }
    static final class EatTask implements Task {
        private int servings;
        @Override public int priority() { return 30; }
        @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
            if(failed(last)) return Step.failed("Eating failed: "+receipt);
            if(MC.player.getFoodData().getFoodLevel()>=18||servings>=4||food()==null) return Step.done("Food level now "+MC.player.getFoodData().getFoodLevel()+"; inventory was not discarded");
            var park=parkCursor(); if(park!=null) return Step.action(park);
            Item target=food(); var select=equip(s->s.is(target)); if(select!=null) return Step.action(select);
            var close=closeMenu(); if(close!=null) return Step.action(close);
            servings++; JsonObject use=input("USE",45); use.addProperty("pitch",-90); return Step.action(json(use));
        }
    }
    static final class EscapeTask implements Task {
        private final PlayerWorld world; private final boolean stuck;
        private final long started=MC.level.getGameTime(); private final Vec3 origin=MC.player.position();
        private Task child; private int attempts;
        EscapeTask(PlayerWorld world) { this(world,true); }
        EscapeTask(PlayerWorld world,boolean stuck) { this.world=world; this.stuck=stuck; }
        @Override public int priority() { return 40; }
        @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
            var close=closeMenu(); if(close!=null) return Step.action(close);
            if(MC.level.getGameTime()-started>600) return Step.failed("Escape timed out; actual position="+MC.player.position());
            if(child!=null) { var step=child.next(state,last,receipt); if(step.action()!=null) return step; child=null; }
            if(MC.player.isInWall()) {
                for(BlockPos p:List.of(MC.player.blockPosition().above(),MC.player.blockPosition()))
                    if(!MC.level.getBlockState(p).getCollisionShape(MC.level,p).isEmpty()&&MC.level.getBlockState(p).getDestroySpeed(MC.level,p)>=0)
                        return Step.action(lookAt("BREAK",p,240));
                return Step.failed("Suffocation block cannot be removed using current native controls");
            }
            if(MC.player.isInWater()||MC.player.isInLava()) {
                BlockPos shore=null, feet=MC.player.blockPosition(); double best=Double.MAX_VALUE;
                for(int r:new int[]{2,4,8,12,16,24}) for(int d=0;d<8;d++) for(int y=feet.getY()-1;y<=feet.getY()+5;y++) {
                    BlockPos p=new BlockPos(feet.getX()+(int)Math.round(Math.sin(d*Math.PI/4)*r),y,feet.getZ()+(int)Math.round(Math.cos(d*Math.PI/4)*r));
                    if(world.standable(PlayerWorld.point(p))&&p.distSqr(feet)<best) { shore=p; best=p.distSqr(feet); }
                }
                JsonObject swim=input("INPUT",20); swim.addProperty("jump",true); swim.addProperty("pitch",-30);
                if(shore!=null) { Vec3 delta=Vec3.atCenterOf(shore).subtract(MC.player.position()); swim.addProperty("yaw",Math.toDegrees(Math.atan2(-delta.x,delta.z))); swim.addProperty("forward",.8); }
                return Step.action(json(swim));
            }
            if(MC.player.isOnFire()) {
                BlockPos feet=MC.player.blockPosition();
                for(int r:new int[]{2,4,6,8,12}) for(int d=0;d<8;d++) for(int y=-1;y<=1;y++) {
                    BlockPos p=feet.offset((int)Math.round(Math.sin(d*Math.PI/4)*r),y,(int)Math.round(Math.cos(d*Math.PI/4)*r));
                    if(MC.level.hasChunkAt(p)&&MC.level.getFluidState(p).is(net.minecraft.tags.FluidTags.WATER)&&world.visible(p)&&safeWaterApproach(p)) {
                        Vec3 delta=Vec3.atCenterOf(p).subtract(MC.player.position()); JsonObject extinguish=input("INPUT",15);
                        extinguish.addProperty("yaw",Math.toDegrees(Math.atan2(-delta.x,delta.z))); extinguish.addProperty("forward",.8); extinguish.addProperty("jump",true);
                        return Step.action(json(extinguish));
                    }
                }
                if(MC.player.getHealth()<10&&food()!=null&&MC.player.getFoodData().getFoodLevel()<18) { child=new EatTask(); return Step.action(action("WAIT")); }
                return Step.action(json(input("WAIT",10)));
            }
            if(MC.player.onGround()&&(!stuck||MC.player.position().distanceTo(origin)>.4)) return Step.done("Escaped to stable ground; position="+MC.player.position());
            if(!MC.player.onGround()) return Step.action(json(input("WAIT",10)));
            if(++attempts>6) return Step.failed("No safe escape after six local attempts; request assistance");
            BlockPos feet=MC.player.blockPosition();
            for(int d=0;d<8;d++) {
                double angle=(d+attempts)*Math.PI/4; BlockPos p=feet.offset((int)Math.round(Math.sin(angle)*2),0,(int)Math.round(Math.cos(angle)*2));
                for(int y=1;y>=-1;y--) if(world.standable(PlayerWorld.point(p.above(y)))) {
                    child=SurvivalPlayerTasks.walkTo(p.above(y)); return Step.action(json(input("WAIT",1)));
                }
            }
            boolean blocks=MC.player.getInventory().items.stream().anyMatch(s->s.is(Items.DIRT)||s.is(Items.COBBLESTONE)||s.is(net.minecraft.tags.ItemTags.PLANKS));
            if(blocks) { child=new SurvivalPlayerTasks.PillarTask(); return Step.action(action("WAIT")); }
            return Step.failed("Trapped: no walkable exit or carried scaffold material");
        }
        private boolean safeWaterApproach(BlockPos target) {
            Vec3 from=MC.player.position(), to=Vec3.atBottomCenterOf(target); int samples=(int)Math.ceil(from.distanceTo(to)*2);
            for(int i=1;i<=samples;i++) {
                Vec3 at=from.lerp(to,(double)i/samples); BlockPos cell=BlockPos.containing(at);
                if(!MC.level.hasChunkAt(cell)) return false;
                if(MC.level.getFluidState(cell).is(net.minecraft.tags.FluidTags.WATER)) continue;
                if(!world.standable(PlayerWorld.point(cell))) return false;
            }
            return true;
        }
    }
    static final class FleeTask implements Task {
        private final PlayerWorld world; private final long started=MC.level.getGameTime();
        private Task walking; private long safeSince=-1; private int failures,strikes; private boolean triedHome;
        FleeTask(PlayerWorld world) { this.world=world; }
        @Override public int priority() { return 70; }
        @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
            var close=closeMenu(); if(close!=null) return Step.action(close);
            if(walking instanceof PlayerShelterTask.ReturnTask) {
                var step=walking.next(state,last,receipt); if(step.action()!=null) return step;
                walking=null; if(step.outcome()!=PlayerProgress.Outcome.SUCCEEDED) failures++;
            }
            long now=MC.level.getGameTime(); var threats=hostiles();
            double distance=threats.stream().mapToDouble(MC.player::distanceTo).min().orElse(1000);
            if(distance>14&&!projectile()) {
                if(safeSince<0) safeSince=now;
                if(now-safeSince>=60) return Step.done("No nearby visible threat for three seconds; revalidate suspended work");
                return Step.action(json(input("WAIT",10)));
            }
            safeSince=-1;
            if(now-started>1200) return Step.failed("Could not find lasting safety within sixty seconds; seek player assistance");
            if(walking!=null) { var step=walking.next(state,last,receipt); if(step.action()!=null) return step;
                walking=null; if(step.outcome()!=PlayerProgress.Outcome.SUCCEEDED) failures++; }
            BlockPos home=world.shelter();
            if(!triedHome&&home!=null&&home.distSqr(MC.player.blockPosition())<24*24&&PlayerShelterTask.intact(home)) {
                triedHome=true; walking=new PlayerShelterTask.ReturnTask(world); return Step.action(action("WAIT"));
            }
            BlockPos feet=MC.player.blockPosition(), best=null; double score=-Double.MAX_VALUE;
            for(int r:new int[]{8,12,16}) for(int d=0;d<8;d++) for(int y=feet.getY()-3;y<=feet.getY()+3;y++) {
                BlockPos p=new BlockPos(feet.getX()+(int)Math.round(Math.sin(d*Math.PI/4)*r),y,feet.getZ()+(int)Math.round(Math.cos(d*Math.PI/4)*r));
                if(!world.standable(PlayerWorld.point(p))) continue;
                double after=threats.stream().mapToDouble(m->m.position().distanceTo(Vec3.atCenterOf(p))).min().orElse(30);
                if(after<distance+1&&distance<900) continue;
                var route=SurfaceRoute.find(PlayerWorld.point(feet),PlayerWorld.point(p),world::standable,world::clear,1500); if(route.isEmpty()) continue;
                boolean cover=!threats.isEmpty()&&threats.stream().allMatch(m->MC.level.clip(new ClipContext(m.getEyePosition(),Vec3.atBottomCenterOf(p).add(0,1.6,0),ClipContext.Block.COLLIDER,ClipContext.Fluid.NONE,MC.player)).getType()==HitResult.Type.BLOCK);
                double candidate=SurvivalPolicy.retreatScore(distance>900?0:distance,after,cover,route.size());
                Vec3 travel=Vec3.atCenterOf(p).subtract(MC.player.position()).normalize();
                for(var arrow:incoming()) candidate+=12*(1-Math.abs(travel.dot(arrow.getDeltaMovement().normalize())));
                if(candidate>score) { score=candidate; best=p; }
            }
            if(best!=null) { walking=SurvivalPlayerTasks.runTo(best); return Step.action(action("WAIT")); }
            // Self-defence is a bounded last resort when no retreat path is available.
            if(!threats.isEmpty()&&distance<MC.player.entityInteractionRange()-.2&&strikes<8&&!(threats.getFirst() instanceof Creeper)) {
                int weapon=-1;
                for(int i=0;i<9;i++) if(MC.player.getInventory().getItem(i).getItem() instanceof SwordItem) { weapon=i; break; }
                if(weapon<0) for(int i=0;i<9;i++) if(MC.player.getInventory().getItem(i).getItem() instanceof AxeItem) { weapon=i; break; }
                if(weapon>=0&&MC.player.getInventory().selected!=weapon) { JsonObject select=input("SELECT",1); select.addProperty("slot",weapon); return Step.action(json(select)); }
                strikes++;
                var mob=threats.getFirst(); Vec3 delta=mob.getEyePosition().subtract(MC.player.getEyePosition()); JsonObject attack=input("ATTACK",30);
                attack.addProperty("yaw",Math.toDegrees(Math.atan2(-delta.x,delta.z))); attack.addProperty("pitch",-Math.toDegrees(Math.atan2(delta.y,Math.hypot(delta.x,delta.z))));
                return Step.action(json(attack));
            }
            if(++failures>4) return Step.failed("No safe retreat path; do not run blindly off cliffs or into fluids");
            return Step.action(json(input("WAIT",5)));
        }
    }
}
