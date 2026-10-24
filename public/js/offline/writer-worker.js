// Writes download pieces into the device's private storage at their byte offsets (v0.21). A dedicated worker, because
// only workers get the fast sync access handle (a page's writable copies the whole file on every close).
const handles = new Map(); // "<profileId>/<name>" → FileSystemSyncAccessHandle

// A file is only made by its first piece (offset 0): a late piece for a download that was removed fails instead of
// leaving a file that starts with nothing.
async function handleFor(profileId, name, offset) {
  const key = `${profileId}/${name}`;
  if (handles.has(key)) return handles.get(key);
  const create = offset === 0;
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle('atomix-downloads', { create })).getDirectoryHandle(String(profileId), { create });
  const handle = await (await dir.getFileHandle(name, { create })).createSyncAccessHandle();
  handles.set(key, handle);
  return handle;
}

self.onmessage = async ({ data }) => {
  const { id, op, profileId, name, offset, buffer } = data;
  try {
    if (op === 'write') {
      const h = await handleFor(profileId, name, offset);
      const n = h.write(new Uint8Array(buffer), { at: offset });
      if (data.whole) h.truncate(n); // a whole small file: nothing of an older one left after it
      h.flush();
      self.postMessage({ id, ok: true, n });
    } else if (op === 'close') {
      const key = `${profileId}/${name}`;
      handles.get(key)?.close();
      handles.delete(key);
      self.postMessage({ id, ok: true });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, name: err.name, message: err.message });
  }
};
