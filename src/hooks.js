// A small async event bus. Core code emits events; plugins subscribe.
import { logger } from './log.js';

const log = logger('hooks');

export class Hooks {
  constructor() {
    this.handlers = new Map(); // event -> [{fn, owner}]
  }

  on(event, fn, owner = 'core') {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push({ fn, owner });
    return () => this.off(event, fn);
  }

  off(event, fn) {
    const list = this.handlers.get(event);
    if (list) this.handlers.set(event, list.filter((h) => h.fn !== fn));
  }

  removeByOwner(owner) {
    for (const [event, list] of this.handlers) this.handlers.set(event, list.filter((h) => h.owner !== owner));
  }

  /** Run every handler; one failing handler never breaks the others. */
  async emit(event, payload) {
    const list = this.handlers.get(event);
    if (!list?.length) return;
    await Promise.all(
      list.map(async ({ fn, owner }) => {
        try {
          await fn(payload);
        } catch (err) {
          log.warn(`Handler for "${event}" from ${owner} failed: ${err.message}`);
        }
      }),
    );
  }
}
