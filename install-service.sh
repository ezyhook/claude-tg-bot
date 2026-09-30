#!/bin/bash
# Installs the bot as a systemd service (autostart). Run: sudo ./install-service.sh
set -e
cd "$(dirname "$0")"
sudo -u arch ./run.sh stop || true
install -m 644 claude-tg-bot.service /etc/systemd/system/claude-tg-bot.service
systemctl daemon-reload
systemctl enable --now claude-tg-bot
systemctl --no-pager status claude-tg-bot | head -5
