// The title page's music parts (v0.30): an album (its songs, by disc) and an artist (their albums). Same elements as
// the older page; the songs are a TrackList (ui/music.js).
import { html, useLayoutEffect, useRef } from '../ui.js';
import { Button } from '../ui/basics.js';
import { Art, Grid } from '../ui/cards.js';
import { TitleArt, Genres, RatingControl } from '../ui/detail.js';
import { formatRuntime } from '../dom.js';
import { isOrbit } from '../app.js';
import { canRate } from '../rating.js';
import { music } from '../music.js';
import { TrackList } from '../ui/music.js';

const songCount = (n) => `${n} ${n === 1 ? 'song' : 'songs'}`;
const totalTime = (sec) => (sec ? formatRuntime(sec / 60) : null);

/** Play (or Play all), Shuffle and Add to queue; nothing when there are no songs. */
function PlayButtons({ tracks, label = 'Play', autofocus = true }) {
  if (!tracks.length) return null;
  return [
    html`<${Button} label=${label} icon="play" variant="primary" autofocus=${autofocus} onClick=${() => music.playTracks(tracks, 0)} />`,
    html`<${Button} label="Shuffle" icon="shuffle" onClick=${() => music.playTracks(tracks, -1, { shuffle: true })} />`,
    html`<${Button} label="" icon="queue" variant="ghost" title="Add to queue" onClick=${() => music.addToQueue(tracks)} />`,
  ];
}

/** An album's or an artist's header: square (or round) art, the eyebrow, the title, a plain meta line, the actions. */
export function MusicHeader({ item, eyebrow, meta, actions, round = false }) {
  return html`<header class="detail-header music-header">
    <div class="detail-inner">
      <div class=${`detail-poster is-square${round ? ' is-round' : ''}`}><${Art} key=${item.poster || ''} src=${item.poster} title=${item.title} kind="square" eager=${true} /></div>
      <div class="detail-info">
        <p class="eyebrow">${eyebrow}</p>
        <${TitleArt} logo=${item.logo} title=${item.title} />
        <div class="meta-line">${meta.filter(Boolean).map((m) => html`<span>${m}</span>`)}</div>
        <${Genres} genres=${item.genres} />
        ${item.overview ? html`<p class="overview">${item.overview}</p>` : null}
        <div class="actions">${actions}</div>
        ${isOrbit() && canRate(item) ? html`<${RatingControl} item=${item} />` : null}
      </div>
    </div>
  </header>`;
}

/** An album: its songs by disc. `?track=` focuses that song and brings it to the middle of the screen. `more`: the "…" (and older themes' admin buttons). */
export function AlbumPage({ data, query, more }) {
  const { item, artist } = data;
  const tracks = data.tracks || [];
  const focusId = Number(query.track) || null;
  const body = useRef(null);
  useLayoutEffect(() => {
    if (!focusId) return undefined;
    // The page is drawn before it is shown: wait until it is on the page (at most a second), then a frame more, so
    // the router's own scroll to the top (straight after it puts the page in) has happened.
    // Only this page's own row: the page being left can still be on screen (a still copy) with the same song in it.
    let tries = 0;
    let frame = 0;
    let seen = false;
    const centre = () => {
      const row = body.current?.querySelector(`.track-row[data-id="${focusId}"]`);
      if (!row?.isConnected || !seen) {
        seen = Boolean(row?.isConnected);
        return void (tries++ < 60 && (frame = requestAnimationFrame(centre)));
      }
      row.scrollIntoView({ block: 'center' });
    };
    frame = requestAnimationFrame(centre);
    return () => cancelAnimationFrame(frame);
  }, []);
  const eyebrow = artist ? ['Album · ', html`<a href=${`#/item/${artist.id}`}>${artist.title}</a>`] : 'Album';
  return [
    html`<${MusicHeader} item=${item} eyebrow=${eyebrow} meta=${[item.year ? String(item.year) : null, songCount(tracks.length), totalTime(item.duration)]} actions=${[html`<${PlayButtons} tracks=${tracks} autofocus=${!focusId} />`, more]} />`,
    html`<div class="detail-body" ref=${body}>
      <section class="detail-section">
        <h2 class="visually-hidden">Songs</h2>
        ${tracks.length ? html`<${TrackList} tracks=${tracks} showArtist=${artist?.title || true} discs=${true} focusId=${focusId} />` : html`<p class="muted">No songs found.</p>`}
      </section>
    </div>`,
  ];
}

/** An artist: Play all, and their albums as a grid. */
export function ArtistPage({ data, more }) {
  const { item } = data;
  const albums = data.albums || [];
  const tracks = data.tracks || [];
  return [
    html`<${MusicHeader} item=${item} round=${true} eyebrow="Artist" meta=${[`${albums.length} ${albums.length === 1 ? 'album' : 'albums'}`, songCount(tracks.length), totalTime(item.duration)]} actions=${[html`<${PlayButtons} tracks=${tracks} label="Play all" />`, more]} />`,
    html`<div class="detail-body detail-body-flush">
      <section class="detail-section">
        <h2 class="section-pad">Albums</h2>
        ${albums.length ? html`<${Grid} items=${albums} style="square" />` : html`<p class="muted section-pad">No albums found.</p>`}
      </section>
    </div>`,
  ];
}
