/**
 * A minimal in-process stand-in for the Discord network.
 *
 * It is NOT a discord.js mock: it is a fake *transport* used to drive the real
 * DiscordControlPlane class (real command handling, real progress throttling,
 * real approval buttons, real session bookkeeping) without a bot token. The
 * thing under test is our control plane, not Discord itself.
 *
 * The only real-Discord assumptions it mirrors are the ones the bridge relies on:
 * a channel you can send into, a DM to the owner, message edits, button
 * interactions carrying a customId, and — for the Work-thread path — a guild
 * text channel that can create one thread.
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
  constructor({ content = '', components = [], channelId, guildId = null, kind, log, id }) {
    this.id = id;
    this.content = content;
    this.components = components;
    this.channelId = channelId;
    this.guildId = guildId;
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

  /** Stand-in for Discord's pin API; the real bridge treats a failure as non-fatal. */
  async pin() { this.pinned = true; return this; }

  async unpin() { this.pinned = false; return this; }
}

export class FakeDiscord {
  constructor({ ownerId = 'owner-1', channelId = 'chan-1', threadCapable = false, threadFailure = false, threadDelayMs = 0 } = {}) {
    this.threadDelayMs = threadDelayMs;
    this.ownerId = ownerId;
    this.channelId = channelId;
    this.messages = [];
    this.edits = [];
    this.handlers = new Map();
    this.loginCalled = false;
    this.nextId = 0;
    this.ownerDmCount = 0;
    this.threadCapable = threadCapable;
    this.threadFailure = threadFailure;
    this.threads = [];
    this.channelsById = new Map();

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

    this.channel = this.#makeChannel({ id: channelId, threadCapable: threadCapable });
    this.channelsById.set(channelId, this.channel);

    this.client = {
      user: { id: 'bot-1', tag: 'agent#0001' },
      channels: { fetch: async (id) => self.channelsById.get(id) ?? null },
      users: { fetch: async (id) => (id === ownerId ? self.owner : null) },
      on: (event, handler) => self.handlers.set(event, handler),
      login: async () => { self.loginCalled = true; return 'bot-1'; },
    };
  }

  /** Register an extra channel (e.g. a second independent Work context). */
  addChannel({ id, threadCapable = false }) {
    const channel = this.#makeChannel({ id, threadCapable });
    this.channelsById.set(id, channel);
    return channel;
  }

  #makeChannel({ id, parentId = null, thread = false, threadCapable = false }) {
    const self = this;
    const channel = {
      id,
      parentId,
      isTextBased: () => true,
      isThread: () => thread,
      async send(payload) {
        const body = typeof payload === 'string' ? { content: payload } : payload;
        const msg = new FakeMessage({
          content: body.content, components: body.components,
          channelId: id, kind: thread ? 'thread' : 'channel', log: self, id: `ch-${++self.nextId}`,
        });
        self.messages.push(msg);
        return msg;
      },
    };
    if (threadCapable && !thread) {
      channel.threads = { create: async ({ name }) => self.#createThread(id, name) };
    }
    return channel;
  }

  async #createThread(parentId, name) {
    if (this.threadFailure) {
      throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
    }
    if (this.threadDelayMs) await new Promise((resolve) => setTimeout(resolve, this.threadDelayMs));
    const channel = this.#makeChannel({ id: `thread-${++this.nextId}`, parentId, thread: true });
    channel.name = name;
    this.channelsById.set(channel.id, channel);
    this.threads.push(channel);
    return channel;
  }

  #messageFor({ content, channelId, guildId, attachments = [] }) {
    const self = this;
    const channel = this.channelsById.get(channelId) ?? this.channel;
    const message = {
      id: `in-${++this.nextId}`,
      content,
      channelId,
      guildId,
      attachments,
      channel,
      author: { id: this.ownerId, bot: false },
      deleted: false,
      replies: [],
      ...(this.threadCapable && !channel.isThread()
        ? { startThread: async ({ name }) => self.#createThread(channelId, name) }
        : {}),
      async delete() { this.deleted = true; },
      async reply(payload) {
        const body = typeof payload === 'string' ? { content: payload } : payload;
        const msg = new FakeMessage({
          content: body.content, components: body.components,
          channelId, guildId, kind: channel.isThread() ? 'thread' : 'channel', log: self, id: `rep-${++self.nextId}`,
        });
        this.replies.push(msg);
        self.messages.push(msg);
        return msg;
      },
    };
    return message;
  }

  /** Simulate the owner (or someone else) sending a message. */
  async sendAsUser({ content, authorId = this.ownerId, channelId = this.channelId, guildId = null, attachments = [] }) {
    const message = this.#messageFor({ content, channelId, guildId, attachments });
    message.author = { id: authorId, bot: false };
    const handler = this.handlers.get('messageCreate');
    if (!handler) throw new Error('control plane has not been started');
    await handler(message);
    return message;
  }

  /** Messages sent to a specific channel/thread id. */
  messagesIn(channelId) {
    return this.messages.filter((m) => m.channelId === channelId);
  }

  /** The thread created from a parent channel, if any. */
  threadFor(parentId) {
    return this.threads.find((thread) => thread.parentId === parentId) ?? null;
  }

  /** Simulate the owner tapping one of the approval/panel buttons. */
  async clickButton(customId, { userId = this.ownerId } = {}) {
    const handler = this.handlers.get('interactionCreate');
    if (!handler) throw new Error('control plane has not been started');
    const self = this;
    const target = this.messages.find((m) => m.buttonIds.includes(customId));
    if (!target) throw new Error(`no message carries button ${customId}`);
    let updated = null;
    let modal = null;
    const interaction = {
      id: `ic-${++this.nextId}`,
      isButton: () => true,
      isModalSubmit: () => false,
      isChatInputCommand: () => false,
      customId,
      user: { id: userId },
      message: target,
      channelId: target.channelId,
      channel: this.channelsById.get(target.channelId) ?? null,
      guildId: target.guildId ?? null,
      deferred: false,
      replied: null,
      followedUp: [],
      async showModal(builder) { modal = builder; self.lastModal = builder; },
      async deferUpdate() { this.deferred = true; },
      async deferReply() { this.deferred = true; },
      async reply(payload) { this.replied = payload; return null; },
      async editReply(payload) {
        this.deferred = false;
        this.replied = payload;
        updated = payload;
        await target.edit(payload);
        return target;
      },
      async followUp(payload) {
        this.followedUp.push(payload);
        const channel = self.channelsById.get(target.channelId) ?? self.channel;
        const sent = await channel.send(payload);
        if (!this.replied) this.replied = payload;
        return sent;
      },
      async update(payload) {
        updated = payload;
        this.replied = payload;
        await target.edit(payload);
      },
    };
    this.lastInteraction = interaction;
    await handler(interaction);
    return { interaction, updated, modal };
  }

  /**
   * Simulate the owner submitting the `🛠 新建 Work` modal. `values` maps the
   * modal input customId to its text value.
   */
  async submitModal(customId, { values = {}, userId = this.ownerId, channelId = this.channelId, guildId = null } = {}) {
    const handler = this.handlers.get('interactionCreate');
    if (!handler) throw new Error('control plane has not been started');
    const channel = this.channelsById.get(channelId) ?? this.channel;
    let replied = null;
    const followedUp = [];
    const interaction = {
      id: `im-${++this.nextId}`,
      isButton: () => false,
      isModalSubmit: () => true,
      isChatInputCommand: () => false,
      customId,
      user: { id: userId },
      message: null,
      channelId,
      guildId,
      channel,
      fields: { getTextInputValue: (id) => values[id] ?? '' },
      deferred: false,
      replied: null,
      followedUp,
      async deferUpdate() { this.deferred = true; },
      async deferReply() { this.deferred = true; },
      async reply(payload) { this.replied = payload; replied = payload; return null; },
      async editReply(payload) {
        this.deferred = false;
        this.replied = payload;
        replied = payload;
        return channel.send(payload);
      },
      async followUp(payload) {
        followedUp.push(payload);
        const sent = await channel.send(payload);
        if (!this.replied) { this.replied = payload; replied = payload; }
        return sent;
      },
      async update(payload) { replied = payload; this.replied = payload; },
    };
    this.lastInteraction = interaction;
    await handler(interaction);
    return { interaction, replied, followedUp };
  }

  /**
   * Simulate the owner invoking a native application command. The reply is
   * posted into the channel so tests can read it like any other message.
   */
  async command(name, { options = {}, userId = this.ownerId, channelId = this.channelId, guildId = null } = {}) {
    const handler = this.handlers.get('interactionCreate');
    if (!handler) throw new Error('control plane has not been started');
    const self = this;
    const channel = this.channelsById.get(channelId) ?? this.channel;
    let replied = null;
    let deferred = false;
    let modal = null;
    const interaction = {
      id: `icmd-${++this.nextId}`,
      isButton: () => false,
      isModalSubmit: () => false,
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName: name,
      user: { id: userId },
      message: null,
      channelId,
      guildId,
      channel,
      deferred: false,
      options: {
        getString: (key) => (options[key] == null ? null : String(options[key])),
        getInteger: (key) => (options[key] == null ? null : Number(options[key])),
        getBoolean: (key) => (options[key] == null ? null : Boolean(options[key])),
      },
      async reply(payload) {
        replied = typeof payload === 'string' ? { content: payload } : payload;
        this.replied = replied;
        return channel.send(replied);
      },
      async deferUpdate() { this.deferred = true; deferred = true; },
      async deferReply() { this.deferred = true; deferred = true; },
      async editReply(payload) {
        this.deferred = false;
        replied = typeof payload === 'string' ? { content: payload } : payload;
        this.replied = replied;
        return channel.send(replied);
      },
      async followUp(payload) {
        const body = typeof payload === 'string' ? { content: payload } : payload;
        if (!this.replied) { replied = body; this.replied = body; }
        return channel.send(body);
      },
      async showModal(builder) { modal = builder; self.lastModal = builder; },
      async update(payload) { replied = payload; this.replied = payload; },
    };
    this.lastInteraction = interaction;
    await handler(interaction);
    return { interaction, replied, deferred: interaction.deferred, modal };
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
