// A provider's address request (a source's stream()) that never answers mustn't hang a start or a tuner's restart.
export const RESOLVE_TIMEOUT_MS = 15_000;

export class ResolveTimeout extends Error {
  constructor() {
    super("The channel's provider didn't answer");
    this.code = 'RESOLVE_TIMEOUT';
  }
}

/** The promise's result, or a ResolveTimeout after `ms`. */
export function withTimeout(promise, ms = RESOLVE_TIMEOUT_MS) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ResolveTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), late]).finally(() => clearTimeout(timer));
}
