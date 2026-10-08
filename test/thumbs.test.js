// A still frame for an extra, made in the background.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { hasFfmpeg, tempDir, makeVideo } from './helpers.js';
import { makeThumb } from '../src/extras/thumbs.js';

test('makeThumb writes one JPEG a tenth of the way in and returns a cache: reference', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const dir = tempDir();
  const file = path.join(dir, 'clip.mp4');
  makeVideo(file, { seconds: 5 });
  const imagesDir = path.join(dir, 'images');
  fs.mkdirSync(imagesDir);
  const ref = await makeThumb({ ffmpegPath: 'ffmpeg', imagesDir, item: { id: 7, path: file, duration: 5, size: 1, mtime: 2 } });
  assert.match(ref, /^cache:thumb-7-1-2\.jpg$/);
  const st = fs.statSync(path.join(imagesDir, ref.slice(6)));
  assert.ok(st.size > 500);
});
