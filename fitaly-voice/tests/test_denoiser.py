"""Tests for AudioDenoiser."""
from __future__ import annotations

import sys
from unittest.mock import MagicMock, patch

import numpy as np
import pytest

from conftest import make_noise, SAMPLE_RATE
from fitaly_voice.denoiser import AudioDenoiser


def _snr(clean: np.ndarray, noisy: np.ndarray) -> float:
    """Signal-to-noise ratio improvement proxy: ratio of signal power."""
    signal_power = float(np.mean(clean ** 2))
    noise_power = float(np.mean((noisy - clean) ** 2)) + 1e-10
    return signal_power / noise_power


class TestAudioDenoiser:
    def test_spectral_backend_resolves_when_rnnoise_unavailable(self):
        with patch.dict(sys.modules, {"rnnoise": None}):
            dn = AudioDenoiser(backend="rnnoise")
        assert dn.backend == "spectral"

    def test_spectral_backend_explicit(self):
        dn = AudioDenoiser(backend="spectral")
        assert dn.backend == "spectral"

    def test_spectral_denoise_returns_same_length(self):
        rng = np.random.default_rng(1)
        clean = np.sin(2 * np.pi * 440 * np.linspace(0, 1, SAMPLE_RATE)).astype(np.float32)
        noise = (rng.standard_normal(SAMPLE_RATE) * 0.1).astype(np.float32)
        noisy = clean + noise

        dn = AudioDenoiser(backend="spectral")
        denoised = dn.denoise(noisy, SAMPLE_RATE)
        assert denoised.shape == noisy.shape
        assert denoised.dtype == np.float32

    def test_spectral_reduces_noise_power(self):
        rng = np.random.default_rng(2)
        clean = np.sin(2 * np.pi * 440 * np.linspace(0, 1, SAMPLE_RATE)).astype(np.float32)
        noise = (rng.standard_normal(SAMPLE_RATE) * 0.4).astype(np.float32)
        noisy = clean + noise

        dn = AudioDenoiser(backend="spectral")
        denoised = dn.denoise(noisy, SAMPLE_RATE)

        # Residual noise should be lower after denoising
        residual_before = float(np.mean(noise ** 2))
        residual_after = float(np.mean((denoised - clean) ** 2))
        assert residual_after < residual_before

    def test_rnnoise_backend_with_mock(self):
        mock_rnnoise = MagicMock()
        mock_rnnoise_instance = MagicMock()
        mock_rnnoise_instance.process_frame.side_effect = lambda x: x  # passthrough
        mock_rnnoise.RNNoise.return_value = mock_rnnoise_instance

        with patch.dict(sys.modules, {"rnnoise": mock_rnnoise}):
            dn = AudioDenoiser(backend="rnnoise")
            assert dn.backend == "rnnoise"

            audio = make_noise(200, amplitude=0.3, sample_rate=SAMPLE_RATE)
            result = dn.denoise(audio, SAMPLE_RATE)
            assert result.shape == audio.shape
            assert result.dtype == np.float32
