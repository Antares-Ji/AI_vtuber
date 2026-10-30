/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;

class PlayerConditionTest {
    static PlayerEvidence frame(double x, float yaw, String block, int logs) {
        return new PlayerEvidence(x, 64, 0, yaw, 0, 0, 0, "none", "gui", "inventory", "slot;cursor=air",
                "air", "air", Map.of("minecraft:oak_log", logs), Map.of(new PlayerEvidence.Point(1, 63, 0), block), Map.of(), 10);
    }
    static PlayerCondition condition(String json) { return PlayerCondition.parse(JsonParser.parseString(json).getAsJsonObject()); }
    @Test void distanceCompletesFromMeasuredServerDisplacement() {
        var c = condition("{\"type\":\"distance\",\"value\":4,\"tolerance\":0.1}");
        var start = frame(0, 0, "minecraft:oak_log", 0);
        assertFalse(c.matches(frame(3.5, 0, "minecraft:oak_log", 0), start));
        assertTrue(c.matches(frame(3.95, 0, "minecraft:oak_log", 0), start));
    }
    @Test void positionAndYawHaveRealCompletionTolerances() {
        var start = frame(0, 0, "minecraft:air", 0);
        assertTrue(condition("{\"type\":\"position\",\"x\":4,\"y\":64,\"z\":0}").matches(frame(3.8, 0, "minecraft:air", 0), start));
        assertTrue(condition("{\"type\":\"yaw\",\"value\":180}").matches(frame(0, -180, "minecraft:air", 0), start));
        assertEquals(2, PlayerCondition.angleError(179, -179));
    }
    @Test void blockAndInventoryConditionsNeedObservedChanges() {
        var start = frame(0, 0, "minecraft:oak_log", 0);
        var mine = condition("{\"type\":\"block\",\"x\":1,\"y\":63,\"z\":0,\"block\":\"minecraft:air\"}");
        assertFalse(mine.matches(start, start)); assertTrue(mine.matches(frame(0, 0, "minecraft:air", 0), start));
        var count = condition("{\"type\":\"item_count\",\"item\":\"minecraft:oak_log\",\"count\":8}");
        assertFalse(count.matches(frame(0, 0, "minecraft:air", 7), start));
        assertTrue(count.matches(frame(0, 0, "minecraft:air", 8), start));
    }
    @Test void supportsInventoryRemovalAndRoundTripsConditionJson() {
        var c = condition("{\"type\":\"item_count\",\"item\":\"minecraft:oak_log\",\"count\":0,\"op\":\"eq\"}");
        assertFalse(c.matches(frame(0, 0, "minecraft:air", 1), frame(0, 0, "minecraft:air", 8)));
        assertTrue(c.matches(frame(0, 0, "minecraft:air", 0), frame(0, 0, "minecraft:air", 8)));
        assertEquals(c, PlayerCondition.parse(c.json()));
    }
    @Test void rejectsAmbiguousOrInvalidPredicates() {
        for (String json : new String[]{"{\"type\":\"position\",\"x\":1}", "{\"type\":\"distance\",\"value\":-1}",
                "{\"type\":\"block\",\"x\":1.5,\"y\":1,\"z\":1,\"block\":\"minecraft:air\"}",
                "{\"type\":\"menu\",\"value\":0.5}", "{\"type\":\"yaw\",\"value\":1e999}"})
            assertThrows(RuntimeException.class, () -> condition(json));
    }
}
