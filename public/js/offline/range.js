// A stored file answered with byte ranges (v0.21), so the player can seek in a download with no connection. Used by
// the offline helper (sw.js) and its tests.

/** @param {Blob} blob @param {string|null} range the request's Range header @param {string} type */
export function rangeResponse(blob, range, type) {
  const size = blob.size;
  const base = { 'Content-Type': type || blob.type || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(range || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return new Response(blob, { status: 200, headers: { ...base, 'Content-Length': String(size) } });
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } });
  return new Response(blob.slice(start, end + 1), { status: 206, headers: { ...base, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` } });
}
