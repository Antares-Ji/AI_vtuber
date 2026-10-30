/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.minecraft;
import java.nio.file.Path;
public final class AgentPaths {
    private static Path config=Path.of("config");
    private AgentPaths() {}
    public static void configure(Path path) { config=path; }
    public static Path root() { return config.resolve("mcplayeragent"); }
    public static Path clientDir() { return root().resolve("client"); }
    public static Path legacyClientDir() { return config.resolve("numen/client"); }
}
