// Windows: finding ffmpeg/ffprobe when PATH hasn't caught up.
// `winget install Gyan.FFmpeg` changes PATH only for windows opened afterwards, so Atomix
// started from an older window (or Explorer) can't find ffmpeg. This looks in the
// places winget, Scoop and Chocolatey put it.
import nodeFs from 'node:fs';
import path from 'node:path';

const win = path.win32;

/** The packages folder holds e.g. Gyan.FFmpeg_<source>\ffmpeg-8.0-full_build\bin\ffmpeg.exe. */
function inWingetPackages(packages, exe, fs) {
  let names;
  try {
    names = fs.readdirSync(packages);
  } catch {
    return null;
  }
  for (const pkg of names.filter((n) => /ffmpeg/i.test(n))) {
    const dir = win.join(packages, pkg);
    const direct = win.join(dir, 'bin', exe);
    if (fs.existsSync(direct)) return direct;
    let inner = [];
    try {
      inner = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const sub of inner) {
      const file = win.join(dir, sub, 'bin', exe);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/**
 * The full path of `name` (ffmpeg or ffprobe) on Windows when it isn't on PATH but is
 * installed in a known place; otherwise `name` unchanged.
 * @param {string} name
 * @param {{platform?: string, env?: object, fs?: {existsSync: Function, readdirSync: Function}}} [opts]
 */
export function findTool(name, { platform = process.platform, env = process.env, fs = nodeFs } = {}) {
  if (platform !== 'win32') return name;
  const exe = `${name}.exe`;
  const pathDirs = String(env.PATH || env.Path || '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(Boolean);
  if (pathDirs.some((d) => fs.existsSync(win.join(d, exe)))) return name;

  const local = env.LOCALAPPDATA || (env.USERPROFILE ? win.join(env.USERPROFILE, 'AppData', 'Local') : null);
  const candidates = [];
  if (local) candidates.push(win.join(local, 'Microsoft', 'WinGet', 'Links', exe));
  if (env.ProgramFiles) candidates.push(win.join(env.ProgramFiles, 'WinGet', 'Links', exe));
  if (env.USERPROFILE) candidates.push(win.join(env.USERPROFILE, 'scoop', 'shims', exe));
  candidates.push(win.join(env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', exe));
  candidates.push(win.join('C:\\ffmpeg', 'bin', exe));
  for (const file of candidates) if (fs.existsSync(file)) return file;

  for (const root of [local && win.join(local, 'Microsoft', 'WinGet', 'Packages'), env.ProgramFiles && win.join(env.ProgramFiles, 'WinGet', 'Packages')]) {
    const found = root && inWingetPackages(root, exe, fs);
    if (found) return found;
  }
  return name;
}
