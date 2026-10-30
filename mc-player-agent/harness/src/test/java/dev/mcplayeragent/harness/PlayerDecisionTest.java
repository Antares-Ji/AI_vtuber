/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PlayerDecisionTest {
    private static final String VALID = """
            {"action":"MOVE","ticks":20,"forward":1,"strafe":0,"jump":true,"yaw":-90,"pitch":0,"slot":0}
            """;
    @Test void acceptsNativeInput() {
        PlayerDecision d = PlayerDecision.parse(VALID);
        assertEquals(PlayerDecision.Kind.MOVE, d.action()); assertEquals(20, d.ticks());
        assertTrue(d.jump()); assertEquals(-90, d.yaw());
    }
    @Test void rejectsInvalidWireTypesAndUnknownPrimitives() {
        for (String text : new String[] {
                VALID.replace("20", "0"), VALID.replace("20", "1.5"), VALID.replace("20", "1.0000000000001"),
                VALID.replace("20", "2147483648"), VALID.replace("MOVE", "SHELL"),
                VALID.replace("\"slot\":0", "\"slot\":9"),
                VALID.replace("\"forward\":1", "\"forward\":\"1\""), VALID.replace("true", "\"true\""),
                VALID.replace("\"slot\":0", "\"slot\":0,\"code\":\"teleport\"")})
            assertThrows(RuntimeException.class, () -> PlayerDecision.parse(text), text);
    }
    @Test void rejectsMissingActionAndProse() {
        assertThrows(RuntimeException.class, () -> PlayerDecision.parse("{}"));
        assertThrows(RuntimeException.class, () -> PlayerDecision.parse("not JSON"));
        assertThrows(RuntimeException.class, () -> PlayerDecision.parsePlan("{\"actions\":[]}"));
    }
    @Test void noArtificialTwentyOrTwoHundredTickLimit() {
        assertEquals(72000, PlayerDecision.parse(VALID.replace("20", "72000")).ticks());
        assertEquals(2147483647, PlayerDecision.parse(VALID.replace("MOVE", "BREAK").replace("20", "2147483647")).ticks());
        assertEquals(-179, PlayerDecision.parse(VALID.replace("-90", "181")).yaw());
    }
    @Test void omittedOrientationAndSelectionPreservePlayerState() {
        PlayerDecision d = PlayerDecision.parse("{\"action\":\"WAIT\"}");
        assertTrue(Float.isNaN(d.yaw())); assertTrue(Float.isNaN(d.pitch())); assertEquals(-1, d.slot());
    }
    @Test void supportsChainedNativeInventoryCraftAndWorldActions() {
        var plan = PlayerDecision.parsePlan("""
                {"actions":[{"action":"INPUT","ticks":40,"sprint":true,"forward":1,"use":true},
                {"action":"INVENTORY"},{"action":"CLICK","menu":0,"index":9,"click":"QUICK_MOVE"},
                {"action":"CRAFT","menu":0,"text":"minecraft:oak_planks"},
                {"action":"GUI_CLICK","screen":"game.Screen","index":2},
                {"action":"COMMAND","text":"time set day"},{"action":"DONE"}]}
                """);
        assertEquals(7, plan.size()); assertTrue(plan.getFirst().sprint()); assertTrue(plan.getFirst().use());
        assertEquals(PlayerDecision.Kind.CRAFT, plan.get(3).action());
        assertEquals("game.Screen", plan.get(4).screen());
    }
    @Test void commandAndRecipeNeedText() {
        assertThrows(RuntimeException.class, () -> PlayerDecision.parse("{\"action\":\"COMMAND\"}"));
        assertThrows(RuntimeException.class, () -> PlayerDecision.parse("{\"action\":\"CRAFT\"}"));
        assertThrows(RuntimeException.class, () -> PlayerDecision.parse("{\"action\":\"CLICK\",\"click\":\"NOT_NATIVE\"}"));
    }
    @Test void nativeOffhandSlotSwapUsesButtonForty() {
        var d = PlayerDecision.parse("{\"action\":\"CLICK\",\"menu\":0,\"index\":9,\"click\":\"SWAP\",\"button\":40}");
        assertEquals(40, d.button());
    }
}
