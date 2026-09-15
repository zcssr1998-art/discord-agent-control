export const MODE = Object.freeze({
  CHAT: 'chat',
  WORK: 'work',
});

/**
 * Remove a leading mention of this bot without touching mentions of anyone else.
 * Discord serialises user/bot mentions as <@id> or <@!id>.
 */
export function stripSelfMention(text, botUserId = null) {
  const input = String(text ?? '').trim();
  if (!botUserId) return input;
  return input.replace(new RegExp(`^<@!?${String(botUserId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>\\s*`), '').trim();
}

/**
 * Deterministic local control parser. This function must never call an LLM.
 *
 * Supported forms:
 *   work
 *   /work
 *   !work
 *   work fix the bug
 *   chat
 *   /chat
 *   !chat
 *   chat explain this screenshot
 */
export function parseModeCommand(text) {
  const input = String(text ?? '').trim();
  const match = input.match(/^[/!]?(work|chat)(?:\s+([\s\S]+))?$/i);
  if (!match) return null;
  const mode = match[1].toLowerCase() === 'work' ? MODE.WORK : MODE.CHAT;
  const prompt = String(match[2] ?? '').trim() || null;
  return { type: 'mode', mode, prompt };
}

export function normalizeMode(mode, fallback = MODE.CHAT) {
  return mode === MODE.WORK || mode === MODE.CHAT ? mode : fallback;
}
