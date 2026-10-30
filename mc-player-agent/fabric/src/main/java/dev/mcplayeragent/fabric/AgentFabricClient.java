/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.fabric;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import dev.mcplayeragent.minecraft.*;
public final class AgentFabricClient implements ClientModInitializer {
    public void onInitializeClient() {
        AgentKeys.initialize(); KeyBindingHelper.registerKeyBinding(AgentKeys.SETTINGS); KeyBindingHelper.registerKeyBinding(AgentKeys.STOP);
        ClientTickEvents.END_CLIENT_TICK.register(mc->AgentKeys.tick());
        ClientPlayConnectionEvents.DISCONNECT.register((handler,mc)->PlayerControl.stop("离开世界"));
    }
}
