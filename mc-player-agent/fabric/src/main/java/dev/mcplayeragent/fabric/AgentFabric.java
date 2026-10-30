/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.fabric;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import dev.mcplayeragent.minecraft.*;
public final class AgentFabric implements ModInitializer {
    public void onInitialize() {
        AgentPaths.configure(FabricLoader.getInstance().getConfigDir());
        ServerLifecycleEvents.SERVER_STOPPED.register(server->AgentLifecycle.fireStopped());
    }
}
