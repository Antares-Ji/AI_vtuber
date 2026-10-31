/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.minecraft;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import org.lwjgl.glfw.GLFW;
public final class AgentKeys {
    public static final KeyMapping SETTINGS=new KeyMapping("key.mcplayeragent.settings",GLFW.GLFW_KEY_F8,"key.categories.mcplayeragent");
    public static final KeyMapping STOP=new KeyMapping("key.mcplayeragent.stop",GLFW.GLFW_KEY_F9,"key.categories.mcplayeragent");
    public static void initialize() { LegacyMigration.run(); DirectorControl.initialize(); }
    public static void tick() {
        while(STOP.consumeClick()) { DirectorControl.cancelAll(); PlayerControl.stop("F9 急停"); }
        while(SETTINGS.consumeClick()) { DirectorControl.cancelAll(); PlayerControl.stop("打开设置"); Minecraft.getInstance().setScreen(new MissionControlScreen()); }
        DirectorControl.tick();
        PlayerControl.tick();
    }
}
