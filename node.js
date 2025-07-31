require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite = require('sqlite');
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');

const logStream = fs.createWriteStream(path.join(__dirname, 'bot.log'), { flags: 'a' });
const log = (message, level = 'INFO') => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}\n`;
  logStream.write(logMessage);
  console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](logMessage);
};

const bot = new Telegraf(process.env.BOT_TOKEN);

const config = {
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID,
  SOURCE_CHAT_ID: process.env.SOURCE_CHAT_ID,
  REPORT_CHAT_ID: process.env.REPORT_CHAT_ID,
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL) || 10 * 60 * 1000,
  TIMEOUT_MINUTES: parseInt(process.env.TIMEOUT_MINUTES) || 45,
  get TIMEOUT() { return this.TIMEOUT_MINUTES * 60 * 1000 }
};

if (!config.ADMIN_CHAT_ID || !config.SOURCE_CHAT_ID || !config.REPORT_CHAT_ID) {
  log('Не все обязательные переменные окружения установлены!', 'ERROR');
  process.exit(1);
}

let db;

async function initDb() {
  try {
    db = await sqlite.open({
      filename: './bot.db',
      driver: sqlite3.Database
    });

    await db.run('PRAGMA journal_mode = WAL');

    await db.run(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        last_seen INTEGER,
        warnings INTEGER DEFAULT 0
      );
    `);

    await db.run(`
      CREATE TABLE IF NOT EXISTS ignore_list (
        user_id INTEGER PRIMARY KEY
      );
    `);

    log('База данных успешно инициализирована');
  } catch (error) {
    log(`Ошибка инициализации БД: ${error.message}`, 'ERROR');
    throw error;
  }
}

async function dbQuery(query, params = []) {
  try {
    return await db[query.startsWith('SELECT') ? 'all' : 'run'](query, params);
  } catch (error) {
    log(`Ошибка выполнения запроса: ${query}. Ошибка: ${error.message}`, 'ERROR');
    throw error;
  }
}

function isAdmin(ctx) {
  return String(ctx.chat.id) === config.ADMIN_CHAT_ID;
}

function isValidUserId(userId) {
  return /^\d+$/.test(userId);
}

async function handleWarning(userId, username) {
  try {
    await dbQuery(`
      UPDATE users 
      SET warnings = warnings + 1 
      WHERE user_id = ?
    `, [userId]);

    const user = await dbQuery(
      'SELECT warnings FROM users WHERE user_id = ?',
      [userId]
    );

    const warnings = user[0]?.warnings || 1;
    let message = `⚠️ Пользователь ${username ? `@${username}` : ''} (ID ${userId}) `;
    message += `не отправлял фото более ${config.TIMEOUT_MINUTES} минут.`;

    if (warnings > 1) {
      message += `\n🚨 Это ${warnings}-е предупреждение!`;
    }

    await bot.telegram.sendMessage(config.REPORT_CHAT_ID, message);
    log(`Отправлено уведомление для пользователя ${userId}. Предупреждений: ${warnings}`);
  } catch (error) {
    log(`Ошибка при обработке предупреждения: ${error.message}`, 'ERROR');
  }
}

bot.on('photo', async (ctx) => {
  try {
    if (String(ctx.chat.id) !== config.SOURCE_CHAT_ID) return;

    const uid = ctx.from.id;
    const username = ctx.from.username || '';
    const now = Date.now();

    await dbQuery(`
      INSERT INTO users (user_id, username, last_seen, warnings)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        last_seen = excluded.last_seen,
        warnings = 0;
    `, [uid, username, now]);

    log(`Пользователь ${username ? `@${username}` : uid} отправил фото`);
  } catch (error) {
    log(`Ошибка при обработке фото: ${error.message}`, 'ERROR');
  }
});

bot.command('admin', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к команде admin из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.reply('Доступ запрещен');
    }

    const message = `
<b>Доступные команды администратора:</b>

• /ignore [user_id] — Добавить пользователя в игнор-лист
• /unignore [user_id] — Удалить пользователя из игнор-листа
• /status — Показать текущую активность всех пользователей
• /report — Отправить отчёт за текущую смену
• /report all — Отправить отчёты за последние 10 смен
• /report YYYY-MM-DD morning|evening — Отправить отчёт за конкретную дату и смену

<b>Информация о сменах:</b>
• Таймзона: Asia/Almaty (UTC+5)
• Утренняя смена: 07:00–15:00
• Вечерняя смена: 15:00–23:00
`;

    await ctx.replyWithHTML(message, Markup.inlineKeyboard([
      [Markup.button.switchToChat('Игнорировать пользователя', '/ignore '), Markup.button.switchToChat('Убрать из игнора', '/unignore ')],
      [Markup.button.switchToChat('Статус активности', '/status')],
      [Markup.button.switchToChat('Отчёт за смену', '/report')],
      [Markup.button.switchToChat('Отчёты за 10 смен', '/report all')],
      [Markup.button.switchToChat('Отчёт за дату', '/report ')],
      [Markup.button.callback('Обнулить данные', 'reset_data')]
    ]));
    log(`Администратор ${ctx.from.id} запросил список команд через /admin`);
  } catch (error) {
    log(`Ошибка при выполнении команды admin: ${error.message}`, 'ERROR');
    await ctx.reply('Произошла ошибка при выполнении команды.');
  }
});

bot.action('reset_data', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к действию reset_data из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.answerCbQuery('Доступ запрещен');
    }

    await dbQuery('DELETE FROM users');
    await dbQuery('DELETE FROM ignore_list');
    await ctx.answerCbQuery('Данные успешно обнулены');
    await ctx.reply('Все данные пользователей и игнор-листа обнулены.');
    log(`Администратор ${ctx.from.id} обнулил данные`);
  } catch (error) {
    log(`Ошибка при обнулении данных: ${error.message}`, 'ERROR');
    await ctx.answerCbQuery('Ошибка при обнулении данных');
    await ctx.reply('Произошла ошибка при выполнении действия.');
  }
});

bot.command('ignore', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к команде ignore из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.reply('Доступ запрещен');
    }

    const args = ctx.message.text.split(' ')[1];
    if (!args || !isValidUserId(args)) {
      return ctx.reply('Укажите корректный user_id (только цифры)');
    }

    const uid = parseInt(args);
    await dbQuery('INSERT OR IGNORE INTO ignore_list(user_id) VALUES (?)', [uid]);
    await ctx.reply(`Пользователь ${uid} добавлен в ignore-лист.`);
    log(`Пользователь ${uid} добавлен в ignore-лист администратором ${ctx.from.id}`);
  } catch (error) {
    log(`Ошибка при выполнении команды ignore: ${error.message}`, 'ERROR');
    ctx.reply('Произошла ошибка при выполнении команды.');
  }
});

bot.command('unignore', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к команде unignore из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.reply('Доступ запрещен');
    }

    const args = ctx.message.text.split(' ')[1];
    if (!args || !isValidUserId(args)) {
      return ctx.reply('Укажите корректный user_id (только цифры)');
    }

    const uid = parseInt(args);
    await dbQuery('DELETE FROM ignore_list WHERE user_id = ?', [uid]);
    await ctx.reply(`Пользователь ${uid} удалён из игнор-листа.`);
    log(`Пользователь ${uid} удален из ignore-листа администратором ${ctx.from.id}`);
  } catch (error) {
    log(`Ошибка при выполнении команды unignore: ${error.message}`, 'ERROR');
    ctx.reply('Произошла ошибка при выполнении команды.');
  }
});

bot.command('status', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к команде status из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.reply('Доступ запрещен');
    }

    const rows = await dbQuery('SELECT user_id, username, last_seen, warnings FROM users');
    if (!rows.length) return ctx.reply('Нет данных о пользователях.');

    const now = Date.now();
    let msg = '📝 Статус активности:\n\n';

    for (const { user_id, username, last_seen, warnings } of rows) {
      const diff = Math.floor((now - last_seen) / 60000);
      msg += `• ID ${user_id}${username ? ` (@${username})` : ''}: ${diff} мин назад, предупреждений: ${warnings}\n`;
    }

    await ctx.reply(msg);
    log(`Администратор ${ctx.from.id} запросил статус`);
  } catch (error) {
    log(`Ошибка при выполнении команды status: ${error.message}`, 'ERROR');
    ctx.reply('Произошла ошибка при получении статуса.');
  }
});

async function checkActivity() {
  try {
    log('Начало периодической проверки активности');
    const now = Date.now();
    const users = await dbQuery('SELECT user_id, username, last_seen FROM users');
    const ignore = await dbQuery('SELECT user_id FROM ignore_list');
    const ignoreSet = new Set(ignore.map(r => r.user_id));

    for (const u of users) {
      if (ignoreSet.has(u.user_id)) continue;
      if (now - u.last_seen > config.TIMEOUT) {
        await handleWarning(u.user_id, u.username);
        await dbQuery('UPDATE users SET last_seen = ? WHERE user_id = ?', [now, u.user_id]);
      }
    }

    log('Периодическая проверка активности завершена');
  } catch (error) {
    log(`Ошибка при периодической проверки активности: ${error.message}`, 'ERROR');
  } finally {
    setTimeout(checkActivity, config.CHECK_INTERVAL);
  }
}

async function startBot() {
  try {
    await initDb();
    bot.launch().then(() => {
      log('Бот успешно запущен');
      checkActivity();
    });

    process.once('SIGINT', async () => {
      log('Остановка бота по SIGINT');
      await bot.stop('SIGINT');
      process.exit();
    });

    process.once('SIGTERM', async () => {
      log('Остановка бота по SIGTERM');
      await bot.stop('SIGTERM');
      process.exit();
    });

  } catch (error) {
    log(`Ошибка при запуске бота: ${error.message}`, 'ERROR');
    process.exit(1);
  }
}

startBot();
