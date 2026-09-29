// The picture-and-time bubble above the player's seek bar.
import { h, formatClock } from './dom.js';
import { tileFor } from './previews.js';

export function seekPreview(track) {
  const img = h('div', { class: 'seek-preview-img' });
  const time = h('span', { class: 'seek-preview-time' });
  const el = h('div', { class: 'seek-preview', hidden: true, 'aria-hidden': 'true' }, img, time);
  track.append(el);
  let manifest = null;
  const loaded = new Set();
  const preload = (url) => {
    if (!url || loaded.has(url)) return;
    loaded.add(url);
    new Image().src = url;
  };

  return {
    el,
    setManifest(m) {
      manifest = m || null;
      el.classList.toggle('has-image', Boolean(manifest));
    },
    show(t, total) {
      el.hidden = false;
      time.textContent = formatClock(t);
      const tile = tileFor(manifest, t);
      if (tile) {
        const scale = (img.clientWidth || tile.width) / tile.width;
        img.style.aspectRatio = `${tile.width} / ${tile.height}`;
        img.style.backgroundImage = `url("${tile.url}")`;
        img.style.backgroundSize = `${tile.sheetWidth * scale}px ${tile.sheetHeight * scale}px`;
        img.style.backgroundPosition = `${-tile.x * scale}px ${-tile.y * scale}px`;
        preload(tile.url);
        // The sheets either side, so scrubbing across a sheet boundary doesn't flash.
        const perSheet = manifest.interval * manifest.columns * manifest.rows;
        preload(tileFor(manifest, t + perSheet)?.url);
        preload(tileFor(manifest, t - perSheet)?.url);
      }
      const pct = total > 0 ? Math.max(0, Math.min(1, t / total)) : 0;
      const half = el.offsetWidth / 2;
      const width = track.clientWidth;
      el.style.left = `${Math.max(half, Math.min(width - half, pct * width))}px`;
    },
    hide() {
      el.hidden = true;
    },
  };
}
