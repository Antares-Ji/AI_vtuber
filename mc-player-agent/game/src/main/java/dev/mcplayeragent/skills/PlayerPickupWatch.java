/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.core.registries.BuiltInRegistries;
import java.util.*;

/** Server thread pickup receipts; nested collection tasks share a reference counted stream. */
public final class PlayerPickupWatch {
    private PlayerPickupWatch() {}
    private static final Map<ServerPlayer,Stream> streams=new IdentityHashMap<>();
    static { dev.mcplayeragent.minecraft.AgentLifecycle.onStopped(()-> { synchronized(streams) { streams.clear(); } }); }
    private static final class Stream { final PickupJournal journal=new PickupJournal(); int references; }
    public static final class Lease implements AutoCloseable {
        private final ServerPlayer player; private final Stream stream; private final long cursor; private boolean closed;
        private Lease(ServerPlayer player,Stream stream) { this.player=player; this.stream=stream; cursor=stream.journal.cursor(); }
        public List<PickupJournal.Entry> entries() { return stream.journal.since(cursor); }
        public boolean truncated() { return stream.journal.truncated(cursor); }
        @Override public void close() { synchronized(streams) { if(closed) return; closed=true; if(--stream.references==0) streams.remove(player,stream); } }
    }
    public static Lease open(ServerPlayer player) {
        synchronized(streams) { Stream stream=streams.computeIfAbsent(player,p->new Stream()); stream.references++; return new Lease(player,stream); }
    }
    public static boolean watching(Player player) { synchronized(streams) { return streams.containsKey(player); } }
    public static int count(Player player,ItemStack stack) {
        int count=0; for(int i=0;i<player.getInventory().getContainerSize();i++) {
            ItemStack s=player.getInventory().getItem(i); if(ItemStack.isSameItemSameComponents(s,stack)) count+=s.getCount();
        }
        return count;
    }
    public static void taken(Player player,ItemEntity entity,ItemStack original,int before) {
        if(!(player instanceof ServerPlayer server)) return;
        Stream stream; synchronized(streams) { stream=streams.get(server); } if(stream==null) return;
        stream.journal.accepted(entity.getUUID(),BuiltInRegistries.ITEM.getKey(original.getItem()).toString(),before,count(player,original),
                entity.blockPosition().getX(),entity.blockPosition().getY(),entity.blockPosition().getZ(),server.serverLevel().getGameTime());
    }
}
