class BaseAdapter {
  constructor(definition) {
    this.definition = definition;
    this.id = definition.id;
    this.type = definition.type;
    this.displayName = definition.displayName || definition.type;
  }

  async connect() {
    throw new Error(`connect() not implemented for ${this.type}`);
  }

  async getChannel(_channelId) {
    throw new Error(`getChannel() not implemented for ${this.type}`);
  }

  onMessage(_handler) {
    throw new Error(`onMessage() not implemented for ${this.type}`);
  }

  async sendMessage(_channelId, _payload) {
    throw new Error(`sendMessage() not implemented for ${this.type}`);
  }

  normalizeChannelId(channelId) {
    return String(channelId);
  }

  isOwnMessage(_message) {
    return false;
  }

  normalizeMessage(_message) {
    throw new Error(`normalizeMessage() not implemented for ${this.type}`);
  }

  async destroy() {}
}

module.exports = BaseAdapter;
