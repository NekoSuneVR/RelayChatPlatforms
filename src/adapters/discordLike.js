const {
  Client,
  GatewayIntentBits,
  Events,
} = require('discord.js');

const BaseAdapter = require('./base');

class DiscordLikeAdapter extends BaseAdapter {
  constructor(definition, endpoints = {}) {
    super(definition);

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      ...(endpoints.rest ? { rest: endpoints.rest } : {}),
      ...(endpoints.ws ? { ws: endpoints.ws } : {}),
    });

    this.messageHandlers = [];

    this.client.on(Events.MessageCreate, message => {
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    });

    this.client.on(Events.Error, error => {
      console.error(`[${this.displayName}] client error`, error);
    });
  }

  async connect() {
    const token = process.env[this.definition.tokenEnv];

    if (!token) {
      throw new Error(
        `${this.displayName}: environment variable ${this.definition.tokenEnv} is missing`
      );
    }

    await this.client.login(token);

    console.log(
      `[${this.displayName}] Logged in as ${this.client.user?.tag || this.client.user?.username || 'bot'}`
    );
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  async getChannel(channelId) {
    const channel = await this.client.channels.fetch(channelId);

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

  async sendMessage(channelId, payload) {
    const channel = await this.getChannel(channelId);

    return channel.send({
      content: payload.content,
      allowedMentions: {
        parse: [],
        repliedUser: false,
      },
    });
  }

  isOwnMessage(message) {
    return Boolean(message?.author?.bot);
  }

  normalizeMessage(message) {
    const attachments = [];

    if (message.attachments?.size) {
      for (const attachment of message.attachments.values()) {
        attachments.push({
          name: attachment.name || null,
          url: attachment.url,
          contentType: attachment.contentType || null,
        });
      }
    }

    return {
      id: message.id,
      channelId: message.channelId,
      author: {
        id: message.author?.id || null,
        username: message.author?.username || 'Unknown User',
        displayName:
          message.member?.displayName ||
          message.author?.globalName ||
          message.author?.displayName ||
          message.author?.username ||
          'Unknown User',
        avatarUrl:
          typeof message.author?.displayAvatarURL === 'function'
            ? message.author.displayAvatarURL()
            : null,
        isBot: Boolean(message.author?.bot),
      },
      content: message.content || '',
      attachments,
      webhookId: message.webhookId || null,
      raw: message,
    };
  }

  async destroy() {
    this.client.destroy();
  }
}

module.exports = DiscordLikeAdapter;
