// CBR and CB7 comics through 7-Zip or unrar (v0.22), when one is installed — like ffmpeg, an outside program Atomix
// finds (the path in Settings → Server, else 7z, 7za, 7zz or unrar on the PATH). Always run with its arguments as a
// list, never through a shell; a page is asked for only by a name from the comic's own list, its output is capped,
// and a tool that doesn't answer is stopped.
import { spawn } from 'node:child_process';
import { ZIP_LIMITS } from '../../public/js/reader/zip.js';

export const ARCHIVE_CANDIDATES = ['7z', '7za', '7zz', 'unrar'];
const NEEDS_TOOL = 'Install 7-Zip to read this.';
const LIST_MS = 30_000;

/** Run a tool; resolves { code, out, err } (stdout as a Buffer). Rejects 'timeout', 'too-large' or the spawn error. */
function exec(bin, args, { timeoutMs, maxBytes }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      reject(err);
      return;
    }
    const chunks = [];
    let size = 0;
    let err = '';
    let done = false;
    const finish = (fn) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => finish(() => (child.kill('SIGKILL'), reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })))), timeoutMs);
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) finish(() => (child.kill('SIGKILL'), reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }))));
      else chunks.push(c);
    });
    child.stderr.on('data', (c) => (err += c).length > 10000 && (err = err.slice(-10000)));
    child.on('error', (e) => finish(() => reject(e)));
    child.on('close', (code) => finish(() => resolve({ code, out: Buffer.concat(chunks), err })));
  });
}

/**
 * The first candidate that answers as 7-Zip or unrar.
 * @returns {Promise<{ available: boolean, kind: '7z'|'unrar'|null, path: string|null, version: string|null }>}
 */
export async function detectArchiveTool(candidates = ARCHIVE_CANDIDATES) {
  for (const bin of candidates.filter(Boolean)) {
    try {
      const r = await exec(bin, [], { timeoutMs: 10_000, maxBytes: 1_000_000 });
      const text = `${r.out}${r.err}`;
      const seven = /7-Zip[^\d]*(\d+\.\d+)/i.exec(text);
      if (seven) return { available: true, kind: '7z', path: bin, version: seven[1] };
      const rar = /UNRAR\s+(\d+\.\d+)/i.exec(text);
      if (rar) return { available: true, kind: 'unrar', path: bin, version: rar[1] };
    } catch {
      /* not there, or not one of these */
    }
  }
  return { available: false, kind: null, path: null, version: null };
}

const safe = (name) => name && !name.includes('\u0000') && !/^[\\/]/.test(name) && !/^[a-zA-Z]:/.test(name) && !name.split(/[\\/]/).includes('..');

/** The names in an archive (folders and unsafe names left out). */
export async function archiveList(tool, file) {
  if (!tool?.available) throw new Error(NEEDS_TOOL);
  const args = tool.kind === 'unrar' ? ['lb', file] : ['l', '-slt', '-ba', '--', file];
  let r;
  try {
    r = await exec(tool.path, args, { timeoutMs: LIST_MS, maxBytes: 10_000_000 });
  } catch (err) {
    throw new Error(err.code === 'TIMEOUT' ? "7-Zip didn't answer in time." : NEEDS_TOOL);
  }
  if (r.code !== 0) throw new Error("This comic couldn't be read.");
  const text = r.out.toString('utf8');
  if (tool.kind === 'unrar') return text.split(/\r?\n/).map((l) => l.trim()).filter(safe);
  const names = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const name = /^Path = (.*)$/m.exec(block)?.[1];
    const attrs = /^Attributes = (.*)$/m.exec(block)?.[1] || '';
    const folder = /^Folder = \+$/m.test(block) || /^D/.test(attrs);
    if (name && !folder && safe(name)) names.push(name);
  }
  return names;
}

/**
 * Every entry into `outDir` in one run (packing a comic for Downloads: a solid archive is read once, not once a page).
 * `outDir` is a fresh folder under Atomix's cache.
 */
export async function archiveExtractAll(tool, file, outDir, { timeoutMs = 600_000 } = {}) {
  if (!tool?.available) throw new Error(NEEDS_TOOL);
  const args = tool.kind === 'unrar' ? ['x', '-o+', '-inul', file, `${outDir}${outDir.endsWith('/') || outDir.endsWith('\\') ? '' : '/'}`] : ['x', `-o${outDir}`, '-y', '--', file];
  let r;
  try {
    r = await exec(tool.path, args, { timeoutMs, maxBytes: 20_000_000 });
  } catch (err) {
    throw new Error(err.code === 'TIMEOUT' ? "7-Zip didn't answer in time." : NEEDS_TOOL);
  }
  if (r.code !== 0) throw new Error("This comic couldn't be read.");
}

/** One entry's bytes, by a name from `list` (the comic's own list). */
export async function archiveEntry(tool, file, name, { list, timeoutMs = 30_000 } = {}) {
  if (!tool?.available) throw new Error(NEEDS_TOOL);
  if (!Array.isArray(list) || !list.includes(name)) throw new Error("That page isn't in this comic.");
  const args = tool.kind === 'unrar' ? ['p', '-inul', file, name] : ['e', '-so', '--', file, name];
  let r;
  try {
    r = await exec(tool.path, args, { timeoutMs, maxBytes: ZIP_LIMITS.entryBytes });
  } catch (err) {
    if (err.code === 'TIMEOUT') throw new Error("7-Zip didn't answer in time.");
    if (err.code === 'TOO_LARGE') throw new Error('A file in this archive is too large to open.');
    throw new Error(NEEDS_TOOL);
  }
  if (r.code !== 0 || !r.out.length) throw new Error("This comic couldn't be read.");
  return r.out;
}
