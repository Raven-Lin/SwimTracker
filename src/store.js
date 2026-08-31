/* ============================================================================
   SwimTracker — Persistence
   ============================================================================

   The app has no server, so "your data" means "data in this browser". That
   makes storage a correctness problem rather than a convenience:

   * A 150-swimmer squad is roughly 3–5 MB of CSV. localStorage caps out
     around 5 MB and throws QuotaExceededError when it fills, so IndexedDB is
     the primary store and localStorage is only a fallback for small squads.
   * Storage can be unavailable entirely — a file:// page in some browsers,
     Safari private mode, or a locked-down school laptop. Every path degrades
     to in-memory instead of throwing, and `lastError` lets the UI tell the
     coach plainly that their data will not survive a refresh, rather than
     silently losing a morning's work.

   Nothing here ever leaves the machine.
============================================================================ */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.STStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DB_NAME = 'swimtracker';
  const DB_VERSION = 1;
  const STORE = 'kv';
  const LS_PREFIX = 'swimtracker:';
  const LS_MAX_BYTES = 4 * 1024 * 1024; // leave headroom under the ~5MB cap

  let memory = new Map();
  let dbPromise = null;
  let mode = 'unknown';   // 'idb' | 'local' | 'memory'
  let lastError = null;

  function hasIDB() {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; }
    catch (_) { return false; }
  }

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!hasIDB()) { reject(new Error('IndexedDB unavailable')); return; }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { reject(e); return; }

      // A blocked or hung open must not leave the UI waiting forever.
      const timer = setTimeout(() => reject(new Error('IndexedDB open timed out')), 4000);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
      req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('IndexedDB open failed')); };
      req.onblocked = () => { clearTimeout(timer); reject(new Error('IndexedDB blocked')); };
    }).catch(err => { dbPromise = null; throw err; });
    return dbPromise;
  }

  function idbRequest(storeMode, fn) {
    return openDB().then(db => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE, storeMode); }
      catch (e) { reject(e); return; }
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
    }));
  }

  function lsAvailable() {
    try {
      const k = LS_PREFIX + '__probe';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (_) { return false; }
  }

  /** Store a value. Resolves to the mode actually used. */
  function set(key, value) {
    memory.set(key, value);
    const json = JSON.stringify(value);

    return idbRequest('readwrite', s => s.put(json, key))
      .then(() => { mode = 'idb'; lastError = null; return 'idb'; })
      .catch(idbErr => {
        // Fall back to localStorage, but only if the payload plausibly fits.
        if (json.length > LS_MAX_BYTES) {
          mode = 'memory';
          lastError = 'This squad is too large for fallback storage and ' +
                      'IndexedDB is not available. Data will be lost on refresh — ' +
                      'export a CSV before closing.';
          return 'memory';
        }
        try {
          if (!lsAvailable()) throw idbErr;
          localStorage.setItem(LS_PREFIX + key, json);
          mode = 'local'; lastError = null;
          return 'local';
        } catch (lsErr) {
          mode = 'memory';
          lastError = (lsErr && lsErr.name === 'QuotaExceededError')
            ? 'Browser storage is full. Data will be lost on refresh — export a CSV.'
            : 'Browser storage is unavailable. Data will be lost on refresh — export a CSV.';
          return 'memory';
        }
      });
  }

  /** Read a value back, or `fallback` when absent. */
  function get(key, fallback) {
    return idbRequest('readonly', s => s.get(key))
      .then(json => {
        if (json === undefined || json === null) throw new Error('miss');
        mode = 'idb';
        return JSON.parse(json);
      })
      .catch(() => {
        try {
          const json = localStorage.getItem(LS_PREFIX + key);
          if (json !== null) { mode = 'local'; return JSON.parse(json); }
        } catch (_) { /* storage unavailable */ }
        if (memory.has(key)) return memory.get(key);
        return fallback;
      })
      .catch(() => fallback);
  }

  function remove(key) {
    memory.delete(key);
    try { localStorage.removeItem(LS_PREFIX + key); } catch (_) {}
    return idbRequest('readwrite', s => s.delete(key)).catch(() => undefined);
  }

  function clear() {
    memory = new Map();
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf(LS_PREFIX) === 0) localStorage.removeItem(k);
      }
    } catch (_) {}
    return idbRequest('readwrite', s => s.clear()).catch(() => undefined);
  }

  function status() {
    return { mode, lastError };
  }

  return { get, set, remove, clear, status };
});
