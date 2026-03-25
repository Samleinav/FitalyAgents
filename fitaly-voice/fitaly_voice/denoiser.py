from __future__ import annotations

from typing import Literal

import numpy as np


class AudioDenoiser:
    """
    Audio denoiser with two backends:

    - ``rnnoise``: Real-time RNNoise (preferred). Processes 10ms frames of
      16-bit int16 PCM at 48kHz internally.  Very low latency (~1ms/frame).
    - ``spectral``: noisereduce spectral gating (fallback). Works at any
      sample rate but is not real-time capable for large buffers.

    Auto-selects ``spectral`` if rnnoise is not installed.
    """

    def __init__(self, backend: Literal["rnnoise", "spectral"] = "rnnoise") -> None:
        self.backend = self._resolve_backend(backend)

    @staticmethod
    def _resolve_backend(requested: str) -> str:
        if requested == "rnnoise":
            try:
                import rnnoise  # noqa: F401

                return "rnnoise"
            except ImportError:
                return "spectral"
        return "spectral"

    def denoise(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        """
        Denoise *audio* (float32, values in [-1, 1]) sampled at *sample_rate*.
        Returns denoised float32 array of the same length.
        """
        if self.backend == "rnnoise":
            return self._denoise_rnnoise(audio, sample_rate)
        return self._denoise_spectral(audio, sample_rate)

    def _denoise_rnnoise(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        import rnnoise
        from scipy.signal import resample_poly

        # RNNoise requires 48 kHz int16 input, 10 ms frames (480 samples)
        RNNOISE_SR = 48000
        FRAME = 480

        # Resample to 48 kHz if needed
        if sample_rate != RNNOISE_SR:
            from math import gcd

            g = gcd(RNNOISE_SR, sample_rate)
            audio_48k = resample_poly(audio, RNNOISE_SR // g, sample_rate // g).astype(
                np.float32
            )
        else:
            audio_48k = audio.astype(np.float32)

        # Convert to int16 for rnnoise
        pcm = (audio_48k * 32768).clip(-32768, 32767).astype(np.int16)

        # Process frame by frame
        denoised_pcm = np.zeros_like(pcm)
        dn = rnnoise.RNNoise()
        for i in range(0, len(pcm), FRAME):
            frame = pcm[i : i + FRAME]
            if len(frame) < FRAME:
                frame = np.pad(frame, (0, FRAME - len(frame)))
            out = dn.process_frame(frame)
            end = min(i + FRAME, len(denoised_pcm))
            denoised_pcm[i:end] = out[: end - i]

        # Back to float32
        denoised_48k = denoised_pcm.astype(np.float32) / 32768.0

        # Resample back to original sample_rate if needed
        if sample_rate != RNNOISE_SR:
            from math import gcd

            g = gcd(RNNOISE_SR, sample_rate)
            denoised = resample_poly(denoised_48k, sample_rate // g, RNNOISE_SR // g).astype(
                np.float32
            )
            # Trim/pad to match original length
            if len(denoised) > len(audio):
                denoised = denoised[: len(audio)]
            elif len(denoised) < len(audio):
                denoised = np.pad(denoised, (0, len(audio) - len(denoised)))
        else:
            denoised = denoised_48k

        return denoised

    def _denoise_spectral(self, audio: np.ndarray, sample_rate: int) -> np.ndarray:
        import noisereduce as nr

        return nr.reduce_noise(y=audio, sr=sample_rate).astype(np.float32)
