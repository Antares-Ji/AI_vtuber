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
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.phys.*;
import dev.mcplayeragent.minecraft.ItemReach;
import java.util.*;
import static dev.mcplayeragent.skills.SurvivalPlayerTasks.*;

/** Follow ordinary item entities, approach a valid pickup box, then require server inventory-gain receipts. */
final class PlayerPickupTask implements Task {
    private static final Minecraft MC=Minecraft.getInstance();
    private final PlayerWorld world; private final PlayerPickupSession session=new PlayerPickupSession();
    private final String mode; private final Set<String> items=new HashSet<>(); private final int radius,wanted;
    private final String resource;
    private final BlockPos center; private final long started=MC.level.getGameTime();
    private final Set<UUID> rejected=new HashSet<>(); private UUID selected; private Vec3 lastPosition;
    private Task child; private int waits,emptyScans,attempted; private boolean compacted;
    private int collected,recoveryFailures; private String lastProblem="";
    PlayerPickupTask(PlayerWorld world,JsonObject args) {
        this.world=world; mode=args.has("mode")?args.get("mode").getAsString():"sweep";
        resource=args.has("resource")?args.get("resource").getAsString():"";
        if(!Set.of("nearest","filtered","sweep","recover").contains(mode)) throw new IllegalArgumentException("Unknown pickup mode");
        radius=args.has("radius")?args.get("radius").getAsInt():12;
        if(radius<1||radius>48) throw new IllegalArgumentException("pickup radius must be 1..48");
        wanted=args.has("count")?args.get("count").getAsInt():0; if(wanted<0||wanted>4096) throw new IllegalArgumentException("pickup count must be 0..4096");
        if(args.has("item")) items.add(id(args.get("item").getAsString()));
        if(args.has("items")) for(JsonElement e:args.getAsJsonArray("items")) items.add(id(e.getAsString()));
        center=mode.equals("recover")?world.lastEvent("DEAD"):args.has("x")?new BlockPos(args.get("x").getAsInt(),args.get("y").getAsInt(),args.get("z").getAsInt()):MC.player.blockPosition();
        if(center==null) throw new IllegalArgumentException("No death position recorded in current dimension");
    }
    static String id(String s) { return s.contains(":")?s:"minecraft:"+s; }
    private boolean matches(String id) { return (items.isEmpty()||items.contains(id))&&(resource.isEmpty()||MiningTargets.dropMatches(resource,id)); }
    private boolean matches(ItemEntity entity) { return matches(BuiltInRegistries.ITEM.getKey(entity.getItem().getItem()).toString()); }
    @Override public void paused() { if(child!=null) child.paused(); }
    @Override public void resumed() { if(child!=null) child.stopped(); child=null; selected=null; waits=0; }
    @Override public void stopped() { session.close(); if(child!=null) child.stopped(); }
    private Step complete(boolean success,String detail) {
        world.event("PICKUP",detail+"; verified="+collected,MC.player.blockPosition());
        return success?Step.done(detail+"; server_confirmed_items="+collected):Step.failed(detail+"; server_confirmed_items="+collected);
    }
    @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
        if(child!=null) {
            if(selected!=null&&lastPosition!=null) {
                var moving=MC.level.getEntitiesOfClass(ItemEntity.class,MC.player.getBoundingBox().inflate(64),e->e.getUUID().equals(selected)).stream().findFirst();
                if(moving.isPresent()&&moving.get().position().distanceTo(lastPosition)>2) { child.stopped(); child=null; waits=0; }
            }
        }
        if(child!=null) {
            var step=child.next(state,last,receipt); if(step.action()!=null) return step; child.stopped(); child=null;
            if(step.outcome()!=PlayerProgress.Outcome.SUCCEEDED) { if(selected!=null) rejected.add(selected); selected=null; lastProblem=step.detail(); if(mode.equals("recover")&&++recoveryFailures>2) return complete(false,lastProblem); }
        }
        var proof=session.read(); if(proof==null) return Step.action(json(input("WAIT",2)));
        if(proof.truncated()) return complete(false,"PICKUP_RECEIPT_WINDOW_EXCEEDED");
        collected=proof.entries().stream().filter(e->matches(e.item())).mapToInt(PickupJournal.Entry::count).sum();
        if(wanted>0&&collected>=wanted || mode.equals("nearest")&&collected>0) return complete(true,"Requested collection verified");
        if(MC.level.getGameTime()-started>2400) return complete(false,"Pickup work budget exceeded; remaining items were not credited");
        var close=PlayerSurvivalReflexes.closeMenu(); if(close!=null) return Step.action(close);
        if(mode.equals("recover")&&MC.player.blockPosition().distSqr(center)>radius*radius) {
            BlockPos destination=center;
            Vec3 delta=Vec3.atBottomCenterOf(center).subtract(MC.player.position());
            if(delta.horizontalDistance()>24) {
                Vec3 intermediate=MC.player.position().add(new Vec3(delta.x,0,delta.z).normalize().scale(24)); destination=null;
                for(int y=MC.player.blockPosition().getY()+4;y>=MC.player.blockPosition().getY()-4;y--) {
                    BlockPos p=BlockPos.containing(intermediate.x,y,intermediate.z); if(world.standable(PlayerWorld.point(p))) { destination=p; break; }
                }
                if(destination==null) return complete(false,"No safe loaded waypoint toward remembered death position");
            }
            child=SurvivalPlayerTasks.walkTo(destination); return Step.action(action("WAIT"));
        }
        List<ItemEntity> candidates=MC.level.getEntitiesOfClass(ItemEntity.class,new AABB(center).inflate(radius),e->e.isAlive()&&!e.getItem().isEmpty()&&matches(e)&&!rejected.contains(e.getUUID())&&world.visible(e.blockPosition()))
                .stream().sorted(Comparator.comparingDouble(MC.player::distanceToSqr)).toList();
        ItemEntity item=selected==null?null:candidates.stream().filter(e->e.getUUID().equals(selected)).findFirst().orElse(null);
        if(selected!=null&&item==null) { selected=null; waits=0; lastProblem="Previously selected stack disappeared/merged/moved; no pickup is assumed"; }
        if(item==null) {
            if(candidates.isEmpty()) {
                if(++emptyScans<3) return Step.action(json(input("WAIT",10)));
                return complete(wanted>0?collected>=wanted:rejected.isEmpty(),"No more eligible visible items; rejected="+rejected.size()+"; "+lastProblem);
            }
            if(++attempted>128) return complete(false,"Too many inaccessible or moving item stacks");
            item=candidates.getFirst(); selected=item.getUUID(); waits=0; emptyScans=0;
        }
        if(PlayerInventoryTasks.capacity(item.getItem())<=0) {
            if(!compacted) { compacted=true; child=new PlayerInventoryTasks.Compact(1); return Step.action(action("WAIT")); }
            return complete(false,"INVENTORY_FULL: no automatic discarding; free storage space first");
        }
        var reach=new ItemReach(item.getBoundingBox()); BlockPos feet=MC.player.blockPosition();
        if(reach.centerTouches(feet.getX(),feet.getY(),feet.getZ())&&MC.player.position().distanceTo(Vec3.atBottomCenterOf(feet))<.5) {
            if(++waits<=8) return Step.action(json(input("WAIT",5)));
            rejected.add(selected); selected=null; lastProblem="Within pickup range but no matching server receipt; delay, ownership, components or obstruction may block it";
            return Step.action(action("WAIT"));
        }
        BlockPos destination=null; List<dev.mcplayeragent.harness.PlayerEvidence.Point> best=List.of(); BlockPos at=item.blockPosition();
        for(BlockPos p:BlockPos.betweenClosed(at.offset(-2,-2,-2),at.offset(2,1,2))) {
            if(!world.standable(PlayerWorld.point(p))||!reach.centerTouches(p.getX(),p.getY(),p.getZ())) continue;
            var route=SurfaceRoute.find(PlayerWorld.point(feet),PlayerWorld.point(p),world::standable,world::clear,1500);
            if(p.equals(feet)||!route.isEmpty()&&(best.isEmpty()||route.size()<best.size())) { destination=p.immutable(); best=route; if(p.equals(feet)) break; }
        }
        if(destination==null) { rejected.add(selected); selected=null; lastProblem="NO_SAFE_PICKUP_ROUTE: do not jump into lava, deep water or a pit for loot"; return Step.action(action("WAIT")); }
        lastPosition=item.position(); child=SurvivalPlayerTasks.walkTo(destination); return Step.action(action("WAIT"));
    }
}
