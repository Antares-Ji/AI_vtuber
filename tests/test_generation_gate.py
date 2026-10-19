"""No model/GPU required: validate admission and native-worker ownership."""
import asyncio
import importlib.util
from pathlib import Path
import threading
import unittest

spec = importlib.util.spec_from_file_location("generation_gate", Path(__file__).resolve().parents[1] / "src/local_llm/generation_gate.py")
gate_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate_module)
Gate = gate_module.CancellableGenerationGate


class GateTests(unittest.IsolatedAsyncioTestCase):
    async def until(self, predicate):
        async with asyncio.timeout(1):
            while not predicate():
                await asyncio.sleep(0.002)

    async def test_fifo_bounded_queue_and_cancelled_waiter_never_runs(self):
        gate = Gate(max_waiters=2, poll_seconds=0.002)
        release = threading.Event()
        order = []
        first = asyncio.create_task(gate.execute(lambda stop: release.wait(2)))
        await self.until(lambda: gate.snapshot()["active"])
        cancelled = asyncio.create_task(gate.execute(lambda stop: order.append("cancelled")))
        second = asyncio.create_task(gate.execute(lambda stop: order.append("second")))
        await self.until(lambda: gate.snapshot()["queued"] == 2)
        with self.assertRaises(gate_module.QueueFull):
            await gate.execute(lambda stop: None)
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await cancelled
        third = asyncio.create_task(gate.execute(lambda stop: order.append("third")))
        await self.until(lambda: gate.snapshot()["queued"] == 2)
        release.set()
        await asyncio.gather(first, second, third)
        self.assertEqual(order, ["second", "third"])
        self.assertFalse(gate.snapshot()["active"])

    async def test_queue_disconnect_and_deadline(self):
        gate = Gate(poll_seconds=0.002)
        release = threading.Event()
        first = asyncio.create_task(gate.execute(lambda stop: release.wait(2)))
        await self.until(lambda: gate.snapshot()["active"])
        disconnected = False
        async def check():
            return disconnected
        waiter = asyncio.create_task(gate.execute(lambda stop: self.fail("stale job ran"), is_disconnected=check))
        await self.until(lambda: gate.snapshot()["queued"] == 1)
        disconnected = True
        with self.assertRaises(gate_module.ClientDisconnected):
            await waiter
        with self.assertRaises(gate_module.QueueTimeout):
            await gate.execute(lambda stop: self.fail("expired job ran"), queue_timeout=0.01)
        self.assertEqual(gate.snapshot()["queued"], 0)
        release.set()
        await first

    async def test_runtime_timeout_retains_gpu_slot_until_native_exit(self):
        gate = Gate(poll_seconds=0.002)
        release = threading.Event()
        stop_seen = threading.Event()
        def stubborn_worker(stop):
            stop.wait(1)
            stop_seen.set()
            release.wait(2)  # Simulates a kernel that cannot immediately stop.
        with self.assertRaises(gate_module.GenerationTimeout):
            await gate.execute(stubborn_worker, run_timeout=0.01)
        await self.until(stop_seen.is_set)
        self.assertTrue(gate.snapshot()["active"])
        ran = threading.Event()
        second = asyncio.create_task(gate.execute(lambda stop: ran.set()))
        await asyncio.sleep(0.02)
        self.assertFalse(ran.is_set(), "must never run two model/adapter operations together")
        release.set()
        await second
        await gate.drain()
        self.assertTrue(ran.is_set())
        self.assertEqual(gate.snapshot()["cancelled_running"], 1)

    async def test_running_disconnect_and_task_cancel_stop_worker(self):
        for disconnect in (True, False):
            gate = Gate(poll_seconds=0.002)
            seen = threading.Event()
            disconnected = False
            def worker(stop):
                stop.wait(1)
                seen.set()
            async def check():
                return disconnected
            task = asyncio.create_task(gate.execute(worker, is_disconnected=check))
            await self.until(lambda: gate.snapshot()["active"])
            if disconnect:
                disconnected = True
                with self.assertRaises(gate_module.ClientDisconnected):
                    await task
            else:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
            await gate.drain()
            self.assertTrue(seen.is_set())
            self.assertFalse(gate.snapshot()["active"])

    async def test_worker_exception_releases_slot_and_preserves_error(self):
        gate = Gate(poll_seconds=0.002)
        def fail(stop):
            raise ValueError("native failure")
        with self.assertRaisesRegex(ValueError, "native failure"):
            await gate.execute(fail)
        self.assertEqual(await gate.execute(lambda stop: "ok"), "ok")


if __name__ == "__main__":
    unittest.main()
