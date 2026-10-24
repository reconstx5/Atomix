// Alerts channels (v0.23): ntfy, Telegram and Pushover. Each send resolves, or throws an Error whose message is the
// reason people read ("Unauthorized (check the bot token)"). Addresses carry tokens (Telegram's is in its path),
// so no address ever goes into an error or a log.

const TIMEOUT = 15000;

async function post(api, url, init) {
  try {
    return await api.fetch(url, { method: 'POST', ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    throw new Error(err?.name === 'TimeoutError' ? 'timed out' : 'no answer');
  }
}

/** A header value with non-ASCII text encoded (RFC 2047), as ntfy reads it. */
const headerText = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

export async function sendNtfy(api, cfg, { title, text }) {
  const server = String(cfg.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
  const headers = { 'Content-Type': 'text/plain; charset=utf-8', Title: headerText(String(title || '').slice(0, 200)) };
  if (cfg.ntfyToken) headers.Authorization = `Bearer ${cfg.ntfyToken}`;
  const res = await post(api, `${server}/${encodeURIComponent(cfg.ntfyTopic)}`, { headers, body: String(text) });
  await res.body?.cancel().catch(() => {});
  if (res.status === 401 || res.status === 403) throw new Error('Unauthorized (check the access token)');
  if (!res.ok) throw new Error(`answered ${res.status}`);
}

export async function sendTelegram(api, cfg, { text }) {
  const base = (process.env.ATOMIX_TELEGRAM_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const res = await post(api, `${base}/bot${cfg.telegramToken}/sendMessage`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: String(cfg.telegramChat), text: String(text).slice(0, 4000), disable_web_page_preview: true }),
  });
  const data = await res.json().catch(() => null);
  if (res.ok && data?.ok !== false) return;
  if (res.status === 401) throw new Error('Unauthorized (check the bot token)');
  if (/chat not found/i.test(data?.description || '')) throw new Error('chat not found (check the chat id)');
  throw new Error(data?.description ? String(data.description).slice(0, 120) : `answered ${res.status}`);
}

export async function sendPushover(api, cfg, { title, text }) {
  const base = (process.env.ATOMIX_PUSHOVER_BASE || 'https://api.pushover.net').replace(/\/+$/, '');
  const form = new URLSearchParams({ token: cfg.pushoverToken, user: cfg.pushoverUser, title: String(title || '').slice(0, 250), message: String(text).slice(0, 1024) });
  const res = await post(api, `${base}/1/messages.json`, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const data = await res.json().catch(() => null);
  if (res.ok && data?.status === 1) return;
  if (Array.isArray(data?.errors) && data.errors[0]) throw new Error(String(data.errors[0]).slice(0, 120));
  throw new Error(`answered ${res.status}`);
}
