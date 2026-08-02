#!/usr/bin/env python3
"""Offline, opt-in Whisper transcription helper.

The caller supplies all arguments as an argv array. This helper never downloads
models and emits exactly one UTF-8 JSON object on stdout.
"""

import argparse
import json
import os
import sys
import time


def configure_utf8_stdio():
    """Make the Node/Python process boundary independent of Windows code pages."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def main():
    configure_utf8_stdio()
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
    except Exception:
        print(json.dumps({"error": "provider_dependency_missing"}, ensure_ascii=False))
        return 3
    try:
        model = WhisperModel(
            args.model,
            device=args.device,
            compute_type=args.compute_type,
            local_files_only=True,
        )
        segments, _ = model.transcribe(
            args.input,
            language=args.language or None,
            vad_filter=True,
        )
        pieces = []
        total_chars = 0
        elapsed = 0.0
        for segment in segments:
            elapsed = max(elapsed, float(getattr(segment, "end", 0.0) or 0.0))
            if elapsed > args.max_audio_seconds:
                print(json.dumps({"error": "audio_duration_limit"}, ensure_ascii=False))
                return 4
            text = str(getattr(segment, "text", ""))
            total_chars += len(text)
            if total_chars > args.max_output_chars:
                print(json.dumps({"error": "output_limit"}, ensure_ascii=False))
                return 5
            pieces.append(text)
        print(json.dumps({"text": "".join(pieces).strip(), "model": args.model, "elapsedMs": int((time.monotonic() - started) * 1000)}, ensure_ascii=False))
        return 0
    except Exception:
        print(json.dumps({"error": "transcription_failed"}, ensure_ascii=False))
        return 6


if __name__ == "__main__":
    sys.exit(main())
