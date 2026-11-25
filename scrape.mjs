// Reads exchange rates from Icelandic bank pages (every destination currency), Kantor Alior and the
// public APIs of monobank / PrivatBank, and writes public/rates.json for the ISK Transfer app.
// Run: node scrape.mjs
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { labels, findPair, findPairByValue, EUR_LABELS, USD_LABELS } from "./parser.mjs";
import { snapshot, addDay, shouldSave, wiseModel, problems, persistent } from "./history.mjs";

// keep in sync with Dest.java
const CODES = ["PLN", "EUR", "UAH", "GBP", "USD", "NOK", "SEK", "DKK", "CHF", "CZK", "HUF", "RON", "BRL", "PHP",
  "THB", "CAD", "AUD", "NZD", "JPY", "CNY", "HKD", "SGD", "ZAR"];
const IS_BANKS = [
  { id: "landsbankinn", urls: ["https://www.landsbankinn.is/en/markets/exchange-rates", "https://www.landsbankinn.is/markadir/gjaldmidlar"], cardTab: /^visa(-?gengi)?$/i },
  { id: "islandsbanki", urls: ["https://www.islandsbanki.is/en/article/exchange-rates", "https://www.islandsbanki.is/is/grein/gengi-gjaldmidla"], cardTab: /^mastercard[\s-]?(gengi)?$/i },
  { id: "arion", urls: ["https://www.arionbanki.is/english/markets/currency-converter", "https://www.arionbanki.is/markadir/gjaldmidlar/"], cardTab: /^(visa|kort(a)?gengi|card rate)$/i },
];
const ALIOR_URLS = ["https://kantor.aliorbank.pl/", "https://kantor.aliorbank.pl/kursy-walut",
  "https://kantor.aliorbank.pl/forex/eur.html", "https://kantor.aliorbank.pl/forex/usd.html"];
const TOL = 0.04;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// visible text + every table row (including cells hidden by CSS)
const PAGE_TEXT = () => {
  const t = document.body ? document.body.innerText : "";
  const rows = [...document.querySelectorAll("tr,[role=row]")].map((r) =>
    [...r.querySelectorAll("td,th,[role=cell],[role=gridcell]")].map((c) => (c.textContent || "").trim()).join("\t"));
  return t + "\n@@ROWS@@\n" + rows.join("\n");
};

const HEADERS = {
  "Accept": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
};

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS });
  const t = await r.text();
  try { return JSON.parse(t); }
  catch { throw new Error(`HTTP ${r.status}, not JSON: ${t.slice(0, 120).replace(/\s+/g, " ")}`); }
}

/** Mid rates as PLN per 1 unit. NBP first; if it refuses GitHub's servers, a free fallback source. */
async function nbp() {
  for (const url of ["https://api.nbp.pl/api/exchangerates/tables/A/?format=json",
                     "https://api.nbp.pl/api/exchangerates/tables/a/?format=json"]) {
    for (let i = 0; i < 2; i++) {
      try {
        const j = await getJson(url);
        const m = Object.fromEntries(j[0].rates.map((x) => [x.code, x.mid]));
        if (m.EUR && m.ISK) { console.log("mid rates: NBP"); return m; }
      } catch (e) { console.log("NBP fail:", e.message); await sleep(3000); }
    }
  }
  // fallback: rates per 1 EUR → PLN per 1 unit
  const j = await getJson("https://open.er-api.com/v6/latest/EUR");
  const r = j.rates;
  if (!r || !r.PLN || !r.ISK) throw new Error("no mid rates from any source");
  const m = {};
  for (const [c, v] of Object.entries(r)) if (v > 0 && c !== "PLN") m[c] = r.PLN / v;
  console.log("mid rates: open.er-api.com (NBP unavailable)");
  return m;
}

/** ISK per unit of a currency, parsed with the same rules as the app (JPY/HUF may be quoted per 100). */
function parseCode(text, code, exp, maxValues = 2) {
  const e = exp[code];
  if (!(e > 0)) return null;
  let r = findPair(text, labels(code), e, TOL, maxValues);
  if (!r && maxValues === 2 && ["EUR", "USD", "PLN"].includes(code)) r = findPairByValue(text, e, 0.03);
  if (!r && (code === "JPY" || code === "HUF")) {
    const h = findPair(text, labels(code), e * 100, TOL, maxValues);
    if (h) r = [h[0] / 100, h[1] / 100];
  }
  return r;
}

async function load(page, url) {
  try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); return true; }
  catch (e) { console.log("load fail", url, e.message); return false; }
}

async function scrapeIs(browser, bank, exp) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
  const rates = {};
  let text = "";
  for (const url of bank.urls) {
    if (!(await load(page, url))) continue;
    for (let i = 0; i < 10; i++) {
      await sleep(1500);
      text = await page.evaluate(PAGE_TEXT).catch(() => "");
      for (const c of CODES) if (!rates[c]) { const v = parseCode(text, c, exp); if (v) rates[c] = v; }
      if (rates.EUR && rates.USD && i >= 3) break;
    }
    if (rates.EUR && rates.USD) break;
  }
  // single-rate tables as a last resort
  for (const c of CODES) if (!rates[c]) { const v = parseCode(text, c, exp, 1); if (v) rates[c] = v; }
  const out = { rates, card: {} };
  // card rate tab (e.g. "Visa"): a real mouse click on the visible tab, then wait until the table changes.
  // A value is only trusted if it differs from the general rate.
  if (rates.EUR && bank.cardTab) {
    try {
      const before = await page.evaluate(PAGE_TEXT);
      const tabs = page.locator("button, a, li, [role=tab], label, span, div").filter({ hasText: bank.cardTab }).filter({ visible: true });
      const n = await tabs.count();
      let clicked = false;
      // innermost matching element first (the last one in document order)
      for (let k = n - 1; k >= 0 && !clicked; k--) {
        const el = tabs.nth(k);
        const t = ((await el.innerText().catch(() => "")) || "").trim();
        if (!bank.cardTab.test(t)) continue;
        try { await el.click({ timeout: 3000 }); clicked = true; } catch { /* try the next one */ }
      }
      console.log(bank.id, "card tab", clicked ? "clicked" : `not found (${n} candidates)`);
      // wait until the page has changed AND has stopped changing (the new table may load in steps)
      let t = before, prev = before;
      for (let k = 0; k < 12 && clicked; k++) {
        await sleep(1000);
        t = await page.evaluate(PAGE_TEXT);
        if (t !== before && t === prev && k >= 2) break;
        prev = t;
      }
      if (clicked) {
        // diagnostics: what the card table looks like (helps adjust the parser)
        const lines = t.split("\n").filter((l) => /\b(PLN|EUR)\b/.test(l)).slice(0, 4);
        console.log(bank.id, "card tab sample:", JSON.stringify(lines.map((l) => l.slice(0, 160))));
      }
      for (const c of CODES) {
        if (t === before) break; // the tab did not change anything: no card rates
        const v = parseCode(t, c, exp, 2) || parseCode(t, c, exp, 1), g = rates[c];
        if (v && (!g || v[0] !== g[0] || v[1] !== g[1])) out.card[c] = v[1];
      }
    } catch (e) { console.log(bank.id, "card tab error:", e.message); }
  }
  await page.close();
  return out;
}

async function scrapeAlior(browser, n) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
  const res = {};
  for (const url of ALIOR_URLS) {
    if (!(await load(page, url))) continue;
    for (let i = 0; i < 10 && !(res.eur && res.usd); i++) {
      await sleep(1500);
      const t = await page.evaluate(PAGE_TEXT).catch(() => "");
      res.eur ||= findPair(t, EUR_LABELS, n.EUR, TOL, 2);
      res.usd ||= findPair(t, USD_LABELS, n.USD, TOL, 2);
    }
    if (res.eur && res.usd) break;
  }
  await page.close();
  return Object.fromEntries(Object.entries(res).filter(([, v]) => v));
}

async function ukraine(n) {
  const ua = { monobank: {}, privatbank: {} };
  const ok = (v, e) => v > 0 && Math.abs(v / e - 1) < 0.06;
  const eE = n.EUR / n.UAH, eU = n.USD / n.UAH;
  try {
    const a = await getJson("https://api.monobank.ua/bank/currency");
    for (const o of a) {
      if (o.currencyCodeB !== 980) continue;
      if (o.currencyCodeA === 978 && ok(o.rateBuy, eE)) ua.monobank.eur = [o.rateBuy, o.rateSell];
      if (o.currencyCodeA === 840 && ok(o.rateBuy, eU)) ua.monobank.usd = [o.rateBuy, o.rateSell];
    }
  } catch (e) { console.log("monobank fail", e.message); }
  try {
    const a = await getJson("https://api.privatbank.ua/p24api/pubinfo?exchange&coursid=11");
    for (const o of a) {
      if (o.base_ccy !== "UAH") continue;
      const b = parseFloat(o.buy), s = parseFloat(o.sale);
      if (o.ccy === "EUR" && ok(b, eE)) ua.privatbank.eur = [b, s];
      if (o.ccy === "USD" && ok(b, eU)) ua.privatbank.usd = [b, s];
    }
  } catch (e) { console.log("privatbank fail", e.message); }
  return ua;
}

// previously published file: Wise fees are reused for 6 hours, problems are compared with the last run
function pagesUrl() {
  if (process.env.PAGES_URL) return process.env.PAGES_URL.replace(/\/$/, "");
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || "/").split("/");
  return owner && repo ? `https://${owner.toLowerCase()}.github.io/${repo}` : "";
}
async function previous() {
  const base = pagesUrl();
  if (!base) return null;
  try { return await getJson(`${base}/rates.json?t=${Date.now()}`); } catch (e) { console.log("no previous rates.json:", e.message); return null; }
}

/** Wise: mid rate + fee model for EUR → every destination, from Wise's public comparison API. */
async function wise(prev) {
  if (prev && prev.wise && Date.now() - (prev.wiseMs || 0) < 6 * 3600 * 1000 && Object.keys(prev.wise).length >= 5)
    return { data: prev.wise, ms: prev.wiseMs };
  const q = async (target, amount) => {
    const j = await getJson(`https://api.wise.com/v3/comparisons/?sourceCurrency=EUR&targetCurrency=${target}&sendAmount=${amount}`);
    const w = (j.providers || []).find((p) => /wise/i.test(p.name || p.alias || ""));
    const quote = w && w.quotes && w.quotes[0];
    return quote ? { amount, rate: quote.rate, fee: quote.fee } : null;
  };
  const data = {};
  for (const c of CODES) {
    if (c === "EUR") continue;
    try {
      const m = wiseModel(await q(c, 1000), await q(c, 200));
      if (m) data[c] = m;
    } catch (e) { console.log("wise", c, e.message); }
    await sleep(400);
  }
  return { data, ms: Date.now() };
}

const n = await nbp();
const exp = Object.fromEntries(CODES.filter((c) => n[c] || c === "PLN").map((c) => [c, (c === "PLN" ? 1 : n[c]) / n.ISK]));
const browser = await chromium.launch();
const out = { version: 2, updatedMs: Date.now(), updated: new Date().toISOString(), nbp: n, banks: {}, alior: {}, ua: {} };
for (const b of IS_BANKS) {
  out.banks[b.id] = await scrapeIs(browser, b, exp);
  console.log(b.id, Object.keys(out.banks[b.id].rates).join(","), "card:", Object.keys(out.banks[b.id].card).join(","));
}
out.alior = await scrapeAlior(browser, n);
console.log("alior", JSON.stringify(out.alior));
await browser.close();
out.ua = await ukraine(n);
console.log("ua", JSON.stringify(out.ua));
const prev = await previous();
const w = await wise(prev);
out.wise = w.data; out.wiseMs = w.ms;
console.log("wise", Object.keys(out.wise).join(","));
out.problems = problems(out, IS_BANKS.map((b) => b.id));
console.log("problems", out.problems.join(", ") || "none");

mkdirSync("public", { recursive: true });
writeFileSync("public/rates.json", JSON.stringify(out, null, 2));

// daily history (kept in the repository: data/history.json, committed by the workflow at most once an hour)
mkdirSync("data", { recursive: true });
const HF = "data/history.json";
const hist = existsSync(HF) ? JSON.parse(readFileSync(HF, "utf8")) : { days: [] };
const day = new Date().toISOString().slice(0, 10);
const lastDay = hist.days && hist.days.length ? hist.days[hist.days.length - 1].d : "";
const updated = addDay(hist, day, snapshot(out, CODES));
if (shouldSave(hist.savedMs, lastDay, day, Date.now())) {
  updated.savedMs = Date.now();
  writeFileSync(HF, JSON.stringify(updated));
  writeFileSync("data/.save", "1"); // tells the workflow to commit
} else updated.savedMs = hist.savedMs;
writeFileSync("public/history.json", JSON.stringify(updated));
console.log(`history: ${updated.days.length} days`);

// alarm only for problems that were already there in the previous run
const alarm = persistent(out.problems, prev && prev.problems);
writeFileSync("problems.txt", alarm.join("\n"));
const ok = Object.values(out.banks).filter((b) => b.rates.EUR && b.rates.USD).length;
console.log(`OK: ${ok}/${IS_BANKS.length} Icelandic banks, Alior: ${out.alior.eur ? "yes" : "no"}`);
