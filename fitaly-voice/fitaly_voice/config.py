from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Literal


@dataclass
class PipelineConfig:
    # Bus
    redis_url: str = "redis://localhost:6379"
    store_id: str = "store-001"
    bus_mode: Literal["redis", "stdout"] = "redis"

    # VAD
    vad_threshold: float = 0.5
    vad_min_speech_ms: int = 300
    vad_max_silence_ms: int = 500

    # Denoiser
    denoiser_backend: Literal["rnnoise", "spectral"] = "rnnoise"

    # Diarizer
    diarizer_model: str = "diar_streaming_sortformer_4spk-v2.1"
    diarizer_device: str = "cuda"
    diarizer_chunk_s: float = 1.0
    # "stub" = no model (demo/CI); "nemo" = full NeMo; "onnx" = onnxruntime-gpu
    diarizer_backend: Literal["nemo", "onnx", "stub"] = "nemo"
    diarizer_onnx_path: str | None = None

    # STT (speech-to-text)
    stt_enabled: bool = False
    stt_provider: Literal["whisper", "deepgram"] = "whisper"
    stt_language: str | None = None  # None = auto-detect

    # Whisper (offline fallback — dev/CI only, NOT for production)
    stt_model: str = "tiny"   # tiny|base|small
    stt_device: str = "cpu"

    # Deepgram (production streaming STT)
    deepgram_api_key: str = ""
    deepgram_model: str = "nova-2"
    deepgram_encoding: str = "linear16"
    deepgram_interim_results: bool = True
    deepgram_max_speakers: int = 8

    # AOSC Speaker Cache
    embedder_model: str = "titanet_large"
    aosc_threshold: float = 0.75
    aosc_cache_path: str | None = None
    embedder_backend: Literal["nemo", "onnx"] = "nemo"
    embedder_onnx_path: str | None = None

    # SpeakerTracker
    tracker_similarity_threshold: float = 0.72
    tracker_ema_alpha: float = 0.3
    tracker_max_inactive_s: float = 300.0
    tracker_max_speakers: int = 32
    forget_every_n_chunks: int = 50

    # Audio
    sample_rate: int = 16000
    chunk_ms: int = 100  # milliseconds per audio chunk

    @classmethod
    def from_env(cls) -> "PipelineConfig":
        return cls(
            redis_url=os.getenv("REDIS_URL", "redis://localhost:6379"),
            store_id=os.getenv("STORE_ID", "store-001"),
            bus_mode=os.getenv("BUS_MODE", "redis"),  # type: ignore[arg-type]
            vad_threshold=float(os.getenv("VAD_THRESHOLD", "0.5")),
            vad_min_speech_ms=int(os.getenv("VAD_MIN_SPEECH_MS", "300")),
            vad_max_silence_ms=int(os.getenv("VAD_MAX_SILENCE_MS", "500")),
            denoiser_backend=os.getenv("DENOISER_BACKEND", "rnnoise"),  # type: ignore[arg-type]
            diarizer_model=os.getenv("DIARIZER_MODEL", "diar_streaming_sortformer_4spk-v2.1"),
            diarizer_device=os.getenv("DIARIZER_DEVICE", "cuda"),
            diarizer_chunk_s=float(os.getenv("DIARIZER_CHUNK_S", "1.0")),
            diarizer_backend=os.getenv("DIARIZER_BACKEND", "nemo"),  # type: ignore[arg-type]
            diarizer_onnx_path=os.getenv("DIARIZER_ONNX_PATH"),
            stt_enabled=os.getenv("STT_ENABLED", "false").lower() == "true",
            stt_provider=os.getenv("STT_PROVIDER", "whisper"),  # type: ignore[arg-type]
            stt_language=os.getenv("STT_LANGUAGE") or None,
            stt_model=os.getenv("STT_MODEL", "tiny"),
            stt_device=os.getenv("STT_DEVICE", "cpu"),
            deepgram_api_key=os.getenv("DEEPGRAM_API_KEY", ""),
            deepgram_model=os.getenv("DEEPGRAM_MODEL", "nova-2"),
            deepgram_encoding=os.getenv("DEEPGRAM_ENCODING", "linear16"),
            deepgram_interim_results=os.getenv("DEEPGRAM_INTERIM_RESULTS", "true").lower() == "true",
            deepgram_max_speakers=int(os.getenv("DEEPGRAM_MAX_SPEAKERS", "8")),
            embedder_model=os.getenv("EMBEDDER_MODEL", "titanet_large"),
            aosc_threshold=float(os.getenv("AOSC_THRESHOLD", "0.75")),
            aosc_cache_path=os.getenv("AOSC_CACHE_PATH"),
            embedder_backend=os.getenv("EMBEDDER_BACKEND", "nemo"),  # type: ignore[arg-type]
            embedder_onnx_path=os.getenv("EMBEDDER_ONNX_PATH"),
            tracker_similarity_threshold=float(os.getenv("TRACKER_SIM_THRESHOLD", "0.72")),
            tracker_ema_alpha=float(os.getenv("TRACKER_EMA_ALPHA", "0.3")),
            tracker_max_inactive_s=float(os.getenv("TRACKER_MAX_INACTIVE_S", "300.0")),
            tracker_max_speakers=int(os.getenv("TRACKER_MAX_SPEAKERS", "32")),
            forget_every_n_chunks=int(os.getenv("FORGET_EVERY_N_CHUNKS", "50")),
            sample_rate=int(os.getenv("SAMPLE_RATE", "16000")),
            chunk_ms=int(os.getenv("CHUNK_MS", "100")),
        )
