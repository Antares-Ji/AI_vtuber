# Optional local director task API

This integration extension preserves the original AgentHarness planning loop,
native actions, server receipts and goal acceptance. It submits goals, not input
coordinates or action scripts. The standalone F8/F9 workflow remains available.
The API is disabled unless explicitly enabled for this Minecraft installation.

## Configuration

With Minecraft stopped, create `config/mcplayeragent/client/director.json` in its
game directory:

```json
{"enabled":true,"port":17650}
```

On the next client start, the API binds only to `127.0.0.1`. It creates a random
256-bit `director-token.txt` beside that file. Keep this file local; do not put its
contents in browser code, URLs, logs, screenshots or the source repository. The
HTTP Authorization header is `Bearer ` followed by that file's text. Requests
with an Origin header are rejected; the director's local server is the client.

Configure DeepSeek using the existing profile/credential mechanism. This API
cannot change providers, submit model keys or bypass game permissions. Enter the
intended singleplayer save or a world hosted by this client. Remote multiplayer
clients are not supported. The game must be in the foreground with no GUI open
when a task starts. The adapter never chooses a save or creates a world.

## Protocol 1

- `GET /status`: instance UUID, manual-control revision, hashed actual save path,
  world name, readiness, host-tick freshness and current mission metadata. This
  does not expose the save path, API key, game observations or full mission log.
- `POST /requests`: JSON with `id` (canonical UUID), `instanceId`,
  `controlRevision`, `worldId`, `goal` (1–1000 characters), and `durationMs`
  (integer, 1000–1200000). Read the current instance, revision and world from
  status; explicitly select that world. Repeating an identical request ID returns
  the existing task; changing its parameters conflicts. HTTP only queues work.
- `GET /requests/{id}`: queued/running/stopping/terminal status and mission UUID.
- `POST /requests/{id}/stop`: JSON containing `instanceId`. Cancellation of an
  unknown ID creates a tombstone, so a late start cannot resurrect it. Stopping
  never targets another mission. `releaseComplete:true` is the release receipt.

Only client ticks access PlayerControl. A queued request expires after ten
seconds or its shorter total budget. Runtime includes queue time; expiry,
cancellation and native interruptions do not mean success. A stop retains
ownership until the host confirms input release. Native VERIFIED/UNVERIFIED
results come only from the matching mission's existing MissionRun acceptance.
The outer integration adapter reports the native result but does not add an
independent gameplay verification claim.

F8/F9 cancel queued requests and advance the manual-control revision. Delayed
requests created before that change cannot undo the manual stop. The ledger is
bounded to 128 IDs per client process and does not evict tombstones; restart the
client when full. The outer Skill Host holds its desktop lease during ambiguous
start/stop failures. A missing response or different server instance is not a
release acknowledgement. Cross-process lease recovery is not implemented.

## Validation boundary

The headless HTTP tests use a fake host and monotonic clock. They exercise
ownership, cancellation races, expiry, malformed bodies and authentication.
Loader compilation verifies integration types. Neither proves real client
control, model performance, endurance or a completed Minecraft goal; those need
a separately recorded run in the user's selected save.
