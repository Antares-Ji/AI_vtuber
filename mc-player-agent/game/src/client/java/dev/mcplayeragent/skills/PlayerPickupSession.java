/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import net.minecraft.client.Minecraft;
import java.util.*;
import java.util.concurrent.CompletableFuture;

/** Marshals receipt access onto the owning integrated server; observations contain no client predictions. */
final class PlayerPickupSession {
    record Snapshot(List<PickupJournal.Entry> entries,boolean truncated) {}
    private final net.minecraft.server.MinecraftServer server=Minecraft.getInstance().getSingleplayerServer();
    private final UUID player=Minecraft.getInstance().player.getUUID();
    private PlayerPickupWatch.Lease lease; private volatile boolean closed;
    private CompletableFuture<Snapshot> pending;
    Snapshot read() {
        if(pending==null) {
            pending=new CompletableFuture<>(); var future=pending;
            server.execute(()-> { try {
                if(closed) { future.complete(new Snapshot(List.of(),false)); return; }
                if(lease==null) { var owner=server.getPlayerList().getPlayer(player); if(owner==null) throw new IllegalStateException("Pickup owner left world"); lease=PlayerPickupWatch.open(owner); }
                future.complete(new Snapshot(lease.entries(),lease.truncated()));
            } catch(Exception e) { future.completeExceptionally(e); } });
            return null;
        }
        if(!pending.isDone()) return null;
        Snapshot value=pending.join(); pending=null; return value;
    }
    void close() {
        if(closed) return; closed=true;
        if(server.isStopped()) { if(lease!=null) lease.close(); }
        else server.execute(()-> { if(lease!=null) lease.close(); });
    }
}
