"""
fitaly_voice.bus — Bus adapters and Pydantic event schemas.

Schemas mirror the Zod definitions in packages/core/src/types/index.ts.
"""
from .schemas import (
    AmbientContextEvent,
    InteractionPauseEvent,
    InteractionResumeEvent,
    SpeakerDetectedEvent,
    SpeakerLostEvent,
    SpeechFinalEvent,
    SpeechPartialEvent,
)
from .adapters import IBusAdapter, RedisBusAdapter, StdoutBusAdapter

__all__ = [
    # Schemas
    "SpeechFinalEvent",
    "SpeechPartialEvent",
    "AmbientContextEvent",
    "SpeakerDetectedEvent",
    "SpeakerLostEvent",
    "InteractionPauseEvent",
    "InteractionResumeEvent",
    # Adapters
    "IBusAdapter",
    "RedisBusAdapter",
    "StdoutBusAdapter",
]
