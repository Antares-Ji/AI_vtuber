/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import java.util.*;

/** Repeated failures are quarantined for the same action and unchanged evidence, not for the session. */
public final class PlayerProgress {
    public enum Outcome { SUCCEEDED, ALREADY_SATISFIED, FAILED, TIMED_OUT, NO_PROGRESS, SENT_UNCONFIRMED, CONTINUING }
    private final Map<String, Integer> failures = new LinkedHashMap<>();
    private long requests, steps, succeeded, failed, requestMillis, idleTicks, activeTicks, skipped;
    private final ArrayDeque<String> recentFailures = new ArrayDeque<>();

    public boolean blocked(String action, String state) { return failures.getOrDefault(action + "|" + state, 0) >= 2; }
    public void record(String action, String state, Outcome outcome, String reason) {
        steps++;
        if (outcome == Outcome.ALREADY_SATISFIED) skipped++;
        if (outcome == Outcome.SUCCEEDED || outcome == Outcome.ALREADY_SATISFIED) succeeded++;
        if (outcome == Outcome.FAILED || outcome == Outcome.TIMED_OUT || outcome == Outcome.NO_PROGRESS) {
            failed++; String key = action + "|" + state; failures.merge(key, 1, Integer::sum);
            while (failures.size() > 64) failures.remove(failures.keySet().iterator().next());
            recentFailures.addLast(outcome + ": " + PlayerPlan.displayText(reason) + "; action=" + PlayerPlan.displayText(action));
            while (recentFailures.size() > 8) recentFailures.removeFirst();
        }
    }
    public void request(long millis) { requests++; requestMillis += millis; }
    public void tick(boolean working) { if (working) activeTicks++; else idleTicks++; }
    public long requests() { return requests; }
    public long steps() { return steps; }
    public long succeeded() { return succeeded; }
    public long failed() { return failed; }
    public long skipped() { return skipped; }
    public long requestMillis() { return requestMillis; }
    public long idleTicks() { return idleTicks; }
    public long activeTicks() { return activeTicks; }
    public List<String> recentFailures() { return List.copyOf(recentFailures); }
}
