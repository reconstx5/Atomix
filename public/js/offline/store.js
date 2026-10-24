// Downloads kept on this device (v0.21): the files in the browser's private storage (OPFS) and a small index in
// IndexedDB — per profile, so two profiles on one device each see only their own. Also kept here: progress made
// offline (sent when back online) and the account's profiles for "Who's watching?" with no connection (PINs as a
// salted PBKDF2 hash).
const DB_NAME = 'atomix';
const DIR = 'atomix-downloads';
const PBKDF2_ROUNDS = 100_000;

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function openDb() {
  const r = indexedDB.open(DB_NAME, 1);
  r.onupgradeneeded = () => {
    const db = r.result;
    db.createObjectStore('downloads', { keyPath: ['profileId', 'itemId'] });
    db.createObjectStore('pending', { autoIncrement: true });
    db.createObjectStore('profiles', { keyPath: 'id' });
  };
  return req(r);
}
const nameFor = (itemId, ext) => `${itemId}.${ext}`;

async function folder(profileId, create = false) {
  const root = await navigator.storage.getDirectory();
  try {
    return await (await root.getDirectoryHandle(DIR, { create })).getDirectoryHandle(String(profileId), { create });
  } catch {
    return null;
  }
}

let writer = null;
let seq = 0;
const waiting = new Map();
function worker() {
  if (writer !== null) return writer;
  try {
    writer = new Worker('/js/offline/writer-worker.js');
    writer.onmessage = ({ data }) => {
      const w = waiting.get(data.id);
      waiting.delete(data.id);
      if (!w) return;
      if (data.ok) w.resolve(data.n);
      else w.reject(Object.assign(new Error(data.message), { name: data.name }));
    };
  } catch {
    writer = false;
  }
  return writer;
}
const ask = (msg, transfer = []) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    worker().postMessage({ ...msg, id }, transfer);
  });

async function hash(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ROUNDS }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function openStore() {
  const db = await openDb();
  const tx = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);
  return {
    async list(profileId) {
      const all = await req(tx('downloads').getAll(IDBKeyRange.bound([Number(profileId), -Infinity], [Number(profileId), Infinity])));
      return all.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    },
    /** Every profile's entries (the expiry check and the offline boot look at all of them). */
    all: () => req(tx('downloads').getAll()),
    get: (profileId, itemId) => req(tx('downloads').get([Number(profileId), Number(itemId)])),
    /** Change some fields of an entry in one transaction (several things update the same download at once). `changes`
     *  may be a function of the stored entry (null leaves it as it is); the result is the entry as stored. */
    patch(profileId, itemId, changes) {
      return new Promise((resolve, reject) => {
        const t = db.transaction('downloads', 'readwrite');
        const os = t.objectStore('downloads');
        const g = os.get([Number(profileId), Number(itemId)]);
        let next = null;
        g.onsuccess = () => {
          if (!g.result) return;
          const ch = typeof changes === 'function' ? changes(g.result) : changes;
          next = ch ? { ...g.result, ...ch } : g.result;
          if (ch) os.put(next);
        };
        t.oncomplete = () => resolve(next);
        t.onerror = () => reject(t.error);
      });
    },
    put: (entry) => req(tx('downloads', 'readwrite').put({ addedAt: Date.now(), ...entry, profileId: Number(entry.profileId), itemId: Number(entry.itemId) })),
    /** A download's files (the video or song and its subtitles), keeping its entry. */
    async removeFiles(profileId, itemId) {
      const entry = await this.get(profileId, itemId);
      const dir = await folder(profileId);
      if (!dir) return;
      if (writer) await ask({ op: 'close', profileId, name: nameFor(itemId, entry?.ext || 'bin') }).catch(() => {});
      const names = [];
      for await (const name of dir.keys()) if (name === `${itemId}` || name.startsWith(`${itemId}.`)) names.push(name);
      for (const name of names) await dir.removeEntry(name).catch(() => {});
    },
    async remove(profileId, itemId) {
      await this.removeFiles(profileId, itemId);
      await req(tx('downloads', 'readwrite').delete([Number(profileId), Number(itemId)]));
    },
    /** Everything this device keeps for Atomix (signing out): downloads, their files, offline progress, profiles. */
    async clearAll() {
      for (const e of await this.all()) await this.remove(e.profileId, e.itemId);
      await req(tx('pending', 'readwrite').clear());
      await req(tx('profiles', 'readwrite').clear());
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(DIR, { recursive: true }).catch(() => {});
    },
    /** Write a piece at its byte offset (a worker's sync handle; a page writable where workers can't). */
    async writeAt(profileId, itemId, ext, offset, bytes) {
      const name = nameFor(itemId, ext);
      if (worker()) return ask({ op: 'write', profileId, name, offset, buffer: bytes }, [bytes]);
      const dir = await folder(profileId, true);
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable({ keepExistingData: true });
      await w.write({ type: 'write', position: offset, data: bytes });
      await w.close();
      return bytes.byteLength;
    },
    /** A whole small file (subtitles, the poster) — through the writer worker where a page can't write a file. */
    async writeFile(profileId, name, blob) {
      if (typeof FileSystemFileHandle !== 'undefined' && !FileSystemFileHandle.prototype.createWritable && worker()) {
        await ask({ op: 'write', profileId, name, offset: 0, whole: true, buffer: await blob.arrayBuffer() });
        await ask({ op: 'close', profileId, name });
        return;
      }
      const dir = await folder(profileId, true);
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await w.write(blob);
      await w.close();
    },
    async closeFile(profileId, itemId, ext) {
      if (writer) await ask({ op: 'close', profileId, name: nameFor(itemId, ext) }).catch(() => {});
    },
    async bytesOnDisk(profileId, itemId, ext) {
      const dir = await folder(profileId);
      if (!dir) return 0;
      try {
        await this.closeFile(profileId, itemId, ext); // a handle open in the worker locks the file for reading
        return (await (await dir.getFileHandle(nameFor(itemId, ext))).getFile()).size;
      } catch {
        return 0;
      }
    },
    fileUrl: (entry, name = nameFor(entry.itemId, entry.ext)) => `/offline/${entry.profileId}/${encodeURIComponent(name)}`,
    async usage() {
      let used = 0;
      for (const e of await this.all()) used += e.bytes || e.size || 0;
      const est = (await navigator.storage.estimate?.()) || {};
      return { used, quota: est.quota ?? null };
    },
    /** Offline progress, one row per profile and title: a newer report replaces the older (v0.22). */
    async queueProgress(p) {
      const store = tx('pending', 'readwrite');
      const [keys, values] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
      values.forEach((v, i) => v.profileId === p.profileId && v.itemId === p.itemId && store.delete(keys[i]));
      return req(store.add({ ...p }));
    },
    async pendingProgress() {
      const store = tx('pending');
      const [keys, values] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
      return values.map((v, i) => ({ ...v, key: keys[i] }));
    },
    async clearProgress(keys) {
      const store = tx('pending', 'readwrite');
      await Promise.all(keys.map((k) => req(store.delete(k))));
    },
    async keepProfiles(list) {
      // Kept hashes stay for profiles that still have the same PIN (its stamp, v0.22); a profile gone from the account goes.
      const old = new Map((await req(tx('profiles').getAll())).map((p) => [p.id, p]));
      const store = tx('profiles', 'readwrite');
      store.clear();
      await Promise.all(
        list.map((p) => {
          const was = old.get(p.id);
          const same = p.hasPin && was?.pinHash && (was.pinStamp ?? null) === (p.pinStamp ?? null);
          return req(store.put({ ...was, ...p, ...(same ? {} : { pinHash: null, pinSalt: null }) }));
        }),
      );
      // A profile gone from the account takes its downloads with it (nobody can see or remove them otherwise).
      const ids = new Set(list.map((p) => Number(p.id)));
      for (const e of await this.all()) if (!ids.has(Number(e.profileId))) await this.remove(e.profileId, e.itemId);
    },
    keptProfiles: () => req(tx('profiles').getAll()),
    async setPinHash(profileId, pin) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const pinHash = await hash(pin, salt);
      const prev = (await req(tx('profiles').get(Number(profileId)))) || { id: Number(profileId) };
      await req(tx('profiles', 'readwrite').put({ ...prev, pinSalt: [...salt], pinHash, pinFails: 0, pinWait: 0, pinUntil: 0 }));
    },
    /** Offline PIN tries (v0.22): how long this profile must wait (ms), kept with it so a reload doesn't reset it. */
    async pinWaitLeft(profileId, now = Date.now()) {
      const p = await req(tx('profiles').get(Number(profileId)));
      return Math.max(0, (p?.pinUntil || 0) - now);
    },
    /** A wrong PIN: after 5, a wait of 30 s, doubling with each wrong try after it, to at most 8 minutes. */
    async pinFailed(profileId, now = Date.now()) {
      const p = (await req(tx('profiles').get(Number(profileId)))) || { id: Number(profileId) };
      const fails = (p.pinFails || 0) + 1;
      const wait = fails < 5 ? 0 : Math.min(8 * 60_000, p.pinWait ? p.pinWait * 2 : 30_000);
      await req(tx('profiles', 'readwrite').put({ ...p, pinFails: fails, pinWait: wait || p.pinWait || 0, pinUntil: wait ? now + wait : 0 }));
      return wait;
    },
    async pinPassed(profileId) {
      const p = await req(tx('profiles').get(Number(profileId)));
      if (p) await req(tx('profiles', 'readwrite').put({ ...p, pinFails: 0, pinWait: 0, pinUntil: 0 }));
    },
    async checkPin(profileId, pin) {
      const p = await req(tx('profiles').get(Number(profileId)));
      if (!p?.pinHash || !p.pinSalt) return false;
      return (await hash(pin, new Uint8Array(p.pinSalt))) === p.pinHash;
    },
  };
}
