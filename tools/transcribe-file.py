#!/usr/bin/env python3
"""Offline, opt-in Whisper transcription helper.

The caller supplies all arguments as an argv array. This helper never downloads
models and emits exactly one JSON object on stdout.
"""

import argparse
import json
import os
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--device", required=True)
    parser.add_argument("--compute-type", required=True)
    parser.add_argument("--language", default="")
    parser.add_argument("--max-audio-seconds", type=float, required=True)
    parser.add_argument("--max-output-chars", type=int, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    if not os.path.isdir(args.model):
        print(json.dumps({"error": "model_missing"}, ensure_ascii=False))
        return 2
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:
        print(json.dumps({"error": "provider_dependency_missing", "detail": str(exc)[:300]}, ensure_ascii=False))
        return 3
    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type, download_root=None)
        segments, _ = model.transcribe(args.input, language=args.language or None)
        pieces = []
        elapsed = 0.0
        for segment in segments:
            elapsed = max(elapsed, float(getattr(segment, "end", 0.0) or 0.0))
            if elapsed > args.max_audio_seconds:
                print(json.dumps({"error": "audio_duration_limit"}, ensure_ascii=False))
                return 4
            pieces.append(str(getattr(segment, "text", "")))
            if sum(len(item) for item in pieces) > args.max_output_chars:
                print(json.dumps({"error": "output_limit"}, ensure_ascii=False))
                return 5
        print(json.dumps({"text": " ".join(pieces).strip(), "model": args.model, "elapsedMs": int((time.monotonic() - started) * 1000)}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"error": "transcription_failed", "detail": str(exc)[:300]}, ensure_ascii=False))
        return 6


if __name__ == "__main__":
    sys.exit(main())
