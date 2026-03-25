# fitaly-voice — Full GPU Dockerfile
# GTX 1660 Super (Turing, CC 7.5) + CUDA 12.1 + NeMo SortFormer + TitaNet
#
# Audio input via UDP bridge — run audio_bridge.py on the host to forward mic.
# All NeMo/GPU processing runs here inside the container.
#
# Build:
#   docker compose build fitaly-voice
#
# First run will download models (~560MB) to /root/.cache/torch/NeMo/

# ── CUDA base ─────────────────────────────────────────────────────────────────
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# ── System deps ───────────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.11 \
      python3.11-dev \
      python3-pip \
      python3.11-venv \
      git \
      ffmpeg \
      libsndfile1 \
      libsndfile1-dev \
      build-essential \
      curl \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3 /usr/bin/python \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── PyTorch CUDA 12.1 (Turing sm_75 supported) ───────────────────────────────
# Install before NeMo to avoid version conflicts
RUN pip install --no-cache-dir \
      "torch==2.1.2+cu121" \
      "torchaudio==2.1.2+cu121" \
      --index-url https://download.pytorch.org/whl/cu121

# ── NeMo ASR (SortFormer + TitaNet) ──────────────────────────────────────────
# nemo_toolkit[asr] pulls in the ASR collection including diarization
RUN pip install --no-cache-dir "nemo_toolkit[asr]>=2.0"

# ── STT: faster-whisper (CTranslate2, no extra torch needed) ─────────────────
RUN pip install --no-cache-dir faster-whisper

# ── TEN VAD + pipeline deps ───────────────────────────────────────────────────
RUN pip install --no-cache-dir \
      "ten-vad @ git+https://github.com/TEN-framework/ten-vad.git" \
      rnnoise-python \
      noisereduce \
      scipy \
      "redis[hiredis]>=5.0" \
      numpy \
      pyyaml

# ── Copy package ──────────────────────────────────────────────────────────────
COPY pyproject.toml ./
COPY fitaly_voice/ ./fitaly_voice/

# ── NeMo model cache dir ──────────────────────────────────────────────────────
# Models are downloaded on first run and cached here.
# Mount a volume to persist across container restarts:
#   volumes: - nemo_cache:/root/.cache
ENV NEMO_CACHE_DIR=/root/.cache/torch/NeMo

# ── Runtime defaults (override via docker-compose / env) ─────────────────────
ENV REDIS_URL=redis://redis:6379 \
    STORE_ID=store-001 \
    BUS_MODE=redis \
    # Full NeMo diarizer (SortFormer 4spk-v2.1)
    DIARIZER_BACKEND=nemo \
    DIARIZER_DEVICE=cuda \
    DIARIZER_MODEL=diar_streaming_sortformer_4spk-v2.1 \
    # TitaNet speaker embeddings
    EMBEDDER_MODEL=titanet_large \
    EMBEDDER_BACKEND=nemo \
    # STT via faster-whisper (GPU-accelerated)
    STT_ENABLED=true \
    STT_MODEL=small \
    STT_DEVICE=cuda \
    # Denoiser
    DENOISER_BACKEND=rnnoise \
    # VAD
    VAD_THRESHOLD=0.5

# ── Entrypoint: UDP audio source (receives from audio_bridge.py on host) ──────
CMD ["python", "-m", "fitaly_voice", "run", \
     "--mode", "redis", \
     "--source", "udp", \
     "--udp-port", "5005", \
     "--session", "session-001", \
     "--store", "store-001"]
