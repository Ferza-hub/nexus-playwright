'use strict';

class Semaphore {
  constructor(n) { this._n = n; this._q = []; }
  acquire() {
    if (this._n > 0) { this._n--; return Promise.resolve(); }
    return new Promise(r => this._q.push(r));
  }
  release() {
    const r = this._q.shift();
    if (r) r(); else this._n++;
  }
}

const MAX = parseInt(process.env.MAX_CONCURRENT_BROWSERS ?? '8', 10);
module.exports = new Semaphore(MAX);
