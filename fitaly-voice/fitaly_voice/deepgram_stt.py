"""DeepgramSTT — real-time streaming STT via Deepgram WebSocket.

Primary production STT provider.  Each active speaker gets its own
WebSocket stream so transcripts include the correct ``speaker_id``.

Install:
    pip install deepgram-sdk

Usage:
    stt = DeepgramSTT(api_key="...", language="es", model="nova-2")
    stt.on_partial(lambda text, conf: print(f"[partial] {text}"))
    stt.on_final(lambda text, spk, conf: print(f"[{spk}] {text}"))
    await stt.start()
    stt.feed_audio(audio_chunk, speaker_id="spk_0")
    await stt.stop()

Each ``feed_audio()`` call routes the chunk to the per-speaker stream.
If no stream exists yet for that speaker, one is created on-the-fly.
"""
from __future__ import annotations

import asyncio
import logging
import struct
from typing import Callable, Dict, Optional

import numpy as np

from .stt_base import ISTTProvider

logger = logging.getLogger(__name__)


# ── Per-speaker WebSocket stream ──────────────────────────────────────────────

class _SpeakerStream:
    """Manages a single Deepgram WebSocket connection for one speaker."""

    def __init__(
        self,
        speaker_id: str,
        api_key: str,
        *,
        model: str = "nova-2",
        language: str = "es",
        sample_rate: int = 16_000,
        encoding: str = "linear16",
        interim_results: bool = True,
        on_partial: Callable[[str, float], None] | None = None,
        on_final: Callable[[str, str, float], None] | None = None,
    ) -> None:
        self.speaker_id = speaker_id
        self._api_key = api_key
        self._model = model
        self._language = language
        self._sample_rate = sample_rate
        self._encoding = encoding
        self._interim_results = interim_results
        self._on_partial = on_partial
        self._on_final = on_final
        self._connection = None
        self._started = False
        self._reconnect_attempts = 0
        self._max_reconnect_attempts = 3

    async def open(self) -> None:
        """Open the WebSocket connection to Deepgram."""
        from deepgram import DeepgramClient, LiveOptions, LiveTranscriptionEvents

        client = DeepgramClient(self._api_key)
        self._connection = client.listen.websocket.v("1")

        # Register event handlers
        self._connection.on(
            LiveTranscriptionEvents.Transcript, self._handle_transcript
        )
        self._connection.on(
            LiveTranscriptionEvents.Error, self._handle_error
        )

        options = LiveOptions(
            model=self._model,
            language=self._language,
            sample_rate=self._sample_rate,
            encoding=self._encoding,
            interim_results=self._interim_results,
            punctuate=True,
            smart_format=True,
        )
        started = self._connection.start(options)
        if not started:
            raise ConnectionError(
                f"Failed to open Deepgram WebSocket for speaker {self.speaker_id}"
            )
        self._started = True
        self._reconnect_attempts = 0
        logger.info("Deepgram stream opened for speaker %s", self.speaker_id)

    def _handle_transcript(self, _self_or_result, result=None, **kwargs) -> None:
        """Callback fired by Deepgram SDK on each transcript event."""
        # SDK v3+ passes (self, result, **kwargs); adapt for both signatures
        if result is None:
            result = _self_or_result

        try:
            alt = result.channel.alternatives[0]
            text = alt.transcript.strip()
            confidence = float(alt.confidence) if hasattr(alt, "confidence") else 0.0
        except (IndexError, AttributeError):
            return

        if not text:
            return

        is_final = getattr(result, "is_final", True)

        if is_final:
            if self._on_final:
                self._on_final(text, self.speaker_id, confidence)
        else:
            if self._on_partial:
                self._on_partial(text, confidence)

    def _handle_error(self, _self_or_error, error=None, **kwargs) -> None:
        """Log Deepgram errors and attempt reconnection."""
        if error is None:
            error = _self_or_error
        logger.error(
            "Deepgram error for speaker %s: %s", self.speaker_id, error
        )

    def send(self, audio: np.ndarray) -> None:
        """
        Send float32 audio to the Deepgram WebSocket as int16 PCM bytes.

        Args:
            audio: float32 mono PCM array, values in [-1, 1].
        """
        if not self._started or self._connection is None:
            return
        # Convert float32 [-1, 1] → int16 PCM bytes
        pcm_int16 = (audio * 32767).clip(-32768, 32767).astype(np.int16)
        self._connection.send(pcm_int16.tobytes())

    async def close(self) -> None:
        """Close the WebSocket connection gracefully."""
        if self._connection is not None and self._started:
            try:
                self._connection.finish()
            except Exception as exc:
                logger.warning(
                    "Error closing Deepgram stream for %s: %s",
                    self.speaker_id,
                    exc,
                )
            self._started = False
            self._connection = None

    async def reconnect(self) -> bool:
        """Attempt to reconnect after a WebSocket failure."""
        if self._reconnect_attempts >= self._max_reconnect_attempts:
            logger.error(
                "Max reconnect attempts reached for speaker %s",
                self.speaker_id,
            )
            return False
        self._reconnect_attempts += 1
        logger.info(
            "Reconnecting speaker %s (attempt %d/%d)",
            self.speaker_id,
            self._reconnect_attempts,
            self._max_reconnect_attempts,
        )
        await self.close()
        try:
            await self.open()
            return True
        except Exception as exc:
            logger.error("Reconnect failed for %s: %s", self.speaker_id, exc)
            return False

    @property
    def is_active(self) -> bool:
        return self._started and self._connection is not None


# ── DeepgramSTT (ISTTProvider implementation) ─────────────────────────────────

class DeepgramSTT:
    """
    Real-time streaming STT via Deepgram WebSocket.

    Implements ``ISTTProvider`` (from ``stt_base.py``).
    Creates one WebSocket stream per active speaker for accurate attribution.

    Config fields (from PipelineConfig):
        stt_provider = "deepgram"
        deepgram_api_key = "..."
        deepgram_model = "nova-2"
        stt_language = "es"
    """

    def __init__(
        self,
        api_key: str,
        *,
        model: str = "nova-2",
        language: str = "es",
        sample_rate: int = 16_000,
        encoding: str = "linear16",
        interim_results: bool = True,
        max_speakers: int = 8,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._language = language
        self._sample_rate = sample_rate
        self._encoding = encoding
        self._interim_results = interim_results
        self._max_speakers = max_speakers

        # Per-speaker streams
        self._streams: Dict[str, _SpeakerStream] = {}

        # Callbacks
        self._partial_handler: Callable[[str, float], None] | None = None
        self._final_handler: Callable[[str, str | None, float], None] | None = None

        # Fallback speaker for audio without speaker_id
        self._default_speaker = "__default__"

    # ── ISTTProvider interface ────────────────────────────────────────────

    def feed_audio(
        self, audio: np.ndarray, speaker_id: Optional[str] = None
    ) -> None:
        """Push audio to the per-speaker WebSocket stream."""
        spk = speaker_id or self._default_speaker
        stream = self._streams.get(spk)
        if stream is None:
            logger.debug(
                "No stream for speaker %s yet — creating on next start cycle",
                spk,
            )
            return
        stream.send(audio)

    def on_partial(self, handler: Callable[[str, float], None]) -> None:
        """Register callback for interim/partial transcripts."""
        self._partial_handler = handler

    def on_final(
        self, handler: Callable[[str, Optional[str], float], None]
    ) -> None:
        """Register callback for final transcripts."""
        self._final_handler = handler

    async def start(self) -> None:
        """Open a default speaker stream (others created on demand)."""
        await self._ensure_stream(self._default_speaker)

    async def stop(self) -> None:
        """Close all speaker streams."""
        for stream in list(self._streams.values()):
            await stream.close()
        self._streams.clear()

    # ── Speaker stream management ─────────────────────────────────────────

    async def _ensure_stream(self, speaker_id: str) -> _SpeakerStream:
        """Get or create a WebSocket stream for ``speaker_id``."""
        if speaker_id in self._streams and self._streams[speaker_id].is_active:
            return self._streams[speaker_id]

        # Evict oldest stream if at capacity
        if len(self._streams) >= self._max_speakers:
            oldest_key = next(iter(self._streams))
            logger.info("Evicting stream for speaker %s (at capacity)", oldest_key)
            await self._streams[oldest_key].close()
            del self._streams[oldest_key]

        stream = _SpeakerStream(
            speaker_id=speaker_id,
            api_key=self._api_key,
            model=self._model,
            language=self._language,
            sample_rate=self._sample_rate,
            encoding=self._encoding,
            interim_results=self._interim_results,
            on_partial=self._partial_handler,
            on_final=self._final_handler,
        )
        await stream.open()
        self._streams[speaker_id] = stream
        return stream

    async def add_speaker(self, speaker_id: str) -> None:
        """Explicitly open a stream for a new speaker."""
        await self._ensure_stream(speaker_id)

    async def remove_speaker(self, speaker_id: str) -> None:
        """Close and remove the stream for a speaker that left."""
        stream = self._streams.pop(speaker_id, None)
        if stream is not None:
            await stream.close()

    async def reconnect_speaker(self, speaker_id: str) -> bool:
        """Reconnect a specific speaker's stream after an error."""
        stream = self._streams.get(speaker_id)
        if stream is None:
            return False
        return await stream.reconnect()

    @property
    def active_speakers(self) -> list[str]:
        """Return list of speaker IDs with active streams."""
        return [
            spk
            for spk, s in self._streams.items()
            if s.is_active and spk != self._default_speaker
        ]

    @property
    def stream_count(self) -> int:
        """Total number of active streams (including default)."""
        return len(self._streams)
