// Web apps (v0.22): the household's shortcut tiles to sites with no API (ReelShort and the like). Admins keep the
// list; a Kids profile sees only the ones marked for Kids. A tile's picture is fetched once by the server (its bytes
// checked, as artwork) and served from Atomix, so a browser never asks the picture's own address.
import { HttpError } from '../http/router.js';

const shape = (r) => ({ id: r.id, name: r.name, url: r.url, image: r.image ? `/api/web-apps/${r.id}/image` : null, kids: Boolean(r.kids) });

function cleanUrl(url) {
  let u;
  try {
    u = new URL(String(url || '').trim());
  } catch {
    u = null;
  }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) throw new HttpError(400, 'Web app addresses start with https:// or http://.');
  return u.href;
}

function cleanName(name) {
  const n = String(name || '').trim();
  if (!n || n.length > 40) throw new HttpError(400, 'Give the web app a name (up to 40 letters).');
  return n;
}

export class WebApps {
  constructor({ db, images }) {
    this.db = db;
    this.images = images;
  }
  row(id) {
    return this.db.get('SELECT * FROM web_apps WHERE id = ?', Number(id)) || null;
  }
  /** In their order; a Kids viewer gets only those marked for Kids. */
  list({ kids = false } = {}) {
    return this.db.all(`SELECT * FROM web_apps ${kids ? 'WHERE kids = 1' : ''} ORDER BY position, id`).map(shape);
  }
  /** Fetch the picture; `{ image, imageError }` — a picture that fails leaves the app without one. */
  async #picture(imageUrl) {
    if (imageUrl == null || imageUrl === '') return { image: null };
    let ref = null;
    try {
      ref = await this.images.download(cleanUrl(imageUrl));
    } catch {
      ref = null;
    }
    return ref ? { image: ref } : { image: null, imageError: "Couldn't use that picture (it isn't one, or the address didn't answer). The tile shows the first letter instead." };
  }
  async add({ name, url, imageUrl, kids }) {
    const fields = { name: cleanName(name), url: cleanUrl(url) };
    const pic = await this.#picture(imageUrl);
    const position = (this.db.get('SELECT MAX(position) AS p FROM web_apps')?.p ?? -1) + 1;
    const id = Number(this.db.run('INSERT INTO web_apps (name, url, image, kids, position, created_at) VALUES (?, ?, ?, ?, ?, ?)', fields.name, fields.url, pic.image, kids ? 1 : 0, position, Date.now()).lastInsertRowid);
    return { ...shape(this.row(id)), ...(pic.imageError ? { imageError: pic.imageError } : {}) };
  }
  async update(id, fields) {
    const r = this.row(id);
    if (!r) throw new HttpError(404, 'That web app no longer exists.');
    const name = fields.name !== undefined ? cleanName(fields.name) : r.name;
    const url = fields.url !== undefined ? cleanUrl(fields.url) : r.url;
    const kids = fields.kids !== undefined ? (fields.kids ? 1 : 0) : r.kids;
    const pic = fields.imageUrl !== undefined ? await this.#picture(fields.imageUrl) : { image: r.image };
    this.db.run('UPDATE web_apps SET name = ?, url = ?, kids = ?, image = ? WHERE id = ?', name, url, kids, pic.image, r.id);
    if (fields.position !== undefined) this.move(r.id, fields.position);
    return { ...shape(this.row(r.id)), ...(pic.imageError ? { imageError: pic.imageError } : {}) };
  }
  remove(id) {
    this.db.run('DELETE FROM web_apps WHERE id = ?', Number(id));
  }
  /** Put an app at `position` (0 = first) and renumber the rest. */
  move(id, position) {
    const ids = this.db.all('SELECT id FROM web_apps ORDER BY position, id').map((r) => r.id).filter((x) => x !== Number(id));
    ids.splice(Math.max(0, Math.min(ids.length, Number(position) || 0)), 0, Number(id));
    ids.forEach((x, i) => this.db.run('UPDATE web_apps SET position = ? WHERE id = ?', i, x));
  }
  /** The picture's file for a viewer who may see the app, or null. */
  pictureFor(id, viewer) {
    const r = this.row(id);
    if (!r?.image || (viewer?.kids && !r.kids)) return null;
    return this.images.resolve(r.image)?.file || null;
  }
}
