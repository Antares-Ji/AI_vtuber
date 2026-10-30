/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.minecraft;
import java.nio.file.*;
public final class AgentCredentials {
    private AgentCredentials() {}
    private static Path path(String service) {
        if(!service.matches("[a-zA-Z0-9_-]+")) throw new IllegalArgumentException("Invalid key name");
        return AgentPaths.clientDir().resolve("keys").resolve(service+".key");
    }
    public static String get(String service) {
        try { Path p=path(service); return Files.exists(p)?Files.readString(p).strip():""; }
        catch(java.io.IOException e) { throw new IllegalStateException("Cannot read model key",e); }
    }
    public static void put(String service,String key) {
        try { Path p=path(service); Files.createDirectories(p.getParent()); Files.writeString(p,key.strip()); }
        catch(java.io.IOException e) { throw new IllegalStateException("Cannot save model key",e); }
    }
}
