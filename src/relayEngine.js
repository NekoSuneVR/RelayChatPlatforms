class RelayEngine {
  constructor(config, adapters) {
    this.config = config;
    this.adapters = adapters;
    this.relayedMessageIds = new Set();

    this.options = {
      relayAttachments: true,
      relayWebhookMessages: true,
      showPlatform: true,
      showRelayGroup: false,
      preventEveryoneMentions: true,
      ...(config.options || {}),
    };
  }

  cleanText(text = '') {
    if (!this.options.preventEveryoneMentions) {
      return text;
    }

    return text
      .replace(/@everyone/g, '@\u200beveryone')
      .replace(/@here/g, '@\u200bhere');
  }

  rememberMessage(id) {
    if (!id) return;

    this.relayedMessageIds.add(id);

    setTimeout(() => {
      this.relayedMessageIds.delete(id);
    }, 10 * 60 * 1000).unref();
  }

  getGroupsForChannel(platformId, channelId) {
    return (this.config.relayGroups || []).filter(group =>
      Array.isArray(group.channels) &&
      group.channels.some(
        entry =>
          entry.platform === platformId &&
          String(entry.channelId) === String(channelId)
      )
    );
  }

  formatMessage(message, sourceAdapter, relayGroup) {
    const body = [];

    if (message.content?.trim()) {
      body.push(this.cleanText(message.content.trim()));
    }

    if (this.options.relayAttachments && message.attachments?.length) {
      for (const attachment of message.attachments) {
        if (attachment.url) {
          body.push(attachment.url);
        }
      }
    }

    if (!body.length) {
      return null;
    }

    const prefixParts = [];

    if (this.options.showPlatform) {
      prefixParts.push(`[${sourceAdapter.displayName}]`);
    }

    if (this.options.showRelayGroup) {
      prefixParts.push(`[${relayGroup.name || relayGroup.id}]`);
    }

    const prefix = prefixParts.length
      ? `${prefixParts.join(' ')} `
      : '';

    return `${prefix}**${this.cleanText(message.author.displayName)}:** ${body.join('\n')}`;
  }

  async handleIncoming(platformId, rawMessage) {
    const sourceAdapter = this.adapters.get(platformId);

    if (!sourceAdapter) {
      return;
    }

    if (sourceAdapter.isOwnMessage(rawMessage)) {
      return;
    }

    const message = sourceAdapter.normalizeMessage(rawMessage);

    if (this.relayedMessageIds.has(message.id)) {
      return;
    }

    if (!this.options.relayWebhookMessages && message.webhookId) {
      return;
    }

    const groups = this.getGroupsForChannel(platformId, message.channelId);

    for (const relayGroup of groups) {
      const content = this.formatMessage(
        message,
        sourceAdapter,
        relayGroup
      );

      if (!content) {
        continue;
      }

      for (const target of relayGroup.channels) {
        if (
          target.platform === platformId &&
          String(target.channelId) === String(message.channelId)
        ) {
          continue;
        }

        const targetAdapter = this.adapters.get(target.platform);

        if (!targetAdapter) {
          console.warn(
            `[relay] Missing adapter "${target.platform}" in group "${relayGroup.id}"`
          );
          continue;
        }

        try {
          const sent = await targetAdapter.sendMessage(target.channelId, {
            content: content.slice(0, 2000),
            source: {
              platformId,
              platformName: sourceAdapter.displayName,
              messageId: message.id,
              channelId: message.channelId,
              author: message.author,
              relayGroupId: relayGroup.id,
            },
          });

          this.rememberMessage(sent?.id);

          console.log(
            `[relay:${relayGroup.id}] ` +
            `${sourceAdapter.displayName} -> ${targetAdapter.displayName}: ` +
            `${message.id} -> ${sent?.id || 'sent'}`
          );
        } catch (error) {
          console.error(
            `[relay:${relayGroup.id}] ` +
            `${sourceAdapter.displayName} -> ${targetAdapter.displayName} failed`,
            error
          );
        }
      }
    }
  }

  bind() {
    for (const [platformId, adapter] of this.adapters.entries()) {
      adapter.onMessage(message => {
        this.handleIncoming(platformId, message).catch(error => {
          console.error(
            `[relay] Unhandled message error from ${adapter.displayName}`,
            error
          );
        });
      });
    }
  }
}

module.exports = RelayEngine;
