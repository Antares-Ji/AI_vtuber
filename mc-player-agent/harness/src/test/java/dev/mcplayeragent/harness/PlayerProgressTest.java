/* SPDX-License-Identifier: LGPL-3.0-only
 * Extracted from local player-agent extensions in the modified Numen workspace.
 * This file is absent from the original downloaded Numen snapshot.
 * Origin and modification history: NOTICE and provenance.json.
 */
package dev.mcplayeragent.harness;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;
import static dev.mcplayeragent.harness.PlayerProgress.Outcome.*;

class PlayerProgressTest {
    @Test void stopsIdenticalFailedRetriesButAllowsChangedStateOrDifferentApproach() {
        var p = new PlayerProgress(); p.record("walk", "wall", NO_PROGRESS, "blocked");
        assertFalse(p.blocked("walk", "wall"));
        p.record("walk", "wall", NO_PROGRESS, "blocked"); assertTrue(p.blocked("walk", "wall"));
        assertFalse(p.blocked("walk", "door-open")); assertFalse(p.blocked("jump", "wall"));
    }
    @Test void sentPacketsAndContinuationsAreNotCountedAsVerifiedSuccess() {
        var p = new PlayerProgress(); p.record("cmd", "s", SENT_UNCONFIRMED, "sent");
        p.record("mine", "s", CONTINUING, "holding"); assertEquals(0, p.succeeded());
        p.record("place", "s", SUCCEEDED, "server block matched"); assertEquals(1, p.succeeded());
        p.record("look", "s", ALREADY_SATISFIED, "skipped"); assertEquals(1, p.skipped());
    }
    @Test void tracksLatencyAndIdleTimeWithoutImposingASessionStepLimit() {
        var p = new PlayerProgress();
        for (int i = 0; i < 500; i++) p.record("move", "s" + i, SUCCEEDED, "observed");
        p.request(800); p.tick(false); p.tick(true);
        assertEquals(500, p.steps()); assertEquals(800, p.requestMillis()); assertEquals(1, p.idleTicks());
    }
}
