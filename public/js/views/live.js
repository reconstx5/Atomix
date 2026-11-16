// Live TV: the channel list. Group chips, what's on now and next, favourites, and typing a channel number to jump
// to it, as on a TV. Orbit shows the channels as a wall of glass cards under a spotlight; the older themes as rows.
// v0.26: a Preact screen (ui/live.js has its pieces).
import { html, useState, useRef, useLayoutEffect, useEffect, useAppState } from '../ui.js';
import { Button, EmptyState, MoreButton } from '../ui/basics.js';
import { ChannelRow, ChannelCard, LiveSpotlight } from '../ui/live.js';
import { toast, announce, openDialog, field } from '../components.js';
import { h } from '../dom.js';
import { api } from '../api.js';
import { followFocus } from '../backdrop.js';
import { canAdmin, isOrbit, isKidsProfile } from '../app.js';
import { fetchAll, rememberGroup } from './live-data.js';
import { spotKeep } from '../live-rules.js';
import { setFavourite, setZapOrder, playChannel, recordProgramme } from '../live.js';
import { hiddenFilter, hiddenCount, deviceNow, whenDeviceKnown, showAllNow, setShowAll, switchLabel } from '../dash/playable.js';

export { load } from './live-data.js';

const guideFor = (c) => (location.hash = `#/live/guide?channel=${c.id}`);
/**
 * An admin's "Provider app link…" (v0.28): the https address and button name of the provider's own app for a channel
 * this device can't play. "Use default" goes back to the playlist's or the built-in link. Resolves true when changed;
 * Save with the playlist's or built-in link untouched saves nothing (c.appLinkAdmin says whose link it is).
 */
export async function appLinkDialog(c) {
  const url = h('input', { type: 'text', name: 'url', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', placeholder: 'https://', value: c.appUrl || '', 'data-autofocus': true });
  const name = h('input', { type: 'text', name: 'name', maxlength: '80', autocomplete: 'off', placeholder: 'TVNZ+', value: c.appName || '' });
  let unchanged = false;
  const v = await openDialog({
    title: `Provider app link for ${c.name}`,
    body: h('div', {}, field('Address (https)', url, "Opens the provider's own app or site on a device that can't play this channel."), field('Button name', name, 'Shown as "Open <name>".')),
    actions: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'Use default', value: 'default' },
      { label: 'Save', value: 'save', variant: 'primary' },
    ],
    onSubmit: async (value) => {
      if (value === 'default') return api.put(`/api/live/channels/${c.id}/app-link`, {});
      const address = url.value.trim();
      // The playlist's or built-in link, saved untouched, stays the default: it isn't made the admin's own setting.
      if (!c.appLinkAdmin && address === (c.appUrl || '') && name.value.trim() === (c.appName || '')) {
        unchanged = true;
        return;
      }
      if (!/^https:\/\/[^/\s]/i.test(address)) throw new Error('The app link must be an https:// address.');
      return api.put(`/api/live/channels/${c.id}/app-link`, { url: address, name: name.value.trim() });
    },
  });
  if (unchanged) return false;
  if (v === 'save') toast(`Saved the app link for ${c.name}`);
  else if (v === 'default') toast(`${c.name} uses its default app link again`);
  return v === 'save' || v === 'default';
}

const castFor = async (c) => (await import('../cast.js')).castLive?.({ liveChannelId: c.id }, { encrypted: Boolean(c.drm) });

function scrollerOf(node) {
  for (let n = node.parentElement; n; n = n.parentElement) if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight) return n;
  return document.scrollingElement;
}

export function Screen({ data, view }) {
  const [orbit] = useState(isOrbit);
  useLayoutEffect(() => {
    view?.classList.add('live-view');
    if (orbit && data.status.enabled) view?.classList.add('has-spot');
  }, []);
  if (!data.status.enabled) {
    return html`<${EmptyState}
      title="Live TV isn't set up yet"
      text=${canAdmin() ? 'Add a playlist in Settings → Plugins → IPTV Simple' : ''}
      icon="live"
      action=${canAdmin() ? html`<${Button} label="Open Plugins" icon="settings" variant="primary" href="#/settings/plugins" />` : null}
    />`;
  }
  return html`<${Channels} first=${data} orbit=${orbit} view=${view} />`;
}

function Channels({ first, orbit, view }) {
  const [snap, setSnap] = useState(first);
  const [spotId, setSpotId] = useState(null);
  const [digits, setDigits] = useState('');
  const castOff = useAppState((s) => s.status?.castEnabled === false);
  const admin = useAppState(() => canAdmin()); // re-read when the profile changes (Kids profiles aren't admins)
  // v0.28: channels this device can't play are left out (or, with the switch on, dimmed). An iPhone is known at once;
  // elsewhere the probe answers once and the lists are drawn again.
  const [device, setDevice] = useState(deviceNow);
  const [showAll, setShowAllState] = useState(showAllNow);
  const recordingsLink = useAppState((s) => Boolean(s.profile && !s.profile.kids));
  const list = useRef(null);
  const chips = useRef(null);
  const left = useRef(false); // the page has closed
  const group = useRef(first.group);
  const all = useRef(first.all);
  const byId = useRef(new Map());
  const after = useRef(null); // what the next drawing restores: { anchor, keep }
  const recording = useRef(false); // a Record press in flight: repeat presses wait for it

  const shown = hiddenFilter(snap.shown, { device, showAll });
  const hidden = hiddenCount(snap.all, device);
  byId.current = new Map(shown.map((c) => [String(c.id), c]));
  all.current = snap.all;
  const spotC = orbit ? byId.current.get(String(spotKeep(shown, spotId))) || null : null;

  useEffect(() => {
    if (device) return;
    whenDeviceKnown(snap.all).then((d) => d && !left.current && setDevice(d)).catch(() => {});
  }, [snap]);
  const flipShowAll = (on) => {
    setShowAll(on);
    setShowAllState(on);
  };
  async function appLink(c) {
    if (await appLinkDialog(c)) await reload({ keep: c.id }).catch(() => {});
  }

  // keep: the channel whose row gets focus back (from a row's "…"); a reload otherwise leaves focus where it is,
  // since the rows keep their elements.
  const seq = useRef(0); // only the latest reload draws (chip answers can land out of order)
  async function reload({ keep = null } = {}) {
    if (left.current) return;
    const my = ++seq.current;
    const next = await fetchAll(group.current);
    if (left.current || my !== seq.current) return;
    group.current = next.group;
    // Orbit: a reload redraws the wall without moving it. Off-screen cards take their real height as a placeholder
    // (content-visibility), and the card in view (the focused one, else the first visible) stays where it was.
    let anchor = null;
    const ul = list.current;
    if (orbit && ul) {
      const focusedId = document.activeElement?.closest?.('.live-item')?.dataset.id ?? null;
      const li = (focusedId && ul.querySelector(`.live-item[data-id="${focusedId}"]`)) || [...ul.children].find((x) => x.getBoundingClientRect().bottom > 0);
      anchor = li ? { id: li.dataset.id, top: li.getBoundingClientRect().top } : null;
      if (ul.firstElementChild?.firstElementChild) ul.style.setProperty('--item-h', `${ul.firstElementChild.firstElementChild.offsetHeight}px`); // the card's height: the item's padding comes on top
    }
    after.current = { anchor, keep };
    setSnap(next);
  }

  useLayoutEffect(() => {
    setZapOrder(snap.shown.filter((c) => !c.radio).map((c) => c.id));
    const { anchor, keep } = after.current || {};
    after.current = null;
    const ul = list.current;
    if (anchor && ul) {
      const again = ul.querySelector(`.live-item[data-id="${anchor.id}"]`);
      if (again) scrollerOf(ul).scrollTop += again.getBoundingClientRect().top - anchor.top;
    }
    if (keep != null) ul?.querySelector(`.live-item[data-id="${keep}"] > button`)?.focus({ preventScroll: false });
  }, [snap]);

  // Now/next move on at the earliest programme end (and each minute, for the bars).
  useEffect(() => {
    const now = Date.now();
    const soonest = Math.min(...snap.shown.filter((c) => c.now).map((c) => c.now.end), now + 60_000);
    const timer = setTimeout(() => reload().catch(() => {}), Math.max(5_000, soonest - now + 500));
    return () => clearTimeout(timer);
  }, [snap]);

  // Orbit: the spotlight follows focus and the mouse; past the first row it gets compact.
  useLayoutEffect(() => {
    if (!orbit) return undefined;
    followFocus(list.current, (card) => byId.current.get(card.dataset.id), (c) => setSpotId(c.id), { selector: '.live-card' });
    const onFocus = (e) => {
      const card = e.target.closest?.('.live-card');
      const firstItem = list.current?.querySelector('.live-item');
      view?.classList.toggle('is-compact', Boolean(card && firstItem && card.parentElement.offsetTop > firstItem.offsetTop));
    };
    view?.addEventListener('focusin', onFocus);
    return () => view?.removeEventListener('focusin', onFocus);
  }, []);

  // Typing a channel number: shown while typed; plays after 1.5 s or Enter.
  useLayoutEffect(() => {
    let typed = '';
    let digitTimer = null;
    const show = (t) => setDigits(t);
    const goTyped = () => {
      clearTimeout(digitTimer);
      const n = Number(typed);
      typed = '';
      show('');
      const c = all.current.find((x) => x.number === n);
      if (c) playChannel(c);
      else announce(`There's no channel ${n}`);
    };
    const onKey = (e) => {
      if (e.target.closest?.('input, textarea, select, [contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        typed = (typed + e.key).slice(-4);
        show(typed);
        clearTimeout(digitTimer);
        digitTimer = setTimeout(goTyped, 1500);
      } else if (typed && e.key === 'Enter') {
        e.preventDefault();
        goTyped();
      } else if (typed && (e.key === 'Escape' || e.key === 'Backspace')) {
        e.preventDefault();
        typed = '';
        show('');
        clearTimeout(digitTimer);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      left.current = true;
      clearTimeout(digitTimer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, []);

  async function pick(label) {
    group.current = rememberGroup(label);
    setSnap((s) => ({ ...s, group: label }));
    await reload();
  }
  const onChipKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const pills = [...chips.current.children];
    const i = pills.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    const next = pills[(i + (e.key === 'ArrowRight' ? 1 : pills.length - 1)) % pills.length];
    next.focus();
    pick(next.textContent);
  };

  // keepFocus: from a row's "…", focus goes back to the row; from the spotlight it stays on the ★.
  async function favourite(c, on, { keepFocus = true } = {}) {
    await setFavourite(c.id, on);
    toast(on ? `Added ${c.name} to favourites` : `Removed ${c.name} from favourites`);
    await reload(keepFocus ? { keep: c.id } : {});
  }

  // The spotlight's Record: marks the programme on now; a marked one opens its sheet (Cancel, Stop).
  async function record(c) {
    if (!c.now || recording.current) return;
    if (c.now.recording) {
      if ((await (await import('./guide.js')).openProgramme(c.now.id)) === 'recordings-changed') await reload().catch(() => {});
      return;
    }
    recording.current = true;
    try {
      const r = await recordProgramme(c.now.id);
      toast(r?.recording?.status === 'scheduled' ? `Recording scheduled: ${c.now.title}` : `Recording ${c.now.title}`);
      if (r?.clash) toast(r.clash, { type: 'warning', timeout: 9000 });
    } catch (err) {
      toast(err.message, { type: 'error', timeout: 9000 }); // spoken by the alert region
    } finally {
      recording.current = false;
    }
    await reload().catch(() => {});
  }

  const chipsEl = html`<div ref=${chips} class="live-groups kind-pills" role="radiogroup" aria-label="Channel group" onKeyDown=${onChipKey}>
    ${snap.labels.map((label) => {
      const on = label === snap.group;
      return html`<button key=${label} type="button" role="radio" class="pill" aria-checked=${String(on)} tabindex=${on ? 0 : -1} onClick=${() => pick(label)}>${label}</button>`;
    })}
  </div>`;
  // The switch, only when this device can't play something: Orbit's "…" sheet, a check box over the older themes' rows.
  const label = hidden ? switchLabel() : '';
  const orbitMore = orbit && hidden ? html`<${MoreButton} title="Live TV" items=${[{ label, icon: 'eye', checked: showAll, onSelect: () => flipShowAll(!showAll) }]} />` : null;
  const switchEl = !orbit && hidden ? html`<label class="live-show-unplayable"><input type="checkbox" checked=${showAll} onChange=${(e) => flipShowAll(e.currentTarget.checked)} /><span>${label}</span></label>` : null;
  const pageActions = html`<div class="actions"><${Button} label="Guide" icon="guide" variant="ghost" href="#/live/guide" />${recordingsLink ? html`<${Button} label="Recordings" icon="archive" variant="ghost" href="#/live/recordings" />` : null}${orbitMore}</div>`;
  const items = shown.map((c) =>
    orbit
      ? html`<${ChannelCard} key=${c.id} c=${c} onPlay=${playChannel} />`
      : html`<${ChannelRow} key=${c.id} c=${c} onPlay=${playChannel} onFavourite=${favourite} onGuide=${guideFor} onCast=${castFor} castOk=${!castOff} onAppLink=${admin ? appLink : null} />`,
  );
  const listEl = html`<ul ref=${list} class=${orbit ? 'live-wall' : 'live-list'} role="list">${items}</ul>`;
  const digitsEl = html`<div class="live-digits" hidden=${!digits} aria-hidden="true">${digits}</div>`;
  if (!orbit) {
    return html`<header class="page-head live-head"><h1>Live TV</h1>${pageActions}</header>${chipsEl}${switchEl}${listEl}${digitsEl}`;
  }
  return html`<h1 class="visually-hidden">Live TV</h1>
    <${LiveSpotlight}
      c=${spotC}
      view=${view}
      castOff=${castOff}
      kids=${isKidsProfile()}
      onWatch=${playChannel}
      onRecord=${record}
      onFavourite=${(c) => favourite(c, !c.favourite, { keepFocus: false })}
      onGuide=${guideFor}
      onCast=${castFor}
      onAppLink=${admin ? appLink : null}
    />
    <div class="live-scroll"><div class="live-toolbar">${chipsEl}${pageActions}</div>${listEl}</div>
    ${digitsEl}`;
}
