const fs = require('fs');
const path = require('path');

const BaseAdapter = require('./base');

// Discord's upload limit for bots; bigger files are named in the text instead.
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
// Events older than this at startup are backlog from the first sync, not new chat.
const BACKLOG_SLACK_MS = 5000;
const RELAYED_MSGTYPES = new Set(['m.text', 'm.emote', 'm.image', 'm.file', 'm.video', 'm.audio']);

// A relay "channel" on Matrix is a room: its id ("!abc:server") or an alias
// ("#general:server"). A Discord-style server is a Matrix Space; each of its
// channels is its own room, so each goes into relays.json separately.
//
// Credentials: a username + password (userEnv / passwordEnv) that logs in
// once and keeps the session in sessionFile, so restarts reuse the bot's own
// device; or an access token (tokenEnv). With encryption on, the token must
// belong to a session made for the bot: a token copied from Element is
// Element's device, whose encryption keys only Element holds.
class MatrixAdapter extends BaseAdapter {
  constructor(definition) {
    super(definition);

    this.client = null;
    this.userId = null;
    this.messageHandlers = [];
    this.roomAliases = new Map();
    this.displayNames = new Map();
    this.startedAt = 0;
  }

  get sessionFile() {
    return this.definition.sessionFile || 'matrix-bot-session.json';
  }

  env(name) {
    return name ? process.env[name]?.trim() || null : null;
  }

  getDisabledReason() {
    if (!this.definition.homeserverUrl) {
      return 'homeserverUrl is not set';
    }

    const { tokenEnv, userEnv, passwordEnv } = this.definition;
    if (this.env(tokenEnv) || fs.existsSync(this.sessionFile) || (this.env(userEnv) && this.env(passwordEnv))) {
      return null;
    }

    return `${[tokenEnv, userEnv && passwordEnv && `${userEnv} + ${passwordEnv}`].filter(Boolean).join(' or ') || 'credentials'} blank and no ${this.sessionFile}`;
  }

  readSession() {
    try {
      const session = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      return session.homeserverUrl === this.definition.homeserverUrl ? session : null;
    } catch {
      return null;
    }
  }

  // Saved session first, then a password login (the bot's own device), and
  // only then a raw token.
  async resolveAccessToken(sdk) {
    const session = this.readSession();
    if (session?.accessToken) {
      return session.accessToken;
    }

    const username = this.env(this.definition.userEnv);
    const password = this.env(this.definition.passwordEnv);
    if (!username || !password) {
      return this.env(this.definition.tokenEnv);
    }

    const auth = new sdk.MatrixAuth(this.definition.homeserverUrl);
    const loggedIn = await auth.passwordLogin(username, password, this.definition.deviceName || 'Relay bot');
    const whoami = await loggedIn.getWhoAmI();

    // The token is a credential: owner-only, and gitignored.
    fs.writeFileSync(
      this.sessionFile,
      JSON.stringify({
        homeserverUrl: this.definition.homeserverUrl,
        userId: whoami.user_id,
        deviceId: whoami.device_id,
        accessToken: loggedIn.accessToken,
      }, null, 2),
      { mode: 0o600 }
    );
    console.log(`[${this.displayName}] Logged in as ${whoami.user_id}; session saved to ${this.sessionFile}`);
    return loggedIn.accessToken;
  }

  async connect() {
    const sdk = require('matrix-bot-sdk');
    sdk.LogService.setLevel(process.env.DEBUG === '1' ? sdk.LogLevel.DEBUG : sdk.LogLevel.WARN);

    const accessToken = await this.resolveAccessToken(sdk);
    const storage = new sdk.SimpleFsStorageProvider(this.definition.storageFile || 'matrix-bot-storage.json');

    // Element encrypts private rooms by default, so encryption is on unless
    // turned off. The crypto store holds one device's keys, so each device
    // gets its own folder: a store paired with the wrong device is rejected
    // by the server, and switching logins must never mix them up.
    let cryptoStore;
    if (this.definition.encryption !== false) {
      const { StoreType } = require('@matrix-org/matrix-sdk-crypto-nodejs');
      const { device_id: deviceId } = await new sdk.MatrixClient(this.definition.homeserverUrl, accessToken).getWhoAmI();
      const cryptoDir = path.join(this.definition.cryptoDir || 'matrix-crypto', deviceId);
      cryptoStore = new sdk.RustSdkCryptoStorageProvider(cryptoDir, StoreType.Sqlite);
    }

    this.client = new sdk.MatrixClient(this.definition.homeserverUrl, accessToken, storage, cryptoStore);
    this.userId = await this.client.getUserId();

    this.client.on('room.invite', (roomId, event) => this.handleInvite(roomId, event));
    this.client.on('room.join', roomId => {
      this.describeRoom(roomId).then(label => console.log(`[${this.displayName}] Room available: ${label}`));
    });
    this.client.on('room.message', (roomId, event) => {
      if (!this.shouldRelay(event)) return;
      for (const handler of this.messageHandlers) {
        handler({ roomId, event });
      }
    });
    this.client.on('room.failed_decryption', (roomId, event, error) => {
      console.warn(`[${this.displayName}] could not decrypt a message in ${roomId}: ${error.message}`);
    });

    this.startedAt = Date.now();
    try {
      await this.client.start();
    } catch (error) {
      if (/one time key .* already exists/i.test(error.message || error.body?.error || '')) {
        throw new Error(
          'this device already has encryption keys on the server that the local store ' +
          `(${this.definition.cryptoDir || 'matrix-crypto'}) doesn't hold. Usually the access token is ` +
          `Element's session: log in with ${this.definition.userEnv} / ${this.definition.passwordEnv} instead, ` +
          `delete ${this.definition.cryptoDir || 'matrix-crypto'}/, ${this.definition.storageFile || 'matrix-bot-storage.json'} ` +
          `and ${this.sessionFile}, and restart`
        );
      }
      throw error;
    }

    console.log(
      `[${this.displayName}] Logged in as ${this.userId}` +
      (cryptoStore ? ' (end-to-end encryption on)' : '')
    );

    for (const roomId of await this.client.getJoinedRooms()) {
      console.log(`[${this.displayName}] Room available: ${await this.describeRoom(roomId)}`);
    }
  }

  // "!id:server (#alias:server, Name)", so the id can be copied into relays.json.
  async describeRoom(roomId) {
    const state = type => this.client.getRoomStateEvent(roomId, type, '').catch(() => null);
    const [name, alias] = await Promise.all([state('m.room.name'), state('m.room.canonical_alias')]);
    const details = [alias?.alias, name?.name].filter(Boolean).join(', ');
    return details ? `${roomId} (${details})` : roomId;
  }

  // Invites are accepted from acceptInvitesFrom when it is set, else from anyone.
  handleInvite(roomId, event) {
    const allowed = this.definition.acceptInvitesFrom;
    if (allowed?.length && !allowed.includes(event.sender)) {
      console.log(`[${this.displayName}] Ignoring invite to ${roomId} from ${event.sender} (not in acceptInvitesFrom)`);
      return;
    }

    this.client.joinRoom(roomId).then(
      () => console.log(`[${this.displayName}] Accepted invite to ${roomId} from ${event.sender}`),
      error => console.warn(`[${this.displayName}] Could not join ${roomId}: ${error.message}`)
    );
  }

  shouldRelay(event) {
    const content = event?.content;
    if (!content || !RELAYED_MSGTYPES.has(content.msgtype)) return false;
    // Edits re-send the whole message; relaying them would duplicate it.
    if (content['m.relates_to']?.rel_type === 'm.replace') return false;
    if (event.origin_server_ts < this.startedAt - BACKLOG_SLACK_MS) return false;
    return true;
  }

  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  normalizeChannelId(channelId) {
    const id = String(channelId).trim();
    return this.roomAliases.get(id) || id;
  }

  async getChannel(channelId) {
    const roomId = await this.client.resolveRoom(String(channelId).trim()).catch(error => {
      throw new Error(`${this.displayName}: could not resolve ${channelId}: ${error.message}`);
    });

    if (roomId !== channelId) {
      this.roomAliases.set(String(channelId).trim(), roomId);
    }

    const joined = await this.client.getJoinedRooms();
    if (!joined.includes(roomId)) {
      throw new Error(`${this.displayName}: the bot is not in ${channelId}; invite ${this.userId} to the room`);
    }

    return { roomId };
  }

  fileUploadSupport() {
    return 2;
  }

  // Matrix media needs an access token to download on current servers, so
  // there's no public link to hand to other platforms.
  hostedFileUrls() {
    return [];
  }

  // Engine output uses **bold**; Matrix gets it as HTML with a plain fallback.
  formatContent(text) {
    const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return {
      msgtype: this.definition.noticeMessages ? 'm.notice' : 'm.text',
      body: text.replace(/\*\*(.+?)\*\*/g, '$1'),
      format: 'org.matrix.custom.html',
      formatted_body: escape(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n/g, '<br>'),
    };
  }

  async uploadFile(roomId, file) {
    const info = { mimetype: file.contentType || 'application/octet-stream', size: file.data.length };
    const msgtype = info.mimetype.startsWith('image/')
      ? 'm.image'
      : info.mimetype.startsWith('video/')
        ? 'm.video'
        : info.mimetype.startsWith('audio/') ? 'm.audio' : 'm.file';

    // In an encrypted room the file is encrypted too, not just the event.
    if (this.client.crypto && (await this.client.crypto.isRoomEncrypted(roomId))) {
      const encrypted = await this.client.crypto.encryptMedia(file.data);
      const url = await this.client.uploadContent(encrypted.buffer, 'application/octet-stream', file.name);
      return this.client.sendMessage(roomId, { msgtype, body: file.name, info, file: { ...encrypted.file, url } });
    }

    const url = await this.client.uploadContent(file.data, info.mimetype, file.name);
    return this.client.sendMessage(roomId, { msgtype, body: file.name, info, url });
  }

  async sendMessage(channelId, payload) {
    const { roomId } = await this.getChannel(channelId);
    const eventId = await this.client.sendMessage(roomId, this.formatContent(payload.content));

    for (const file of payload.files || []) {
      try {
        await this.uploadFile(roomId, file);
      } catch (error) {
        console.warn(`[${this.displayName}] could not upload ${file.name}: ${error.message}`);
        await this.client.sendMessage(roomId, this.formatContent(`[file: ${file.name}]`));
      }
    }

    return { id: eventId };
  }

  isOwnMessage(message) {
    return message?.event?.sender === this.userId;
  }

  async resolveDisplayName(roomId, userId) {
    const key = `${roomId}|${userId}`;
    if (!this.displayNames.has(key)) {
      const member = await this.client.getRoomStateEvent(roomId, 'm.room.member', userId).catch(() => null);
      const profile = member?.displayname ? null : await this.client.getUserProfile(userId).catch(() => null);
      this.displayNames.set(key, member?.displayname || profile?.displayname || userId.replace(/^@/, '').split(':')[0]);
    }
    return this.displayNames.get(key);
  }

  // Encrypted rooms carry `file` (key + iv), plain ones a bare `url`.
  async downloadAttachment(content) {
    const name = content.filename || content.body || 'attachment';
    const maxBytes = this.definition.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;

    try {
      if ((content.info?.size ?? 0) > maxBytes) {
        throw new Error('over the size limit');
      }
      const data = content.file
        ? await this.client.crypto.decryptMedia(content.file)
        : (await this.client.downloadContent(content.url)).data;
      if (data.length > maxBytes) {
        throw new Error('over the size limit');
      }
      return { name, contentType: content.info?.mimetype || 'application/octet-stream', data };
    } catch (error) {
      console.warn(`[${this.displayName}] could not fetch attachment ${name}: ${error.message}`);
      return { name, note: `[attachment: ${name} (${/limit/.test(error.message) ? 'too large' : 'unavailable'})]` };
    }
  }

  async normalizeMessage({ roomId, event }) {
    const { content } = event;
    const isMedia = ['m.image', 'm.file', 'm.video', 'm.audio'].includes(content.msgtype);

    let text = isMedia ? '' : content.body || '';
    // Replies carry a quoted fallback ("> <@user> ...") ahead of the real text.
    if (content['m.relates_to']?.['m.in_reply_to'] && text.startsWith('> ')) {
      text = text.replace(/^(?:>.*\n?)+\n?/, '');
    }
    if (content.msgtype === 'm.emote') {
      text = `*${text}*`;
    }

    return {
      id: event.event_id,
      channelId: roomId,
      author: {
        id: event.sender,
        username: event.sender,
        displayName: await this.resolveDisplayName(roomId, event.sender),
        avatarUrl: null,
        isBot: false,
      },
      content: text,
      attachments: isMedia ? [await this.downloadAttachment(content)] : [],
      webhookId: null,
      raw: event,
    };
  }

  async destroy() {
    this.client?.stop();
  }
}

module.exports = MatrixAdapter;
