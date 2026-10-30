/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.neoforge;
import net.neoforged.fml.common.Mod;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.client.event.*;
import dev.mcplayeragent.minecraft.*;
@Mod(value="mcplayeragent",dist=Dist.CLIENT)
public final class AgentNeoForgeClient {
    public AgentNeoForgeClient(IEventBus bus) {
        AgentKeys.initialize();
        bus.addListener((RegisterKeyMappingsEvent e)->{ e.register(AgentKeys.SETTINGS); e.register(AgentKeys.STOP); });
        NeoForge.EVENT_BUS.addListener((ClientTickEvent.Post e)->AgentKeys.tick());
        NeoForge.EVENT_BUS.addListener((ClientPlayerNetworkEvent.LoggingOut e)->PlayerControl.stop("离开世界"));
    }
}
