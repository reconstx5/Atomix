// Themes (skins): a folder in /themes with theme.json + theme.css.
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('themes');

export class Themes {
  constructor(config) {
    this.dir = config.themesDir;
  }

  list() {
    if (!fs.existsSync(this.dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const file = path.join(this.dir, entry.name, 'theme.json');
      if (!fs.existsSync(file)) continue;
      try {
        const t = JSON.parse(fs.readFileSync(file, 'utf8'));
        out.push({
          id: entry.name,
          name: t.name || entry.name,
          description: t.description || '',
          author: t.author || '',
          layout: ['side', 'orbit'].includes(t.layout) ? t.layout : 'top',
          colorScheme: t.colorScheme === 'light' ? 'light' : 'dark',
          preview: t.preview || {},
          css: `/themes/${encodeURIComponent(entry.name)}/${t.stylesheet || 'theme.css'}`,
        });
      } catch (err) {
        log.warn(`Bad theme.json in ${entry.name}: ${err.message}`);
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
