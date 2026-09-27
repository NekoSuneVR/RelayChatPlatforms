const BaseAdapter = require('./base');

class UnsupportedAdapter extends BaseAdapter {
  async connect() {
    throw new Error(
      `${this.displayName}: adapter type "${this.type}" exists in config but is not implemented yet`
    );
  }
}

module.exports = UnsupportedAdapter;
