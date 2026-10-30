/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import java.util.Map;

/** Immutable server observations; UI and view fields are supplied by the client on receipt. */
public record PlayerEvidence(double x, double y, double z, float yaw, float pitch, int slot, int menu,
        String screen, String gui, String inventory, String menuContents, String hand, String offhand,
        Map<String, Integer> items, Map<Point, String> blocks, Map<Integer, Float> entityHealth, long serverTick) {
    public record Point(int x, int y, int z) {}
    public PlayerEvidence { items = Map.copyOf(items); blocks = Map.copyOf(blocks); entityHealth = Map.copyOf(entityHealth); }
    public PlayerEvidence withView(float newYaw, float newPitch, String newScreen, String newGui) {
        return new PlayerEvidence(x, y, z, newYaw, newPitch, slot, menu, newScreen, newGui, inventory,
                menuContents, hand, offhand, items, blocks, entityHealth, serverTick);
    }
    public double distance(PlayerEvidence other) {
        return Math.sqrt(Math.pow(x - other.x, 2) + Math.pow(y - other.y, 2) + Math.pow(z - other.z, 2));
    }
    public String stableKey() {
        return Math.round(x * 10) + ":" + Math.round(y * 10) + ":" + Math.round(z * 10)
                + ":" + Math.round(yaw / 2) + ":" + Math.round(pitch / 2) + ":" + slot
                + ":" + menu + ":" + screen + ":" + gui + ":" + inventory + ":" + menuContents + ":" + blocks + ":" + entityHealth;
    }
}
