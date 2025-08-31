// scripts/update.js
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

const ROOT = process.cwd();
const DOCS = path.join(ROOT, 'docs');
const DATA = path.join(DOCS, 'data');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT,'config.json'),'utf8'));
const entries = Object.entries(cfg.tickers);

async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  const ok = [];

  for (const [ticker, info] of entries) {
    try {
      const rows = await fetchHoldings(ticker, info);
      if (!rows?.length) { console.log('skip empty', ticker); continue; }
      saveCSV(ticker, rows);
      ok.push(ticker);
      console.log('OK', ticker, rows.length);
    } catch (e) {
      console.warn('ERR', ticker, e.message);
    }
  }

  fs.writeFileSync(path.join(DATA,'index.json'),
    JSON.stringify({ updatedAt: new Date().toISOString(), tickers: ok }, null, 2));
}

async function fetchHoldings(ticker, info) {
  const src = (info.source||'').toLowerCase();
  if (src === 'ssga' || src === 'spdr') {
    const url = info.url || ssgaUrl(ticker);
    const ab = await fetchArrayBuffer(url);
    const rows = xlsxToRows(ab);
    return pickTickerWeight(rows);
  }
  if (src === 'invesco') {
    const url = info.url || invescoUrl(ticker);
    const ab = await fetchArrayBuffer(url);
    const rows = xlsxToRows(ab);
    return pickTickerWeight(rows);
  }
  if (src === 'csv') {
    if (!info.url) throw new Error('CSV url missing');
    const text = await fetchText(info.url);
    const rows = csvToRows(text);
    return pickTickerWeight(rows);
  }
  if (src === 'ark') { // совместимо с CSV
    const text = await fetchText(info.url);
    const rows = csvToRows(text);
    return pickTickerWeight(rows);
  }
  throw new Error('unknown source '+src);
}

function ssgaUrl(t) {
  return `https://www.ssga.com/library-content/products/fund-data/etfs/us/holdings-daily-us-en-${t.toLowerCase()}.xlsx`;
}
function invescoUrl(t) {
  return `https://www.invesco.com/us/financial-products/etfs/holdings/main/holdings/0?action=download&audienceType=Investor&ticker=${encodeURIComponent(t)}`;
}

async function fetchArrayBuffer(url) {
  const r = await fetch(url, { headers: { 'user-agent':'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.arrayBuffer();
}
async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent':'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return await r.text();
}

function xlsxToRows(ab) {
  const wb = XLSX.read(ab, { type:'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, blankrows:false });
}
function csvToRows(text) {
  // очень простое разбиение: CSV с заголовком; при сложных CSV лучше заменить на papaparse в Node
  const lines = text.replace(/\r/g,'').split('\n').filter(Boolean);
  return lines.map(line => line.split(','));
}

function pickTickerWeight(rows) {
  if (!rows?.length) return [];
  const hdr = rows[0].map(x => String(x||'').trim());
  const tIdx = findHeader(hdr, [/^(ticker|symbol|ticker symbol|code)$/i]);
  const wIdx = findHeader(hdr, [/^weight.*%$|^%?\s*weight\s*\(%\)$|^weight$/i, /portfolio\s*weight/i]);
  if (tIdx === -1 || wIdx === -1) throw new Error('no Ticker/Weight headers: '+JSON.stringify(hdr));
  const out = [];
  for (let i=1;i<rows.length;i++){
    const r = rows[i]; if (!r) continue;
    const tick = String(r[tIdx] ?? '').trim();
    if (!tick) continue;
    const w = normalizeWeight(r[wIdx]);
    out.push({ Ticker: tick, Weight: w });
  }
  return out;
}
function findHeader(hdr, patterns) {
  for (let i=0;i<hdr.length;i++) {
    const h = hdr[i];
    for (const re of patterns) if (re.test(h)) return i;
  }
  return -1;
}
function normalizeWeight(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return v>1 ? v/100 : v;
  let s = String(v).trim().replace(',', '.');
  s = s.replace(/.*?(-?\d+(?:\.\d+)?).*/, '$1'); // первое число из "1.23 (…)"
  const n = parseFloat(s.replace('%',''));
  if (!isFinite(n)) return '';
  return n>1 ? n/100 : n;
}

function saveCSV(ticker, rows) {
  const csv = ['Ticker,Weight'].concat(rows.map(r => `${r.Ticker},${r.Weight}`)).join('\n');
  fs.writeFileSync(path.join(DATA, `${ticker.toUpperCase()}.csv`), csv);
}

main().catch(e => { console.error(e); process.exit(1); });
