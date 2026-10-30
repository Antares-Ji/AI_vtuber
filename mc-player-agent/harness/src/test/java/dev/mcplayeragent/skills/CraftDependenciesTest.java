/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import java.util.*;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import dev.mcplayeragent.skills.CraftDependencies.Formula;

class CraftDependenciesTest {
    private static final Formula PLANKS=new Formula("planks","oak_planks",4,2,List.of(List.of("oak_log")));
    private static final Formula STICKS=new Formula("sticks","stick",4,2,List.of(List.of("oak_planks","birch_planks"),List.of("oak_planks","birch_planks")));
    private static final Formula PICK=new Formula("pick","wooden_pickaxe",1,3,List.of(List.of("oak_planks","birch_planks"),List.of("oak_planks","birch_planks"),List.of("oak_planks","birch_planks"),List.of("stick"),List.of("stick")));
    @Test void logsBecomePlanksThenSticksThenToolWithoutInventingMaterials() {
        var stock=Map.of("oak_log",2);
        var plan=CraftDependencies.plan("wooden_pickaxe",1,stock,List.of(PLANKS,STICKS,PICK));
        assertTrue(plan.missing().isEmpty(),plan.toString());
        var jobs=plan.jobs().stream().map(CraftDependencies.Job::recipe).toList();
        assertTrue(jobs.indexOf("planks")<jobs.indexOf("sticks")); assertEquals("pick",jobs.getLast());
        assertEquals(Map.of("oak_log",2),stock);
    }
    @Test void missingRawResourcesAreExplicitAndAlreadyOwnedGoalsNeedNoActions() {
        var plan=CraftDependencies.plan("wooden_pickaxe",1,Map.of(),List.of(PLANKS,STICKS,PICK));
        assertFalse(plan.missing().isEmpty());
        assertTrue(CraftDependencies.plan("wooden_pickaxe",1,Map.of("wooden_pickaxe",1),List.of(PICK)).jobs().isEmpty());
    }
    @Test void ingredientAlternativesPreferTheWoodActuallyCarried() {
        var acacia=new Formula("acacia_planks","acacia_planks",4,2,List.of(List.of("acacia_log")));
        var table=new Formula("table","crafting_table",1,2,Collections.nCopies(4,List.of("acacia_planks","oak_planks")));
        var plan=CraftDependencies.plan("crafting_table",1,Map.of("oak_log",1),List.of(acacia,PLANKS,table));
        assertTrue(plan.missing().isEmpty(),plan.toString()); assertEquals("planks",plan.jobs().getFirst().recipe());
    }
    @Test void mixedPlanksAreAllocatedWithoutRequiringAnotherTree() {
        var table=new Formula("table","crafting_table",1,2,Collections.nCopies(4,List.of("oak_planks","birch_planks")));
        var plan=CraftDependencies.plan("crafting_table",1,Map.of("oak_planks",2,"birch_planks",2),List.of(table));
        assertTrue(plan.missing().isEmpty(),plan.toString());
    }
    @Test void cyclicConversionRecipesTerminateAndReportAnActualMissingInput() {
        var a=new Formula("a","a",1,2,List.of(List.of("b")));
        var b=new Formula("b","b",1,2,List.of(List.of("a")));
        var plan=CraftDependencies.plan("a",1,Map.of(),List.of(a,b)); assertFalse(plan.missing().isEmpty());
    }
}
