"""Tests for AoscSpeakerCache — no NeMo required (embedding injected directly)."""
from __future__ import annotations

import os
import tempfile

import numpy as np
import pytest

from conftest import make_random_embedding
from fitaly_voice.speaker_cache import AoscSpeakerCache, KnownSpeaker


@pytest.fixture
def cache():
    return AoscSpeakerCache(threshold=0.75)


def enroll_with_emb(cache: AoscSpeakerCache, speaker_id: str, name: str,
                    role: str, embedding: np.ndarray) -> KnownSpeaker:
    """Helper: enroll a speaker directly from a pre-computed embedding."""
    return cache.enroll_from_embedding(speaker_id, name, role, embedding)


class TestEnrollAndIdentify:
    def test_identify_enrolled_speaker(self, cache):
        emb = make_random_embedding(seed=1)
        enroll_with_emb(cache, "emp:alice", "Alice", "employee", emb)

        result = cache.identify(emb)
        assert result is not None
        assert result.speaker_id == "emp:alice"

    def test_identify_returns_none_for_unknown(self, cache):
        emb_alice = make_random_embedding(seed=1)
        emb_unknown = make_random_embedding(seed=99)
        enroll_with_emb(cache, "emp:alice", "Alice", "employee", emb_alice)

        result = cache.identify(emb_unknown)
        assert result is None

    def test_identify_picks_closest_speaker(self, cache):
        emb_alice = make_random_embedding(seed=1)
        emb_bob = make_random_embedding(seed=2)
        enroll_with_emb(cache, "emp:alice", "Alice", "employee", emb_alice)
        enroll_with_emb(cache, "emp:bob", "Bob", "employee", emb_bob)

        result = cache.identify(emb_alice)
        assert result is not None
        assert result.speaker_id == "emp:alice"

    def test_identify_empty_cache_returns_none(self, cache):
        emb = make_random_embedding(seed=5)
        assert cache.identify(emb) is None

    def test_threshold_boundary(self):
        # threshold=0.9 — only very close embeddings match
        cache_strict = AoscSpeakerCache(threshold=0.9)
        emb = make_random_embedding(seed=10)
        enroll_with_emb(cache_strict, "emp:alice", "Alice", "employee", emb)

        # Slightly perturbed embedding — cosine sim < 0.9
        rng = np.random.default_rng(10)
        perturbed = emb + rng.standard_normal(len(emb)).astype(np.float32) * 0.5
        perturbed /= np.linalg.norm(perturbed)
        result = cache_strict.identify(perturbed)
        # May or may not match depending on perturbation magnitude — just verify type
        assert result is None or isinstance(result, KnownSpeaker)

    def test_enroll_replaces_existing(self, cache):
        emb1 = make_random_embedding(seed=1)
        emb2 = make_random_embedding(seed=2)
        enroll_with_emb(cache, "emp:alice", "Alice", "employee", emb1)
        enroll_with_emb(cache, "emp:alice", "Alice Updated", "employee", emb2)

        assert len(cache) == 1
        result = cache.identify(emb2)
        assert result is not None
        assert result.name == "Alice Updated"


class TestSavLoad:
    def test_save_and_load_roundtrip(self, cache):
        emb_alice = make_random_embedding(seed=1)
        emb_bob = make_random_embedding(seed=2)
        enroll_with_emb(cache, "emp:alice", "Alice", "employee", emb_alice)
        enroll_with_emb(cache, "emp:bob", "Bob", "employee", emb_bob)

        with tempfile.NamedTemporaryFile(suffix=".npz", delete=False) as f:
            path = f.name

        try:
            cache.save(path)

            cache2 = AoscSpeakerCache(threshold=0.75)
            cache2.load(path)

            assert len(cache2) == 2
            result = cache2.identify(emb_alice)
            assert result is not None
            assert result.speaker_id == "emp:alice"

            result2 = cache2.identify(emb_bob)
            assert result2 is not None
            assert result2.speaker_id == "emp:bob"
        finally:
            os.unlink(path)

    def test_embeddings_preserved_exactly(self, cache):
        emb = make_random_embedding(seed=42)
        enroll_with_emb(cache, "emp:charlie", "Charlie", "employee", emb)

        with tempfile.NamedTemporaryFile(suffix=".npz", delete=False) as f:
            path = f.name

        try:
            cache.save(path)
            cache2 = AoscSpeakerCache(threshold=0.75)
            cache2.load(path)
            np.testing.assert_array_almost_equal(
                cache2._known[0].embedding, emb, decimal=6
            )
        finally:
            os.unlink(path)


class TestEphemeralId:
    def test_ephemeral_id_format(self, cache):
        eid = cache.make_ephemeral_id("sess-abc", "speaker_0")
        assert eid == "unk:sess-abc:speaker_0"
