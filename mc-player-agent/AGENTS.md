# MC Player Agent development

This is a standalone, task-oriented first-person player automation project.

- Preserve the task-first console, native actions, server receipts and explicit verified/unverified completion states.
- Keep fast local survival responses separate from slow model planning. A review must not replace a skill that still owns execution.
- Keep mission records and world memory isolated by the actual save. Never log API keys or private model reasoning.
- Do not introduce a Numen runtime/build dependency, companion subsystem, original artwork or original plugin framework.
- Preserve upstream notices for inherited implementations. Consult provenance.json before making origin claims; local extension files must not automatically be described as original upstream code.
- Keep new source independent of the old workspace. Old directory names may be read only by migration support.
- Common/server sources must not import Minecraft client classes. Loader entrypoints remain thin.
- Build with JDK 21: `gradlew.bat :harness:test :collect-return-example:test :fabric:build :neoforge:build --no-daemon`.
- For changes to native pickup hooks or loader setup, run the two `runGameTestServer` tasks sequentially and check the actual pass counts.
- New behavioral changes need focused tests where meaningful. Do not claim client endurance or UI validation from a successful compilation or server GameTest.
- Consult docs/PROJECT.md for scope and outstanding acceptance goals.
- Keep AgentHarness free of Minecraft imports and per-session state out of static fields. PlayerControl adapts native controls; do not reintroduce a second planning loop there.
- Run core tests and the simulated loop without Minecraft: `bash gradlew -p harness test run --args='demo build/demo' --no-daemon`. Consult docs/HARNESS.md for the host-thread and receipt contract.
- DONE must always use the harness goal acceptance check, regardless of action until fields or an adapter-reported success.
- Session limits must be enforced by code, include reviews and canceled requests, survive world changes, and end as INTERRUPTED. Test boundaries with a fake monotonic clock.
- Update README, HARNESS and VALIDATION when changing public behavior; report simulated tests separately from real gameplay evaluation.

- Start human handoff work from docs/DEVELOPMENT.md and docs/HANDOVER.md; keep AGENTS.md as the single project instruction source.
- Run `python3 tools/check_repository.py` and `python3 -m unittest discover -s tools -p 'test_*.py' -v` for repository/tool changes. The import check is lightweight, not a substitute for compilation or server/client review.
- Follow .editorconfig for new edits and the surrounding file style; do not mix repository-wide formatting with behavioral changes.

- Register new skills through the instance SkillRegistry; validate arguments in factories, preserve legacy built-in aliases, and forward child lifecycle hooks. Consult docs/EXTENSIONS.md.
- For profile or extension API changes, run the independent example: `bash gradlew -p examples/collect-return :test :run --args='build/demo' --no-daemon`. Do not run it concurrently with other Gradle builds.
- Treat same-JVM providers as trusted code. Skill selection is not a permission sandbox; do not claim real Minecraft extension installation from the headless example.
