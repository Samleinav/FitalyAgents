from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

import numpy as np


@dataclass
class KnownSpeaker:
    speaker_id: str     # e.g. "emp:alice", "emp:bob"
    name: str
    role: str           # "employee" | "customer"
    embedding: np.ndarray  # L2-normalised, shape (192,) for TitaNet-Large


class AoscSpeakerCache:
    """
    AOSC (Agent-Oriented Speaker Cache) — identifies known voices by
    cosine similarity of TitaNet speaker embeddings.

    Supports two backends for embedding extraction:
    - ``nemo``  — full NeMo TitaNet model (required once for initial enrollment)
    - ``onnx``  — onnxruntime-gpu with pre-exported TitaNet (~100MB runtime dep)

    Export once (requires NeMo):
        from fitaly_voice.speaker_cache import AoscSpeakerCache
        AoscSpeakerCache.export_onnx(output_path="titanet.onnx")

    Then use:
        cache = AoscSpeakerCache(backend="onnx", onnx_path="titanet.onnx")

    Unknown speakers receive ephemeral IDs: ``"unk:{session_id}:{label}"``.
    """

    def __init__(
        self,
        embedder_model: str = "titanet_large",
        threshold: float = 0.75,
        cache_path: Optional[str] = None,
        backend: Literal["nemo", "onnx"] = "nemo",
        onnx_path: Optional[str] = None,
        device: str = "cuda",
    ) -> None:
        self.embedder_model = embedder_model
        self.threshold = threshold
        self.backend = backend
        self.onnx_path = onnx_path
        self.device = device
        self._known: list[KnownSpeaker] = []
        self._embedder = None  # lazy-loaded

        if cache_path:
            try:
                self.load(cache_path)
            except FileNotFoundError:
                pass

    # ── Embedder ──────────────────────────────────────────────────────────────

    def _load_embedder(self):
        if self._embedder is None:
            if self.backend == "onnx":
                self._embedder = self._load_onnx_embedder()
            else:
                self._embedder = self._load_nemo_embedder()
        return self._embedder

    def _load_nemo_embedder(self):
        from nemo.collections.asr.models import EncDecSpeakerLabelModel  # type: ignore[import]

        model = EncDecSpeakerLabelModel.from_pretrained(self.embedder_model)
        model.eval()
        return model

    def _load_onnx_embedder(self):
        if not self.onnx_path:
            raise ValueError("onnx_path is required when backend='onnx'")
        import onnxruntime as ort  # type: ignore[import]

        providers = (
            ["CUDAExecutionProvider", "CPUExecutionProvider"]
            if self.device != "cpu"
            else ["CPUExecutionProvider"]
        )
        return ort.InferenceSession(self.onnx_path, providers=providers)

    @staticmethod
    def export_onnx(
        model_name: str = "titanet_large",
        output_path: str = "titanet.onnx",
        device: str = "cuda",
    ) -> None:
        """
        Export TitaNet to ONNX (run once, then use backend='onnx').
        Requires nemo_toolkit[asr]. After export only onnxruntime-gpu needed.
        """
        import torch
        from nemo.collections.asr.models import EncDecSpeakerLabelModel  # type: ignore[import]

        print(f"Loading {model_name}...")
        model = EncDecSpeakerLabelModel.from_pretrained(model_name)
        model = model.to(device)
        model.eval()

        dummy_audio = torch.zeros(1, 32000, device=device)
        dummy_len = torch.tensor([32000], dtype=torch.long, device=device)

        print(f"Exporting to {output_path}...")
        torch.onnx.export(
            model,
            (dummy_audio, dummy_len),
            output_path,
            input_names=["input_signal", "input_signal_length"],
            output_names=["logits", "embs"],
            dynamic_axes={
                "input_signal": {0: "batch", 1: "time"},
                "input_signal_length": {0: "batch"},
            },
            opset_version=17,
        )
        print(f"Exported: {output_path}")

    def get_embedding(self, audio: np.ndarray, sample_rate: int = 16000) -> np.ndarray:
        """
        Extract a L2-normalised speaker embedding from *audio*.

        Args:
            audio: float32 array, shape (N,).
            sample_rate: audio sample rate.

        Returns:
            L2-normalised embedding, shape (D,).
        """
        embedder = self._load_embedder()

        if self.backend == "onnx":
            emb = self._embed_onnx(embedder, audio)
        else:
            emb = self._embed_nemo(embedder, audio)

        norm = np.linalg.norm(emb)
        return (emb / norm).astype(np.float32) if norm > 0 else emb.astype(np.float32)

    def _embed_nemo(self, embedder, audio: np.ndarray) -> np.ndarray:
        import torch

        tensor = torch.from_numpy(audio.astype(np.float32)).unsqueeze(0)
        length = torch.tensor([len(audio)], dtype=torch.long)
        with torch.no_grad():
            _, embedding = embedder.forward(
                input_signal=tensor,
                input_signal_length=length,
            )
        return embedding[0].cpu().numpy()

    def _embed_onnx(self, embedder, audio: np.ndarray) -> np.ndarray:
        inp = audio.astype(np.float32).reshape(1, -1)
        length = np.array([len(audio)], dtype=np.int64)
        outputs = embedder.run(
            None,
            {"input_signal": inp, "input_signal_length": length},
        )
        return outputs[1][0]  # embs output

    # ── Enroll / Identify ─────────────────────────────────────────────────────

    def enroll(
        self,
        speaker_id: str,
        name: str,
        role: str,
        audio: np.ndarray,
        sample_rate: int = 16000,
    ) -> KnownSpeaker:
        """
        Enroll a known speaker from an audio sample.

        If *speaker_id* already exists, the embedding is replaced.
        """
        embedding = self.get_embedding(audio, sample_rate)
        # Replace if already enrolled
        self._known = [k for k in self._known if k.speaker_id != speaker_id]
        known = KnownSpeaker(
            speaker_id=speaker_id,
            name=name,
            role=role,
            embedding=embedding,
        )
        self._known.append(known)
        return known

    def enroll_from_embedding(
        self,
        speaker_id: str,
        name: str,
        role: str,
        embedding: np.ndarray,
    ) -> KnownSpeaker:
        """Enroll a speaker directly from a pre-computed L2-normalised embedding."""
        norm = np.linalg.norm(embedding)
        emb = embedding / norm if norm > 0 else embedding
        self._known = [k for k in self._known if k.speaker_id != speaker_id]
        known = KnownSpeaker(
            speaker_id=speaker_id,
            name=name,
            role=role,
            embedding=emb.astype(np.float32),
        )
        self._known.append(known)
        return known

    def identify(self, embedding: np.ndarray) -> Optional[KnownSpeaker]:
        """
        Find the best-matching known speaker by cosine similarity.

        Returns the best match if similarity ≥ threshold, else None.
        """
        if not self._known:
            return None

        best_score = -1.0
        best_speaker: Optional[KnownSpeaker] = None

        for known in self._known:
            score = float(np.dot(embedding, known.embedding))
            if score > best_score:
                best_score = score
                best_speaker = known

        if best_score >= self.threshold:
            return best_speaker
        return None

    def make_ephemeral_id(self, session_id: str, speaker_label: str) -> str:
        """Return a stable ephemeral ID for an unknown speaker within a session."""
        return f"unk:{session_id}:{speaker_label}"

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self, path: str) -> None:
        """Persist known speakers to a .npz file."""
        if not self._known:
            return
        ids = np.array([k.speaker_id for k in self._known], dtype=object)
        names = np.array([k.name for k in self._known], dtype=object)
        roles = np.array([k.role for k in self._known], dtype=object)
        embeddings = np.stack([k.embedding for k in self._known])
        np.savez(path, ids=ids, names=names, roles=roles, embeddings=embeddings)

    def load(self, path: str) -> None:
        """Load known speakers from a .npz file."""
        data = np.load(path, allow_pickle=True)
        self._known = []
        for speaker_id, name, role, embedding in zip(
            data["ids"], data["names"], data["roles"], data["embeddings"]
        ):
            self._known.append(
                KnownSpeaker(
                    speaker_id=str(speaker_id),
                    name=str(name),
                    role=str(role),
                    embedding=embedding.astype(np.float32),
                )
            )

    def __len__(self) -> int:
        return len(self._known)
