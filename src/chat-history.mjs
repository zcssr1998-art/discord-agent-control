import fs from 'node:fs';
import path from 'node:path';

/**
 * Bounded, channel-scoped Chat history.
 *
 * Chat is not an Agent session: it is a small local JSON store keyed by Discord
 * channel/thread id. It is deliberately separate from Work/Agent `sessionId`,
 * survives a bridge restart, and never stores credentials or binary bodies.
 *
 * The store is intentionally simple (no SQLite/Redis): a single-user personal
 * bridge has a handful of channels with a bounded number of text turns.
 */
export const CHAT_HISTORY_VERSION = 1;

export const CHAT_HISTORY_DEFAULTS = Object.freeze({
  // Roughly 20 user/assistant turns. Enough continuity without replaying an
  // unbounded Discord transcript into every model call.
  maxMessages: 40,
  // Character envelope before local trimming kicks in (no tokenizer dependency).
  maxChars: 56000,
  summaryMaxChars: 6000,
});

function messageChars(message) {
  const content = message?.content;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((sum, part) => sum + (typeof part?.text === 'string' ? part.text.length : 0), 0);
  }
  return 0;
}

function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const content = message.content;
  if (typeof content !== 'string' && !Array.isArray(content)) return null;
  return { role: message.role === 'assistant' ? 'assistant' : 'user', content };
}

export class ChatHistoryStore {
  constructor({
    file,
    maxMessages = CHAT_HISTORY_DEFAULTS.maxMessages,
    maxChars = CHAT_HISTORY_DEFAULTS.maxChars,
    summaryMaxChars = CHAT_HISTORY_DEFAULTS.summaryMaxChars,
    now = () => Date.now(),
    logger = null,
  } = {}) {
    this.file = file;
    this.maxMessages = maxMessages;
    this.maxChars = maxChars;
    this.summaryMaxChars = summaryMaxChars;
    this.now = now;
    this.logger = logger;
    this.data = { version: CHAT_HISTORY_VERSION, channels: {} };
    this.corrupt = false;
    this.load();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') this.#warn(`read failed: ${error?.code || error?.message}`);
      return;
    }
    try {
      // A leading UTF-8 BOM (easy to produce from Windows PowerShell) would make
      // JSON.parse throw and silently wipe every channel; strip it explicitly.
      const parsed = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
      if (parsed && typeof parsed === 'object' && parsed.channels && typeof parsed.channels === 'object') {
        this.data = { version: parsed.version ?? CHAT_HISTORY_VERSION, channels: parsed.channels };
      } else {
        this.corrupt = true;
        this.#warn('unexpected schema; starting empty but preserving the existing file');
      }
    } catch (error) {
      this.corrupt = true;
      this.#warn(`parse failed (${error?.message}); starting empty but preserving the existing file`);
    }
  }

  #warn(detail) {
    const line = `[chat-history] ${detail}`;
    if (this.logger?.warn) this.logger.warn(line); else console.warn(line);
  }

  #emptyChannel() { return { messages: [], summary: null, updatedAt: null }; }

  #channel(channelId) {
    const entry = this.data.channels[channelId];
    if (!entry || typeof entry !== 'object') return this.#emptyChannel();
    const messages = Array.isArray(entry.messages) ? entry.messages.map(normalizeMessage).filter(Boolean) : [];
    return {
      messages,
      summary: typeof entry.summary === 'string' && entry.summary.trim() ? entry.summary : null,
      updatedAt: entry.updatedAt ?? null,
    };
  }

  /** A defensive copy: callers must not mutate the stored history in place. */
  get(channelId) {
    const channel = this.#channel(channelId);
    return { ...channel, messages: channel.messages.map((message) => ({ ...message })) };
  }

  messages(channelId) { return this.#channel(channelId).messages; }

  summary(channelId) { return this.#channel(channelId).summary; }

  #trim(messages) {
    let list = messages.map((message) => ({ role: message.role, content: message.content }));
    if (list.length > this.maxMessages) list = list.slice(list.length - this.maxMessages);
    let total = list.reduce((sum, message) => sum + messageChars(message), 0);
    // Keep at least the newest turn; drop oldest context first.
    while (list.length > 2 && total > this.maxChars) {
      total -= messageChars(list[0]);
      list.shift();
    }
    return list;
  }

  /** Append exactly one user + one assistant turn, then persist bounded state. */
  appendTurn(channelId, { user = null, assistant = null } = {}) {
    const channel = this.#channel(channelId);
    const messages = [...channel.messages];
    if (user != null && String(user).trim()) messages.push({ role: 'user', content: String(user) });
    if (assistant != null && String(assistant).trim()) messages.push({ role: 'assistant', content: String(assistant) });
    const entry = {
      messages: this.#trim(messages),
      summary: channel.summary,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.data.channels[channelId] = entry;
    this.save();
    return entry;
  }

  /** Replace the stored context with a compacted summary + recent tail. */
  replace(channelId, { summary = null, messages = [] } = {}) {
    const trimmedSummary = typeof summary === 'string' && summary.trim()
      ? summary.trim().slice(0, this.summaryMaxChars)
      : null;
    const entry = {
      messages: this.#trim(messages),
      summary: trimmedSummary,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.data.channels[channelId] = entry;
    this.save();
    return entry;
  }

  clear(channelId) {
    if (!(channelId in this.data.channels)) return false;
    delete this.data.channels[channelId];
    this.save();
    return true;
  }

  /**
   * True when appending `extraMessages` would force `#trim()` to drop older
   * stored messages. The chat path uses this to auto-compact BEFORE any
   * destructive trim instead of silently discarding history.
   */
  wouldTrim(channelId, { extraMessages = [] } = {}) {
    const channel = this.#channel(channelId);
    const extra = (extraMessages ?? []).map(normalizeMessage).filter(Boolean);
    const combined = [...channel.messages, ...extra];
    return this.#trim(combined).length < combined.length;
  }

  stats(channelId) {
    const channel = this.#channel(channelId);
    const chars = channel.messages.reduce((sum, message) => sum + messageChars(message), 0);
    return {
      messages: channel.messages.length,
      turns: Math.ceil(channel.messages.length / 2),
      chars: chars + (channel.summary?.length ?? 0),
      hasSummary: Boolean(channel.summary),
    };
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (this.corrupt) {
      // Keep a recovery copy of the unreadable file instead of destroying it.
      try {
        if (fs.existsSync(this.file)) {
          const backup = `${this.file}.corrupt-${new Date(this.now()).toISOString().replace(/[:.]/g, '-')}`;
          fs.copyFileSync(this.file, backup);
        }
      } catch { /* best effort */ }
      this.corrupt = false;
    }
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(temporary, this.file);
  }
}

export default ChatHistoryStore;
