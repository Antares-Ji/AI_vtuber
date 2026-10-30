/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

/** Pure hand-off rules, shared with replay tests. Native input still has one owner. */
public final class PlayerContinuity {
    private PlayerContinuity() {}
    public static boolean mining(PlayerDecision current, PlayerDecision next, int slot, float yaw, float pitch, boolean gone) {
        return next != null && !gone && (current.action() == PlayerDecision.Kind.BREAK || current.attack())
                && (next.action() == PlayerDecision.Kind.BREAK || next.attack())
                && (next.slot() < 0 || next.slot() == slot)
                && (Float.isNaN(next.yaw()) || PlayerCondition.angleError(next.yaw(), yaw) < 0.7)
                && (Float.isNaN(next.pitch()) || Math.abs(next.pitch() - pitch) < 0.7)
                && (current.until() == null || next.until() == null || current.until().equals(next.until()));
    }
    public static boolean use(PlayerDecision current, PlayerDecision next, int slot) {
        return next != null && (current.action() == PlayerDecision.Kind.USE || current.use())
                && (next.action() == PlayerDecision.Kind.USE || next.use())
                && current.offhand() == next.offhand() && (next.slot() < 0 || next.slot() == slot);
    }
    public static boolean clickedSlotChanged(String before, String after, int index) {
        String[] a = before.split(";", -1), b = after.split(";", -1);
        if (index >= 0 && index < a.length - 1 && index < b.length - 1 && !a[index].equals(b[index])) return true;
        return !a[a.length - 1].equals(b[b.length - 1]);
    }
}
