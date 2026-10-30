/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.mixin;

import net.minecraft.client.MouseHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(MouseHandler.class)
public abstract class PlayerControlMouseMixin {
    @Shadow private double accumulatedDX;
    @Shadow private double accumulatedDY;
    @Shadow private boolean ignoreFirstMove;
    @Shadow private double xpos;
    @Shadow private double ypos;

    @Inject(method = "onMove", at = @At("HEAD"))
    private void mcplayeragent$guiMouse(long window, double x, double y, CallbackInfo ci) {
        if (!ignoreFirstMove && net.minecraft.client.Minecraft.getInstance().screen != null
                && (Math.abs(x - xpos) > 0.01 || Math.abs(y - ypos) > 0.01))
            dev.mcplayeragent.minecraft.PlayerControl.mouseMoved();
    }

    @Inject(method = "onPress", at = @At("HEAD"))
    private void mcplayeragent$humanClick(long window, int button, int action, int modifiers, CallbackInfo ci) {
        if (action == org.lwjgl.glfw.GLFW.GLFW_PRESS)
            dev.mcplayeragent.minecraft.PlayerControl.mouseMoved();
    }

    @Inject(method = "turnPlayer", at = @At("HEAD"))
    private void mcplayeragent$manualMouse(double frameTime, CallbackInfo ci) {
        // Vanilla has already discarded cursor warps and its first move after grabbing the window.
        if (Math.abs(accumulatedDX) > 0.01 || Math.abs(accumulatedDY) > 0.01) {
            dev.mcplayeragent.minecraft.PlayerControl.mouseMoved();
        }
    }

    @Inject(method = "onScroll", at = @At("HEAD"))
    private void mcplayeragent$manualScroll(long window, double x, double y, CallbackInfo ci) {
        if (x != 0 || y != 0) dev.mcplayeragent.minecraft.PlayerControl.mouseMoved();
    }
}
