/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import com.google.gson.JsonObject;
import java.nio.file.*;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import static org.junit.jupiter.api.Assertions.*;

class WorldJournalTest {
    @TempDir Path temp;
    private final UUID player=UUID.fromString("11111111-1111-1111-1111-111111111111");
    @Test void sameNamedWorldsHaveIndependentIdentityGoalsAndLandmarks() {
        var a=WorldJournal.bind(temp.resolve("save-a"),player,"minecraft:overworld","New World");
        var b=WorldJournal.bind(temp.resolve("save-b"),player,"minecraft:overworld","New World");
        JsonObject memory=new JsonObject(); memory.addProperty("shelter","1 64 2"); WorldJournal.write(a.file(),memory);
        memory.addProperty("goal","build home"); WorldJournal.write(a.agenda(),memory);
        assertNotEquals(a.worldId(),b.worldId()); assertNotEquals(a.key(),b.key());
        assertTrue(WorldJournal.read(b.file()).isEmpty()); assertTrue(WorldJournal.read(b.agenda()).isEmpty());
        assertEquals("1 64 2",WorldJournal.read(a.file()).get("shelter").getAsString());
    }
    @Test void reopenKeepsIdentityAndDimensionsShareGoalButNeverCoordinates() {
        var a=WorldJournal.bind(temp.resolve("save"),player,"minecraft:overworld","A");
        var again=WorldJournal.bind(temp.resolve("save"),player,"minecraft:overworld","Renamed");
        var nether=WorldJournal.bind(temp.resolve("save"),player,"minecraft:the_nether","A");
        assertEquals(a,again); assertEquals(a.worldId(),nether.worldId()); assertEquals(a.agenda(),nether.agenda());
        assertNotEquals(a.file(),nether.file()); assertNotEquals(a.key(),nether.key());
    }
    @Test void playersAndDimensionNamespacesCannotAlias() {
        var a=WorldJournal.bind(temp.resolve("save"),player,"a:b_c","A");
        var b=WorldJournal.bind(temp.resolve("save"),player,"a_b:c","A");
        var other=WorldJournal.bind(temp.resolve("save"),UUID.randomUUID(),"a:b_c","A");
        assertNotEquals(a.file(),b.file()); assertNotEquals(a.agenda(),other.agenda());
    }
    @Test void legacyDataIsCopiedWithoutDeletingTheOriginal() throws Exception {
        Path legacy=temp.resolve("save/mcplayeragent/memory").resolve(player+"-minecraft_overworld.json");
        JsonObject old=new JsonObject(); old.addProperty("goal","keep this"); WorldJournal.write(legacy,old);
        var binding=WorldJournal.bind(temp.resolve("save"),player,"minecraft:overworld","A");
        assertEquals(old,WorldJournal.read(binding.file())); assertEquals(old,WorldJournal.read(legacy));
    }
    @Test void copiedSaveDoesNotReuseTheOtherFoldersRuntimeContext() throws Exception {
        var a=WorldJournal.bind(temp.resolve("a"),player,"minecraft:overworld","A");
        Path copied=temp.resolve("b/mcplayeragent/memory/world.json"); Files.createDirectories(copied.getParent());
        Files.copy(temp.resolve("a/mcplayeragent/memory/world.json"),copied);
        var b=WorldJournal.bind(temp.resolve("b"),player,"minecraft:overworld","A");
        assertEquals(a.worldId(),b.worldId()); assertNotEquals(a.key(),b.key());
    }
    @Test void numenWorldIdentityAgendaAndDimensionsMigrateWithoutOverwritingNewMemory() {
        Path save=temp.resolve("migration"),old=save.resolve("numen/player-control");
        String id=UUID.randomUUID().toString();
        JsonObject identity=new JsonObject(); identity.addProperty("id",id); identity.addProperty("name","Old world");
        WorldJournal.write(old.resolve("world.json"),identity);
        String dimension="minecraft:overworld";
        String encoded=java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(dimension.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        JsonObject memory=new JsonObject(); memory.addProperty("shelter","10 64 20");
        WorldJournal.write(old.resolve(player+"-"+encoded+".json"),memory);
        JsonObject agenda=new JsonObject(); agenda.addProperty("goal","finish mining");
        WorldJournal.write(old.resolve("players/"+player+"/agenda.json"),agenda);
        var binding=WorldJournal.bind(save,player,dimension,"New world");
        assertEquals(id,binding.worldId()); assertEquals(memory,WorldJournal.read(binding.file()));
        assertEquals(agenda,WorldJournal.read(binding.agenda()));
        JsonObject updated=new JsonObject(); updated.addProperty("shelter","30 70 40"); WorldJournal.write(binding.file(),updated);
        WorldJournal.bind(save,player,dimension,"New world");
        assertEquals(updated,WorldJournal.read(binding.file()));
        assertEquals(memory,WorldJournal.read(old.resolve(player+"-"+encoded+".json")));
        var other=WorldJournal.bind(save,UUID.randomUUID(),dimension,"New world");
        assertTrue(WorldJournal.read(other.file()).isEmpty()); assertTrue(WorldJournal.read(other.agenda()).isEmpty());
    }
}
