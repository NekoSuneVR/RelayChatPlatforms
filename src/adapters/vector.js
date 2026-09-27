const BaseAdapter = require('./base');

const GROUP_PREFIX = 'group:';
const DEFAULT_RELAYS = ['wss://jskitty.cat/nostr', 'wss://relay.damus.io'];

// Vector has no server channels. A relay "channel" is either:
//   - a user's npub / hex pubkey  -> private DM with that user
//   - "group:<groupId>"           -> Vector MLS group (needs the MLS sidecar)
//
// @nekosuneprojects/vector-sdk is ESM-only, so it is loaded with a dynamic import.
class VectorAdapter extends BaseAdapter {
  constructor(definition) {
    super(definition);

    this.client = null;
    this.nip19 = null;
    this.hasGroupTransport = false;
    this.messageHandlers = [];
  }

  getRelays() {
    const fromEnv = this.definition.relaysEnv
      ? process.env[this.definition.relaysEnv]
      : null;

    const relays = fromEnv
      ? fromEnv.split(',')
      : this.definition.relays || DEFAULT_RELAYS;

    return relays.map(relay => relay.trim()).filter(Boolean);
  }

  async connect() {
    const privateKey = process.env[this.definition.tokenEnv];

    if (!privateKey) {
      throw new Error(
        `${this.displayName}: environment variable ${this.definition.tokenEnv} is missing`
      );
    }

    const sdk = await import('@nekosuneprojects/vector-sdk');
    ({ nip19: this.nip19 } = await import('nostr-tools'));

    const mlsSidecarBin = this.definition.mlsSidecarBinEnv
      ? process.env[this.definition.mlsSidecarBinEnv]
      : null;

    const mlsAdapter = mlsSidecarBin
      ? sdk.createMlsSidecarAdapter({
          binPath: mlsSidecarBin,
          stateDir: this.definition.mlsStateDir || '.vector-mls-sidecar',
        })
      : undefined;

    this.hasGroupTransport = Boolean(mlsAdapter);

    this.client = new sdk.VectorBotClient({
      privateKey,
      relays: this.getRelays(),
      profile: this.definition.profile,
      mlsAdapter,
      autoDiscoverGroups: Boolean(mlsAdapter),
      debug: process.env.DEBUG === '1',
    });

    this.client.on('message', (pubkey, tags, content, self) => {
      for (const handler of this.messageHandlers) {
        handler({ pubkey, tags, content, self });
      }
    });

    this.client.on('error', error => {
      console.error(`[${this.displayName}] client error`, error);
    });

    const ready = new Promise(resolve => this.client.once('ready', resolve));
    await this.client.connect();
    const { pubkey } = await ready;

    console.log(
      `[${this.displayName}] Online as ${this.nip19.npubEncode(pubkey)}`
    );
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  // Config may use npub or hex; incoming DMs carry hex pubkeys.
  normalizeChannelId(channelId) {
    const id = String(channelId).trim();

    if (id.startsWith(GROUP_PREFIX) || !this.nip19) {
      return id;
    }

    if (id.startsWith('npub1')) {
      return this.nip19.decode(id).data;
    }

    return id.toLowerCase();
  }

  async getChannel(channelId) {
    const id = this.normalizeChannelId(channelId);

    if (id.startsWith(GROUP_PREFIX)) {
      if (!this.hasGroupTransport) {
        throw new Error(
          `${this.displayName}: group channels need the MLS sidecar ` +
          `(set ${this.definition.mlsSidecarBinEnv || 'mlsSidecarBinEnv'})`
        );
      }

      return { type: 'group', id: id.slice(GROUP_PREFIX.length) };
    }

    if (!/^[0-9a-f]{64}$/.test(id)) {
      throw new Error(
        `${this.displayName}: ${channelId} is not an npub, hex pubkey or group:<id>`
      );
    }

    return { type: 'dm', id };
  }

  async sendMessage(channelId, payload) {
    const channel = await this.getChannel(channelId);

    if (channel.type === 'group') {
      const sent = await this.client.sendGroupMessage(channel.id, payload.content);

      if (!sent) {
        throw new Error(`${this.displayName}: group send to ${channel.id} failed`);
      }

      return { id: null };
    }

    return this.client.send(channel.id, payload.content);
  }

  isOwnMessage(message) {
    return Boolean(message?.self);
  }

  normalizeMessage({ pubkey, tags, content }) {
    const attachments = [];

    // Vector attachments are AES-GCM encrypted by default; the URL is useless
    // to anyone without the key, so only plain attachments are relayed.
    if (tags.attachment && !tags.attachment.encryption) {
      attachments.push({
        name: tags.attachment.filename || null,
        url: tags.attachment.url,
        contentType: tags.attachment.mimeType || null,
      });
    }

    const npub = this.nip19.npubEncode(pubkey);

    return {
      id: tags.messageId || tags.rawEvent?.id,
      channelId: tags.isGroup && tags.groupId
        ? `${GROUP_PREFIX}${tags.groupId}`
        : pubkey,
      author: {
        id: pubkey,
        username: npub,
        displayName: tags.displayName || `${npub.slice(0, 12)}…`,
        avatarUrl: null,
        isBot: false,
      },
      content: content || '',
      attachments,
      webhookId: null,
      raw: { pubkey, tags, content },
    };
  }

  async destroy() {
    this.client?.close();
  }
}

module.exports = VectorAdapter;
