// Where to send someone whose device can't play a channel: the provider's own app. An admin's link (admin_app_url) wins, then the
// playlist's (#KODIPROP:atomix.app_url / app_name), then the built-in list. https only; never shown to Kids.
const BUILT_IN = [{ re: /^(TVNZ ?1|TVNZ ?2|(TVNZ )?DUKE)$/i, url: 'https://www.tvnz.co.nz', name: 'TVNZ+' }];

export const isHttpsUrl = (u) => {
  try {
    return new URL(String(u)).protocol === 'https:';
  } catch {
    return false;
  }
};

/** @param {{name?: string, appUrl?: string|null, appName?: string|null}} channel @returns {{url: string, name: string}|null} */
export function providerLink(channel) {
  if (!channel) return null;
  if (channel.adminAppUrl && isHttpsUrl(channel.adminAppUrl)) return { url: channel.adminAppUrl, name: channel.adminAppName || "the provider's app" };
  if (channel.appUrl && isHttpsUrl(channel.appUrl)) return { url: channel.appUrl, name: channel.appName || "the provider's app" };
  const name = String(channel.name || '').trim();
  const hit = BUILT_IN.find((b) => b.re.test(name));
  return hit ? { url: hit.url, name: hit.name } : null;
}
