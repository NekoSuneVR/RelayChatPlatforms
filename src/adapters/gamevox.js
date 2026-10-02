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

  async watchChannel(channelId) {
    const id = String(channelId);
    if (this.watchedChannels.has(id)) {
      return;
    }

    const state = {
      lastPolledId: null,
      initialized: false,
      warned: false,
    };
    this.watchedChannels.set(id, state);

    try {
      const channel = await this.getBotChannel(id);

      if (!channel.messages || typeof channel.messages.fetch !== 'function') {
        state.initialized = true;
        return;
      }

      // Establish a cursor without replaying pre-existing history on startup.
      const latest = await channel.messages.fetch({ limit: 1 });
      const message = latest?.first?.() || [...(latest?.values?.() || [])][0];

      if (message?.id) {
        state.lastPolledId = String(message.id);
        this.rememberIncoming(message.id);
      }

      state.initialized = true;
    } catch (error) {
      // Validation/send fallback may still work. The poller will retry later.
      state.initialized = true;
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
          const channel = await this.getBotChannel(channelId);

          if (!channel.messages || typeof channel.messages.fetch !== 'function') {
            continue;
          }

          if (!state.initialized) {
            await this.watchChannel(channelId);
            continue;
          }

          const options = { limit: 100 };
          if (state.lastPolledId) {
            options.after = state.lastPolledId;
          }

          const fetched = await channel.messages.fetch(options);
          const messages = [...(fetched?.values?.() || [])];

          // REST returns newest-first on Discord-compatible APIs; relay oldest-first.
          messages.sort((a, b) => {
            try {
              return Number(BigInt(a.id) - BigInt(b.id));
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
            initialized: true,
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
