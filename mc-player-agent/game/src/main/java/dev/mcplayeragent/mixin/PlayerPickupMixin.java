/* SPDX-License-Identifier: LGPL-3.0-only
 * Adapted from Numen verified player pickup hook, Dwinovo and contributors. See NOTICE.
 */
package dev.mcplayeragent.mixin;
import dev.mcplayeragent.skills.PlayerPickupWatch;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Player;
import com.llamalad7.mixinextras.injector.wrapmethod.WrapMethod;
import com.llamalad7.mixinextras.injector.wrapoperation.Operation;
import org.spongepowered.asm.mixin.Mixin;
@Mixin(ItemEntity.class)
public abstract class PlayerPickupMixin {
    @WrapMethod(method="playerTouch")
    private void mcplayeragent$pickup(Player player,Operation<Void> original) {
        if(player.level().isClientSide||!PlayerPickupWatch.watching(player)) { original.call(player); return; }
        var entity=(ItemEntity)(Object)this; var stack=entity.getItem().copy();
        int before=PlayerPickupWatch.count(player,stack);
        try { original.call(player); } finally { PlayerPickupWatch.taken(player,entity,stack,before); }
    }
}
