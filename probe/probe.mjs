// Probe candidate rate pages: page text around EUR/USD + JSON/XML/CSV network responses that contain rates.
import { chromium } from "playwright";
const G = JSON.parse(process.env.PROBE || "[]");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
for (const [id, url] of G) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 1000 }, locale: "en-US",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" });
  const page = await ctx.newPage();
  const hits = [];
  page.on("response", async (r) => {
    try {
      const ct = (r.headers()["content-type"] || "");
      if (!/json|xml|csv|text\/plain|javascript/.test(ct) || /\.js(\?|$)/.test(r.url()) && !/json/.test(ct)) return;
      const b = await r.text();
      if (/EUR/.test(b) && /\d[.,]\d{2,}/.test(b) && b.length < 3e6) hits.push(`${r.status()} ${ct.split(";")[0]} ${b.length}B ${r.url().slice(0, 220)}\n      ${b.replace(/\s+/g, " ").slice(Math.max(0, b.indexOf("EUR") - 150), b.indexOf("EUR") + 350)}`);
    } catch {}
  });
  let st = "?";
  try { const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 35000 }); st = resp ? resp.status() : "null"; }
  catch (e) { st = "ERR " + e.message.split("\n")[0]; }
  await sleep(9000);
  let text = "";
  try { text = await page.evaluate(() => document.body ? document.body.innerText : ""); } catch {}
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => /\b(EUR|USD)\b/.test(l) && /\d/.test(l)).slice(0, 6);
  console.log(`\n### ${id} [${st}] ${url}\n  title: ${await page.title().catch(() => "")}\n  final: ${page.url()}`);
  console.log("  text: " + (lines.length ? lines.join(" | ").slice(0, 700) : "(no EUR/USD lines) " + text.replace(/\s+/g, " ").slice(0, 200)));
  for (const h of hits.slice(0, 4)) console.log("  NET " + h);
  await ctx.close();
}
await browser.close();
