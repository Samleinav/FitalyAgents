"""Integration tests for FitalyVoicePipeline — all heavy deps mocked."""
from __future__ import annotations

import asyncio
import json
import sys
from io import StringIO
from typing import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, patch

import numpy as np
import pytest

from conftest import make_noise, make_random_embedding, make_silence, SAMPLE_RATE
from fitaly_voice.bus_adapter import StdoutBusAdapter
from fitaly_voice.config import PipelineConfig
from fitaly_voice.diarizer import DiarizationSegment
from fitaly_voice.pipeline import FitalyVoicePipeline
from fitaly_voice.speaker_cache import KnownSpeaker
from fitaly_voice.tracker import SpeakerTracker


# ── Helpers ───────────────────────────────────────────────────────────────────

def _config(bus_mode="stdout") -> PipelineConfig:
    cfg = PipelineConfig()
    cfg.bus_mode = bus_mode
    cfg.diarizer_device = "cpu"
    return cfg


def _init_pipeline_extras(pipeline, cache=None):
    """Set attributes that __new__ skips (tracker, STT, counters)."""
    if cache is not None:
        pipeline._tracker = MagicMock()
        pipeline._tracker.resolve.side_effect = lambda label, emb, sid: (
            cache.identify.return_value.speaker_id
            if cache.identify(emb) is not None
            else f"trk:0:{label}"
        )
        pipeline._tracker.forget_inactive = MagicMock()
    pipeline._stt = None
    pipeline._stt_is_streaming = False
    pipeline._chunk_count = 0
    pipeline._speech_buffers = {}


def _make_source(*chunks: np.ndarray):
    """Create a mock AudioSource that yields the given chunks."""
    class _Source:
        async def chunks(self) -> AsyncGenerator[np.ndarray, None]:
            for c in chunks:
                yield c
    return _Source()


def _patch_vad(is_speech_fn):
    """Patch TenVAD so it doesn't load the TEN VAD model."""
    mock_vad = MagicMock()
    mock_vad.is_speech.side_effect = is_speech_fn
    return mock_vad


def _patch_diarizer(segments_per_chunk: list[list[DiarizationSegment]]):
    """Patch SortFormerDiarizer to return predetermined segments."""
    mock = MagicMock()
    call_iter = iter(segments_per_chunk)

    def _process_chunk(audio, session_id, sample_rate=16000):
        try:
            return next(call_iter)
        except StopIteration:
            return []

    mock.process_chunk.side_effect = _process_chunk
    mock.reset_session = MagicMock()
    return mock


def _patch_cache(embedding, known_speaker=None):
    """Patch AoscSpeakerCache to return a fixed embedding and optional known speaker."""
    mock = MagicMock()
    mock.get_embedding.return_value = embedding
    mock.identify.return_value = known_speaker
    mock.make_ephemeral_id.side_effect = lambda sid, label: f"unk:{sid}:{label}"
    return mock


def _patch_denoiser():
    mock = MagicMock()
    mock.denoise.side_effect = lambda audio, sr: audio  # passthrough
    return mock


# ── Tests ─────────────────────────────────────────────────────────────────────

class TestProcessSession:
    @pytest.mark.asyncio
    async def test_speaker_detected_published_for_new_speaker(self, capsys):
        cfg = _config()
        pipeline = FitalyVoicePipeline.__new__(FitalyVoicePipeline)
        pipeline.config = cfg
        pipeline._shutdown = False
        pipeline._bus = StdoutBusAdapter()
        pipeline._denoiser = _patch_denoiser()
        pipeline._vad = _patch_vad(lambda chunk: True)  # always speech
        pipeline._diarizer = _patch_diarizer([
            [DiarizationSegment("speaker_0", 0.0, 0.5)],  # chunk 1
            [],  # chunk 2 — no segments → speaker lost
        ])
        emb = make_random_embedding(seed=1)
        pipeline._cache = _patch_cache(emb, known_speaker=None)
        _init_pipeline_extras(pipeline, cache=pipeline._cache)

        noise1 = make_noise(100, amplitude=0.3)
        noise2 = make_noise(100, amplitude=0.3)
        source = _make_source(noise1, noise2)

        await pipeline.process_session("s-001", source)

        captured = capsys.readouterr().out
        events = [json.loads(line) for line in captured.strip().splitlines() if line]
        event_names = [e["event"] for e in events]

        assert "SPEAKER_DETECTED" in event_names

    @pytest.mark.asyncio
    async def test_known_speaker_id_used(self, capsys):
        cfg = _config()
        pipeline = FitalyVoicePipeline.__new__(FitalyVoicePipeline)
        pipeline.config = cfg
        pipeline._shutdown = False
        pipeline._bus = StdoutBusAdapter()
        pipeline._denoiser = _patch_denoiser()
        pipeline._vad = _patch_vad(lambda chunk: True)
        pipeline._diarizer = _patch_diarizer([
            [DiarizationSegment("speaker_0", 0.0, 0.5)],
        ])
        emb = make_random_embedding(seed=1)
        known = KnownSpeaker(
            speaker_id="emp:alice",
            name="Alice",
            role="employee",
            embedding=emb,
        )
        pipeline._cache = _patch_cache(emb, known_speaker=known)
        _init_pipeline_extras(pipeline, cache=pipeline._cache)

        source = _make_source(make_noise(100, amplitude=0.3))
        await pipeline.process_session("s-001", source)

        captured = capsys.readouterr().out
        events = [json.loads(line) for line in captured.strip().splitlines() if line]
        detected = [e for e in events if e["event"] == "SPEAKER_DETECTED"]
        assert len(detected) == 1
        assert detected[0]["speaker_id"] == "emp:alice"

    @pytest.mark.asyncio
    async def test_speaker_lost_published_when_speaker_disappears(self, capsys):
        cfg = _config()
        pipeline = FitalyVoicePipeline.__new__(FitalyVoicePipeline)
        pipeline.config = cfg
        pipeline._shutdown = False
        pipeline._bus = StdoutBusAdapter()
        pipeline._denoiser = _patch_denoiser()

        call_count = [0]
        def vad_fn(chunk):
            call_count[0] += 1
            return call_count[0] <= 1  # speech on first chunk, silence after

        pipeline._vad = _patch_vad(vad_fn)
        pipeline._diarizer = _patch_diarizer([
            [DiarizationSegment("speaker_0", 0.0, 0.5)],
        ])
        emb = make_random_embedding(seed=1)
        pipeline._cache = _patch_cache(emb, known_speaker=None)
        _init_pipeline_extras(pipeline, cache=pipeline._cache)

        source = _make_source(
            make_noise(100, amplitude=0.3),  # speech
            make_silence(100),              # silence → SPEAKER_LOST
        )
        await pipeline.process_session("s-001", source)

        captured = capsys.readouterr().out
        events = [json.loads(line) for line in captured.strip().splitlines() if line]
        event_names = [e["event"] for e in events]

        assert "SPEAKER_DETECTED" in event_names
        assert "SPEAKER_LOST" in event_names

    @pytest.mark.asyncio
    async def test_silent_source_yields_no_events(self, capsys):
        cfg = _config()
        pipeline = FitalyVoicePipeline.__new__(FitalyVoicePipeline)
        pipeline.config = cfg
        pipeline._shutdown = False
        pipeline._bus = StdoutBusAdapter()
        pipeline._denoiser = _patch_denoiser()
        pipeline._vad = _patch_vad(lambda chunk: False)  # always silent
        pipeline._diarizer = _patch_diarizer([])
        pipeline._cache = _patch_cache(make_random_embedding())
        _init_pipeline_extras(pipeline, cache=pipeline._cache)

        source = _make_source(*[make_silence(100) for _ in range(5)])
        await pipeline.process_session("s-001", source)

        captured = capsys.readouterr().out
        events = [json.loads(line) for line in captured.strip().splitlines() if line]
        # No SPEAKER_DETECTED — only SPEAKER_LOST is possible if there were active speakers
        detected = [e for e in events if e["event"] == "SPEAKER_DETECTED"]
        assert detected == []

    @pytest.mark.asyncio
    async def test_shutdown_stops_processing(self, capsys):
        cfg = _config()
        pipeline = FitalyVoicePipeline.__new__(FitalyVoicePipeline)
        pipeline.config = cfg
        pipeline._shutdown = True  # already shut down
        pipeline._bus = StdoutBusAdapter()
        pipeline._denoiser = _patch_denoiser()
        pipeline._vad = _patch_vad(lambda chunk: True)
        pipeline._diarizer = _patch_diarizer([
            [DiarizationSegment("speaker_0", 0.0, 0.5)],
        ])
        pipeline._cache = _patch_cache(make_random_embedding())
        _init_pipeline_extras(pipeline, cache=pipeline._cache)

        source = _make_source(*[make_noise(100, amplitude=0.3) for _ in range(5)])
        await pipeline.process_session("s-001", source)

        captured = capsys.readouterr().out
        # No events should be published when shutdown=True
        events = [json.loads(line) for line in captured.strip().splitlines() if line]
        assert events == []


class TestStdoutBusAdapter:
    @pytest.mark.asyncio
    async def test_publish_speaker_detected(self, capsys):
        bus = StdoutBusAdapter()
        await bus.publish_speaker_detected("s-001", "emp:alice", "store-001")
        captured = json.loads(capsys.readouterr().out.strip())
        assert captured["event"] == "SPEAKER_DETECTED"
        assert captured["session_id"] == "s-001"
        assert captured["speaker_id"] == "emp:alice"
        assert captured["store_id"] == "store-001"
        assert captured["channel"] == "bus:SPEAKER_DETECTED"

    @pytest.mark.asyncio
    async def test_publish_speaker_lost(self, capsys):
        bus = StdoutBusAdapter()
        await bus.publish_speaker_lost("s-001", "emp:alice")
        captured = json.loads(capsys.readouterr().out.strip())
        assert captured["event"] == "SPEAKER_LOST"
        assert captured["speaker_id"] == "emp:alice"

    @pytest.mark.asyncio
    async def test_publish_speech_partial_with_speaker(self, capsys):
        bus = StdoutBusAdapter()
        await bus.publish_speech_partial("s-001", "hello world", "emp:alice", 0.95)
        captured = json.loads(capsys.readouterr().out.strip())
        assert captured["event"] == "SPEECH_PARTIAL"
        assert captured["text"] == "hello world"
        assert captured["speaker_id"] == "emp:alice"
        assert captured["confidence"] == 0.95

    @pytest.mark.asyncio
    async def test_publish_ambient_context(self, capsys):
        bus = StdoutBusAdapter()
        await bus.publish_ambient_context("s-001", "conversacion ambiente", "unk:s-001:speaker_1")
        captured = json.loads(capsys.readouterr().out.strip())
        assert captured["event"] == "AMBIENT_CONTEXT"
        assert captured["text"] == "conversacion ambiente"
