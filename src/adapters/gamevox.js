const DiscordLikeAdapter = require('./discordLike');

class GameVoxAdapter extends DiscordLikeAdapter {
  constructor(definition) {
    super(definition, {
      rest: {
        api: 'https://bot-api.gamevox.com/api',
      },
      ws: {
        gatewayURL: 'wss://gateway.gamevox.com',
      },
    });
  }
}

module.exports = GameVoxAdapter;
