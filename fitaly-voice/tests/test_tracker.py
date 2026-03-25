"""Tests for SpeakerTracker — no NeMo/GPU required; embeddings are injected directly."""
from __future__ import annotations

import time
from unittest.mock import MagicMock

import numpy as np
import pytest

from conftest import make_random_embedding
from fitaly_voice.speaker_cache import KnownSpeaker
from fitaly_voice.tracker import SpeakerTracker, TrackedSpeaker, _l2_norm


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_cache(known_speaker: KnownSpeaker | None = None) -> MagicMock:
    """Mock AoscSpeakerCache — identify() returns the supplied known speaker."""
    mock = MagicMock()
    mock.identify.return_value = known_speaker
    return mock


def _tracker(
    known_speaker: KnownSpeaker | None = None,
    similarity_threshold: float = 0.72,
    ema_alpha: float = 0.3,
    max_inactive_s: float = 300.0,
    max_tracked: int = 32,
) -> SpeakerTracker:
    cache = _make_cache(known_speaker)
    return SpeakerTracker(
        cache=cache,
        similarity_threshold=similarity_threshold,
        ema_alpha=ema_alpha,
        max_inactive_s=max_inactive_s,
        max_tracked=max_tracked,
    )


# ── _l2_norm ──────────────────────────────────────────────────────────────────

class TestL2Norm:
    def test_unit_vector_unchanged(self):
        v = make_random_embedding(seed=0)
        result = _l2_norm(v)
        assert abs(np.linalg.norm(result) - 1.0) < 1e-6

    def test_zero_vector_safe(self):
        v = np.zeros(192, dtype=np.float32)
        result = _l2_norm(v)
        assert np.allclose(result, 0.0)

    def test_arbitrary_vector_normalised(self):
        v = np.array([3.0, 4.0], dtype=np.float32)
        result = _l2_norm(v)
        assert abs(np.linalg.norm(result) - 1.0) < 1e-6


# ── resolve: same embedding → same ID ─────────────────────────────────────────

class TestResolveIdentity:
    def test_same_embedding_returns_same_id(self):
        t = _tracker()
        emb = make_random_embedding(seed=1)
        id1 = t.resolve("speaker_0", emb, "sess-001")
        id2 = t.resolve("speaker_0", emb, "sess-001")
        assert id1 == id2

    def test_different_embedding_returns_new_id(self):
        t = _tracker(similarity_threshold=0.72)
        emb_a = make_random_embedding(seed=1)
        emb_b = make_random_embedding(seed=99)  # orthogonal to emb_a
        id1 = t.resolve("speaker_0", emb_a, "sess-001")
        id2 = t.resolve("speaker_1", emb_b, "sess-001")
        assert id1 != id2

    def test_ids_are_prefixed_trk(self):
        t = _tracker()
        emb = make_random_embedding(seed=2)
        spk_id = t.resolve("speaker_0", emb, "sess-abc")
        assert spk_id.startswith("trk:sess-abc:")

    def test_counter_increments_for_new_speakers(self):
        t = _tracker()
        id1 = t.resolve("speaker_0", make_random_embedding(seed=1), "s")
        id2 = t.resolve("speaker_1", make_random_embedding(seed=99), "s")
        assert id1 != id2
        # Both should be tracked
        assert len(t.snapshot()) == 2


# ── resolve: AOSC known speaker has priority ──────────────────────────────────

class TestAoscPriority:
    def test_known_speaker_id_returned(self):
        emb = make_random_embedding(seed=1)
        known = KnownSpeaker(
            speaker_id="emp:alice",
            name="Alice",
            role="employee",
            embedding=emb,
        )
        t = _tracker(known_speaker=known)
        result = t.resolve("speaker_0", emb, "sess-001")
        assert result == "emp:alice"

    def test_known_speaker_beats_tracked_match(self):
        """Even if a similar tracked speaker exists, AOSC takes priority."""
        emb = make_random_embedding(seed=1)
        # First call: no AOSC match → creates tracked entry
        t_no_aosc = _tracker(known_speaker=None)
        t_no_aosc.resolve("speaker_0", emb, "sess")

        # Now simulate AOSC finding a match on second call
        known = KnownSpeaker(
            speaker_id="emp:bob",
            name="Bob",
            role="employee",
            embedding=emb,
        )
        t_with_aosc = _tracker(known_speaker=known)
        result = t_with_aosc.resolve("speaker_0", emb, "sess")
        assert result == "emp:bob"


# ── EMA embedding update ──────────────────────────────────────────────────────

class TestEMA:
    def test_mean_embedding_updated_after_calls(self):
        t = _tracker(ema_alpha=0.5, similarity_threshold=0.5)
        emb_a = make_random_embedding(seed=1)
        emb_b = _l2_norm(emb_a * 0.9 + make_random_embedding(seed=2) * 0.1)

        t.resolve("speaker_0", emb_a, "sess")
        initial_mean = t.snapshot()[0].mean_embedding.copy()

        t.resolve("speaker_0", emb_b, "sess")
        updated_mean = t.snapshot()[0].mean_embedding

        # Mean should have shifted toward emb_b
        assert not np.allclose(initial_mean, updated_mean)

    def test_ema_converges_toward_new_embeddings(self):
        """EMA mean shifts when repeatedly observing a similar but distinct embedding."""
        t = _tracker(ema_alpha=0.5, similarity_threshold=0.3)
        base = make_random_embedding(seed=1)
        # Small perturbation — remains similar to base so it keeps re-matching
        perturb = make_random_embedding(seed=2)
        target = _l2_norm(base * 0.9 + perturb * 0.1)

        t.resolve("speaker_0", base, "sess")
        initial_mean = t.snapshot()[0].mean_embedding.copy()

        for _ in range(10):
            t.resolve("speaker_0", target, "sess")

        mean = t.snapshot()[0].mean_embedding
        # Mean should be closer to target than it was initially
        sim_after = float(np.dot(mean, target))
        sim_before = float(np.dot(initial_mean, target))
        assert sim_after > sim_before


# ── forget_inactive ───────────────────────────────────────────────────────────

class TestForgetInactive:
    def test_active_speaker_not_forgotten(self):
        t = _tracker(max_inactive_s=10.0)
        t.resolve("speaker_0", make_random_embedding(seed=1), "sess")
        removed = t.forget_inactive()
        assert removed == []
        assert len(t.snapshot()) == 1

    def test_inactive_speaker_removed(self):
        t = _tracker(max_inactive_s=0.0)  # expires immediately
        t.resolve("speaker_0", make_random_embedding(seed=1), "sess")
        # Advance time by touching last_seen
        sp = t.snapshot()[0]
        sp.last_seen = time.time() - 1.0  # 1 second ago

        removed = t.forget_inactive()
        assert sp.global_id in removed
        assert len(t.snapshot()) == 0

    def test_returns_list_of_removed_ids(self):
        t = _tracker(max_inactive_s=0.0)
        emb1, emb2 = make_random_embedding(seed=1), make_random_embedding(seed=99)
        t.resolve("speaker_0", emb1, "sess")
        t.resolve("speaker_1", emb2, "sess")

        for sp in t.snapshot():
            sp.last_seen = time.time() - 1.0

        removed = t.forget_inactive()
        assert len(removed) == 2
        assert len(t.snapshot()) == 0


# ── re-entry after silence ────────────────────────────────────────────────────

class TestReEntry:
    def test_same_speaker_re_identified_after_gap(self):
        """Speaker who goes silent and returns should get the same ID."""
        t = _tracker(max_inactive_s=300.0, similarity_threshold=0.72)
        emb = make_random_embedding(seed=5)
        id_before = t.resolve("speaker_0", emb, "sess")
        # Simulate a gap — no forget_inactive() called
        id_after = t.resolve("speaker_0", emb, "sess")
        assert id_before == id_after


# ── max_tracked eviction ──────────────────────────────────────────────────────

class TestMaxTracked:
    def test_oldest_evicted_when_limit_reached(self):
        t = _tracker(max_tracked=3, similarity_threshold=0.99)
        seeds = [1, 99, 42, 7]  # 4 distinct embeddings
        ids = []
        for i, seed in enumerate(seeds):
            ids.append(t.resolve(f"speaker_{i}", make_random_embedding(seed=seed), "sess"))

        # Only 3 tracked after eviction
        assert len(t.snapshot()) == 3
        tracked_ids = {sp.global_id for sp in t.snapshot()}
        # The first (oldest) speaker should have been evicted
        assert ids[0] not in tracked_ids
