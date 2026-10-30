/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.mixin;

import dev.mcplayeragent.minecraft.PlayerControl;
import net.minecraft.client.KeyboardHandler;
import org.lwjgl.glfw.GLFW;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/** Physical input also cancels takeover while an AI-owned inventory GUI is open. */
@Mixin(KeyboardHandler.class)
public abstract class PlayerControlKeyboardMixin {
    @Inject(method = "keyPress", at = @At("HEAD"))
    private void mcplayeragent$humanKey(long window, int key, int scan, int action, int modifiers, CallbackInfo ci) {
        if (PlayerControl.active() && action == GLFW.GLFW_PRESS)
            PlayerControl.stop(key == GLFW.GLFW_KEY_F9 ? "F9 急停" : "键盘输入，已交还控制");
    }
}
