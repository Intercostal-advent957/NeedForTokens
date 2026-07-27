/**
 * Tiny synchronous pub/sub. Zero allocation on emit for the common case.
 * See CONTRACTS.md §2 for the canonical event list.
 */
export class EventBus {
  constructor() {
    this._map = new Map();
    this._depth = 0;
    this._pendingRemovals = null;
  }

  on(name, fn) {
    let list = this._map.get(name);
    if (!list) this._map.set(name, (list = []));
    list.push(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const un = this.on(name, (p) => {
      un();
      fn(p);
    });
    return un;
  }

  off(name, fn) {
    const list = this._map.get(name);
    if (!list) return;
    if (this._depth > 0) {
      (this._pendingRemovals ||= []).push([name, fn]);
      return;
    }
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(name, payload) {
    const list = this._map.get(name);
    if (!list || list.length === 0) return;
    this._depth++;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (err) {
        console.error(`[bus] handler for "${name}" threw:`, err);
      }
    }
    this._depth--;
    if (this._depth === 0 && this._pendingRemovals) {
      for (const [n, f] of this._pendingRemovals) this.off(n, f);
      this._pendingRemovals = null;
    }
  }

  clear() {
    this._map.clear();
  }
}
