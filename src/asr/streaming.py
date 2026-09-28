"""Stateful PCM adapter for an opt-in FunASR streaming service.

This module deliberately has no network listener.  The ASR service owns the
WebSocket lifecycle and creates one ``StreamingAsrSession`` per connection.
Keeping the session logic here makes its cache, sequence, final-flush, and
cancel semantics testable without downloading a model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


class StreamingRecognizer(Protocol):
    """Recognize signed 16-bit mono PCM while retaining the supplied cache."""

    def recognize(self, pcm16: bytes, cache: dict[str, Any], *, is_final: bool) -> str:
        ...


@dataclass
class StreamingAsrSession:
    recognizer: StreamingRecognizer
    chunk_samples: int = 9600  # 600 ms at 16 kHz, matching FunASR [0, 10, 5].
    cache: dict[str, Any] = field(default_factory=dict)
    _pending: bytearray = field(default_factory=bytearray, init=False)
    _sequence: int = field(default=0, init=False)
    _state: str = field(default="open", init=False)

    def __post_init__(self) -> None:
        if self.chunk_samples <= 0:
            raise ValueError("chunk_samples must be positive")

    @property
    def state(self) -> str:
        return self._state

    @property
    def pending_samples(self) -> int:
        return len(self._pending) // 2

    def feed_pcm(self, pcm16: bytes) -> list[dict[str, Any]]:
        """Feed a raw 16 kHz mono PCM fragment and emit any partial events.

        One chunk stays buffered so ``finish`` can mark the actual final model
        call with ``is_final=True`` instead of trying to flush an empty cache.
        """
        self._require_open()
        if len(pcm16) % 2:
            raise ValueError("PCM16 payload must contain whole samples")
        self._pending.extend(pcm16)
        events: list[dict[str, Any]] = []
        while len(self._pending) > self._chunk_bytes:
            events.append(self._run(bytes(self._pending[: self._chunk_bytes]), is_final=False))
            del self._pending[: self._chunk_bytes]
        return events

    def finish(self) -> list[dict[str, Any]]:
        """Flush all remaining audio exactly once and close the session."""
        self._require_open()
        events: list[dict[str, Any]] = []
        while len(self._pending) > self._chunk_bytes:
            events.append(self._run(bytes(self._pending[: self._chunk_bytes]), is_final=False))
            del self._pending[: self._chunk_bytes]
        if self._pending:
            events.append(self._run(bytes(self._pending), is_final=True))
            self._pending.clear()
        self._state = "finished"
        self.cache.clear()
        return events

    def cancel(self) -> None:
        """Release cached model state without attempting a final decode."""
        if self._state != "open":
            return
        self._pending.clear()
        self.cache.clear()
        self._state = "cancelled"

    @property
    def _chunk_bytes(self) -> int:
        return self.chunk_samples * 2

    def _run(self, pcm16: bytes, *, is_final: bool) -> dict[str, Any]:
        text = self.recognizer.recognize(pcm16, self.cache, is_final=is_final)
        event = {
            "type": "final" if is_final else "partial",
            "sequence": self._sequence,
            "text": str(text or ""),
            "isFinal": is_final,
        }
        self._sequence += 1
        return event

    def _require_open(self) -> None:
        if self._state != "open":
            raise RuntimeError(f"streaming ASR session is {self._state}")


class FunAsrOnlineRecognizer:
    """Thin adapter for ``paraformer-zh-streaming`` loaded by the service."""

    def __init__(self, model: Any, *, chunk_size: tuple[int, int, int] = (0, 10, 5)) -> None:
        self.model = model
        self.chunk_size = list(chunk_size)

    def recognize(self, pcm16: bytes, cache: dict[str, Any], *, is_final: bool) -> str:
        # Import lazily: unit tests and disabled deployments require no NumPy or
        # model download merely to import this module.
        import numpy as np

        samples = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        result = self.model.generate(
            input=samples,
            cache=cache,
            is_final=is_final,
            chunk_size=self.chunk_size,
            encoder_chunk_look_back=4,
            decoder_chunk_look_back=1,
        )
        return "".join(str(item.get("text", "")) for item in result).strip()
