/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import com.google.gson.*;
import java.util.*;

/** Actions plus a brief public explanation; private provider reasoning is never part of this record. */
public record PlayerPlan(List<PlayerDecision> actions, String summary, String phase, PlayerCondition goalCheck, JsonArray agenda) {
    public PlayerPlan { actions = List.copyOf(actions); }

    public static PlayerPlan parse(String text) {
        JsonObject root = JsonParser.parseString(text).getAsJsonObject();
        if (!root.has("actions")) return new PlayerPlan(List.of(PlayerDecision.parse(root)), "", "", null, new JsonArray());
        if (!Set.of("actions", "summary", "phase", "goal_check", "agenda").containsAll(root.keySet()))
            throw new IllegalArgumentException("Expected actions and optional public summary only");
        String summary = "";
        if (root.has("summary")) {
            var value = root.get("summary");
            if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString())
                throw new IllegalArgumentException("summary must be a string");
            summary = displayText(value.getAsString());
        }
        List<PlayerDecision> actions = new ArrayList<>();
        for (JsonElement e : root.getAsJsonArray("actions")) actions.add(PlayerDecision.parse(e.getAsJsonObject()));
        if (actions.isEmpty()) throw new IllegalArgumentException("Empty action plan");
        String phase = root.has("phase") ? displayText(root.get("phase").getAsString()) : "";
        JsonArray agenda=root.has("agenda")?root.getAsJsonArray("agenda").deepCopy():new JsonArray();
        for(JsonElement e:agenda) {
            if(!e.isJsonObject()||!e.getAsJsonObject().has("goal")||!e.getAsJsonObject().get("goal").isJsonPrimitive()
                    ||!e.getAsJsonObject().getAsJsonPrimitive("goal").isString()) throw new IllegalArgumentException("agenda entries need a goal string");
        }
        return new PlayerPlan(actions, summary, phase, root.has("goal_check") ? PlayerCondition.parse(root.getAsJsonObject("goal_check")) : null, agenda);
    }

    /** Keep chat output on one short line and remove formatting/control characters. */
    public static String displayText(String text) {
        String clean = text.replaceAll("[\\p{Cntrl}§]", " ").strip();
        int count = clean.codePointCount(0, clean.length());
        return count > 160 ? clean.substring(0, clean.offsetByCodePoints(0, 160)) + "…" : clean;
    }
}
