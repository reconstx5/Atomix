// Which tile of the seek-bar preview sheets shows moment `t` (seconds). Pure, so
// it runs in the browser and in the Node tests.
export function tileFor(p, t) {
  if (!p || !(p.count > 0)) return null;
  const index = Math.min(p.count - 1, Math.max(0, Math.round((Number(t) || 0) / p.interval)));
  const perSheet = p.columns * p.rows;
  const inSheet = index % perSheet;
  return {
    url: p.url.replace('{n}', String(Math.floor(index / perSheet) + 1)),
    x: (inSheet % p.columns) * p.width,
    y: Math.floor(inSheet / p.columns) * p.height,
    width: p.width,
    height: p.height,
    sheetWidth: p.columns * p.width,
    sheetHeight: p.rows * p.height,
  };
}

/**
 * v0.28 card motion: up to `n` moments to flip through on a resting card, spread through the title but taken from at
 * most two preview sheets (one picture download each), and never from the opening or the end credits.
 * Returns tiles (as tileFor) with their time `t`, in order; [] when there is too little to animate.
 */
export function flipFrames(p, n = 8) {
  if (!p || !(p.count > 0)) return [];
  const first = Math.ceil(p.count * 0.05);
  const last = Math.floor(p.count * 0.9);
  if (last - first + 1 < 3) return [];
  const perSheet = p.columns * p.rows;
  const sheets = new Set([Math.floor((p.count * 0.3) / perSheet), Math.floor((p.count * 0.65) / perSheet)]);
  const pool = [];
  for (let i = first; i <= last; i++) if (sheets.has(Math.floor(i / perSheet))) pool.push(i);
  const take = Math.min(n, pool.length);
  const picked = [...new Set(Array.from({ length: take }, (_, k) => pool[Math.round((k * (pool.length - 1)) / Math.max(1, take - 1))]))];
  return picked.map((i) => ({ ...tileFor(p, i * p.interval), t: i * p.interval }));
}
