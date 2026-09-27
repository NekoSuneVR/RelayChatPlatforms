require('dotenv').config();

const fs = require('fs');
const path = require('path');

const { createAdapter } = require('./adapterFactory');
const RelayEngine = require('./relayEngine');

const configPath = path.resolve(
  process.env.RELAY_CONFIG || './config/relays.json'
);

if (!fs.existsSync(configPath)) {
  console.error(`Relay config was not found: ${configPath}`);
  console.error(
    'Copy config/relays.example.json to config/relays.json and edit it.'
  );
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (!config.platforms || typeof config.platforms !== 'object') {
  console.error('config.platforms is missing or invalid');
  process.exit(1);
}

if (!Array.isArray(config.relayGroups) || !config.relayGroups.length) {
  console.error('config.relayGroups must contain at least one relay group');
  process.exit(1);
}

const adapters = new Map();

const disabledPlatforms = new Set();

for (const [id, definition] of Object.entries(config.platforms)) {
  const adapter = createAdapter(id, definition);
  const reason =
    definition.enabled === false
      ? '"enabled": false in config'
      : adapter.getDisabledReason();

  if (reason) {
    disabledPlatforms.add(id);
    console.log(`[config] ${adapter.displayName} (${id}) disabled: ${reason}`);
    continue;
  }

  adapters.set(id, adapter);
}

if (!adapters.size) {
  console.error('No platforms are enabled; fill in at least one token in .env');
  process.exit(1);
}

// Channels on disabled platforms are dropped so they don't show up as errors.
for (const group of config.relayGroups) {
  group.channels = (group.channels || []).filter(
    entry => !disabledPlatforms.has(entry.platform)
  );

  if (group.channels.length < 2) {
    console.warn(
      `[config] Relay group "${group.id}" has fewer than 2 enabled channels; nothing to relay`
    );
  }
}

const relayEngine = new RelayEngine(config, adapters);
relayEngine.bind();

async function validateConfiguredChannels() {
  for (const group of config.relayGroups) {
    for (const entry of group.channels || []) {
      const adapter = adapters.get(entry.platform);

      if (!adapter) {
        console.warn(
          `[config] Relay group "${group.id}" references unknown platform "${entry.platform}"`
        );
        continue;
      }

      try {
        await adapter.getChannel(entry.channelId);
        console.log(
          `[config] ${group.id}: ${adapter.displayName} channel ${entry.channelId} ready`
        );
      } catch (error) {
        entry.failed = true;
        console.error(
          `[config] ${group.id}: ${adapter.displayName} channel ${entry.channelId} ` +
          `failed and is skipped until restart: ${error.message}`
        );
      }
    }

    // A channel that failed validation would error on every relayed message.
    group.channels = group.channels.filter(entry => !entry.failed);
  }
}

async function start() {
  try {
    for (const adapter of adapters.values()) {
      try {
        await adapter.connect();
      } catch (error) {
        if (/disallowed intents/i.test(error.message)) {
          error.message =
            `${adapter.displayName}: ${error.message}. Enable "Message Content Intent" ` +
            "under Privileged Gateway Intents in this bot's developer portal settings.";
        } else if (!error.message.startsWith(`${adapter.displayName}:`)) {
          error.message = `${adapter.displayName}: ${error.message}`;
        }

        throw error;
      }
    }

    await validateConfiguredChannels();

    console.log(
      `[relay] Ready with ${config.relayGroups.length} relay group(s) across ${adapters.size} platform(s)`
    );
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down...`);

  for (const adapter of adapters.values()) {
    try {
      await adapter.destroy();
    } catch {}
  }

  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

start();
