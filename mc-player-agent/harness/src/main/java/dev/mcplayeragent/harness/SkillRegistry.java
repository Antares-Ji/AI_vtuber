/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.harness;

import com.google.gson.*;
import java.util.*;
import java.util.function.Function;

/** Host-thread registry. Configure once before execution; factories validate arguments before acting. */
public final class SkillRegistry {
    private record Entry(String version, String description, Function<JsonObject, PlayerTasks.Task> factory) {}
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private Set<String> enabled;

    public void register(String id, String version, String description, Function<JsonObject, PlayerTasks.Task> factory) {
        if (enabled != null) throw new IllegalStateException("Skill registry is already sealed");
        requireId(id);
        if (version == null || version.isBlank() || description == null || description.isBlank())
            throw new IllegalArgumentException("Skill version and description are required: " + id);
        if (entries.putIfAbsent(id, new Entry(version, description, Objects.requireNonNull(factory))) != null)
            throw new IllegalArgumentException("Duplicate skill: " + id);
    }
    public static void requireId(String id) {
        if (id == null || !id.matches("[a-z0-9_.-]+:[a-z0-9_./-]+"))
            throw new IllegalArgumentException("Expected namespaced skill id: " + id);
    }
    /** '*' enables all registered skills; an empty list disables model-selected skills. */
    public void seal(List<String> selection) {
        if (enabled != null) throw new IllegalStateException("Skill registry is already sealed");
        if (selection.equals(List.of("*"))) enabled = Set.copyOf(entries.keySet());
        else {
            for (String id : selection) {
                requireId(id);
                if (!entries.containsKey(id)) throw new IllegalArgumentException("Unknown enabled skill: " + id);
            }
            enabled = Set.copyOf(selection);
        }
    }
    public PlayerTasks.Task start(PlayerDecision request) {
        if (request.action() != PlayerDecision.Kind.SKILL) throw new IllegalArgumentException("Expected SKILL request");
        // Preserve the names used by existing plans and world journals.
        String id = request.text().contains(":") ? request.text() : "minecraft:" + request.text();
        return start(id, request.args());
    }
    public PlayerTasks.Task start(String id, JsonObject args) {
        if (enabled == null) throw new IllegalStateException("Seal the skill registry before execution");
        Entry entry = entries.get(id);
        if (entry == null) throw new IllegalArgumentException("Unknown skill: " + id);
        if (!enabled.contains(id)) throw new IllegalArgumentException("Disabled skill: " + id);
        return Objects.requireNonNull(entry.factory().apply(args.deepCopy()), "Skill factory returned null: " + id);
    }
    public JsonArray catalog() {
        if (enabled == null) throw new IllegalStateException("Seal the skill registry before discovery");
        JsonArray result = new JsonArray();
        entries.forEach((id, entry) -> {
            if (!enabled.contains(id)) return;
            JsonObject item = new JsonObject(); item.addProperty("id", id); item.addProperty("version", entry.version());
            item.addProperty("description", entry.description()); result.add(item);
        });
        return result;
    }
}
