# Multi-Platform Chat Relay

A platform-aware Node.js relay designed to bridge chat between:

- Discord
- GameVox
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

### Sending through a webhook (GameVox workaround)

GameVox currently refuses bots on channel endpoints (`403 Missing Permissions`)
even when the bot has admin, so direct sends fail. A channel webhook avoids this:

1. GameVox developer portal -> your application -> **Webhooks** -> **New Webhook**,
   pick the relay channel, copy the URL.
2. Put it in `.env`: `GAMEVOX_WEBHOOK_URL=https://api.gamevox.com/webhooks/...`
3. Map the channel to that variable on the platform:

```json
"gamevox-main": {
  "type": "gamevox",
  "displayName": "GameVox",
  "tokenEnv": "GAMEVOX_BOT_TOKEN",
  "webhookEnvs": { "1553735658507157504": "GAMEVOX_WEBHOOK_URL" }
}
```

Webhook posts appear as the bot, so they are not relayed back. The same option
works for Discord channels.

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
| Discord / GameVox / Stoat | its `tokenEnv` is blank |
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

Requires Node.js 22.15+ (`stoat.js` is ESM-only and needs it).

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

Because of that, Matrix or another platform can be added without modifying the central relay engine.

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
- source platform
- display name

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
