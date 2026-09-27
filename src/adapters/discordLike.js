const {
  ActivityType,
  Client,
  GatewayIntentBits,
  Events,
  Status,
} = require('discord.js');

const BaseAdapter = require('./base');

// If the gateway isn't Ready for this long, the client is thrown away and a
// fresh one logs in. discord.js reconnects on its own for normal drops; this
// covers sessions that die quietly and never come back.
const STALL_TIMEOUT_MS = 2 * 60 * 1000;
const WATCHDOG_INTERVAL_MS = 30 * 1000;

class DiscordLikeAdapter extends BaseAdapter {
  constructor(definition, endpoints = {}) {
    super(definition);

    this.endpoints = endpoints;
    this.messageHandlers = [];
    // Webhooks that rejected a multipart upload (GameVox self-hosted takes JSON only).
    this.jsonOnlyWebhooks = new Set();
    this.notReadySince = null;
    this.relogging = false;
    this.watchdog = null;
    this.client = this.createClient();
  }

  // Sent on every (re)connect. Without an explicit presence some
  // Discord-compatible platforms (GameVox) show the bot as offline.
  get presence() {
    return {
      status: 'online',
      activities: [
        {
          name: this.definition.activity || 'Relaying chat',
          type: ActivityType.Watching,
        },
      ],
    };
  }

  createClient() {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      presence: this.presence,
      ...(this.endpoints.rest ? { rest: this.endpoints.rest } : {}),
      ...(this.endpoints.ws ? { ws: this.endpoints.ws } : {}),
    });

    client.on(Events.MessageCreate, message => {
      for (const handler of this.messageHandlers) {
        handler(message);
      }
    });

    client.on(Events.Error, error => {
      console.error(`[${this.displayName}] client error`, error);
    });

    client.on(Events.ShardDisconnect, event => {
      console.warn(
        `[${this.displayName}] gateway disconnected (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`
      );
    });

    client.on(Events.ShardReconnecting, () => {
      console.warn(`[${this.displayName}] gateway reconnecting...`);
    });

    client.on(Events.ShardResume, () => {
      console.log(`[${this.displayName}] gateway resumed`);
      client.user?.setPresence(this.presence);
    });

    client.on(Events.ShardReady, () => {
      client.user?.setPresence(this.presence);
    });

    client.on(Events.Invalidated, () => {
      console.warn(`[${this.displayName}] session invalidated; logging in again`);
      this.relogin();
    });

    return client;
  }

  getToken() {
    const token = process.env[this.definition.tokenEnv];

    if (!token) {
      throw new Error(
        `${this.displayName}: environment variable ${this.definition.tokenEnv} is missing`
      );
    }

    return token;
  }

  async connect() {
    await this.client.login(this.getToken());

    console.log(
      `[${this.displayName}] Logged in as ${this.client.user?.tag || this.client.user?.username || 'bot'}`
    );

    this.startWatchdog();
  }

  startWatchdog() {
    clearInterval(this.watchdog);

    this.watchdog = setInterval(() => {
      if (this.client.ws.status === Status.Ready) {
        this.notReadySince = null;
        return;
      }

      this.notReadySince ??= Date.now();

      if (Date.now() - this.notReadySince >= STALL_TIMEOUT_MS) {
        console.warn(
          `[${this.displayName}] gateway not ready for ${STALL_TIMEOUT_MS / 1000}s; logging in again`
        );
        this.relogin();
      }
    }, WATCHDOG_INTERVAL_MS);

    this.watchdog.unref();
  }

  async relogin() {
    if (this.relogging) return;
    this.relogging = true;

    try {
      this.client.removeAllListeners();
      await this.client.destroy();
    } catch {}

    this.client = this.createClient();
    this.notReadySince = null;

    try {
      await this.client.login(this.getToken());
      console.log(`[${this.displayName}] Logged in again`);
    } catch (error) {
      // The watchdog retries on its next tick.
      console.error(`[${this.displayName}] re-login failed: ${error.message}`);
      this.notReadySince = Date.now();
    } finally {
      this.relogging = false;
    }
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  // Optional per-channel webhook, from "webhookEnvs": { "<channelId>": "ENV_NAME" }.
  // Used where the bot can't post directly (GameVox currently refuses bots on
  // channel endpoints even with admin); webhook posts still appear as the bot.
  getWebhookUrl(channelId) {
    const envName = this.definition.webhookEnvs?.[String(channelId)];
    return envName ? process.env[envName]?.trim() || null : null;
  }

  async getChannel(channelId) {
    if (this.getWebhookUrl(channelId)) {
      return { id: channelId, webhook: true };
    }

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

  async postWebhook(target, request) {
    const response = await fetch(target, request);

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(`webhook returned ${response.status} ${body.slice(0, 200)}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }

    return response.json().catch(() => ({}));
  }

  async sendWebhook(url, content, files = [], fileUrls) {
    const target = new URL(url);
    target.searchParams.set('wait', 'true');

    const jsonRequest = text => ({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }),
    });

    // Webhooks that can't take files still get the message, with the files named.
    if (files.length && this.jsonOnlyWebhooks.has(url)) {
      return this.postWebhook(target, jsonRequest(this.withFileNotes({ content, files, fileUrls })));
    }

    const payload = { content, allowed_mentions: { parse: [] } };
    let request;

    if (files.length) {
      // Discord-style multipart: payload_json plus files[n].
      const form = new FormData();
      form.append('payload_json', JSON.stringify(payload));
      files.forEach((file, index) => {
        form.append(
          `files[${index}]`,
          new Blob([file.data], { type: file.contentType || 'application/octet-stream' }),
          file.name
        );
      });
      request = { method: 'POST', body: form };
    } else {
      request = jsonRequest(content);
    }

    try {
      return await this.postWebhook(target, request);
    } catch (error) {
      // A 4xx on a multipart upload means this webhook doesn't take files;
      // remember that and deliver the message as JSON.
      if (!files.length || error.status < 400 || error.status >= 500) {
        throw error;
      }

      this.jsonOnlyWebhooks.add(url);
      console.warn(
        `[${this.displayName}] webhook doesn't accept file uploads (${error.status}); ` +
        'sending files as names in the text from now on'
      );
      return this.postWebhook(target, jsonRequest(this.withFileNotes({ content, files, fileUrls })));
    }
  }

  fileUploadSupport(channelId) {
    const webhookUrl = this.getWebhookUrl(channelId);
    if (!webhookUrl) return 2;
    return this.jsonOnlyWebhooks.has(webhookUrl) ? 0 : 1;
  }

  hostedFileUrls(sent) {
    // A discord.js Message holds a Collection; a webhook reply holds an array.
    const attachments = sent?.attachments;
    const list = typeof attachments?.values === 'function' ? [...attachments.values()] : attachments || [];
    return list.map(attachment => attachment.url).filter(Boolean);
  }

  async sendMessage(channelId, payload) {
    const webhookUrl = this.getWebhookUrl(channelId);

    if (webhookUrl) {
      return this.sendWebhook(webhookUrl, payload.content, payload.files, payload.fileUrls);
    }

    const channel = await this.getChannel(channelId);

    return channel.send({
      content: payload.content,
      files: (payload.files || []).map(file => ({ attachment: file.data, name: file.name })),
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
    clearInterval(this.watchdog);
    this.client.removeAllListeners();
    await this.client.destroy();
  }
}

module.exports = DiscordLikeAdapter;
