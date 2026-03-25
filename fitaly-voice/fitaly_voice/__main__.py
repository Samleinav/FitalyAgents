"""
fitaly-voice CLI

Commands:
  run     Start the audio pipeline (mic or file source)
  enroll  Enroll a known speaker into the AOSC cache

Examples:
  python -m fitaly_voice run --mode stdout --source file --path audio.wav --session s-001
  python -m fitaly_voice run --mode redis --session s-001 --store store-001
  python -m fitaly_voice enroll --id emp:alice --name Alice --role employee --audio alice.wav
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from .config import PipelineConfig


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="fitaly_voice",
        description="FitalyVoice — local audio diarization pipeline",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # ── run ──────────────────────────────────────────────────────────────────
    run_p = sub.add_parser("run", help="Start the audio pipeline")
    run_p.add_argument("--mode", choices=["redis", "stdout"], default="redis",
                       help="Bus adapter (default: redis)")
    run_p.add_argument("--source", choices=["mic", "file", "udp"], default="mic",
                       help="Audio source: mic | file | udp (default: mic)")
    run_p.add_argument("--path", help="Path to WAV file (required when --source file)")
    run_p.add_argument("--udp-port", type=int, default=5005,
                       help="UDP port for audio bridge (default: 5005, --source udp only)")
    run_p.add_argument("--session", default="session-001", help="Session ID")
    run_p.add_argument("--store", default="store-001", help="Store ID")
    run_p.add_argument("--redis-url", default="redis://localhost:6379")
    run_p.add_argument("--cache", help="Path to aosc_cache.npz")

    # ── enroll ────────────────────────────────────────────────────────────────
    enroll_p = sub.add_parser("enroll", help="Enroll a known speaker")
    enroll_p.add_argument("--id", required=True, dest="speaker_id",
                          help="Speaker ID (e.g. emp:alice)")
    enroll_p.add_argument("--name", required=True, help="Speaker display name")
    enroll_p.add_argument("--role", default="employee",
                          choices=["employee", "customer"], help="Speaker role")
    enroll_p.add_argument("--audio", required=True, help="WAV file with speaker audio sample")
    enroll_p.add_argument("--cache", default="aosc_cache.npz",
                          help="Cache file to write/update (default: aosc_cache.npz)")
    enroll_p.add_argument("--embedder", default="titanet_large",
                          help="NeMo embedder model name")

    return parser


async def _run(args) -> None:
    from .pipeline import FitalyVoicePipeline, FileSource, MicrophoneSource, UDPSource

    config = PipelineConfig.from_env()
    config.bus_mode = args.mode
    config.store_id = args.store
    config.redis_url = args.redis_url
    if args.cache:
        config.aosc_cache_path = args.cache

    if args.source == "file":
        if not args.path:
            print("error: --path required when --source file", file=sys.stderr)
            sys.exit(1)
        source = FileSource(args.path, chunk_ms=config.chunk_ms)
    elif args.source == "udp":
        source = UDPSource(port=args.udp_port, sample_rate=config.sample_rate,
                           chunk_ms=config.chunk_ms)
    else:
        source = MicrophoneSource(sample_rate=config.sample_rate, chunk_ms=config.chunk_ms)

    pipeline = FitalyVoicePipeline(config)
    print(f"[fitaly-voice] Starting pipeline — session={args.session} store={args.store} "
          f"bus={args.mode}", flush=True)

    try:
        await pipeline.run(source, args.session)
    except KeyboardInterrupt:
        pass
    finally:
        await pipeline.shutdown()
        print("[fitaly-voice] Shutdown complete.", flush=True)


def _enroll(args) -> None:
    import wave
    import numpy as np
    from .speaker_cache import AoscSpeakerCache

    print(f"[fitaly-voice] Loading audio: {args.audio}")
    with wave.open(args.audio, "rb") as wf:
        sample_rate = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    cache = AoscSpeakerCache(
        embedder_model=args.embedder,
        threshold=0.75,
        cache_path=args.cache if __import__("os").path.exists(args.cache) else None,
    )

    print(f"[fitaly-voice] Extracting embedding for {args.speaker_id}...")
    cache.enroll(args.speaker_id, args.name, args.role, audio, sample_rate)
    cache.save(args.cache)
    print(f"[fitaly-voice] Enrolled {args.speaker_id} ({args.name}) → {args.cache}")


def main() -> None:
    parser = _build_parser()
    args = parser.parse_args()

    if args.command == "run":
        asyncio.run(_run(args))
    elif args.command == "enroll":
        _enroll(args)


if __name__ == "__main__":
    main()
