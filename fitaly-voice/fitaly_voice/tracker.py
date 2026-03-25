"""SpeakerTracker — online multi-speaker identity tracking across SortFormer windows.

Handles >4 total speakers by maintaining identity continuity across diarization
windows via TitaNet EMA embeddings and cosine similarity re-identification.

License: Commercial (fitaly-voice-pro)
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

import numpy as np

if TYPE_CHECKING:
    from .speaker_cache import AoscSpeakerCache


@dataclass
class TrackedSpeaker:
    global_id: str
    mean_embedding: np.ndarray  # L2-normalised EMA embedding
    last_seen: float            # UNIX timestamp
    source: Literal["aosc", "tracked"]


class SpeakerTracker:
    """
    Online speaker identity tracking across SortFormer diarization windows.

    Resolution order:
    1. AOSC cache (known employees) — highest priority
    2. Tracked speakers by cosine similarity ≥ similarity_threshold
    3. New ephemeral ID "trk:{session}:{counter}"

    Mean embedding updated via EMA after each observation:
        mean = ema_alpha * new + (1 - ema_alpha) * mean
    """

    def __init__(
        self,
        cache: AoscSpeakerCache,
        similarity_threshold: float = 0.72,
        ema_alpha: float = 0.3,
        max_inactive_s: float = 300.0,
        max_tracked: int = 32,
    ) -> None:
        self._cache = cache
        self.similarity_threshold = similarity_threshold
        self.ema_alpha = ema_alpha
        self.max_inactive_s = max_inactive_s
        self.max_tracked = max_tracked

        self._tracked: dict[str, TrackedSpeaker] = {}
        self._counter: int = 0

    # ── Public API ────────────────────────────────────────────────────────────

    def resolve(
        self,
        diarizer_label: str,
        embedding: np.ndarray,
        session_id: str,
    ) -> str:
        """
        Return stable speaker_id for the given embedding.

        Parameters
        ----------
        diarizer_label : str
            Short label from SortFormer (e.g. "speaker_0"). Used only as a
            fallback hint — identity is determined by embedding similarity.
        embedding : np.ndarray
            L2-normalised 192-dim TitaNet embedding.
        session_id : str
            Current session identifier (used when minting new IDs).
        """
        embedding = _l2_norm(embedding)
        now = time.time()

        # 1. AOSC cache: known employees take priority
        known = self._cache.identify(embedding)
        if known is not None:
            self._upsert(known.speaker_id, embedding, now, source="aosc")
            return known.speaker_id

        # 2. Search tracked speakers by cosine similarity
        best_id, best_sim = self._find_best_match(embedding)
        if best_id is not None and best_sim >= self.similarity_threshold:
            self._update_ema(best_id, embedding, now)
            return best_id

        # 3. New speaker
        new_id = self._mint_id(session_id)
        tracked = TrackedSpeaker(
            global_id=new_id,
            mean_embedding=embedding.copy(),
            last_seen=now,
            source="tracked",
        )
        self._evict_if_full()
        self._tracked[new_id] = tracked
        return new_id

    def forget_inactive(self) -> list[str]:
        """Remove speakers not seen within max_inactive_s. Returns removed IDs."""
        cutoff = time.time() - self.max_inactive_s
        to_remove = [
            gid for gid, sp in self._tracked.items()
            if sp.last_seen < cutoff
        ]
        for gid in to_remove:
            del self._tracked[gid]
        return to_remove

    def snapshot(self) -> list[TrackedSpeaker]:
        """Return a copy of all currently tracked speakers."""
        return list(self._tracked.values())

    # ── Internals ─────────────────────────────────────────────────────────────

    def _find_best_match(
        self, embedding: np.ndarray
    ) -> tuple[str | None, float]:
        best_id: str | None = None
        best_sim = -1.0
        for gid, sp in self._tracked.items():
            sim = float(np.dot(embedding, sp.mean_embedding))
            if sim > best_sim:
                best_sim = sim
                best_id = gid
        return best_id, best_sim

    def _update_ema(self, gid: str, embedding: np.ndarray, now: float) -> None:
        sp = self._tracked[gid]
        sp.mean_embedding = _l2_norm(
            self.ema_alpha * embedding + (1 - self.ema_alpha) * sp.mean_embedding
        )
        sp.last_seen = now

    def _upsert(
        self,
        gid: str,
        embedding: np.ndarray,
        now: float,
        source: Literal["aosc", "tracked"],
    ) -> None:
        if gid in self._tracked:
            self._update_ema(gid, embedding, now)
        else:
            self._evict_if_full()
            self._tracked[gid] = TrackedSpeaker(
                global_id=gid,
                mean_embedding=embedding.copy(),
                last_seen=now,
                source=source,
            )

    def _evict_if_full(self) -> None:
        if len(self._tracked) >= self.max_tracked:
            # Evict the least recently seen speaker
            oldest = min(self._tracked.values(), key=lambda s: s.last_seen)
            del self._tracked[oldest.global_id]

    def _mint_id(self, session_id: str) -> str:
        self._counter += 1
        return f"trk:{session_id}:{self._counter:03d}"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _l2_norm(v: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(v)
    if norm < 1e-9:
        return v
    return v / norm
