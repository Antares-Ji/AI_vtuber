/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.minecraft;

import dev.mcplayeragent.harness.PlayerEvidence;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemStack;
import java.util.*;

/** Reads only on the integrated-server thread; no client prediction is counted as a server result. */
final class PlayerFeedback {
    private PlayerFeedback() {}
    static PlayerEvidence capture(ServerPlayer player, Set<PlayerEvidence.Point> positions, Set<Integer> entities) {
        Map<String, Integer> items = new TreeMap<>();
        StringBuilder inventory = new StringBuilder(), menu = new StringBuilder();
        for (int i = 0; i < player.getInventory().getContainerSize(); i++) {
            var stack = player.getInventory().getItem(i);
            inventory.append(i).append('=').append(signature(stack)).append(';');
            if (!stack.isEmpty()) items.merge(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString(), stack.getCount(), Integer::sum);
        }
        for (var slot : player.containerMenu.slots) menu.append(signature(slot.getItem())).append(';');
        menu.append("cursor=").append(signature(player.containerMenu.getCarried()));
        Map<PlayerEvidence.Point, String> blocks = new LinkedHashMap<>();
        positions.stream().sorted(Comparator.comparingInt(PlayerEvidence.Point::x).thenComparingInt(PlayerEvidence.Point::y)
                .thenComparingInt(PlayerEvidence.Point::z)).forEach(p -> {
            BlockPos pos = new BlockPos(p.x(), p.y(), p.z());
            blocks.put(p, player.serverLevel().hasChunkAt(pos)
                    ? BuiltInRegistries.BLOCK.getKey(player.serverLevel().getBlockState(pos).getBlock()).toString() : "unloaded");
        });
        Map<Integer, Float> health = new HashMap<>();
        for (int id : entities) {
            var entity = player.serverLevel().getEntity(id);
            health.put(id, entity instanceof LivingEntity living ? living.getHealth() : entity == null ? -1F : 1F);
        }
        return new PlayerEvidence(player.getX(), player.getY(), player.getZ(), player.getYRot(), player.getXRot(),
                player.getInventory().selected, player.containerMenu.containerId, "", "", inventory.toString(), menu.toString(),
                signature(player.getMainHandItem()), signature(player.getOffhandItem()), items, blocks, health,
                player.serverLevel().getGameTime());
    }
    static String signature(ItemStack stack) {
        return BuiltInRegistries.ITEM.getKey(stack.getItem()) + "x" + stack.getCount() + ":" + stack.getComponents().hashCode();
    }
    static PlayerEvidence.Point point(BlockPos pos) { return new PlayerEvidence.Point(pos.getX(), pos.getY(), pos.getZ()); }
}
