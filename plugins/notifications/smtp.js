// A small SMTP client (no dependencies): implicit TLS (port 465), STARTTLS
// (port 587) or plain, with AUTH PLAIN / LOGIN. Enough to send alert emails
// through Gmail, Outlook, Fastmail, a local relay, etc.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

const ADDRESS = /^[^\s<>@"'(),;:\\]+@[^\s<>@"'(),;:\\]+\.[^\s<>@"'(),;:\\]+$/;

/** "Name <a@b.c>" or "a@b.c" → { name, address } (throws on anything odd). */
export function parseAddress(value) {
  const text = String(value || '').trim();
  if (/[\r\n]/.test(text)) throw new Error(`Invalid email address: ${JSON.stringify(text)}`);
  const m = /^(.*)<([^>]+)>$/.exec(text);
  const address = (m ? m[2] : text).trim();
  const name = m ? m[1].trim().replace(/^"|"$/g, '') : '';
  if (!ADDRESS.test(address)) throw new Error(`Invalid email address: ${JSON.stringify(text)}`);
  return { name, address };
}

const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const formatAddress = ({ name, address }) => (name ? `${encodeWord(name)} <${address}>` : address);
const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n').trimEnd();

class Connection {
  constructor(socket, timeout) {
    this.socket = null;
    this.timeout = timeout;
    this.buffer = '';
    this.waiting = null;
    this.lines = [];
    this.attach(socket);
  }

  attach(socket) {
    // When upgrading to TLS, stop listening to the plain socket underneath.
    if (this.socket && this.handlers) {
      this.socket.off('data', this.handlers.data);
      this.socket.off('error', this.handlers.error);
      this.socket.off('close', this.handlers.close);
    }
    this.socket = socket;
    const onData = (chunk) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, i).replace(/\r$/, '');
        this.buffer = this.buffer.slice(i + 1);
        this.lines.push(line);
        // A reply ends with "NNN text" (a dash after the code means more lines follow).
        if (/^\d{3}(?: |$)/.test(line)) {
          const reply = { code: Number(line.slice(0, 3)), lines: this.lines };
          this.lines = [];
          const w = this.waiting;
          this.waiting = null;
          w?.resolve(reply);
        }
      }
    };
    this.handlers = {
      data: (chunk) => onData(chunk.toString('utf8')),
      error: (err) => this.waiting?.reject(err),
      close: () => this.waiting?.reject(new Error('The mail server closed the connection.')),
    };
    socket.on('data', this.handlers.data);
    socket.on('error', this.handlers.error);
    socket.on('close', this.handlers.close);
  }

  read() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The mail server did not answer in time.')), this.timeout);
      this.waiting = {
        resolve: (r) => (clearTimeout(timer), resolve(r)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
    });
  }

  async command(line, expect, { secret = false } = {}) {
    const pending = this.read();
    this.socket.write(line + '\r\n');
    const reply = await pending;
    if (!expect.includes(reply.code)) {
      const shown = secret ? line.split(' ').slice(0, 2).join(' ') + ' …' : line;
      throw new Error(`Mail server refused "${shown}": ${reply.lines.join(' ')}`);
    }
    return reply;
  }
}

/**
 * @param {object} o
 * @param {string} o.host
 * @param {number} [o.port]
 * @param {'starttls'|'tls'|'none'} [o.security]
 * @param {string} [o.user]
 * @param {string} [o.pass]
 * @param {'PLAIN'|'LOGIN'} [o.authMethod]
 * @param {string} o.from
 * @param {string[]} o.to
 * @param {string} o.subject
 * @param {string} o.text
 */
export async function sendMail({ host, port, security = 'starttls', user, pass, authMethod, from, to, subject, text, timeout = 20000, tls: tlsOptions = {} }) {
  if (!host) throw new Error('No mail server (SMTP host) set.');
  const sender = parseAddress(from);
  const recipients = [].concat(to || []).map(parseAddress);
  if (!recipients.length) throw new Error('No recipients.');
  const cleanSubject = String(subject || '').replace(/[\r\n]+/g, ' ');
  const portNumber = Number(port) || (security === 'tls' ? 465 : security === 'none' ? 25 : 587);

  const socket = await new Promise((resolve, reject) => {
    const opts = { host, port: portNumber, servername: net.isIP(host) ? undefined : host, ...tlsOptions };
    const s = security === 'tls' ? tls.connect(opts, () => resolve(s)) : net.connect(opts, () => resolve(s));
    s.once('error', reject);
    s.setTimeout(timeout, () => s.destroy(new Error('Connection to the mail server timed out.')));
  });
  const conn = new Connection(socket, timeout);
  try {
    const greeting = await conn.read();
    if (greeting.code !== 220) throw new Error(`Unexpected greeting: ${greeting.lines.join(' ')}`);
    const hello = `EHLO ${'nodeflix.local'}`;
    let ehlo = await conn.command(hello, [250]);

    if (security === 'starttls') {
      if (!ehlo.lines.some((l) => /STARTTLS/i.test(l))) throw new Error('The mail server does not offer STARTTLS. Try "SSL/TLS" (port 465) instead.');
      await conn.command('STARTTLS', [220]);
      const secure = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, ...tlsOptions }, () => resolve(t));
        t.once('error', reject);
      });
      conn.attach(secure);
      ehlo = await conn.command(hello, [250]);
    }

    if (user) {
      const offered = ehlo.lines.find((l) => /AUTH/i.test(l)) || '';
      const method = authMethod || (/PLAIN/i.test(offered) ? 'PLAIN' : 'LOGIN');
      if (method === 'PLAIN') {
        await conn.command(`AUTH PLAIN ${Buffer.from(`\0${user}\0${pass || ''}`).toString('base64')}`, [235], { secret: true });
      } else {
        await conn.command('AUTH LOGIN', [334]);
        await conn.command(Buffer.from(user).toString('base64'), [334], { secret: true });
        await conn.command(Buffer.from(pass || '').toString('base64'), [235], { secret: true });
      }
    }

    await conn.command(`MAIL FROM:<${sender.address}>`, [250]);
    for (const r of recipients) await conn.command(`RCPT TO:<${r.address}>`, [250, 251]);
    await conn.command('DATA', [354]);
    const domain = sender.address.split('@')[1];
    const headers = [
      `From: ${formatAddress(sender)}`,
      `To: ${recipients.map(formatAddress).join(', ')}`,
      `Subject: ${encodeWord(cleanSubject)}`,
      `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
      `Message-ID: <${crypto.randomUUID()}@${domain}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      'X-Mailer: NodeFlix',
    ];
    const body = wrap76(Buffer.from(String(text || '').replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64'));
    // Base64 lines never start with "." so no dot-stuffing is needed.
    await conn.command(`${headers.join('\r\n')}\r\n\r\n${body}\r\n.`, [250]);
    await conn.command('QUIT', [221]).catch(() => {});
  } finally {
    conn.socket.end();
  }
}
