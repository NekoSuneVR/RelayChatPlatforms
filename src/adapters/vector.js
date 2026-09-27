const fs = require('fs');

const BaseAdapter = require('./base');

const GROUP_PREFIX = 'group:';
const COMMUNITY_PREFIX = 'community:';
// The SDK's DEFAULT_KEY_ENV_VARS + DEFAULT_MNEMONIC_ENV_VARS.
const KEY_ENV_VARS = [
  'VECTOR_NSEC',
  'VECTOR_PRIVATE_KEY',
  'NOSTR_PRIVATE_KEY',
  'NSEC',
  'VECTOR_MNEMONIC',
  'NOSTR_MNEMONIC',
];
const DEFAULT_RELAYS = ['wss://jskitty.cat/nostr', 'wss://relay.damus.io'];

// A relay "channel" on Vector is one of:
//   - "community:<communityId>/<channel>" -> a channel in a Vector community,
//     <channel> being its id or name ("general")
//   - a user's npub / hex pubkey          -> private DM with that user
//   - "group:<groupId>"                   -> legacy MLS group (needs the sidecar)
//
// @nekosuneprojects/vector-sdk is ESM-only, so it is loaded with a dynamic import.
class VectorAdapter extends BaseAdapter {
  constructor(definition) {
    super(definition);

    this.client = null;
    this.nip19 = null;
    this.hasGroupTransport = false;
    this.messageHandlers = [];
    this.displayNames = new Map();
  }

  // Invites from these npubs/hex keys are accepted automatically; any other
  // invite stays parked, the way Vector itself waits for consent.
  getTrustedInviters() {
    return new Set(
      (this.definition.acceptInvitesFrom || []).map(key =>
        String(key).startsWith('npub1') ? this.nip19.decode(key).data : String(key).toLowerCase()
      )
    );
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

  // Mirrors the sources resolveAccount() checks, without loading the ESM SDK.
  getDisabledReason() {
    if (this.definition.createAccount) {
      return null;
    }

    const accountFile =
      this.definition.accountFile ||
      process.env.VECTOR_ACCOUNT_FILE ||
      'vector-bot-account.json';

    const envVars = [
      ...new Set([this.definition.tokenEnv, ...KEY_ENV_VARS].filter(Boolean)),
    ];

    if (
      fs.existsSync(accountFile) ||
      envVars.some(name => process.env[name]?.trim())
    ) {
      return null;
    }

    return `no account file and ${envVars.join(' / ')} are blank`;
  }

  // Account file first, then tokenEnv / the SDK's default key and seed-phrase
  // env vars; with createAccount a fresh key is minted and saved on first run.
  async resolveAccount(sdk) {
    const envVars = [
      ...(this.definition.tokenEnv ? [this.definition.tokenEnv] : []),
      ...sdk.DEFAULT_KEY_ENV_VARS,
    ];

    try {
      return await sdk.resolveAccount({
        file: this.definition.accountFile,
        envVars,
        create: Boolean(this.definition.createAccount),
      });
    } catch (error) {
      throw new Error(`${this.displayName}: ${error.message}`);
    }
  }

  async connect() {
    const sdk = await import('@nekosuneprojects/vector-sdk');
    ({ nip19: this.nip19 } = await import('nostr-tools'));

    const { account, source, filePath, envVar } = await this.resolveAccount(sdk);

    console.log(
      `[${this.displayName}] Using account ${account.npub} from ` +
      (source === 'env' ? envVar : `${source} ${filePath}`)
    );

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
      privateKey: account.privateKey,
      relays: this.getRelays(),
      profile: this.definition.profile,
      mlsAdapter,
      autoDiscoverGroups: Boolean(mlsAdapter),
      discoverGroupsFromHistory: Boolean(mlsAdapter),
      communitiesFile: this.definition.communitiesFile,
      debug: process.env.DEBUG === '1',
    });

    this.client.on('message', (pubkey, tags, content, self) => {
      for (const handler of this.messageHandlers) {
        handler({ pubkey, tags, content, self });
      }
    });

    this.client.on('community_message', message => {
      for (const handler of this.messageHandlers) {
        handler({ community: message });
      }
    });

    const trustedInviters = this.getTrustedInviters();
    this.client.on('invite', received => {
      const { invite, senderPubkey, expired } = received;
      const label = `${invite.name || invite.communityId} from ${this.nip19.npubEncode(senderPubkey)}`;

      if (expired || !trustedInviters.has(senderPubkey)) {
        console.log(
          `[${this.displayName}] Community invite to ${label} ${expired ? 'has expired' : 'is waiting (sender not in acceptInvitesFrom)'}`
        );
        return;
      }

      this.client.acceptInvite(invite.communityId).then(
        () => console.log(`[${this.displayName}] Accepted community invite to ${label}`),
        error => console.warn(`[${this.displayName}] Could not accept invite to ${label}: ${error.message}`)
      );
    });

    this.client.on('community_joined', community => this.logCommunityChannels(community.communityId));
    this.client.on('community_announced', ({ communityName }) => {
      console.log(`[${this.displayName}] Joined ${communityName}; members can now see the bot`);
    });

    this.client.on('error', error => {
      console.error(`[${this.displayName}] client error`, error);
    });

    // Logged so the group ID can be copied into relays.json as "group:<id>".
    const seenGroups = new Set();
    this.client.on('group_discovered', ({ groupId, source }) => {
      if (seenGroups.has(groupId)) return;
      seenGroups.add(groupId);
      console.log(
        `[${this.displayName}] Group available: group:${groupId} (via ${source})`
      );
    });

    // Group invites (MLS welcomes) are accepted automatically by the SDK when
    // the sidecar is configured; these make that visible.
    // Vector can only invite the bot to a group once this is published.
    this.client.on('mls_keypackage', ({ published }) => {
      console.log(
        `[${this.displayName}] Group key package ${published ? 'published' : 'already published'}; the bot can be invited to groups`
      );
    });

    this.client.on('mls_welcome_processed', ({ groupId }) => {
      console.log(
        `[${this.displayName}] Accepted group invite${groupId ? `: group:${groupId}` : ''}`
      );
    });

    this.client.on('mls_welcome_process_failed', ({ error }) => {
      console.warn(`[${this.displayName}] Could not accept group invite: ${error}`);
    });

    const ready = new Promise(resolve => this.client.once('ready', resolve));
    await this.client.connect();
    const { pubkey, knownGroupIds = [] } = await ready;

    console.log(
      `[${this.displayName}] Online as ${this.nip19.npubEncode(pubkey)}` +
      (mlsAdapter ? ` in ${knownGroupIds.length} group(s)` : ' (DMs only; no MLS sidecar)')
    );

    for (const groupId of knownGroupIds) {
      if (seenGroups.has(groupId)) continue;
      seenGroups.add(groupId);
      console.log(`[${this.displayName}] Group available: group:${groupId}`);
    }

    this.logCommunityChannels();
  }

  // Logged so the channel can be copied into relays.json.
  logCommunityChannels(communityId) {
    for (const channel of this.client.getCommunityChannels(communityId)) {
      console.log(
        `[${this.displayName}] Community channel available: ` +
        `${COMMUNITY_PREFIX}${channel.communityId}/${channel.name || channel.id}`
      );
    }
  }

  parseCommunityChannel(id) {
    const [communityId, channel] = id.slice(COMMUNITY_PREFIX.length).split('/');

    if (!communityId || !channel) {
      throw new Error(
        `${this.displayName}: ${id} should look like community:<communityId>/<channel id or name>`
      );
    }

    return { communityId: communityId.toLowerCase(), channel };
  }

  findCommunityChannel(id) {
    const { communityId, channel } = this.parseCommunityChannel(id);
    const wanted = channel.replace(/^#/, '').toLowerCase();

    return this.client
      ?.getCommunityChannels(communityId)
      .find(c => c.id === wanted || c.name?.toLowerCase() === wanted);
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  // Config may use npub or hex; incoming DMs carry hex pubkeys.
  normalizeChannelId(channelId) {
    const id = String(channelId).trim();

    // Configs may name a community channel; incoming messages carry its id.
    if (id.startsWith(COMMUNITY_PREFIX)) {
      try {
        const channel = this.findCommunityChannel(id);
        return channel ? `${COMMUNITY_PREFIX}${channel.communityId}/${channel.id}` : id.toLowerCase();
      } catch {
        return id.toLowerCase();
      }
    }

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

    if (id.startsWith(COMMUNITY_PREFIX)) {
      const { communityId, channel } = this.parseCommunityChannel(id);
      const found = this.findCommunityChannel(id);

      if (!found) {
        const available = this.client.getCommunityChannels(communityId);
        throw new Error(
          `${this.displayName}: no channel "${channel}" in community ${communityId}. ` +
          (available.length
            ? `Available: ${available.map(c => c.name || c.id).join(', ')}`
            : 'The bot is not in that community; invite it from Vector (see acceptInvitesFrom)')
        );
      }

      return { type: 'community', communityId: found.communityId, channelId: found.id };
    }

    if (id.startsWith(GROUP_PREFIX)) {
      if (!this.hasGroupTransport) {
        throw new Error(
          `${this.displayName}: group channels need the MLS sidecar ` +
          `(set ${this.definition.mlsSidecarBinEnv || 'mlsSidecarBinEnv'})`
        );
      }

      const groupId = id.slice(GROUP_PREFIX.length);
      const knownGroups = this.client?.getKnownGroupIds() || [];

      if (!knownGroups.includes(groupId)) {
        throw new Error(
          `${this.displayName}: the bot is not in group ${groupId}. ` +
          'Invite the bot to the group in Vector, restart, and use an ID from the "Group available" log lines' +
          (knownGroups.length ? ` (known: ${knownGroups.map(g => `group:${g}`).join(', ')})` : '')
        );
      }

      return { type: 'group', id: groupId };
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

    if (channel.type === 'community') {
      return this.client.sendCommunityMessage(channel.communityId, channel.channelId, payload.content);
    }

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
    // The SDK never emits the bot's own community messages.
    return Boolean(message?.self);
  }

  // Profile names are cached; a lookup that fails falls back to a short npub.
  async resolveDisplayName(pubkey) {
    if (!this.displayNames.has(pubkey)) {
      const name = await this.client.fetchUser(pubkey).then(user => user.displayName, () => null);
      this.displayNames.set(pubkey, name || `${this.nip19.npubEncode(pubkey).slice(0, 12)}…`);
    }

    return this.displayNames.get(pubkey);
  }

  async normalizeMessage(message) {
    if (message.community) {
      return this.normalizeCommunityMessage(message.community);
    }

    const { pubkey, tags, content } = message;
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

  async normalizeCommunityMessage(message) {
    const npub = this.nip19.npubEncode(message.author);

    return {
      id: message.id,
      channelId: `${COMMUNITY_PREFIX}${message.communityId}/${message.channelId}`,
      author: {
        id: message.author,
        username: npub,
        displayName: await this.resolveDisplayName(message.author),
        avatarUrl: null,
        isBot: false,
      },
      content: message.content || '',
      attachments: [],
      webhookId: null,
      raw: message,
    };
  }

  async destroy() {
    this.client?.close();
  }
}

module.exports = VectorAdapter;
