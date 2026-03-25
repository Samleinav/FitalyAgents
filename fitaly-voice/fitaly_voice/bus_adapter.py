from __future__ import annotations

import json
import time
from abc import ABC, abstractmethod
from typing import Optional


class IBusAdapter(ABC):
    """Abstract bus adapter — publish FitalyAgents bus events."""

    @abstractmethod
    async def publish_speaker_detected(
        self, session_id: str, speaker_id: str, store_id: str
    ) -> None: ...

    @abstractmethod
    async def publish_speaker_lost(
        self, session_id: str, speaker_id: str
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
    async def publish_ambient_context(
        self,
        session_id: str,
        text: str,
        speaker_id: Optional[str] = None,
    ) -> None: ...

    @abstractmethod
    async def disconnect(self) -> None: ...


class RedisBusAdapter(IBusAdapter):
    """
    Publishes FitalyAgents bus events to Redis pub/sub channels.

    Payload schemas match ``packages/core/src/types/index.ts``:
    - ``SpeechPartialEventSchema``
    - ``AmbientContextEventSchema``
    - ``TargetDetectedEventSchema`` (SPEAKER_DETECTED)
    """

    def __init__(self, redis_url: str, channel_prefix: str = "bus") -> None:
        self._redis_url = redis_url
        self._prefix = channel_prefix
        self._client = None

    async def _get_client(self):
        if self._client is None:
            import redis.asyncio as aioredis

            self._client = await aioredis.from_url(self._redis_url)
        return self._client

    async def _publish(self, channel: str, payload: dict) -> None:
        client = await self._get_client()
        await client.publish(f"{self._prefix}:{channel}", json.dumps(payload))

    async def publish_speaker_detected(
        self, session_id: str, speaker_id: str, store_id: str
    ) -> None:
        await self._publish(
            "SPEAKER_DETECTED",
            {
                "event": "SPEAKER_DETECTED",
                "session_id": session_id,
                "speaker_id": speaker_id,
                "store_id": store_id,
            },
        )

    async def publish_speaker_lost(
        self, session_id: str, speaker_id: str
    ) -> None:
        # Not a named schema in core types yet — use pattern consistent with others
        await self._publish(
            "SPEAKER_LOST",
            {
                "event": "SPEAKER_LOST",
                "session_id": session_id,
                "speaker_id": speaker_id,
                "timestamp": int(time.time() * 1000),
            },
        )

    async def publish_speech_partial(
        self,
        session_id: str,
        text: str,
        speaker_id: Optional[str],
        confidence: float,
    ) -> None:
        payload: dict = {
            "event": "SPEECH_PARTIAL",
            "session_id": session_id,
            "text": text,
            "confidence": confidence,
        }
        if speaker_id is not None:
            payload["speaker_id"] = speaker_id
        await self._publish("SPEECH_PARTIAL", payload)

    async def publish_ambient_context(
        self,
        session_id: str,
        text: str,
        speaker_id: Optional[str] = None,
    ) -> None:
        payload: dict = {
            "event": "AMBIENT_CONTEXT",
            "session_id": session_id,
            "text": text,
            "timestamp": int(time.time() * 1000),
        }
        if speaker_id is not None:
            payload["speaker_id"] = speaker_id
        await self._publish("AMBIENT_CONTEXT", payload)

    async def disconnect(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


class StdoutBusAdapter(IBusAdapter):
    """
    Dev/test adapter — prints JSON payloads to stdout instead of Redis.
    Useful for local development without a running Redis instance.
    """

    def __init__(self, channel_prefix: str = "bus") -> None:
        self._prefix = channel_prefix

    def _print(self, channel: str, payload: dict) -> None:
        print(json.dumps({"channel": f"{self._prefix}:{channel}", **payload}), flush=True)

    async def publish_speaker_detected(
        self, session_id: str, speaker_id: str, store_id: str
    ) -> None:
        self._print(
            "SPEAKER_DETECTED",
            {
                "event": "SPEAKER_DETECTED",
                "session_id": session_id,
                "speaker_id": speaker_id,
                "store_id": store_id,
            },
        )

    async def publish_speaker_lost(
        self, session_id: str, speaker_id: str
    ) -> None:
        self._print(
            "SPEAKER_LOST",
            {
                "event": "SPEAKER_LOST",
                "session_id": session_id,
                "speaker_id": speaker_id,
                "timestamp": int(time.time() * 1000),
            },
        )

    async def publish_speech_partial(
        self,
        session_id: str,
        text: str,
        speaker_id: Optional[str],
        confidence: float,
    ) -> None:
        payload: dict = {
            "event": "SPEECH_PARTIAL",
            "session_id": session_id,
            "text": text,
            "confidence": confidence,
        }
        if speaker_id is not None:
            payload["speaker_id"] = speaker_id
        self._print("SPEECH_PARTIAL", payload)

    async def publish_ambient_context(
        self,
        session_id: str,
        text: str,
        speaker_id: Optional[str] = None,
    ) -> None:
        payload: dict = {
            "event": "AMBIENT_CONTEXT",
            "session_id": session_id,
            "text": text,
            "timestamp": int(time.time() * 1000),
        }
        if speaker_id is not None:
            payload["speaker_id"] = speaker_id
        self._print("AMBIENT_CONTEXT", payload)

    async def disconnect(self) -> None:
        pass
