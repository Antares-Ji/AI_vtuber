/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.neoforge;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStoppedEvent;
import dev.mcplayeragent.minecraft.*;
@Mod("mcplayeragent")
public final class AgentNeoForge {
    public AgentNeoForge() {
        AgentPaths.configure(FMLPaths.CONFIGDIR.get());
        NeoForge.EVENT_BUS.addListener((ServerStoppedEvent event)->AgentLifecycle.fireStopped());
    }
}
