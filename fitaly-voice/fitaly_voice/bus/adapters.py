"""
Bus adapter implementations — publish FitalyVoice events via Redis or stdout.

Uses Pydantic schemas from ``bus.schemas`` for type-safe serialisation.
"""
from __future__ import annotations

import json
from abc import ABC, abstractmethod
from typing import Callable, Optional

from .schemas import (
    AmbientContextEvent,
    SpeakerDetectedEvent,
    SpeakerLostEvent,
    SpeechFinalEvent,
    SpeechPartialEvent,
)


class IBusAdapter(ABC):
    """Abstract bus adapter — publish FitalyAgents bus events."""

    @abstractmethod
    async def publish_speech_final(
        self,
        session_id: str,
        text: str,
        confidence: float = 1.0,
        speaker_id: Optional[str] = None,
        role: Optional[str] = None,
    ) -> None: ...

    @abstractmethod
    async def publish_speech_partial(
        self,
        session_id: str,
        text: str,
        speaker_id: Optional[str],
        confidence: float,
    ) -> None: ...

    @abstractmethod
    async def publish_speaker_detected(
        self, session_id: str, speaker_id: str, store_id: str
    ) -> None: ...

    @abstractmethod
    async def publish_speaker_lost(
        self, session_id: str, speaker_id: str
    ) -> None: ...

    @abstractmethod
    async def publish_ambient_context(
        self,
        session_id: str,
        text: str,
        speaker_id: Optional[str] = None,
    ) -> None: ...

    @abstractmethod
    async def subscribe(
        self, channel: str, handler: Callable[[dict], None]
    ) -> None: ...

    @abstractmethod
    async def disconnect(self) -> None: ...


# ── Redis ─────────────────────────────────────────────────────────────────────


class RedisBusAdapter(IBusAdapter):
    """
    Publishes FitalyAgents bus events to Redis pub/sub channels.

    Payload schemas match ``packages/core/src/types/index.ts``
    via Pydantic model_dump().
    """

    def __init__(self, redis_url: str, channel_prefix: str = "bus") -> None:
        self._redis_url = redis_url
        self._prefix = channel_prefix
        self._client = None
        self._pubsub = None

    async def _get_client(self):
        if self._client is None:
            import redis.asyncio as aioredis

            self._client = await aioredis.from_url(self._redis_url)
        return self._client

    async def _publish(self, channel: str, payload: dict) -> None:
        client = await self._get_client()
        await client.publish(f"{self._prefix}:{channel}", json.dumps(payload))

    # ── Publish methods ───────────────────────────────────────────────────────

    async def publish_speech_final(
        self,
        session_id: str,
        text: str,
        confidence: float = 1.0,
        speaker_id: Optional[str] = None,
        role: Optional[str] = None,
    ) -> None:
        evt = SpeechFinalEvent(
            session_id=session_id,
            text=text,
            confidence=confidence,
            speaker_id=speaker_id,
            role=role,  # type: ignore[arg-type]
        )
        await self._publish("SPEECH_FINAL", evt.model_dump(exclude_none=True))

    async def publish_speech_partial(
        self,
        session_id: str,
        text: str,
        speaker_id: Optional[str],
        confidence: float,
    ) -> None:
        evt = SpeechPartialEvent(
            session_id=session_id,
            text=text,
            confidence=confidence,
            speaker_id=speaker_id,
        )
        await self._publish("SPEECH_PARTIAL", evt.model_dump(exclude_none=True))

    async def publish_speaker_detected(
        self, session_id: str, speaker_id: str, store_id: str
    ) -> None:
        evt = SpeakerDetectedEvent(
            session_id=session_id,
            speaker_id=speaker_id,
            store_id=store_id,
        )
        await self._publish("SPEAKER_DETECTED", evt.model_dump())

    async def publish_speaker_lost(
        self, session_id: str, speaker_id: str
    ) -> None:
        evt = SpeakerLostEvent(
            session_id=session_id,
            speaker_id=speaker_id,
        )
        await self._publish("SPEAKER_LOST", evt.model_dump())

    async def publish_ambient_context(
        self,
        session_id: str,
        text: str,
        speaker_id: Optional[str] = None,
    ) -> None:
        evt = AmbientContextEvent(
            session_id=session_id,
            text=text,
            speaker_id=speaker_id,
        )
        await self._publish("AMBIENT_CONTEXT", evt.model_dump(exclude_none=True))

    # ── Subscribe ─────────────────────────────────────────────────────────────

    async def subscribe(
        self, channel: str, handler: Callable[[dict], None]
    ) -> None:
        """Subscribe to a Redis pub/sub channel.

        The *handler* receives already-parsed ``dict`` payloads.
        Runs a background listener task internally.
        """
        import asyncio

        client = await self._get_client()
        self._pubsub = client.pubsub()
        full_channel = f"{self._prefix}:{channel}"
        await self._pubsub.subscribe(full_channel)

        async def _listener():
            async for message in self._pubsub.listen():
                if message["type"] == "message":
                    data = json.loads(message["data"])
                    handler(data)

        asyncio.create_task(_listener())

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def disconnect(self) -> None:
        if self._pubsub is not None:
            await self._pubsub.unsubscribe()
            await self._pubsub.aclose()
            self._pubsub = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None


# ── Stdout (dev / testing) ────────────────────────────────────────────────────


class StdoutBusAdapter(IBusAdapter):
    """
    Dev/test adapter — prints JSON payloads to stdout instead of Redis.
    Useful for local development without a running Redis instance.
    """

    def __init__(self, channel_prefix: str = "bus") -> None:
        self._prefix = channel_prefix
        self._subscriptions: dict[str, Callable[[dict], None]] = {}

    def _print(self, channel: str, payload: dict) -> None:
        print(
            json.dumps({"channel": f"{self._prefix}:{channel}", **payload}),
            flush=True,
        )

    async def publish_speech_final(
        self,
        session_id: str,
        text: str,
        confidence: float = 1.0,
        speaker_id: Optional[str] = None,
        role: Optional[str] = None,
    ) -> None:
        evt = SpeechFinalEvent(
            session_id=session_id,
            text=text,
            confidence=confidence,
            speaker_id=speaker_id,
            role=role,  # type: ignore[arg-type]
        )
        self._print("SPEECH_FINAL", evt.model_dump(exclude_none=True))

    async def publish_speech_partial(
        self,
        session_id: str,
        text: str,
        speaker_id: Optional[str],
        confidence: float,
    ) -> None:
        evt = SpeechPartialEvent(
            session_id=session_id,
            text=text,
            confidence=confidence,
            speaker_id=speaker_id,
        )
        self._print("SPEECH_PARTIAL", evt.model_dump(exclude_none=True))

    async def publish_speaker_detected(
        self, session_id: str, speaker_id: str, store_id: str
    ) -> None:
        evt = SpeakerDetectedEvent(
            session_id=session_id,
            speaker_id=speaker_id,
            store_id=store_id,
        )
        self._print("SPEAKER_DETECTED", evt.model_dump())

    async def publish_speaker_lost(
        self, session_id: str, speaker_id: str
    ) -> None:
        evt = SpeakerLostEvent(
            session_id=session_id,
            speaker_id=speaker_id,
        )
        self._print("SPEAKER_LOST", evt.model_dump())

    async def publish_ambient_context(
        self,
        session_id: str,
        text: str,
        speaker_id: Optional[str] = None,
    ) -> None:
        evt = AmbientContextEvent(
            session_id=session_id,
            text=text,
            speaker_id=speaker_id,
        )
        self._print("AMBIENT_CONTEXT", evt.model_dump(exclude_none=True))

    async def subscribe(
        self, channel: str, handler: Callable[[dict], None]
    ) -> None:
        """Register a handler — stdout adapter stores but never fires."""
        self._subscriptions[channel] = handler

    async def disconnect(self) -> None:
        self._subscriptions.clear()
