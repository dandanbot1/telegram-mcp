/**
 * Group/supergroup direct-ping detection for multi-tenant bots.
 * Used when config.group_require_mention is true.
 */

/**
 * Return true if the update is a direct ping to this bot in a group context.
 *
 * Accepts when:
 * 1. text/caption entities include `mention` of @botUsername OR `text_mention` matching bot id, OR
 * 2. plain text/caption contains @botUsername (case-insensitive), OR
 * 3. message is reply_to_message whose from.id is this bot, OR
 * 4. bot_command entity for /cmd@botUsername (command addressed to this bot)
 *
 * @param {object} update Telegram Update
 * @param {string|null|undefined} botUsername without or with leading @
 * @param {number|string|null|undefined} botId numeric bot id
 * @returns {boolean}
 */
export function isDirectGroupPing(update, botUsername, botId) {
  const msg = update?.message || update?.edited_message || update?.channel_post;
  if (!msg || typeof msg !== 'object') return false;

  const uname = typeof botUsername === 'string'
    ? botUsername.replace(/^@/, '').trim()
    : '';
  const unameLower = uname.toLowerCase();
  const text = typeof msg.text === 'string'
    ? msg.text
    : typeof msg.caption === 'string'
      ? msg.caption
      : '';
  const entities = Array.isArray(msg.entities)
    ? msg.entities
    : Array.isArray(msg.caption_entities)
      ? msg.caption_entities
      : [];

  const botIdNum =
    botId != null && botId !== '' && Number.isFinite(Number(botId))
      ? Number(botId)
      : null;

  for (const ent of entities) {
    if (!ent || typeof ent !== 'object') continue;
    const offset = Number(ent.offset);
    const length = Number(ent.length);
    if (!Number.isFinite(offset) || !Number.isFinite(length) || length < 0) {
      continue;
    }
    // JS string indices are UTF-16 code units (matches Telegram entity offsets)
    const slice =
      text.length > 0 ? text.slice(offset, offset + length) : '';

    if (ent.type === 'mention' && unameLower) {
      const mentioned = slice.replace(/^@/, '').toLowerCase();
      if (mentioned === unameLower) return true;
    }

    if (ent.type === 'text_mention' && botIdNum != null) {
      const uid = ent.user?.id;
      if (uid != null && Number(uid) === botIdNum) return true;
    }

    if (ent.type === 'bot_command' && unameLower && slice) {
      // /cmd@botUsername — must be addressed to this bot
      const m = slice.match(/^\/[A-Za-z0-9_]+@([A-Za-z0-9_]+)/);
      if (m && m[1].toLowerCase() === unameLower) return true;
    }
  }

  // Plain-text fallback (case-insensitive @username)
  if (unameLower && text.toLowerCase().includes(`@${unameLower}`)) {
    return true;
  }

  // Reply to a message from this bot
  if (botIdNum != null && msg.reply_to_message?.from?.id != null) {
    if (Number(msg.reply_to_message.from.id) === botIdNum) return true;
  }

  return false;
}
