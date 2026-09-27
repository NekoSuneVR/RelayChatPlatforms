class BaseAdapter {
  constructor(definition) {
    this.definition = definition;
    this.id = definition.id;
    this.type = definition.type;
    this.displayName = definition.displayName || definition.type;
  }

  // Returns why this platform can't run with the current environment, or null.
  // Checked before connect(); a disabled platform is skipped, not fatal.
  getDisabledReason() {
    const { tokenEnv } = this.definition;

    if (tokenEnv && !process.env[tokenEnv]?.trim()) {
      return `${tokenEnv} is blank`;
    }

    return null;
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

  // How well this target takes file uploads: 2 = reliably, 1 = maybe (not yet
  // known), 0 = can't. The engine sends to better uploaders first, so their
  // hosted copies can be linked for the rest.
  fileUploadSupport(_channelId) {
    return 0;
  }

  // Public URLs of the files a sent message carries, when this platform hosts them.
  hostedFileUrls(_sent) {
    return [];
  }

  // For targets that can't upload files: link each file when another platform
  // already hosts a copy (payload.fileUrls), or name it in the text.
  withFileNotes(payload) {
    if (!payload.files?.length) {
      return payload.content;
    }

    const notes = payload.files.map((file, index) =>
      payload.fileUrls?.[index] ||
      `[${file.contentType?.startsWith('image/') ? 'image' : 'file'}: ${file.name}]`
    );

    return [payload.content, ...notes].join('\n');
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
