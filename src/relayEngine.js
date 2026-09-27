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

  // Returns { content, files }: attachments that came as downloaded bytes
  // (Vector's are end-to-end encrypted, so a link is useless elsewhere) are
  // handed to the target to upload; ones with a public URL stay links.
  formatMessage(message, sourceAdapter, relayGroup) {
    const body = [];
    const files = [];

    if (message.content?.trim()) {
      body.push(this.cleanText(message.content.trim()));
    }

    if (this.options.relayAttachments && message.attachments?.length) {
      for (const attachment of message.attachments) {
        if (attachment.data) {
          files.push(attachment);
        } else if (attachment.url) {
          body.push(attachment.url);
        } else if (attachment.note) {
          body.push(attachment.note);
        }
      }
    }

    if (!body.length && !files.length) {
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

    return {
      content: `${prefix}**${this.cleanText(message.author.displayName)}:** ${body.join('\n')}`.trimEnd(),
      files,
    };
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
      const formatted = this.formatMessage(
        message,
        sourceAdapter,
        relayGroup
      );

      if (!formatted) {
        continue;
      }

      // With files, send to the best uploaders first: the copy they host is
      // then linked for targets that can't upload (e.g. a JSON-only webhook).
      const targets = [...relayGroup.channels];
      if (formatted.files.length) {
        const support = target => this.adapters.get(target.platform)?.fileUploadSupport(target.channelId) ?? 0;
        targets.sort((a, b) => support(b) - support(a));
      }
      let fileUrls;

      for (const target of targets) {
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
            content: formatted.content.slice(0, 2000),
            files: formatted.files,
            fileUrls,
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

          if (formatted.files.length && !fileUrls) {
            const hosted = targetAdapter.hostedFileUrls(sent);
            if (hosted.length === formatted.files.length) {
              fileUrls = hosted;
            }
          }

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
