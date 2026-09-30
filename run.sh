#!/bin/bash
# Starts the bot in the background with auto-restart. Usage: ./run.sh [stop]
cd "$(dirname "$0")"
export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$PATH"
if [ -f bot.pid ] && kill -0 "$(cat bot.pid)" 2>/dev/null; then
  [ "$1" = stop ] && { kill -- -"$(cat bot.pid)" 2>/dev/null; rm -f bot.pid; echo stopped; exit; }
  echo "already running (pid $(cat bot.pid))"; exit
fi
[ "$1" = stop ] && { echo "not running"; exit; }
setsid nohup bash -c 'while true; do node --env-file=.env bot.mjs; echo "restart in 5s"; sleep 5; done' >> bot.log 2>&1 &
echo $! > bot.pid
echo "started (pid $!), log: $(pwd)/bot.log"
