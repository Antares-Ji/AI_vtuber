/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

/** Priority is independent of model latency. Neutral mobs are filtered by perception before this policy. */
public final class SurvivalPolicy {
    private SurvivalPolicy() {}
    public enum Need { DEAD, SUFFOCATING, LAVA, DROWNING, FIRE, CREEPER, PROJECTILE, HOSTILE, STUCK, FOOD, NONE }
    public record State(boolean dead,boolean wall,boolean lava,boolean water,int air,boolean fire,boolean creeper,
                        boolean projectile,double hostileDistance,boolean stuck,float health,int food,boolean edible) {}
    public record Choice(Need need,int priority) {}
    public static Choice choose(State s) {
        if(s.dead()) return new Choice(Need.DEAD,1000);
        if(s.wall()) return new Choice(Need.SUFFOCATING,100);
        if(s.water()&&s.air()<60) return new Choice(Need.DROWNING,98);
        if(s.lava()) return new Choice(Need.LAVA,96);
        if(s.creeper()) return new Choice(Need.CREEPER,94);
        if(s.water()&&s.air()<180) return new Choice(Need.DROWNING,90);
        if(s.fire()) return new Choice(Need.FIRE,86);
        if(s.projectile()) return new Choice(Need.PROJECTILE,85);
        if(s.hostileDistance()<12) return new Choice(Need.HOSTILE,70);
        if(s.stuck()) return new Choice(Need.STUCK,40);
        if(s.edible()&&(s.food()<=6||s.health()<12&&s.food()<18)) return new Choice(Need.FOOD,30);
        return new Choice(Need.NONE,0);
    }
    public static double retreatScore(double before,double after,boolean cover,int steps) {
        if(after<before+1) return -Double.MAX_VALUE;
        return after*2+(cover?20:0)-steps*.35;
    }
}
