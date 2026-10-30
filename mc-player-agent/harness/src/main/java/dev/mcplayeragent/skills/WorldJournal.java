/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.skills;

import com.google.gson.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Each save owns its journal; dimension encoding is reversible and cannot alias another namespace. */
public final class WorldJournal {
    private WorldJournal() {}
    public record Binding(Path file,Path agenda,String worldId,String key) {}
    public static Binding bind(Path save,UUID player,String dimension,String name) {
        try {
            Path root=save.toAbsolutePath().normalize().resolve("mcplayeragent/memory");
            migrate(save,root,player,dimension);
            Files.createDirectories(root); Path identity=root.resolve("world.json"); JsonObject world;
            if(Files.exists(identity)) world=read(identity);
            else { world=new JsonObject(); world.addProperty("id",UUID.randomUUID().toString()); world.addProperty("name",name); write(identity,world); }
            String id=world.get("id").getAsString(); UUID.fromString(id);
            String encoded=Base64.getUrlEncoder().withoutPadding().encodeToString(dimension.getBytes(StandardCharsets.UTF_8));
            Path file=root.resolve(player+"-"+encoded+".json");
            Path legacy=root.resolve(player+"-"+dimension.replace(':','_')+".json");
            if(!Files.exists(file)&&Files.exists(legacy)) write(file,read(legacy));
            String key=UUID.nameUUIDFromBytes((root+"|"+id+"|"+player+"|"+dimension).getBytes(StandardCharsets.UTF_8)).toString();
            return new Binding(file,root.resolve("players").resolve(player.toString()).resolve("agenda.json"),id,key);
        } catch(Exception e) { throw new IllegalStateException("Cannot bind save memory: "+save,e); }
    }
    private static void migrate(Path save,Path root,UUID player,String dimension) throws java.io.IOException {
        Path old=save.resolve("numen/player-control");
        String encoded=Base64.getUrlEncoder().withoutPadding().encodeToString(dimension.getBytes(StandardCharsets.UTF_8));
        for(String relative:List.of("world.json",player+"-"+encoded+".json",
                player+"-"+dimension.replace(':','_')+".json","players/"+player+"/agenda.json")) {
            Path source=old.resolve(relative),target=root.resolve(relative);
            if(!Files.exists(target)&&Files.isRegularFile(source)) {
                Files.createDirectories(target.getParent()); Files.copy(source,target);
            }
        }
    }
    public static JsonObject read(Path file) {
        try { return Files.exists(file)?JsonParser.parseString(Files.readString(file)).getAsJsonObject():new JsonObject(); }
        catch(Exception e) { throw new IllegalStateException("Cannot read world journal: "+file,e); }
    }
    public static void write(Path file,JsonObject value) {
        try { Files.createDirectories(file.getParent()); Path temp=file.resolveSibling(file.getFileName()+".tmp");
            Files.writeString(temp,value.toString()); Files.move(temp,file,StandardCopyOption.REPLACE_EXISTING,StandardCopyOption.ATOMIC_MOVE);
        } catch(Exception e) { throw new IllegalStateException("Cannot save world journal: "+file,e); }
    }
}
