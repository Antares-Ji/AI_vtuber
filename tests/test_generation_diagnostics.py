"""CPU-only mocked worker tests, no model imports."""
import asyncio
import importlib.util
from pathlib import Path
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "src/local_llm" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
G = load("generation_gate")
D = load("performance_diagnostics").RequestDiagnostic

class Tests(unittest.IsolatedAsyncioTestCase):
    async def until(self, predicate):
        async with asyncio.timeout(2):
            while not predicate():
                await asyncio.sleep(.002)

    async def test_success_metadata_and_health(self):
        gate = G.CancellableGenerationGate(poll_seconds=.002)
        records = []
        d = D("minecraft-survival", "00000000-0000-0000-0000-000000000001", records.append)
        release = threading.Event()
        def work(stop):
            d.measure("prepare", lambda: None)
            d.input_tokens({"input_ids": type("MockTensor", (), {"shape": (1, 123)})()})
            return d.measure("generate", lambda: release.wait(2))
        job = asyncio.create_task(gate.execute(work, diagnostic=d))
        await self.until(lambda: gate.snapshot()["current"] and gate.snapshot()["current"]["phase"] == "generate")
        self.assertEqual(gate.snapshot()["current"]["input_tokens"], 123)
        release.set()
        self.assertTrue(await job)
        self.assertIsNone(gate.snapshot()["current"])
        self.assertEqual(len(records), 1)
        for field in ["prepare_ms", "generate_ms", "queue_ms"]:
            self.assertGreaterEqual(records[0][field], 0)
        self.assertIsNone(records[0]["cancel_to_exit_ms"])

    async def test_timeout_keeps_health_until_native_exit(self):
        gate = G.CancellableGenerationGate(poll_seconds=.002)
        records = []; release = threading.Event()
        d = D("minecraft-survival", emit=records.append)
        job = asyncio.create_task(gate.execute(lambda stop: release.wait(2), diagnostic=d, run_timeout=.02))
        with self.assertRaises(G.GenerationTimeout):
            await job
        self.assertTrue(gate.snapshot()["active"])
        self.assertTrue(gate.snapshot()["current"]["cancel_requested"])
        self.assertEqual(records, [])
        release.set(); await gate.drain()
        self.assertGreaterEqual(records[0]["cancel_to_exit_ms"], 0)
        self.assertFalse(gate.snapshot()["active"])

    async def test_queue_timeout_and_untrusted_metadata(self):
        gate = G.CancellableGenerationGate(poll_seconds=.002)
        release = threading.Event(); records=[]
        first = asyncio.create_task(gate.execute(lambda stop: release.wait(2)))
        await self.until(lambda: gate.snapshot()["active"])
        d = D("SECRET-PROMPT", "SECRET-KEY", records.append)
        try:
            with self.assertRaises(G.QueueTimeout):
                await gate.execute(lambda stop: self.fail("must not run"), diagnostic=d, queue_timeout=.02)
        finally:
            release.set(); await first
        self.assertEqual(records[0]["outcome"], "QueueTimeout")
        self.assertNotIn("SECRET", str(records))
        self.assertIsNone(records[0]["running_ms"])

    async def test_sink_error_does_not_change_result(self):
        def bad_sink(record):
            raise RuntimeError("logging failed")
        gate = G.CancellableGenerationGate()
        self.assertEqual(await gate.execute(lambda stop: 42, diagnostic=D(emit=bad_sink)), 42)
        self.assertFalse(gate.snapshot()["active"])

if __name__ == "__main__":
    unittest.main()
