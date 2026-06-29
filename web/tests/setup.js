import "fake-indexeddb/auto";

class FakeAudio {
  constructor() {
    this.playbackRate = 1;
    this.paused = true;
    this.onloadedmetadata = null;
    this.onended = null;
    this.onerror = null;
  }

  get duration() { return 0.25; }

  play() {
    this.paused = false;
    if (this.onloadedmetadata) this.onloadedmetadata();
    setTimeout(() => { if (this.onended) this.onended(); }, 15);
    return Promise.resolve();
  }

  pause() { this.paused = true; }
}

globalThis.Audio = FakeAudio;
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => "blob:test";
}
if (!globalThis.URL.revokeObjectURL) {
  globalThis.URL.revokeObjectURL = () => {};
}
