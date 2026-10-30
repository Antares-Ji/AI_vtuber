/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import com.google.gson.*;
import java.util.Locale;
import java.util.Set;

/** Completion predicates describe observable results, not permissions or generated code. */
public record PlayerCondition(Type type, double x, double y, double z, double value, double tolerance,
                              String item, String block, String screen, String op) {
    public enum Type { POSITION, DISTANCE, BLOCK, ITEM_COUNT, MENU, SCREEN, YAW }
    public static PlayerCondition parse(JsonObject o) {
        if (!Set.of("type", "x", "y", "z", "value", "count", "tolerance", "item", "block", "screen", "op").containsAll(o.keySet()))
            throw new IllegalArgumentException("Unknown completion condition field");
        Type type = Type.valueOf(o.get("type").getAsString().toUpperCase(Locale.ROOT));
        double x = 0, y = 0, z = 0;
        if (type == Type.POSITION || type == Type.BLOCK) {
            x = number(o, "x"); y = number(o, "y"); z = number(o, "z");
        }
        double value = switch (type) {
            case DISTANCE, MENU, YAW -> number(o, "value");
            case ITEM_COUNT -> number(o, "count");
            default -> 0;
        };
        double tolerance = o.has("tolerance") ? number(o, "tolerance") : type == Type.YAW ? 1 : 0.35;
        if (tolerance < 0 || ((type == Type.DISTANCE || type == Type.ITEM_COUNT) && value < 0))
            throw new IllegalArgumentException("Negative completion distance/count/tolerance");
        if ((type == Type.MENU || type == Type.ITEM_COUNT) && (value != Math.rint(value) || value > Integer.MAX_VALUE || value < 0))
            throw new IllegalArgumentException("Menu and item counts must be nonnegative int32");
        String op = o.has("op") ? o.get("op").getAsString() : "gte";
        if (!Set.of("gte", "lte", "eq").contains(op)) throw new IllegalArgumentException("Unknown condition comparison");
        if (type == Type.BLOCK && (x != Math.rint(x) || y != Math.rint(y) || z != Math.rint(z)
                || Math.abs(x) > Integer.MAX_VALUE || Math.abs(y) > Integer.MAX_VALUE || Math.abs(z) > Integer.MAX_VALUE))
            throw new IllegalArgumentException("Block coordinates must be int32");
        return new PlayerCondition(type, x, y, z, value, tolerance,
                type == Type.ITEM_COUNT ? requiredText(o, "item") : "",
                type == Type.BLOCK ? requiredText(o, "block") : "",
                type == Type.SCREEN ? requiredText(o, "screen") : "", op);
    }
    private static String requiredText(JsonObject o, String key) {
        if (!o.has(key) || !o.get(key).isJsonPrimitive() || !o.getAsJsonPrimitive(key).isString()
                || o.get(key).getAsString().isBlank()) throw new IllegalArgumentException("Missing " + key);
        return o.get(key).getAsString();
    }
    private static double number(JsonObject o, String key) {
        if (!o.has(key) || !o.get(key).isJsonPrimitive() || !o.getAsJsonPrimitive(key).isNumber())
            throw new IllegalArgumentException("Missing numeric condition field " + key);
        double value = o.get(key).getAsDouble();
        if (!Double.isFinite(value)) throw new IllegalArgumentException("Non-finite condition value");
        return value;
    }
    public PlayerEvidence.Point point() { return new PlayerEvidence.Point((int) x, (int) y, (int) z); }
    public double distanceTo(PlayerEvidence now) {
        return Math.sqrt(Math.pow(now.x() - x, 2) + Math.pow(now.y() - y, 2) + Math.pow(now.z() - z, 2));
    }
    public boolean matches(PlayerEvidence now, PlayerEvidence start) {
        return switch (type) {
            case POSITION -> distanceTo(now) <= tolerance;
            case DISTANCE -> now.distance(start) >= Math.max(0, value - tolerance);
            case BLOCK -> block.equals(now.blocks().get(point()));
            case ITEM_COUNT -> switch (op) {
                case "lte" -> now.items().getOrDefault(item, 0) <= value;
                case "eq" -> now.items().getOrDefault(item, 0) == value;
                default -> now.items().getOrDefault(item, 0) >= value;
            };
            case MENU -> now.menu() == value;
            case SCREEN -> screen.equals(now.screen());
            case YAW -> angleError(now.yaw(), value) <= tolerance;
        };
    }
    public static double angleError(double current, double target) {
        double delta = (target - current) % 360;
        if (delta > 180) delta -= 360; if (delta < -180) delta += 360;
        return Math.abs(delta);
    }
    public JsonObject json() {
        JsonObject o = new JsonObject(); o.addProperty("type", type.name().toLowerCase(Locale.ROOT));
        if (type == Type.POSITION || type == Type.BLOCK) { o.addProperty("x", x); o.addProperty("y", y); o.addProperty("z", z); }
        if (type == Type.DISTANCE || type == Type.MENU || type == Type.YAW) o.addProperty("value", value);
        if (type == Type.ITEM_COUNT) { o.addProperty("item", item); o.addProperty("count", value); o.addProperty("op", op); }
        if (type == Type.BLOCK) o.addProperty("block", block);
        if (type == Type.SCREEN) o.addProperty("screen", screen);
        o.addProperty("tolerance", tolerance); return o;
    }
}
