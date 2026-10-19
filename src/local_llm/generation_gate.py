"""FIFO admission and cooperative cancellation for one GPU worker.

No FastAPI/torch dependency. Use one gate per event loop. A caller may return
early on disconnect/deadline, but the GPU slot remains held until work exits.
The worker must check the provided threading.Event (e.g. stopping criteria).
This cannot interrupt a CUDA kernel; close the service only after drain().
"""
import asyncio
import threading
import time
from collections import deque


class QueueFull(RuntimeError):
    pass


class QueueTimeout(TimeoutError):
    pass


class GenerationTimeout(TimeoutError):
    pass


class ClientDisconnected(RuntimeError):
    pass


class CancellableGenerationGate:
    def __init__(self, max_waiters=4, poll_seconds=0.05):
        if max_waiters < 1 or poll_seconds <= 0:
            raise ValueError("max_waiters and poll_seconds must be positive")
        self.max_waiters = max_waiters
        self.poll_seconds = poll_seconds
        self._queue = deque()
        self._active = False
        self._jobs = set()
        self._stop_events = set()
        self._cancelled_running = 0
        self._diagnostic = None

    def snapshot(self):
        return {"active": self._active, "queued": len(self._queue),
                "max_waiters": self.max_waiters,
                "cancelled_running": self._cancelled_running,
                "current": self._diagnostic.snapshot() if self._diagnostic else None}

    async def _admit(self, disconnected, timeout):
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        if disconnected and await disconnected():
            raise ClientDisconnected("Client disconnected before admission")
        if len(self._queue) >= self.max_waiters:
            raise QueueFull("Generation queue is full")
        ticket = object()
        self._queue.append(ticket)
        try:
            while True:
                if disconnected and await disconnected():
                    raise ClientDisconnected("Client disconnected while queued")
                if loop.time() >= deadline:
                    raise QueueTimeout("Generation queue deadline expired")
                if not self._active and self._queue[0] is ticket:
                    self._queue.popleft()
                    self._active = True
                    return
                await asyncio.sleep(min(self.poll_seconds, max(0, deadline - loop.time())))
        finally:
            if ticket in self._queue:
                self._queue.remove(ticket)

    async def _worker(self, work, stop, diagnostic=None):
        # Shield the executor future: cancelling an await does not stop its
        # native thread. Keep ownership until that actual thread has exited.
        try:
            future = asyncio.get_running_loop().run_in_executor(None, work, stop)
            try:
                await asyncio.shield(future)
            except asyncio.CancelledError:
                stop.set()
                await asyncio.shield(future)
                raise
            return future.result()
        finally:
            self._active = False
            self._stop_events.discard(stop)
            if diagnostic:
                diagnostic.finish("worker_exited")
            self._diagnostic = None

    @staticmethod
    def _consume_result(job):
        if not job.cancelled():
            job.exception()  # Retrieve abandoned worker errors, without hiding awaited errors.

    async def execute(self, work, *, is_disconnected=None, queue_timeout=3.0, run_timeout=45.0, diagnostic=None):
        """Await synchronous work(stop_event); propagate its result/exception.

        is_disconnected is an async zero-argument callable. Put tokenization,
        device transfers, adapter selection and generation inside work so all
        GPU access shares this gate. Never also acquire the old blocking lock.
        """
        if queue_timeout <= 0 or run_timeout <= 0:
            raise ValueError("Timeouts must be positive")
        try:
            await self._admit(is_disconnected, queue_timeout)
        except BaseException as error:
            if diagnostic:
                diagnostic.finish(type(error).__name__)
            raise
        self._diagnostic = diagnostic
        if diagnostic:
            diagnostic.admitted()
        stop = DiagnosticStopEvent(diagnostic) if diagnostic else threading.Event()
        self._stop_events.add(stop)
        job = asyncio.create_task(self._worker(work, stop, diagnostic))
        self._jobs.add(job)
        job.add_done_callback(self._jobs.discard)
        job.add_done_callback(self._consume_result)
        deadline = asyncio.get_running_loop().time() + run_timeout
        try:
            while not job.done():
                if is_disconnected and await is_disconnected():
                    raise ClientDisconnected("Client disconnected during generation")
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    raise GenerationTimeout("Generation deadline expired")
                # asyncio.wait doesn't cancel the job when this caller is cancelled.
                await asyncio.wait({job}, timeout=min(self.poll_seconds, remaining))
            return job.result()
        finally:
            if not job.done():
                stop.set()
                self._cancelled_running += 1

    async def drain(self, cancel=False):
        """Wait for native workers; optionally request cooperative stopping."""
        if cancel:
            for stop in self._stop_events:
                stop.set()
        while self._jobs:
            await asyncio.gather(*(asyncio.shield(job) for job in tuple(self._jobs)), return_exceptions=True)

class DiagnosticStopEvent(threading.Event):
    def __init__(self, diagnostic):
        super().__init__()
        self.diagnostic = diagnostic

    def set(self):
        if not self.is_set():
            self.diagnostic.cancelled_at = time.perf_counter()
        super().set()
