const DiscordLikeAdapter = require('./discordLike');

class DiscordAdapter extends DiscordLikeAdapter {
  constructor(definition) {
    super(definition);
  }
}

module.exports = DiscordAdapter;
