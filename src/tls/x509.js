// A small X.509 certificate writer (v0.27): just what Atomix's own home certificate needs — a CA and a server
// certificate on EC P-256 keys, signed ECDSA with SHA-256 — in DER, from node:crypto's keys. No library: the
// encoding below is the subset of ASN.1 DER that certificates use (RFC 5280).
import crypto from 'node:crypto';

// ---- DER ----
function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, value) => Buffer.concat([Buffer.from([tag]), length(value.length), value]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts.filter(Boolean)));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octets = (buf) => tlv(0x04, buf);
const utf8 = (s) => tlv(0x0c, Buffer.from(String(s), 'utf8'));
const explicit = (n, inner) => tlv(0xa0 + n, inner);
/** A non-negative INTEGER from big-endian bytes (a leading zero when the top bit is set, none to spare). */
function integer(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}
/** A BIT STRING with `unused` bits left over in the last byte. */
const bits = (buf, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buf]));
function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
/** UTCTime before 2050, GeneralizedTime from 2050 on (RFC 5280 §4.1.2.5). */
function time(date) {
  const iso = new Date(date).toISOString(); // 2026-10-22T19:41:00.000Z
  const digits = iso.slice(0, 19).replace(/[-T:]/g, '') + 'Z'; // 20261022194100Z
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(digits.slice(2))) : tlv(0x18, Buffer.from(digits));
}
const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const extension = (id, critical, valueDer) => seq(oid(id), critical ? bool(true) : null, octets(valueDer));

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

/** The EC public key's point (04 ‖ x ‖ y): what the key identifier is a hash of. */
function point(publicKey) {
  const { x, y } = publicKey.export({ format: 'jwk' });
  return Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')]);
}
export const keyId = (publicKey) => crypto.createHash('sha1').update(point(publicKey)).digest();

function ipBytes(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) throw new Error(`Not an IPv4 address: ${ip}`);
  return Buffer.from(parts);
}

/**
 * makeCertificate({ subjectCN, issuerCN, publicKey, signingKey, serial, notBefore, notAfter, ca, san, issuerKey })
 * → { der, pem }. `publicKey`/`signingKey` are KeyObjects (EC P-256); `issuerKey` is the issuer's public key (for the
 * authority key identifier; the subject's own for a self-signed CA). `san` = { dns: [...], ip: [...] } or null.
 */
export function makeCertificate({ subjectCN, issuerCN, issuerName = null, publicKey, signingKey, serial, notBefore, notAfter, ca = false, san = null, issuerKey = publicKey, permitted = null }) {
  const extensions = [
    extension('2.5.29.19', true, ca ? seq(bool(true)) : seq()), // basicConstraints
    // keyUsage: a CA signs certificates (keyCertSign, cRLSign: bits 5 and 6); a server signs its handshakes (digitalSignature: bit 0).
    extension('2.5.29.15', true, ca ? bits(Buffer.from([0x06]), 1) : bits(Buffer.from([0x80]), 7)),
    !ca ? extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))) : null, // extKeyUsage serverAuth
    san ? extension('2.5.29.17', false, seq(...(san.dns || []).map((d) => tlv(0x82, Buffer.from(d))), ...(san.ip || []).map((ip) => tlv(0x87, ipBytes(ip))))) : null,
    // nameConstraints (a CA only): it may only vouch for these names and address ranges — a home CA can't stand in for
    // anyone else's website even if its key got out. `permitted` = { dns: ['local', …], ip: [['192.168.0.0', 16], …] }.
    ca && permitted
      ? extension('2.5.29.30', true, seq(tlv(0xa0, Buffer.concat([...(permitted.dns || []).map((d) => seq(tlv(0x82, Buffer.from(d)))), ...(permitted.ip || []).map(([ip, bitsLen]) => seq(tlv(0x87, Buffer.concat([ipBytes(ip), maskBytes(bitsLen)]))))]))))
      : null,
    extension('2.5.29.14', false, octets(keyId(publicKey))), // subjectKeyIdentifier
    extension('2.5.29.35', false, seq(tlv(0x80, keyId(issuerKey)))), // authorityKeyIdentifier
  ].filter(Boolean);
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ECDSA_SHA256,
    issuerName || name(issuerCN), // the issuer's subject exactly as its certificate has it (byte for byte)
    seq(time(notBefore), time(notAfter)),
    name(subjectCN),
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions)),
  );
  const signature = crypto.sign('sha256', tbs, { key: signingKey, dsaEncoding: 'der' });
  const der = seq(tbs, ECDSA_SHA256, bits(signature));
  return { der, pem: toPem(der) };
}

function maskBytes(n) {
  const out = Buffer.alloc(4);
  for (let i = 0; i < 4; i++) out[i] = n >= 8 * (i + 1) ? 0xff : n <= 8 * i ? 0 : (0xff << (8 - (n - 8 * i))) & 0xff;
  return out;
}

/** The elements inside a DER SEQUENCE at `buf` (each as its whole TLV). */
function children(buf) {
  const out = [];
  const read = (at) => {
    let len = buf[at + 1];
    let head = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i];
      head = 2 + n;
    }
    return { start: at, contentStart: at + head, end: at + head + len };
  };
  const outer = read(0);
  for (let at = outer.contentStart; at < outer.end; ) {
    const el = read(at);
    out.push(buf.subarray(el.start, el.end));
    at = el.end;
  }
  return out;
}
/** A certificate's subject Name, as its DER bytes (for the issuer field of the certificates it signs). */
export function subjectOf(der) {
  const tbs = children(der)[0];
  const parts = children(tbs);
  const at = parts[0][0] === 0xa0 ? 5 : 4; // [0] version present: serial, sigAlg, issuer, validity, subject
  return Buffer.from(parts[at]);
}

export const toPem = (der, label = 'CERTIFICATE') => `-----BEGIN ${label}-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
/** A positive 16-byte serial number. */
export function serialNumber() {
  const b = crypto.randomBytes(16);
  b[0] &= 0x7f;
  if (b[0] === 0) b[0] = 1;
  return b;
}
