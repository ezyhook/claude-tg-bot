#!/bin/bash
# Installs everything the bot needs besides npm packages: system tools (ffmpeg, build tools),
# local speech-to-text (whisper.cpp + small-q5_1 model) and text-to-speech (piper + Russian voices).
# Idempotent: already installed parts are skipped. Usage: ./install-deps.sh
set -eo pipefail
cd "$(dirname "$0")"
REPO="$PWD"
STT="$HOME/.local/share/stt"
TTS="$HOME/.local/share/tts"
ok() { echo "✔ $*"; }
step() { echo "→ $*"; }
fetch() { [ -s "$2" ] && return 0; step "скачиваю $(basename "$2")"; curl -fL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; }

# ---- system packages (needs root) ----
need=()
for cmd in ffmpeg:ffmpeg git:git cmake:cmake make:make gcc:gcc g++:gcc curl:curl tar:tar; do
  command -v "${cmd%%:*}" >/dev/null || need+=("${cmd##*:}")
done
if [ ${#need[@]} -gt 0 ]; then
  mapfile -t need < <(printf '%s\n' "${need[@]}" | sort -u)
  SUDO=$([ "$(id -u)" = 0 ] || echo sudo)
  if command -v pacman >/dev/null; then $SUDO pacman -S --needed --noconfirm "${need[@]}"
  elif command -v apt-get >/dev/null; then
    need=("${need[@]/gcc/build-essential}"); $SUDO apt-get update && $SUDO apt-get install -y "${need[@]}"
  else echo "Установите вручную: ${need[*]}"; exit 1
  fi
fi
ok "системные утилиты: ffmpeg, git, cmake, gcc"

# ---- node (only checked: installed separately) ----
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
command -v node >/dev/null || { echo "✘ нет Node.js (>=20.3): https://nodejs.org/en/download"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=3)?0:1)' \
  || { echo "✘ нужен Node.js >= 20.3 (сейчас $(node -v))"; exit 1; }
ok "node $(node -v)"

# ---- speech to text: whisper.cpp ----
mkdir -p "$STT"
cp deps/stt/transcribe.sh deps/stt/decode.mjs deps/stt/package.json "$STT/"
chmod +x "$STT/transcribe.sh"
[ -d "$STT/whisper.cpp" ] || git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$STT/whisper.cpp"
if [ ! -x "$STT/whisper.cpp/build/bin/whisper-cli" ]; then
  step "собираю whisper.cpp (несколько минут)"
  cmake -S "$STT/whisper.cpp" -B "$STT/whisper.cpp/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
  cmake --build "$STT/whisper.cpp/build" --target whisper-cli -j"$(nproc)" >/dev/null
fi
fetch https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin "$STT/ggml-small-q5_1.bin"
[ -d "$STT/node_modules" ] || (cd "$STT" && npm install --silent)
ok "распознавание речи: $STT/transcribe.sh"

# ---- text to speech: piper ----
mkdir -p "$TTS"
cp deps/tts/speak.sh "$TTS/"
chmod +x "$TTS/speak.sh"
if [ ! -x "$TTS/piper/piper" ]; then
  arch=$(uname -m); [ "$arch" = arm64 ] && arch=aarch64
  fetch "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_$arch.tar.gz" "$TTS/piper.tar.gz"
  tar -xzf "$TTS/piper.tar.gz" -C "$TTS" && rm "$TTS/piper.tar.gz"
fi
for v in dmitri irina; do
  base="https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/$v/medium/ru_RU-$v-medium.onnx"
  fetch "$base" "$TTS/ru_RU-$v-medium.onnx"
  fetch "$base.json" "$TTS/ru_RU-$v-medium.onnx.json"
done
ok "синтез речи: $TTS/speak.sh (голоса dmitri, irina)"

# ---- bot's own npm packages ----
[ -d "$REPO/node_modules" ] || (cd "$REPO" && npm ci --silent)
ok "npm-пакеты бота"
[ -f "$REPO/.env" ] || echo "⚠ создайте .env по образцу .env.example"
echo "Готово."
