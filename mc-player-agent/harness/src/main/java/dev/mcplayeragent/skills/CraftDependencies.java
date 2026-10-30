/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import java.util.*;

/** Recipe dependency planning consumes a virtual inventory; it never edits the player's items. */
public final class CraftDependencies {
    private CraftDependencies() {}
    public record Formula(String id,String item,int output,int grid,List<List<String>> ingredients) {}
    public record Job(String recipe,String item,int batches,int grid) {}
    public record Plan(List<Job> jobs,Map<String,Integer> missing) {}
    private static final class State {
        final Map<String,Integer> stock=new HashMap<>(), missing=new TreeMap<>(); final List<Job> jobs=new ArrayList<>();
        State copy() { State s=new State(); s.stock.putAll(stock); s.missing.putAll(missing); s.jobs.addAll(jobs); return s; }
        int score() { return missing.values().stream().mapToInt(Integer::intValue).sum()*1000+jobs.size(); }
    }
    public static Plan plan(String item,int count,Map<String,Integer> inventory,List<Formula> recipes) {
        if(count<1||count>4096) throw new IllegalArgumentException("count must be 1..4096");
        Map<String,List<Formula>> byOutput=new HashMap<>();
        for(Formula f:recipes) if(f.output()>0&&!f.ingredients().isEmpty()) byOutput.computeIfAbsent(f.item(),k->new ArrayList<>()).add(f);
        State state=new State(); state.stock.putAll(inventory);
        state=ensure(item,count,state,byOutput,new HashSet<>(),new int[]{2000});
        return new Plan(List.copyOf(state.jobs),Map.copyOf(state.missing));
    }
    private static State ensure(String item,int wanted,State current,Map<String,List<Formula>> recipes,Set<String> path,int[] budget) {
        int deficit=wanted-current.stock.getOrDefault(item,0); if(deficit<=0) return current;
        if(path.contains(item)||path.size()>=12||--budget[0]<=0) return missing(item,deficit,current);
        Set<String> nested=new HashSet<>(path); nested.add(item); State best=null;
        for(Formula recipe:recipes.getOrDefault(item,List.of())) {
            State trial=current.copy(); int batches=(deficit+recipe.output()-1)/recipe.output();
            State selection=trial;
            Map<String,Integer> needed=new LinkedHashMap<>();
            for(List<String> choices:recipe.ingredients()) {
                if(choices.isEmpty()) continue;
                Map<String,Integer> estimates=new HashMap<>();
                for(String id:choices) estimates.put(id,estimate(id,batches+needed.getOrDefault(id,0),selection.stock,recipes,nested,0));
                String chosen=choices.stream().min(Comparator.<String>comparingInt(estimates::get).thenComparing(id->id)).orElseThrow();
                needed.merge(chosen,batches,Integer::sum);
            }
            for(var entry:needed.entrySet()) {
                trial=ensure(entry.getKey(),entry.getValue(),trial,recipes,nested,budget);
                trial.stock.merge(entry.getKey(),-entry.getValue(),Integer::sum);
            }
            trial.stock.merge(item,batches*recipe.output(),Integer::sum);
            trial.jobs.add(new Job(recipe.id(),item,batches,recipe.grid()));
            if(best==null||trial.score()<best.score()) best=trial;
            if(budget[0]<=0) break;
        }
        return best==null?missing(item,deficit,current):best;
    }
    private static State missing(String item,int count,State state) {
        state.missing.merge(item,count,Integer::sum); state.stock.merge(item,count,Integer::sum); return state;
    }
    private static int estimate(String item,int count,Map<String,Integer> stock,Map<String,List<Formula>> recipes,Set<String> path,int depth) {
        int deficit=count-stock.getOrDefault(item,0); if(deficit<=0) return 0;
        if(depth>=6||path.contains(item)) return deficit*1000;
        Set<String> nested=new HashSet<>(path); nested.add(item); int best=deficit*1000;
        for(Formula formula:recipes.getOrDefault(item,List.of())) {
            int batches=(deficit+formula.output()-1)/formula.output(), cost=1;
            for(List<String> choices:formula.ingredients()) {
                int cheapest=Integer.MAX_VALUE;
                for(String choice:choices) cheapest=Math.min(cheapest,estimate(choice,batches,stock,recipes,nested,depth+1));
                if(cheapest!=Integer.MAX_VALUE) cost=Math.min(1000000,cost+cheapest);
            }
            best=Math.min(best,cost);
        }
        return best;
    }
}
