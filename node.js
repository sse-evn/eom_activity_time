require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const sqlite = require('sqlite');
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');
const { DateTime } = require('luxon');

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

• Игнорировать пользователя (/ignore [user_id])
• Убрать из игнора (/unignore [user_id])
• Статус активности (/status)
• Отчёт за смену (/report)
• Отчёты за 10 смен (/report all)
• Отчёт за дату (/report YYYY-MM-DD morning|evening)
• Обнулить данные

<b>Информация о сменах:</b>
• Таймзона: Asia/Almaty (UTC+5)
• Утренняя смена: 07:00–15:00
• Вечерняя смена: 15:00–23:00
`;

    await ctx.replyWithHTML(message, Markup.inlineKeyboard([
      [Markup.button.callback('Игнорировать', 'ignore'), Markup.button.callback('Убрать из игнора', 'unignore')],
      [Markup.button.callback('Статус', 'status')],
      [Markup.button.callback('Отчёт за смену', 'report')],
      [Markup.button.callback('Отчёты за 10 смен', 'report_all')],
      [Markup.button.callback('Отчёт за дату', 'report_date')],
      [Markup.button.callback('Обнулить данные', 'reset_data')]
    ]));
    log(`Администратор ${ctx.from.id} запросил список команд через /admin`);
  } catch (error) {
    log(`Ошибка при выполнении команды admin: ${error.message}`, 'ERROR');
    await ctx.reply('Произошла ошибка при выполнении команды.');
  }
});

bot.action('ignore', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к действию ignore из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.answerCbQuery('Доступ запрещен');
    }
    await ctx.answerCbQuery();
    await ctx.reply('Введите user_id для добавления в игнор-лист:');
    ctx.session = { awaiting: 'ignore' };
  } catch (error) {
    log(`Ошибка при обработке действия ignore: ${error.message}`, 'ERROR');
    await ctx.reply('Произошла ошибка.');
  }
});

bot.action('unignore', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к действию unignore из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.answerCbQuery('Доступ запрещен');
    }
    await ctx.answerCbQuery();
    await ctx.reply('Введите user_id для удаления из игнор-листа:');
    ctx.session = { awaiting: 'unignore' };
  } catch (error) {
    log(`Ошибка при обработке действия unignore: ${error.message}`, 'ERROR');
    await ctx.reply('Произошла ошибка.');
  }
});

bot.action('status', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к действию status из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.answerCbQuery('Доступ запрещен');
    }
    await ctx.answerCbQuery();
    const rows = await dbQuery('SELECT user_id, username, last_seen, warnings FROM users');
    if (!rows.length) return ctx.reply('Нет данных о пользователях.');

    const now = Date.now();
    let msg = '<b>📝 Статус активности:</b>\n\n';

    for (const { username, last_seen, warnings } of rows) {
      const diff = Math.floor((now - last_seen) / 60000);
      msg += `• <code>${username ? `@${username}` : 'Без имени'}</code>\n`;
      msg += `  🕒 ${diff} мин назад\n`;
      msg += `  ⚠️ Предупреждений: ${warnings}\n\n`;
    }

    await ctx.replyWithHTML(msg);
    log(`Администратор ${ctx.from.id} запросил статус через кнопку`);
  } catch (error) {
    log(`Ошибка при обработке действия status: ${error.message}`, 'ERROR');
    await ctx.reply('Произошла ошибка.');
  }
});

bot.action('report', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к действию report из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.answerCbQuery('Доступ запрещен');
    }
    await ctx.answerCbQuery();

    const now = DateTime.now().setZone('Asia/Almaty');
    const hour = now.hour;
    let shift;
    let shiftStart, shiftEnd;

    if (hour >= 7 && hour < 15) {
      shift = 'утренняя';
      shiftStart = now.startOf('day').set({ hour: 7 }).toMillis();
      shiftEnd = now.startOf('day').set({ hour: 15 }).toMillis();
    } else if (hour >= 15 && hour < 23) {
      shift = 'вечерняя';
      shiftStart = now.startOf('day').set({ hour: 15 }).toMillis();
      shiftEnd = now.startOf('day').set({ hour: 23 }).toMillis();
    } else {
      await ctx.reply('Смена не активна (активные смены: 07:00–15:00, 15:00–23:00).');
      return;
    }

    const rows = await dbQuery('SELECT user_id, username, last_seen, warnings FROM users');
    if (!rows.length) return ctx.reply('Нет данных о пользователях.');

    let msg = `<b>📊 Отчёт за ${shift} смену (${now.toFormat('yyyy-MM-dd')})</b>\n\n`;

    for (const { username, last_seen, warnings } of rows) {
      msg += `• <code>${username ? `@${username}` : 'Без имени'}</code>\n`;
      if (last_seen >= shiftStart && last_seen <= shiftEnd) {
        const diff = Math.floor((now.toMillis() - last_seen) / 60000);
        msg += `  🕒 Последняя активность: ${diff} мин назад\n`;
      } else {
        msg += `  🕒 Не активен в этой смене\n`;
      }
      msg += `  ⚠️ Предупреждений: ${warnings}\n\n`;
    }

    await ctx.replyWithHTML(msg);
    log(`Администратор ${ctx.from.id} запросил отчёт за текущую смену через кнопку`);
  } catch (error) {
    log(`Ошибка при обработке действия report: ${error.message}`, 'ERROR');
    await ctx.reply('Произошла ошибка.');
  }
});

bot.action('report_all', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к действию report_all из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.answerCbQuery('Доступ запрещен');
    }
    await ctx.answerCbQuery();
    await ctx.reply('Функция отчётов за последние 10 смен ещё не реализована.');
    log(`Администратор ${ctx.from.id} запросил отчёты за 10 смен через кнопку`);
  } catch (error) {
    log(`Ошибка при обработке действия report_all: ${error.message}`, 'ERROR');
    await ctx.reply('Произошла ошибка.');
  }
});

bot.action('report_date', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к действию report_date из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.answerCbQuery('Доступ запрещен');
    }
    await ctx.answerCbQuery();
    await ctx.reply('Введите дату и смену в формате: YYYY-MM-DD morning|evening');
    ctx.session = { awaiting: 'report_date' };
  } catch (error) {
    log(`Ошибка при обработке действия report_date: ${error.message}`, 'ERROR');
    await ctx.reply('Произошла ошибка.');
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

bot.on('text', async (ctx) => {
  try {
    if (!isAdmin(ctx) || !ctx.session?.awaiting) return;

    const text = ctx.message.text.trim();
    if (ctx.session.awaiting === 'ignore') {
      if (!isValidUserId(text)) {
        return ctx.reply('Укажите корректный user_id (только цифры)');
      }
      const uid = parseInt(text);
      await dbQuery('INSERT OR IGNORE INTO ignore_list(user_id) VALUES (?)', [uid]);
      await ctx.reply(`Пользователь ${uid} добавлен в ignore-лист.`);
      log(`Пользователь ${uid} добавлен в ignore-лист администратором ${ctx.from.id}`);
    } else if (ctx.session.awaiting === 'unignore') {
      if (!isValidUserId(text)) {
        return ctx.reply('Укажите корректный user_id (только цифры)');
      }
      const uid = parseInt(text);
      await dbQuery('DELETE FROM ignore_list WHERE user_id = ?', [uid]);
      await ctx.reply(`Пользователь ${uid} удалён из игнор-листа.`);
      log(`Пользователь ${uid} удален из ignore-листа администратором ${ctx.from.id}`);
    } else if (ctx.session.awaiting === 'report_date') {
      if (!text.match(/^\d{4}-\d{2}-\d{2} (morning|evening)$/)) {
        return ctx.reply('Формат должен быть: YYYY-MM-DD morning|evening');
      }
      await ctx.reply(`Функция отчёта за ${text} ещё не реализована.`);
      log(`Администратор ${ctx.from.id} запросил отчёт за ${text} через кнопку`);
    }
    ctx.session = null;
  } catch (error) {
    log(`Ошибка при обработке текстового ввода: ${error.message}`, 'ERROR');
    await ctx.reply('Произошла ошибка.');
    ctx.session = null;
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
    let msg = '<b>📝 Статус активности:</b>\n\n';

    for (const { username, last_seen, warnings } of rows) {
      const diff = Math.floor((now - last_seen) / 60000);
      msg += `• <code>${username ? `@${username}` : 'Без имени'}</code>\n`;
      msg += `  🕒 ${diff} мин назад\n`;
      msg += `  ⚠️ Предупреждений: ${warnings}\n\n`;
    }

    await ctx.replyWithHTML(msg);
    log(`Администратор ${ctx.from.id} запросил статус`);
  } catch (error) {
    log(`Ошибка при выполнении команды status: ${error.message}`, 'ERROR');
    ctx.reply('Произошла ошибка при получении статуса.');
  }
});

bot.command('report', async (ctx) => {
  try {
    if (!isAdmin(ctx)) {
      log(`Попытка доступа к команде report из неавторизованного чата: ${ctx.chat.id}`, 'WARN');
      return ctx.reply('Доступ запрещен');
    }

    const now = DateTime.now().setZone('Asia/Almaty');
    const hour = now.hour;
    let shift;
    let shiftStart, shiftEnd;

    if (hour >= 7 && hour < 15) {
      shift = 'утренняя';
      shiftStart = now.startOf('day').set({ hour: 7 }).toMillis();
      shiftEnd = now.startOf('day').set({ hour: 15 }).toMillis();
    } else if (hour >= 15 && hour < 23) {
      shift = 'вечерняя';
      shiftStart = now.startOf('day').set({ hour: 15 }).toMillis();
      shiftEnd = now.startOf('day').set({ hour: 23 }).toMillis();
    } else {
      await ctx.reply('Смена не активна (активные смены: 07:00–15:00, 15:00–23:00).');
      return;
    }

    const rows = await dbQuery('SELECT user_id, username, last_seen, warnings FROM users');
    if (!rows.length) return ctx.reply('Нет данных о пользователях.');

    let msg = `<b>📊 Отчёт за ${shift} смену (${now.toFormat('yyyy-MM-dd')})</b>\n\n`;

    for (const { username, last_seen, warnings } of rows) {
      msg += `• <code>${username ? `@${username}` : 'Без имени'}</code>\n`;
      if (last_seen >= shiftStart && last_seen <= shiftEnd) {
        const diff = Math.floor((now.toMillis() - last_seen) / 60000);
        msg += `  🕒 Последняя активность: ${diff} мин назад\n`;
      } else {
        msg += `  🕒 Не активен в этой смене\n`;
      }
      msg += `  ⚠️ Предупреждений: ${warnings}\n\n`;
    }

    await ctx.replyWithHTML(msg);
    log(`Администратор ${ctx.from.id} запросил отчёт за текущую смену`);
  } catch (error) {
    log(`Ошибка при выполнении команды report: ${error.message}`, 'ERROR');
    ctx.reply('Произошла ошибка при получении отчёта.');
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
