// ffmpeg reads a connected server's stream over HTTP: the sign-in travels as request headers.
/** One `-headers` block (each line CRLF-terminated, as ffmpeg wants), plus reconnects for a long read over HTTP. */
export function headerArgs(headers) {
  const h = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  return ['-headers', h, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
}

/** The same arguments for a log line: the header block (token or cookie) replaced. */
export function redactArgs(args) {
  return args.map((a, i) => (i > 0 && args[i - 1] === '-headers' ? '[redacted]' : a));
}
