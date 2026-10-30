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
import net.minecraft.core.*;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.*;
import java.util.List;
import static dev.mcplayeragent.skills.SurvivalPlayerTasks.*;

/** Places one chosen cell by selecting an actual visible neighbour face; roof work may require a native jump. */
final class PlayerPlacementTask implements Task {
    private static final Minecraft MC=Minecraft.getInstance();
    private final BlockPos target; private final String block; private int stage;
    PlayerPlacementTask(BlockPos target,String block) { this.target=target; this.block=block; }
    @Override public void resumed() { stage=0; }
    @Override public Step next(PlayerEvidence evidence,PlayerProgress.Outcome last,String receipt) {
        if(failed(last)) return Step.failed("Placement failed at "+target+": "+receipt);
        if(BuiltInRegistries.BLOCK.getKey(MC.level.getBlockState(target).getBlock()).toString().equals(block)) return Step.done("Placed "+block+" at "+target);
        if(stage==3) return Step.failed("Placement was not reflected in world state at "+target);
        var item=BuiltInRegistries.ITEM.get(ResourceLocation.parse(block));
        var park=PlayerSurvivalReflexes.parkCursor(); if(park!=null) return Step.action(park);
        var select=equip(s->s.is(item)); if(select!=null) return Step.action(select);
        var close=PlayerSurvivalReflexes.closeMenu(); if(close!=null) return Step.action(close);
        if(!MC.level.getBlockState(target).canBeReplaced()) return Step.failed("Cell occupied; do not overwrite existing structure at "+target);
        Vec3 eye=MC.player.getEyePosition(), aim=face(eye);
        if(stage==0&&aim==null) {
            if(!MC.player.onGround()) return Step.failed("Cannot plan roof placement from unstable ground");
            aim=face(eye.add(0,1.1,0)); if(aim==null) return Step.failed("No visible native placement face for "+target);
            stage=1; return Step.action(aim("LOOK",aim,eye.add(0,1.1,0)));
        }
        if(stage==1) { stage=2; JsonObject jump=input("INPUT",5); jump.addProperty("jump",true); return Step.action(json(jump)); }
        if(aim==null) return Step.failed("Placement face no longer visible at "+target);
        stage=3; PlayerDecision pose=aim("PLACE",aim,eye); JsonObject place=input("PLACE",30);
        place.addProperty("yaw",pose.yaw()); place.addProperty("pitch",pose.pitch()); place.add("until",blockCondition(target,block));
        return Step.action(json(place));
    }
    private Vec3 face(Vec3 eye) {
        for(Direction direction:Direction.values()) {
            BlockPos anchor=target.relative(direction); if(!MC.level.hasChunkAt(anchor)||MC.level.getBlockState(anchor).getCollisionShape(MC.level,anchor).isEmpty()) continue;
            Direction side=direction.getOpposite(); Vec3 normal=Vec3.atLowerCornerOf(side.getNormal());
            for(double shift:new double[]{0,-.45,.45}) {
                Vec3 point=Vec3.atCenterOf(anchor).add(normal.scale(.499));
                point=side.getAxis()==Direction.Axis.Y?point.add(shift,0,0):point.add(0,shift,0);
                if(eye.distanceTo(point)>MC.player.blockInteractionRange()-.05) continue;
                var hit=MC.level.clip(new ClipContext(eye,point,ClipContext.Block.COLLIDER,ClipContext.Fluid.NONE,MC.player));
                if(hit.getType()==HitResult.Type.BLOCK&&hit.getBlockPos().equals(anchor)&&hit.getDirection()==side) return point;
            }
        }
        return null;
    }
    private static PlayerDecision aim(String action,Vec3 target,Vec3 eye) {
        Vec3 d=target.subtract(eye); JsonObject o=input(action,30);
        o.addProperty("yaw",Math.toDegrees(Math.atan2(-d.x,d.z))); o.addProperty("pitch",-Math.toDegrees(Math.atan2(d.y,Math.hypot(d.x,d.z)))); return json(o);
    }
}
