const DiscordLikeAdapter = require('./discordLike');

class GameVoxAdapter extends DiscordLikeAdapter {
  constructor(definition) {
    super(definition, {
      rest: {
        api: 'https://bot-api.gamevox.com/api',
      },
      ws: {
        gatewayURL: 'wss://gateway.gamevox.com',
      },
    });

    // Keep the native GameVox gateway as the primary receive path. A lightweight
    // REST poller catches MESSAGE_CREATE events the gateway may fail to publish.
    this.gameVoxMessageHandlers = [];
    this.seenIncomingIds = new Map();
    this.watchedChannels = new Map();
    this.incomingPollTimer = null;
    this.pollingIncoming = false;
    this.incomingPollIntervalMs = Math.max(
      1000,
      Number(this.definition.incomingPollIntervalMs || 5000)
    );

    // DiscordLikeAdapter's gateway listener reads this array dynamically.
    // Route native gateway events through our dedupe layer first.
    this.messageHandlers = [
      message => this.dispatchIncoming(message, 'gateway'),
    ];
  }

  async connect() {
    await super.connect();
    this.startIncomingPoller();
  }

  onMessage(handler) {
    this.gameVoxMessageHandlers.push(handler);
  }

  rememberIncoming(id) {
    if (!id) return false;

    const key = String(id);
    if (this.seenIncomingIds.has(key)) {
      return true;
    }

    this.seenIncomingIds.set(key, Date.now());

    // Bound the dedupe cache so long-running relays do not grow forever.
    if (this.seenIncomingIds.size > 5000) {
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const [messageId, seenAt] of this.seenIncomingIds) {
        if (seenAt < cutoff || this.seenIncomingIds.size > 4000) {
          this.seenIncomingIds.delete(messageId);
        } else {
          break;
        }
      }
    }

    return false;
  }

  dispatchIncoming(message, source) {
    if (!message?.id || this.rememberIncoming(message.id)) {
      return;
    }

    if (source === 'rest') {
      console.log(
        `[${this.displayName}] recovered incoming message ${message.id} through REST polling`
      );
    }

    for (const handler of this.gameVoxMessageHandlers) {
      handler(message);
    }
  }

  async fetchRawMessages(channelId, options = {}) {
    const url = new URL(
      `https://bot-api.gamevox.com/api/v10/channels/${encodeURIComponent(String(channelId))}/messages`
    );

    if (options.limit) url.searchParams.set('limit', String(options.limit));
    if (options.after) url.searchParams.set('after', String(options.after));
    if (options.before) url.searchParams.set('before', String(options.before));

    const response = await fetch(url, {
      headers: {
        Authorization: `Bot ${this.getToken()}`,
        Accept: 'application/json',
      },
    });

    const body = await response.text();
    let data;

    try {
      data = body ? JSON.parse(body) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const error = new Error(
        data?.message ||
        `GameVox message history returned ${response.status}: ${body.slice(0, 200)}`
      );
      error.status = response.status;
      error.code = data?.code;
      error.data = data;
      throw error;
    }

    return Array.isArray(data) ? data : [];
  }

  rawMessageToRelayMessage(raw, channelId) {
    // GameVox history responses are not always shaped exactly like Discord's
    // gateway MESSAGE_CREATE payload. Prefer whichever user/member object is
    // actually populated instead of assuming raw.author exists.
    const rawMember = raw?.member || raw?.guild_member || raw?.guildMember || null;

    const objectCandidate = value =>
      value && typeof value === 'object' && !Array.isArray(value) ? value : null;

    // Some GameVox REST payloads use "author"/"sender" as an ID rather than a
    // full Discord User object. Do not let that primitive value hide member.user.
    const rawAuthor =
      objectCandidate(raw?.author) ||
      objectCandidate(raw?.user) ||
      objectCandidate(raw?.sender) ||
      objectCandidate(rawMember?.user) ||
      objectCandidate(rawMember?.author) ||
      {};

    const primitiveAuthorId =
      (typeof raw?.author === 'string' || typeof raw?.author === 'number')
        ? raw.author
        : (typeof raw?.sender === 'string' || typeof raw?.sender === 'number')
          ? raw.sender
          : null;

    const authorId =
      rawAuthor?.id ||
      primitiveAuthorId ||
      raw?.author_id ||
      raw?.authorId ||
      raw?.sender_id ||
      raw?.senderId ||
      raw?.user_id ||
      raw?.userId ||
      rawMember?.user_id ||
      rawMember?.userId ||
      null;

    const username =
      rawAuthor?.username ||
      rawAuthor?.name ||
      rawAuthor?.display_name ||
      rawAuthor?.displayName ||
      raw?.username ||
      raw?.author_name ||
      raw?.authorName ||
      rawMember?.username ||
      'Unknown User';

    const displayName =
      rawMember?.nick ||
      rawMember?.nickname ||
      rawMember?.display_name ||
      rawMember?.displayName ||
      rawAuthor?.global_name ||
      rawAuthor?.globalName ||
      rawAuthor?.display_name ||
      rawAuthor?.displayName ||
      raw?.display_name ||
      raw?.displayName ||
      raw?.author_name ||
      raw?.authorName ||
      username;

    if (username === 'Unknown User' && !this.loggedUnknownAuthorShape) {
      this.loggedUnknownAuthorShape = true;
      console.warn(
        `[${this.displayName}] unknown REST author shape; message keys=` +
          Object.keys(raw || {}).join(',') +
          `; member keys=${Object.keys(rawMember || {}).join(',')}` +
          `; author type=${typeof raw?.author}`
      );
    }

    const attachments = new Map(
      (Array.isArray(raw?.attachments) ? raw.attachments : []).map((file, index) => [
        String(file?.id || index),
        {
          id: file?.id || null,
          name: file?.filename || file?.name || null,
          url: file?.url || file?.proxy_url || file?.proxyUrl || null,
          contentType: file?.content_type || file?.contentType || null,
        },
      ])
    );

    return {
      id: String(raw?.id || ''),
      channelId: String(raw?.channel_id || channelId),
      guildId: raw?.guild_id || null,
      content: raw?.content || '',
      author: {
        id: authorId,
        username,
        globalName:
          rawAuthor?.global_name ||
          rawAuthor?.globalName ||
          rawAuthor?.display_name ||
          rawAuthor?.displayName ||
          null,
        displayName,
        bot: Boolean(rawAuthor?.bot || raw?.bot || rawMember?.bot),
        displayAvatarURL: () => {
          const avatar = rawAuthor?.avatar || raw?.avatar || rawMember?.avatar;
          if (!authorId || !avatar) return null;
          return `https://cdn.gamevox.com/avatars/${authorId}/${avatar}.png`;
        },
      },
      member: rawMember
        ? {
            displayName,
          }
        : null,
      attachments,
      webhookId: raw?.webhook_id || null,
      raw,
    };
  }

  async watchChannel(channelId) {
    const id = String(channelId);
    const existing = this.watchedChannels.get(id);
    if (existing?.initialized) {
      return;
    }

    const state = existing || {
      lastPolledId: null,
      initialized: false,
      warned: false,
    };
    this.watchedChannels.set(id, state);

    try {
      // Use raw REST instead of discord.js MessageManager here. GameVox can
      // legitimately return null fields that discord.js's Discord-specific
      // Message constructor assumes are populated.
      const latest = await this.fetchRawMessages(id, { limit: 1 });
      const message = latest[0];

      if (message?.id) {
        state.lastPolledId = String(message.id);
        this.rememberIncoming(message.id);
      }

      state.initialized = true;
    } catch (error) {
      // Validation/send fallback may still work. Leave this uninitialized so
      // the poller establishes a fresh cursor instead of replaying old history
      // if read access becomes available later.
      state.initialized = false;
      if (!this.isPermissionError(error)) {
        console.warn(
          `[${this.displayName}] could not initialize receive fallback for channel ${id}: ${error.message}`
        );
      }
    }
  }

  startIncomingPoller() {
    clearInterval(this.incomingPollTimer);

    this.incomingPollTimer = setInterval(() => {
      this.pollIncomingMessages().catch(error => {
        console.error(
          `[${this.displayName}] incoming REST fallback failed: ${error.message}`
        );
      });
    }, this.incomingPollIntervalMs);

    this.incomingPollTimer.unref();
  }

  async pollIncomingMessages() {
    if (this.pollingIncoming || !this.watchedChannels.size) {
      return;
    }

    this.pollingIncoming = true;

    try {
      for (const [channelId, state] of this.watchedChannels) {
        try {
          if (!state.initialized) {
            await this.watchChannel(channelId);
            continue;
          }

          const options = { limit: 100 };
          if (state.lastPolledId) {
            options.after = state.lastPolledId;
          }

          const rawMessages = await this.fetchRawMessages(channelId, options);
          const messages = rawMessages.map(raw =>
            this.rawMessageToRelayMessage(raw, channelId)
          );

          // REST returns newest-first on Discord-compatible APIs; relay oldest-first.
          messages.sort((a, b) => {
            try {
              const left = BigInt(a.id);
              const right = BigInt(b.id);
              return left < right ? -1 : left > right ? 1 : 0;
            } catch {
              return String(a.id).localeCompare(String(b.id));
            }
          });

          for (const message of messages) {
            this.dispatchIncoming(message, 'rest');
            state.lastPolledId = String(message.id);
          }

          state.warned = false;
        } catch (error) {
          if (!state.warned) {
            const hint = this.isPermissionError(error)
              ? ' Give the GameVox bot View Channel and Read Message History for this channel.'
              : '';

            console.warn(
              `[${this.displayName}] cannot read channel ${channelId} for receive fallback: ${error.message}.${hint}`
            );
            state.warned = true;
          }
        }
      }
    } finally {
      this.pollingIncoming = false;
    }
  }

  isPermissionError(error) {
    const status =
      error?.status ??
      error?.statusCode ??
      error?.rawError?.status ??
      error?.response?.status;

    const code =
      error?.code ??
      error?.rawError?.code ??
      error?.data?.code;

    const message = [
      error?.message,
      error?.rawError?.message,
      error?.data?.message,
      error?.body,
    ]
      .filter(Boolean)
      .join(' ');

    return Boolean(
      status === 403 ||
      code === 50001 ||
      code === 50013 ||
      /missing\s+(access|permissions?)/i.test(message) ||
      /forbidden/i.test(message) ||
      /not authorized/i.test(message) ||
      /permission denied/i.test(message)
    );
  }

  async getBotChannel(channelId) {
    const channel = await this.client.channels.fetch(String(channelId));

    if (!channel) {
      throw new Error(`${this.displayName}: channel ${channelId} was not found`);
    }

    if (!channel.isTextBased() || typeof channel.send !== 'function') {
      throw new Error(
        `${this.displayName}: channel ${channelId} is not a sendable text channel`
      );
    }

    return channel;
  }

  async getChannel(channelId) {
    const id = String(channelId);

    try {
      const channel = await this.getBotChannel(id);
      await this.watchChannel(id);
      return channel;
    } catch (error) {
      const webhookUrl = this.getWebhookUrl(id);

      if (webhookUrl && this.isPermissionError(error)) {
        // Keep tracking it: if read permission starts working later the REST
        // fallback can begin receiving without a restart.
        if (!this.watchedChannels.has(id)) {
          this.watchedChannels.set(id, {
            lastPolledId: null,
            initialized: false,
            warned: false,
          });
        }

        console.warn(
          `[${this.displayName}] bot cannot access channel ${id}; ` +
            'webhook fallback is available if a send is attempted'
        );
        return { id, webhookFallback: true };
      }

      throw error;
    }
  }

  fileUploadSupport() {
    return 2;
  }

  async sendMessage(channelId, payload) {
    try {
      const channel = await this.getBotChannel(channelId);

      return await channel.send({
        content: payload.content,
        files: (payload.files || []).map(file => ({
          attachment: file.data,
          name: file.name,
        })),
        allowedMentions: {
          parse: [],
          repliedUser: false,
        },
      });
    } catch (error) {
      const webhookUrl = this.getWebhookUrl(channelId);

      if (!webhookUrl || !this.isPermissionError(error)) {
        throw error;
      }

      console.warn(
        `[${this.displayName}] bot send to channel ${channelId} was denied; ` +
          'using configured webhook fallback for this message'
      );

      return this.sendWebhook(
        webhookUrl,
        payload.content,
        payload.files || [],
        payload.fileUrls
      );
    }
  }

  async destroy() {
    clearInterval(this.incomingPollTimer);
    this.incomingPollTimer = null;
    await super.destroy();
  }
}

module.exports = GameVoxAdapter;
