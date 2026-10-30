/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.harness;

import com.google.gson.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.*;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

class AgentProfileTest {
    @TempDir Path temp;
    private static JsonObject json(String value) { return JsonParser.parseString(value).getAsJsonObject(); }
    @Test void defaultsAndLegacySettingsRetainBehavior() throws Exception {
        assertEquals(AgentHarness.DEFAULT_LIMITS, AgentProfile.load(temp.resolve("missing.json")).limits());
        var old = AgentProfile.parse(json("""
                {"endpoint":"http://localhost:11434/v1","model":"local","prompt":"be careful","chat_summary":false}
                """));
        assertEquals(PlayerModelConnection.Backend.OLLAMA, old.connection().backend());
        assertEquals(List.of("*"), old.enabledSkills()); assertFalse(old.chatSummary());
        assertEquals(old, AgentProfile.parse(old.toJson()));
    }
    @Test void overridesMergeLimitsAndReplaceSelectionWithoutMutatingTheProfile() {
        var original = AgentProfile.defaults().withOverrides(json("{\"limits\":{\"max_actions\":4}}"));
        var changed = original.withOverrides(json("{\"limits\":{\"max_model_requests\":2},\"enabled_skills\":[]}"));
        assertEquals(4, changed.limits().maxActions()); assertEquals(2, changed.limits().maxModelRequests());
        assertEquals(120, original.limits().maxModelRequests()); assertEquals(List.of(), changed.enabledSkills());
        assertThrows(UnsupportedOperationException.class, () -> changed.enabledSkills().add("a:b"));
    }
    @Test void invalidConfigurationNeverFallsBackOrCoercesTypes() throws Exception {
        for (String value : List.of("{\"api_key\":\"private\"}", "{\"schema_version\":2}", "{\"prompt\":3}",
                "{\"chat_summary\":\"true\"}", "{\"limits\":{\"max_actions\":0}}", "{\"limits\":{\"max_actions\":1.2}}",
                "{\"limits\":{\"max_runtime_ms\":9223372036854775808}}", "{\"limits\":{\"max_action\":2}}",
                "{\"enabled_skills\":[\"*\",\"a:b\"]}", "{\"enabled_skills\":[\"a:b\",\"a:b\"]}",
                "{\"enabled_skills\":[1]}", "{\"enabled_skills\":[\"old_name\"]}"))
            assertThrows(IllegalArgumentException.class, () -> AgentProfile.parse(json(value)), value);
        Path file = temp.resolve("bad.json"); Files.writeString(file, "{broken");
        assertThrows(JsonParseException.class, () -> AgentProfile.load(file));
        assertThrows(java.io.IOException.class, () -> AgentProfile.load(temp));
    }
    @Test void credentialsAndUnsafeEndpointsAreRejectedDuringOverridesToo() {
        assertThrows(IllegalArgumentException.class, () -> AgentProfile.defaults().withOverrides(json("{\"api_key\":\"private\"}")));
        assertThrows(IllegalArgumentException.class, () -> AgentProfile.defaults().withOverrides(json("{\"endpoint\":\"https://example.org\"}")));
        assertThrows(IllegalArgumentException.class, () -> AgentProfile.defaults().withOverrides(json("{\"limits\":{\"typo\":1}}")));
    }
    @Test void fileRoundTripPreservesAdvancedFieldsAndFingerprintTracksResolvedValues() throws Exception {
        Path file = temp.resolve("nested/profile.json");
        var profile = AgentProfile.defaults().withOverrides(json("{\"limits\":{\"max_actions\":4},\"enabled_skills\":[\"example:collect_return\"]}"));
        profile.save(file);
        var edited = AgentProfile.load(file).withOverrides(json("{\"prompt\":\"stay near home\"}")); edited.save(file);
        assertEquals(4, AgentProfile.load(file).limits().maxActions());
        assertEquals(profile.enabledSkills(), AgentProfile.load(file).enabledSkills());
        assertEquals(edited.fingerprint(), AgentProfile.load(file).fingerprint()); assertNotEquals(profile.fingerprint(), edited.fingerprint());
        assertEquals(64, edited.fingerprint().length());
    }
}
