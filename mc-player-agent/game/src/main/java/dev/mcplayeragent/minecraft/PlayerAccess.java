/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.minecraft;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;
/** Only the actual integrated-server player is eligible; actions still use native Minecraft checks. */
public final class PlayerAccess {
    private PlayerAccess() {}
    public static boolean authorize(ServerPlayer player,UUID expected) {
        return expected.equals(player.getUUID()) && player.server.isSingleplayer()
                && player.server.getPlayerList().getPlayer(expected)==player;
    }
}
