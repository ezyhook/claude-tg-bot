#!/bin/bash
# Speech to text, fully local (whisper.cpp). Usage: transcribe.sh <audio or video file>  -> prints the text.
# Any format is converted to 16 kHz mono WAV by ffmpeg; without ffmpeg only OGG/Opus (decode.mjs)
# and WAV/MP3/FLAC (read by whisper itself) work. STT_LANG=auto to detect the language (default ru).
set -eo pipefail
D="$(cd "$(dirname "$0")" && pwd)"
export PATH="$HOME/.local/node/bin:$PATH"
IN="$1"
WAV="$(mktemp --suffix=.wav)"
trap 'rm -f "$WAV"' EXIT
if command -v ffmpeg >/dev/null; then
  ffmpeg -loglevel error -y -i "$IN" -vn -ar 16000 -ac 1 "$WAV"
  IN="$WAV"
elif [ "$(head -c 4 "$IN")" = "OggS" ]; then
  node "$D/decode.mjs" "$IN" "$WAV"
  IN="$WAV"
fi
"$D/whisper.cpp/build/bin/whisper-cli" -m "$D/ggml-small-q5_1.bin" -l "${STT_LANG:-ru}" -t 6 -nt -np -f "$IN" 2>/dev/null \
  | sed 's/^[[:space:]]*//' | tr '\n' ' ' | sed 's/[[:space:]]*$//'
echo
