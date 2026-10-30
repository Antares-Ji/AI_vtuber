/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import java.util.*;

/** Names describe observable blocks and actual drops; no seed lookup or hidden-ore coordinates. */
public final class MiningTargets {
    private MiningTargets() {}
    public static String normalize(String query) {
        String value=query.strip().toLowerCase(Locale.ROOT); return value.startsWith("minecraft:")?value.substring(10):value;
    }
    public static boolean ore(String id) { String name=normalize(id); return name.endsWith("_ore")||name.equals("ancient_debris"); }
    public static boolean matches(String query,String block) {
        String q=normalize(query), b=normalize(block);
        if(q.equals("all_ores")) return ore(block);
        if(q.equals("cobblestone")) return Set.of("stone","cobblestone").contains(b);
        if(q.equals("cobbled_deepslate")) return Set.of("deepslate","cobbled_deepslate").contains(b);
        if(Set.of("coal","iron","copper","gold","redstone","lapis","emerald","diamond","quartz").contains(q))
            return b.equals(q+"_ore")||b.equals("deepslate_"+q+"_ore")||q.equals("quartz")&&b.equals("nether_quartz_ore")||q.equals("gold")&&b.equals("nether_gold_ore");
        return q.equals(b);
    }
    public static boolean dropMatches(String query,String item) {
        String q=normalize(query), i=normalize(item);
        if(q.equals("all_ores")) return ore(item)||Set.of("coal","raw_iron","raw_copper","raw_gold","gold_nugget","redstone","lapis_lazuli","emerald","diamond","quartz").contains(i);
        if(matches(query,item)) return true;
        String family=q.replace("deepslate_","").replace("nether_","").replace("_ore","");
        return switch(family) {
            case "iron","copper","gold" -> i.equals("raw_"+family)||i.equals(family+"_ingot")||family.equals("gold")&&i.equals("gold_nugget");
            case "lapis" -> i.equals("lapis_lazuli");
            case "stone" -> i.equals("cobblestone");
            case "deepslate" -> i.equals("cobbled_deepslate");
            default -> i.equals(family);
        };
    }
    public static boolean rawGoal(String query) { return Set.of("coal","iron","copper","gold","redstone","lapis","diamond","emerald","quartz","cobblestone","cobbled_deepslate").contains(normalize(query)); }
    public static int goalUnits(String query,Map<String,Integer> items) {
        String q=normalize(query); Map<String,Integer> amounts=new HashMap<>(); items.forEach((k,v)->amounts.merge(normalize(k),v,Integer::sum));
        return switch(q) {
            case "gold" -> amounts.getOrDefault("raw_gold",0)+amounts.getOrDefault("gold_ingot",0)+amounts.getOrDefault("gold_nugget",0)/9;
            case "iron","copper" -> amounts.getOrDefault("raw_"+q,0)+amounts.getOrDefault(q+"_ingot",0);
            case "lapis" -> amounts.getOrDefault("lapis_lazuli",0);
            case "coal","redstone","diamond","emerald","quartz","cobblestone","cobbled_deepslate" -> amounts.getOrDefault(q,0);
            default -> items.entrySet().stream().filter(e->dropMatches(query,e.getKey())).mapToInt(Map.Entry::getValue).sum();
        };
    }
}
