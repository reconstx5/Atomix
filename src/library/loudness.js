// Even volume (v0.28): how loud a song is (EBU R128 integrated loudness and true peak, measured once by ffmpeg's
// ebur128 filter in the background), the gain that levels it, and the ReplayGain values music apps read.
import { spawn } from 'node:child_process';

export const TARGET_LUFS = -16; // the player levels every song to this (Apple Music and most players aim near it)
const RG_REFERENCE = -18; // ReplayGain 2's reference loudness

/** ffmpeg's ebur128 summary → { i, tp } (integrated LUFS, true peak dBFS), or null (unreadable or silent). */
export function parseEbur128(stderr) {
  const text = String(stderr);
  const i = /^\s*I:\s*(-?[\d.]+)\s*LUFS/m.exec(text);
  const tp = /^\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/m.exec(text);
  if (!i) return null;
  const loud = Number(i[1]);
  if (!Number.isFinite(loud) || loud <= -70) return null; // silence
  const peak = tp && tp[1] !== '-inf' ? Number(tp[1]) : 0;
  return { i: loud, tp: Number.isFinite(peak) ? peak : 0 };
}

/** The gain (dB) that brings a song to TARGET_LUFS: down by up to 12 dB, up by up to 6 dB but never past its peak. */
export function levelGain(loudness, target = TARGET_LUFS) {
  if (!loudness || !Number.isFinite(loudness.i)) return 0;
  let g = target - loudness.i;
  if (g > 0) g = Math.min(g, 6, Math.max(0, -1 - (loudness.tp ?? 0))); // keep 1 dB of headroom below full scale
  return Math.round(Math.max(-12, g) * 10) / 10;
}

/** OpenSubsonic's replayGain for a song: gain to the -18 LUFS reference, and the peak as a ratio of full scale. */
export function replayGainOf(loudness) {
  if (!loudness || !Number.isFinite(loudness.i)) return undefined;
  return { trackGain: Math.round((RG_REFERENCE - loudness.i) * 10) / 10, trackPeak: Math.round(10 ** ((loudness.tp ?? 0) / 20) * 1000) / 1000 };
}

/** Measure a file's main audio track. Resolves to { i, tp } or null. */
export function measureLoudness(ffmpegPath, file, { signal, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    // No framelog=quiet: ffmpeg 4.x doesn't know it (the per-frame lines are trimmed below; the summary is last).
    const args = ['-hide_banner', '-nostdin', '-nostats', '-i', file, '-map', '0:a:0', '-vn', '-sn', '-dn', '-af', 'ebur128=peak=true', '-f', 'null', '-'];
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], signal });
    onSpawn?.(proc);
    let err = '';
    proc.stderr.on('data', (d) => {
      err += d;
      if (err.length > 200000) err = err.slice(-100000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(parseEbur128(err)) : reject(new Error(`ffmpeg exited with ${code}: ${err.slice(-300)}`))));
  });
}
