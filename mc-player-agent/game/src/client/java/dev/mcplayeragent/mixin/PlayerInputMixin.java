/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.mixin;
import net.minecraft.client.player.Input;
import net.minecraft.client.player.KeyboardInput;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.*;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
@Mixin(KeyboardInput.class)
public abstract class PlayerInputMixin extends Input {
    @Inject(method="tick",at=@At("TAIL"))
    private void mcplayeragent$input(boolean slowDown,float multiplier,CallbackInfo ci) {
        dev.mcplayeragent.minecraft.PlayerControl.input(this);
    }
}
