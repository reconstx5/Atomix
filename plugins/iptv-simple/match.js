// Which guide channel feeds which playlist channel: tvg-id first, then names compared loosely.

/** Lower case, accents stripped, punctuation and spaces removed, a trailing HD/FHD/UHD/4K ignored. */
export function normaliseName(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s()[\]-]*(f?hd|uhd|4k)[\s()[\]]*$/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * @param {Array<{ key, name, tvgId?, tvgName? }>} channels
 * @param {Map<string, string[]>} guideChannels  XMLTV id → display names
 * @returns {Map<string, string>} channel key → XMLTV id
 */
export function matchGuide(channels, guideChannels) {
  const byLowerId = new Map();
  const byName = new Map();
  for (const [id, names] of guideChannels) {
    if (!byLowerId.has(id.toLowerCase())) byLowerId.set(id.toLowerCase(), id);
    for (const n of names) {
      const k = normaliseName(n);
      if (k && !byName.has(k)) byName.set(k, id);
    }
  }
  const out = new Map();
  for (const c of channels) {
    let id = null;
    if (c.tvgId) id = guideChannels.has(c.tvgId) ? c.tvgId : byLowerId.get(c.tvgId.toLowerCase()) || null;
    if (!id && c.tvgName) id = byName.get(normaliseName(c.tvgName)) || null;
    if (!id) id = byName.get(normaliseName(c.name)) || null;
    if (id) out.set(c.key, id);
  }
  return out;
}
