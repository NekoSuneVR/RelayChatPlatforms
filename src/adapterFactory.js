const DiscordAdapter = require('./adapters/discord');
const GameVoxAdapter = require('./adapters/gamevox');
const UnsupportedAdapter = require('./adapters/unsupported');

function createAdapter(id, definition) {
  const fullDefinition = {
    id,
    ...definition,
  };

  switch (definition.type) {
    case 'discord':
      return new DiscordAdapter(fullDefinition);

    case 'gamevox':
      return new GameVoxAdapter(fullDefinition);

    // Future:
    // case 'rootapp':
    //   return new RootAppAdapter(fullDefinition);
    //
    // case 'vectorapp':
    //   return new VectorAppAdapter(fullDefinition);
    //
    // case 'stoat':
    //   return new StoatAdapter(fullDefinition);

    default:
      return new UnsupportedAdapter(fullDefinition);
  }
}

module.exports = {
  createAdapter,
};
