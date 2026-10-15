// Установить фото группы: node --env-file=.env set-photo.mjs
import { Bot, InputFile } from "grammy";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = Number(process.env.ALLOWED_CHAT_ID);
const photoPath = "/home/user/claude-tg-bot/assets/lumospace-logo-512.jpg";

if (!token || !chatId) {
  console.error("Нужны TELEGRAM_BOT_TOKEN и ALLOWED_CHAT_ID в .env");
  process.exit(1);
}

const bot = new Bot(token);

try {
  await bot.api.setChatPhoto(chatId, new InputFile(photoPath));
  console.log("Фото группы обновлено!");
} catch (e) {
  console.error("Ошибка:", e.message);
  process.exit(1);
}
