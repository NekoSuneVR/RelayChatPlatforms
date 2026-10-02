# Multi-Platform Chat Relay

A platform-aware Node.js relay designed to bridge chat between:

- Discord
- GameVox
- Fluxer (`@fluxerjs/core`)
- Matrix (`matrix-bot-sdk`)
- Root (`@rootsdk/server-bot`)
- Vector (`@nekosuneprojects/vector-sdk`)
- Stoat (`stoat.js`)
- any other platform added later

The relay core no longer assumes that a message comes from Discord or GameVox.
Every connection has a platform ID and display name, and every relayed message
can show the source platform.

## Current adapters

### Discord

Native `discord.js`.

### GameVox

Also uses `discord.js`, with GameVox's Discord-compatible REST/Gateway:

```js
rest: { api: 'https://bot-api.gamevox.com/api' },
ws:   { gatewayURL: 'wss://gateway.gamevox.com' },
```

### Fluxer

Uses [`@fluxerjs/core`](https://fluxer.js.org/) v3.x. Fluxer does not use Discord-style gateway intents; the adapter creates a native Fluxer client, listens for `MessageCreate`, fetches configured channels, and sends through `channel.send()`.

```json
"fluxer-main": {
  "type": "fluxer",
  "displayName": "Fluxer",
  "tokenEnv": "FLUXER_BOT_TOKEN",
  "apiUrlEnv": "FLUXER_API_URL"
}
```

Put the bot token in `.env`:

```dotenv
FLUXER_BOT_TOKEN=
FLUXER_API_URL=
```

Leave `FLUXER_API_URL` blank for hosted Fluxer. For a self-hosted instance you can either set `apiUrl` / `apiUrlEnv` for the legacy REST override, or use `discoveryOrigin` / `discoveryEnv` so Fluxer.js discovers the API, media/CDN and invite endpoints from `/.well-known/fluxer`. The channel ID in a relay group is the Fluxer channel ID.

Fluxer text messages and uploaded files are relayed in both directions. Bot/webhook messages are ignored to prevent loops. The adapter also normalizes usernames, display names and avatar URLs into the common relay format.

### Stoat

Uses [`stoat.js`](https://github.com/stoatchat/javascript-client-sdk). Needs a bot
token in `STOAT_BOT_TOKEN`; `channelId` is a Stoat channel ID. Set `baseURL` on the
platform definition to use a self-hosted instance.

```json
"stoat-main": { "type": "stoat", "displayName": "Stoat", "tokenEnv": "STOAT_BOT_TOKEN" }
```

### Vector

Uses [`@nekosuneprojects/vector-sdk`](https://www.npmjs.com/package/@nekosuneprojects/vector-sdk).
Requires 1.2.0+ (1.4.0+ for communities). The bot is a Nostr key, found in this order:

1. the account file (`accountFile`, default `vector-bot-account.json`; create one
   with `npx vector-bot create`)
2. the `tokenEnv` variable, then `VECTOR_NSEC` / `VECTOR_PRIVATE_KEY` /
   `NOSTR_PRIVATE_KEY` / `NSEC` (nsec or hex)
3. a seed phrase in `VECTOR_MNEMONIC` / `NOSTR_MNEMONIC`
4. with `"createAccount": true`, a new key is generated and saved to the account
   file on first run (don't use this in Docker unless that file is on a volume,
   or the bot gets a new identity on every rebuild)

The account file is gitignored. A Vector `channelId` is one of:

- `community:<communityId>/<channel>`: a channel in a Vector community, where
  `<channel>` is the channel's name (`general`) or id. Needs SDK 1.4.0+.
- an `npub…` or hex pubkey: relays with that user over private DMs
- `group:<groupId>`: a legacy Vector MLS group. Set `VECTOR_MLS_SIDECAR_BIN` to
  the compiled MLS sidecar (`mlsSidecarBinEnv` in the definition)

```json
"vector-main": {
  "type": "vector",
  "displayName": "Vector",
  "tokenEnv": "VECTOR_PRIVATE_KEY",
  "relaysEnv": "VECTOR_RELAYS",
  "acceptInvitesFrom": ["npub1...your-npub"],
  "profile": { "name": "relaybot", "displayName": "Relay Bot" }
}
```

#### Adding the bot to a Vector community

1. Put your npub in `acceptInvitesFrom`. Invites from anyone else are logged
   and left waiting, the way Vector itself asks for consent.
2. In Vector, invite the bot's npub to the community (it's printed at startup).
3. The bot accepts, announces its join once, and logs each channel it can use:
   `Community channel available: community:<id>/general`. Copy that into
   `relays.json`.

The community's keys are kept in `vector-bot-communities.json` (gitignored;
treat it like the account key). Not supported yet: channels created after the
invite, the community banlist, and key rotations (after a ban, the bot needs a
fresh invite).

Vector attachments (screenshots, GIFs, files) are end-to-end encrypted, so the
bot downloads and decrypts them and uploads the file itself to Discord, GameVox
(bot or webhook) and Stoat. Files over `maxAttachmentBytes` (default 10 MB,
Discord's bot limit) are named in the text instead. Sending files *into*
Vector isn't supported yet: those show as `[image: name]`, and files with a
public link (Discord's) arrive as that link.

### Matrix

Uses [`matrix-bot-sdk`](https://github.com/turt2live/matrix-bot-sdk), with
end-to-end encryption on (Element encrypts private rooms by default). A Matrix
channel is a **room**: `channelId` is its id (`!abc:server`) or an alias
(`#general:server`). A Discord-style server is a Matrix **Space**; each of its
rooms is relayed separately, so add one entry per room.

```json
"matrix-main": {
  "type": "matrix",
  "displayName": "Matrix",
  "homeserverUrl": "https://matrix.nekosunevr.co.uk",
  "tokenEnv": "MATRIX_ACCESS_TOKEN",
  "userEnv": "MATRIX_USER",
  "passwordEnv": "MATRIX_PASSWORD",
  "acceptInvitesFrom": ["@you:nekosunevr.co.uk"]
}
```

Setup:

1. Create a user for the bot on your homeserver (Element's sign-up, or
   `register_new_matrix_user` on Synapse).
2. Put its username and password in `.env` (`MATRIX_USER`, `MATRIX_PASSWORD`).
   The first start logs in and saves the session to `matrix-bot-session.json`,
   so later starts reuse the same device. Or set `MATRIX_ACCESS_TOKEN` instead.
3. Invite the bot to each room. It joins invites from `acceptInvitesFrom`
   (or from anyone when that's not set) and logs `Room available: !id (#alias, Name)`.
4. Put the room id or alias in `relays.json`.

Images and files are relayed both ways (decrypted/encrypted as the room
requires). `matrix-bot-session.json`, `matrix-bot-storage.json` and
`matrix-crypto/` hold the bot's login and encryption keys and are gitignored;
keep `matrix-crypto/` between restarts, or the bot becomes a new device and
can't read older encrypted messages. Set `"encryption": false` for
unencrypted rooms only, and `"noticeMessages": true` to post as `m.notice`.

### Root

Uses [`@rootsdk/server-bot`](https://docs.rootapp.com/docs/bot-docs/bot-home/).
Root bots do **not** log in with a token: Root's host launches the process and
injects the community connection. That means when Root is in the config, the
whole relay runs as the Root bot:

- **Local testing:** put your `DEV_TOKEN` in `.env`, set the bot `id` in
  `root-manifest.json`, then run `npm run root:dev` (instead of `npm start`).
- **Production:** Root bots must be hosted in Root's cloud (upload with
  `rootsdk`). Outbound connections to Discord/Stoat/Vector are allowed there.

One Root community per process, so configure at most one `rootapp` platform.
`channelId` is a Root channel GUID. Running `npm start` with a `rootapp` platform
configured fails at startup with a message explaining this.

```json
"rootapp-main": { "type": "rootapp", "displayName": "Root" }
```

Bot permissions (`createMessage`, `viewMessageHistory`) are declared in
`root-manifest.json`.

### Receiving messages from GameVox

The GameVox gateway remains the primary receive path. The bot requests
`Guilds`, `GuildMessages`, and the privileged `MessageContent` intent, matching
GameVox's current discord.js setup.

In the GameVox Developer Portal, open the application's **Bot** tab and make sure
**Message Content Intent** is enabled. GameVox documents that `GUILD_MESSAGES`
delivers `MESSAGE_CREATE`, while `MESSAGE_CONTENT` adds the message text and
attachments.

The adapter also keeps a small REST polling safety net for configured GameVox
channels. It establishes a cursor at startup so old history is not replayed, then
checks for newer messages every 5 seconds by default. Native gateway events are
still delivered immediately; message IDs are deduplicated so the same message is
not relayed twice.

You can tune the fallback interval per GameVox platform:

```json
"gamevox-main": {
  "type": "gamevox",
  "displayName": "GameVox",
  "tokenEnv": "GAMEVOX_BOT_TOKEN",
  "incomingPollIntervalMs": 5000
}
```

If the REST fallback logs a permission error, give the bot **View Channel** and
**Read Message History** for that GameVox channel.

### GameVox webhook fallback

GameVox always uses the full bot integration first: gateway events, bot channel
lookup and normal bot sends. A configured webhook is only a fallback for a send
that fails with a permission/access error such as `403 Missing Permissions`.

This means you can leave the webhook configured permanently. If GameVox restores
normal bot channel permissions, the next message automatically goes through the
bot API again and the webhook is not used.

1. GameVox developer portal -> your application -> **Webhooks** -> **New Webhook**,
   pick the relay channel, copy the URL.
2. Put it in `.env`: `GAMEVOX_WEBHOOK_URL=https://api.gamevox.com/webhooks/...`
3. Map that webhook to the affected channel:

```json
"gamevox-main": {
  "type": "gamevox",
  "displayName": "GameVox",
  "tokenEnv": "GAMEVOX_BOT_TOKEN",
  "webhookEnvs": { "1553735658507157504": "GAMEVOX_WEBHOOK_URL" }
}
```

The fallback is **not** used for general connection failures, invalid tokens,
rate limits, server errors or other non-permission problems; those errors remain
visible instead of being hidden by a webhook. Webhook posts are ignored by the
relay loop prevention logic.

## Example relayed messages

A Discord message:

```text
Hello!
```

becomes:

```text
[Discord] NekoSuneVR: Hello!
```

A GameVox message becomes:

```text
[GameVox] ExampleUser: Hello back!
```

This makes the original platform obvious when several platforms share one relay.

---

# Relay groups

Instead of having one hard-coded Discord channel and one hard-coded GameVox
channel, relays are configured as groups.

Example:

```json
{
  "id": "community-chat",
  "name": "Community Chat",
  "channels": [
    {
      "platform": "discord-main",
      "channelId": "111111111111111111"
    },
    {
      "platform": "gamevox-main",
      "channelId": "222222222222222222"
    }
  ]
}
```

Anything posted in either channel gets sent to every other channel in that
relay group.

The same group can span every platform:

```json
{
  "id": "community-chat",
  "name": "Community Chat",
  "channels": [
    {
      "platform": "discord-main",
      "channelId": "111111111111111111"
    },
    {
      "platform": "gamevox-main",
      "channelId": "222222222222222222"
    },
    {
      "platform": "fluxer-main",
      "channelId": "333333333333333333"
    },
    {
      "platform": "matrix-main",
      "channelId": "#general:example.org"
    },
    {
      "platform": "rootapp-main",
      "channelId": "root-chat-id"
    },
    {
      "platform": "vectorapp-main",
      "channelId": "group:vector-group-id"
    },
    {
      "platform": "stoat-main",
      "channelId": "stoat-channel-id"
    }
  ]
}
```

Adapters can also implement `normalizeChannelId()` when one channel has several
spellings (Vector accepts both `npub…` and hex).

---

# Disabling platforms

A platform is skipped (not fatal) when its credentials are blank, so you can
keep every platform in `relays.json` and turn them on by filling in `.env`:

| Platform | Disabled when |
| --- | --- |
| Discord / GameVox / Fluxer / Stoat | its `tokenEnv` is blank |
| Matrix | access token is blank and no username/password login is configured |
| Vector | no account file, and every key/seed env var is blank (unless `createAccount`) |
| Root | not launched by Root's host (`npm run root:dev` or Root cloud) |

Set `"enabled": false` on a platform to turn it off regardless. Channels on a
disabled platform are removed from their relay groups at startup, and startup
logs which platforms were skipped and why.

# Platform definitions

Platforms are declared separately from relay groups.

```json
"platforms": {
  "discord-main": {
    "type": "discord",
    "displayName": "Discord",
    "tokenEnv": "DISCORD_BOT_TOKEN"
  },
  "gamevox-main": {
    "type": "gamevox",
    "displayName": "GameVox",
    "tokenEnv": "GAMEVOX_BOT_TOKEN"
  },
  "fluxer-main": {
    "type": "fluxer",
    "displayName": "Fluxer",
    "tokenEnv": "FLUXER_BOT_TOKEN",
    "apiUrlEnv": "FLUXER_API_URL"
  }
}
```

The key (`discord-main`) is an internal connection ID.

`displayName` is what users see in relayed messages.

This means you can even run multiple accounts/connections for the same
platform later, for example:

```json
"discord-main": {
  "type": "discord",
  "displayName": "Discord",
  "tokenEnv": "DISCORD_BOT_TOKEN"
},
"discord-staff": {
  "type": "discord",
  "displayName": "Discord Staff",
  "tokenEnv": "DISCORD_STAFF_BOT_TOKEN"
}
```

---

# Install

Requires Node.js 22.15+. This also satisfies Fluxer.js 3.x, which requires Node.js 22.13+.

```bash
npm install
```

Copy the environment file:

```bash
cp .env.example .env
```

On Windows CMD:

```bat
copy .env.example .env
```

Copy the relay configuration:

```bash
cp config/relays.example.json config/relays.json
```

On Windows CMD:

```bat
copy config\relays.example.json config\relays.json
```

Add your tokens to `.env` and channel IDs to `config/relays.json`.

Run:

```bash
npm start
```

---

# Docker

```bash
docker compose up -d --build
```

Logs:

```bash
docker compose logs -f
```

---

# Adapter architecture

Each platform adapter implements a small common interface:

```text
connect()
getChannel()
onMessage()
sendMessage()
isOwnMessage()
normalizeMessage()
destroy()
```

Because of that, Fluxer, Matrix, or another platform can be added without modifying the central relay engine.

A platform-specific adapter only needs to convert that platform's message
format into the relay's normalized structure:

```js
{
  id,
  channelId,

  author: {
    id,
    username,
    displayName,
    avatarUrl,
    isBot
  },

  content,
  attachments,
  webhookId
}
```

The relay engine then forwards it to every destination in the selected relay
group.

---

# Current limitations

The current adapters relay:

- text
- attachment URLs
- uploaded files where the destination adapter supports them
- source platform
- username/display name
- avatar metadata used by supported destinations

They currently do not synchronize:

- message edits
- message deletion
- replies
- reactions
- native embeds
- stickers
- threads
- voice

The architecture is now ready for these to be added later.
