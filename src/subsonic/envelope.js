// The Subsonic answer: { "subsonic-response": { status, version, type, serverVersion, openSubsonic, ...body } } as
// JSON, JSONP (f=jsonp&callback=name) or XML (the default). Always HTTP 200: a failure is status "failed" with an
// error element. XML follows the JSON one to one: a key with a plain value is an attribute, an object is a child
// element, an array is repeated child elements (plain values as their text), and a `value` key is the text itself.

export const API_VERSION = '1.16.1';

export class SubsonicError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const MESSAGES = {
  0: 'Not supported in Atomix',
  40: 'Wrong username or password.',
  43: 'Use either an API key or a username, not both.',
  44: "That API key isn't valid.",
  50: "This profile isn't allowed to do that.",
};

// Characters XML 1.0 can't carry at all (control characters, lone surrogates) are dropped; the rest escaped.
const esc = (v) => String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const plain = (v) => v === null || typeof v !== 'object';

function element(name, obj) {
  if (plain(obj)) return `<${name}>${esc(obj)}</${name}>`;
  let attrs = '';
  let kids = '';
  let text = '';
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (k === 'value' && plain(v)) text = esc(v);
    else if (Array.isArray(v)) for (const item of v) kids += element(k, item);
    else if (typeof v === 'object') kids += element(k, v);
    else attrs += ` ${k}="${esc(v)}"`;
  }
  return kids || text ? `<${name}${attrs}>${text}${kids}</${name}>` : `<${name}${attrs}/>`;
}

export function toXml(response) {
  const { status, ...rest } = response;
  return `<?xml version="1.0" encoding="UTF-8"?>\n${element('subsonic-response', { xmlns: 'http://subsonic.org/restapi', status, ...rest })}`;
}

export function envelope(serverVersion, status, body = {}) {
  return { status, version: API_VERSION, type: 'atomix', serverVersion, openSubsonic: true, ...body };
}

const CALLBACK = /^[A-Za-z_$][\w$.]{0,63}$/;

/** Write the answer in the format the request asked for. */
export function send(res, params, response) {
  const f = params.get('f');
  let type;
  let body;
  if (f === 'json' || (f === 'jsonp' && !CALLBACK.test(params.get('callback') || ''))) {
    type = 'application/json; charset=utf-8';
    body = JSON.stringify({ 'subsonic-response': response });
  } else if (f === 'jsonp') {
    type = 'application/javascript; charset=utf-8';
    body = `${params.get('callback')}(${JSON.stringify({ 'subsonic-response': response })});`;
  } else {
    type = 'text/xml; charset=utf-8';
    body = toXml(response);
  }
  if (res.headersSent) return;
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
