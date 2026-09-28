import json
import unittest
from src.asr.streaming_endpoint import serve_stream


class Recognizer:
    def __init__(self):
        self.calls = []

    def recognize(self, pcm, cache, *, is_final):
        cache["active"] = True
        self.calls.append((bytes(pcm), cache, is_final))
        return "final" if is_final else "partial"


class Socket:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.events = []
        self.code = None

    async def accept(self):
        pass

    async def receive(self):
        return next(self.messages, {"type": "websocket.disconnect"})

    async def send_json(self, value):
        self.events.append(value)

    async def close(self, code):
        self.code = code


def control(**value):
    return {"type": "websocket.receive", "text": json.dumps(value)}


START = control(type="start", sampleRate=16000, channels=1, format="pcm_s16le")
PCM = {"type": "websocket.receive", "bytes": b"\0" * 20000}


class EndpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_partial_final_and_cache_release(self):
        recognizer = Recognizer()
        socket = Socket([START, PCM, control(type="finish")])
        await serve_stream(socket, recognizer)
        self.assertEqual([event["type"] for event in socket.events], ["ready", "partial", "final"])
        self.assertEqual(socket.code, 1000)
        self.assertEqual([call[2] for call in recognizer.calls], [False, True])
        self.assertTrue(all(call[1] == {} for call in recognizer.calls))

    async def test_cancel_and_disconnect_never_finalize(self):
        for ending in [control(type="cancel"), {"type": "websocket.disconnect"}]:
            recognizer = Recognizer()
            await serve_stream(Socket([START, PCM, ending]), recognizer)
            self.assertEqual(len(recognizer.calls), 1)
            self.assertEqual(recognizer.calls[0][1], {})
            self.assertFalse(recognizer.calls[0][2])

    async def test_empty_finish_and_invalid_order(self):
        socket = Socket([START, control(type="finish")])
        await serve_stream(socket, Recognizer())
        self.assertEqual(socket.events[-1]["type"], "final")
        for messages in [[PCM], [START, START], [START, {"type": "websocket.receive", "bytes": b"x"}], [control(type="start", sampleRate=48000)]]:
            socket = Socket(messages)
            await serve_stream(socket, Recognizer())
            self.assertEqual(socket.code, 1008)


if __name__ == "__main__":
    unittest.main()
