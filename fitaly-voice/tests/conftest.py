"""Shared fixtures for fitaly-voice tests."""
from __future__ import annotations

import numpy as np
import pytest


SAMPLE_RATE = 16000


def make_silence(duration_ms: int, sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Generate a silent (near-zero) audio chunk."""
    n = int(sample_rate * duration_ms / 1000)
    return np.zeros(n, dtype=np.float32)


def make_sine(freq: float, duration_ms: int, amplitude: float = 0.05,
              sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Generate a sine wave (not speech — pure tone)."""
    n = int(sample_rate * duration_ms / 1000)
    t = np.linspace(0, duration_ms / 1000, n, endpoint=False)
    return (amplitude * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def make_noise(duration_ms: int, amplitude: float = 0.3,
               sample_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Generate white noise (used as proxy for energetic speech in tests)."""
    n = int(sample_rate * duration_ms / 1000)
    rng = np.random.default_rng(42)
    return (amplitude * rng.standard_normal(n)).astype(np.float32)


def make_random_embedding(dim: int = 192, seed: int = 0) -> np.ndarray:
    """Generate a random L2-normalised embedding vector."""
    rng = np.random.default_rng(seed)
    v = rng.standard_normal(dim).astype(np.float32)
    return v / np.linalg.norm(v)


@pytest.fixture
def sample_rate() -> int:
    return SAMPLE_RATE


@pytest.fixture
def silence_chunk(sample_rate: int) -> np.ndarray:
    return make_silence(100, sample_rate)


@pytest.fixture
def noise_chunk(sample_rate: int) -> np.ndarray:
    return make_noise(100, sample_rate)
