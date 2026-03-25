"""Whisper STT wrapper using faster-whisper (CPU-friendly, no GPU required).

faster-whisper uses CTranslate2 for efficient CPU inference.
Tiny model (~39MB) works at ~1-3× real-time on modern CPUs.

Install:
    pip install faster-whisper

Usage:
    stt = WhisperSTT(model_size="tiny")
    text = stt.transcribe(audio_float32, sample_rate=16000)
"""
from __future__ import annotations

import numpy as np


class WhisperSTT:
    """
    Offline STT using faster-whisper.

    Parameters
    ----------
    model_size : str
        One of "tiny" (~39MB), "base" (~74MB), "small" (~244MB).
        "tiny" is recommended for CPU demo; "small" for better accuracy.
    device : str
        "cpu" (default) or "cuda" (if CUDA available).
    compute_type : str
        "int8" for CPU (fastest), "float16" for GPU.
    language : str | None
        Force a language code ("es", "en", etc.) or None for auto-detect.
    """

    def __init__(
        self,
        model_size: str = "tiny",
        device: str = "cpu",
        compute_type: str = "int8",
        language: str | None = None,
    ) -> None:
        self.model_size = model_size
        self.device = device
        self.compute_type = compute_type
        self.language = language
        self._model = self._load()

    def _load(self):
        from faster_whisper import WhisperModel  # type: ignore[import]

        return WhisperModel(
            self.model_size,
            device=self.device,
            compute_type=self.compute_type,
        )

    def transcribe(self, audio: np.ndarray, sample_rate: int = 16000) -> str:
        """
        Transcribe a float32 audio array to text.

        Parameters
        ----------
        audio : np.ndarray
            Float32 mono audio, values in [-1, 1], at ``sample_rate`` Hz.
        sample_rate : int
            Sample rate of the audio (resampled to 16 kHz internally if needed).

        Returns
        -------
        str
            Transcribed text (empty string if no speech detected).
        """
        # faster-whisper expects float32 at 16kHz
        if sample_rate != 16000:
            audio = _resample(audio, sample_rate, 16000)

        audio = audio.astype(np.float32)

        segments, _info = self._model.transcribe(
            audio,
            language=self.language,
            beam_size=1,           # fastest for demo
            vad_filter=False,      # VAD already done upstream
            word_timestamps=False,
        )
        return " ".join(seg.text.strip() for seg in segments).strip()


# ── helpers ───────────────────────────────────────────────────────────────────

def _resample(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Simple linear resampling (good enough for STT preprocessing)."""
    from scipy.signal import resample_poly  # type: ignore[import]
    from math import gcd

    g = gcd(src_rate, dst_rate)
    return resample_poly(audio, dst_rate // g, src_rate // g).astype(np.float32)
