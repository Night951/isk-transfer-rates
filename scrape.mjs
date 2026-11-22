// Reads exchange rates from Icelandic bank pages (every destination currency), Kantor Alior and the
// public APIs of monobank / PrivatBank, and writes public/rates.json for the ISK Transfer app.
// Run: node scrape.mjs
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { labels, findPair, findPairByValue, EUR_LABELS, USD_LABELS } from "./parser.mjs";

// keep in sync with Dest.java
const CODES = ["PLN", "EUR", "UAH", "GBP", "USD", "NOK", "SEK", "DKK", "CHF", "CZK", "HUF", "RON", "BRL", "PHP",
  "THB", "CAD", "AUD", "NZD", "JPY", "CNY", "HKD", "SGD", "ZAR"];
const IS_BANKS = [
  { id: "landsbankinn", urls: ["https://www.landsbankinn.is/en/markets/exchange-rates", "https://www.landsbankinn.is/markadir/gjaldmidlar"], cardTab: /^visa(-?gengi)?$/i },
  { id: "islandsbanki", urls: ["https://www.islandsbanki.is/en/article/exchange-rates", "https://www.islandsbanki.is/is/grein/gengi-gjaldmidla"], cardTab: /^mastercard(-?gengi)?$/i },
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

async function nbp() {
  const r = await fetch("https://api.nbp.pl/api/exchangerates/tables/A?format=json");
  const j = await r.json();
  return Object.fromEntries(j[0].rates.map((x) => [x.code, x.mid]));
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
  // card rate tab (a value is only trusted if it differs from the general rate)
  if (rates.EUR && bank.cardTab) {
    try {
      await page.evaluate((src) => {
        const re = new RegExp(src, "i");
        for (const el of document.querySelectorAll("button,a,li,[role=tab],span,div,label")) {
          if (re.test((el.innerText || el.textContent || "").trim())) { el.click(); return; }
        }
      }, bank.cardTab.source);
      await sleep(2500);
      const t = await page.evaluate(PAGE_TEXT);
      for (const c of CODES) {
        const v = parseCode(t, c, exp, 1), g = rates[c];
        if (v && (!g || v[0] !== g[0] || v[1] !== g[1])) out.card[c] = v[1];
      }
    } catch (e) { /* ignore */ }
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
    const a = await (await fetch("https://api.monobank.ua/bank/currency")).json();
    for (const o of a) {
      if (o.currencyCodeB !== 980) continue;
      if (o.currencyCodeA === 978 && ok(o.rateBuy, eE)) ua.monobank.eur = [o.rateBuy, o.rateSell];
      if (o.currencyCodeA === 840 && ok(o.rateBuy, eU)) ua.monobank.usd = [o.rateBuy, o.rateSell];
    }
  } catch (e) { console.log("monobank fail", e.message); }
  try {
    const a = await (await fetch("https://api.privatbank.ua/p24api/pubinfo?exchange&coursid=11")).json();
    for (const o of a) {
      if (o.base_ccy !== "UAH") continue;
      const b = parseFloat(o.buy), s = parseFloat(o.sale);
      if (o.ccy === "EUR" && ok(b, eE)) ua.privatbank.eur = [b, s];
      if (o.ccy === "USD" && ok(b, eU)) ua.privatbank.usd = [b, s];
    }
  } catch (e) { console.log("privatbank fail", e.message); }
  return ua;
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

mkdirSync("public", { recursive: true });
writeFileSync("public/rates.json", JSON.stringify(out, null, 2));
const ok = Object.values(out.banks).filter((b) => b.rates.EUR && b.rates.USD).length;
console.log(`OK: ${ok}/${IS_BANKS.length} Icelandic banks, Alior: ${out.alior.eur ? "yes" : "no"}`);
