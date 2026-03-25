"""Tests for TenVAD — mocks ten_vad.TenVad to avoid model download."""
from __future__ import annotations

import sys
from unittest.mock import MagicMock

import numpy as np
import pytest

from conftest import make_noise, make_silence, make_sine, SAMPLE_RATE
from fitaly_voice.vad import TenVAD, _to_int16

HOP = 256  # samples per frame at 16kHz


# ── Mock TEN VAD model ────────────────────────────────────────────────────────

class _MockTenVad:
    """Returns high probability for high-energy audio, low for silence."""

    def __init__(self, hop_size: int) -> None:
        self.hop_size = hop_size

    def is_speech(self, frame: np.ndarray) -> float:
        # RMS energy of int16 → probability
        rms = float(np.sqrt(np.mean(frame.astype(np.float32) ** 2)))
        return min(1.0, rms / 3000.0)  # 3000 ≈ quiet; 32767 = max int16


def _make_mock_module():
    mod = MagicMock()
    mod.TenVad.side_effect = _MockTenVad
    return mod


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def vad():
    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(sys.modules, "ten_vad", _make_mock_module())
        yield TenVAD(threshold=0.5, min_speech_ms=100, max_silence_ms=200,
                     sample_rate=SAMPLE_RATE, hop_size=HOP)


@pytest.fixture
def vad_strict():
    with pytest.MonkeyPatch.context() as mp:
        mp.setitem(sys.modules, "ten_vad", _make_mock_module())
        yield TenVAD(threshold=0.5, min_speech_ms=300, max_silence_ms=200,
                     sample_rate=SAMPLE_RATE, hop_size=HOP)


# ── _to_int16 helper ──────────────────────────────────────────────────────────

class TestToInt16:
    def test_float32_converts(self):
        audio = np.array([0.5, -0.5, 1.0, -1.0], dtype=np.float32)
        result = _to_int16(audio)
        assert result.dtype == np.int16
        assert result[0] > 0 and result[1] < 0

    def test_int16_passthrough(self):
        audio = np.array([1000, -1000], dtype=np.int16)
        result = _to_int16(audio)
        assert result is audio


# ── frame_probability ─────────────────────────────────────────────────────────

class TestFrameProbability:
    def test_silence_low_probability(self, vad):
        prob = vad.frame_probability(make_silence(16))
        assert prob < 0.5

    def test_loud_noise_high_probability(self, vad):
        prob = vad.frame_probability(make_noise(16, amplitude=0.9))
        assert prob >= 0.5

    def test_short_frame_padded(self, vad):
        prob = vad.frame_probability(make_silence(5))
        assert 0.0 <= prob <= 1.0

    def test_long_frame_truncated(self, vad):
        prob = vad.frame_probability(make_noise(50, amplitude=0.9))
        assert 0.0 <= prob <= 1.0


# ── is_speech ─────────────────────────────────────────────────────────────────

class TestIsSpeech:
    def test_silence_not_speech(self, vad):
        assert vad.is_speech(make_silence(100)) is False

    def test_loud_noise_is_speech(self, vad):
        assert vad.is_speech(make_noise(100, amplitude=0.9)) is True

    def test_quiet_sine_not_speech(self, vad):
        assert vad.is_speech(make_sine(440, 100, amplitude=0.02)) is False


# ── filter_chunks ─────────────────────────────────────────────────────────────

class TestFilterChunks:
    def test_pure_silence_yields_nothing(self, vad):
        result = list(vad.filter_chunks(iter([make_silence(100)] * 10)))
        assert result == []

    def test_sustained_speech_yields_chunks(self, vad):
        # 4 × 100ms = 400ms > min_speech_ms=100ms → yields
        chunks = [make_noise(100, amplitude=0.9)] * 4 + [make_silence(100)] * 5
        result = list(vad.filter_chunks(iter(chunks)))
        assert len(result) > 0

    def test_short_burst_suppressed(self, vad_strict):
        # min_speech_ms=300ms: 2 × 100ms = 200ms < 300ms → suppressed
        chunks = [make_noise(100, amplitude=0.9)] * 2 + [make_silence(100)] * 5
        result = list(vad_strict.filter_chunks(iter(chunks)))
        assert result == []

    def test_silence_closes_segment(self, vad):
        # Speech then 3 × 100ms silence (max_silence_ms=200ms → closes at 3rd)
        chunks = [make_noise(100, amplitude=0.9)] * 4 + [make_silence(100)] * 3
        result = list(vad.filter_chunks(iter(chunks)))
        assert len(result) > 0
        # Yielded chunks should be from speech portion (high energy)
        for chunk in result:
            assert float(np.sqrt(np.mean(chunk ** 2))) > 0.01
