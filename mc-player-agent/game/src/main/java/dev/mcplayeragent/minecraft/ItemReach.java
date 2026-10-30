/* SPDX-License-Identifier: LGPL-3.0-only
 * Pickup geometry adapted from Numen ItemReach, Dwinovo and contributors. See NOTICE.
 */
package dev.mcplayeragent.minecraft;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.phys.AABB;
public record ItemReach(AABB item) {
    public boolean centerTouches(int x,int y,int z) {
        double half=EntityType.PLAYER.getWidth()/2;
        return new AABB(x+.5-half,y,z+.5-half,x+.5+half,y+EntityType.PLAYER.getHeight(),z+.5+half)
                .inflate(1,.5,1).intersects(item);
    }
}
