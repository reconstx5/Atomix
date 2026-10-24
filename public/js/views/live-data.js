// Live TV's data (v0.26): what one drawing of the page needs. Kept apart from views/live.js (the screen) so the
// router can start it while the screen's modules, Preact among them, are still arriving.
import { setTitle } from '../app.js';
import { channels as fetchChannels, groups as fetchGroups, liveStatus } from '../live.js';

let lastGroup = 'All'; // the chip chosen last time (kept while the page is reopened)
export const rememberGroup = (label) => (lastGroup = label);

/** The channels, the chips and the channels the chosen chip shows (a chip gone since falls back to All). */
export async function fetchAll(group) {
  const all = await fetchChannels();
  const names = await fetchGroups();
  const labels = [...(all.some((c) => c.favourite) ? ['Favourites'] : []), 'All', ...names];
  if (!labels.includes(group)) group = 'All';
  const shown = group === 'Favourites' ? await fetchChannels({ favourites: true }) : group === 'All' ? all : all.filter((c) => c.groups.includes(group));
  return { all, labels, group, shown };
}

export async function load() {
  setTitle('Live TV');
  const status = await liveStatus({ fresh: true });
  if (!status.enabled) return { status };
  return { status, ...(await fetchAll(lastGroup)) };
}
