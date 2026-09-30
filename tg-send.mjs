// Send a message to the owner from the command line: node --env-file=.env tg-send.mjs "text"
import { Api } from "grammy";

const text = process.argv.slice(2).join(" ") || (await new Response(process.stdin).text());
await new Api(process.env.TELEGRAM_BOT_TOKEN).sendMessage(Number(process.env.ALLOWED_CHAT_ID), text.slice(0, 4000));
