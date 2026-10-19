"""Bounded metadata only; never retain prompts, images, headers or exception text."""
import json
import logging
import time
import uuid

logger = logging.getLogger("uvicorn.error")
TASKS = {"minecraft-survival", "minecraft-commentary", "minecraft-visual-observation"}

class RequestDiagnostic:
    def __init__(self, task=None, request_id=None, emit=None):
        # Accept only UUID correlation IDs, never arbitrary client header content.
        try:
            self.request_id = str(uuid.UUID(str(request_id)))
        except (ValueError, TypeError, AttributeError):
            self.request_id = str(uuid.uuid4())
        self.task = task if task in TASKS else "other"
        self.started = time.perf_counter()
        self.admitted_at = None
        self.cancelled_at = None
        self.phase = "queued"
        self.metrics = {}
        self.emit = emit or (lambda record: logger.info("generation_performance %s", json.dumps(record)))
        self.finished = False

    def admitted(self):
        self.admitted_at = time.perf_counter()
        self.metrics["queue_ms"] = round((self.admitted_at - self.started) * 1000, 1)

    def measure(self, phase, work):
        self.phase = phase
        started = time.perf_counter()
        try:
            return work()
        except BaseException as error:
            self.metrics["error_type"] = type(error).__name__
            raise
        finally:
            self.metrics[phase + "_ms"] = round((time.perf_counter() - started) * 1000, 1)

    def input_tokens(self, inputs):
        self.metrics["input_tokens"] = int(inputs["input_ids"].shape[-1])

    def snapshot(self):
        now = time.perf_counter()
        return {"request_id": self.request_id, "task": self.task, "phase": self.phase,
                "elapsed_ms": round((now-self.started)*1000, 1),
                "running_ms": round((now-self.admitted_at)*1000, 1) if self.admitted_at is not None else None,
                "cancel_requested": self.cancelled_at is not None, **self.metrics}

    def finish(self, outcome):
        if self.finished:
            return
        self.finished = True
        record = self.snapshot()
        if self.admitted_at is None:
            record["queue_ms"] = record["elapsed_ms"]
        record["outcome"] = outcome
        record["cancel_to_exit_ms"] = round((time.perf_counter()-self.cancelled_at)*1000, 1) if self.cancelled_at is not None else None
        # Diagnostics must never alter admission/cancellation or leak exceptions.
        try:
            self.emit(record)
        except Exception:
            pass
