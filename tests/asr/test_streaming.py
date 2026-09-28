import unittest

from src.asr.streaming import StreamingAsrSession


class MockRecognizer:
    def __init__(self):
        self.calls = []

    def recognize(self, pcm16, cache, *, is_final):
        cache["calls"] = cache.get("calls", 0) + 1
        self.calls.append({"pcm": pcm16, "cache": cache, "is_final": is_final})
        return f"chunk-{cache['calls']}"


class StreamingSessionTests(unittest.TestCase):
    def test_cache_sequence_and_final_flush(self):
        recognizer = MockRecognizer()
        session = StreamingAsrSession(recognizer, chunk_samples=4)

        partial = session.feed_pcm(b"a" * 20)  # two chunks plus a buffered final chunk
        final = session.finish()

        self.assertEqual([event["sequence"] for event in partial + final], [0, 1, 2])
        self.assertEqual([event["type"] for event in partial + final], ["partial", "partial", "final"])
        self.assertEqual([call["is_final"] for call in recognizer.calls], [False, False, True])
        self.assertTrue(all(call["cache"] is recognizer.calls[0]["cache"] for call in recognizer.calls))
        self.assertEqual(session.state, "finished")
        self.assertEqual(session.pending_samples, 0)
        self.assertEqual(session.cache, {})

    def test_cancel_releases_cache_and_rejects_future_audio(self):
        recognizer = MockRecognizer()
        session = StreamingAsrSession(recognizer, chunk_samples=4)
        session.feed_pcm(b"a" * 8)
        session.cache["model-state"] = "allocated"

        session.cancel()

        self.assertEqual(session.state, "cancelled")
        self.assertEqual(session.cache, {})
        self.assertEqual(session.pending_samples, 0)
        with self.assertRaises(RuntimeError):
            session.feed_pcm(b"a" * 2)


if __name__ == "__main__":
    unittest.main()
