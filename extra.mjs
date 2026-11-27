// Banks read from JSON endpoints / PDFs found behind their public rate pages (Nov 2026).
// Every function returns {EUR: [buy, sell], USD: [...]} in local currency per 1 unit (bank buys = what you get
// for incoming EUR/USD), or for sending banks {CODE: [buy, sell], ...} in home currency per 1 unit.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/** Body of {@code url}: plain fetch first, then the browser (some endpoints want cookies from the page). */
export async function getBody(browser, url, pageUrl) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json, text/plain, */*" } });
    if (r.ok) { const t = await r.text(); if (t.length > 20) return t; }
  } catch { /* fall through */ }
  const page = await browser.newPage();
  try {
    if (pageUrl) { await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}); }
    const t = await page.evaluate(async (u) => { const r = await fetch(u, { credentials: "include" }); return r.ok ? r.text() : ""; }, url).catch(() => "");
    if (t) return t;
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return resp ? await resp.text() : "";
  } finally { await page.close(); }
}

/** Every object in a parsed JSON tree. */
function* objects(o) {
  if (Array.isArray(o)) { for (const x of o) yield* objects(x); }
  else if (o && typeof o === "object") { yield o; for (const v of Object.values(o)) yield* objects(v); }
}

const num = (v) => typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", "."));
const ymd = (d) => d.toISOString().slice(0, 10);
const daysBack = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; };

/** Keeps pairs within {@code tol} of the expected mid and with buy < sell. */
export function sane(rates, exp, tol = 0.08) {
  const out = {};
  for (const [c, v] of Object.entries(rates)) {
    const e = exp[c];
    if (!v || !(v[0] > 0) || !(v[1] >= v[0]) || !(e > 0)) continue;
    if (Math.abs(v[0] / e - 1) <= tol && Math.abs(v[1] / e - 1) <= tol) out[c] = [+v[0].toFixed(6), +v[1].toFixed(6)];
  }
  return out;
}

// ---- receiving banks (local per 1 EUR/USD)

export const API_FX = [
  {
    id: "csob", ccy: "CZK", page: "https://www.csob.cz/lide/kurzovni-listek",
    async read(browser) {
      for (let k = 0; k < 5; k++) {
        const d = ymd(daysBack(k));
        const t = await getBody(browser, `https://www.csob.cz/spa/exrate/exrates/overview/exrates?date=${d}T00:00:00.000%2B00:00`, this.page);
        const r = {};
        try { for (const o of objects(JSON.parse(t))) if ((o.currency === "EUR" || o.currency === "USD") && o.cashless) r[o.currency] = [num(o.cashless.purchase) / (o.unit || 1), num(o.cashless.sale) / (o.unit || 1)]; } catch { /* next day */ }
        if (r.EUR) return r;
      }
      return {};
    },
  },
  {
    id: "otp", ccy: "HUF", page: "https://www.otpbank.hu/portal/hu/arfolyamok/otp",
    async read(browser) {
      for (let k = 0; k < 5; k++) {
        const t = await getBody(browser, `https://www.otpbank.hu/apps/exchangerate/api/exchangerate/otp/${ymd(daysBack(k))}`, this.page);
        try {
          const j = JSON.parse(t), day = (j.dates || []).slice(-1)[0], ver = day && day.versions.slice(-1)[0];
          const r = {};
          for (const o of (ver && ver.exchangeRates) || []) if (o.currencyCode === "EUR" || o.currencyCode === "USD")
            r[o.currencyCode] = [o.foreignExchangeBuyingRate / (o.unitSize || 1), o.foreignExchangeSellingRate / (o.unitSize || 1)];
          if (r.EUR) return r;
        } catch { /* next day */ }
      }
      return {};
    },
  },
  {
    id: "icbc", ccy: "CNY", page: "https://www.icbc.com.cn/column/1438058341489590354.html",
    async read(browser) {
      const t = await getBody(browser, "https://papi.icbc.com.cn/exchanges/ns/getLatest", this.page);
      const r = {};
      for (const o of objects(JSON.parse(t))) if (o.currencyENName === "EUR" || o.currencyENName === "USD")
        r[o.currencyENName] = [num(o.foreignBuy) / 100, num(o.foreignSell) / 100];
      return r;
    },
  },
  {
    id: "dbs", ccy: "SGD", page: "https://www.dbs.com.sg/personal/rates-online/foreign-currency-foreign-exchange.page",
    async read(browser) {
      const t = await getBody(browser, `https://www.dbs.com.sg/sg-rates-api/v1/api/sgrates/getCurrencyConversionRates?FETCH_LATEST=${Date.now()}`, this.page);
      const r = {};
      for (const o of objects(JSON.parse(t))) if (o.quoteCurrency === "SGD" && (o.currency === "EUR" || o.currency === "USD"))
        r[o.currency] = [num(o.ttBuy) / num(o.baseCurrencyUnit || 1), num(o.ttSell) / num(o.baseCurrencyUnit || 1)];
      return r;
    },
  },
  {
    id: "hangseng", ccy: "HKD", page: "https://www.hangseng.com/en-hk/personal/banking/rates/foreign-exchange-rates/",
    async read(browser) {
      const t = await getBody(browser, "https://rbwm-api.hsbc.com.hk/pws-hk-hase-rates-papi-prod-proxy/v1/fxtt-exchange-rates?isIncludeCcyNameLang=N", this.page);
      const r = {};
      for (const o of objects(JSON.parse(t))) if (o.ccyCode === "EUR" || o.ccyCode === "USD") r[o.ccyCode] = [num(o.ttBuyRate), num(o.ttSellRate)];
      return r;
    },
  },
  {
    id: "cba", ccy: "AUD", page: "https://www.commbank.com.au/international/foreign-exchange-rates.html",
    async read(browser) {
      // quoted as foreign currency per 1 AUD: the bank buys EUR at bbImt → AUD per EUR = 1 / bbImt
      const t = await getBody(browser, `https://www.commbank.com.au/content/data/forex-rates/AUD.json?path=${Date.now()}`, this.page);
      const r = {};
      for (const o of objects(JSON.parse(t))) if ((o.currencyTitle === "EUR" || o.currencyTitle === "USD") && num(o.bbImt) > 0 && num(o.bsImt) > 0)
        r[o.currencyTitle] = [1 / num(o.bbImt), 1 / num(o.bsImt)];
      return r;
    },
  },
  {
    id: "anz", ccy: "AUD", page: "https://www.anz.com.au/personal/travel-international/foreign-exchange-rates/",
    async read(browser) {
      const t = await getBody(browser, `https://www.anz.com/productdata/fxrates/fxrates.asp?callback=cb&_=${Date.now()}`, this.page);
      const j = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
      const r = {};
      for (const c of ["EUR", "USD"]) { const o = j.rates && j.rates[c]; if (o && o.ttbuy > 0 && o.ttsel > 0) r[c] = [1 / o.ttbuy, 1 / o.ttsel]; }
      return r;
    },
  },
  {
    id: "scotia", ccy: "CAD", page: "https://www.scotiabank.com/ca/en/personal/rates-prices/foreign-exchange-rates.html",
    async read(browser) {
      // CLIENT_SELL = the client sells the currency to the bank
      const t = await getBody(browser, "https://dmtsms.scotiabank.com/api/rates/fxr", this.page);
      const r = {};
      for (const o of objects(JSON.parse(t))) if ((o.CURRENCY_CODE === "EUR" || o.CURRENCY_CODE === "USD") && num(o.CLIENT_SELL) > 0)
        r[o.CURRENCY_CODE] = [num(o.CLIENT_SELL), num(o.CLIENT_BUY)];
      return r;
    },
  },
  {
    id: "boc", ccy: "CNY", page: "https://www.boc.cn/sourcedb/whpj/enindex_1619.html",
    async read(browser) {
      // columns: buying rate, cash buying, selling rate, cash selling, middle — per 100 units
      const t = await getBody(browser, this.page);
      const r = {};
      for (const c of ["EUR", "USD"]) {
        const m = t.match(new RegExp(`>\\s*${c}\\s*<[\\s\\S]*?>\\s*([\\d.]+)\\s*<[\\s\\S]*?>\\s*([\\d.]+)\\s*<[\\s\\S]*?>\\s*([\\d.]+)\\s*<`));
        if (m) r[c] = [num(m[1]) / 100, num(m[3]) / 100];
      }
      return r;
    },
  },
  {
    id: "absa", ccy: "ZAR", page: "https://www.absa.co.za/indices/exchange-rates/",
    text: true, // row of several buying and selling rates: best below the mid = TT buy, best above = TT sell
  },
];

// ---- sending banks (home currency per 1 unit, every code)

/** SEB Sweden: avista (transfer) rates, SEK per unit. */
export async function seb(browser) {
  const t = await getBody(browser, "https://seb.se/ssc/trading/fx-rates-bff/api/rates/avista", "https://seb.se/marknaden-och-kurslistor/valutakurser-avistakurser");
  const r = {};
  for (const o of objects(JSON.parse(t))) {
    if (!Array.isArray(o.data)) continue;
    const v = o.data.map((x) => x && x.value);
    if (typeof v[0] === "string" && /^[A-Z]{3}$/.test(v[0])) {
      const nums = v.slice(1).map(num).filter((x) => x > 0);
      if (nums.length >= 2) r[v[0]] = [nums[0], nums[1]];
    }
  }
  return r;
}

/** SpareBank 1 Sør-Norge daily PDF: "<units> <CODE> mid buy sell (transfer) cashBuy cashSell", NOK per unit. */
export async function sparebank1() {
  const res = await fetch("https://www.sparebank1.no/content/dam/SB1/bank/sr-bank/markedsrapporter/markets/daglig_oppdatering/dagens_valutakurser.pdf", { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const { default: pdf } = await import("pdf-parse/lib/pdf-parse.js");
  const text = (await pdf(Buffer.from(await res.arrayBuffer()))).text;
  const r = parseSb1(text);
  if (!r.EUR) console.log("sb1 pdf text sample:", JSON.stringify(text.slice(0, 600)));
  return r;
}

export function parseSb1(text) {
  const r = {};
  const re = /(\d{1,3})\s*([A-Z]{3})\s*((?:\d+[.,]\d{2,4}\s*){3,})/g;
  let m;
  while ((m = re.exec(text))) {
    const units = parseInt(m[1], 10), nums = (m[3].match(/\d+[.,]\d{2,4}/g) || []).map(num).filter((x) => x > 0);
    if (!(units > 0) || !nums || nums.length < 3 || r[m[2]]) continue;
    r[m[2]] = [nums[1] / units, nums[2] / units];
  }
  return r;
}
