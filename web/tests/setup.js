import "fake-indexeddb/auto";

class FakeAudio {
  constructor() {
    this.playbackRate = 1;
    this.paused = true;
    this.currentTime = 0;
    this.onloadedmetadata = null;
    this.onended = null;
    this.onerror = null;
    this.onwaiting = null;
    this.onplaying = null;
    this._endTimer = null;
    // Test-only hook: sharedAudioSource.js's audioEl singleton isn't exported,
    // so tests exercising real onwaiting/onplaying wiring (buffering state)
    // need some way to reach the actual instance it created.
    globalThis.__lastFakeAudio = this;
  }

  get duration() { return 0.25; }

  play() {
    this.paused = false;
    if (this.onloadedmetadata) this.onloadedmetadata();
    if (this._endTimer) clearTimeout(this._endTimer);
    this._endTimer = setTimeout(() => { this._endTimer = null; if (this.onended) this.onended(); }, 15);
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    if (this._endTimer) { clearTimeout(this._endTimer); this._endTimer = null; }
  }
}

globalThis.Audio = FakeAudio;
if (!globalThis.URL.createObjectURL) {
  globalThis.URL.createObjectURL = () => "blob:test";
}
if (!globalThis.URL.revokeObjectURL) {
  globalThis.URL.revokeObjectURL = () => {};
}
