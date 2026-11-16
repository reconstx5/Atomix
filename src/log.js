import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;
let fileOut = null; // v0.28: a copy of every line in data/logs/atomix.log

export function setLogLevel(level) {
  threshold = LEVELS[level] ?? LEVELS.info;
}

/**
 * Also write every line to `file` (appended). A file over `maxBytes` is moved to `<file>.1` first (one old copy kept),
 * so the log can't grow without end. A file that can't be opened is skipped with one console line.
 */
export function setLogFile(file, { maxBytes = 5 * 1024 * 1024 } = {}) {
  closeLogFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
    const fd = fs.openSync(file, 'a');
    fileOut = { fd, file };
  } catch (err) {
    console.warn(`Couldn't open the log file ${file}: ${err.message}`);
  }
}

export function closeLogFile() {
  if (!fileOut) return;
  try {
    fs.closeSync(fileOut.fd);
  } catch {
    /* already closed */
  }
  fileOut = null;
}

function write(level, scope, args) {
  if (LEVELS[level] < threshold) return;
  const time = new Date().toISOString().slice(11, 19);
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  const head = `${time} ${level.toUpperCase().padEnd(5)} [${scope}]`;
  fn(head, ...args);
  if (fileOut) {
    try {
      fs.writeSync(fileOut.fd, `${new Date().toISOString().slice(0, 10)} ${head} ${format(...args)}\n`);
    } catch {
      closeLogFile();
    }
  }
}

export function logger(scope) {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}
