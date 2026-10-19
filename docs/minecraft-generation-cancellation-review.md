# Local inference cancellation review

Reviewed 2026-10-13. This change supplies `src/local_llm/generation_gate.py`; it does **not** modify or activate `server.py`.

The reviewed service acquires a `threading.Lock` with a 60-second wait in a synchronous FastAPI handler. Disconnected non-streaming requests can remain in that wait and subsequently run inference. Non-streaming generation has no disconnect stopping criterion. A client-side planner timeout therefore does not establish that the previous GPU request has stopped. Streaming worker exceptions also need to finish the streamer, otherwise its consumer can wait for the streamer timeout.

The independent gate provides one FIFO admission slot and four waiting slots by default. Queue wait defaults to three seconds, generation to 45 seconds. An async disconnect predicate is checked every 50 milliseconds while waiting and generating. Queue cancellation removes the ticket. Running cancellation sets the worker's `threading.Event` and lets the caller finish, but retains the GPU slot until the actual native worker exits. It never assumes that cancelling an asyncio future kills its underlying thread.

Integration contract for the service owner:

1. Create one `CancellableGenerationGate` for the service event loop. Convert the request handler to async and accept a FastAPI `Request`.
2. Call `await gate.execute(work, is_disconnected=http_request.is_disconnected, queue_timeout=3, run_timeout=45)`.
3. Put preparation/tokenization/device transfers, adapter-context selection, and model generation inside synchronous `work(stop_event)`. Add the existing `DisconnectStoppingCriteria(stop_event)` to **every** generation call. Preserve per-request `metadata.used_adapter`.
4. Route both streaming and non-streaming inference through the same gate; remove the old blocking-lock path rather than acquiring both. A split implementation would permit concurrent use and adapter races. Feed/finish the streaming output in the worker, including exception paths, and propagate cancellation when the response disconnects.
5. Map queue-full/queue-timeout to 503, generation timeout to 504, and disconnected requests to a local cancelled outcome (499 if the framework still needs a response). Expose `gate.snapshot()` for actual busy/queued state. During orderly shutdown stop accepting requests and await `gate.drain(cancel=True)`.

This is cooperative cancellation. A running CUDA kernel cannot be forcibly interrupted by this module. If the model never returns or ignores stopping criteria, the slot stays occupied, later requests time out, and process recovery is required. Keeping the slot held is essential to avoid unsafe concurrent model or adapter access. The async disconnect callback must itself return promptly.

Validation: `runtime/local-llm/.venv/Scripts/python.exe tests/test_generation_gate.py` passed five tests covering FIFO and queue capacity; queued cancellation, disconnect and timeout; runtime deadline retaining the slot until native exit; running disconnect/task cancellation; and worker-error propagation with subsequent slot reuse. These tests use native threads and events without loading a model or GPU. Endpoint integration and real model cancellation remain service-owner acceptance work.

Reactive timing is separate: fallback path planning targets a total 60 ms cooperative budget with a 20 ms margin below the requested 80 ms ceiling. It examines at most four rotating candidates, gives each search at most 12 ms and each generator slice at most 6 ms, and stops issuing work when less than 12 ms remains. `reactive_timing` and `snapshot.timing` report actual tick duration, sample gaps, skipped overlapping ticks, planning duration and overrun count. The configured 200 ms sample interval is a scheduling target, **not** a maximum response-latency guarantee. A synchronous library call can overrun; a test deliberately simulates 90 ms and verifies that the measured overrun is visible.
