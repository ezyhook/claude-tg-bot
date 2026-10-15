// Telegram <-> Proton Lumo agent bridge (grammY + lumo-tamer OpenAI-compatible API)
// Works in the owner's forum group: every topic is its own Lumo session with its own queue,
// so topics don't mix and run in parallel. Messages in General go to the "main" session.
import { Bot, InlineKeyboard, Keyboard, InputFile } from "grammy";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mdToTgHtml, splitMarkdown } from "./md2tg.mjs";
import { runAgent, MODELS, DEFAULT_MODEL } from "./lumo.mjs";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = Number(process.env.ALLOWED_CHAT_ID);
const OWNER_ID = Number(process.env.OWNER_ID);
const WORK_DIR = process.env.WORK_DIR || process.cwd();
const STATE_FILE = new URL("./state.json", import.meta.url);

if (!TOKEN || !CHAT_ID || !OWNER_ID) throw new Error("TELEGRAM_BOT_TOKEN, ALLOWED_CHAT_ID и OWNER_ID обязательны (.env)");

// ---- persistent state: per-topic sessions survive restarts ----
// state.topics[key] = { name, sessionId, cwd, last }; key = message_thread_id or "main"
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { yolo: false };
state.topics ??= {};
const saveState = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const bot = new Bot(TOKEN);

// ---- topics ----
const MAIN = "main";
// the private chat is always a single session; only forum groups are split into topics
const keyOf = (msg) =>
  msg?.message_thread_id && msg.is_topic_message && msg.chat?.type !== "private" ? String(msg.message_thread_id) : MAIN;
const threadOf = (key) => (key === MAIN ? {} : { message_thread_id: Number(key) });
function topic(key) {
  return (state.topics[key] ??= { name: key === MAIN ? "Общий чат" : `тема ${key}`, sessionId: null, cwd: WORK_DIR, last: null });
}
const rt = new Map(); // key -> runtime: { queue, running, draining, alwaysAllowed }
function runtime(key) {
  if (!rt.has(key)) rt.set(key, { queue: [], running: null, draining: false, alwaysAllowed: new Set() });
  return rt.get(key);
}

// ---- helpers ----
// Messages are Markdown: converted to Telegram HTML; if Telegram rejects the markup, the chunk is sent as plain text
async function send(text, key = MAIN) {
  text = String(text ?? "").trim();
  if (!text) return;
  const where = threadOf(key);
  for (const chunk of splitMarkdown(text, 3000)) {
    await bot.api
      .sendMessage(CHAT_ID, mdToTgHtml(chunk), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...where })
      .catch(() => bot.api.sendMessage(CHAT_ID, chunk.slice(0, 4000), where))
      .catch((e) => console.error("send:", e.message));
  }
}
const action = (key, a = "typing") => bot.api.sendChatAction(CHAT_ID, a, threadOf(key)).catch(() => {});

// tool-call messages: state.verbose = "short" (first line, 200 chars) | "full" (whole command) | "off"
const VERBOSE = ["short", "full", "off"];
function describeTool(name, input) {
  const mode = state.verbose ?? "full";
  if (mode === "off") return "";
  const s = input.command ?? input.path ?? input.file_path ?? input.query ?? "";
  if (mode === "short") {
    const line = String(s).split("\n")[0];
    return `🔧 ${name}${line ? ": " + (line.length > 200 ? line.slice(0, 200) + "…" : line) : ""}`;
  }
  // full: the whole command / query; file writes show the path and size, not the file body
  if (input.command) return `🔧 ${name}:\n\`\`\`\n${String(input.command).replace(/```/g, "ˋˋˋ")}\n\`\`\``;
  if (name === "write_file" || name === "append_file")
    return `🔧 ${name}: ${input.path} (${String(input.content ?? "").split("\n").length} строк, ${String(input.content ?? "").length} символов)`;
  if (name === "edit_file")
    return `🔧 edit_file: ${input.path}\n- ${String(input.old_string ?? "").slice(0, 1500)}\n+ ${String(input.new_string ?? "").slice(0, 1500)}`;
  if (name === "read_file" || name === "list_dir")
    return `🔧 ${name}: ${input.path ?? "."}${input.start_line ? ` (${input.start_line}–${input.end_line ?? "…"})` : ""}`;
  const rest = JSON.stringify(input);
  return `🔧 ${name}: ${rest.length > 3500 ? rest.slice(0, 3500) + "…" : rest}`;
}

// ---- tool permission requests via inline buttons (in the topic that asked) ----
const pendingPerms = new Map(); // id -> { resolve, key }

const canUseToolFor = (key) => async (toolName, input, { signal }) => {
  const r = runtime(key);
  if (state.yolo || r.alwaysAllowed.has(toolName)) return { behavior: "allow", updatedInput: input };
  const id = randomUUID().slice(0, 8);
  const details = JSON.stringify(input, null, 2);
  const kb = new InlineKeyboard()
    .text("✅ Разрешить", `perm:${id}:allow`)
    .text("♾ Всегда", `perm:${id}:always`)
    .row()
    .text("❌ Запретить", `perm:${id}:deny`);
  await bot.api.sendMessage(
    CHAT_ID,
    `🔐 Запрос разрешения: ${toolName}\n\n${details.length > 3000 ? details.slice(0, 3000) + "…" : details}`,
    { reply_markup: kb, ...threadOf(key) },
  );
  const decision = await new Promise((resolve) => {
    pendingPerms.set(id, { resolve, key });
    signal?.addEventListener("abort", () => resolve("deny"));
  });
  pendingPerms.delete(id);
  if (decision === "always") r.alwaysAllowed.add(toolName);
  return decision === "deny"
    ? { behavior: "deny", message: "Пользователь запретил это действие." }
    : { behavior: "allow", updatedInput: input };
};

bot.callbackQuery(/^perm:(\w+):(allow|always|deny)$/, async (ctx) => {
  if (ctx.chat?.id !== CHAT_ID || ctx.from?.id !== OWNER_ID) return ctx.answerCallbackQuery();
  const [, id, decision] = ctx.match;
  const p = pendingPerms.get(id);
  const label = { allow: "✅ Разрешено", always: "♾ Разрешено всегда", deny: "❌ Запрещено" }[decision];
  await ctx.answerCallbackQuery({ text: p ? label : "Запрос устарел" });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  if (p) {
    await send(label, p.key);
    p.resolve(decision);
  }
});

// ---- Lumo runner: per topic one turn at a time (messages queued), topics in parallel ----
const PROMPT =
  "Пользователь общается с тобой через Telegram-бота. Отвечай кратко. Markdown рендерится частично: " +
  "работают **жирный**, `код`, блоки ```кода```, ~~зачёркнутый~~, [ссылки](url), заголовки # (станут жирными) " +
  "и списки \"- \". Не используй таблицы и одиночные *курсив*/_курсив_ — они не отображаются.";
const AGENT_PROMPT =
  " Ты — агент на Linux-машине пользователя. Действуй сам через инструменты (run_command, read_file, list_dir, " +
  "write_file, append_file, edit_file), не проси пользователя запускать команды. Никогда не пиши, что что-то сделал, " +
  "создал или запустил, пока не получил результат инструмента; если инструмент вернул ошибку — скажи об этом. " +
  "Файлы длиннее ~80 строк записывай частями: первая часть через write_file, остальные через append_file; " +
  "для правки существующих файлов используй edit_file. Долгие процессы запускай в фоне (nohup … > log 2>&1 &). " +
  "Никогда не выводи содержимое .env, токены и ключи.";

async function runTurn(key, prompt) {
  const t = topic(key), r = runtime(key);
  const typing = setInterval(() => action(key), 4000);
  action(key);
  const ac = new AbortController();
  r.running = { interrupt: async () => ac.abort() };
  if (!t.sessionId) {
    t.sessionId = randomUUID();
    saveState();
  }
  const cwd = t.cwd || WORK_DIR;
  try {
    const lastText = await runAgent({
      sessionId: t.sessionId,
      prompt,
      cwd,
      model: state.model || DEFAULT_MODEL,
      think: state.think,
      signal: ac.signal,
      system:
        PROMPT + AGENT_PROMPT +
        ` Рабочая папка: ${cwd}. Чат разбит на темы Telegram, у каждой темы своя сессия. Текущая тема: «${t.name}». ` +
        "Держись её; если пользователь просит о чём-то совсем другом, можно предложить завести для этого отдельную тему." +
        (t.voice ? VOICE_PROMPT : ""),
      onText: (text) => send(text, key),
      onTool: (name, input) => send(describeTool(name, input), key),
      approve: (name, input, signal) => canUseToolFor(key)(name, input, { signal }),
    });
    if (t.voice && lastText && !ac.signal.aborted) await sendVoice(lastText, key);
  } catch (e) {
    if (!ac.signal.aborted) {
      console.error(e);
      await send(`⚠️ Ошибка: ${e.message}`, key);
    }
  } finally {
    r.running = null;
    clearInterval(typing);
    t.last = new Date().toISOString();
    saveState();
  }
}

async function drain(key) {
  const r = runtime(key);
  if (r.draining) return;
  r.draining = true;
  try {
    while (r.queue.length) {
      const { prompt, msgId } = r.queue.shift();
      await runTurn(key, prompt);
      react(msgId, "👌");
    }
  } finally {
    r.draining = false;
  }
}

// in a group Telegram shows no "read" ticks for the bot, so reactions mark progress: 👀 received, 👌 answered
const react = (msgId, emoji) =>
  bot.api.setMessageReaction(CHAT_ID, msgId, [{ type: "emoji", emoji }]).catch((e) => console.error("react:", e.message));

// ---- access control: ignore everyone except the owner ----
bot.use(async (ctx, next) => {
  if (ctx.chat?.id !== CHAT_ID || ctx.from?.id !== OWNER_ID) {
    if (ctx.chat?.type === "private" && ctx.from?.id === OWNER_ID && ctx.message)
      return ctx.reply("Я переехал в группу Agent Space — пиши там.").catch(() => {});
    if (ctx.chat) console.log(`foreign chat: id=${ctx.chat.id} type=${ctx.chat.type} title=${ctx.chat.title ?? ""} from=${ctx.from?.id}`);
    return;
  }
  await next();
});

// topic names: remember them when a topic is created or renamed
bot.use(async (ctx, next) => {
  const m = ctx.msg;
  const created = m?.forum_topic_created ?? m?.reply_to_message?.forum_topic_created;
  const name = m?.forum_topic_edited?.name ?? created?.name;
  if (name && keyOf(m) !== MAIN && topic(keyOf(m)).name !== name) {
    topic(keyOf(m)).name = name;
    saveState();
  }
  await next();
});

const reply = (ctx, text, extra = {}) => bot.api.sendMessage(CHAT_ID, text, { ...threadOf(keyOf(ctx.msg)), ...extra });

// ---- reply-keyboard menu ----
const handlers = {};
const BTN = { new: "🆕 Новая сессия", stop: "⏹ Стоп", yolo: "⚡ YOLO", status: "ℹ️ Статус", topics: "🗂 Темы", hide: "🙈 Скрыть меню" };
// trading bot reports (~/algolab/report.mjs), answered directly without Lumo
const TRADE = {
  trade: { btn: "🤖 Робот", desc: "Торговый робот: состояние", arg: "status" },
  positions: { btn: "📂 Позиции", desc: "Открытые позиции", arg: "positions" },
  stats: { btn: "📈 Статистика", desc: "Статистика торговли", arg: "stats" },
  ls: { btn: "📊 Лонг/шорт", desc: "Соотношение лонг/шорт и сигналы", arg: "ls" },
  div: { btn: "📐 Дивергенции", desc: "Дивергенции RSI (1h/4h/1d)", arg: "div" },
};
const CHART = { btn: "📉 Графики", desc: "График лонг/шорт: /chart [SOL] [дней]" };
const menu = new Keyboard()
  .text(TRADE.trade.btn).text(TRADE.positions.btn).row()
  .text(TRADE.stats.btn).text(TRADE.ls.btn).row()
  .text(CHART.btn).text(TRADE.div.btn).row()
  .text(BTN.new).text(BTN.stop).row()
  .text(BTN.yolo).text(BTN.status).row()
  .text(BTN.topics).text(BTN.hide)
  .resized()
  .persistent();

bot.command("menu", (ctx) => reply(ctx, "📋 Меню", { reply_markup: menu }));
bot.hears(BTN.hide, (ctx) => reply(ctx, "Меню скрыто. Вернуть: /menu", { reply_markup: { remove_keyboard: true } }));

bot.command("start", (ctx) =>
  reply(
    ctx,
    "Привет! Пиши сообщения — я Lumo, агент на твоей машине: выполняю команды и работаю с файлами.\n\n" +
      "Каждая тема чата — отдельная сессия со своим контекстом. Новую тему создай в Telegram, первое сообщение в ней начнёт новую сессию.\n\n" +
      "/menu — показать меню\n/topics — список тем\n/new — новая сессия в этой теме\n/stop — прервать задачу в этой теме\n" +
      "/cwd [папка] — рабочая папка темы\n/model [lumo|lumo-lite|lumo-max] — модель\n/think — режим размышлений вкл/выкл\n" +
      "/voice — голосовые ответы вкл/выкл\n/yolo — вкл/выкл автоподтверждение действий\n/status — состояние\n\n" +
      "Торговый робот:\n/trade — состояние\n/positions — позиции\n/stats — статистика\n/ls — лонг/шорт и сигналы\n/div — дивергенции RSI\n/chart [монета] [дней] — графики",
    { reply_markup: menu },
  ),
);

const ALGOLAB = process.env.ALGOLAB_DIR || `${process.env.HOME}/algolab`;
function tradeReport(ctx, arg) {
  const key = keyOf(ctx.msg);
  action(key);
  execFile(process.execPath, ["report.mjs", arg], { cwd: ALGOLAB, timeout: 60e3 }, (err, stdout, stderr) =>
    send(err ? `⚠️ Отчёт не получен: ${(stderr || err.message).slice(0, 500)}` : stdout, key),
  );
}
// long/short charts (~/algolab/chart_ls.mjs): /chart -> all coins, /chart SOL 180 -> one coin, 180 days
function sendCharts(ctx, args = "") {
  const key = keyOf(ctx.msg);
  const [coinArg, daysArg] = args.trim().split(/\s+/);
  const coins = coinArg ? [coinArg.toUpperCase()] : ["BTC", "ETH", "SOL"];
  const days = Number(daysArg) > 30 ? String(Math.min(Number(daysArg), 1500)) : "365";
  for (const coin of coins) {
    if (!/^[A-Z0-9]{2,10}$/.test(coin)) return send("Формат: /chart [BTC|ETH|SOL] [дней]", key);
    action(key, "upload_photo");
    const out = `/tmp/ls_${coin}_${Date.now()}.png`;
    execFile(process.execPath, ["chart_ls.mjs", coin, days, out], { cwd: ALGOLAB, timeout: 120e3 }, (err, stdout, stderr) => {
      if (err) return send(`⚠️ График ${coin} не построен: ${(stderr || err.message).split("\n").find((l) => /Error|error/.test(l)) || err.message}`.slice(0, 500), key);
      bot.api
        .sendPhoto(CHAT_ID, new InputFile(out), { caption: `${coin}: цена и соотношение лонг/шорт с порогами экстремумов, ${days} дн.`, ...threadOf(key) })
        .catch((e) => send(`⚠️ ${e.message}`, key));
    });
  }
}
bot.command("chart", (ctx) => sendCharts(ctx, ctx.match));
bot.hears(CHART.btn, (ctx) => sendCharts(ctx));

for (const [cmd, t] of Object.entries(TRADE)) {
  bot.command(cmd, (ctx) => tradeReport(ctx, t.arg));
  bot.hears(t.btn, (ctx) => tradeReport(ctx, t.arg));
}

bot.hears(BTN.new, (ctx) => handlers.new(ctx));
bot.command("new", (ctx) => handlers.new(ctx));
handlers.new = async (ctx) => {
  const key = keyOf(ctx.msg);
  topic(key).sessionId = null;
  runtime(key).alwaysAllowed.clear();
  saveState();
  await reply(ctx, `🆕 В теме «${topic(key).name}» начата новая сессия.`);
};

bot.hears(BTN.stop, (ctx) => handlers.stop(ctx));
bot.command("stop", (ctx) => handlers.stop(ctx));
handlers.stop = async (ctx) => {
  const key = keyOf(ctx.msg), r = runtime(key);
  r.queue.length = 0;
  for (const p of pendingPerms.values()) if (p.key === key) p.resolve("deny");
  if (r.running) {
    await r.running.interrupt().catch(() => {});
    await reply(ctx, "⏹ Прервано.");
  } else await reply(ctx, "В этой теме сейчас ничего не выполняется.");
};

bot.hears(BTN.yolo, (ctx) => handlers.yolo(ctx));
bot.command("yolo", (ctx) => handlers.yolo(ctx));
handlers.yolo = async (ctx) => {
  state.yolo = !state.yolo;
  saveState();
  await reply(
    ctx,
    state.yolo
      ? "⚡ YOLO включён: все действия выполняются без подтверждения (со следующего сообщения)."
      : "🔐 YOLO выключен: опасные действия снова требуют подтверждения.",
  );
};

bot.command("model", async (ctx) => {
  const arg = String(ctx.match || "").trim().toLowerCase();
  if (arg && !MODELS.includes(arg)) return reply(ctx, `⚠️ Нет такой модели. Доступны: ${MODELS.join(", ")}`);
  if (arg) {
    state.model = arg;
    saveState();
  }
  await reply(ctx, `🧠 Модель: ${state.model || DEFAULT_MODEL}${arg ? " (со следующего сообщения)" : ""}\n/model ${MODELS.join(" | ")}`);
});

bot.command("think", async (ctx) => {
  const arg = String(ctx.match || "").trim().toLowerCase();
  state.think = arg === "on" ? true : arg === "off" ? false : !state.think;
  saveState();
  await reply(ctx, `${state.think ? "💭 Режим размышлений включён" : "⚡ Режим размышлений выключен"} (зависит от тарифа Proton).\n/think on | off`);
});

bot.command("verbose", async (ctx) => {
  const arg = String(ctx.match || "").trim().toLowerCase();
  state.verbose = VERBOSE.includes(arg) ? arg : VERBOSE[(VERBOSE.indexOf(state.verbose ?? "full") + 1) % VERBOSE.length];
  saveState();
  await reply(
    ctx,
    { short: "🔧 Технические сообщения: коротко (первая строка).", full: "🔧 Технические сообщения: полностью.", off: "🔧 Технические сообщения выключены." }[state.verbose] +
      "\n/verbose short | full | off",
  );
});

// working directory of the topic; sessions are stored per directory, so changing it starts a new session
bot.command("cwd", async (ctx) => {
  const key = keyOf(ctx.msg), t = topic(key);
  let dir = String(ctx.match || "").trim();
  if (!dir) return reply(ctx, `📁 Папка темы «${t.name}»: ${t.cwd || WORK_DIR}\nСменить: /cwd ~/папка (начнётся новая сессия)`);
  dir = dir.replace(/^~(?=\/|$)/, process.env.HOME);
  if (!existsSync(dir)) return reply(ctx, `⚠️ Нет такой папки: ${dir}`);
  t.cwd = dir;
  t.sessionId = null;
  saveState();
  await reply(ctx, `📁 Папка темы «${t.name}»: ${dir}. Начата новая сессия.`);
});

bot.hears(BTN.status, (ctx) => handlers.status(ctx));
bot.command("status", (ctx) => handlers.status(ctx));
handlers.status = (ctx) => {
  const key = keyOf(ctx.msg), t = topic(key), r = runtime(key);
  const busy = [...rt.entries()].filter(([, x]) => x.running).map(([k]) => topic(k).name);
  return reply(
    ctx,
    `Тема: ${t.name}\nСессия: ${t.sessionId ?? "новая"}\nПапка: ${t.cwd || WORK_DIR}\n` +
      `Выполняется здесь: ${r.running ? "да" : "нет"}, в очереди: ${r.queue.length}\n` +
      `Заняты темы: ${busy.length ? busy.join(", ") : "нет"}\n` +
      `Модель: ${state.model || DEFAULT_MODEL}, размышления: ${state.think ? "да" : "нет"}\n` +
      `YOLO: ${state.yolo ? "да" : "нет"}\nТехнические сообщения: ${state.verbose ?? "full"}`,
  );
};

bot.hears(BTN.topics, (ctx) => handlers.topics(ctx));
bot.command("topics", (ctx) => handlers.topics(ctx));
handlers.topics = (ctx) => {
  const list = Object.entries(state.topics)
    .sort(([, a], [, b]) => String(b.last).localeCompare(String(a.last)))
    .map(([k, t]) => `${rt.get(k)?.running ? "⏳" : t.sessionId ? "💬" : "▫️"} ${t.name}${t.last ? ` — ${t.last.slice(0, 16).replace("T", " ")} UTC` : ""}${t.cwd && t.cwd !== WORK_DIR ? ` (${t.cwd})` : ""}`);
  return reply(ctx, `🗂 Темы:\n${list.join("\n") || "пока нет"}\n\nНовая тема создаётся в Telegram; её первое сообщение начнёт отдельную сессию.`);
};

// prefix the prompt with the message being replied to, so Lumo sees what it refers to
// (in a topic, every message "replies" to the topic's service message — that one is skipped)
const QUOTE_MAX = 1500;
function withReplyContext(msg, text = msg.text) {
  const r = msg.reply_to_message;
  if (!r || r.forum_topic_created || (keyOf(msg) !== MAIN && r.message_id === msg.message_thread_id)) return text;
  // a partial quote (user selected a fragment) wins over the whole replied message
  let quoted = msg.quote?.text ?? r.text ?? r.caption ?? "[сообщение без текста]";
  if (quoted.length > QUOTE_MAX) quoted = quoted.slice(0, QUOTE_MAX) + "…";
  const author = r.from?.id === bot.botInfo.id ? "твоё сообщение" : "сообщение пользователя";
  return `[В ответ на ${author}:\n${quoted}]\n\n${text}`;
}

function enqueue(ctx, prompt) {
  const key = keyOf(ctx.msg), r = runtime(key);
  topic(key);
  r.queue.push({ prompt: withReplyContext(ctx.message, prompt), msgId: ctx.message.message_id });
  react(ctx.message.message_id, "👀");
  if (r.draining) reply(ctx, "⏳ Добавлено в очередь.").catch(() => {});
  drain(key); // not awaited: the update loop must stay free to handle permission buttons and other topics
}

// registered before message:text, otherwise the text handler swallows the command
bot.command("voice", async (ctx) => {
  const key = keyOf(ctx.msg), t = topic(key);
  const arg = String(ctx.match || "").trim().toLowerCase();
  if (["irina", "dmitri"].includes(arg)) state.ttsVoice = arg;
  else t.voice = arg === "on" ? true : arg === "off" ? false : !t.voice;
  saveState();
  await reply(
    ctx,
    `${t.voice ? "🔊 Голосовые ответы в теме «" + t.name + "» включены" : "🔇 Голосовые ответы в теме «" + t.name + "» выключены"}. ` +
      `Голос: ${state.ttsVoice || "dmitri"}.\n/voice on | off | irina | dmitri`,
  );
});

bot.on("message:text", (ctx) => enqueue(ctx, ctx.message.text));

// ---- photos, files and voice: saved to INBOX, Lumo gets the path (voice: a local whisper.cpp transcript)
const INBOX = process.env.INBOX_DIR || `${process.env.HOME}/tg-inbox`;
const STT = process.env.STT_SCRIPT || `${process.env.HOME}/.local/share/stt/transcribe.sh`;
mkdirSync(INBOX, { recursive: true });

async function download(fileId, name) {
  const file = await bot.api.getFile(fileId); // bots can download files up to 20 MB
  const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const safe = name.replace(/[^\w.\-а-яА-ЯёЁ]+/g, "_").slice(-120);
  const path = `${INBOX}/${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}_${safe}`;
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  return path;
}

const caption = (ctx) => (ctx.message.caption ? `\n${ctx.message.caption}` : "");
const fail = (ctx, e) => reply(ctx, `⚠️ Не удалось получить файл: ${e.message}`).catch(() => {});

bot.on("message:photo", async (ctx) => {
  try {
    const p = ctx.message.photo.at(-1); // largest size
    const path = await download(p.file_id, "photo.jpg");
    enqueue(ctx, `[Фото от пользователя: ${path}]${caption(ctx) || "\n(без подписи)"}`);
  } catch (e) {
    fail(ctx, e);
  }
});

bot.on("message:document", async (ctx) => {
  try {
    const d = ctx.message.document;
    const path = await download(d.file_id, d.file_name || "file");
    const kb = d.file_size ? `, ${Math.round(d.file_size / 1024)} КБ` : "";
    enqueue(ctx, `[Файл от пользователя: ${path} (${d.mime_type || "?"}${kb})]${caption(ctx) || "\n(без подписи)"}`);
  } catch (e) {
    fail(ctx, e);
  }
});

function transcribe(path) {
  return new Promise((resolve, reject) =>
    execFile(STT, [path], { timeout: 600e3, maxBuffer: 4 << 20 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim().split("\n").at(-1))) : resolve(stdout.trim()),
    ),
  );
}

bot.on(["message:voice", "message:audio", "message:video_note"], async (ctx) => {
  const key = keyOf(ctx.msg);
  const m = ctx.message.voice || ctx.message.audio || ctx.message.video_note;
  const typing = setInterval(() => action(key), 4000);
  try {
    const path = await download(m.file_id, ctx.message.audio?.file_name || (ctx.message.video_note ? "video_note.mp4" : "voice.ogg"));
    const text = await transcribe(path);
    if (!text) throw new Error("речь не распознана");
    await send(`🎤 Распознано: ${text}`, key);
    enqueue(ctx, `[Голосовое сообщение пользователя, расшифровка whisper (возможны ошибки распознавания); аудио: ${path}]\n${text}${caption(ctx)}`);
  } catch (e) {
    reply(ctx, `⚠️ Голосовое не распознано: ${e.message}`).catch(() => {});
  } finally {
    clearInterval(typing);
  }
});

// ---- voice replies (/voice): the final answer of a turn is also sent as a voice message, local piper TTS
const TTS = process.env.TTS_SCRIPT || `${process.env.HOME}/.local/share/tts/speak.sh`;
const VOICE_MAX = 1500; // chars; longer answers are voiced only up to here
const VOICE_PROMPT =
  " Озвучка включена: твой финальный ответ будет прочитан синтезатором речи. Пиши разговорно, короткими фразами, " +
  "без таблиц, эмодзи и длинных списков; код и пути давай только если без них никак.";

// markdown -> plain speakable text
function speakable(md) {
  let s = md
    .replace(/```[\s\S]*?```/g, " (код — в тексте) ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "(ссылка)")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/[*_~#|>]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (s.length > VOICE_MAX) s = s.slice(0, s.lastIndexOf(".", VOICE_MAX) + 1 || VOICE_MAX) + " Дальше — в тексте.";
  return s;
}

async function sendVoice(md, key) {
  const text = speakable(md);
  if (!text) return;
  action(key, "record_voice");
  const out = `${INBOX}/reply-${Date.now()}.ogg`;
  try {
    await new Promise((resolve, reject) =>
      execFile(TTS, [out, text], { timeout: 120e3, env: { ...process.env, TTS_VOICE: state.ttsVoice || "dmitri" } }, (err, _o, stderr) =>
        err ? reject(new Error((stderr || err.message).trim().split("\n").at(-1))) : resolve(),
      ),
    );
    await bot.api.sendVoice(CHAT_ID, new InputFile(out), threadOf(key));
  } catch (e) {
    await send(`⚠️ Озвучка не удалась: ${e.message}`, key);
  } finally {
    rmSync(out, { force: true });
  }
}

// ---- geolocation: a point, venue or the start of a live location (live updates arrive as edits and are ignored)
bot.on("message:location", (ctx) => {
  const { latitude: lat, longitude: lon, horizontal_accuracy: acc, live_period } = ctx.message.location;
  const v = ctx.message.venue;
  const what = v ? `Место «${v.title}», ${v.address}` : live_period ? "Трансляция геопозиции (первая точка)" : "Геопозиция";
  const extra = acc ? `, точность ~${Math.round(acc)} м` : "";
  enqueue(ctx, `[${what} от пользователя: ${lat.toFixed(6)}, ${lon.toFixed(6)}${extra}; https://maps.google.com/?q=${lat},${lon}]`);
});

bot.catch((err) => console.error("bot error:", err.error));

// one-time move to the forum group: old private-chat topics are dead; the trading session gets its own topic
if (state.chatId !== CHAT_ID) {
  const trade = Object.entries(state.topics).find(([k, t]) => k !== MAIN && t.name === "Торговый бот")?.[1];
  for (const k of Object.keys(state.topics)) if (k !== MAIN) delete state.topics[k];
  if (trade) {
    try {
      const t = await bot.api.createForumTopic(CHAT_ID, trade.name);
      state.topics[String(t.message_thread_id)] = { ...trade, last: new Date().toISOString() };
      await send(`🗂 Сюда перенесена сессия «${trade.name}».`, String(t.message_thread_id));
    } catch (e) {
      console.error("migration:", e.message);
    }
  }
  state.chatId = CHAT_ID;
  saveState();
}

await bot.api.setMyCommands([
  { command: "menu", description: "Показать меню" },
  { command: "topics", description: "Список тем" },
  { command: "new", description: "Новая сессия в этой теме" },
  { command: "stop", description: "Прервать задачу в этой теме" },
  { command: "cwd", description: "Рабочая папка темы" },
  { command: "model", description: "Модель: lumo / lumo-lite / lumo-max" },
  { command: "think", description: "Режим размышлений вкл/выкл" },
  { command: "yolo", description: "Автоподтверждение вкл/выкл" },
  { command: "status", description: "Состояние" },
  { command: "verbose", description: "Технические сообщения: short / full / off" },
  { command: "voice", description: "Голосовые ответы вкл/выкл, голос irina / dmitri" },
  ...Object.entries(TRADE).map(([command, t]) => ({ command, description: t.desc })),
  { command: "chart", description: CHART.desc },
]);
// replaces any old reply keyboard in the chat with the new menu
await bot.api.sendMessage(CHAT_ID, "🟢 Бот запущен. Пиши!", { reply_markup: menu }).catch((e) => console.error("send:", e.message));
console.log("Bot started");
bot.start({ drop_pending_updates: true });

for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => bot.stop().then(() => process.exit(0)));
