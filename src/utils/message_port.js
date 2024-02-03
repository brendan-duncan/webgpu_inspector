export class MessagePort {
  constructor(name, tabId, listener) {
    this.name = name;
    this.tabId = tabId ?? 0;
    this.listeners = [];
    if (listener) {
      this.listeners.push(listener);
    }
    this._port = null;
    this.reset();
  }

  reset() {
    const self = this;
    this._port = chrome.runtime.connect({ name: this.name });
    this._port.onDisconnect.addListener(() => {
      self.reset();
    });
    this._port.onMessage.addListener((message) => {
      for (const listener of self.listeners) {
        listener(message);
      }
    });
  }

  addListener(listener) {
    this.listeners.push(listener);
  }

  postMessage(message) {
    if (this.tabId) {
      message.tabId = this.tabId;
    }
    try {
      this._port.postMessage(message);
    } catch (e) {
      this.reset();
    }
  }
}
