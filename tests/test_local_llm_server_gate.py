"""CPU-only endpoint integration tests for serialized chat and stream generation."""
import asyncio
import queue
import threading
import unittest
import weakref
from contextlib import nullcontext
from unittest.mock import Mock, patch

import torch

from src.local_llm import server
from src.local_llm.generation_gate import CancellableGenerationGate


class Batch(dict):
    def to(self, _device):
        return self


class FakeProcessor:
    tokenizer = object()

    def apply_chat_template(self, *_args, **_kwargs):
        return "test prompt"

    def __call__(self, **_kwargs):
        return Batch(input_ids=torch.tensor([[1, 2]], dtype=torch.long))

    def decode(self, *_args, **_kwargs):
        return "{}"


_END = object()


class FakeStreamer:
    def __init__(self, *_args, **_kwargs):
        self.values = queue.Queue()

    def put(self, value):
        self.values.put(value)

    def end(self):
        self.values.put(_END)

    def __iter__(self):
        while True:
            value = self.values.get(timeout=5)
            if value is _END:
                return
            yield value


class FakeModel:
    device = "cpu"

    def __init__(self):
        self.release = threading.Event()
        self.started = threading.Event()
        self.mutex = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.cancel_seen = []

    def disable_adapter(self):
        return nullcontext()

    def generate(self, **kwargs):
        with self.mutex:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.started.set()
        try:
            streamer = kwargs.get("streamer")
            if streamer:
                streamer.put("token")
            self.release.wait(3)
            criteria = kwargs.get("stopping_criteria")
            self.cancel_seen.append(bool(criteria and criteria[0](None, None)))
            if streamer:
                streamer.end()
                return None
            return torch.tensor([[1, 2, 3]], dtype=torch.long)
        finally:
            with self.mutex:
                self.active -= 1


class FakeRequest:
    def __init__(self):
        self.disconnected = False
        self.headers = {}

    async def is_disconnected(self):
        return self.disconnected


class ServerGateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.model = FakeModel()
        self.processor = FakeProcessor()
        self.old = (server.model, server.processor, server.generation_gate, server.ADAPTER_PATH, server.TextIteratorStreamer)
        server.model = self.model
        server.processor = self.processor
        server.generation_gate = CancellableGenerationGate(max_waiters=2, poll_seconds=0.002)
        server.ADAPTER_PATH = ""
        server.TextIteratorStreamer = FakeStreamer

    async def asyncTearDown(self):
        await server.generation_gate.drain(cancel=True)
        server.model, server.processor, server.generation_gate, server.ADAPTER_PATH, server.TextIteratorStreamer = self.old

    async def until(self, condition):
        async with asyncio.timeout(2):
            while not condition():
                await asyncio.sleep(0.002)

    @staticmethod
    def request(stream=False):
        return server.ChatRequest(messages=[{"role": "user", "content": "test"}], stream=stream, temperature=0)

    async def test_stream_and_nonstream_share_one_gpu_slot(self):
        first = asyncio.create_task(server.chat(self.request(), FakeRequest()))
        await self.until(lambda: self.model.started.is_set())
        streaming = asyncio.create_task(server.chat(self.request(stream=True), FakeRequest()))
        await self.until(lambda: server.generation_gate.snapshot()["queued"] == 1)
        self.assertEqual(self.model.max_active, 1)
        self.model.release.set()
        response = await first
        stream_response = await streaming
        chunks = [chunk async for chunk in stream_response.body_iterator]
        rendered = "".join(chunk.decode() if isinstance(chunk, bytes) else chunk for chunk in chunks)
        self.assertIn("token", rendered)
        self.assertEqual(response["metadata"]["used_adapter"], False)
        self.assertEqual(self.model.max_active, 1)
        self.assertFalse(server.generation_gate.snapshot()["active"])

    async def test_disconnect_returns_but_keeps_slot_until_native_generate_exits(self):
        client = FakeRequest()
        first = asyncio.create_task(server.chat(self.request(), client))
        await self.until(lambda: self.model.started.is_set())
        second = asyncio.create_task(server.chat(self.request(), FakeRequest()))
        await self.until(lambda: server.generation_gate.snapshot()["queued"] == 1)
        client.disconnected = True
        with self.assertRaises(server.HTTPException) as raised:
            await first
        self.assertEqual(raised.exception.status_code, 499)
        await asyncio.sleep(0.03)
        self.assertEqual(self.model.max_active, 1, "disconnect must not release the slot while generate still runs")
        self.model.release.set()
        await second
        self.assertEqual(self.model.max_active, 1)
        self.assertEqual(self.model.cancel_seen[0], True)

    async def test_cancelled_stream_admission_does_not_leave_queued_worker(self):
        first = asyncio.create_task(server.chat(self.request(), FakeRequest()))
        await self.until(lambda: self.model.started.is_set())
        queued = asyncio.create_task(server.chat(self.request(stream=True), FakeRequest()))
        await self.until(lambda: server.generation_gate.snapshot()["queued"] == 1)
        queued.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await queued
        self.assertEqual(server.generation_gate.snapshot()["queued"], 0)
        self.model.release.set()
        await first
        await asyncio.sleep(0.03)
        self.assertEqual(self.model.max_active, 1)

    async def test_stream_reports_run_deadline_without_waiting_for_streamer_timeout(self):
        old_timeout = server.GENERATION_RUN_TIMEOUT_SECONDS
        server.GENERATION_RUN_TIMEOUT_SECONDS = 0.05
        try:
            response = await server.chat(self.request(stream=True), FakeRequest())
            async with asyncio.timeout(0.5):
                chunks = [chunk async for chunk in response.body_iterator]
            rendered = "".join(chunk.decode() if isinstance(chunk, bytes) else chunk for chunk in chunks)
            self.assertIn("Generation deadline expired", rendered)
            self.assertEqual(self.model.max_active, 1)
        finally:
            self.model.release.set()
            server.GENERATION_RUN_TIMEOUT_SECONDS = old_timeout

    async def test_health_reads_counters_without_touching_gpu_work(self):
        cuda = Mock()
        cuda.is_initialized.return_value = True
        cuda.device_count.return_value = 1
        cuda.memory_allocated.return_value = 123
        cuda.memory_reserved.return_value = 456
        cuda.max_memory_allocated.return_value = 789
        cuda.max_memory_reserved.return_value = 999
        with patch.object(server.torch, "cuda", cuda):
            result = await server.health()
        self.assertEqual(result["gpu_memory"], {"initialized": True, "devices": [{
            "device": 0, "allocated_bytes": 123, "reserved_bytes": 456,
            "max_allocated_bytes": 789, "max_reserved_bytes": 999,
        }]})
        cuda.synchronize.assert_not_called()
        cuda.empty_cache.assert_not_called()
        cuda.reset_peak_memory_stats.assert_not_called()

    async def test_health_does_not_initialize_cuda_and_sanitizes_read_errors(self):
        cuda = Mock()
        cuda.is_initialized.return_value = False
        with patch.object(server.torch, "cuda", cuda):
            self.assertEqual((await server.health())["gpu_memory"], {"initialized": False, "devices": []})
        cuda.device_count.assert_not_called()
        cuda.is_initialized.side_effect = RuntimeError("private diagnostic detail")
        with patch.object(server.torch, "cuda", cuda):
            result = await server.health()
        self.assertEqual(result["gpu_memory"]["error_type"], "RuntimeError")
        self.assertNotIn("private", str(result))

    async def test_failed_generation_does_not_retain_tensors_in_traceback(self):
        references = []

        def fail(**kwargs):
            temporary = torch.zeros(8)
            references.extend([weakref.ref(temporary), weakref.ref(kwargs["input_ids"])])
            raise RuntimeError("expected generation failure")

        self.model.generate = fail
        for streaming in (False, True):
            with self.subTest(streaming=streaming):
                held_error = None
                try:
                    response = await server.chat(self.request(stream=streaming), FakeRequest())
                    chunks = [chunk async for chunk in response.body_iterator]
                    self.assertIn("expected generation failure", "".join(chunks))
                except RuntimeError as error:
                    held_error = error
                # Allow the gate's done callbacks to remove completed jobs
                # before asking drain to wait for outstanding native work.
                await self.until(lambda: not server.generation_gate._jobs)
                await server.generation_gate.drain()
                self.assertTrue(references)
                self.assertTrue(all(reference() is None for reference in references),
                                "finished error traceback must not keep tensors alive")
                if not streaming:
                    self.assertIsNotNone(held_error, "nonstream errors must still propagate")
                self.assertFalse(server.generation_gate.snapshot()["active"])


if __name__ == "__main__":
    unittest.main()
