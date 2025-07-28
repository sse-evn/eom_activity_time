require('dotenv').config();
const { Telegraf } = require('telegraf');
const sqlite = require('sqlite');
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');

// Настройка логгера
const logStream = fs.createWriteStream(path.join(__dirname, 'bot.log'), { flags: 'a' });
const log = (message, level = 'INFO') => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}\n`;
  logStream.write(logMessage);
  console[level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log'](logMessage);
};

const bot = new Telegraf(process.env.BOT_TOKEN);

// Конфигурация
const config = {
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID,
  SOURCE_CHAT_ID: process.env.SOURCE_CHAT_ID,
  REPORT_CHAT_ID: process.env.REPORT_CHAT_ID,
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL) || 10 * 60 * 1000,
  TIMEOUT_MINUTES: parseInt(process.env.TIMEOUT_MINUTES) || 45,
  get TIMEOUT() { return this.TIMEOUT_MINUTES * 60 * 1000 }
};

// Проверка конфигурации
if (!config.ADMIN_CHAT_ID || !config.SOURCE_CHAT_ID || !config.REPORT_CHAT_ID) {
  log('Не все обязательные переменные окружения установлены!', 'ERROR');
  process.exit(1);
}

let db;

// Инициализация БД
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

// Обертка для запросов к БД
async function dbQuery(query, params = []) {
  try {
    return await db[query.startsWith('SELECT') ? 'all' : 'run'](query, params);
  } catch (error) {
    log(`Ошибка выполнения запроса: ${query}. Ошибка: ${error.message}`, 'ERROR');
    throw error;
  }
}

// Проверка прав администратора
function isAdmin(ctx) {
  return String(ctx.chat.id) === config.ADMIN_CHAT_ID;
}

// Валидация ID пользователя
function isValidUserId(userId) {
  return /^\d+$/.test(userId);
}

// Обработка предупреждений
async function handleWarning(userId, username) {
  try {
    // Увеличиваем счетчик предупреждений
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

// Обработка фото
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

    await ctx.reply('Фото получено, спасибо!');
    log(`Пользователь ${username ? `@${username}` : uid} отправил фото`);
  } catch (error) {
    log(`Ошибка при обработке фото: ${error.message}`, 'ERROR');
    ctx.reply('Произошла ошибка при обработке вашего фото. Пожалуйста, попробуйте позже.');
  }
});

// Команды администратора
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
    await ctx.reply(`Пользователь ${uid} удалён из ignore-листа.`);
    log(`Пользователь ${uid} удален из ignore-листа администратором ${ctx.from.id}`);
  } catch (error) {
    log(`Ошибка при выполнении команды unignore: ${error.message}`, 'ERROR');
    ctx.reply('Произошла ошибка при выполнении команды.');
  }
});

// Команда статуса
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

// Периодическая проверка активности
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
        // Обновляем last_seen чтобы не спамить уведомлениями
        await dbQuery('UPDATE users SET last_seen = ? WHERE user_id = ?', [now, u.user_id]);
      }
    }

    log('Периодическая проверка активности завершена');
  } catch (error) {
    log(`Ошибка при периодической проверке активности: ${error.message}`, 'ERROR');
  } finally {
    setTimeout(checkActivity, config.CHECK_INTERVAL);
  }
}

// Запуск бота
async function startBot() {
  try {
    await initDb();
    bot.launch().then(() => {
      log('Бот успешно запущен');
      checkActivity(); // Запускаем периодическую проверку
    });

    // Корректное завершение работы
    process.once('SIGINT', () => {
      log('Остановка бота по SIGINT');
      bot.stop('SIGINT');
      process.exit();
    });

    process.once('SIGTERM', () => {
      log('Остановка бота по SIGTERM');
      bot.stop('SIGTERM');
      process.exit();
    });
  } catch (error) {
    log(`Ошибка при запуске бота: ${error.message}`, 'ERROR');
    process.exit(1);
  }
}

startBot();
