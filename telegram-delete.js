const axios = require('axios');

async function deleteTelegramMessage(messageId) {
  if (messageId == null) {
    console.warn('Telegram deletion unavailable: this older post has no message ID.');
    return;
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const channel = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !channel) { console.warn('Telegram deletion is not configured.'); return; }
  try {
    const response = await axios.post(`https://api.telegram.org/bot${token}/deleteMessage`,
      { chat_id: channel, message_id: messageId }, { timeout: 10000 });
    if (!response.data?.ok) console.warn('Telegram did not confirm message deletion.');
  } catch { console.warn('Telegram message deletion failed; the database deletion is retained.'); }
}
module.exports = { deleteTelegramMessage };
