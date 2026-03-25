"""
Tests for fitaly_voice.bus — Pydantic schemas + adapter implementations.

Covers:
  - Schema validation, defaults, and serialisation
  - StdoutBusAdapter publish methods (all event types)
  - publish_speech_final (new method)
  - subscribe registration (stdout noop)
  - Schema compatibility with TypeScript Zod definitions
  - RedisBusAdapter publish with mocked Redis client
"""
from __future__ import annotations

import json
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Schemas
from fitaly_voice.bus.schemas import (
    AmbientContextEvent,
    InteractionPauseEvent,
    InteractionResumeEvent,
    SpeakerDetectedEvent,
    SpeakerLostEvent,
    SpeechFinalEvent,
    SpeechPartialEvent,
)

# Adapters
from fitaly_voice.bus.adapters import IBusAdapter, RedisBusAdapter, StdoutBusAdapter

# Backward compat import
from fitaly_voice.bus_adapter import (
    IBusAdapter as IBusAdapterCompat,
    StdoutBusAdapter as StdoutBusAdapterCompat,
)


# ═══════════════════════════════════════════════════════════════════════════════
#  Schema tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestSpeechFinalEvent:
    def test_defaults(self):
        evt = SpeechFinalEvent(session_id="s-1", text="hola")
        assert evt.event == "SPEECH_FINAL"
        assert evt.confidence is None
        assert evt.speaker_id is None
        assert evt.role is None

    def test_full_fields(self):
        evt = SpeechFinalEvent(
            session_id="s-1",
            text="quiero un café",
            confidence=0.97,
            speaker_id="emp:alice",
            role="cashier",
        )
        d = evt.model_dump(exclude_none=True)
        assert d["event"] == "SPEECH_FINAL"
        assert d["text"] == "quiero un café"
        assert d["confidence"] == 0.97
        assert d["role"] == "cashier"
        assert d["speaker_id"] == "emp:alice"

    def test_invalid_role_rejected(self):
        with pytest.raises(Exception):
            SpeechFinalEvent(session_id="s-1", text="x", role="invalid_role")

    def test_json_roundtrip(self):
        evt = SpeechFinalEvent(session_id="s-1", text="hi", confidence=0.9)
        raw = evt.model_dump_json()
        restored = SpeechFinalEvent.model_validate_json(raw)
        assert restored == evt


class TestSpeechPartialEvent:
    def test_required_fields(self):
        evt = SpeechPartialEvent(
            session_id="s-1", text="hol", confidence=0.6
        )
        assert evt.event == "SPEECH_PARTIAL"
        assert evt.speaker_id is None

    def test_with_speaker(self):
        evt = SpeechPartialEvent(
            session_id="s-1", text="hol", confidence=0.6, speaker_id="spk:1"
        )
        d = evt.model_dump(exclude_none=True)
        assert d["speaker_id"] == "spk:1"

    def test_exclude_none_omits_speaker(self):
        evt = SpeechPartialEvent(session_id="s-1", text="a", confidence=0.5)
        d = evt.model_dump(exclude_none=True)
        assert "speaker_id" not in d


class TestAmbientContextEvent:
    def test_timestamp_auto_generated(self):
        before = int(time.time() * 1000)
        evt = AmbientContextEvent(session_id="s-1", text="ruido")
        after = int(time.time() * 1000)
        assert before <= evt.timestamp <= after + 1

    def test_full_fields(self):
        evt = AmbientContextEvent(
            session_id="s-1",
            text="conversacion lejana",
            speaker_id="unk:s-1:speaker_2",
            timestamp=1234567890000,
        )
        d = evt.model_dump()
        assert d["event"] == "AMBIENT_CONTEXT"
        assert d["timestamp"] == 1234567890000


class TestSpeakerDetectedEvent:
    def test_all_fields_required(self):
        evt = SpeakerDetectedEvent(
            session_id="s-1", speaker_id="emp:alice", store_id="store-001"
        )
        d = evt.model_dump()
        assert d == {
            "event": "SPEAKER_DETECTED",
            "session_id": "s-1",
            "speaker_id": "emp:alice",
            "store_id": "store-001",
        }


class TestSpeakerLostEvent:
    def test_timestamp_auto_generated(self):
        evt = SpeakerLostEvent(session_id="s-1", speaker_id="emp:alice")
        assert evt.event == "SPEAKER_LOST"
        assert isinstance(evt.timestamp, int)
        assert evt.timestamp > 0


class TestInteractionPauseEvent:
    def test_fields(self):
        evt = InteractionPauseEvent(
            session_id="s-1", reason="staff override", staff_id="staff:bob"
        )
        d = evt.model_dump()
        assert d["event"] == "INTERACTION_PAUSE"
        assert d["reason"] == "staff override"
        assert d["staff_id"] == "staff:bob"


class TestInteractionResumeEvent:
    def test_fields(self):
        evt = InteractionResumeEvent(session_id="s-1")
        assert evt.model_dump() == {
            "event": "INTERACTION_RESUME",
            "session_id": "s-1",
        }


# ═══════════════════════════════════════════════════════════════════════════════
#  Zod compatibility tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestZodCompatibility:
    """
    Verify that model_dump() produces the exact key set expected by the
    Zod schemas in packages/core/src/types/index.ts.
    """

    def test_speech_final_keys_match_zod(self):
        """SpeechFinalEventSchema requires: event, session_id, text.
        Optional: confidence, speaker_id, role."""
        evt = SpeechFinalEvent(
            session_id="s-1",
            text="hello",
            confidence=0.95,
            speaker_id="spk:1",
            role="customer",
        )
        d = evt.model_dump(exclude_none=True)
        required = {"event", "session_id", "text"}
        assert required.issubset(d.keys())
        # All keys should be valid Zod fields
        valid_keys = {"event", "session_id", "text", "confidence", "speaker_id", "role"}
        assert set(d.keys()).issubset(valid_keys)

    def test_speech_partial_keys_match_zod(self):
        """SpeechPartialEventSchema requires: event, session_id, text, confidence.
        Optional: speaker_id."""
        evt = SpeechPartialEvent(
            session_id="s-1", text="hol", confidence=0.6, speaker_id="spk:1"
        )
        d = evt.model_dump(exclude_none=True)
        required = {"event", "session_id", "text", "confidence"}
        assert required.issubset(d.keys())

    def test_ambient_context_keys_match_zod(self):
        """AmbientContextEventSchema requires: event, session_id, text, timestamp.
        Optional: speaker_id."""
        evt = AmbientContextEvent(session_id="s-1", text="noise")
        d = evt.model_dump(exclude_none=True)
        required = {"event", "session_id", "text", "timestamp"}
        assert required.issubset(d.keys())

    def test_speaker_detected_keys_match_target_detected_zod(self):
        """TargetDetectedEventSchema requires: event, session_id, speaker_id, store_id."""
        evt = SpeakerDetectedEvent(
            session_id="s-1", speaker_id="spk:1", store_id="store-001"
        )
        d = evt.model_dump()
        required = {"event", "session_id", "speaker_id", "store_id"}
        assert set(d.keys()) == required

    def test_interaction_pause_keys_match_zod(self):
        """InteractionPauseEventSchema requires: event, session_id, reason, staff_id."""
        evt = InteractionPauseEvent(
            session_id="s-1", reason="override", staff_id="staff:1"
        )
        d = evt.model_dump()
        required = {"event", "session_id", "reason", "staff_id"}
        assert set(d.keys()) == required

    def test_speech_final_role_enum_values(self):
        """Role must be one of: customer, staff, cashier, manager, owner."""
        for role in ["customer", "staff", "cashier", "manager", "owner"]:
            evt = SpeechFinalEvent(session_id="s-1", text="x", role=role)
            assert evt.role == role

    def test_json_parse_produces_plain_dict(self):
        """Ensure json.loads of model_dump_json produces a plain dict
        that a Zod z.parse() would accept (no Python-specific types)."""
        evt = SpeechFinalEvent(
            session_id="s-1", text="hi", confidence=0.9, role="staff"
        )
        raw = evt.model_dump_json(exclude_none=True)
        parsed = json.loads(raw)
        assert isinstance(parsed, dict)
        assert parsed["event"] == "SPEECH_FINAL"
        assert isinstance(parsed["confidence"], float)


# ═══════════════════════════════════════════════════════════════════════════════
#  StdoutBusAdapter tests
# ═══════════════════════════════════════════════════════════════════════════════


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
        assert "timestamp" in captured

    @pytest.mark.asyncio
    async def test_publish_speech_partial_with_speaker(self, capsys):
        bus = StdoutBusAdapter()
        await bus.publish_speech_partial("s-001", "hello", "emp:alice", 0.95)
        captured = json.loads(capsys.readouterr().out.strip())
        assert captured["event"] == "SPEECH_PARTIAL"
        assert captured["text"] == "hello"
        assert captured["speaker_id"] == "emp:alice"
        assert captured["confidence"] == 0.95

    @pytest.mark.asyncio
    async def test_publish_speech_partial_without_speaker(self, capsys):
        bus = StdoutBusAdapter()
        await bus.publish_speech_partial("s-001", "hello", None, 0.8)
        captured = json.loads(capsys.readouterr().out.strip())
        assert captured["event"] == "SPEECH_PARTIAL"
        assert "speaker_id" not in captured

    @pytest.mark.asyncio
    async def test_publish_speech_final(self, capsys):
        bus = StdoutBusAdapter()
        await bus.publish_speech_final(
            "s-001", "quiero un café", confidence=0.97, speaker_id="emp:alice", role="cashier"
        )
        captured = json.loads(capsys.readouterr().out.strip())
        assert captured["event"] == "SPEECH_FINAL"
        assert captured["text"] == "quiero un café"
        assert captured["confidence"] == 0.97
        assert captured["speaker_id"] == "emp:alice"
        assert captured["role"] == "cashier"
        assert captured["channel"] == "bus:SPEECH_FINAL"

    @pytest.mark.asyncio
    async def test_publish_speech_final_minimal(self, capsys):
        bus = StdoutBusAdapter()
        await bus.publish_speech_final("s-001", "hola")
        captured = json.loads(capsys.readouterr().out.strip())
        assert captured["event"] == "SPEECH_FINAL"
        assert captured["text"] == "hola"
        assert captured["confidence"] == 1.0
        assert "speaker_id" not in captured
        assert "role" not in captured

    @pytest.mark.asyncio
    async def test_publish_ambient_context(self, capsys):
        bus = StdoutBusAdapter()
        await bus.publish_ambient_context(
            "s-001", "conversacion ambiente", "unk:s-001:speaker_1"
        )
        captured = json.loads(capsys.readouterr().out.strip())
        assert captured["event"] == "AMBIENT_CONTEXT"
        assert captured["text"] == "conversacion ambiente"
        assert captured["speaker_id"] == "unk:s-001:speaker_1"
        assert "timestamp" in captured

    @pytest.mark.asyncio
    async def test_publish_ambient_context_no_speaker(self, capsys):
        bus = StdoutBusAdapter()
        await bus.publish_ambient_context("s-001", "ruido de fondo")
        captured = json.loads(capsys.readouterr().out.strip())
        assert captured["event"] == "AMBIENT_CONTEXT"
        assert "speaker_id" not in captured

    @pytest.mark.asyncio
    async def test_subscribe_stores_handler(self):
        bus = StdoutBusAdapter()
        handler = MagicMock()
        await bus.subscribe("SPEECH_FINAL", handler)
        assert "SPEECH_FINAL" in bus._subscriptions

    @pytest.mark.asyncio
    async def test_disconnect_clears_subscriptions(self):
        bus = StdoutBusAdapter()
        await bus.subscribe("SPEECH_FINAL", MagicMock())
        await bus.disconnect()
        assert len(bus._subscriptions) == 0


# ═══════════════════════════════════════════════════════════════════════════════
#  RedisBusAdapter tests (mocked)
# ═══════════════════════════════════════════════════════════════════════════════


class TestRedisBusAdapter:
    @pytest.mark.asyncio
    async def test_publish_speech_final_to_redis(self):
        adapter = RedisBusAdapter("redis://localhost:6379")
        mock_client = AsyncMock()
        adapter._client = mock_client

        await adapter.publish_speech_final(
            "s-001", "hola mundo", confidence=0.95, speaker_id="spk:1", role="customer"
        )

        mock_client.publish.assert_called_once()
        call_args = mock_client.publish.call_args
        channel = call_args[0][0]
        payload = json.loads(call_args[0][1])
        assert channel == "bus:SPEECH_FINAL"
        assert payload["event"] == "SPEECH_FINAL"
        assert payload["text"] == "hola mundo"
        assert payload["confidence"] == 0.95
        assert payload["role"] == "customer"

    @pytest.mark.asyncio
    async def test_publish_speech_partial_to_redis(self):
        adapter = RedisBusAdapter("redis://localhost:6379")
        mock_client = AsyncMock()
        adapter._client = mock_client

        await adapter.publish_speech_partial("s-001", "hol", "spk:1", 0.6)

        call_args = mock_client.publish.call_args
        payload = json.loads(call_args[0][1])
        assert payload["event"] == "SPEECH_PARTIAL"
        assert payload["text"] == "hol"

    @pytest.mark.asyncio
    async def test_publish_speaker_detected_to_redis(self):
        adapter = RedisBusAdapter("redis://localhost:6379")
        mock_client = AsyncMock()
        adapter._client = mock_client

        await adapter.publish_speaker_detected("s-001", "emp:alice", "store-001")

        call_args = mock_client.publish.call_args
        channel = call_args[0][0]
        payload = json.loads(call_args[0][1])
        assert channel == "bus:SPEAKER_DETECTED"
        assert payload["speaker_id"] == "emp:alice"

    @pytest.mark.asyncio
    async def test_publish_speaker_lost_to_redis(self):
        adapter = RedisBusAdapter("redis://localhost:6379")
        mock_client = AsyncMock()
        adapter._client = mock_client

        await adapter.publish_speaker_lost("s-001", "emp:alice")

        call_args = mock_client.publish.call_args
        payload = json.loads(call_args[0][1])
        assert payload["event"] == "SPEAKER_LOST"
        assert "timestamp" in payload

    @pytest.mark.asyncio
    async def test_publish_ambient_context_to_redis(self):
        adapter = RedisBusAdapter("redis://localhost:6379")
        mock_client = AsyncMock()
        adapter._client = mock_client

        await adapter.publish_ambient_context("s-001", "ruido", "spk:2")

        call_args = mock_client.publish.call_args
        payload = json.loads(call_args[0][1])
        assert payload["event"] == "AMBIENT_CONTEXT"
        assert payload["speaker_id"] == "spk:2"

    @pytest.mark.asyncio
    async def test_disconnect_closes_client(self):
        adapter = RedisBusAdapter("redis://localhost:6379")
        mock_client = AsyncMock()
        adapter._client = mock_client

        await adapter.disconnect()
        mock_client.aclose.assert_called_once()
        assert adapter._client is None

    @pytest.mark.asyncio
    async def test_custom_channel_prefix(self):
        adapter = RedisBusAdapter("redis://localhost:6379", channel_prefix="voice")
        mock_client = AsyncMock()
        adapter._client = mock_client

        await adapter.publish_speech_final("s-1", "test")

        channel = mock_client.publish.call_args[0][0]
        assert channel == "voice:SPEECH_FINAL"


# ═══════════════════════════════════════════════════════════════════════════════
#  Backward compatibility tests
# ═══════════════════════════════════════════════════════════════════════════════


class TestBackwardCompatibility:
    def test_old_import_path_works(self):
        """from fitaly_voice.bus_adapter import ... should still work."""
        assert IBusAdapterCompat is IBusAdapter
        assert StdoutBusAdapterCompat is StdoutBusAdapter

    def test_stdout_adapter_is_ibus_adapter(self):
        bus = StdoutBusAdapter()
        assert isinstance(bus, IBusAdapter)

    def test_redis_adapter_is_ibus_adapter(self):
        bus = RedisBusAdapter("redis://localhost:6379")
        assert isinstance(bus, IBusAdapter)
