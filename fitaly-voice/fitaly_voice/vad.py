from __future__ import annotations

from collections import deque
from typing import Generator, Iterator

import numpy as np

# TEN VAD processes fixed-size frames at 16kHz.
# hop_size=256 → 16ms per frame (recommended for conversational AI)
# hop_size=160 → 10ms per frame (higher resolution, slightly more CPU)
_DEFAULT_HOP = 256  # samples per frame at 16kHz


class TenVAD:
    """
    Voice Activity Detection using TEN-framework VAD.

    Advantages over Silero VAD:
    - No PyTorch dependency (ONNX-based, ~306KB model)
    - RTF ~0.009 on CPU vs ~0.05 for Silero
    - Designed for low-latency conversational AI (barge-in, transitions)
    - Apache 2.0 licensed

    Install:
        pip install git+https://github.com/TEN-framework/ten-vad.git

    Input: audio at 16kHz, any chunk size (internally split into hop_size frames).
    """

    def __init__(
        self,
        threshold: float = 0.5,
        min_speech_ms: int = 300,
        max_silence_ms: int = 500,
        sample_rate: int = 16000,
        hop_size: int = _DEFAULT_HOP,
    ) -> None:
        if sample_rate != 16000:
            raise ValueError("TEN VAD requires 16kHz audio (sample_rate must be 16000)")
        self.threshold = threshold
        self.min_speech_ms = min_speech_ms
        self.max_silence_ms = max_silence_ms
        self.sample_rate = sample_rate
        self.hop_size = hop_size
        self._vad = self._load()

    def _load(self):
        from ten_vad import TenVad  # type: ignore[import]

        return TenVad(self.hop_size)

    # ── Frame-level API ───────────────────────────────────────────────────────

    def frame_probability(self, frame: np.ndarray) -> float:
        """
        Return speech probability [0, 1] for a single frame of hop_size samples.

        Accepts float32 [-1, 1] or int16. Pads/truncates to hop_size automatically.
        """
        pcm = _to_int16(frame)
        if len(pcm) < self.hop_size:
            pcm = np.pad(pcm, (0, self.hop_size - len(pcm)))
        elif len(pcm) > self.hop_size:
            pcm = pcm[: self.hop_size]

        result = self._vad.is_speech(pcm)
        # TEN VAD may return float directly or an object with getProbability()
        if isinstance(result, (int, float)):
            return float(result)
        if hasattr(result, "getProbability"):
            return float(result.getProbability())
        return float(result)

    def chunk_probability(self, chunk: np.ndarray) -> float:
        """Average speech probability across all frames in *chunk*."""
        n = len(chunk)
        if n == 0:
            return 0.0
        probs = [
            self.frame_probability(chunk[i : i + self.hop_size])
            for i in range(0, n, self.hop_size)
        ]
        return float(np.mean(probs))

    def is_speech(self, chunk: np.ndarray) -> bool:
        """Return True if *chunk* has average speech probability ≥ threshold."""
        return self.chunk_probability(chunk) >= self.threshold

    # ── Chunk-stream filtering ────────────────────────────────────────────────

    def filter_chunks(
        self,
        chunks: Iterator[np.ndarray],
    ) -> Generator[np.ndarray, None, None]:
        """
        Yield only chunks that contain speech, with hysteresis.

        min_speech_ms:  consecutive speech needed to open a segment.
        max_silence_ms: silence tolerated before closing a segment.

        Filters out:
        - Silence and distant/low-energy voices
        - Short noise bursts below min_speech_ms
        """
        speech_buffer: deque[np.ndarray] = deque()
        silence_ms = 0.0
        speech_ms = 0.0
        in_speech = False

        for chunk in chunks:
            chunk_ms = len(chunk) / self.sample_rate * 1000
            is_spch = self.is_speech(chunk)

            if is_spch:
                silence_ms = 0.0
                speech_ms += chunk_ms
                speech_buffer.append(chunk)

                if not in_speech and speech_ms >= self.min_speech_ms:
                    # Transition → speech: flush pre-roll buffer
                    in_speech = True
                    while speech_buffer:
                        yield speech_buffer.popleft()
                elif in_speech:
                    # Steady-state: emit directly
                    yield speech_buffer.pop()
            else:
                speech_ms = 0.0
                if in_speech:
                    silence_ms += chunk_ms
                    speech_buffer.append(chunk)
                    if silence_ms >= self.max_silence_ms:
                        in_speech = False
                        speech_buffer.clear()
                        silence_ms = 0.0
                    # else: tolerated silence — keep buffering
                else:
                    speech_buffer.clear()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _to_int16(audio: np.ndarray) -> np.ndarray:
    """Convert float32 [-1, 1] or int16 to int16."""
    if audio.dtype == np.int16:
        return audio
    return (audio.astype(np.float32) * 32767).clip(-32768, 32767).astype(np.int16)
