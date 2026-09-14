/**
 * A minimal in-process stand-in for the Discord network.
 *
 * It is NOT a discord.js mock: it is a fake *transport* used to drive the real
 * DiscordControlPlane class (real command handling, real progress throttling,
 * real approval buttons, real session bookkeeping) without a bot token. The
 * thing under test is our control plane, not Discord itself.
 *
 * The only real-Discord assumptions it mirrors are the ones the bridge relies on:
 * a channel you can send into, a DM to the owner, message edits, and button
 * interactions carrying a customId.
 */

function buttonIds(components) {
  const out = [];
  for (const row of components ?? []) {
    const children = row?.components ?? row ?? [];
    for (const child of children) {
      const id = child?.data?.custom_id ?? child?.customId ?? null;
      if (id) out.push(id);
    }
  }
  return out;
}

class FakeMessage {
  constructor({ content = '', components = [], channelId, kind, log, id }) {
    this.id = id;
    this.content = content;
    this.components = components;
    this.channelId = channelId;
    this.kind = kind;
    this.editHistory = [];
    this.#log = log;
    this.#latchApprovalButtons();
  }

  #log;

  // Latched: `interaction.update()` clears the components after a decision, so
  // "did this message ever carry approval buttons?" cannot be answered later.
  hadApprovalButtons = false;

  firstApprovalButtonIds = [];

  #latchApprovalButtons() {
    const ids = this.buttonIds.filter((id) => id.startsWith('ap:'));
    if (ids.length) {
      this.hadApprovalButtons = true;
      if (!this.firstApprovalButtonIds.length) this.firstApprovalButtonIds = ids;
    }
  }

  get edits() { return this.editHistory.length; }

  get buttonIds() { return buttonIds(this.components); }

  async edit(payload) {
    const body = typeof payload === 'string' ? { content: payload } : payload;
    if (body.content != null) this.content = body.content;
    if (body.components) this.components = body.components;
    this.#latchApprovalButtons();
    this.editHistory.push(this.content);
    this.#log.edits.push({ channelId: this.channelId, kind: this.kind, content: this.content });
    return this;
  }
}

export class FakeDiscord {
  constructor({ ownerId = 'owner-1', channelId = 'chan-1' } = {}) {
    this.ownerId = ownerId;
    this.channelId = channelId;
    this.messages = [];
    this.edits = [];
    this.handlers = new Map();
    this.loginCalled = false;
    this.nextId = 0;
    this.ownerDmCount = 0;

    const self = this;
    this.owner = {
      id: ownerId,
      tag: 'owner#0001',
      async send(payload) {
        const body = typeof payload === 'string' ? { content: payload } : payload;
        const msg = new FakeMessage({
          content: body.content, components: body.components,
          channelId: `dm:${ownerId}`, kind: 'dm', log: self, id: `dm-${++self.nextId}`,
        });
        self.messages.push(msg);
        self.ownerDmCount += 1;
        return msg;
      },
    };

    this.channel = {
      id: channelId,
      isTextBased: () => true,
      async send(payload) {
        const body = typeof payload === 'string' ? { content: payload } : payload;
        const msg = new FakeMessage({
          content: body.content, components: body.components,
          channelId, kind: 'channel', log: self, id: `ch-${++self.nextId}`,
        });
        self.messages.push(msg);
        return msg;
      },
    };

    this.client = {
      user: { id: 'bot-1', tag: 'agent#0001' },
      channels: { fetch: async (id) => (id === channelId ? self.channel : null) },
      users: { fetch: async (id) => (id === ownerId ? self.owner : null) },
      on: (event, handler) => self.handlers.set(event, handler),
      login: async () => { self.loginCalled = true; return 'bot-1'; },
    };
  }

  /** Simulate the owner (or someone else) sending a message. */
  async sendAsUser({ content, authorId = this.ownerId, channelId = this.channelId, guildId = null }) {
    const self = this;
    const message = {
      id: `in-${++this.nextId}`,
      content,
      channelId,
      guildId,
      author: { id: authorId, bot: false },
      replies: [],
      async reply(payload) {
        const body = typeof payload === 'string' ? { content: payload } : payload;
        const msg = new FakeMessage({
          content: body.content, components: body.components,
          channelId, kind: 'channel', log: self, id: `rep-${++self.nextId}`,
        });
        this.replies.push(msg);
        self.messages.push(msg);
        return msg;
      },
    };
    const handler = this.handlers.get('messageCreate');
    if (!handler) throw new Error('control plane has not been started');
    await handler(message);
    return message;
  }

  /** Simulate the owner tapping one of the approval buttons. */
  async clickButton(customId, { userId = this.ownerId } = {}) {
    const handler = this.handlers.get('interactionCreate');
    if (!handler) throw new Error('control plane has not been started');
    const target = this.messages.find((m) => m.buttonIds.includes(customId));
    if (!target) throw new Error(`no message carries button ${customId}`);
    let updated = null;
    const interaction = {
      isButton: () => true,
      customId,
      user: { id: userId },
      message: target,
      replied: null,
      async reply(payload) { this.replied = payload; },
      async update(payload) {
        updated = payload;
        await target.edit(payload);
      },
    };
    await handler(interaction);
    return { interaction, updated };
  }

  /** The newest message that carries an approval button for the given action. */
  approvalMessage(action) {
    return [...this.messages].reverse().find((m) => m.buttonIds.some((id) => id.startsWith('ap:') && id.endsWith(`:${action}`)));
  }

  /** Every message that ever carried approval buttons, even after they were cleared. */
  approvalHistory() {
    return this.messages.filter((m) => m.hadApprovalButtons);
  }

  texts() { return this.messages.map((m) => m.content); }
}
