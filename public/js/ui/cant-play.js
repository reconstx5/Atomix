// The message card for a channel this device can't play (v0.28): opened instead of a stream (none is reserved). It
// says why (dash/support.js's sentence), offers Watch on TV when casting is on and a TV can play the channel, and the
// provider's own app when the channel has a link (never for Kids profiles: the server sends none). Back closes it.
import { html, render } from '../ui.js';
import { Icon } from './basics.js';
import { openDialog } from '../components.js';
import { castableDrm, channelLabel } from '../live.js';
import { state } from '../app.js';

/** The card's content: the sentence, then Watch on TV, Open <app name> and Go back. */
export function CantPlay({ c, sentence, castOn, onWatchTv, onClose }) {
  const tv = castOn && !c.radio && castableDrm(c.drm);
  const app = c.appUrl && /^https:\/\//i.test(c.appUrl) ? c.appUrl : null;
  return html`<div class="cant-play">
    <p class="cant-play-text">${sentence}</p>
    <div class="actions cant-play-actions">
      ${tv ? html`<button type="button" class="btn btn-primary cant-play-tv" data-autofocus=${true} onClick=${onWatchTv}><${Icon} name="cast" /><span>Watch on TV</span></button>` : null}
      ${app ? html`<a class=${`btn ${tv ? 'btn-secondary' : 'btn-primary'} cant-play-app`} href=${app} target="_blank" rel="noopener" data-autofocus=${tv ? null : true} onClick=${onClose}><${Icon} name="forward" /><span>${`Open ${c.appName || "the provider's app"}`}</span></a>` : null}
      <button type="button" class=${`btn ${tv || app ? 'btn-ghost' : 'btn-primary'} cant-play-back`} data-autofocus=${tv || app ? null : true} onClick=${onClose}>Go back</button>
    </div>
  </div>`;
}

/**
 * Open the card for channel `c` ({ id, name, number?, drm, appUrl?, appName?, radio? }). Resolves once it closes
 * ('tv' when Watch on TV was chosen, else 'back').
 */
export async function openCantPlay(c) {
  const { protectionVerdict } = await import('../dash/support.js');
  const systems = Array.isArray(c.drm) ? c.drm : c.drm ? [c.drm] : [];
  const sentence = (await protectionVerdict(systems)) || "This browser can't play any of this channel's protections.";
  const castOn = state.status?.castEnabled !== false;
  let chose = 'back';
  const box = document.createElement('div');
  const done = openDialog({
    title: channelLabel(c),
    actions: [],
    body: (dialog) => {
      const close = () => dialog.close('done');
      const onWatchTv = () => {
        chose = 'tv';
        close();
      };
      render(html`<${CantPlay} c=${c} sentence=${sentence} castOn=${castOn} onWatchTv=${onWatchTv} onClose=${close} />`, box);
      return box;
    },
  });
  await done;
  render(null, box);
  if (chose === 'tv') (await import('../cast.js')).openCastPicker({ liveChannelId: c.id }, { encrypted: true });
  return chose;
}
