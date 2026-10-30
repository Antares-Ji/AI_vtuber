/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.harness;

/** Trusted Java extension discovered on the host classpath with ServiceLoader, before registry sealing. */
public interface SkillProvider {
    void register(SkillRegistry registry);
}
