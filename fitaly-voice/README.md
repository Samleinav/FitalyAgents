# fitaly-voice

Local audio diarization and speaker identification pipeline for FitalyAgents.

Sits **before** the Node.js bus and handles:
1. **VAD** — Silero VAD filters silence and distant voices
2. **Denoising** — RNNoise removes background noise (spectral gating fallback)
3. **Diarization** — NeMo SortFormer `diar_streaming_sortformer_4spk-v2.1` (up to 4 speakers)
4. **AOSC Speaker Cache** — TitaNet embeddings identify known speakers (employees) across sessions
5. **Bus adapter** — Publishes FitalyAgents events to Redis pub/sub

No changes to the Node.js side are required. `TargetGroupBridge`, `ContextBuilderAgent`, and
`InteractionAgent` already consume the events published here.

---

## Requirements

- Python 3.10+
- NVIDIA GPU with CUDA (for NeMo SortFormer + TitaNet inference)
- Redis (for production mode)

```bash
pip install -e ".[dev]"     # development (includes pytest)
pip install -e .             # production
```

---

## Quickstart

### Dev mode (stdout, no Redis, file source)

```bash
python -m fitaly_voice run \
  --mode stdout \
  --source file \
  --path path/to/audio.wav \
  --session s-001 \
  --store store-001
```

Events are printed as JSON to stdout:
```json
{"channel": "bus:SPEAKER_DETECTED", "event": "SPEAKER_DETECTED", "session_id": "s-001", "speaker_id": "emp:alice", "store_id": "store-001"}
```

### Production mode (Redis, microphone)

```bash
export REDIS_URL=redis://localhost:6379
export STORE_ID=store-bcn-001
export AOSC_CACHE_PATH=/data/aosc_cache.npz

python -m fitaly_voice run --mode redis --session s-001
```

Verify events on Redis:
```bash
redis-cli subscribe 'bus:SPEAKER_DETECTED' 'bus:SPEAKER_LOST' 'bus:SPEECH_PARTIAL'
```

---

## Enroll Known Speakers (Employees)

Record a short audio sample (10–30 seconds) of clear speech for each employee:

```bash
# Enroll Alice
python -m fitaly_voice enroll \
  --id emp:alice \
  --name Alice \
  --role employee \
  --audio samples/alice.wav \
  --cache aosc_cache.npz

# Enroll Bob
python -m fitaly_voice enroll \
  --id emp:bob \
  --name Bob \
  --role employee \
  --audio samples/bob.wav \
  --cache aosc_cache.npz
```

The cache file (`aosc_cache.npz`) accumulates all enrolled speakers. Pass it to the pipeline:

```bash
python -m fitaly_voice run --cache aosc_cache.npz --mode redis --session s-001
```

---

## Multi-Source Deployment (Multiple Microphones)

For multiple rooms or mic arrays, run one pipeline process per source:

```bash
# Room A
STORE_ID=store-001 python -m fitaly_voice run \
  --mode redis --session room-a --cache aosc_cache.npz &

# Room B
STORE_ID=store-001 python -m fitaly_voice run \
  --mode redis --session room-b --cache aosc_cache.npz &
```

The AOSC cache file is read-only at startup — multiple processes can share it safely.
For concurrent enrollment, run sequentially and reload.

---

## Audio Flow

```
Microphone / WAV file
  │
  ▼ SileroVAD.filter_chunks()
  │   Drops silence and low-energy (distant) frames
  │
  ▼ AudioDenoiser.denoise()
  │   RNNoise (preferred) or spectral gating
  │
  ▼ SortFormerDiarizer.process_chunk()
  │   NeMo SortFormer — up to 4 speakers
  │   Stable speaker labels per session (sliding context window)
  │
  ▼ AoscSpeakerCache.get_embedding() → .identify()
  │   TitaNet-Large (192-dim), cosine similarity
  │   Known → "emp:alice" | Unknown → "unk:session:speaker_0"
  │
  ▼ RedisBusAdapter / StdoutBusAdapter
      SPEAKER_DETECTED  →  bus:SPEAKER_DETECTED
      SPEAKER_LOST      →  bus:SPEAKER_LOST
      SPEECH_PARTIAL    →  bus:SPEECH_PARTIAL    (if STT plugged in)
      AMBIENT_CONTEXT   →  bus:AMBIENT_CONTEXT
```

---

## Integration with FitalyAgents

| Node.js component | Consumes | Schema |
|---|---|---|
| `TargetGroupBridge` | `bus:SPEAKER_DETECTED`, `bus:SPEAKER_LOST` | `TargetDetectedEventSchema` |
| `ContextBuilderAgent` | `bus:AMBIENT_CONTEXT` | `AmbientContextEventSchema` |
| `InteractionAgent` | `bus:SPEECH_PARTIAL` | `SpeechPartialEventSchema` |

Schemas defined in `packages/core/src/types/index.ts`.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |
| `STORE_ID` | `store-001` | Store identifier (included in SPEAKER_DETECTED) |
| `BUS_MODE` | `redis` | `redis` or `stdout` |
| `VAD_THRESHOLD` | `0.5` | Silero VAD speech probability threshold (0–1) |
| `VAD_MIN_SPEECH_MS` | `300` | Minimum speech duration to open a segment |
| `VAD_MAX_SILENCE_MS` | `500` | Max silence tolerated before closing a segment |
| `DENOISER_BACKEND` | `rnnoise` | `rnnoise` or `spectral` |
| `DIARIZER_MODEL` | `diar_streaming_sortformer_4spk-v2.1` | NeMo model name |
| `DIARIZER_DEVICE` | `cuda` | PyTorch device (`cuda` or `cpu`) |
| `DIARIZER_CHUNK_S` | `1.0` | Audio chunk duration in seconds |
| `EMBEDDER_MODEL` | `titanet_large` | TitaNet model for speaker embeddings |
| `AOSC_THRESHOLD` | `0.75` | Cosine similarity threshold for speaker identification |
| `AOSC_CACHE_PATH` | _(none)_ | Path to `.npz` cache file |
| `SAMPLE_RATE` | `16000` | Audio sample rate in Hz |

---

## Running Tests

Tests mock NeMo models — no GPU required:

```bash
cd fitaly-voice
pip install -e ".[dev]"
pytest tests/ -v
```

---

## License

AGPL-3.0-only WITH Commons-Clause — same as FitalyAgents.
