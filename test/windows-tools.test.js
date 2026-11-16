import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTool } from '../src/windows-tools.js';

const LOCAL = 'C:\\Users\\dallas\\AppData\\Local';
const env = { LOCALAPPDATA: LOCAL, USERPROFILE: 'C:\\Users\\dallas', PATH: 'C:\\Windows\\system32;C:\\Program Files\\nodejs' };

/** A pretend disk: the files listed exist; folders are worked out from them. */
function disk(files) {
  const lower = files.map((f) => f.toLowerCase());
  return {
    existsSync: (p) => lower.includes(p.toLowerCase()),
    readdirSync: (dir) => {
      const pre = dir.toLowerCase().replace(/\\$/, '') + '\\';
      const names = new Set();
      files.forEach((f, i) => { if (lower[i].startsWith(pre)) names.add(f.slice(pre.length).split('\\')[0]); });
      if (!names.size) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return [...names];
    },
  };
}

test('not Windows: the name is kept as it is', () => {
  assert.equal(findTool('ffmpeg', { platform: 'linux', env, fs: disk([]) }), 'ffmpeg');
});

test('on PATH already: the plain name is kept', () => {
  const fs = disk(['C:\\Program Files\\nodejs\\ffmpeg.exe']);
  assert.equal(findTool('ffmpeg', { platform: 'win32', env: { ...env, PATH: env.PATH }, fs }), 'ffmpeg');
});

test('winget Links folder is used when PATH has not caught up', () => {
  const exe = `${LOCAL}\\Microsoft\\WinGet\\Links\\ffmpeg.exe`;
  assert.equal(findTool('ffmpeg', { platform: 'win32', env, fs: disk([exe]) }), exe);
});

test('winget package folder (Gyan.FFmpeg) is found when there is no Links copy', () => {
  const exe = `${LOCAL}\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0-full_build\\bin\\ffprobe.exe`;
  assert.equal(findTool('ffprobe', { platform: 'win32', env, fs: disk([exe]) }), exe);
});

test('Scoop and Chocolatey folders are checked too', () => {
  const scoop = 'C:\\Users\\dallas\\scoop\\shims\\ffmpeg.exe';
  assert.equal(findTool('ffmpeg', { platform: 'win32', env, fs: disk([scoop]) }), scoop);
  const choco = 'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe';
  assert.equal(findTool('ffmpeg', { platform: 'win32', env: { ...env, ProgramData: 'C:\\ProgramData' }, fs: disk([choco]) }), choco);
});

test('nothing anywhere: the plain name is kept (the usual warning follows)', () => {
  assert.equal(findTool('ffmpeg', { platform: 'win32', env, fs: disk([]) }), 'ffmpeg');
});

// loadConfig asks findTool only about the default names, never about a path someone set.
import fsReal from 'node:fs';
import os from 'node:os';
import pathMod from 'node:path';
import { loadConfig } from '../src/config.js';

const tmp = () => fsReal.mkdtempSync(pathMod.join(os.tmpdir(), 'atomix-wt-'));

test('loadConfig: the default ffmpeg/ffprobe names go through findTool', () => {
  const cfg = loadConfig({ root: tmp(), env: {}, findTool: (n) => `C:\\found\\${n}.exe` });
  assert.equal(cfg.ffmpegPath, 'C:\\found\\ffmpeg.exe');
  assert.equal(cfg.ffprobePath, 'C:\\found\\ffprobe.exe');
});

test('loadConfig: a path set in the environment is left alone', () => {
  const cfg = loadConfig({ root: tmp(), env: { ATOMIX_FFMPEG: 'D:\\tools\\ffmpeg.exe' }, findTool: (n) => `C:\\found\\${n}.exe` });
  assert.equal(cfg.ffmpegPath, 'D:\\tools\\ffmpeg.exe');
  assert.equal(cfg.ffprobePath, 'C:\\found\\ffprobe.exe');
});
