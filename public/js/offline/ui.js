// Download controls (v0.21): the quality sheet, a title's Download button (Orbit, on the page) and the same flow from
// a "…" sheet (every theme), all following the download manager's events.
import { h, formatBytes } from '../dom.js';
import { openSheet, toast, announce } from '../components.js';
import { state } from '../app.js';
import { secure } from './install.js';
import { downloads } from './downloader.js';

const QUALITIES = [
  ['480', '480p', 'smallest'],
  ['720', '720p', null],
  ['1080', '1080p', 'largest'],
];

/** Downloads are offered on this device for this account. */
export const canDownloadHere = () => secure() && Boolean(state.status?.downloads?.allowed) && Boolean(state.profile);

function pickQuality(title) {
  const def = String(state.status?.downloads?.quality || '720');
  return new Promise((resolve) => {
    let picked = null;
    openSheet(
      `Download ${title}`,
      QUALITIES.map(([value, label, note]) => ({
        label: `${label}${note ? ` (${note})` : ''}${value === def ? ' (default)' : ''}`,
        icon: 'download',
        onSelect: () => {
          picked = value;
          resolve(value);
        },
      })),
    ).then(() => picked == null && resolve(null));
  });
}

/** Start downloading these titles (asking the quality for videos). */
export async function startDownload({ itemIds, listId, title, kind }) {
  const music = kind === 'track' || kind === 'album' || kind === 'artist';
  const quality = music ? null : await pickQuality(title);
  if (!music && !quality) return;
  try {
    const r = await downloads.start({ itemIds, listId }, quality);
    const msg = r.added ? `Downloading ${r.added === 1 ? title : `${r.added} titles`}` : 'Already downloaded';
    toast(r.skipped ? `${msg} (${r.skipped} not available)` : msg, { type: 'success' });
    announce(msg);
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
}

/** What a title's download is doing, in words for its button. */
export function stateLabel(st) {
  if (!st) return 'Download';
  if (st.status === 'ready') return 'Downloaded';
  if (st.status === 'preparing') return `Preparing… ${Math.round((st.progress || 0) * 100)}%`;
  if (st.status === 'downloading') return `Downloading… ${formatBytes(st.bytes) || '0 B'} of ${formatBytes(st.size)}`;
  if (st.status === 'waiting') return 'Waiting for the connection';
  if (st.status === 'paused') return 'Paused';
  if (st.status === 'expired') return 'Connect to keep';
  return "Couldn't download";
}

/** The sheet for a title that already has a download. */
async function manage(item) {
  const st = await downloads.state(item.id);
  if (!st || st.status === 'failed') {
    if (st) await downloads.remove(item.id);
    return startDownload({ itemIds: [item.id], title: item.title, kind: item.kind });
  }
  const playHref = item.kind === 'track' ? null : `#/play/${item.id}?offline=1`;
  openSheet(item.title, [
    st.status === 'ready' && playHref ? { label: 'Play download', icon: 'play', href: playHref } : null,
    st.status === 'paused' ? { label: 'Resume download', icon: 'download', onSelect: () => downloads.resume(item.id) } : null,
    ['preparing', 'downloading', 'waiting'].includes(st.status) ? { label: 'Pause download', icon: 'pause', onSelect: () => downloads.pause(item.id) } : null,
    {
      label: st.status === 'ready' ? 'Remove download' : 'Cancel download',
      icon: 'trash',
      danger: true,
      onSelect: async () => {
        await downloads.remove(item.id);
        toast(st.status === 'ready' ? 'Download removed' : 'Download cancelled');
      },
    },
  ]);
}

/** A "…" sheet entry: Download, or the download's own sheet when it has one. */
export function downloadSheetItem(item, { label = 'Download', ids = null, listId = null } = {}) {
  if (!canDownloadHere()) return null;
  const single = !ids && !listId && ['movie', 'episode', 'track'].includes(item.kind);
  // `ids` may be a function: a show's season is the one showing when the sheet is used.
  return { label, icon: 'download', onSelect: () => (single ? manage(item) : startDownload({ itemIds: (typeof ids === 'function' ? ids() : ids) || [item.id], listId, title: item.title, kind: item.kind })) };
}

/** Orbit's button beside the play actions: its words follow the download. */
export function downloadButton(item) {
  if (!canDownloadHere()) return null;
  const label = h('span', {}, 'Download');
  const btn = h('button', { type: 'button', class: 'btn btn-ghost download-btn', onClick: () => manage(item) }, label);
  const draw = async () => {
    const st = await downloads.state(item.id);
    label.textContent = stateLabel(st);
    btn.dataset.status = st?.status || 'none';
  };
  // It stops following once it has been on the page and left it (it may hear a change before it is placed).
  let placed = false;
  const onChange = (e) => {
    if (btn.isConnected) placed = true;
    else if (placed) return downloads.events.removeEventListener('change', onChange);
    if (e.detail.itemId === item.id) draw();
  };
  downloads.events.addEventListener('change', onChange);
  draw();
  return btn;
}
