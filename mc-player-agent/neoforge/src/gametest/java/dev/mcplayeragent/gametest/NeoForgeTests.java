/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.gametest;
import net.neoforged.fml.common.Mod;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.event.RegisterGameTestsEvent;
@Mod("mcplayeragent_tests")
public final class NeoForgeTests {
    public NeoForgeTests(IEventBus bus) { bus.addListener((RegisterGameTestsEvent e)->e.register(AgentSmokeTests.class)); }
}
