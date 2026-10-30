/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.harness;

import com.google.gson.*;
import java.io.IOException;
import java.nio.file.*;
import java.util.*;

/** Immutable, credential-free session configuration. Missing files use defaults; invalid files fail closed. */
public record AgentProfile(PlayerModelConnection connection, String prompt, boolean chatSummary,
                           AgentHarness.Limits limits, List<String> enabledSkills) {
    public AgentProfile {
        Objects.requireNonNull(connection); Objects.requireNonNull(prompt); Objects.requireNonNull(limits);
        enabledSkills = List.copyOf(enabledSkills);
        if (!enabledSkills.equals(List.of("*"))) enabledSkills.forEach(SkillRegistry::requireId);
        if (new HashSet<>(enabledSkills).size() != enabledSkills.size()) throw new IllegalArgumentException("Duplicate enabled_skills");
    }
    public static AgentProfile defaults() {
        return new AgentProfile(new PlayerModelConnection(PlayerModelConnection.Backend.DEEPSEEK,
                "https://api.deepseek.com", "deepseek-flash"), "", true, AgentHarness.DEFAULT_LIMITS, List.of("*"));
    }
    public static AgentProfile load(Path path) throws IOException {
        try { return parse(JsonParser.parseString(Files.readString(path)).getAsJsonObject()); }
        catch (NoSuchFileException missing) { return defaults(); }
    }
    public void save(Path path) throws IOException {
        Path target = path.toAbsolutePath(); Files.createDirectories(target.getParent());
        Path temporary = Files.createTempFile(target.getParent(), "agent-profile-", ".tmp");
        try {
            Files.writeString(temporary, new GsonBuilder().setPrettyPrinting().create().toJson(toJson()) + "\n");
            try { Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
            catch (AtomicMoveNotSupportedException unsupported) { Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING); }
        } finally { Files.deleteIfExists(temporary); }
    }
    /** Identify the resolved profile in logs without copying prompts or endpoint details into the run. */
    public String fingerprint() {
        try {
            return HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256")
                    .digest(toJson().toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    public static AgentProfile parse(JsonObject value) {
        fields(value, Set.of("schema_version", "backend", "endpoint", "model", "prompt", "chat_summary", "limits", "enabled_skills"));
        if (integer(value, "schema_version", 1, 1) != 1) throw new IllegalArgumentException("Unsupported profile schema_version");
        AgentProfile defaults = defaults();
        String endpoint = string(value, "endpoint", defaults.connection().endpoint());
        String backend = string(value, "backend", endpoint.startsWith("https://api.deepseek.com") ? "DEEPSEEK" : "OLLAMA");
        var connection = new PlayerModelConnection(PlayerModelConnection.Backend.valueOf(backend), endpoint,
                string(value, "model", defaults.connection().model()));
        boolean chat = defaults.chatSummary();
        if (value.has("chat_summary")) {
            if (!value.get("chat_summary").isJsonPrimitive() || !value.getAsJsonPrimitive("chat_summary").isBoolean())
                throw new IllegalArgumentException("chat_summary must be boolean");
            chat = value.get("chat_summary").getAsBoolean();
        }
        var limits = defaults.limits();
        if (value.has("limits")) {
            JsonObject raw = value.getAsJsonObject("limits");
            fields(raw, Set.of("max_runtime_ms", "max_model_requests", "max_actions"));
            limits = new AgentHarness.Limits(integer(raw, "max_runtime_ms", limits.maxRuntimeMillis(), Long.MAX_VALUE),
                    (int) integer(raw, "max_model_requests", limits.maxModelRequests(), Integer.MAX_VALUE),
                    (int) integer(raw, "max_actions", limits.maxActions(), Integer.MAX_VALUE));
        }
        List<String> skills = defaults.enabledSkills();
        if (value.has("enabled_skills")) {
            skills = new ArrayList<>();
            for (JsonElement item : value.getAsJsonArray("enabled_skills")) {
                if (!item.isJsonPrimitive() || !item.getAsJsonPrimitive().isString())
                    throw new IllegalArgumentException("enabled_skills must contain strings");
                skills.add(item.getAsString());
            }
        }
        return new AgentProfile(connection, string(value, "prompt", ""), chat, limits, skills);
    }
    /** Explicit session overrides; nested limit fields merge, arrays replace, and the result is validated. */
    public AgentProfile withOverrides(JsonObject overrides) {
        JsonObject merged = toJson();
        overrides.entrySet().forEach(entry -> {
            if (entry.getKey().equals("limits") && entry.getValue().isJsonObject())
                entry.getValue().getAsJsonObject().entrySet().forEach(limit -> merged.getAsJsonObject("limits").add(limit.getKey(), limit.getValue().deepCopy()));
            else merged.add(entry.getKey(), entry.getValue().deepCopy());
        });
        return parse(merged);
    }
    public JsonObject toJson() {
        JsonObject result = new JsonObject(); result.addProperty("schema_version", 1);
        result.addProperty("backend", connection.backend().name()); result.addProperty("endpoint", connection.endpoint());
        result.addProperty("model", connection.model()); result.addProperty("prompt", prompt); result.addProperty("chat_summary", chatSummary);
        JsonObject budget = new JsonObject(); budget.addProperty("max_runtime_ms", limits.maxRuntimeMillis());
        budget.addProperty("max_model_requests", limits.maxModelRequests()); budget.addProperty("max_actions", limits.maxActions());
        result.add("limits", budget);
        JsonArray skills = new JsonArray(); enabledSkills.forEach(skills::add); result.add("enabled_skills", skills);
        return result;
    }
    private static void fields(JsonObject value, Set<String> allowed) {
        if (value == null) throw new IllegalArgumentException("Expected configuration object");
        for (String key : value.keySet()) if (!allowed.contains(key)) throw new IllegalArgumentException("Unknown profile field: " + key);
    }
    private static String string(JsonObject value, String key, String fallback) {
        if (!value.has(key)) return fallback;
        if (!value.get(key).isJsonPrimitive() || !value.getAsJsonPrimitive(key).isString())
            throw new IllegalArgumentException(key + " must be string");
        return value.get(key).getAsString();
    }
    private static long integer(JsonObject value, String key, long fallback, long maximum) {
        if (!value.has(key)) return fallback;
        if (!value.get(key).isJsonPrimitive() || !value.getAsJsonPrimitive(key).isNumber())
            throw new IllegalArgumentException(key + " must be integer");
        long result;
        try { result = value.get(key).getAsBigDecimal().longValueExact(); }
        catch (ArithmeticException error) { throw new IllegalArgumentException(key + " must be int64", error); }
        if (result <= 0 || result > maximum) throw new IllegalArgumentException(key + " out of range");
        return result;
    }
}
