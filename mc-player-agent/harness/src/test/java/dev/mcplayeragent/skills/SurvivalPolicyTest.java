/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static dev.mcplayeragent.skills.SurvivalPolicy.Need.*;

class SurvivalPolicyTest {
    @Test void immediateDeathRiskPreemptsFoodAndThreats() {
        var s=new SurvivalPolicy.State(false,false,false,true,30,false,true,true,2,true,4,2,true);
        assertEquals(DROWNING,SurvivalPolicy.choose(s).need());
        assertEquals(SUFFOCATING,SurvivalPolicy.choose(new SurvivalPolicy.State(false,true,true,true,30,true,true,true,1,true,1,0,true)).need());
    }
    @Test void creepersProjectilesAndHostilesTakePrecedenceOverStuckAndFood() {
        assertEquals(CREEPER,SurvivalPolicy.choose(new SurvivalPolicy.State(false,false,false,false,300,false,true,true,2,true,4,2,true)).need());
        assertEquals(PROJECTILE,SurvivalPolicy.choose(new SurvivalPolicy.State(false,false,false,false,300,false,false,true,2,true,4,2,true)).need());
        assertEquals(HOSTILE,SurvivalPolicy.choose(new SurvivalPolicy.State(false,false,false,false,300,false,false,false,8,true,4,2,true)).need());
    }
    @Test void ordinarySwimmingAndHealthyFoodLevelsDoNotConstantlyInterruptWork() {
        assertEquals(NONE,SurvivalPolicy.choose(new SurvivalPolicy.State(false,false,false,true,300,false,false,false,30,false,20,18,true)).need());
        assertEquals(FOOD,SurvivalPolicy.choose(new SurvivalPolicy.State(false,false,false,false,300,false,false,false,30,false,8,10,true)).need());
        assertEquals(NONE,SurvivalPolicy.choose(new SurvivalPolicy.State(false,false,false,false,300,false,false,false,30,false,8,10,false)).need());
    }
    @Test void retreatMustGainDistanceAndCoverIsValuable() {
        assertEquals(-Double.MAX_VALUE,SurvivalPolicy.retreatScore(5,4,true,1));
        assertTrue(SurvivalPolicy.retreatScore(5,12,true,8)>SurvivalPolicy.retreatScore(5,14,false,8));
    }
}
