/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class PlayerPlanTest {
    @Test void durableAgendaAndTaskArgumentsSurvivePlanning() {
        var plan=PlayerPlan.parse("""
                {"agenda":[{"goal":"先收集完整树木，再合成木镐","status":"active"}],
                "actions":[{"action":"SKILL","text":"craft_item","args":{"item":"minecraft:wooden_pickaxe","count":1}}]}
                """);
        assertEquals(1,plan.agenda().size());
        assertEquals(PlayerDecision.Kind.SKILL,plan.actions().getFirst().action());
        assertEquals("minecraft:wooden_pickaxe",plan.actions().getFirst().args().get("item").getAsString());
    }
    @Test void parsesPhasePreconditionsAndVerifiableGoalTogether() {
        var plan = PlayerPlan.parse("""
                {"phase":"收集材料","goal_check":{"type":"item_count","item":"minecraft:oak_log","count":8},
                 "actions":[{"action":"BREAK","ticks":120,
                 "requires":{"type":"item_count","item":"minecraft:oak_log","count":8,"op":"lte"},
                 "until":{"type":"block","x":1,"y":64,"z":3,"block":"minecraft:air"}}]}
                """);
        assertEquals("收集材料", plan.phase());
        assertEquals(PlayerCondition.Type.ITEM_COUNT, plan.goalCheck().type());
        assertEquals("lte", plan.actions().getFirst().requires().op());
        assertEquals(new PlayerEvidence.Point(1, 64, 3), plan.actions().getFirst().until().point());
    }
    @Test void parsesPublicSummaryWithoutChangingActionExecution() {
        var plan = PlayerPlan.parse("""
                {"summary":"先接近木头，再开始挖掘。","actions":[{"action":"MOVE","forward":1},{"action":"BREAK","ticks":100}]}
                """);
        assertEquals("先接近木头，再开始挖掘。", plan.summary());
        assertEquals(2, plan.actions().size());
        assertEquals(PlayerDecision.Kind.BREAK, plan.actions().get(1).action());
        assertEquals(2, PlayerDecision.parsePlan("{\"summary\":\"计划\",\"actions\":[{\"action\":\"LOOK\"},{\"action\":\"DONE\"}]}").size());
    }
    @Test void olderActionOnlyResponsesRemainCompatible() {
        assertEquals("", PlayerPlan.parse("{\"action\":\"WAIT\"}").summary());
        assertEquals("", PlayerPlan.parse("{\"actions\":[{\"action\":\"WAIT\"}]}").summary());
    }
    @Test void providerPrivateReasoningIsNotAnAcceptedChatField() {
        assertThrows(IllegalArgumentException.class, () -> PlayerPlan.parse(
                "{\"reasoning_content\":\"private\",\"actions\":[{\"action\":\"WAIT\"}]}"));
        assertThrows(IllegalArgumentException.class, () -> PlayerPlan.parse(
                "{\"summary\":{},\"actions\":[{\"action\":\"WAIT\"}]}"));
    }
    @Test void chatTextIsShortSingleLineAndDoesNotBreakUnicode() {
        assertEquals("计划 一", PlayerPlan.displayText("计划\n一"));
        assertFalse(PlayerPlan.displayText("§c计划\r\n下一步").contains("§"));
        String longText = "😀".repeat(200);
        String shortText = PlayerPlan.displayText(longText);
        assertEquals(161, shortText.codePointCount(0, shortText.length()));
        assertTrue(shortText.endsWith("…"));
    }
}
