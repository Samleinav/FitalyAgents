from __future__ import annotations

import asyncio
import wave
from typing import AsyncGenerator, Optional, Protocol, runtime_checkable

import numpy as np

from .bus_adapter import IBusAdapter, RedisBusAdapter, StdoutBusAdapter
from .config import PipelineConfig
from .denoiser import AudioDenoiser
from .diarizer import DiarizationSegment, SortFormerDiarizer
from .speaker_cache import AoscSpeakerCache
from .tracker import SpeakerTracker
from .vad import TenVAD

# STT is optional — imported lazily to avoid requiring faster-whisper / deepgram-sdk
_WhisperSTT = None


# ── AudioSource protocol ──────────────────────────────────────────────────────

@runtime_checkable
class AudioSource(Protocol):
    async def chunks(self) -> AsyncGenerator[np.ndarray, None]: ...


class FileSource:
    """Read audio from a WAV file, yielding fixed-size float32 chunks."""

    def __init__(
        self,
        path: str,
        chunk_ms: int = 100,
    ) -> None:
        self.path = path
        self.chunk_ms = chunk_ms

    async def chunks(self) -> AsyncGenerator[np.ndarray, None]:
        with wave.open(self.path, "rb") as wf:
            sample_rate = wf.getframerate()
            chunk_frames = int(sample_rate * self.chunk_ms / 1000)
            while True:
                raw = wf.readframes(chunk_frames)
                if not raw:
                    break
                # Convert PCM int16 to float32 [-1, 1]
                pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                yield pcm
                await asyncio.sleep(0)  # yield control


class MicrophoneSource:
    """Stream audio from the default microphone using sounddevice."""

    def __init__(
        self,
        sample_rate: int = 16000,
        chunk_ms: int = 100,
        device: Optional[int] = None,
    ) -> None:
        self.sample_rate = sample_rate
        self.chunk_ms = chunk_ms
        self.device = device

    async def chunks(self) -> AsyncGenerator[np.ndarray, None]:
        import sounddevice as sd

        chunk_frames = int(self.sample_rate * self.chunk_ms / 1000)
        loop = asyncio.get_event_loop()
        queue: asyncio.Queue[np.ndarray] = asyncio.Queue()

        def callback(indata, frames, time_info, status):
            loop.call_soon_threadsafe(queue.put_nowait, indata[:, 0].copy().astype(np.float32))

        with sd.InputStream(
            samplerate=self.sample_rate,
            channels=1,
            dtype="float32",
            blocksize=chunk_frames,
            device=self.device,
            callback=callback,
        ):
            while True:
                chunk = await queue.get()
                yield chunk


class UDPSource:
    """
    Receive raw PCM audio from a host-side audio bridge via UDP.

    The companion ``audio_bridge.py`` script captures the microphone on the
    Windows/macOS host and streams 16kHz mono int16 frames to this port.
    This lets the full NeMo pipeline run inside Docker while microphone
    capture happens on the host (where audio hardware is accessible).

    Wire-format: raw little-endian int16 PCM at ``sample_rate`` Hz, mono.
    Each datagram is exactly ``chunk_frames * 2`` bytes.

    Usage:
        # In Docker container:
        source = UDPSource(port=5005, sample_rate=16000, chunk_ms=100)

        # On host (Windows/macOS):
        python audio_bridge.py --host localhost --port 5005
    """

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 5005,
        sample_rate: int = 16000,
        chunk_ms: int = 100,
    ) -> None:
        self.host = host
        self.port = port
        self.sample_rate = sample_rate
        self.chunk_ms = chunk_ms

    async def chunks(self) -> AsyncGenerator[np.ndarray, None]:
        loop = asyncio.get_event_loop()
        chunk_frames = int(self.sample_rate * self.chunk_ms / 1000)
        expected_bytes = chunk_frames * 2  # int16 = 2 bytes per sample

        # Open UDP socket and register with asyncio
        import socket as _socket
        sock = _socket.socket(_socket.AF_INET, _socket.SOCK_DGRAM)
        sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
        sock.bind((self.host, self.port))
        sock.setblocking(False)

        print(f"[UDPSource] Listening on UDP {self.host}:{self.port} "
              f"— waiting for audio_bridge.py", flush=True)

        buf = bytearray()
        try:
            while True:
                data = await loop.sock_recv(sock, 65536)
                buf.extend(data)
                # Yield complete chunks
                while len(buf) >= expected_bytes:
                    frame_bytes = bytes(buf[:expected_bytes])
                    del buf[:expected_bytes]
                    pcm = np.frombuffer(frame_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                    yield pcm
        finally:
            sock.close()


# ── FitalyVoicePipeline ───────────────────────────────────────────────────────

class FitalyVoicePipeline:
    """
    Orchestrates the full audio processing pipeline:

    AudioSource → VAD → Denoiser → SortFormer → SpeakerTracker → Bus events

    Supports multiple concurrent sessions via asyncio.TaskGroup.
    For multiple audio sources (multiple mics), instantiate one pipeline
    per source in separate processes.
    """

    def __init__(self, config: PipelineConfig) -> None:
        self.config = config
        self._vad = TenVAD(
            threshold=config.vad_threshold,
            min_speech_ms=config.vad_min_speech_ms,
            max_silence_ms=config.vad_max_silence_ms,
            sample_rate=config.sample_rate,
        )
        self._denoiser = AudioDenoiser(backend=config.denoiser_backend)
        self._diarizer = SortFormerDiarizer(
            model_name=config.diarizer_model,
            device=config.diarizer_device,
            chunk_duration_s=config.diarizer_chunk_s,
            backend=config.diarizer_backend,  # type: ignore[arg-type]
            onnx_path=config.diarizer_onnx_path,
        )
        self._cache = AoscSpeakerCache(
            embedder_model=config.embedder_model,
            threshold=config.aosc_threshold,
            cache_path=config.aosc_cache_path,
            backend=config.embedder_backend,  # type: ignore[arg-type]
            onnx_path=config.embedder_onnx_path,
            device=config.diarizer_device,
        )
        self._tracker = SpeakerTracker(
            cache=self._cache,
            similarity_threshold=config.tracker_similarity_threshold,
            ema_alpha=config.tracker_ema_alpha,
            max_inactive_s=config.tracker_max_inactive_s,
            max_tracked=config.tracker_max_speakers,
        )
        self._bus: IBusAdapter = self._make_adapter()
        self._shutdown = False
        self._chunk_count = 0
        # STT — loaded lazily on first use
        self._stt = self._make_stt() if config.stt_enabled else None
        self._stt_is_streaming = config.stt_provider == "deepgram"
        # Per-speaker speech accumulation buffer for batch STT (Whisper)
        self._speech_buffers: dict[str, list[np.ndarray]] = {}

    def _make_stt(self):
        if self.config.stt_provider == "deepgram":
            from .deepgram_stt import DeepgramSTT
            return DeepgramSTT(
                api_key=self.config.deepgram_api_key,
                model=self.config.deepgram_model,
                language=self.config.stt_language or "es",
                sample_rate=self.config.sample_rate,
                encoding=self.config.deepgram_encoding,
                interim_results=self.config.deepgram_interim_results,
                max_speakers=self.config.deepgram_max_speakers,
            )
        # Default: Whisper (offline batch)
        from .stt import WhisperSTT
        return WhisperSTT(
            model_size=self.config.stt_model,
            device=self.config.stt_device,
            language=self.config.stt_language,
        )

    def _make_adapter(self) -> IBusAdapter:
        if self.config.bus_mode == "redis":
            return RedisBusAdapter(self.config.redis_url)
        return StdoutBusAdapter()

    # ── Public API ────────────────────────────────────────────────────────────

    async def run(
        self,
        audio_source: AudioSource,
        session_id: str,
    ) -> None:
        """Run the pipeline for a single session until source is exhausted or shutdown."""
        # Start streaming STT if configured
        if self._stt is not None and self._stt_is_streaming:
            # Wire Deepgram callbacks to bus adapter
            self._stt.on_partial(
                lambda text, conf: None  # partials logged but not published
            )
            bus = self._bus
            sid = session_id

            def _on_final(text: str, speaker_id: str | None, confidence: float):
                import asyncio as _aio
                try:
                    loop = _aio.get_running_loop()
                    loop.create_task(
                        bus.publish_speech_final(
                            sid, text, confidence=confidence, speaker_id=speaker_id
                        )
                    )
                except RuntimeError:
                    pass  # no running loop — ignore (e.g. during shutdown)

            self._stt.on_final(_on_final)
            await self._stt.start()

        try:
            await self.process_session(session_id, audio_source)
        finally:
            # Stop streaming STT
            if self._stt is not None and self._stt_is_streaming:
                await self._stt.stop()
            self._diarizer.reset_session(session_id)

    async def run_multi(
        self,
        sessions: dict[str, AudioSource],
    ) -> None:
        """Run multiple sessions concurrently (asyncio.TaskGroup)."""
        async with asyncio.TaskGroup() as tg:
            for session_id, source in sessions.items():
                tg.create_task(self.run(source, session_id))

    async def shutdown(self) -> None:
        self._shutdown = True
        if self._stt is not None and self._stt_is_streaming:
            await self._stt.stop()
        await self._bus.disconnect()

    # ── Core processing ───────────────────────────────────────────────────────

    async def process_session(
        self,
        session_id: str,
        audio_source: AudioSource,
    ) -> None:
        """
        Process all chunks from *audio_source* for *session_id*.

        Tracks which speakers are active and publishes:
        - SPEAKER_DETECTED when a new speaker is first seen
        - SPEAKER_LOST when a speaker disappears for a full chunk cycle
        """
        active_speakers: set[str] = set()

        async for raw_chunk in audio_source.chunks():
            if self._shutdown:
                break

            # 1. Denoise
            chunk = self._denoiser.denoise(raw_chunk, self.config.sample_rate)

            # 2. VAD — skip silent/distant frames
            if not self._vad.is_speech(chunk):
                # If we had active speakers and now it's silent, mark them lost
                for spk_id in list(active_speakers):
                    await self._bus.publish_speaker_lost(session_id, spk_id)
                    # Flush batch STT buffer on speaker lost
                    if not self._stt_is_streaming:
                        await self._flush_speech(session_id, spk_id)
                    active_speakers.discard(spk_id)
                continue

            # 3. Diarize
            segments = self._diarizer.process_chunk(
                chunk, session_id, self.config.sample_rate
            )

            # 4. Resolve speaker identity via SpeakerTracker
            current_speakers: set[str] = set()
            for seg in segments:
                seg_audio = self._extract_segment(chunk, seg)
                embedding = self._cache.get_embedding(seg_audio, self.config.sample_rate)
                speaker_id = self._tracker.resolve(seg.speaker_label, embedding, session_id)
                current_speakers.add(speaker_id)

            # Publish SPEAKER_DETECTED for newly active speakers
            for spk_id in current_speakers - active_speakers:
                await self._bus.publish_speaker_detected(
                    session_id, spk_id, self.config.store_id
                )
                if not self._stt_is_streaming:
                    self._speech_buffers[spk_id] = []
                # Open a Deepgram stream for the new speaker
                if self._stt_is_streaming and self._stt is not None:
                    await self._stt.add_speaker(spk_id)

            # Publish SPEAKER_LOST — flush speech buffer → STT (batch)
            for spk_id in active_speakers - current_speakers:
                await self._bus.publish_speaker_lost(session_id, spk_id)
                if self._stt_is_streaming and self._stt is not None:
                    await self._stt.remove_speaker(spk_id)
                else:
                    await self._flush_speech(session_id, spk_id)

            # Feed audio to STT
            if self._stt is not None:
                if self._stt_is_streaming:
                    # Streaming: feed each chunk to per-speaker stream
                    for spk_id in current_speakers:
                        self._stt.feed_audio(chunk.copy(), speaker_id=spk_id)
                else:
                    # Batch: accumulate for later transcription
                    for spk_id in current_speakers:
                        self._speech_buffers.setdefault(spk_id, []).append(chunk.copy())

            active_speakers = current_speakers

            # Periodic garbage collection of inactive tracked speakers
            self._chunk_count += 1
            if self._chunk_count % self.config.forget_every_n_chunks == 0:
                self._tracker.forget_inactive()

    async def _flush_speech(self, session_id: str, speaker_id: str) -> None:
        """Transcribe accumulated speech buffer (batch/Whisper) and publish."""
        if self._stt is None or self._stt_is_streaming:
            return
        buf = self._speech_buffers.pop(speaker_id, [])
        if not buf:
            return
        audio = np.concatenate(buf)
        # Run STT in thread pool to avoid blocking the event loop
        loop = asyncio.get_event_loop()
        text = await loop.run_in_executor(
            None, self._stt.transcribe, audio, self.config.sample_rate
        )
        if text:
            await self._bus.publish_speech_final(
                session_id, text, confidence=1.0, speaker_id=speaker_id
            )

    def _extract_segment(self, chunk: np.ndarray, seg: DiarizationSegment) -> np.ndarray:
        """Slice the audio chunk to the segment's time range."""
        start = int(seg.start * self.config.sample_rate)
        end = int(seg.end * self.config.sample_rate)
        seg_audio = chunk[start:end]
        return seg_audio if len(seg_audio) > 0 else chunk
