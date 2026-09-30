# claude-tg-bot

Telegram ↔ Claude Code bridge (grammY + Claude Agent SDK). Works in a forum group: every topic is its own Claude session.
Voice in (local whisper.cpp), voice out (local piper), photos/files, trading commands.

## Установка

```bash
git clone git@github.com:ezyhook/claude-tg-bot.git && cd claude-tg-bot
./install-deps.sh          # ffmpeg, whisper.cpp + модель, piper + голоса, npm-пакеты
cp .env.example .env       # заполнить токен, id группы и владельца
./install-service.sh       # systemd-сервис claude-tg-bot
```

Нужны заранее: Node.js ≥ 18 и Claude Code CLI (`curl -fsSL https://claude.ai/install.sh | bash`).
