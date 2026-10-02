const BaseAdapter = require('./base');

// @fluxerjs/core is ESM-first, so load it dynamically from this CommonJS app.
class FluxerAdapter extends BaseAdapter {
  constructor(definition) {
    super(definition);

    this.client = null;
    this.Events = null;
    this.messageHandlers = [];
  }

  async connect() {
    const token = process.env[this.definition.tokenEnv];

    if (!token) {
      throw new Error(
        `${this.displayName}: environment variable ${this.definition.tokenEnv} is missing`
      );
    }

    const { Client, Events } = await import('@fluxerjs/core');
    this.Events = Events;

    if (this.definition.discoveryOrigin) {
      this.client = await Client.fromDiscovery(this.definition.discoveryOrigin);
    } else {
      const options = {};
      if (this.definition.apiUrl) {
        options.rest = { api: this.definition.apiUrl };
      }
      this.client = new Client(options);
    }

    this.client.on(Events.MessageCreate, message => {
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    });

    this.client.on(Events.Error, error => {
      console.error(`[${this.displayName}] client error`, error);
    });

    await this.client.login(token);

    console.log(
      `[${this.displayName}] Logged in as ${this.client.user?.username || 'bot'}`
    );
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  async getChannel(channelId) {
    const channel = await this.client.channels.fetch(String(channelId));

    if (!channel) {
      throw new Error(`${this.displayName}: channel ${channelId} was not found`);
    }

    if (typeof channel.send !== 'function') {
      throw new Error(
        `${this.displayName}: channel ${channelId} is not a sendable channel`
      );
    }

    return channel;
  }

  fileUploadSupport() {
    return 2;
  }

  hostedFileUrls(sent) {
    return (sent?.attachments || [])
      .map(file => file.url || file.proxyUrl || null)
      .filter(Boolean);
  }

  async sendMessage(channelId, payload) {
    const channel = await this.getChannel(channelId);
    const content = payload.content || '';
    const files = (payload.files || []).map(file => ({
      name: file.name || 'attachment',
      data: file.data,
    }));

    return channel.send({
      content,
      ...(files.length ? { files } : {}),
      allowedMentions: { parse: [] },
    });
  }

  isOwnMessage(message) {
    return Boolean(
      message?.author?.id === this.client?.user?.id ||
      message?.author?.bot ||
      message?.webhookId
    );
  }

  normalizeMessage(message) {
    const attachments = Array.from(message.attachments?.values?.() || message.attachments || [])
      .map(file => ({
        name: file.filename || file.name || null,
        url: file.url || file.proxyUrl || null,
        contentType: file.contentType || file.content_type || null,
      }))
      .filter(file => file.url);

    const avatarUrl =
      message.author?.displayAvatarURL?.({ size: 256 }) ||
      message.author?.avatarURL?.({ size: 256 }) ||
      null;

    return {
      id: message.id,
      channelId: message.channelId || message.channel?.id,
      author: {
        id: message.author?.id || null,
        username: message.author?.username || 'Unknown User',
        displayName:
          message.member?.displayName ||
          message.member?.nickname ||
          message.author?.globalName ||
          message.author?.displayName ||
          message.author?.username ||
          'Unknown User',
        avatarUrl,
        isBot: Boolean(message.author?.bot),
      },
      content: message.content || '',
      attachments,
      webhookId: message.webhookId || null,
      raw: message,
    };
  }

  async destroy() {
    try {
      await this.client?.destroy?.();
    } catch {}
    this.client?.removeAllListeners?.();
  }
}

module.exports = FluxerAdapter;
