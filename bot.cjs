const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const express = require('express');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Supabase client (use service role key for full access)
const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_KEY || ''
);

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ─── Helper: get user stats ──────────────────────────────────────────────────

async function getUserStats(userId) {
  const { data } = await supabase
    .from('users')
    .select('stats')
    .eq('id', String(userId))
    .single();
  if (!data) return { fileCount: 0, referrals: [], baseLimit: 2 };
  return data.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
}

async function canUploadFile(userId) {
  const stats = await getUserStats(userId);
  const totalAllowedFiles = stats.baseLimit + stats.referrals.length;
  return stats.fileCount < totalAllowedFiles;
}

async function updateFileCount(userId, increment = true) {
  const stats = await getUserStats(userId);
  stats.fileCount = increment ? stats.fileCount + 1 : Math.max(0, stats.fileCount - 1);
  await supabase.from('users').update({ stats }).eq('id', String(userId));
}

// ─── Helper: get / set bot config ────────────────────────────────────────────

async function getConfig(key) {
  const { data } = await supabase
    .from('bot_config')
    .select('value')
    .eq('key', key)
    .single();
  return data ? data.value : null;
}

async function setConfig(key, value, updatedBy) {
  await supabase.from('bot_config').upsert({
    key,
    value,
    updated_at: new Date().toISOString(),
    updated_by: String(updatedBy || '')
  });
}

// ─── Helper: Telegram Storage ─────────────────────────────────────────────────
// Files are stored in a private Telegram channel (unlimited storage).
// Supabase is used only for metadata (file_id, message_id, etc.).
// This means bot restarts never cause data loss — everything is in the DB.

const storageChannelId = process.env.TELEGRAM_STORAGE_CHANNEL_ID;

function getPublicUrl(userId, fileName) {
  let base = '';
  if (process.env.RENDER_EXTERNAL_URL) {
    base = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '');
  } else {
    const domain = (process.env.REPLIT_DOMAINS || process.env.REPLIT_DEV_DOMAIN || 'localhost').split(',')[0].trim();
    base = `https://${domain}`;
  }
  return `${base}/api/view/${userId}/${encodeURIComponent(fileName)}`;
}

async function listUserFiles(userId) {
  const { data, error } = await supabase
    .from('files')
    .select('file_name, uploaded_at, file_size')
    .eq('user_id', String(userId))
    .order('uploaded_at', { ascending: false });
  if (error || !data) return [];
  return data.map(f => ({ name: f.file_name, created_at: f.uploaded_at, metadata: { size: f.file_size } }));
}

// Uploads a file to the Telegram storage channel using the original file_id.
// Telegram reuses the file server-side — no download/re-upload needed.
async function uploadFile(userId, fileName, telegramFileId, contentType, fileSize) {
  if (!storageChannelId) throw new Error('TELEGRAM_STORAGE_CHANNEL_ID is not set');

  const msg = await bot.telegram.sendDocument(
    storageChannelId,
    telegramFileId,
    { caption: `📁 user:${userId} | ${fileName}` }
  );

  const doc = msg.document;

  const { error } = await supabase.from('files').upsert({
    user_id: String(userId),
    file_name: fileName,
    telegram_file_id: doc.file_id,
    telegram_message_id: msg.message_id,
    content_type: contentType,
    file_size: fileSize || doc.file_size || 0,
  }, { onConflict: 'user_id,file_name' });

  if (error) throw error;
}

async function deleteStorageFile(userId, fileName) {
  const { data } = await supabase
    .from('files')
    .select('telegram_message_id')
    .eq('user_id', String(userId))
    .eq('file_name', fileName)
    .single();

  if (data && data.telegram_message_id && storageChannelId) {
    try {
      await bot.telegram.deleteMessage(storageChannelId, data.telegram_message_id);
    } catch (_) {}
  }

  await supabase.from('files').delete()
    .eq('user_id', String(userId))
    .eq('file_name', fileName);
}

async function deleteAllUserFiles(userId) {
  const { data } = await supabase
    .from('files')
    .select('telegram_message_id')
    .eq('user_id', String(userId));

  if (!data || data.length === 0) return 0;

  if (storageChannelId) {
    for (const file of data) {
      if (file.telegram_message_id) {
        try {
          await bot.telegram.deleteMessage(storageChannelId, file.telegram_message_id);
        } catch (_) {}
      }
    }
  }

  await supabase.from('files').delete().eq('user_id', String(userId));
  return data.length;
}

// ─── Admin config ─────────────────────────────────────────────────────────────

const adminId = process.env.ADMIN_ID;
const bannedUsers = new Set();
const users = new Set();
const adminStates = new Map();
let banUserMode = false;
let unbanUserMode = false;
let defaultSlotsMode = false;
let referralRewardMode = false;

const isAdmin = (userId) => userId === Number(adminId);
const isBanned = (userId) => bannedUsers.has(userId);

// ─── Menus ────────────────────────────────────────────────────────────────────

const adminMenu = Markup.inlineKeyboard([
  [
    Markup.button.callback('📂 View All Files', 'view_files'),
    Markup.button.callback('📊 Total Users', 'total_users')
  ],
  [
    Markup.button.callback('📈 Referral Stats', 'referral_stats'),
    Markup.button.callback('📊 Daily Stats', 'daily_stats')
  ],
  [
    Markup.button.callback('📢 Broadcast', 'broadcast'),
    Markup.button.callback('🎁 Add Slots', 'add_slots')
  ],
  [
    Markup.button.callback('⚙️ Default Slots', 'edit_default_slots'),
    Markup.button.callback('🎯 Referral Reward', 'edit_referral_reward')
  ],
  [
    Markup.button.callback('🚫 Ban User', 'ban_user'),
    Markup.button.callback('🔓 Unban User', 'unban_user')
  ],
  [
    Markup.button.callback('🔔 Send Notification', 'send_notification'),
    Markup.button.callback('👑 Premium Users', 'premium_users')
  ],
  [
    Markup.button.callback('🗑️ Delete User Files', 'delete_user_files'),
    Markup.button.callback('📝 View User Files', 'view_user_files')
  ],
  [
    Markup.button.callback('⚙️ Bot Settings', 'bot_settings')
  ],
]);

const userMenu = Markup.inlineKeyboard([
  [
    Markup.button.callback('📤 Upload File', 'upload'),
    Markup.button.callback('📂 My Files', 'myfiles')
  ],
  [
    Markup.button.callback('❌ Delete File', 'delete'),
    Markup.button.callback('⭐ My Stats', 'mystats')
  ],
  [
    Markup.button.callback('🎁 Refer & Earn', 'refer'),
    Markup.button.callback('👑 Get Premium', 'get_premium')
  ],
  [
    Markup.button.callback('🛠️ Advanced Options', 'advanced_options'),
    Markup.button.callback('📞 Contact Admin', 'contact')
  ]
]);

// ─── Notification helper ──────────────────────────────────────────────────────

async function sendNotificationToUsers(message, specificUserId = null) {
  try {
    if (!specificUserId) {
      const config = await getConfig('notifications');
      if (config && config.enabled === false) return 0;
    }

    if (specificUserId) {
      try {
        await bot.telegram.sendMessage(specificUserId, message, {
          parse_mode: 'Markdown',
          disable_notification: false
        });
        return 1;
      } catch (error) {
        console.error(`Could not send to ${specificUserId}: ${error.message}`);
        return 0;
      }
    }

    const { data: allUsers } = await supabase.from('users').select('chat_id, notifications');
    if (!allUsers || allUsers.length === 0) return 0;

    let sentCount = 0;
    let failedCount = 0;

    for (const user of allUsers) {
      const chatId = user.chat_id;
      if (!chatId) continue;
      if (user.notifications === false) continue;

      try {
        await bot.telegram.sendMessage(chatId, message, {
          parse_mode: 'Markdown',
          disable_notification: false
        });
        sentCount++;
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        failedCount++;
      }
    }

    console.log(`Notifications sent: ${sentCount}, Failed: ${failedCount}`);
    return sentCount;
  } catch (error) {
    console.error('Error sending notifications:', error);
    return 0;
  }
}

// ─── Daily usage tracking ─────────────────────────────────────────────────────

async function trackDailyUsage(userId) {
  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase
    .from('daily_stats')
    .select('*')
    .eq('date', today)
    .single();

  if (!data) {
    await supabase.from('daily_stats').insert({ date: today, users: [userId], count: 1 });
  } else {
    const existingUsers = data.users || [];
    if (!existingUsers.includes(userId)) {
      await supabase.from('daily_stats').update({
        users: [...existingUsers, userId],
        count: (data.count || 0) + 1
      }).eq('date', today);
    }
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  await trackDailyUsage(ctx.from.id);
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || 'Unknown';
  const startPayload = ctx.startPayload;

  if (isBanned(userId)) {
    return ctx.reply('❌ You are banned from using this bot.');
  }

  users.add(userId);

  const { data: existingUser } = await supabase
    .from('users')
    .select('id')
    .eq('id', String(userId))
    .single();

  if (!existingUser) {
    const initialData = {
      id: String(userId),
      chat_id: userId,
      name: userName,
      joined_at: new Date().toISOString(),
      stats: { fileCount: 0, referrals: [], baseLimit: 2 }
    };

    if (startPayload && startPayload !== String(userId)) {
      const { data: referrer } = await supabase
        .from('users')
        .select('stats')
        .eq('id', String(startPayload))
        .single();

      if (referrer) {
        const referrerStats = referrer.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
        if (!referrerStats.referrals.includes(String(userId))) {
          referrerStats.referrals.push(String(userId));
          await supabase.from('users').update({ stats: referrerStats }).eq('id', String(startPayload));

          ctx.reply(
            '🎉 Welcome! You were referred by another user!\n' +
            '📤 You have received your initial storage slots.\n' +
            '💫 Share your own referral link to earn more slots!\n\n' +
            `🔗 Your referral link:\nt.me/${ctx.botInfo.username}?start=${userId}`
          );

          const newUserName = ctx.from.first_name || 'Someone';
          bot.telegram.sendMessage(startPayload,
            `🌟 *New Referral Success!*\n\n` +
            `👤 User: ${newUserName}\n` +
            `📊 Your New Total Slots: ${referrerStats.baseLimit + referrerStats.referrals.length}\n` +
            `💰 Reward: +1 Storage Slot\n\n` +
            `Keep sharing your referral link to earn more slots!`,
            { parse_mode: 'Markdown' }
          );

          bot.telegram.sendAnimation(startPayload,
            'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExcHBwNHJ5NjlwNnYyOW53amlxeXp4ZDF2M2E2OGpwZmM0M3d6dTNseiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3oEduOnl5IHM5NRodO/giphy.gif'
          );
        }
      }
    }

    await supabase.from('users').insert(initialData);
  }

  if (isAdmin(userId)) {
    ctx.reply('Welcome to the Admin Panel! Use the menu below:', adminMenu);
  } else {
    ctx.reply(
      '🚀 *Welcome to the HTML Hosting Bot!*\n\n' +
      '🌟 *Features:*\n' +
      '• Upload HTML/ZIP files\n' +
      '• Get instant file links\n' +
      '• Manage your uploads\n' +
      '• Earn more slots through referrals\n\n' +
      '🎯 Select an option below:',
      {
        parse_mode: 'Markdown',
        ...userMenu
      }
    );
  }
});

// ─── User actions ─────────────────────────────────────────────────────────────

bot.action('mystats', async (ctx) => {
  const stats = await getUserStats(ctx.from.id);
  const totalSlots = stats.baseLimit + stats.referrals.length;

  ctx.reply(
    `📊 *Your Account Statistics*\n\n` +
    `📁 Files Uploaded: ${stats.fileCount}\n` +
    `💾 Total Storage Slots: ${totalSlots}\n` +
    `👥 Referrals Made: ${stats.referrals.length}\n` +
    `🌟 Account Level: ${Math.floor(stats.referrals.length / 2) + 1}\n\n` +
    `Progress to next level:\n` +
    `[${'▰'.repeat(stats.referrals.length % 2)}${'▱'.repeat(2 - (stats.referrals.length % 2))}]`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('tasks', async (ctx) => {
  const stats = await getUserStats(ctx.from.id);
  ctx.reply(
    `🎯 *Daily Tasks*\n\n` +
    `1. 📤 Upload a file (${stats.fileCount > 0 ? '✅' : '❌'})\n` +
    `2. 🔗 Share your referral link (${stats.referrals.length > 0 ? '✅' : '❌'})\n` +
    `3. 👥 Invite a friend (${stats.referrals.length > 0 ? '✅' : '❌'})\n\n` +
    `Complete tasks to earn more storage slots!`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('guide', (ctx) => {
  ctx.reply(
    `📚 *Bot Usage Guide*\n\n` +
    `1. 📤 *Upload Files*\n` +
    `   - Send HTML/ZIP files\n` +
    `   - Get instant hosting links\n\n` +
    `2. 🎁 *Earn More Storage*\n` +
    `   - Share your referral link\n` +
    `   - Each referral = +1 slot\n\n` +
    `3. 📂 *Manage Files*\n` +
    `   - View all your uploads\n` +
    `   - Delete unwanted files\n\n` +
    `4. 📊 *Track Progress*\n` +
    `   - Check your stats\n` +
    `   - Complete daily tasks`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('refer', async (ctx) => {
  const userId = ctx.from.id;
  const stats = await getUserStats(userId);
  const totalSlots = stats.baseLimit + stats.referrals.length;
  const usedSlots = Math.max(0, Math.min(stats.fileCount, totalSlots));
  const remainingSlots = Math.max(0, totalSlots - usedSlots);
  const referralCount = Math.min(stats.referrals.length, 5);
  const remainingReferrals = Math.max(0, 5 - referralCount);

  ctx.reply(
    `🌟 *Your Referral Dashboard*\n\n` +
    `📊 *Storage Status:*\n` +
    `[${usedSlots}/${totalSlots}] ${'▰'.repeat(usedSlots)}${'▱'.repeat(remainingSlots)}\n\n` +
    `👥 *Referral Progress:*\n` +
    `Total Referrals: ${stats.referrals.length}\n` +
    `${'🟢'.repeat(referralCount)}${'⚪️'.repeat(remainingReferrals)}\n\n` +
    `🎁 *Share your link to earn more:*\n` +
    `https://t.me/${ctx.botInfo.username}?start=${userId}\n\n` +
    `💫 *Rewards:*\n` +
    `• Each referral = ${stats.referralReward || 1} upload slots!\n` +
    `• Maximum referrals = Unlimited\n` +
    `• Your current reward: ${stats.referrals.length * (stats.referralReward || 1)} slots`,
    { parse_mode: 'Markdown' }
  );

  ctx.replyWithAnimation('https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExcHBwNHJ5NjlwNnYyOW53amlxeXp4ZDF2M2E2OGpwZmM0M3d6dTNseiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/3oEduOnl5IHM5NRodO/giphy.gif');
});

bot.action('upload', (ctx) => {
  ctx.reply('Please send me an HTML or ZIP file to host.');
});

bot.action('contact', (ctx) => {
  ctx.reply(
    '📌 message me  for any query = @Gamaspyowner:\n\n' +
    '🔗 [🚀Message me](https://t.me/Gamaspyowner)',
    { parse_mode: 'Markdown' }
  );
});

bot.action('back_to_main', async (ctx) => {
  await ctx.reply(
    '🚀 *Welcome back to the main menu!*\n\nSelect an option from the menu below:',
    { parse_mode: 'Markdown', ...userMenu }
  );
});

// ─── My Files ─────────────────────────────────────────────────────────────────

bot.action('myfiles', async (ctx) => {
  if (isBanned(ctx.from.id)) return ctx.reply('❌ You are banned from using this bot.');

  try {
    const files = await listUserFiles(ctx.from.id);
    if (files.length === 0) return ctx.reply('📂 You have no uploaded files.');

    let message = '📄 Your uploaded files:\n\n';
    for (const file of files) {
      const fileUrl = getPublicUrl(ctx.from.id, file.name);
      message += `🔗 File: ${file.name}\n${fileUrl}\n\n`;
    }

    ctx.reply(message);
  } catch (error) {
    ctx.reply('❌ Error fetching your files.');
    console.error(error);
  }
});

// ─── Delete File ──────────────────────────────────────────────────────────────

bot.action('delete', async (ctx) => {
  const userId = ctx.from.id;
  if (isBanned(userId)) return ctx.reply('❌ You are banned from using this bot.');

  try {
    const files = await listUserFiles(userId);
    if (files.length === 0) return ctx.reply('📂 You have no files to delete.');

    const fileButtons = files.map(file => [
      Markup.button.callback(`🗑️ ${file.name}`, `del_${file.name}`)
    ]);

    ctx.reply('Select a file to delete:', Markup.inlineKeyboard(fileButtons));
  } catch (error) {
    ctx.reply('❌ Error fetching your files.');
    console.error(error);
  }
});

bot.action(/^del_(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const fileName = ctx.match[1];

  try {
    const files = await listUserFiles(userId);
    const exists = files.some(f => f.name === fileName);

    if (!exists) return ctx.reply(`❌ File ${fileName} not found.`);

    await deleteStorageFile(userId, fileName);
    await updateFileCount(userId, false);
    await ctx.reply(`✅ File ${fileName} deleted successfully.`);
  } catch (error) {
    ctx.reply(`❌ Error deleting file ${fileName}.`);
    console.error(error);
  }
});

// ─── File Upload Handler ──────────────────────────────────────────────────────

bot.on('document', async (ctx) => {
  const userId = ctx.from.id;

  if (isBanned(userId)) return ctx.reply('❌ You are banned from using this bot.');

  const canUpload = await canUploadFile(userId);
  if (!canUpload) {
    const stats = await getUserStats(userId);
    const totalSlots = stats.baseLimit + stats.referrals.length;
    return ctx.reply(
      `❌ You've reached your file upload limit (${stats.fileCount}/${totalSlots})\n\n` +
      `Share your referral link to get more slots:\nt.me/${ctx.botInfo.username}?start=${userId}`
    );
  }

  const file = ctx.message.document;

  const allowedTypes = await getConfig('fileTypes') || { html: true, zip: true, js: false, css: false };
  const fileExt = file.file_name.split('.').pop().toLowerCase();

  if (
    !['html', 'zip', 'js', 'css'].includes(fileExt) ||
    (fileExt === 'html' && !allowedTypes.html) ||
    (fileExt === 'zip' && !allowedTypes.zip) ||
    (fileExt === 'js' && !allowedTypes.js) ||
    (fileExt === 'css' && !allowedTypes.css)
  ) {
    const allowedExtList = Object.entries(allowedTypes)
      .filter(([_, isAllowed]) => isAllowed)
      .map(([ext]) => `.${ext.toUpperCase()}`)
      .join(', ');
    return ctx.reply(`⚠️ Invalid file type. Currently allowed file types are: ${allowedExtList}`);
  }

  const progressMsg = await ctx.reply(
    '📤 *Processing Your File*\n\n' +
    '⬆️ Progress Bar:\n' +
    '▰▰▰▰▰▰▰▰▰▰ 100%\n\n' +
    '✨ _Almost done..._',
    { parse_mode: 'Markdown' }
  );

  try {
    const contentType = file.file_name.endsWith('.html') ? 'text/html; charset=utf-8' : (file.mime_type || 'application/octet-stream');

    // Send the file to the Telegram storage channel using its file_id.
    // Telegram reuses the file internally — no download/re-upload needed.
    await uploadFile(userId, file.file_name, file.file_id, contentType, file.file_size);
    const publicUrl = getPublicUrl(userId, file.file_name);

    await updateFileCount(userId, true);
    const stats = await getUserStats(userId);
    const totalSlots = stats.baseLimit + stats.referrals.length;

    ctx.reply(
      `🎉 <b>Success! File Uploaded!</b>\n\n` +
      `📂 File Link:\n${publicUrl}\n\n` +
      `📊 Storage Usage: ${stats.fileCount}/${totalSlots}\n\n` +
      `🎁 <b>Want More Storage?</b>\n` +
      `Share your referral link:\n` +
      `t.me/${ctx.botInfo.username}?start=${userId}\n\n` +
      `💡 <i>For best results, open in Chrome browser</i>`,
      { parse_mode: 'HTML' }
    );

    ctx.replyWithAnimation('https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjExcDN1Z2E3OGhpbXE3M3Q2NmFwbzF6Y2ptdWxqdWx0NXh0aHR4anV3eiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/xT0xezQGU5xCDJuCPe/giphy.gif');
  } catch (error) {
    ctx.reply('❌ Error uploading your file. Try again later.');
    console.error(error);
  }
});

// ─── Admin: Add Slots ─────────────────────────────────────────────────────────

bot.action('add_slots', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'add_slots');
  await ctx.reply('Please send the message in format:\nUserID NumberOfSlots\n\nExample: 123456789 5');
});

// ─── Admin: Referral Stats ────────────────────────────────────────────────────

bot.action('referral_stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const { data: allUsers } = await supabase.from('users').select('name, chat_id, stats');
  if (!allUsers || allUsers.length === 0) return ctx.reply('⚠️ No users found.');

  let totalReferrals = 0;
  let topReferrers = [];

  allUsers.forEach(user => {
    const stats = user.stats || { referrals: [] };
    const referralCount = stats.referrals.length;
    totalReferrals += referralCount;
    if (referralCount > 0) {
      topReferrers.push({ name: user.name || 'Unknown', chatId: user.chat_id, referrals: referralCount });
    }
  });

  topReferrers.sort((a, b) => b.referrals - a.referrals);

  let message = `📊 Referral System Statistics\n\nTotal Referrals: ${totalReferrals}\n\nTop Referrers:\n`;
  topReferrers.slice(0, 10).forEach((user, index) => {
    message += `${index + 1}. ${user.name} (ID: ${user.chatId}) - ${user.referrals} referrals\n`;
  });

  ctx.reply(message);
});

// ─── Admin: Daily Stats ───────────────────────────────────────────────────────

bot.action('daily_stats', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to view this information.');

  const today = new Date().toISOString().split('T')[0];
  const { data } = await supabase.from('daily_stats').select('*').eq('date', today).single();

  if (!data) return ctx.reply('📊 No users today yet.');
  ctx.reply(`📊 Daily Statistics\n\nToday (${today}):\n👥 Total Users: ${data.count}`);
});

// ─── Admin: View All Files ────────────────────────────────────────────────────

bot.action('view_files', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const { data: allUsers } = await supabase.from('users').select('id, name');
  if (!allUsers || allUsers.length === 0) return ctx.reply('📂 No users found.');

  let totalFiles = 0;
  let filesByUser = {};

  for (const user of allUsers) {
    const files = await listUserFiles(user.id);
    if (files.length > 0) {
      filesByUser[user.id] = { files, name: user.name };
      totalFiles += files.length;
    }
  }

  if (totalFiles === 0) return ctx.reply('📂 No uploaded files found.');

  await ctx.reply(`📊 Found ${totalFiles} files from ${Object.keys(filesByUser).length} users`);

  for (const [uid, { files, name }] of Object.entries(filesByUser)) {
    let message = `👤 User: ${name || 'Unknown'} (ID: ${uid}) - ${files.length} files\n\n`;
    const displayFiles = files.slice(0, 10);
    const remaining = files.length - 10;

    for (const file of displayFiles) {
      const fileUrl = getPublicUrl(uid, file.name);
      message += `📄 ${file.name}\n${fileUrl}\n\n`;
    }

    if (remaining > 0) message += `\n...and ${remaining} more files`;

    await ctx.reply(message);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});

// ─── Admin: View Users ────────────────────────────────────────────────────────

bot.command('viewusers', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to view this information.');

  const { data: allUsers } = await supabase.from('users').select('name, chat_id');
  if (!allUsers || allUsers.length === 0) return ctx.reply('⚠️ No users found.');

  let userList = `📜 Total Users: ${allUsers.length}\n\n`;
  allUsers.forEach(user => {
    userList += `👤 Name: ${user.name || 'Unknown'}\n💬 Chat ID: ${user.chat_id}\n\n`;
  });

  ctx.reply(userList);
});

// ─── Admin: Total Users ───────────────────────────────────────────────────────

bot.action('total_users', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const { data: allUsers } = await supabase.from('users').select('name, chat_id');
  if (!allUsers || allUsers.length === 0) return ctx.reply('⚠️ No registered users found.');

  let userList = `📊 Total Users: ${allUsers.length}\n\n`;
  let count = 0;

  for (const user of allUsers) {
    count++;
    userList += `${count}. 👤 ${user.name || 'Unknown'} (ID: ${user.chat_id})\n`;

    if (count % 50 === 0) {
      await ctx.reply(userList);
      userList = '';
    }
  }

  if (userList) await ctx.reply(userList);
});

// ─── Admin: Broadcast ─────────────────────────────────────────────────────────

const broadcastStates = new Map();

bot.action('broadcast', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  broadcastStates.set(ctx.from.id, true);
  await ctx.reply('📢 Please send the message you want to broadcast (Text, Image, or Video).');

  bot.on('message', async (msgCtx) => {
    if (!isAdmin(msgCtx.from.id) || !broadcastStates.get(msgCtx.from.id)) return;

    try {
      broadcastStates.delete(msgCtx.from.id);

      const message = msgCtx.message;
      const { data: allUsers } = await supabase.from('users').select('chat_id');
      if (!allUsers || allUsers.length === 0) return msgCtx.reply('⚠️ No users found.');

      let sentCount = 0;
      let failedCount = 0;

      for (const user of allUsers) {
        const chatId = user.chat_id;
        try {
          if (message.text) {
            await bot.telegram.sendMessage(chatId, message.text);
            sentCount++;
          } else if (message.photo) {
            const photoId = message.photo[message.photo.length - 1].file_id;
            await bot.telegram.sendPhoto(chatId, photoId, { caption: message.caption || '' });
            sentCount++;
          } else if (message.video) {
            await bot.telegram.sendVideo(chatId, message.video.file_id, { caption: message.caption || '' });
            sentCount++;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          failedCount++;
        }
      }

      msgCtx.reply(`📊 Broadcast Results:\n✅ Sent to: ${sentCount} users\n❌ Failed: ${failedCount} users`);
    } catch (error) {
      msgCtx.reply('❌ Error occurred during broadcast. Please try again.');
    }
  });
});

// ─── Admin: Send Notification ─────────────────────────────────────────────────

bot.action('send_notification', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'send_notification');
  await ctx.reply('📣 Please send the notification message you want to send to all users.');
});

// ─── Admin: Ban / Unban ───────────────────────────────────────────────────────

bot.action('ban_user', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'ban_user');
  banUserMode = true; unbanUserMode = false;
  ctx.reply('Please send the user ID to ban:');
});

bot.action('unban_user', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'unban_user');
  banUserMode = false; unbanUserMode = true;
  ctx.reply('Please send the user ID to unban:');
});

// ─── Admin: Premium Users ─────────────────────────────────────────────────────

bot.action('premium_users', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const premiumMenu = Markup.inlineKeyboard([
    [Markup.button.callback('👑 Add Premium User', 'add_premium_user'), Markup.button.callback('❌ Remove Premium', 'remove_premium_user')],
    [Markup.button.callback('📋 List Premium Users', 'list_premium_users'), Markup.button.callback('⚙️ Premium Settings', 'premium_settings')],
    [Markup.button.callback('◀️ Back to Admin Menu', 'back_to_admin')]
  ]);

  await ctx.reply('👑 *Premium User Management*\n\nManage premium users and their special privileges.', {
    parse_mode: 'Markdown', ...premiumMenu
  });
});

bot.action('add_premium_user', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'add_premium_user');
  await ctx.reply('Please enter the user ID to make premium:');
});

bot.action('remove_premium_user', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'remove_premium_user');
  await ctx.reply('Please enter the user ID to remove premium status:');
});

bot.action('list_premium_users', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const { data: premiumUsers } = await supabase.from('users').select('name, chat_id, premium_since').eq('premium', true);

  if (!premiumUsers || premiumUsers.length === 0) return ctx.reply('📝 No premium users found.');

  let message = '👑 *Premium Users*\n\n';
  premiumUsers.forEach(user => {
    message += `👤 ${user.name || 'Unknown'} (ID: ${user.chat_id})\n`;
    message += `📅 Premium since: ${user.premium_since || 'Unknown'}\n\n`;
  });

  await ctx.reply(message, { parse_mode: 'Markdown' });
});

// ─── Admin: Premium Settings ──────────────────────────────────────────────────

bot.action('premium_settings', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const premiumSettingsMenu = Markup.inlineKeyboard([
    [Markup.button.callback('⚙️ Default Premium Slots', 'premium_default_slots'), Markup.button.callback('📊 Premium Features', 'premium_features')],
    [Markup.button.callback('⏱️ Premium Duration', 'premium_duration'), Markup.button.callback('🎁 Premium Welcome Msg', 'premium_welcome_msg')],
    [Markup.button.callback('◀️ Back to Premium Menu', 'premium_users')]
  ]);

  await ctx.reply('⚙️ *Premium Settings*\n\nConfigure premium user benefits and features.', {
    parse_mode: 'Markdown', ...premiumSettingsMenu
  });
});

bot.action('premium_default_slots', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'premium_default_slots');
  await ctx.reply('Please enter the default number of slots for premium users:');
});

bot.action('premium_features', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const features = await getConfig('premiumFeatures') || {};

  const enabledFeatures = Object.entries(features).filter(([_, v]) => v).map(([k]) => `✅ ${k}`).join('\n');
  const disabledFeatures = Object.entries(features).filter(([_, v]) => !v).map(([k]) => `❌ ${k}`).join('\n');

  const featureMenu = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Enable Priority Support', 'enable_priority_support'), Markup.button.callback('❌ Disable Priority Support', 'disable_priority_support')],
    [Markup.button.callback('✅ Enable More File Types', 'enable_more_file_types'), Markup.button.callback('❌ Disable More File Types', 'disable_more_file_types')],
    [Markup.button.callback('✅ Enable No Daily Limit', 'enable_no_daily_limit'), Markup.button.callback('❌ Disable No Daily Limit', 'disable_no_daily_limit')],
    [Markup.button.callback('◀️ Back to Premium Settings', 'premium_settings')]
  ]);

  let message = '🎭 *Premium Features*\n\n';
  if (enabledFeatures) message += `*Enabled Features:*\n${enabledFeatures}\n\n`;
  if (disabledFeatures) message += `*Disabled Features:*\n${disabledFeatures}\n\n`;
  message += `Select features to enable or disable:`;

  await ctx.reply(message, { parse_mode: 'Markdown', ...featureMenu });
});

bot.action('premium_duration', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'premium_duration');
  await ctx.reply('Please enter the default premium subscription duration in days:');
});

bot.action('premium_welcome_msg', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'premium_welcome_msg');
  await ctx.reply('Please enter the welcome message for new premium users. You can use Markdown formatting:');
});

bot.action(/^(enable|disable)_(priority_support|more_file_types|no_daily_limit)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const action = ctx.match[1];
  const feature = ctx.match[2];
  const enabled = action === 'enable';

  const features = await getConfig('premiumFeatures') || {};
  features[feature] = enabled;
  await setConfig('premiumFeatures', features, ctx.from.id);

  await ctx.reply(`✅ ${feature.replace(/_/g, ' ').toUpperCase()} has been ${enabled ? 'enabled' : 'disabled'} for premium users.`);
});

bot.action('back_to_admin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  await ctx.reply('Back to Admin Panel:', adminMenu);
});

// ─── Admin: text handler (state machine) ─────────────────────────────────────

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text.trim();

  if (isAdmin(userId)) {
    const adminState = adminStates.get(userId);

    if (adminState === 'add_slots') {
      adminStates.delete(userId);
      const [targetUserId, slotsToAdd] = text.trim().split(' ');
      const slots = parseInt(slotsToAdd);

      if (!targetUserId || isNaN(slots)) return ctx.reply('❌ Invalid format. Please use: UserID NumberOfSlots');

      const { data: targetUser } = await supabase.from('users').select('stats').eq('id', String(targetUserId)).single();
      if (!targetUser) return ctx.reply('❌ User not found.');

      const currentStats = targetUser.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
      currentStats.baseLimit += slots;
      await supabase.from('users').update({ stats: currentStats }).eq('id', String(targetUserId));
      await ctx.reply(`✅ Successfully added ${slots} slots to user ${targetUserId}.\nNew total slots: ${currentStats.baseLimit + currentStats.referrals.length}`);
      await sendNotificationToUsers(`🔔 *Storage Update*\n\nYour storage slots have been updated! You now have ${currentStats.baseLimit + currentStats.referrals.length} total slots.`, targetUserId);
      return;
    }

    if (adminState === 'send_notification') {
      adminStates.delete(userId);
      if (!text || text.length < 5) return ctx.reply('❌ Please provide a valid notification message (at least 5 characters).');
      const sentCount = await sendNotificationToUsers(`🔔 *NOTIFICATION*\n\n${text}\n\n_From: Admin_`);
      await ctx.reply(`✅ Notification sent successfully to ${sentCount} users.`);
      return;
    }

    if (adminState === 'report_bug') {
      adminStates.delete(userId);
      const userName = ctx.from.first_name || 'Unknown';
      const bugReportMessage = `🐛 *Bug Report Received*\n\nFrom: ${userName} (ID: ${userId})\n\n*Report:*\n${text}\n\nSubmitted: ${new Date().toISOString()}`;
      const adminIds = process.env.ADMIN_ID.split(',').map(id => id.trim());
      for (const aid of adminIds) {
        try { await bot.telegram.sendMessage(aid, bugReportMessage, { parse_mode: 'Markdown' }); } catch (e) { }
      }
      await ctx.reply('✅ *Bug Report Submitted*\n\nThank you for your report! Our team has been notified.', { parse_mode: 'Markdown' });
      return;
    }

    if (adminState === 'message_user') {
      adminStates.delete(userId);
      const targetUserId = adminStates.get(userId + '_target');
      adminStates.delete(userId + '_target');
      if (!targetUserId) return ctx.reply('❌ Error: No target user specified.');
      await sendNotificationToUsers(`📨 *Message from Admin*\n\n${text}\n\nTo reply, please use the "Contact Admin" button in the main menu.`, targetUserId);
      await ctx.reply(`✅ Message sent successfully to user ${targetUserId}.`);
      return;
    }

    if (adminState === 'add_premium_user_prefilled') {
      adminStates.delete(userId);
      const targetUserId = adminStates.get(userId + '_target');
      adminStates.delete(userId + '_target');
      if (!targetUserId) return ctx.reply('❌ Error: No target user specified.');

      const premiumSettings = await getConfig('premiumSettings') || {};
      let premiumSlots = parseInt(text.trim());
      if (isNaN(premiumSlots) || premiumSlots < 1) premiumSlots = premiumSettings.defaultSlots || 10;

      const durationInDays = premiumSettings.durationInDays || 30;
      const now = new Date();
      const premiumUntil = new Date(now.getTime() + durationInDays * 24 * 60 * 60 * 1000);

      const { data: targetUser } = await supabase.from('users').select('stats').eq('id', String(targetUserId)).single();
      if (!targetUser) return ctx.reply('❌ User not found.');

      const currentStats = targetUser.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
      currentStats.baseLimit = premiumSlots;

      await supabase.from('users').update({
        premium: true,
        premium_until: premiumUntil.toISOString(),
        premium_approved_by: String(userId),
        premium_approved_at: now.toISOString(),
        stats: currentStats
      }).eq('id', String(targetUserId));

      await ctx.reply(`✅ User ${targetUserId} is now a premium user with ${premiumSlots} slots until ${premiumUntil.toDateString()}!`);

      let welcomeMessage = premiumSettings.welcomeMessage
        ? premiumSettings.welcomeMessage.replace('{slots}', premiumSlots)
        : `🌟 *Premium Upgrade*\n\nCongratulations! Your premium request has been approved!\n\n✨ Benefits:\n• ${premiumSlots} storage slots\n• Priority support\n• More file formats support\n\nExpires: ${premiumUntil.toDateString()}`;

      await sendNotificationToUsers(welcomeMessage, targetUserId);
      return;
    }

    if (adminState === 'update_welcome_msg') {
      adminStates.delete(userId);
      if (!text || text.length < 10) return ctx.reply('❌ Please provide a valid welcome message (at least 10 characters).');
      await setConfig('welcomeMessage', { message: text }, userId);
      await ctx.reply('✅ Welcome message updated successfully.');
      return;
    }

    if (adminState === 'add_premium_user') {
      adminStates.delete(userId);
      const targetUserId = text.trim();
      if (!targetUserId) return ctx.reply('❌ Please provide a valid user ID.');

      const { data: targetUser } = await supabase.from('users').select('stats').eq('id', String(targetUserId)).single();
      if (!targetUser) return ctx.reply('❌ User not found.');

      const premiumSettings = await getConfig('premiumSettings') || {};
      const premiumSlots = premiumSettings.defaultSlots || 20;
      const durationInDays = premiumSettings.durationInDays || 30;

      const now = new Date();
      const expiryDate = new Date();
      expiryDate.setDate(now.getDate() + durationInDays);

      const currentStats = targetUser.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
      currentStats.baseLimit = premiumSlots;

      await supabase.from('users').update({
        premium: true,
        premium_since: now.toISOString(),
        premium_until: expiryDate.toISOString(),
        premium_slots: premiumSlots,
        premium_duration: durationInDays,
        stats: currentStats
      }).eq('id', String(targetUserId));

      await ctx.reply(`✅ User ${targetUserId} is now a premium user with ${premiumSlots} slots!`);

      const welcomeMessage = premiumSettings.welcomeMessage
        ? premiumSettings.welcomeMessage.replace('{slots}', premiumSlots)
        : `🌟 *Premium Upgrade*\n\nCongratulations! Your account has been upgraded to premium!\n\n✨ Benefits:\n• ${premiumSlots} storage slots\n• Priority support\n\nThank you for your support!`;

      await sendNotificationToUsers(welcomeMessage, targetUserId);
      return;
    }

    if (adminState === 'remove_premium_user') {
      adminStates.delete(userId);
      const targetUserId = text.trim();
      if (!targetUserId) return ctx.reply('❌ Please provide a valid user ID.');

      const { data: targetUser } = await supabase.from('users').select('premium, stats').eq('id', String(targetUserId)).single();
      if (!targetUser) return ctx.reply('❌ User not found.');
      if (!targetUser.premium) return ctx.reply('⚠️ This user is not a premium user.');

      const currentStats = targetUser.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
      currentStats.baseLimit = 2;

      await supabase.from('users').update({
        premium: false,
        premium_until: new Date().toISOString(),
        stats: currentStats
      }).eq('id', String(targetUserId));

      await ctx.reply(`✅ Premium status removed from user ${targetUserId}.`);
      await sendNotificationToUsers(
        `⚠️ *Premium Status Update*\n\nYour premium subscription has ended. Your account has been reverted to standard status.\n\nCurrent storage slots: ${currentStats.baseLimit + currentStats.referrals.length}`,
        targetUserId
      );
      return;
    }

    if (adminState === 'view_user_files') {
      adminStates.delete(userId);
      const targetUserId = text.trim();
      if (!targetUserId) return ctx.reply('❌ Please provide a valid user ID.');

      const { data: targetUser } = await supabase.from('users').select('id').eq('id', String(targetUserId)).single();
      if (!targetUser) return ctx.reply('❌ User not found.');

      const files = await listUserFiles(targetUserId);
      if (files.length === 0) return ctx.reply(`📂 User ${targetUserId} has no uploaded files.`);

      let message = `📄 Files uploaded by user ${targetUserId}:\n\n`;
      for (const file of files) {
        const url = getPublicUrl(targetUserId, file.name);
        message += `• 🔗 [${file.name}](${url})\n`;
      }
      message += `\nTotal files: ${files.length}`;
      await ctx.reply(message, { parse_mode: 'Markdown' });
      return;
    }

    if (adminState === 'delete_user_files') {
      adminStates.delete(userId);
      const targetUserId = text.trim();
      if (!targetUserId) return ctx.reply('❌ Please provide a valid user ID.');

      const { data: targetUser } = await supabase.from('users').select('id').eq('id', String(targetUserId)).single();
      if (!targetUser) return ctx.reply('❌ User not found.');

      const files = await listUserFiles(targetUserId);
      if (files.length === 0) return ctx.reply(`📂 User ${targetUserId} has no files to delete.`);

      const confirmationMenu = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Yes, delete all files', `confirm_delete_${targetUserId}`), Markup.button.callback('❌ No, cancel deletion', 'cancel_delete')]
      ]);
      await ctx.reply(`⚠️ Are you sure you want to delete all ${files.length} files from user ${targetUserId}?`, confirmationMenu);
      return;
    }

    if (adminState === 'premium_default_slots') {
      adminStates.delete(userId);
      const slots = parseInt(text.trim());
      if (isNaN(slots) || slots < 1) return ctx.reply('❌ Please enter a valid number of slots (at least 1).');

      const existing = await getConfig('premiumSettings') || {};
      existing.defaultSlots = slots;
      await setConfig('premiumSettings', existing, userId);

      const { data: premiumUsers } = await supabase.from('users').select('id, stats').eq('premium', true);
      let updatedCount = 0;

      if (premiumUsers && premiumUsers.length > 0) {
        for (const user of premiumUsers) {
          const stats = user.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
          stats.baseLimit = slots;
          await supabase.from('users').update({ stats }).eq('id', user.id);
          updatedCount++;
        }
        await ctx.reply(`✅ Default premium slots updated to ${slots}.\n\nUpdated ${updatedCount} existing premium users.`);
        for (const user of premiumUsers) {
          sendNotificationToUsers(`🌟 *Premium Update*\n\nYour premium slot allocation has been updated to ${slots} slots!`, user.chat_id);
        }
      } else {
        await ctx.reply(`✅ Default premium slots updated to ${slots}.\n\nNo existing premium users to update.`);
      }
      return;
    }

    if (adminState === 'premium_duration') {
      adminStates.delete(userId);
      const days = parseInt(text.trim());
      if (isNaN(days) || days < 1) return ctx.reply('❌ Please enter a valid number of days (at least 1).');

      const existing = await getConfig('premiumSettings') || {};
      existing.durationInDays = days;
      await setConfig('premiumSettings', existing, userId);
      await ctx.reply(`✅ Premium subscription duration updated to ${days} days.`);
      return;
    }

    if (adminState === 'premium_welcome_msg') {
      adminStates.delete(userId);
      if (!text || text.length < 10) return ctx.reply('❌ Please provide a valid welcome message (at least 10 characters).');
      const existing = await getConfig('premiumSettings') || {};
      existing.welcomeMessage = text;
      await setConfig('premiumSettings', existing, userId);
      await ctx.reply('✅ Premium welcome message updated successfully.');
      return;
    }

    if (banUserMode) {
      banUserMode = false;
      bannedUsers.add(text);
      await ctx.reply(`✅ User ${text} has been banned.`);
      return;
    }

    if (unbanUserMode) {
      unbanUserMode = false;
      bannedUsers.delete(text);
      await ctx.reply(`✅ User ${text} has been unbanned.`);
      await sendNotificationToUsers(`🔔 *Account Status Update*\n\nYour account has been unbanned! You can now use all the bot features again.`, text);
      return;
    }

    if (defaultSlotsMode) {
      defaultSlotsMode = false;
      const newLimit = parseInt(text);
      if (isNaN(newLimit) || newLimit < 1) return ctx.reply('❌ Please enter a valid number greater than 0.');

      const { data: allUsers } = await supabase.from('users').select('id, stats');
      for (const user of (allUsers || [])) {
        const stats = user.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
        stats.baseLimit = newLimit;
        await supabase.from('users').update({ stats }).eq('id', user.id);
      }
      await ctx.reply(`✅ Default slot limit updated to ${newLimit} for all users.`);
      await sendNotificationToUsers(`🔔 *Storage Update*\n\nThe default storage slot limit has been updated to ${newLimit} slots!`);
      return;
    }

    if (referralRewardMode) {
      referralRewardMode = false;
      const rewardSlots = parseInt(text);
      if (isNaN(rewardSlots) || rewardSlots < 1) return ctx.reply('❌ Please enter a valid number greater than 0.');

      const { data: allUsers } = await supabase.from('users').select('id, stats');
      for (const user of (allUsers || [])) {
        const stats = user.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
        stats.referralReward = rewardSlots;
        await supabase.from('users').update({ stats }).eq('id', user.id);
      }
      await ctx.reply(`✅ Referral reward updated to ${rewardSlots} slots per referral.`);
      await sendNotificationToUsers(`🔔 *Referral Program Update*\n\nThe referral reward has been updated to ${rewardSlots} slots per referral!`);
      return;
    }
  }
});

// ─── Admin: Edit Default Slots ────────────────────────────────────────────────

bot.action('edit_default_slots', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'edit_default_slots');
  banUserMode = false; unbanUserMode = false; defaultSlotsMode = true; referralRewardMode = false;
  ctx.reply('Please enter the new default slot limit for new users:');
});

bot.action('edit_referral_reward', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'edit_referral_reward');
  banUserMode = false; unbanUserMode = false; defaultSlotsMode = false; referralRewardMode = true;
  ctx.reply('Please enter the new number of slots to reward per referral:');
});

// ─── Admin: View / Delete user files ─────────────────────────────────────────

bot.action('view_user_files', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'view_user_files');
  await ctx.reply('Please enter the user ID to view their files:');
});

bot.action('delete_user_files', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'delete_user_files');
  await ctx.reply('Please enter the user ID to delete their files:');
});

bot.action(/^confirm_delete_(.+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const targetUserId = ctx.match[1];
  const deletedCount = await deleteAllUserFiles(targetUserId);

  if (deletedCount === 0) return ctx.reply(`📂 User ${targetUserId} has no files to delete.`);

  const { data: targetUser } = await supabase.from('users').select('stats').eq('id', String(targetUserId)).single();
  if (targetUser) {
    const stats = targetUser.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
    stats.fileCount = 0;
    await supabase.from('users').update({ stats }).eq('id', String(targetUserId));
    await sendNotificationToUsers(`⚠️ *Files Removed*\n\nAn administrator has deleted all your files.`, targetUserId);
  }

  await ctx.reply(`✅ Successfully deleted ${deletedCount} files from user ${targetUserId}.`);
});

bot.action('cancel_delete', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  await ctx.reply('✅ Deletion cancelled.');
});

// ─── Admin: Commands ──────────────────────────────────────────────────────────

bot.command('viewbanned', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to view this information.');
  if (bannedUsers.size === 0) return ctx.reply('📢 No users are currently banned.');
  let message = '🚫 Banned Users:\n\n';
  bannedUsers.forEach(uid => { message += `• ${uid}\n`; });
  ctx.reply(message);
});

bot.command('clearbans', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  const count = bannedUsers.size;
  bannedUsers.clear();
  ctx.reply(`✅ Cleared all bans (${count} users unbanned)`);
});

bot.command('viewusers', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to view this information.');
  const { data: allUsers } = await supabase.from('users').select('name, chat_id');
  if (!allUsers || allUsers.length === 0) return ctx.reply('⚠️ No users found.');
  let userList = `📜 Total Users: ${allUsers.length}\n\n`;
  allUsers.forEach(u => { userList += `👤 Name: ${u.name || 'Unknown'}\n💬 Chat ID: ${u.chat_id}\n\n`; });
  ctx.reply(userList);
});

bot.command('help', (ctx) => {
  if (isAdmin(ctx.from.id)) {
    ctx.reply(
      `⚙️ **Admin Commands:**\n` +
      `/viewusers - View all users\n` +
      `/viewbanned - View banned users\n` +
      `/clearbans - Clear all bans\n` +
      `/status - View bot status`
    );
  } else {
    ctx.reply(`⚙️ **User Commands:**\n/upload - Upload a file\n/myfiles - View your uploaded files`);
  }
});

// ─── Get Premium ──────────────────────────────────────────────────────────────

bot.action('get_premium', async (ctx) => {
  const userId = ctx.from.id;
  const userName = ctx.from.first_name || 'Unknown';

  const { data: user } = await supabase.from('users').select('premium').eq('id', String(userId)).single();
  if (user && user.premium) {
    return ctx.reply('✨ *You are already a Premium user!*\n\nYou already have access to all premium features.', { parse_mode: 'Markdown' });
  }

  await ctx.reply(
    '🌟 *Premium Upgrade Request*\n\n' +
    'Your request has been sent to the administrators. An admin will review your request and contact you soon.\n\n' +
    '✨ *Premium Benefits:*\n• More storage slots\n• Priority support\n• Advanced file formats\n• Faster upload speeds\n\n' +
    'Thank you for your interest!',
    { parse_mode: 'Markdown' }
  );

  const adminIds = process.env.ADMIN_ID.split(',').map(id => id.trim());
  const adminMessage = `🔔 *New Premium Request*\n\n👤 User: ${userName}\n🆔 ID: ${userId}\n\nUse the buttons below to manage this request:`;
  const premiumRequestButtons = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Approve Premium', `approve_premium_${userId}`), Markup.button.callback('❌ Deny Request', `deny_premium_${userId}`)],
    [Markup.button.callback('💬 Message User', `message_user_${userId}`)]
  ]);

  for (const aid of adminIds) {
    try {
      await bot.telegram.sendMessage(aid, adminMessage, { parse_mode: 'Markdown', ...premiumRequestButtons });
    } catch (error) { }
  }
});

bot.action(/approve_premium_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ You are not authorized.');
  const targetUserId = ctx.match[1];
  adminStates.set(ctx.from.id, 'add_premium_user_prefilled');
  adminStates.set(ctx.from.id + '_target', targetUserId);

  const premiumSettings = await getConfig('premiumSettings') || {};
  const defaultSlots = premiumSettings.defaultSlots || 10;

  await ctx.answerCbQuery('✅ Processing premium approval');
  await ctx.reply(
    `🌟 *Premium Approval Process*\n\nUser ID: ${targetUserId}\nDefault premium slots: ${defaultSlots}\n\nHow many slots do you want to give this user? Press enter with a number or send the number now (default: ${defaultSlots}):`,
    { parse_mode: 'Markdown' }
  );
});

bot.action(/deny_premium_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ You are not authorized.');
  const targetUserId = ctx.match[1];
  await ctx.answerCbQuery('✅ Premium request denied');
  await sendNotificationToUsers(
    `⚠️ *Premium Request Update*\n\nYour request for premium access has been reviewed and cannot be approved at this time.\n\nIf you have questions, please contact our admin using the Contact Admin button.`,
    targetUserId
  );
  await ctx.reply(`Premium request for user ${targetUserId} has been denied and the user has been notified.`);
});

bot.action(/message_user_(\d+)/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('❌ You are not authorized.');
  const targetUserId = ctx.match[1];
  adminStates.set(ctx.from.id, 'message_user');
  adminStates.set(ctx.from.id + '_target', targetUserId);
  await ctx.answerCbQuery('✅ Ready to send message to user');
  await ctx.reply(`💬 *Direct Message to User*\n\nYou're about to send a direct message to user ${targetUserId}.\n\nType your message below:`, { parse_mode: 'Markdown' });
});

// ─── Advanced Options ─────────────────────────────────────────────────────────

bot.action('advanced_options', async (ctx) => {
  const advancedOptionsMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🔔 Notification Settings', 'notification_settings'), Markup.button.callback('🔐 Privacy Options', 'privacy_options')],
    [Markup.button.callback('⚙️ File Type Preferences', 'file_preferences'), Markup.button.callback('🎨 Display Settings', 'display_settings')],
    [Markup.button.callback('📱 Account Settings', 'account_settings'), Markup.button.callback('🔧 Technical Support', 'tech_support')],
    [Markup.button.callback('⬅️ Back to Main Menu', 'back_to_main')]
  ]);
  await ctx.reply('⚙️ *Advanced Options*\n\nCustomize your bot experience:', { parse_mode: 'Markdown', ...advancedOptionsMenu });
});

bot.action('privacy_options', async (ctx) => {
  await ctx.reply(
    '🔐 *Privacy Settings*\n\n' +
    '• Your files are stored securely in our cloud storage\n' +
    '• Your personal information is never shared with third parties\n' +
    '• You can request deletion of all your data at any time',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑️ Delete All My Data', 'delete_my_data'), Markup.button.callback('📋 Request My Data', 'request_my_data')],
        [Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')]
      ])
    }
  );
});

bot.action('display_settings', async (ctx) => {
  await ctx.reply(
    '🎨 *Display Settings*\n\n*Current Settings:*\n• Language: English\n• Time Format: 24-hour\n• Link Preview: Enabled',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Reset to Default', 'reset_display'), Markup.button.callback('⬅️ Back', 'advanced_options')]
      ])
    }
  );
});

bot.action('account_settings', async (ctx) => {
  const userId = ctx.from.id;
  const { data: user } = await supabase.from('users').select('joined_at, premium, premium_until').eq('id', String(userId)).single();

  if (!user) return ctx.reply('❌ Error: User data not found.');

  const joinDate = user.joined_at ? new Date(user.joined_at).toLocaleDateString() : 'Unknown';
  const premiumStatus = user.premium ? '✅ Premium' : '❌ Standard';
  const premiumExpiry = user.premium_until ? new Date(user.premium_until).toLocaleDateString() : 'N/A';

  await ctx.reply(
    '📱 *Account Settings*\n\n' +
    `User ID: ${userId}\nJoined: ${joinDate}\nStatus: ${premiumStatus}\nPremium Expiry: ${premiumExpiry}\n\n` +
    'Manage your account using the options below:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👑 Upgrade to Premium', 'get_premium'), Markup.button.callback('📞 Contact Support', 'contact')],
        [Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')]
      ])
    }
  );
});

bot.action('file_preferences', async (ctx) => {
  await ctx.reply(
    '⚙️ *File Type Preferences*\n\n' +
    'Premium users can upload these file types:\n' +
    '• HTML - ✅ Always Enabled\n• ZIP - ✅ Always Enabled\n• CSS - ✅ Premium Only\n• JS - ✅ Premium Only\n\n' +
    'Standard users are limited to HTML and ZIP files only.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👑 Get Premium', 'get_premium'), Markup.button.callback('⬅️ Back', 'advanced_options')]
      ])
    }
  );
});

bot.action('notification_settings', async (ctx) => {
  const userId = ctx.from.id;
  const { data: user } = await supabase.from('users').select('notifications').eq('id', String(userId)).single();
  const currentSetting = user && user.notifications === false ? false : true;

  const notificationButtons = Markup.inlineKeyboard([
    [Markup.button.callback(currentSetting ? '✅ Notifications ON' : '⚪ Notifications ON', 'notifications_on'), Markup.button.callback(!currentSetting ? '✅ Notifications OFF' : '⚪ Notifications OFF', 'notifications_off')],
    [Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')]
  ]);

  await ctx.reply(
    `🔔 *Notification Settings*\n\nCurrent setting: ${currentSetting ? 'Notifications ON' : 'Notifications OFF'}`,
    { parse_mode: 'Markdown', ...notificationButtons }
  );
});

bot.action('notifications_on', async (ctx) => {
  await supabase.from('users').update({ notifications: true }).eq('id', String(ctx.from.id));
  await ctx.answerCbQuery('Notifications turned ON');
  await ctx.editMessageText(
    '🔔 *Notification Settings*\n\nCurrent setting: Notifications ON',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Notifications ON', 'notifications_on'), Markup.button.callback('⚪ Notifications OFF', 'notifications_off')],
        [Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')]
      ])
    }
  );
});

bot.action('notifications_off', async (ctx) => {
  await supabase.from('users').update({ notifications: false }).eq('id', String(ctx.from.id));
  await ctx.answerCbQuery('Notifications turned OFF');
  await ctx.editMessageText(
    '🔔 *Notification Settings*\n\nCurrent setting: Notifications OFF',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⚪ Notifications ON', 'notifications_on'), Markup.button.callback('✅ Notifications OFF', 'notifications_off')],
        [Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')]
      ])
    }
  );
});

bot.action('tech_support', async (ctx) => {
  await ctx.reply(
    '🔧 *Technical Support*\n\n' +
    'Need help with the bot? Here are some options:\n\n' +
    '1️⃣ *Common Issues*\n- Make sure your files are HTML or ZIP format\n- File size must be under 20MB\n- Check your storage slot availability\n\n' +
    '2️⃣ *Contact Admin*\n👤 @Gamaspyowner\n\n' +
    '3️⃣ *Premium Support*\nPremium users get priority support',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📝 Report a Bug', 'report_bug'), Markup.button.callback('📞 Contact Admin', 'contact')],
        [Markup.button.callback('⬅️ Back to Advanced Options', 'advanced_options')]
      ])
    }
  );
});

bot.action('report_bug', async (ctx) => {
  adminStates.set(ctx.from.id, 'report_bug');
  await ctx.reply(
    '🐛 *Report a Bug*\n\nPlease describe the issue you\'re experiencing in detail. Include:\n\n- What you were trying to do\n- What happened instead\n- Any error messages you saw\n\nType your bug report below:',
    { parse_mode: 'Markdown' }
  );
});

// ─── Premium Features Info ────────────────────────────────────────────────────

bot.action('premium_features_info', async (ctx) => {
  const premiumSettings = await getConfig('premiumSettings') || {};
  const defaultSlots = premiumSettings.defaultSlots || 10;
  const durationInDays = premiumSettings.durationInDays || 30;

  await ctx.reply(
    '✨ *Premium Features*\n\n🌟 *Upgrade Benefits:*\n' +
    `• ${defaultSlots} storage slots (vs 2 for free users)\n` +
    '• Support for more file formats\n• Priority support\n• Early access to new features\n• Ad-free experience\n\n' +
    `📅 *Subscription Duration:* ${durationInDays} days\n\n` +
    '💰 *How to Get Premium:*\nClick the "Get Premium" button in the main menu.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👑 Get Premium', 'get_premium'), Markup.button.callback('❓ FAQ', 'premium_faq')],
        [Markup.button.callback('⬅️ Back to Main Menu', 'back_to_main')]
      ])
    }
  );
});

bot.action('premium_faq', async (ctx) => {
  await ctx.reply(
    '❓ *Premium FAQ*\n\n' +
    '*Q: How do I become a premium user?*\nA: Click the "Get Premium" button to send a request to admins.\n\n' +
    '*Q: What payment methods are accepted?*\nA: Admin will contact you with available payment options.\n\n' +
    '*Q: Can I cancel my premium subscription?*\nA: Yes, contact admin to cancel at any time.\n\n' +
    '*Q: Will I lose my files if premium expires?*\nA: No, but you may not be able to add new files if over the free limit.\n\n' +
    '*Q: How long does premium last?*\nA: Subscription duration is set by admins, typically 30 days.',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('👑 Get Premium', 'get_premium'), Markup.button.callback('⬅️ Back', 'premium_features_info')]
      ])
    }
  );
});

// ─── Privacy: Delete My Data ──────────────────────────────────────────────────

bot.action('delete_my_data', async (ctx) => {
  const userId = ctx.from.id;
  const confirmationMenu = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Yes, delete ALL my data', `confirm_all_data_delete_${userId}`), Markup.button.callback('❌ Cancel', 'cancel_data_delete')]
  ]);
  await ctx.reply(
    '⚠️ *DELETE ALL DATA - CONFIRMATION*\n\nThis will delete *ALL* your uploaded files and account information. This action *CANNOT* be undone.\n\nAre you absolutely sure you want to proceed?',
    { parse_mode: 'Markdown', ...confirmationMenu }
  );
});

bot.action('cancel_data_delete', async (ctx) => {
  await ctx.answerCbQuery('Data deletion cancelled');
  await ctx.reply('✅ Data deletion cancelled. Your files and account information remain untouched.', {
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Privacy Settings', 'privacy_options')]])
  });
});

bot.action(/confirm_all_data_delete_(\d+)/, async (ctx) => {
  const userId = ctx.from.id;
  const targetId = ctx.match[1];

  if (String(userId) !== String(targetId)) return ctx.answerCbQuery('❌ Error: User ID mismatch');

  await ctx.answerCbQuery('Processing data deletion...');

  try {
    const deletedCount = await deleteAllUserFiles(userId);

    if (deletedCount > 0) {
      await ctx.reply(`🗑️ *Deleting your files...*\n\nDeleted ${deletedCount} files.`, { parse_mode: 'Markdown' });
    }

    const { data: user } = await supabase.from('users').select('stats').eq('id', String(userId)).single();
    if (user) {
      const currentStats = user.stats || { fileCount: 0, referrals: [], baseLimit: 2 };
      currentStats.fileCount = 0;
      await supabase.from('users').update({
        stats: currentStats,
        account_deleted: true,
        deleted_at: new Date().toISOString(),
        notifications: false
      }).eq('id', String(userId));
    }

    await ctx.reply(
      '✅ *Data Deletion Complete*\n\nAll your files and personal data have been deleted from our system.',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Main Menu', 'back_to_main')]]) }
    );
  } catch (error) {
    console.error('Error deleting user data:', error);
    await ctx.reply(
      '❌ *Error During Data Deletion*\n\nWe encountered a problem. Please try again later or contact an admin.',
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Privacy Settings', 'privacy_options')]]) }
    );
  }
});

bot.action('request_my_data', async (ctx) => {
  const userId = ctx.from.id;

  const { data: user } = await supabase.from('users').select('*').eq('id', String(userId)).single();
  if (!user) return ctx.reply('❌ Error: User data not found.');

  const files = await listUserFiles(userId);

  let dataReport = `📊 *Your Data Report*\n\n*Account Information:*\n`;
  dataReport += `👤 User ID: ${userId}\n`;
  dataReport += `📅 Joined: ${user.joined_at ? new Date(user.joined_at).toLocaleDateString() : 'Unknown'}\n`;
  dataReport += `✨ Premium: ${user.premium ? 'Yes' : 'No'}\n`;
  if (user.premium) dataReport += `📆 Premium Until: ${user.premium_until ? new Date(user.premium_until).toLocaleDateString() : 'N/A'}\n`;

  const stats = user.stats || {};
  dataReport += `\n*Usage Statistics:*\n`;
  dataReport += `📁 Files Count: ${stats.fileCount || 0}\n`;
  dataReport += `💾 Storage Slots: ${stats.baseLimit || 2}\n`;
  dataReport += `👥 Referrals: ${stats.referrals ? stats.referrals.length : 0}\n`;

  dataReport += `\n*Your Files:*\n`;
  if (files.length === 0) {
    dataReport += `No files found.\n`;
  } else {
    for (let i = 0; i < Math.min(files.length, 10); i++) {
      dataReport += `• ${files[i].name}\n`;
    }
    if (files.length > 10) dataReport += `...and ${files.length - 10} more files.\n`;
  }

  await ctx.reply(dataReport, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Privacy Settings', 'privacy_options')]])
  });
});

// ─── Admin: Bot Settings ──────────────────────────────────────────────────────

bot.action('bot_settings', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const botSettingsMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Update Welcome Message', 'update_welcome_msg'), Markup.button.callback('📝 Edit File Types', 'edit_file_types')],
    [Markup.button.callback('🔔 Toggle Notifications', 'toggle_notifications'), Markup.button.callback('📊 Set Storage Limits', 'set_storage_limits')],
    [Markup.button.callback('◀️ Back to Admin Menu', 'back_to_admin')]
  ]);

  await ctx.reply('⚙️ *Bot Settings*\n\nConfigure general bot settings and behavior.', { parse_mode: 'Markdown', ...botSettingsMenu });
});

bot.action('update_welcome_msg', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');
  adminStates.set(ctx.from.id, 'update_welcome_msg');
  await ctx.reply('Please enter the new welcome message for users.\n\nYou can use Markdown formatting.');
});

bot.action('set_storage_limits', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const storageLimitsMenu = Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Default Slots', 'edit_default_slots'), Markup.button.callback('👑 Premium Slots', 'premium_default_slots')],
    [Markup.button.callback('◀️ Back to Bot Settings', 'bot_settings')]
  ]);

  await ctx.reply('📊 *Storage Limit Settings*\n\nConfigure storage limits for different user types.', { parse_mode: 'Markdown', ...storageLimitsMenu });
});

bot.action('toggle_notifications', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const config = await getConfig('notifications');
  const notificationsEnabled = config ? config.enabled !== false : true;
  await setConfig('notifications', { enabled: !notificationsEnabled }, ctx.from.id);
  await ctx.reply(`✅ Notifications have been ${!notificationsEnabled ? 'enabled' : 'disabled'}.`);
});

bot.action('edit_file_types', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const fileTypeMenu = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Enable HTML', 'enable_html'), Markup.button.callback('❌ Disable HTML', 'disable_html')],
    [Markup.button.callback('✅ Enable ZIP', 'enable_zip'), Markup.button.callback('❌ Disable ZIP', 'disable_zip')],
    [Markup.button.callback('✅ Enable JS', 'enable_js'), Markup.button.callback('❌ Disable JS', 'disable_js')],
    [Markup.button.callback('✅ Enable CSS', 'enable_css'), Markup.button.callback('❌ Disable CSS', 'disable_css')],
    [Markup.button.callback('◀️ Back to Bot Settings', 'bot_settings')]
  ]);

  await ctx.reply('📝 *File Type Settings*\n\nEnable or disable allowed file types for uploads.', { parse_mode: 'Markdown', ...fileTypeMenu });
});

bot.action(/^(enable|disable)_(html|zip|js|css)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.reply('❌ You are not authorized to perform this action.');

  const action = ctx.match[1];
  const fileType = ctx.match[2];

  const fileTypes = await getConfig('fileTypes') || {};
  fileTypes[fileType] = action === 'enable';
  await setConfig('fileTypes', fileTypes, ctx.from.id);

  await ctx.reply(`✅ ${fileType.toUpperCase()} files have been ${action === 'enable' ? 'enabled' : 'disabled'}.`);
});

// ─── Express web server ───────────────────────────────────────────────────────

// File viewer route — fetches files from Telegram storage channel and serves
// them with the correct Content-Type so HTML renders in browsers.
app.get('/api/view/:userId/:fileName', async (req, res) => {
  const { userId, fileName } = req.params;
  const decodedName = decodeURIComponent(fileName);

  try {
    const { data, error } = await supabase
      .from('files')
      .select('telegram_file_id, content_type')
      .eq('user_id', userId)
      .eq('file_name', decodedName)
      .single();

    if (error || !data) {
      return res.status(404).send('File not found.');
    }

    // Ask Telegram for the download path
    const tgToken = process.env.TELEGRAM_BOT_TOKEN;
    const getFileRes = await fetch(
      `https://api.telegram.org/bot${tgToken}/getFile?file_id=${data.telegram_file_id}`
    );
    const getFileJson = await getFileRes.json();

    if (!getFileJson.ok || !getFileJson.result?.file_path) {
      return res.status(404).send('File not available from Telegram.');
    }

    const fileUrl = `https://api.telegram.org/file/bot${tgToken}/${getFileJson.result.file_path}`;
    const fileRes = await fetch(fileUrl);

    if (!fileRes.ok) {
      return res.status(404).send('File not available.');
    }

    const buffer = Buffer.from(await fileRes.arrayBuffer());

    const ext = (decodedName.split('.').pop() || '').toLowerCase();
    const contentTypeMap = {
      html: 'text/html; charset=utf-8',
      css:  'text/css; charset=utf-8',
      js:   'application/javascript; charset=utf-8',
      zip:  'application/zip',
    };
    const contentType = contentTypeMap[ext] || data.content_type || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } catch (err) {
    console.error('Error serving file:', err);
    res.status(500).send('Error serving file.');
  }
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Telegram Bot Status</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 0; padding: 20px; background-color: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background-color: white; padding: 20px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
        h1 { color: #0088cc; text-align: center; }
        .status { padding: 15px; background-color: #d4edda; border-radius: 5px; margin: 20px 0; text-align: center; color: #155724; }
        .info { line-height: 1.6; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Telegram Bot Status</h1>
        <div class="status">✅ Bot is running (Telegram Storage + Supabase DB)</div>
        <div class="info">
          <p>Your Telegram bot is active and running. You can interact with it directly in Telegram.</p>
          <p>Server started at: ${new Date().toLocaleString()}</p>
        </div>
      </div>
    </body>
    </html>
  `);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`✅ Web server running on port ${port}`);
});

bot.launch({ polling: true });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
