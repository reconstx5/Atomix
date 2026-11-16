// The secure address (v0.27): a second listener, HTTPS on `httpsPort` (8443), serving the same app as the HTTP one.
// Browsers only allow encrypted video (and installing the app) on a secure page, so phones on the home network need
// it; computers, TVs and the plain address are unchanged. The certificate is Tailscale's (a real one for
// <computer>.<tailnet>.ts.net) or Atomix's own (a home CA each phone installs once).
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureOwnCertificates, lanAddresses, preferAddresses, mobileconfig } from './own.js';
import { findTailscale, tailscaleCertificate, needsRenewal, TailscaleError } from './tailscale.js';

const MODES = ['off', 'tailscale', 'own'];

export class HttpsManager {
  constructor({ handler, settings, config, log, dataDir = config.dataDir, tailscale = {}, now = () => new Date(), addresses = lanAddresses }) {
    this.handler = handler;
    this.settings = settings;
    this.config = config;
    this.log = log;
    this.dir = path.join(dataDir, 'certs');
    this.tailscale = { find: tailscale.find || (() => findTailscale()), certificate: tailscale.certificate || tailscaleCertificate };
    this.now = now;
    this.addresses = addresses;
    this.server = null;
    this.listenPort = null; // the port asked for when the listener started
    this.current = { mode: 'off', port: null, listening: false, secureUrl: null, sentence: null, command: null, name: null };
    this.caDer = null;
    this.running = Promise.resolve();
    this.pending = 0; // applies queued or running: Settings shows "Starting…" meanwhile
    this.timer = null;
    this.watch = null;
    this.names = []; // the names and addresses the certificate being served carries
    this.lastAddresses = null; // the home addresses the own certificate was made for
  }

  mode() {
    const m = this.settings.get('httpsMode');
    return MODES.includes(m) ? m : 'off';
  }
  port() {
    return this.config.httpsPort ?? (Number(this.settings.get('httpsPort')) || 8443);
  }
  state() {
    return { ...this.current, port: this.current.port ?? this.port(), portFixed: this.config.httpsPort != null, busy: this.pending > 0 };
  }

  /**
   * The secure address for a phone that reached Atomix by `hostHeader` ("192.168.1.20:8787"): the same name when the
   * certificate carries it (a phone's way to the PC is known to work), else the address chosen for everyone.
   */
  secureUrlFor(hostHeader) {
    const st = this.current;
    if (!st.listening || st.mode !== 'own') return st.secureUrl;
    const host = String(hostHeader || '').replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '').toLowerCase();
    const loopback = host === 'localhost' || /^127\./.test(host) || host === '::1';
    return host && !loopback && this.names.includes(host) ? `https://${host}:${st.port}` : st.secureUrl;
  }

  /** Start, stop or re-key the listener for the settings now. Never throws: a failure is the state's sentence. */
  apply() {
    this.pending += 1;
    this.running = this.running
      .then(() => this.#apply())
      .catch((err) => {
        this.log?.warn?.(`[https] ${err.message}`);
      })
      .finally(() => {
        this.pending -= 1;
      });
    return this.running.then(() => this.state());
  }

  async #apply() {
    const mode = this.mode();
    const port = this.port();
    const base = { mode, port, listening: false, secureUrl: null, sentence: null, command: null, name: null };
    if (mode === 'off') {
      await this.#stopListening();
      this.caDer = null;
      this.current = base;
      return;
    }
    let creds;
    try {
      creds = await this.#credentials(mode);
    } catch (err) {
      await this.#stopListening();
      this.names = [];
      this.current = { ...base, sentence: err.message, command: err instanceof TailscaleError ? err.command : null };
      return;
    }
    try {
      if (this.server && this.listenPort === port) this.server.setSecureContext({ key: creds.key, cert: creds.cert });
      else {
        await this.#stopListening();
        await this.#listen(port, creds);
      }
    } catch (err) {
      this.server = null;
      this.listenPort = null;
      this.current = { ...base, name: creds.name || null, sentence: portSentence(err, port) };
      return;
    }
    const actual = this.server.address().port;
    this.names = creds.names || [];
    const host = mode === 'tailscale' ? creds.name : preferAddresses(this.addresses())[0] || 'localhost';
    // A renewal that failed while the certificate still has days left: keep serving it, and say so.
    this.current = { ...base, port: actual, listening: true, name: creds.name || null, secureUrl: `https://${host}:${actual}`, sentence: creds.warning?.message || null, command: creds.warning?.command || null };
  }

  async #credentials(mode) {
    if (mode === 'own') {
      const addresses = this.addresses();
      this.lastAddresses = JSON.stringify(addresses);
      const own = ensureOwnCertificates({ dir: this.dir, serverName: this.settings.get('serverName') || 'Atomix', addresses, extraNames: this.config.httpsNames || [], now: this.now() });
      this.caDer = own.caDer;
      return { key: own.key, cert: own.cert, name: null, names: sanNames(own.cert) };
    }
    this.caDer = null;
    const certFile = path.join(this.dir, 'ts.crt');
    const keyFile = path.join(this.dir, 'ts.key');
    const have = () => (fs.existsSync(certFile) && fs.existsSync(keyFile) ? fs.readFileSync(certFile, 'utf8') : null);
    let cert = have();
    let warning = null;
    // A certificate with more than 30 days left is used as it is (one an administrator made with `tailscale cert`
    // included): Tailscale is only asked for a new one when it's due.
    if (needsRenewal(cert, this.now())) {
      try {
        await this.tailscale.certificate({ bin: this.tailscale.find(), dir: this.dir });
        cert = have();
      } catch (err) {
        const ends = validTo(cert);
        if (!ends || ends <= this.now()) throw err; // nothing usable to keep serving
        warning = { message: `The certificate ends on ${ends.toDateString()}: ${err.message}`, command: err.command || null };
      }
    }
    const names = sanNames(cert);
    return { key: fs.readFileSync(keyFile, 'utf8'), cert, name: names.find((n) => !/^\d+(\.\d+){3}$/.test(n)) || null, names, warning };
  }

  /** Every minute (own mode): a new home address remakes the certificate (the same CA: phones install nothing). */
  async checkAddresses() {
    if (this.mode() !== 'own' || this.lastAddresses == null || JSON.stringify(this.addresses()) === this.lastAddresses) return false;
    await this.apply();
    return true;
  }

  #listen(port, creds) {
    return new Promise((resolve, reject) => {
      const server = https.createServer({ key: creds.key, cert: creds.cert }, this.handler);
      server.requestTimeout = 0; // long-lived video streams, as on HTTP
      server.keepAliveTimeout = 65_000;
      server.headersTimeout = 66_000;
      server.once('error', reject);
      server.listen(port, this.config.host, () => {
        server.off('error', reject);
        server.on('error', (err) => this.log?.warn?.(`[https] ${err.message}`));
        this.server = server;
        this.listenPort = port;
        resolve();
      });
    });
  }

  async #stopListening() {
    const s = this.server;
    this.server = null;
    this.listenPort = null;
    if (!s) return;
    await new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections?.();
    });
  }

  /** A daily check: a certificate under 30 days from its end is renewed (and Atomix's own one remade if needed). */
  renewSoon() {
    clearInterval(this.timer);
    clearInterval(this.watch);
    this.timer = setInterval(() => {
      if (this.mode() !== 'off') this.apply();
    }, 86_400_000);
    this.timer.unref?.();
    this.watch = setInterval(() => this.checkAddresses().catch(() => {}), 60_000);
    this.watch.unref?.();
  }

  async close() {
    clearInterval(this.timer);
    clearInterval(this.watch);
    await this.running.catch(() => {});
    await this.#stopListening();
  }

  /** The home CA for phones: /tls/atomix-home-ca.crt (Android) and .mobileconfig (iPhone); only in `own` mode. */
  serveCa(req, res, url) {
    const file = url.pathname;
    if (file !== '/tls/atomix-home-ca.crt' && file !== '/tls/atomix-home-ca.mobileconfig') return false;
    if (this.mode() !== 'own' || !this.caDer) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return true;
    }
    if (file.endsWith('.crt')) {
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="atomix-home-ca.crt"', 'Cache-Control': 'no-cache' }).end(this.caDer);
    } else {
      const body = mobileconfig(this.caDer, { serverName: this.settings.get('serverName') || 'Atomix' });
      res.writeHead(200, { 'Content-Type': 'application/x-apple-aspen-config', 'Content-Disposition': 'attachment; filename="atomix-home-ca.mobileconfig"', 'Cache-Control': 'no-cache' }).end(body);
    }
    return true;
  }
}

/** The DNS names and IP addresses a PEM certificate (its first one) carries. */
function sanNames(pem) {
  try {
    return String(new crypto.X509Certificate(pem).subjectAltName || '')
      .split(/,\s*/)
      .map((e) => e.replace(/^(DNS|IP Address):/, '').toLowerCase())
      .filter(Boolean);
  } catch {
    return [];
  }
}
function validTo(pem) {
  try {
    return new Date(new crypto.X509Certificate(pem).validTo);
  } catch {
    return null;
  }
}

/** What a failed listen means, in a sentence for the Secure address card. */
export function portSentence(err, port) {
  if (err.code === 'EADDRINUSE') return `Port ${port} is in use; pick another port`;
  // v0.28: a port below 1024 (or one Windows keeps for itself) is refused, not busy.
  if (err.code === 'EACCES') return `Atomix isn't allowed to use port ${port}; pick another port (above 1024 usually works)`;
  return err.message;
}
