// Reads exchange rates from Icelandic bank pages (every destination currency), Kantor Alior and the
// public APIs of monobank / PrivatBank, and writes public/rates.json for the ISK Transfer app.
// Run: node scrape.mjs
import { chromium } from "playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { labels, findPair, findPairByValue, EUR_LABELS, USD_LABELS } from "./parser.mjs";
import { parseTax, parseNoTax } from "./tax.mjs";
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
// Polish banks and online kantors: rates for converting EUR/USD (and a few more) to PLN, as PLN per 1 unit.
// URLs in priority order (the online kantor first where it has its own table).
const PL_BANKS = [
  { id: "pko", urls: ["https://www.pkobp.pl/kantor-internetowy-kursy/", "https://www.pkobp.pl/waluty/", "https://www.pkobp.pl/kursy-walut/"] },
  { id: "mbank", urls: ["https://www.mbank.pl/serwis-ekonomiczny/kursy-walut/"] },
  { id: "pekao", urls: ["https://www.pekao.com.pl/kursy-walut/lista-walut.html"] },
  { id: "erste", urls: ["https://www.erste.pl/kursy-walut", "https://www.santander.pl/klient-indywidualny/karty-platnosci-i-przelewy/kursy-walut"] },
  { id: "ing", urls: ["https://www.ing.pl/indywidualni/narzedzia-i-informacje/kursy-walut", "https://www.ing.pl/kursy-walut", "https://www.ing.pl/indywidualni/tabela-kursow"] },
  { id: "millennium", urls: ["https://www.bankmillennium.pl/kursy-walut", "https://www.bankmillennium.pl/o-banku/serwis-ekonomiczny/kursy-walut"] },
  { id: "walutomat", urls: ["https://www.walutomat.pl/kursy-walut/", "https://www.walutomat.pl/kursy-walut/eur-pln/"] },
  { id: "internetowykantor", urls: ["https://internetowykantor.pl/kursy-walut/", "https://internetowykantor.pl/kurs-euro/"] },
];
const PL_CODES = ["EUR", "USD", "GBP", "CHF", "NOK", "SEK", "DKK"];
// Norwegian banks (sending side when the app is set to Norway): NOK per 1 unit, [bank buys, bank sells]
const NO_BANKS = [
  { id: "dnb", urls: ["https://www.dnb.no/bedrift/markets/valuta-renter/kursliste/overforsel/daglig", "https://www.dnb.no/markets/valuta-og-renter/valutakurser/valutakurs-overforsel-daglig"] },
  { id: "nordea", urls: ["https://www.nordea.no/privat/vare-produkter/konto-og-betalinger/valutakurser.html#tab=Daglige-kurser---Overforinger-Sjekker", "https://www.nordea.no/privat/vare-produkter/konto-og-betalinger/valutakurser-og-valutakalkulator.html"] },
  { id: "sparebank1", urls: ["https://www.sparebank1.no/nb/sr-bank/privat/daglig-bruk/valuta/valutakurser.html", "https://www.sparebank1.no/nb/bank/privat/daglig-bruk/valuta/valutakurser.html", "https://www.sparebank1.no/content/dam/SB1/bank/sr-bank/markedsrapporter/markets/daglig_oppdatering/dagens_valutakurser.pdf"] },
];
// banks abroad: their rate for converting incoming EUR/USD into the local currency (local units per 1 EUR/USD)
const FX_BANKS = [
  { id: "fio", ccy: "CZK", urls: ["https://www.fio.cz/bankovni-sluzby/kurzovni-listek", "https://www.fio.cz/akcie-investice/dalsi-sluzby-fio/devizove-konverze"] },
  { id: "csas", ccy: "CZK", urls: ["https://www.csas.cz/cs/kurzovni-listek", "https://www.csas.cz/cs/kurzovni-listek#/"] },
  { id: "airbank", ccy: "CZK", urls: ["https://www.airbank.cz/kurzovni-listek/"] },
  { id: "bcr", ccy: "RON", urls: ["https://www.bcr.ro/ro/curs-valutar", "https://www.bcr.ro/ro/persoane-fizice/curs-valutar"] },
  { id: "ingro", ccy: "RON", urls: ["https://www.ing.ro/curs-valutar", "https://ing.ro/persoane-fizice/curs-valutar"] },
  { id: "oschad", ccy: "UAH", urls: ["https://www.oschadbank.ua/currency-rate", "https://www.oschadbank.ua/en/currency-rate"] },
  { id: "pumb", ccy: "UAH", urls: ["https://about.pumb.ua/info/currency_converter", "https://www.pumb.ua/"] },
];
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
      // record JSON replies the page loads after the click (the card table may come from an API)
      const seen = [];
      const onResp = async (r) => {
        try {
          const ct = r.headers()["content-type"] || "";
          if (!/json/i.test(ct)) return;
          const body = await r.text();
          seen.push({ url: r.url(), body });
        } catch { /* ignore */ }
      };
      page.on("response", onResp);
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
        // the card table fills in a few seconds later; its data also comes as JSON (Landsbankinn: GraphQL)
        await sleep(3000);
        t = await page.evaluate(PAGE_TEXT);
        page.off("response", onResp);
        const src = /visa/i.test(bank.cardTab.source) ? "visa" : "mastercard";
        for (const x of seen) {
          let j; try { j = JSON.parse(x.body); } catch { continue; }
          for (const part of Array.isArray(j) ? j : [j]) {
            const edges = part?.data?.exchangeRates?.edges || [];
            for (const e of edges) {
              const r = e?.node; if (!r || r.quoteCurrency !== "ISK" || !CODES.includes(r.baseCurrency)) continue;
              if (String(r.source || "").toLowerCase() !== src) continue;
              let v = Number(r.sell); if (!(v > 0)) continue;
              const m = exp[r.baseCurrency];
              if (m > 0) { if (v / m > 30) v /= 100; if (v / m < 0.5 || v / m > 2) continue; } // per-100 quotes, sanity
              out.card[r.baseCurrency] = Math.round(v * 1e4) / 1e4;
            }
          }
        }
        console.log(bank.id, "card from api:", Object.keys(out.card).length, "currencies", out.card.PLN ? `PLN=${out.card.PLN}` : "");
      }
      if (!Object.keys(out.card).length) page.off("response", onResp);
      for (const c of CODES) {
        if (out.card[c]) continue;
        if (t === before) break; // the tab did not change anything: no card rates
        let v = parseCode(t, c, exp, 2) || parseCode(t, c, exp, 1);
        if (!v && exp[c] > 0) {
          // calculator view: amount of the currency you get for 1 000 ISK → ISK per unit = 1000 / amount
          const inv = { ...exp, [c]: 1000 / exp[c] };
          const w = parseCode(t, c, inv, 1);
          if (w) v = [1000 / w[1], 1000 / w[0]];
        }
        const g = rates[c];
        if (v && (!g || Math.abs(v[1] - g[1]) > 1e-9)) out.card[c] = Math.round(v[1] * 1e4) / 1e4;
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

/** One Polish bank/kantor: {rates: {EUR: [buy, sell], …}, url}. Dismisses cookie banners first. */
async function scrapePl(browser, bank, n) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 }, locale: "pl-PL" });
  const exp = Object.fromEntries(PL_CODES.filter((c) => n[c]).map((c) => [c, n[c]]));
  const rates = {};
  let used = "";
  for (const url of bank.urls) {
    if (!(await load(page, url))) continue;
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      if (i === 1) {
        for (const re of [/^(akceptuj|zaakceptuj|zgadzam|accept|ok|rozumiem)/i]) {
          const b = page.locator("button, a").filter({ hasText: re }).filter({ visible: true }).first();
          try { if (await b.count()) await b.click({ timeout: 1500 }); } catch { /* ignore */ }
        }
      }
      const text = await page.evaluate(PAGE_TEXT).catch(() => "");
      // table rows first (summary boxes often show only the mid rate), then the whole page
      const rows = text.split("@@ROWS@@")[1] || "";
      for (const c of PL_CODES) {
        if (rates[c] || !exp[c]) continue;
        for (const part of [rows, text]) {
          const v = findPair(part, labels(c), exp[c], TOL, 2);
          if (v && Math.max(...v) > Math.min(...v)) { rates[c] = [Math.min(...v), Math.max(...v)]; break; }
        }
      }
      if (rates.EUR && rates.USD && i >= 2) break;
    }
    if (rates.EUR) { used = url; break; }
  }
  if (rates.EUR && !(rates.EUR[1] > rates.EUR[0])) { console.log(bank.id, "EUR buy = sell, ignored"); for (const c of Object.keys(rates)) if (!(rates[c][1] > rates[c][0])) delete rates[c]; }
  if (!rates.EUR || process.env.PL_DEBUG === bank.id) {
    const t = await page.evaluate(PAGE_TEXT).catch(() => "");
    const k = t.search(/EUR/);
    console.log(bank.id, "no EUR; sample:", JSON.stringify(t.slice(Math.max(0, k - 200), k + 300)).slice(0, 600));
  }
  await page.close();
  return { rates, url: used };
}

/** A bank abroad: {ccy, rates: {EUR: [buy, sell], USD: […]}, url}; local units per 1 EUR/USD. */
async function scrapeFx(browser, bank, n) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 } });
  const loc = n[bank.ccy];
  const exp = loc ? { EUR: n.EUR / loc, USD: n.USD / loc } : {};
  const rates = {};
  let used = "";
  for (const url of bank.urls) {
    if (!loc || !(await load(page, url))) continue;
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      if (i === 1) {
        const b = page.locator("button, a").filter({ hasText: /^(accept|acceptă|accepta|souhlas|přijmout|akceptuj|aceitar|aceito|прийняти|погоджуюсь|ok|rozumím|sunt de acord)/i }).filter({ visible: true }).first();
        try { if (await b.count()) await b.click({ timeout: 1500 }); } catch { /* ignore */ }
      }
      const text = await page.evaluate(PAGE_TEXT).catch(() => "");
      const rows = text.split("@@ROWS@@")[1] || "";
      for (const c of ["EUR", "USD"]) {
        if (rates[c]) continue;
        for (const part of [rows, text]) {
          const v = findPair(part, labels(c), exp[c], TOL, 2);
          if (v && Math.max(...v) > Math.min(...v)) { rates[c] = [Math.min(...v), Math.max(...v)]; break; }
        }
      }
      if (rates.EUR && rates.USD && i >= 2) break;
    }
    if (rates.EUR) { used = url; break; }
  }
  if (!rates.EUR) {
    const t = await page.evaluate(PAGE_TEXT).catch(() => "");
    const k = t.search(/EUR/);
    console.log(bank.id, "no EUR (exp", exp.EUR && exp.EUR.toFixed(3), "); sample:", JSON.stringify(t.slice(Math.max(0, k - 150), k + 250)).slice(0, 450));
  }
  await page.close();
  return { ccy: bank.ccy, rates, url: used };
}

/** A Norwegian bank's rate table: NOK per 1 unit for every code NBP knows (per-100 quotes scaled). */
async function scrapeNo(browser, bank, n) {
  const page = await browser.newPage({ viewport: { width: 1366, height: 1000 }, locale: "nb-NO" });
  const nok = n.NOK;
  n = { ...n, PLN: 1 }; // NBP quotes everything in PLN
  const codes = CODES.filter((c) => c !== "NOK" && n[c]);
  const rates = {};
  let used = "";
  for (const url of bank.urls) {
    if (!nok || !(await load(page, url))) continue;
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      if (i === 1) {
        const b = page.locator("button, a").filter({ hasText: /^(godta|aksepter|jeg forstår|ok|tillat alle|godkjenn)/i }).filter({ visible: true }).first();
        try { if (await b.count()) await b.click({ timeout: 1500 }); } catch { /* ignore */ }
      }
      let text = await page.evaluate(PAGE_TEXT).catch(() => "");
      for (const f of page.frames()) if (f !== page.mainFrame()) text += "\n" + (await f.evaluate(() => document.body ? document.body.innerText : "").catch(() => ""));
      const rows = text.split("@@ROWS@@")[1] || "";
      for (const c of codes) {
        if (rates[c]) continue;
        const e = n[c] / nok;
        for (const part of [rows, text]) {
          let v = findPair(part, labels(c), e, TOL, 2), k = 1;
          if (!v) { v = findPair(part, labels(c), e * 100, TOL, 2); k = 100; }
          if (v && Math.max(...v) > Math.min(...v)) { rates[c] = [v[0] / k, v[1] / k]; break; }
        }
      }
      if (rates.EUR && rates.PLN && i >= 2) break;
    }
    if (rates.EUR) { used = url; break; }
  }
  if (!rates.EUR) {
    const t = await page.evaluate(PAGE_TEXT).catch(() => "");
    const k = t.search(/EUR/);
    console.log(bank.id, "no EUR; sample:", JSON.stringify(t.slice(Math.max(0, k - 150), k + 250)).slice(0, 450));
  }
  await page.close();
  return { rates, url: used };
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
out.pl = {};
for (const b of PL_BANKS) {
  try { out.pl[b.id] = await scrapePl(browser, b, n); } catch (e) { console.log(b.id, "fail", e.message); out.pl[b.id] = { rates: {} }; }
  const r = out.pl[b.id].rates;
  console.log("pl", b.id, Object.keys(r).join(","), r.EUR ? `EUR ${r.EUR.join("/")} (NBP ${n.EUR})` : "", out.pl[b.id].url || "");
}

console.log("alior", JSON.stringify(out.alior));
out.no = {};
for (const b of NO_BANKS) {
  try { out.no[b.id] = await scrapeNo(browser, b, n); } catch (e) { console.log(b.id, "fail", e.message); out.no[b.id] = { rates: {} }; }
  const r = out.no[b.id].rates;
  console.log("no", b.id, Object.keys(r).length, "codes", r.EUR ? `EUR ${r.EUR.join("/")}` : "-", r.PLN ? `PLN ${r.PLN.join("/")}` : "-", out.no[b.id].url || "");
}
out.fx = {};
for (const b of FX_BANKS) {
  try { out.fx[b.id] = await scrapeFx(browser, b, n); } catch (e) { console.log(b.id, "fail", e.message); out.fx[b.id] = { ccy: b.ccy, rates: {} }; }
  const r = out.fx[b.id].rates;
  console.log("fx", b.id, b.ccy, r.EUR ? `EUR ${r.EUR.join("/")}` : "-", r.USD ? `USD ${r.USD.join("/")}` : "-", out.fx[b.id].url || "");
}
const prev = await previous();
// Icelandic withholding tax for the salary calculator (re-read every 6 hours)
out.tax = prev && prev.tax && Date.now() - (prev.tax.ms || 0) < 6 * 3600 * 1000 ? prev.tax : null;
if (!out.tax) {
  const page = await browser.newPage();
  const y = new Date().getUTCFullYear();
  for (const year of [y, y - 1]) {
    const url = `https://www.skatturinn.is/einstaklingar/helstutolur/${year}/`;
    if (!(await load(page, url))) continue;
    await sleep(1500);
    const t = await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => "");
    const r = parseTax(t, year);
    if (r) { out.tax = { ...r, src: url, ms: Date.now() }; break; }
    console.log("tax: not parsed from", url, JSON.stringify(t.slice(t.indexOf("Skattþrep"), t.indexOf("Skattþrep") + 300)));
  }
  await page.close();
  if (!out.tax && prev && prev.tax) out.tax = prev.tax; // keep the last known values
}
console.log("tax", JSON.stringify(out.tax));
// Norway: tax rules for the salary calculator from skatteetaten.no (re-read every 6 hours)
out.taxno = prev && prev.taxno && Date.now() - (prev.taxno.ms || 0) < 6 * 3600 * 1000 ? prev.taxno : null;
if (!out.taxno) {
  const page = await browser.newPage();
  const y = new Date().getUTCFullYear();
  for (const year of [y, y - 1]) {
    const parts = [];
    for (const slug of ["personfradrag", "minstefradrag", "trinnskatt", "trygdeavgift"]) {
      const url = `https://www.skatteetaten.no/satser/${slug}/?year=${year}`;
      if (!(await load(page, url))) continue;
      await sleep(1500);
      parts.push(await page.evaluate(() => document.body ? document.body.innerText : "").catch(() => ""));
    }
    const r = parseNoTax(parts.join("\n#####\n"), year);
    if (r) { out.taxno = { ...r, paye: 25, payeNoTryg: 17.4, src: "https://www.skatteetaten.no/satser/", ms: Date.now() }; break; }
    console.log("taxno: not parsed for", year);
  }
  await page.close();
  if (!out.taxno && prev && prev.taxno) out.taxno = prev.taxno;
}
console.log("taxno", JSON.stringify(out.taxno));
await browser.close();
out.ua = await ukraine(n);
console.log("ua", JSON.stringify(out.ua));
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
