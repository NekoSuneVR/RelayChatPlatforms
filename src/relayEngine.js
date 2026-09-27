// Known API errors get a one-line hint; anything unexpected keeps its stack.
function describeError(error) {
  const hints = {
    10003: 'unknown channel; check the channelId in relays.json',
    50001: 'bot cannot see this channel; give its role View Channel',
    50013: 'bot lacks permission here; give its role View Channel, Send Messages and Read Message History',
  };

  if (hints[error?.code]) {
    return `${error.message} (${hints[error.code]})`;
  }

  return error?.stack || String(error);
}

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

  isSameChannel(entry, platformId, channelId) {
    if (entry.platform !== platformId) {
      return false;
    }

    const adapter = this.adapters.get(platformId);

    return (
      adapter.normalizeChannelId(entry.channelId) ===
      adapter.normalizeChannelId(channelId)
    );
  }

  getGroupsForChannel(platformId, channelId) {
    return (this.config.relayGroups || []).filter(group =>
      Array.isArray(group.channels) &&
      group.channels.some(entry =>
        this.isSameChannel(entry, platformId, channelId)
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

    const message = await sourceAdapter.normalizeMessage(rawMessage);

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
        if (this.isSameChannel(target, platformId, message.channelId)) {
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
            `${sourceAdapter.displayName} -> ${targetAdapter.displayName} ` +
            `(channel ${target.channelId}) failed: ${describeError(error)}`
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
