require('dotenv').config();
const { Telegraf } = require('telegraf');
const sqlite = require('sqlite');
const sqlite3 = require('sqlite3');

const bot = new Telegraf(process.env.BOT_TOKEN);

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SOURCE_CHAT_ID = process.env.SOURCE_CHAT_ID;
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 10 * 60 * 1000;
const TIMEOUT = (parseInt(process.env.TIMEOUT_MINUTES) || 45) * 60 * 1000;

let db;
async function initDb() {
  db = await sqlite.open({ filename: './bot.db', driver: sqlite3.Database });
  await db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      last_seen INTEGER
    );
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS ignore_list (
      user_id INTEGER PRIMARY KEY
    );
  `);
}

initDb().then(() => console.log('DB ready')).catch(console.error);

// helper: check admin
function isAdmin(ctx) {
  return String(ctx.chat.id) === ADMIN_CHAT_ID;
}

// Source chat: фото — обновляем last_seen
bot.on('photo', async (ctx) => {
  if (String(ctx.chat.id) !== SOURCE_CHAT_ID) return;
  const uid = ctx.from.id;
  const username = ctx.from.username || '';
  const now = Date.now();
  await db.run(`
    INSERT INTO users (user_id, username, last_seen)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      last_seen = excluded.last_seen;
  `, [uid, username, now]);
  ctx.reply('Фото получено, спасибо!');
});

// Команды администратора: ignore / unignore
bot.command('ignore', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ')[1];
  if (!args) return ctx.reply('Укажите user_id');
  const uid = parseInt(args);
  if (isNaN(uid)) return ctx.reply('Неверный формат ID');
  await db.run('INSERT OR IGNORE INTO ignore_list(user_id) VALUES (?)', [uid]);
  ctx.reply(`Пользователь ${uid} добавлен в ignore-лист.`);
});

bot.command('unignore', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const args = ctx.message.text.split(' ')[1];
  if (!args) return ctx.reply('Укажите user_id');
  const uid = parseInt(args);
  if (isNaN(uid)) return ctx.reply('Неверный формат ID');
  await db.run('DELETE FROM ignore_list WHERE user_id = ?', [uid]);
  ctx.reply(`Пользователь ${uid} удалён из ignore-листа.`);
});

// Команда статуса: показать всех и время с последнего фото
bot.command('status', async (ctx) => {
  if (!isAdmin(ctx)) return;
  const rows = await db.all('SELECT user_id, username, last_seen FROM users');
  if (!rows.length) return ctx.reply('Нет данных о пользователях.');
  const now = Date.now();
  let msg = '📝 Статус активности:\n\n';
  for (const { user_id, username, last_seen } of rows) {
    const diff = Math.floor((now - last_seen) / 60000);
    msg += • ID ${user_id}${username ?  (@${username})` : ''}: ${diff} мин назад\n`;
  }
  ctx.reply(msg);
});

// Периодическая проверка
setInterval(async () => {
  const now = Date.now();
  const users = await db.all('SELECT user_id, username, last_seen FROM users');
  const ignore = await db.all('SELECT user_id FROM ignore_list');
  const ignoreSet = new Set(ignore.map(r => r.user_id));
  for (const u of users) {
    if (ignoreSet.has(u.user_id)) continue;
    if (now - u.last_seen > TIMEOUT) {
      await bot.telegram.sendMessage(
        REPORT_CHAT_ID,
        ⚠️ Пользователь ${u.username ? `@${u.username} : ''} (ID ${u.user_id}) не отправлял фото более ${process.env.TIMEOUT_MINUTES} мин`
      );
      await db.run('UPDATE users SET last_seen = ? WHERE user_id = ?', [now, u.user_id]);
    }
  }
}, CHECK_INTERVAL);

// Запуск
bot.launch().then(() => console.log('Bot запущен'));

// graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
