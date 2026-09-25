export class SnapshotGate {
  constructor() {
    this.ready = false;
    this.pending = false;
    this.key = "";
    this.failedKey = "";
    this.retryAt = 0;
    this.failures = 0;
  }
  activate() {
    this.ready = true;
    this.invalidate();
  }
  invalidate() {
    this.key = "";
    this.failedKey = "";
    this.retryAt = 0;
    this.failures = 0;
  }
  begin(key, now = Date.now()) {
    if (
      !this.ready ||
      this.pending ||
      this.key === key ||
      (this.failedKey === key && now < this.retryAt)
    )
      return false;
    if (this.failedKey !== key) {
      this.failures = 0;
      this.retryAt = 0;
    }
    this.key = key;
    this.pending = true;
    return true;
  }
  success() {
    this.pending = false;
    this.failedKey = "";
    this.retryAt = 0;
    this.failures = 0;
  }
  cancel() {
    this.pending = false;
    this.invalidate();
  }
  fail(terminal, now = Date.now()) {
    this.pending = false;
    this.failedKey = this.key;
    if (!terminal) {
      this.key = "";
      this.retryAt = now + Math.min(30000, 1000 * 2 ** this.failures++);
    }
  }
}
