/* SPDX-License-Identifier: LGPL-3.0-only */
package dev.mcplayeragent.minecraft;
import java.util.concurrent.CopyOnWriteArrayList;
public final class AgentLifecycle {
    private static final CopyOnWriteArrayList<Runnable> hooks=new CopyOnWriteArrayList<>();
    private AgentLifecycle() {}
    public static void onStopped(Runnable hook) { hooks.add(hook); }
    public static void fireStopped() { hooks.forEach(Runnable::run); }
}
