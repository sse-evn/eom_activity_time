require('dotenv').config();
const { Telegraf } = require('telegraf');
const sqlite3 = require('sqlite3').verbose();
const moment = require('moment-timezone');

// Initialize environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const SOURCE_CHAT_ID = process.env.SOURCE_CHAT_ID;
const REPORT_CHAT_ID = process.env.REPORT_CHAT_ID;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL) || 360000;
const TIMEOUT_MINUTES = parseInt(process.env.TIMEOUT_MINUTES) || 45;

// Initialize bot and database
const bot = new Telegraf(BOT_TOKEN);
const db = new sqlite3.Database('bot_data.db');

// Set timezone to UTC+5 (Almaty)
moment.tz.setDefault('Asia/Almaty');

// Initialize database tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS activity (
        username TEXT PRIMARY KEY,
        last_active INTEGER,
        warnings INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS ignored (
        username TEXT PRIMARY KEY
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value INTEGER
    )`);
    db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES ('timeout_minutes', ?)`, [TIMEOUT_MINUTES]);
});

// Store active users
let activeUsers = new Map();

// Helper functions
async function getTimeoutMinutes() {
    return new Promise((resolve) => {
        db.get(`SELECT value FROM settings WHERE key = 'timeout_minutes'`, (err, row) => {
            resolve(row ? row.value : TIMEOUT_MINUTES);
        });
    });
}

async function updateTimeoutMinutes(minutes) {
    return new Promise((resolve) => {
        db.run(`INSERT OR REPLACE INTO settings (key, value) VALUES ('timeout_minutes', ?)`, [minutes], resolve);
    });
}

async function checkActivity() {
    const timeoutMinutes = await getTimeoutMinutes();
    const now = moment().valueOf();
    const timeoutMs = timeoutMinutes * 60 * 1000;
    
    let report = '📝 Статус активности:\n\n';
    let hasInactive = false;

    for (const [username, lastActive] of activeUsers) {
        const isIgnored = await new Promise((resolve) => {
            db.get(`SELECT username FROM ignored WHERE username = ?`, [username], (err, row) => {
                resolve(!!row);
            });
        });

        if (isIgnored) continue;

        const minutesSinceLastActive = Math.floor((now - lastActive) / 60000);
        
        if (minutesSinceLastActive > timeoutMinutes) {
            hasInactive = true;
            const warnings = await new Promise((resolve) => {
                db.get(`SELECT warnings FROM activity WHERE username = ?`, [username], (err, row) => {
                    resolve(row ? row.warnings : 0);
                });
            });

            const newWarnings = warnings + 1;
            db.run(`INSERT OR REPLACE INTO activity (username, last_active, warnings) VALUES (?, ?, ?)`, 
                [username, lastActive, newWarnings]);

            report += `• @${username}\n`;
            report += `  🕒 ${minutesSinceLastActive} мин назад\n`;
            report += `  ⚠️ Предупреждений: ${newWarnings}\n\n`;
        }
    }

    if (hasInactive) {
        await bot.telegram.sendMessage(REPORT_CHAT_ID, report);
    }
}

// Message handler for SOURCE_CHAT_ID
bot.on('message', async (ctx) => {
    if (String(ctx.chat.id) === SOURCE_CHAT_ID && ctx.from.username) {
        const username = ctx.from.username;
        activeUsers.set(username, moment().valueOf());
        
        db.run(`INSERT OR REPLACE INTO activity (username, last_active, warnings) VALUES (?, ?, ?)`,
            [username, moment().valueOf(), 0]);
    }
});

// Admin commands
bot.command('set_timeout', async (ctx) => {
    if (String(ctx.chat.id) !== ADMIN_CHAT_ID) return;
    
    const minutes = parseInt(ctx.message.text.split(' ')[1]);
    if (isNaN(minutes) || minutes < 1) {
        return ctx.reply('Укажите корректное количество минут!');
    }

    await updateTimeoutMinutes(minutes);
    ctx.reply(`Таймаут неактивности установлен на ${minutes} минут`);
});

bot.command('status', async (ctx) => {
    if (String(ctx.chat.id) !== ADMIN_CHAT_ID) return;
    
    let report = '📝 Полный отчёт активности:\n\n';
    const now = moment().valueOf();

    for (const [username, lastActive] of activeUsers) {
        const isIgnored = await new Promise((resolve) => {
            db.get(`SELECT username FROM ignored WHERE username = ?`, [username], (err, row) => {
                resolve(!!row);
            });
        });

        const minutesSinceLastActive = Math.floor((now - lastActive) / 60000);
        const warnings = await new Promise((resolve) => {
            db.get(`SELECT warnings FROM activity WHERE username = ?`, [username], (err, row) => {
                resolve(row ? row.warnings : 0);
            });
        });

        report += `• @${username}\n`;
        report += `  🕒 ${minutesSinceLastActive} мин назад\n`;
        report += `  ⚠️ Предупреждений: ${warnings}\n`;
        report += `  ${isIgnored ? '🚫 Игнорируется' : '✅ Отслеживается'}\n\n`;
    }

    ctx.reply(report || 'Нет данных об активности');
});

bot.command('report', async (ctx) => {
    if (String(ctx.chat.id) !== ADMIN_CHAT_ID) return;
    await checkActivity();
    ctx.reply('Проверка активности выполнена');
});

bot.command('ignore', async (ctx) => {
    if (String(ctx.chat.id) !== ADMIN_CHAT_ID) return;
    
    const username = ctx.message.text.split(' ')[1]?.replace('@', '');
    if (!username) return ctx.reply('Укажите username!');

    db.run(`INSERT OR IGNORE INTO ignored (username) VALUES (?)`, [username]);
    ctx.reply(`@${username} добавлен в игнор-лист`);
});

bot.command('unignore', async (ctx) => {
    if (String(ctx.chat.id) !== ADMIN_CHAT_ID) return;
    
    const username = ctx.message.text.split(' ')[1]?.replace('@', '');
    if (!username) return ctx.reply('Укажите username!');

    db.run(`DELETE FROM ignored WHERE username = ?`, [username]);
    ctx.reply(`@${username} удалён из игнор-листа`);
});

bot.command('help', async (ctx) => {
    if (String(ctx.chat.id) !== ADMIN_CHAT_ID) return;
    
    const helpMessage = `
📚 Список команд:
/set_timeout [минуты] - Изменить таймаут неактивности
/status - Показать полный отчёт активности
/report - Выполнить проверку активности
/ignore @username - Исключить пользователя из мониторинга
/unignore @username - Вернуть пользователя в мониторинг
/help - Показать это сообщение
    `;
    ctx.reply(helpMessage);
});

// Start periodic checking
setInterval(checkActivity, CHECK_INTERVAL);

// Load existing activity data
db.all(`SELECT username, last_active FROM activity`, (err, rows) => {
    if (rows) {
        rows.forEach(row => {
            activeUsers.set(row.username, row.last_active);
        });
    }
});

// Start bot
bot.launch().then(() => {
    console.log('Bot started');
});

// Handle graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
