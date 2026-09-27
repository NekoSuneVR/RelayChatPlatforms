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

for (const [id, definition] of Object.entries(config.platforms)) {
  adapters.set(id, createAdapter(id, definition));
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
        console.error(
          `[config] ${group.id}: ${adapter.displayName} channel ${entry.channelId} failed:`,
          error.message
        );
      }
    }
  }
}

async function start() {
  try {
    for (const adapter of adapters.values()) {
      await adapter.connect();
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
