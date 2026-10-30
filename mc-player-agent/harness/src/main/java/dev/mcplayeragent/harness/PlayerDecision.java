/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import com.google.gson.*;
import java.util.*;

/** Native game inputs, not executable Java or operating-system commands. */
public record PlayerDecision(Kind action, int ticks, float forward, float strafe, boolean jump,
        float yaw, float pitch, int slot, boolean sneak, boolean sprint, boolean attack, boolean use,
        boolean offhand, boolean all, String text, int menu, int index, int button, String click, String screen,
        PlayerCondition until, PlayerCondition requires, JsonObject args) {
    public enum Kind { INPUT, WAIT, MOVE, LOOK, BREAK, PLACE, USE, ATTACK, SELECT, DROP, SWAP,
        INVENTORY, CLOSE, CLICK, CRAFT, RECIPES, GUI_CLICK, TEXT, KEY, COMMAND, CHAT, DONE, SKILL }
    private static final Set<String> FIELDS = Set.of("action", "ticks", "forward", "strafe", "jump",
            "yaw", "pitch", "slot", "sneak", "sprint", "attack", "use", "offhand", "all", "text",
            "menu", "index", "button", "click", "screen", "until", "requires", "args");
    private static final Set<String> CLICKS = Set.of("PICKUP", "QUICK_MOVE", "SWAP", "CLONE",
            "THROW", "QUICK_CRAFT", "PICKUP_ALL");

    public static List<PlayerDecision> parsePlan(String text) {
        return PlayerPlan.parse(text).actions();
    }
    public static PlayerDecision parse(String text) { return parse(JsonParser.parseString(text).getAsJsonObject()); }
    static PlayerDecision parse(JsonObject o) {
        if (!FIELDS.containsAll(o.keySet()) || !o.has("action")) throw new IllegalArgumentException("Unknown or missing action fields");
        Kind kind = Kind.valueOf(string(o, "action", ""));
        float yaw = number(o, "yaw", Float.NaN, -Float.MAX_VALUE, Float.MAX_VALUE);
        if (!Float.isNaN(yaw)) { yaw %= 360; if (yaw > 180) yaw -= 360; if (yaw < -180) yaw += 360; }
        String click = string(o, "click", "PICKUP");
        if (!CLICKS.contains(click)) throw new IllegalArgumentException("Unknown native click type");
        String text = string(o, "text", "");
        if (EnumSet.of(Kind.CRAFT, Kind.COMMAND, Kind.CHAT, Kind.SKILL).contains(kind) && text.isBlank())
            throw new IllegalArgumentException("This action needs text");
        return new PlayerDecision(kind, integer(o, "ticks", 20, 1, Integer.MAX_VALUE),
                number(o, "forward", 0, -1, 1), number(o, "strafe", 0, -1, 1), bool(o, "jump"),
                yaw, number(o, "pitch", Float.NaN, -90, 90), integer(o, "slot", -1, 0, 8),
                bool(o, "sneak"), bool(o, "sprint"), bool(o, "attack"), bool(o, "use"),
                bool(o, "offhand"), bool(o, "all"), text, integer(o, "menu", -1, 0, Integer.MAX_VALUE),
                integer(o, "index", -1, -999, Integer.MAX_VALUE), integer(o, "button", 0, 0, 127), click,
                string(o, "screen", ""), o.has("until") ? PlayerCondition.parse(o.getAsJsonObject("until")) : null,
                o.has("requires") ? PlayerCondition.parse(o.getAsJsonObject("requires")) : null,
                o.has("args") ? o.getAsJsonObject("args").deepCopy() : new JsonObject());
    }
    private static boolean bool(JsonObject o, String key) {
        if (!o.has(key)) return false;
        if (!o.get(key).isJsonPrimitive() || !o.getAsJsonPrimitive(key).isBoolean()) throw new IllegalArgumentException(key + " must be boolean");
        return o.get(key).getAsBoolean();
    }
    private static String string(JsonObject o, String key, String fallback) {
        if (!o.has(key)) return fallback;
        if (!o.get(key).isJsonPrimitive() || !o.getAsJsonPrimitive(key).isString()) throw new IllegalArgumentException(key + " must be string");
        return o.get(key).getAsString();
    }
    private static int integer(JsonObject o, String key, int fallback, int min, int max) {
        if (!o.has(key)) return fallback;
        if (!o.get(key).isJsonPrimitive() || !o.getAsJsonPrimitive(key).isNumber()) throw new IllegalArgumentException(key + " must be integer");
        int n;
        try { n = o.get(key).getAsBigDecimal().intValueExact(); }
        catch (ArithmeticException e) { throw new IllegalArgumentException(key + " must be an int32", e); }
        if (n < min || n > max) throw new IllegalArgumentException(key + " out of range");
        return n;
    }
    private static float number(JsonObject o, String key, float fallback, float min, float max) {
        if (!o.has(key)) return fallback;
        if (!o.get(key).isJsonPrimitive() || !o.getAsJsonPrimitive(key).isNumber()) throw new IllegalArgumentException(key + " must be number");
        float n = o.get(key).getAsFloat();
        if (!Float.isFinite(n) || n < min || n > max) throw new IllegalArgumentException(key + " out of range");
        return n;
    }
}
