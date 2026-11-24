// Pure helpers for the daily history of bank rates, the Wise fee model and the problem list (tested in test-parser.mjs).

export const KEEP_DAYS = 150;

/** One day's snapshot from a rates.json object: sell rates of Icelandic banks, buy rates of receivers, NBP mids. */
export function snapshot(out, codes) {
  const banks = {};
  for (const [id, b] of Object.entries(out.banks || {})) {
    const r = {};
    for (const [c, p] of Object.entries(b.rates || {})) if (Array.isArray(p) && p[1] > 0) r[c] = p[1];
    if (Object.keys(r).length) banks[id] = r;
  }
  const nbp = {};
  for (const c of [...codes, "ISK"]) if (out.nbp && out.nbp[c] > 0) nbp[c] = round(out.nbp[c], 6);
  const buy = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, p]) => Array.isArray(p) && p[0] > 0).map(([k, p]) => [k, p[0]]));
  return {
    banks, nbp,
    alior: buy(out.alior),
    ua: { monobank: buy(out.ua && out.ua.monobank), privatbank: buy(out.ua && out.ua.privatbank) },
  };
}

function round(v, d) { const k = 10 ** d; return Math.round(v * k) / k; }

/** Adds or replaces today's entry (the last reading of the day wins) and trims to KEEP_DAYS. */
export function addDay(history, day, snap) {
  const days = (history && Array.isArray(history.days) ? history.days : []).filter((x) => x && x.d !== day);
  days.push({ d: day, ...snap });
  days.sort((a, b) => (a.d < b.d ? -1 : 1));
  return { version: 1, days: days.slice(-KEEP_DAYS) };
}

/** True when the history file should be committed now: a new day, or the last save is at least `minMs` old. */
export function shouldSave(prevSavedMs, prevLastDay, day, nowMs, minMs = 55 * 60 * 1000) {
  return prevLastDay !== day || !(prevSavedMs > 0) || nowMs - prevSavedMs >= minMs;
}

/** Wise fee model from two quotes of the same pair: fee = fixed + pct% × amount. */
export function wiseModel(q1, q2) {
  if (!q1 || !q2 || !(q1.rate > 0) || q1.amount === q2.amount) return null;
  const pct = Math.max(0, (q1.fee - q2.fee) / (q1.amount - q2.amount)) * 100;
  const fixed = Math.max(0, q2.fee - (q2.amount * pct) / 100);
  return { rate: q1.rate, pct: round(pct, 4), fixed: round(fixed, 2) };
}

/** Readable list of what failed in this run (empty = all fine). */
export function problems(out, isBankIds) {
  const p = [];
  for (const id of isBankIds) {
    const r = out.banks && out.banks[id] && out.banks[id].rates;
    if (!r || !r.EUR || !r.USD) p.push(`bank:${id}`);
  }
  if (!out.alior || !out.alior.eur || !out.alior.usd) p.push("alior");
  if (!out.ua || !out.ua.monobank || !out.ua.monobank.eur) p.push("monobank");
  if (!out.ua || !out.ua.privatbank || !out.ua.privatbank.eur) p.push("privatbank");
  if (!out.wise || Object.keys(out.wise).length < 5) p.push("wise");
  return p;
}

/** Problems seen in this run and in the previous published file too (so one flaky run does not raise an alarm). */
export function persistent(now, previous) {
  const prev = new Set(previous || []);
  return now.filter((x) => prev.has(x));
}
