/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.mixin;

import net.minecraft.client.Minecraft;
import net.minecraft.client.KeyMapping;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Minecraft.class)
public abstract class PlayerControlAttackMixin {
    @WrapOperation(method = "handleKeybinds", at = @At(value = "INVOKE", target = "Lnet/minecraft/client/KeyMapping;isDown()Z"))
    private boolean mcplayeragent$holdUse(KeyMapping key, Operation<Boolean> original) {
        return original.call(key) || key == Minecraft.getInstance().options.keyUse
                && dev.mcplayeragent.minecraft.PlayerControl.holdsUse();
    }
    @Inject(method = "continueAttack", at = @At("HEAD"), cancellable = true)
    private void mcplayeragent$keepMining(boolean leftClick, CallbackInfo ci) {
        if (!leftClick && dev.mcplayeragent.minecraft.PlayerControl.ownsMining()) ci.cancel();
    }
}
