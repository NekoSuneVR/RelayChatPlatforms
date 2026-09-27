const BaseAdapter = require('./base');

// stoat.js is ESM-only, so it is loaded with a dynamic import.
class StoatAdapter extends BaseAdapter {
  constructor(definition) {
    super(definition);

    this.client = null;
    this.messageHandlers = [];
  }

  async connect() {
    const token = process.env[this.definition.tokenEnv];

    if (!token) {
      throw new Error(
        `${this.displayName}: environment variable ${this.definition.tokenEnv} is missing`
      );
    }

    const { Client } = await import('stoat.js');

    this.client = new Client(
      this.definition.baseURL ? { baseURL: this.definition.baseURL } : {}
    );

    this.client.on('messageCreate', message => {
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    });

    this.client.on('error', error => {
      console.error(`[${this.displayName}] client error`, error);
    });

    const ready = new Promise(resolve => this.client.once('ready', resolve));
    await this.client.loginBot(token);
    await ready;

    console.log(
      `[${this.displayName}] Logged in as ${this.client.user?.username || 'bot'}`
    );

    // Stoat keeps a user's chosen presence; set it explicitly so the bot never
    // sits as Invisible from an earlier setting.
    await this.client.user
      ?.edit({ status: { ...(this.client.user.status || {}), presence: 'Online' } })
      .catch(error => console.warn(`[${this.displayName}] could not set presence: ${error.message}`));
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  async getChannel(channelId) {
    const channel =
      this.client.channels.get(channelId) ||
      (await this.client.channels.fetch(channelId));

    if (!channel) {
      throw new Error(`${this.displayName}: channel ${channelId} was not found`);
    }

    if (typeof channel.sendMessage !== 'function') {
      throw new Error(
        `${this.displayName}: channel ${channelId} is not a sendable text channel`
      );
    }

    return channel;
  }

  fileUploadSupport() {
    return 2;
  }

  hostedFileUrls(sent) {
    return (sent?.attachments || []).map(file => file.originalUrl).filter(Boolean);
  }

  async sendMessage(channelId, payload) {
    const channel = await this.getChannel(channelId);
    const attachments = [];
    let content = payload.content;

    for (const file of payload.files || []) {
      try {
        const upload = new File([file.data], file.name, { type: file.contentType || 'application/octet-stream' });
        attachments.push(await this.client.uploadFile('attachments', upload));
      } catch (error) {
        console.warn(`[${this.displayName}] could not upload ${file.name}: ${error.message}`);
        content += `\n[file: ${file.name}]`;
      }
    }

    return channel.sendMessage({
      content,
      ...(attachments.length ? { attachments } : {}),
    });
  }

  isOwnMessage(message) {
    return Boolean(
      message?.authorId === this.client?.user?.id ||
      message?.author?.bot ||
      message?.systemMessage
    );
  }

  normalizeMessage(message) {
    const attachments = (message.attachments || []).map(file => ({
      name: file.filename || null,
      url: file.originalUrl,
      contentType: file.contentType || null,
    }));

    return {
      id: message.id,
      channelId: message.channelId,
      author: {
        id: message.authorId || null,
        username: message.author?.username || 'Unknown User',
        displayName:
          message.masquerade?.name ||
          message.member?.nickname ||
          message.author?.displayName ||
          message.author?.username ||
          message.webhook?.name ||
          'Unknown User',
        avatarUrl: message.avatarURL || null,
        isBot: Boolean(message.author?.bot),
      },
      content: message.content || '',
      attachments,
      webhookId: message.webhook ? message.authorId || 'webhook' : null,
      raw: message,
    };
  }

  async destroy() {
    this.client?.removeAllListeners();
    this.client?.events?.disconnect?.();
  }
}

module.exports = StoatAdapter;
