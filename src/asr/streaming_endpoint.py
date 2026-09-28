"""Opt-in WebSocket transport; model ownership remains in the ASR service."""
import asyncio
import json
from .streaming import StreamingAsrSession


async def decode(function, *args):
    # Cancelling to_thread cannot stop native inference. Wait for it before
    # clearing its mutable cache, including during service shutdown.
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        try:
            await task
        finally:
            raise


async def serve_stream(websocket, recognizer):
    await websocket.accept()
    session = StreamingAsrSession(recognizer)
    started = False
    received_bytes = 0
    try:
        while True:
            message = await asyncio.wait_for(websocket.receive(), timeout=30)
            if message["type"] == "websocket.disconnect":
                return
            pcm = message.get("bytes")
            if pcm is not None:
                if not started:
                    raise ValueError("start is required before PCM")
                received_bytes += len(pcm)
                if len(pcm) > 64_000 or received_bytes > 3_840_000:
                    raise ValueError("audio exceeds frame or session limit")
                # Model state is per session. Await each call to preserve order.
                events = await decode(session.feed_pcm, pcm)
            else:
                raw = message.get("text", "")
                if len(raw) > 1024:
                    raise ValueError("control message too large")
                control = json.loads(raw)
                if not isinstance(control, dict):
                    raise ValueError("control must be an object")
                kind = control.get("type")
                if kind == "cancel":
                    session.cancel()
                    await websocket.send_json({"type": "cancelled"})
                    await websocket.close(code=1000)
                    return
                if kind == "start" and not started:
                    if (control.get("sampleRate"), control.get("channels"), control.get("format")) != (16000, 1, "pcm_s16le"):
                        raise ValueError("expected 16kHz mono pcm_s16le")
                    started = True
                    await websocket.send_json({"type": "ready"})
                    continue
                if kind != "finish" or not started:
                    raise ValueError("unexpected control message")
                events = await decode(session.finish)
                if not events:
                    events = [{"type": "final", "sequence": 0, "text": "", "isFinal": True}]
            for event in events:
                await websocket.send_json(event)
            if session.state == "finished":
                await websocket.close(code=1000)
                return
    except (ValueError, asyncio.TimeoutError):
        await websocket.close(code=1008)
    finally:
        session.cancel()
