# Multi-Platform Chat Relay

A platform-aware Node.js relay designed to bridge chat between:

- Discord
- GameVox
- RootApp *(future adapter)*
- VectorApp *(future adapter)*
- Stoat *(future adapter)*
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

Later, once adapters exist, the same group could simply become:

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
      "channelId": "vector-group-id"
    },
    {
      "platform": "stoat-main",
      "channelId": "stoat-channel-id"
    }
  ]
}
```

The relay engine itself does not need to change.

---

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

Requires Node.js 20+.

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

Because of that, RootApp, VectorApp, Stoat, Matrix, Revolt or another platform
can be added without modifying the central relay engine.

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
