"""ISTTProvider — protocol for real-time speech-to-text providers.

Designed for streaming (Deepgram) as the primary provider.
WhisperSTT is an offline-only fallback; do NOT use it in production.

All implementations must support:
  feed_audio() → push PCM chunks as they arrive
  on_partial() → register callback for interim transcripts
  on_final()   → register callback for final transcripts
  start()/stop() → lifecycle management
"""
from __future__ import annotations

from typing import Callable, Optional, Protocol, runtime_checkable

import numpy as np


@runtime_checkable
class ISTTProvider(Protocol):
    """Protocol for real-time speech-to-text providers."""

    def feed_audio(self, audio: np.ndarray, speaker_id: Optional[str] = None) -> None:
        """
        Push an audio chunk to the provider.

        Args:
            audio: float32 mono PCM array, values in [-1, 1], at 16kHz.
            speaker_id: optional speaker identifier for per-speaker routing.
        """
        ...

    def on_partial(self, handler: Callable[[str, float], None]) -> None:
        """
        Register a handler for interim/partial transcripts.

        Args:
            handler: function(text, confidence) called for each partial result.
        """
        ...

    def on_final(self, handler: Callable[[str, Optional[str], float], None]) -> None:
        """
        Register a handler for final transcripts.

        Args:
            handler: function(text, speaker_id, confidence) called for each
                     completed utterance.
        """
        ...

    async def start(self) -> None:
        """Open connection(s) and begin processing."""
        ...

    async def stop(self) -> None:
        """Close connection(s) and release resources."""
        ...
