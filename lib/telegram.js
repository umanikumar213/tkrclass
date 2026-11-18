const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const FILE_PATH_TTL = 60 * 60 * 1000;
const telegramFilePathCache = new Map();
function pruneFilePathCache() {
  for (const [id, entry] of telegramFilePathCache) {
    if (entry.expiresAt <= Date.now()) telegramFilePathCache.delete(id);
  }
}
setInterval(pruneFilePathCache, 10 * 60 * 1000).unref();
function telegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN, channelId = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !channelId) throw new Error('Telegram video storage is not configured.');
  return { token, channelId };
}
async function sendVideoToTelegram(file) {
  const { token, channelId } = telegramConfig();
  const form = new FormData();
  form.append('chat_id', channelId);
  form.append('video', fs.createReadStream(file.path), {
    filename: path.basename(file.originalname || file.filename), contentType: file.mimetype,
  });
  form.append('supports_streaming', 'true');
  const response = await axios.post(`https://api.telegram.org/bot${token}/sendVideo`, form, {
    headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 90000,
  });
  const fileId = response.data?.result?.video?.file_id;
  if (!response.data?.ok || !fileId) throw new Error('Telegram did not return a video file ID.');
  return { fileId, messageId: response.data.result.message_id ?? null };
}
async function telegramFilePath(fileId) {
  const cached = telegramFilePathCache.get(fileId);
  if (cached?.expiresAt > Date.now()) return cached.filePath;
  telegramFilePathCache.delete(fileId);
  const { token } = telegramConfig();
  const response = await axios.get(`https://api.telegram.org/bot${token}/getFile`, {
    params: { file_id: fileId }, timeout: 20000,
  });
  const filePath = response.data?.result?.file_path;
  if (!response.data?.ok || !filePath) throw new Error('Telegram could not resolve this video.');
  telegramFilePathCache.set(fileId, { filePath, expiresAt: Date.now() + FILE_PATH_TTL });
  return filePath;
}
async function deleteTelegramMessage(messageId) {
  if (messageId == null) { console.warn('Telegram deletion unavailable: this older post has no message ID.'); return; }
  try {
    const { token, channelId } = telegramConfig();
    const response = await axios.post(`https://api.telegram.org/bot${token}/deleteMessage`,
      { chat_id: channelId, message_id: messageId }, { timeout: 10000 });
    if (!response.data?.ok) console.warn('Telegram did not confirm message deletion.');
  } catch { console.warn('Telegram message deletion failed; the database deletion is retained.'); }
}
module.exports = { telegramConfig, sendVideoToTelegram, telegramFilePath, deleteTelegramMessage };
