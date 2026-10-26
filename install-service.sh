#!/bin/bash
# Installs the bot as a systemd user service (autostart, restart on crash) for the current user, no root needed.
# Paths come from the unit's %h (home directory): the repo must be at ~/claude-tg-bot, node at ~/.local/node.
# For autostart without a login session, once: sudo loginctl enable-linger "$USER"
set -e
cd "$(dirname "$0")"
./run.sh stop 2>/dev/null || true
mkdir -p ~/.config/systemd/user
install -m 644 claude-tg-bot.service ~/.config/systemd/user/claude-tg-bot.service
systemctl --user daemon-reload
systemctl --user enable --now claude-tg-bot
systemctl --user --no-pager status claude-tg-bot | head -5
loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes || echo "⚠ для автозапуска без входа в систему: sudo loginctl enable-linger $USER"
