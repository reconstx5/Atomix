// libass builds its font cache the first time the subtitles filter runs — on a Windows box with many fonts that
// takes long enough for a TV to give up on the first burned-in cast. Done once at startup instead, in the background.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../library/probe.js';
import { fontsDirArg } from './playback.js';
import { logger } from '../log.js';

const log = logger('playback');

/** Resolves when the warm-up ran (or was skipped); never rejects. */
export async function warmUpSubtitles(config, tools) {
  if (!tools?.filters?.subtitles) return;
  try {
    fs.mkdirSync(config.transcodeDir, { recursive: true });
    const vtt = path.join(config.transcodeDir, 'warm.vtt');
    fs.writeFileSync(vtt, 'WEBVTT\n\n00:00.000 --> 00:00.100\nwarm\n');
    const t0 = Date.now();
    await run(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=s=16x16:d=0.1', '-vf', `subtitles=filename=warm.vtt${fontsDirArg()}`, '-f', 'null', '-'], { timeout: 5 * 60 * 1000, cwd: config.transcodeDir });
    log.info(`Subtitle fonts ready (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (err) {
    log.warn(`Subtitle font warm-up skipped: ${err.message}`);
  }
}
