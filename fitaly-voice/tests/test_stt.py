"""Tests for DeepgramSTT and ISTTProvider protocol compliance.

All tests use mocks — no Deepgram API key or network required.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import numpy as np
import pytest

from fitaly_voice.stt_base import ISTTProvider
from fitaly_voice.deepgram_stt import DeepgramSTT, _SpeakerStream


def _mock_open_side_effect(stream: _SpeakerStream):
    """Side-effect for mocked open() that marks the stream as started."""
    async def _open(self_or_none=None):
        stream._started = True
        stream._connection = MagicMock()
    return _open


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_audio(duration_ms: int = 100, sample_rate: int = 16_000) -> np.ndarray:
    """Generate a short noise chunk simulating speech."""
    n = int(sample_rate * duration_ms / 1000)
    rng = np.random.default_rng(42)
    return rng.standard_normal(n).astype(np.float32) * 0.3


def _make_transcript_result(text: str, confidence: float = 0.95, is_final: bool = True):
    """Create a mock Deepgram transcript result object."""
    alt = MagicMock()
    alt.transcript = text
    alt.confidence = confidence

    channel = MagicMock()
    channel.alternatives = [alt]

    result = MagicMock()
    result.channel = channel
    result.is_final = is_final
    return result


# ── ISTTProvider protocol compliance ──────────────────────────────────────────

class TestISTTProviderProtocol:
    """Verify DeepgramSTT satisfies the ISTTProvider runtime protocol."""

    def test_deepgram_stt_implements_istt_provider(self):
        """DeepgramSTT must be recognized as an ISTTProvider instance."""
        stt = DeepgramSTT(api_key="test-key")
        assert isinstance(stt, ISTTProvider)

    def test_deepgram_stt_has_required_methods(self):
        """All ISTTProvider methods must exist on DeepgramSTT."""
        stt = DeepgramSTT(api_key="test-key")
        assert callable(getattr(stt, "feed_audio", None))
        assert callable(getattr(stt, "on_partial", None))
        assert callable(getattr(stt, "on_final", None))
        assert callable(getattr(stt, "start", None))
        assert callable(getattr(stt, "stop", None))


# ── DeepgramSTT unit tests ────────────────────────────────────────────────────

class TestDeepgramSTTCore:
    """Core functionality of DeepgramSTT with mocked Deepgram SDK."""

    def test_init_defaults(self):
        """Verify default config values."""
        stt = DeepgramSTT(api_key="key-123")
        assert stt._api_key == "key-123"
        assert stt._model == "nova-2"
        assert stt._language == "es"
        assert stt._sample_rate == 16_000
        assert stt._encoding == "linear16"
        assert stt._interim_results is True
        assert stt._max_speakers == 8
        assert stt.stream_count == 0

    def test_init_custom_config(self):
        """Custom config overrides defaults."""
        stt = DeepgramSTT(
            api_key="key-456",
            model="nova-3",
            language="en",
            sample_rate=48_000,
            encoding="opus",
            interim_results=False,
            max_speakers=4,
        )
        assert stt._model == "nova-3"
        assert stt._language == "en"
        assert stt._sample_rate == 48_000
        assert stt._encoding == "opus"
        assert stt._interim_results is False
        assert stt._max_speakers == 4

    def test_on_partial_registers_handler(self):
        """on_partial() stores the callback."""
        stt = DeepgramSTT(api_key="key")
        handler = MagicMock()
        stt.on_partial(handler)
        assert stt._partial_handler is handler

    def test_on_final_registers_handler(self):
        """on_final() stores the callback."""
        stt = DeepgramSTT(api_key="key")
        handler = MagicMock()
        stt.on_final(handler)
        assert stt._final_handler is handler

    def test_feed_audio_without_stream_is_noop(self):
        """feed_audio for an unknown speaker should not crash."""
        stt = DeepgramSTT(api_key="key")
        audio = _make_audio()
        # No streams open → should silently return
        stt.feed_audio(audio, speaker_id="spk_0")
        # No exception = pass

    def test_active_speakers_empty_initially(self):
        """No active speakers before any streams are opened."""
        stt = DeepgramSTT(api_key="key")
        assert stt.active_speakers == []


# ── _SpeakerStream tests ─────────────────────────────────────────────────────

class TestSpeakerStream:
    """Test the per-speaker WebSocket stream wrapper."""

    def test_handle_transcript_final(self):
        """Final transcript should invoke on_final callback."""
        on_final = MagicMock()
        stream = _SpeakerStream(
            speaker_id="spk_0",
            api_key="key",
            on_final=on_final,
        )
        result = _make_transcript_result("hola mundo", confidence=0.92, is_final=True)
        stream._handle_transcript(stream, result)

        on_final.assert_called_once_with("hola mundo", "spk_0", 0.92)

    def test_handle_transcript_partial(self):
        """Partial transcript should invoke on_partial callback."""
        on_partial = MagicMock()
        stream = _SpeakerStream(
            speaker_id="spk_1",
            api_key="key",
            on_partial=on_partial,
        )
        result = _make_transcript_result("hola", confidence=0.8, is_final=False)
        stream._handle_transcript(stream, result)

        on_partial.assert_called_once_with("hola", 0.8)

    def test_handle_transcript_empty_text_ignored(self):
        """Empty transcript text should not invoke any callback."""
        on_final = MagicMock()
        on_partial = MagicMock()
        stream = _SpeakerStream(
            speaker_id="spk_0",
            api_key="key",
            on_final=on_final,
            on_partial=on_partial,
        )
        result = _make_transcript_result("", is_final=True)
        stream._handle_transcript(stream, result)

        on_final.assert_not_called()
        on_partial.assert_not_called()

    def test_handle_transcript_whitespace_only_ignored(self):
        """Whitespace-only transcript should be treated as empty."""
        on_final = MagicMock()
        stream = _SpeakerStream(
            speaker_id="spk_0",
            api_key="key",
            on_final=on_final,
        )
        result = _make_transcript_result("   ", is_final=True)
        stream._handle_transcript(stream, result)

        on_final.assert_not_called()

    def test_handle_transcript_no_alternatives(self):
        """Missing alternatives should not crash."""
        on_final = MagicMock()
        stream = _SpeakerStream(
            speaker_id="spk_0",
            api_key="key",
            on_final=on_final,
        )
        result = MagicMock()
        result.channel.alternatives = []
        stream._handle_transcript(stream, result)

        on_final.assert_not_called()

    def test_send_converts_float32_to_int16(self):
        """send() should convert float32 audio to int16 PCM bytes."""
        stream = _SpeakerStream(speaker_id="spk_0", api_key="key")
        # Simulate an open connection
        mock_connection = MagicMock()
        stream._connection = mock_connection
        stream._started = True

        audio = np.array([0.5, -0.5, 1.0, -1.0], dtype=np.float32)
        stream.send(audio)

        mock_connection.send.assert_called_once()
        sent_bytes = mock_connection.send.call_args[0][0]
        # Verify the bytes decode back to expected int16 values
        decoded = np.frombuffer(sent_bytes, dtype=np.int16)
        assert len(decoded) == 4
        assert decoded[0] == int(0.5 * 32767)   # 16383
        assert decoded[1] == int(-0.5 * 32767)   # -16383 (approximately)

    def test_send_noop_when_not_started(self):
        """send() should silently return if stream isn't started."""
        stream = _SpeakerStream(speaker_id="spk_0", api_key="key")
        stream._connection = MagicMock()
        stream._started = False

        audio = _make_audio()
        stream.send(audio)  # Should not crash or call send

        stream._connection.send.assert_not_called()

    def test_is_active_property(self):
        """is_active should reflect connection state."""
        stream = _SpeakerStream(speaker_id="spk_0", api_key="key")
        assert stream.is_active is False

        stream._connection = MagicMock()
        stream._started = True
        assert stream.is_active is True

    def test_handle_error_does_not_crash(self):
        """Error handler should log but not raise."""
        stream = _SpeakerStream(speaker_id="spk_0", api_key="key")
        # Should not raise
        stream._handle_error(stream, Exception("WebSocket error"))


# ── DeepgramSTT with mocked streams ──────────────────────────────────────────

class TestDeepgramSTTWithMockedStreams:
    """Tests that exercise the full DeepgramSTT with mocked _SpeakerStream."""

    @pytest.fixture
    def stt(self):
        return DeepgramSTT(api_key="test-key", max_speakers=3)

    @pytest.mark.asyncio
    async def test_start_creates_default_stream(self, stt):
        """start() should open a default speaker stream."""
        with patch.object(_SpeakerStream, "open", new_callable=AsyncMock) as mock_open:
            await stt.start()
            assert stt.stream_count == 1
            mock_open.assert_called_once()
            # Default stream should not show in active_speakers
            assert stt.active_speakers == []

    @pytest.mark.asyncio
    async def test_stop_closes_all_streams(self, stt):
        """stop() should close all open streams."""
        with patch.object(_SpeakerStream, "open", new_callable=AsyncMock):
            await stt.start()
            await stt.add_speaker("spk_0")

        with patch.object(_SpeakerStream, "close", new_callable=AsyncMock) as mock_close:
            await stt.stop()
            assert stt.stream_count == 0
            assert mock_close.call_count == 2  # default + spk_0

    @pytest.mark.asyncio
    async def test_add_speaker_creates_new_stream(self, stt):
        """add_speaker() should open a dedicated stream for that speaker."""
        original_ensure = stt._ensure_stream

        async def _patched_ensure(speaker_id):
            stream = _SpeakerStream(speaker_id=speaker_id, api_key="test-key")
            stream._started = True
            stream._connection = MagicMock()
            stt._streams[speaker_id] = stream
            return stream

        with patch.object(stt, "_ensure_stream", side_effect=_patched_ensure):
            await stt.start()
            await stt.add_speaker("spk_alice")
            await stt.add_speaker("spk_bob")

        assert stt.stream_count == 3  # default + alice + bob
        assert "spk_alice" in stt.active_speakers
        assert "spk_bob" in stt.active_speakers

    @pytest.mark.asyncio
    async def test_remove_speaker_closes_stream(self, stt):
        """remove_speaker() should close and remove the stream."""
        with patch.object(_SpeakerStream, "open", new_callable=AsyncMock):
            await stt.start()
            await stt.add_speaker("spk_0")

        with patch.object(_SpeakerStream, "close", new_callable=AsyncMock):
            await stt.remove_speaker("spk_0")

        assert "spk_0" not in stt.active_speakers

    @pytest.mark.asyncio
    async def test_remove_nonexistent_speaker_is_noop(self, stt):
        """remove_speaker() for unknown speaker should not crash."""
        await stt.remove_speaker("ghost")  # Should be silent

    @pytest.mark.asyncio
    async def test_feed_audio_routes_to_correct_speaker(self, stt):
        """feed_audio() should send data to the correct speaker's stream."""
        mock_stream = MagicMock(spec=_SpeakerStream)
        mock_stream.is_active = True
        stt._streams["spk_0"] = mock_stream

        audio = _make_audio()
        stt.feed_audio(audio, speaker_id="spk_0")

        mock_stream.send.assert_called_once()
        sent_audio = mock_stream.send.call_args[0][0]
        np.testing.assert_array_equal(sent_audio, audio)

    @pytest.mark.asyncio
    async def test_feed_audio_default_speaker(self, stt):
        """feed_audio() without speaker_id uses the default stream."""
        mock_stream = MagicMock(spec=_SpeakerStream)
        mock_stream.is_active = True
        stt._streams["__default__"] = mock_stream

        audio = _make_audio()
        stt.feed_audio(audio)

        mock_stream.send.assert_called_once()

    @pytest.mark.asyncio
    async def test_max_speakers_eviction(self, stt):
        """When at capacity, adding a new speaker should evict the oldest."""
        async def _patched_ensure(speaker_id):
            # Evict if at capacity
            if len(stt._streams) >= stt._max_speakers:
                oldest_key = next(iter(stt._streams))
                del stt._streams[oldest_key]
            stream = _SpeakerStream(speaker_id=speaker_id, api_key="test-key")
            stream._started = True
            stream._connection = MagicMock()
            stt._streams[speaker_id] = stream
            return stream

        with patch.object(stt, "_ensure_stream", side_effect=_patched_ensure):
            await stt.start()           # __default__
            await stt.add_speaker("a")  # 2
            await stt.add_speaker("b")  # 3 — at capacity

            # Adding one more should evict the oldest (__default__)
            await stt.add_speaker("c")

        assert stt.stream_count == 3
        assert "c" in stt.active_speakers

    @pytest.mark.asyncio
    async def test_on_final_callback_integration(self, stt):
        """Final transcripts should reach the registered on_final handler."""
        results = []
        stt.on_final(lambda text, spk, conf: results.append((text, spk, conf)))

        # Manually create a stream with the registered handler
        with patch.object(_SpeakerStream, "open", new_callable=AsyncMock):
            await stt.add_speaker("spk_carlos")

        stream = stt._streams["spk_carlos"]
        result = _make_transcript_result("quiero dos tacos", confidence=0.97, is_final=True)
        stream._handle_transcript(stream, result)

        assert len(results) == 1
        assert results[0] == ("quiero dos tacos", "spk_carlos", 0.97)

    @pytest.mark.asyncio
    async def test_on_partial_callback_integration(self, stt):
        """Partial transcripts should reach the registered on_partial handler."""
        partials = []
        stt.on_partial(lambda text, conf: partials.append((text, conf)))

        with patch.object(_SpeakerStream, "open", new_callable=AsyncMock):
            await stt.add_speaker("spk_0")

        stream = stt._streams["spk_0"]
        result = _make_transcript_result("quiero", confidence=0.6, is_final=False)
        stream._handle_transcript(stream, result)

        assert len(partials) == 1
        assert partials[0] == ("quiero", 0.6)

    @pytest.mark.asyncio
    async def test_per_speaker_isolation(self, stt):
        """Each speaker's stream should route transcripts independently."""
        finals = []
        stt.on_final(lambda text, spk, conf: finals.append((text, spk)))

        with patch.object(_SpeakerStream, "open", new_callable=AsyncMock):
            await stt.add_speaker("alice")
            await stt.add_speaker("bob")

        # Simulate transcript from alice
        stt._streams["alice"]._handle_transcript(
            stt._streams["alice"],
            _make_transcript_result("hola soy alice", is_final=True),
        )
        # Simulate transcript from bob
        stt._streams["bob"]._handle_transcript(
            stt._streams["bob"],
            _make_transcript_result("hola soy bob", is_final=True),
        )

        assert len(finals) == 2
        assert ("hola soy alice", "alice") in finals
        assert ("hola soy bob", "bob") in finals


# ── Reconnection tests ───────────────────────────────────────────────────────

class TestDeepgramReconnection:
    """Test WebSocket reconnection logic."""

    @pytest.mark.asyncio
    async def test_reconnect_success(self):
        """Successful reconnect should re-open the stream."""
        stream = _SpeakerStream(speaker_id="spk_0", api_key="key")
        stream._started = True
        stream._connection = MagicMock()

        with patch.object(stream, "close", new_callable=AsyncMock):
            with patch.object(stream, "open", new_callable=AsyncMock):
                result = await stream.reconnect()

        assert result is True
        assert stream._reconnect_attempts == 1

    @pytest.mark.asyncio
    async def test_reconnect_max_attempts_reached(self):
        """After max attempts, reconnect should return False."""
        stream = _SpeakerStream(speaker_id="spk_0", api_key="key")
        stream._reconnect_attempts = 3  # Already at max

        result = await stream.reconnect()
        assert result is False

    @pytest.mark.asyncio
    async def test_reconnect_failure_returns_false(self):
        """If open() fails during reconnect, should return False."""
        stream = _SpeakerStream(speaker_id="spk_0", api_key="key")
        stream._started = True
        stream._connection = MagicMock()

        with patch.object(stream, "close", new_callable=AsyncMock):
            with patch.object(
                stream, "open", new_callable=AsyncMock, side_effect=ConnectionError("fail")
            ):
                result = await stream.reconnect()

        assert result is False

    @pytest.mark.asyncio
    async def test_reconnect_speaker_via_stt(self):
        """DeepgramSTT.reconnect_speaker() should delegate to stream."""
        stt = DeepgramSTT(api_key="key")
        mock_stream = MagicMock(spec=_SpeakerStream)
        mock_stream.reconnect = AsyncMock(return_value=True)
        stt._streams["spk_0"] = mock_stream

        result = await stt.reconnect_speaker("spk_0")
        assert result is True
        mock_stream.reconnect.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_reconnect_nonexistent_speaker(self):
        """reconnect_speaker() for unknown speaker returns False."""
        stt = DeepgramSTT(api_key="key")
        result = await stt.reconnect_speaker("ghost")
        assert result is False
