/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.minecraft;
import java.nio.file.*;
/** Copy on first use; original settings remain intact. */
public final class LegacyMigration {
    public static void run() {
        try {
            for(String name:new String[]{"player-control.json","keys/player-deepseek.key"}) {
                Path source=AgentPaths.legacyClientDir().resolve(name),target=AgentPaths.clientDir().resolve(name);
                if(!Files.exists(target)&&Files.isRegularFile(source)) {
                    Files.createDirectories(target.getParent()); Files.copy(source,target);
                }
            }
        } catch(java.io.IOException e) { org.slf4j.LoggerFactory.getLogger("mcplayeragent").warn("Legacy configuration migration failed",e); }
    }
}
