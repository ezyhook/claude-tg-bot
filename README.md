# claude-tg-bot (Lumo edition)

Telegram ↔ [Proton Lumo](https://lumo.proton.me/): бот-агент на вашей машине. Lumo выполняет команды и работает с файлами, а вы подтверждаете действия кнопками. Бот работает в форум-группе, и каждая тема — отдельная сессия.

Кроме агента в боте есть голосовой ввод (локальный whisper.cpp), голосовые ответы (локальный piper), приём фото и файлов, а также торговые команды.

Lumo подключается через [lumo-tamer](https://github.com/ZeroTricks/lumo-tamer), OpenAI-совместимый прокси. Готовый стек с ним — [ai-stack](https://github.com/ezyhook/ai-stack).

## Установка

Нужен Node.js ≥ 20.3 и запущенный lumo-tamer.

```bash
git clone git@github.com:ezyhook/claude-tg-bot.git && cd claude-tg-bot
./install-deps.sh          # ffmpeg, whisper.cpp + модель, piper + голоса, npm-пакеты
cp .env.example .env       # токен бота, id группы и владельца, LUMO_API_KEY
./run.sh                   # фоном с автоперезапуском, лог: bot.log (остановить: ./run.sh stop)
```

Вместо `run.sh` можно установить systemd-сервис: `sudo ./install-service.sh`.

### `.env`

| Переменная | Что это |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен от @BotFather |
| `ALLOWED_CHAT_ID` | id форум-группы, в которой работает бот |
| `OWNER_ID` | ваш Telegram id; остальных бот игнорирует |
| `WORK_DIR` | рабочая папка по умолчанию |
| `LUMO_BASE_URL` | адрес API lumo-tamer: `http://tamer:3003/v1` внутри ai-stack (например, если бот запущен в open-terminal), `http://127.0.0.1:3003/v1` на хосте |
| `LUMO_API_KEY` | `server.apiKey` из `config.yaml` lumo-tamer (в ai-stack это `LUMO_API_KEY` из `.env`) |
| `LUMO_MODEL` | `lumo`, `lumo-lite` или `lumo-max` |

Проверка доступа к API:

```bash
curl -H "Authorization: Bearer $LUMO_API_KEY" "$LUMO_BASE_URL/models"
```

В `config.yaml` lumo-tamer обязательно должно быть `server.customTools.enabled: true`, иначе Lumo не получит инструменты.

## Как это работает

На каждое сообщение бот отправляет Lumo историю темы и список инструментов. Если Lumo просит инструмент, бот выполняет его (при необходимости спрашивает разрешения кнопками), отдаёт результат Lumo и повторяет цикл, пока Lumo не ответит текстом.

| Инструмент | Подтверждение |
|---|---|
| `read_file`, `list_dir` | не нужно |
| `run_command`, `write_file`, `append_file`, `edit_file` | кнопки ✅ / ♾ / ❌, либо без вопросов в режиме `/yolo` |

История каждой темы хранится в `sessions/<id>.json` и сохраняется при перезапуске. `/new` начинает тему заново.

## Команды

`/new` — новая сессия в теме, `/stop` — прервать, `/cwd` — рабочая папка темы, `/model` — модель, `/think` — режим размышлений, `/yolo` — автоподтверждение, `/verbose` — подробность сообщений об инструментах, `/voice` — голосовые ответы, `/status`, `/topics`, `/menu`.

## Ограничения

- Вызов инструментов в lumo-tamer экспериментальный. Lumo иногда «забывает» вызвать инструмент и при этом пишет, что всё сделал. Проверяйте по сообщениям 🔧: если такого сообщения не было, действие не выполнялось.
- Длинные файлы Lumo упаковывает в вызов ненадёжно. Поэтому в промпте ему сказано писать файлы частями (`write_file` + `append_file`) и править через `edit_file`.
- При «промахнувшемся» вызове инструмента его аргументы могут уйти на серверы Proton (подробности в документации lumo-tamer). Не давайте боту команды с секретами.
