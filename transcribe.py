#!/usr/bin/env python3
"""
Whisper transcription helper — called by the Electron main process.
Outputs JSON to stdout: {"words": [{word, start, end}], "language": str}
"""
import sys
import json


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: transcribe.py <audio_path> [model_size]"}))
        sys.exit(1)

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(json.dumps({
            "error": "faster-whisper not installed. Run: pip install faster-whisper"
        }))
        sys.exit(1)

    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, info = model.transcribe(audio_path, word_timestamps=True)

        words = []
        for segment in segments:
            for word in segment.words:
                words.append({
                    "word":  word.word.strip(),
                    "start": round(word.start, 4),
                    "end":   round(word.end,   4),
                })

        print(json.dumps({"words": words, "language": info.language}))

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
