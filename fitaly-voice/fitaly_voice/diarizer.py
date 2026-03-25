from __future__ import annotations

from typing import Literal, NamedTuple

import numpy as np


class DiarizationSegment(NamedTuple):
    speaker_label: str  # "speaker_0", "speaker_1", ...
    start: float        # seconds within chunk
    end: float          # seconds within chunk


class SortFormerDiarizer:
    """
    Streaming diarization wrapper for SortFormer 4spk-v2.1.

    Supports three backends:
    - ``stub`` — no model required; always returns one segment for "speaker_0".
                 Use for demos, CI, or single-speaker scenarios (no GPU needed).
    - ``nemo`` — loads via nemo_toolkit (required once to export ONNX)
    - ``onnx`` — uses onnxruntime-gpu with a pre-exported .onnx file (~200MB runtime)

    Demo / no-GPU usage:
        diarizer = SortFormerDiarizer(backend="stub")

    Export once (NeMo → ONNX):
        from fitaly_voice.diarizer import SortFormerDiarizer
        SortFormerDiarizer.export_onnx("diar_streaming_sortformer_4spk-v2.1", "sortformer.onnx")

    Then use:
        diarizer = SortFormerDiarizer(backend="onnx", onnx_path="sortformer.onnx")
    """

    def __init__(
        self,
        model_name: str = "diar_streaming_sortformer_4spk-v2.1",
        device: str = "cuda",
        chunk_duration_s: float = 1.0,
        backend: Literal["nemo", "onnx", "stub"] = "nemo",
        onnx_path: str | None = None,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.chunk_duration_s = chunk_duration_s
        self.backend = backend
        self.onnx_path = onnx_path
        self._model = self._load_model()
        # Per-session state: {session_id: context_buffer}
        self._session_buffers: dict[str, np.ndarray] = {}

    def _load_model(self):
        if self.backend == "stub":
            return None  # no model needed
        if self.backend == "onnx":
            return self._load_onnx()
        return self._load_nemo()

    def _load_nemo(self):
        from nemo.collections.asr.models import SortFormerEncLabelModel  # type: ignore[import]

        model = SortFormerEncLabelModel.from_pretrained(self.model_name)
        model = model.to(self.device)
        model.eval()
        return model

    def _load_onnx(self):
        if not self.onnx_path:
            raise ValueError("onnx_path is required when backend='onnx'")
        import onnxruntime as ort  # type: ignore[import]

        providers = (
            ["CUDAExecutionProvider", "CPUExecutionProvider"]
            if self.device != "cpu"
            else ["CPUExecutionProvider"]
        )
        session = ort.InferenceSession(self.onnx_path, providers=providers)
        return session

    # ── Public API ────────────────────────────────────────────────────────────

    def process_chunk(
        self,
        audio: np.ndarray,
        session_id: str,
        sample_rate: int = 16000,
    ) -> list[DiarizationSegment]:
        """
        Process one audio chunk and return a list of speaker segments.

        Accumulates session context so speaker labels are stable across calls.
        """
        # Accumulate session context (sliding window)
        if session_id not in self._session_buffers:
            self._session_buffers[session_id] = audio
        else:
            self._session_buffers[session_id] = np.concatenate(
                [self._session_buffers[session_id], audio]
            )
        context = self._session_buffers[session_id]

        if self.backend == "stub":
            # Stub: treat the whole chunk as a single speaker_0 segment
            duration = len(context) / sample_rate
            return [DiarizationSegment("speaker_0", 0.0, duration)]

        if self.backend == "onnx":
            preds = self._infer_onnx(context)
        else:
            preds = self._infer_nemo(context)

        segments = self._decode_preds(preds, len(context), sample_rate)

        # Trim context to sliding window (4× chunk duration)
        max_ctx = int(self.chunk_duration_s * 4 * sample_rate)
        if len(self._session_buffers[session_id]) > max_ctx:
            self._session_buffers[session_id] = self._session_buffers[session_id][-max_ctx:]

        return segments

    def reset_session(self, session_id: str) -> None:
        """Clear the context buffer for a session."""
        self._session_buffers.pop(session_id, None)

    # ── Inference backends ────────────────────────────────────────────────────

    def _infer_nemo(self, context: np.ndarray) -> np.ndarray:
        import torch

        tensor = torch.from_numpy(context.astype(np.float32)).unsqueeze(0).to(self.device)
        length = torch.tensor([len(context)], dtype=torch.long).to(self.device)
        with torch.no_grad():
            preds, *_ = self._model.forward(
                audio_signal=tensor,
                audio_signal_length=length,
            )
        return preds[0].cpu().numpy()  # (T, num_speakers)

    def _infer_onnx(self, context: np.ndarray) -> np.ndarray:
        audio = context.astype(np.float32).reshape(1, -1)
        length = np.array([len(context)], dtype=np.int64)
        outputs = self._model.run(
            None,
            {"audio_signal": audio, "audio_signal_length": length},
        )
        return outputs[0][0]  # (T, num_speakers)

    # ── ONNX export helper ────────────────────────────────────────────────────

    @staticmethod
    def export_onnx(
        model_name: str = "diar_streaming_sortformer_4spk-v2.1",
        output_path: str = "sortformer.onnx",
        device: str = "cuda",
    ) -> None:
        """
        Export NeMo SortFormer to ONNX (run once, then use backend='onnx').

        Requires nemo_toolkit[asr] installed. After export, runtime only needs
        onnxruntime-gpu (~200MB) instead of full NeMo.

        Usage:
            python -c "from fitaly_voice.diarizer import SortFormerDiarizer; \\
                       SortFormerDiarizer.export_onnx(output_path='sortformer.onnx')"
        """
        import torch
        from nemo.collections.asr.models import SortFormerEncLabelModel  # type: ignore[import]

        print(f"Loading {model_name}...")
        model = SortFormerEncLabelModel.from_pretrained(model_name)
        model = model.to(device)
        model.eval()

        # Dummy input: 4 seconds of audio at 16kHz
        dummy_audio = torch.zeros(1, 64000, device=device)
        dummy_len = torch.tensor([64000], dtype=torch.long, device=device)

        print(f"Exporting to {output_path}...")
        torch.onnx.export(
            model,
            (dummy_audio, dummy_len),
            output_path,
            input_names=["audio_signal", "audio_signal_length"],
            output_names=["preds", "scale_mapping", "session_embedding"],
            dynamic_axes={
                "audio_signal": {0: "batch", 1: "time"},
                "audio_signal_length": {0: "batch"},
                "preds": {0: "batch", 1: "frames"},
            },
            opset_version=17,
        )
        print(f"Exported: {output_path}")

    # ── Decoding ──────────────────────────────────────────────────────────────

    @staticmethod
    def _decode_preds(
        preds: np.ndarray,
        n_samples: int,
        sample_rate: int,
    ) -> list[DiarizationSegment]:
        """
        Convert frame-level speaker activity (T, num_speakers) to DiarizationSegments.
        """
        num_frames, num_speakers = preds.shape
        frame_duration = n_samples / sample_rate / num_frames

        segments: list[DiarizationSegment] = []
        for spk_idx in range(num_speakers):
            activity = preds[:, spk_idx] >= 0.5
            in_seg = False
            seg_start = 0.0
            for t, active in enumerate(activity):
                t_sec = t * frame_duration
                if active and not in_seg:
                    seg_start = t_sec
                    in_seg = True
                elif not active and in_seg:
                    segments.append(DiarizationSegment(f"speaker_{spk_idx}", seg_start, t_sec))
                    in_seg = False
            if in_seg:
                segments.append(
                    DiarizationSegment(f"speaker_{spk_idx}", seg_start, num_frames * frame_duration)
                )

        segments.sort(key=lambda s: s.start)
        return segments
