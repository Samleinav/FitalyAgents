"""
Pydantic event schemas for FitalyVoice bus events.

These models mirror the Zod schemas defined in:
  packages/core/src/types/index.ts

Every model uses ``model_dump()`` for JSON serialisation, guaranteeing
that payloads published by the Python pipeline can be parsed by the
TypeScript side with the corresponding Zod schema (``z.parse()``).
"""
from __future__ import annotations

import time
from typing import Literal, Optional

from pydantic import BaseModel, Field


# ── Voice pipeline events ─────────────────────────────────────────────────────


class SpeechFinalEvent(BaseModel):
    """Mirrors ``SpeechFinalEventSchema`` (Zod)."""

    event: Literal["SPEECH_FINAL"] = "SPEECH_FINAL"
    session_id: str
    text: str
    confidence: Optional[float] = None
    speaker_id: Optional[str] = None
    role: Optional[Literal["customer", "staff", "cashier", "manager", "owner"]] = None


class SpeechPartialEvent(BaseModel):
    """Mirrors ``SpeechPartialEventSchema`` (Zod)."""

    event: Literal["SPEECH_PARTIAL"] = "SPEECH_PARTIAL"
    session_id: str
    text: str
    confidence: float
    speaker_id: Optional[str] = None


class AmbientContextEvent(BaseModel):
    """Mirrors ``AmbientContextEventSchema`` (Zod)."""

    event: Literal["AMBIENT_CONTEXT"] = "AMBIENT_CONTEXT"
    session_id: str
    speaker_id: Optional[str] = None
    text: str
    timestamp: int = Field(default_factory=lambda: int(time.time() * 1000))


# ── Speaker lifecycle events ─────────────────────────────────────────────────


class SpeakerDetectedEvent(BaseModel):
    """Mirrors ``TargetDetectedEventSchema`` (Zod).

    The Zod schema uses ``TARGET_DETECTED``, but the Python bus publishes
    as ``SPEAKER_DETECTED`` for clarity.  The TypeScript side should
    handle both (or the channel name is used for routing).
    """

    event: Literal["SPEAKER_DETECTED"] = "SPEAKER_DETECTED"
    session_id: str
    speaker_id: str
    store_id: str


class SpeakerLostEvent(BaseModel):
    """No direct Zod schema yet — follows the same pattern."""

    event: Literal["SPEAKER_LOST"] = "SPEAKER_LOST"
    session_id: str
    speaker_id: str
    timestamp: int = Field(default_factory=lambda: int(time.time() * 1000))


# ── Multi-Agent ecosystem events ─────────────────────────────────────────────


class InteractionPauseEvent(BaseModel):
    """Mirrors ``InteractionPauseEventSchema`` (Zod)."""

    event: Literal["INTERACTION_PAUSE"] = "INTERACTION_PAUSE"
    session_id: str
    reason: str
    staff_id: str


class InteractionResumeEvent(BaseModel):
    """Mirrors ``InteractionResumeEventSchema`` (Zod)."""

    event: Literal["INTERACTION_RESUME"] = "INTERACTION_RESUME"
    session_id: str
