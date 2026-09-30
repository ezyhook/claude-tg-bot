#!/bin/bash
# Text to speech, fully local (piper). Usage: speak.sh <out.ogg> [text]  (text from stdin if omitted)
# Output is OGG/Opus, ready for Telegram sendVoice. TTS_VOICE=irina|dmitri (default dmitri).
set -eo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
OUT="$1"; shift
TEXT="${*:-$(cat)}"
WAV="$(mktemp --suffix=.wav)"
trap 'rm -f "$WAV"' EXIT
printf '%s' "$TEXT" | "$D/piper/piper" -q -m "$D/ru_RU-${TTS_VOICE:-dmitri}-medium.onnx" -f "$WAV" >/dev/null
ffmpeg -loglevel error -y -i "$WAV" -c:a libopus -b:a 32k -ac 1 "$OUT"
