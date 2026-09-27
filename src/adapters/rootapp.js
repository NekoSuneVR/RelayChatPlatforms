const BaseAdapter = require('./base');

// Root bots don't log in with a token. The process has to be launched by
// Root's host (`npm run root:dev` locally, or Root's cloud once uploaded),
// which injects COMMUNITY_ID / APP_ID / BASE_URL. One community per process,
// so only one "rootapp" platform can be configured.
class RootAppAdapter extends BaseAdapter {
  constructor(definition) {
    super(definition);

    this.sdk = null;
    this.botUserId = null;
    this.sentMessageIds = new Set();
    this.memberNames = new Map();
    this.messageHandlers = [];
  }

  // COMMUNITY_ID is injected by Root's host, so it's blank under plain `npm start`.
  getDisabledReason() {
    if (!process.env.COMMUNITY_ID && !process.env.MULTI_COMMUNITY) {
      return 'not running under Root\'s host (use "npm run root:dev" with DEV_TOKEN in .env)';
    }

    return null;
  }

  async connect() {

    // Required lazily: the SDK calls process.exit() at load time when
    // COMMUNITY_ID is missing, which would kill non-Root deployments.
    this.sdk = require('@rootsdk/server-bot');

    const { rootServer, ChannelMessageEvent } = this.sdk;

    rootServer.community.channelMessages.on(
      ChannelMessageEvent.ChannelMessageCreated,
      evt => {
        for (const handler of this.messageHandlers) {
          handler(evt);
        }
      }
    );

    // lifecycle.start() may keep running for the life of the bot, so resolve
    // once Root reports the bot as started instead of awaiting it.
    await new Promise((resolve, reject) => {
      rootServer.lifecycle
        .start(async state => {
          console.log(
            `[${this.displayName}] Started in community ${state.communityId}`
          );
          resolve();
        })
        .catch(reject);
    });
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  async getChannel(channelId) {
    return this.sdk.rootServer.community.channels.get({ id: channelId });
  }

  async sendMessage(channelId, payload) {
    const message = await this.sdk.rootServer.community.channelMessages.create({
      channelId,
      content: this.withFileNotes(payload),
    });

    this.botUserId = message.userId;
    this.sentMessageIds.add(message.id);
    setTimeout(() => this.sentMessageIds.delete(message.id), 10 * 60 * 1000).unref();

    return message;
  }

  isOwnMessage(evt) {
    return Boolean(
      evt.messageType === this.sdk.MessageType.System ||
      this.sentMessageIds.has(evt.id) ||
      (this.botUserId && evt.userId === this.botUserId)
    );
  }

  async resolveDisplayName(userId) {
    if (this.memberNames.has(userId)) {
      return this.memberNames.get(userId);
    }

    try {
      const member = await this.sdk.rootServer.community.communityMembers.get({ userId });
      this.memberNames.set(userId, member.nickname);
      return member.nickname;
    } catch {
      return null;
    }
  }

  // Root events carry only a userId, so the nickname lookup makes this async.
  async normalizeMessage(evt) {
    const attachments = (evt.messageUris || [])
      .filter(entry => entry.attachment && /^https?:\/\//.test(entry.uri))
      .map(entry => ({
        name: entry.attachment.fileName || null,
        url: entry.uri,
        contentType: entry.attachment.mimeType || null,
      }));

    const displayName = (await this.resolveDisplayName(evt.userId)) || 'Unknown User';

    return {
      id: evt.id,
      channelId: evt.channelId,
      author: {
        id: evt.userId,
        username: displayName,
        displayName,
        avatarUrl: null,
        isBot: false,
      },
      content: evt.messageContent || '',
      attachments,
      webhookId: null,
      raw: evt,
    };
  }
}

module.exports = RootAppAdapter;
