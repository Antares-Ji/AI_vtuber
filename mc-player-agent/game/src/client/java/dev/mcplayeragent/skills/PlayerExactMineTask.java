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
import net.minecraft.world.phys.Vec3;
import static dev.mcplayeragent.skills.SurvivalPlayerTasks.*;

/** Explicit single-block intent, including a separate verified nearby-drop collection phase. */
final class PlayerExactMineTask implements Task {
    private static final Minecraft MC=Minecraft.getInstance(); private final PlayerWorld world;
    private final BlockPos target; private final String block; private final int reserve;
    private final PlayerPickupSession session=new PlayerPickupSession(); private Task child;
    private boolean cleared,collected,ours; private String failure;
    PlayerExactMineTask(PlayerWorld world,JsonObject args) {
        this.world=world; target=new BlockPos(args.get("x").getAsInt(),args.get("y").getAsInt(),args.get("z").getAsInt());
        if(!MC.level.hasChunkAt(target)) throw new IllegalArgumentException("Explicit mining target must be in a loaded chunk");
        block=PlayerDigTask.id(target); reserve=PlayerMineTask.integer(args,"durability_reserve",2,0,1000);
    }
    @Override public void resumed() { if(child!=null) child.resumed(); }
    @Override public void paused() { if(child!=null) child.paused(); }
    @Override public void stopped() { session.close(); if(child!=null) child.stopped(); }
    @Override public Step next(PlayerEvidence state,PlayerProgress.Outcome last,String receipt) {
        if(child!=null) { var step=child.next(state,last,receipt); if(step.action()!=null) return step;
            if(child instanceof PlayerDigTask dig) { cleared=step.outcome()==PlayerProgress.Outcome.SUCCEEDED; ours=dig.broken(); }
            if(step.outcome()!=PlayerProgress.Outcome.SUCCEEDED) failure=step.detail(); child.stopped(); child=null; }
        var proof=session.read(); if(proof==null) return Step.action(json(input("WAIT",2)));
        int picked=proof.entries().stream().filter(e->MiningTargets.dropMatches(block,e.item())).mapToInt(PickupJournal.Entry::count).sum();
        if(failure!=null) return Step.failed(failure+"; confirmed_pickup="+picked);
        if(!cleared) {
            if(!world.visible(target)||MC.player.getEyePosition().distanceTo(Vec3.atCenterOf(target))>=MC.player.blockInteractionRange()-.1) {
                BlockPos p=PlayerMineTask.approach(world,target); if(p==null) return Step.failed("NO_SAFE_APPROACH to "+target);
                child=walkTo(p);
            } else child=new PlayerDigTask(world,target,reserve);
            return Step.action(action("WAIT"));
        }
        if(!collected) { collected=true; JsonObject pickup=new JsonObject(); pickup.addProperty("mode","filtered"); pickup.addProperty("resource",block); pickup.addProperty("radius",8); child=new PlayerPickupTask(world,pickup); return Step.action(json(input("WAIT",10))); }
        return Step.done("Target cleared at "+target+"; our_break="+ours+"; server_confirmed_pickup="+picked);
    }
}
