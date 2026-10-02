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
    try {
      return await this.getBotChannel(channelId);
    } catch (error) {
      const webhookUrl = this.getWebhookUrl(channelId);

      if (webhookUrl && this.isPermissionError(error)) {
        console.warn(
          `[${this.displayName}] bot cannot access channel ${channelId}; ` +
            'webhook fallback is available if a send is attempted'
        );
        return { id: String(channelId), webhookFallback: true };
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
}

module.exports = GameVoxAdapter;
