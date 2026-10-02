const DiscordAdapter = require('./adapters/discord');
const GameVoxAdapter = require('./adapters/gamevox');
const FluxerAdapter = require('./adapters/fluxer');
const MatrixAdapter = require('./adapters/matrix');
const RootAppAdapter = require('./adapters/rootapp');
const StoatAdapter = require('./adapters/stoat');
const VectorAdapter = require('./adapters/vector');
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

    case 'fluxer':
      return new FluxerAdapter(fullDefinition);

    case 'matrix':
      return new MatrixAdapter(fullDefinition);

    case 'rootapp':
      return new RootAppAdapter(fullDefinition);

    case 'vector':
    case 'vectorapp':
      return new VectorAdapter(fullDefinition);

    case 'stoat':
      return new StoatAdapter(fullDefinition);

    default:
      return new UnsupportedAdapter(fullDefinition);
  }
}

module.exports = {
  createAdapter,
};
