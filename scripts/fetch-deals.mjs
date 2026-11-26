// Fetches PS Store deals for configured regions and writes data/<region>.json.
// Run: node scripts/fetch-deals.mjs
// Optional env: BUTTONDOWN_API_KEY — sends a newsletter about new discounts.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');

// Add a new country by appending one line here.
const REGIONS = [
  { code: 'en-IN', country: 'IN', flag: '🇮🇳', currency: 'INR', symbol: '₹', name: { ru: 'Индия', en: 'India' } },
  { code: 'uk-UA', country: 'UA', flag: '🇺🇦', currency: 'UAH', symbol: '₴', name: { ru: 'Украина', en: 'Ukraine' } },
  { code: 'tr-TR', country: 'TR', flag: '🇹🇷', currency: 'TRY', symbol: '₺', name: { ru: 'Турция', en: 'Turkey' } },
];

const ENDPOINT = 'https://web.np.playstation.com/api/graphql/v1//op';
const CATEGORY_ID = '3f772501-f6f8-49b7-abac-874a88ca4897'; // "All Deals" grid, same for all locales
// Persisted-query hash of the store's categoryGridRetrieve document.
// If Sony rotates it: open the store in a browser, find the categoryGridRetrieve
// request and copy extensions.persistedQuery.sha256Hash from its URL.
const QUERY_HASH = '88c0b9a1273c6d320c51cd73e390924e21ae28bf09f01cde8b84b1034b16cd03';

const KEEP_CLASSIFICATIONS = new Set(['FULL_GAME', 'PREMIUM_EDITION', 'GAME_BUNDLE']);
const PAGE_SIZE = 1000;
const HISTORY_LIMIT = 120;
const NEWSLETTER_TAG_PREFIX = 'psdeals-';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePrice(text, locale) {
  if (!text) return null;
  let s = String(text).replace(/[^\d.,]/g, '');
  if (!s) return null;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    const dec = lastComma > lastDot ? ',' : '.';
    const thou = dec === ',' ? '.' : ',';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastComma >= 0) {
    const parts = s.split(',');
    s = parts.length === 2 && parts[1].length <= 2 ? s.replace(',', '.') : s.split(',').join('');
  } else if (lastDot >= 0) {
    const parts = s.split('.');
    s = parts.length === 2 && parts[1].length <= 2 ? s : s.split('.').join('');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseDiscount(text) {
  const m = String(text || '').match(/(\d+)\s*%/);
  return m ? parseInt(m[1], 10) : 0;
}

function pickMedia(media, role) {
  return media?.find((m) => m.role === role && m.type === 'IMAGE')?.url || null;
}

async function fetchPage(locale, offset, attempt = 1) {
  const variables = {
    id: CATEGORY_ID,
    pageArgs: { size: PAGE_SIZE, offset },
    sortBy: null,
    filterBy: [],
    facetOptions: [],
  };
  const url =
    ENDPOINT +
    '?operationName=categoryGridRetrieve&variables=' +
    encodeURIComponent(JSON.stringify(variables)) +
    '&extensions=' +
    encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: QUERY_HASH } }));
  try {
    const res = await fetch(url, {
      headers: {
        'x-psn-store-locale-override': locale,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'apollo-require-preflight': 'true',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const grid = json.data?.categoryGridRetrieve;
    if (!grid) throw new Error(JSON.stringify(json).slice(0, 200));
    return grid;
  } catch (err) {
    if (attempt >= 4) throw err;
    console.warn(`  retry ${attempt} for ${locale} offset ${offset}: ${err.message}`);
    await sleep(1500 * attempt);
    return fetchPage(locale, offset, attempt + 1);
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function toDeal(p, locale, now) {
  const base = parsePrice(p.price?.basePrice, locale);
  const price = parsePrice(p.price?.discountedPrice, locale);
  if (base == null || price == null || price >= base) return null;
  const cover =
    pickMedia(p.media, 'GAMEHUB_COVER_ART') ||
    pickMedia(p.media, 'MASTER') ||
    pickMedia(p.media, 'EDITION_KEY_ART');
  if (!cover) return null;
  const shots = (p.media || [])
    .filter((m) => m.role === 'SCREENSHOT' && m.type === 'IMAGE')
    .slice(0, 5)
    .map((m) => m.url);
  return {
    id: p.id,
    name: p.name,
    platforms: p.platforms || [],
    cls: p.storeDisplayClassification,
    base,
    price,
    baseText: p.price.basePrice,
    priceText: p.price.discountedPrice,
    discount: parseDiscount(p.price.discountText) || Math.round((1 - price / base) * 100),
    cover,
    logo: pickMedia(p.media, 'LOGO'),
    shots,
    hist: [[now, price]],
  };
}

async function fetchRegion(region, now) {
  const file = path.join(DATA_DIR, `${region.code}.json`);
  const prev = await readJson(file, null);
  const prevDeals = new Map((prev?.deals || []).map((d) => [d.id, d]));

  const deals = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const grid = await fetchPage(region.code, offset);
    total = grid.pageInfo.totalCount;
    for (const p of grid.products || []) {
      if (!KEEP_CLASSIFICATIONS.has(p.storeDisplayClassification)) continue;
      const deal = toDeal(p, region.code, now);
      if (!deal) continue;
      const old = prevDeals.get(deal.id);
      if (old?.hist?.length) {
        deal.hist = old.hist;
        const last = deal.hist[deal.hist.length - 1];
        if (last[1] !== deal.price) deal.hist.push([now, deal.price]);
        if (deal.hist.length > HISTORY_LIMIT) deal.hist = deal.hist.slice(-HISTORY_LIMIT);
      }
      deals.push(deal);
    }
    console.log(`  ${region.code}: ${Math.min(offset + PAGE_SIZE, total)}/${total}`);
    if (grid.pageInfo.isLast) break;
    offset += PAGE_SIZE;
    await sleep(400);
  }

  deals.sort((a, b) => b.discount - a.discount);
  const fresh = deals.filter((d) => {
    const old = prevDeals.get(d.id);
    return !old || d.price < old.price;
  });

  const out = {
    region: region.code,
    country: region.country,
    currency: region.currency,
    symbol: region.symbol,
    updatedAt: now,
    count: deals.length,
    deals,
  };
  await writeFile(file, JSON.stringify(out));
  console.log(`  ${region.code}: saved ${deals.length} deals, ${fresh.length} new/cheaper`);
  return { region, fresh };
}

function buildEmail(region, fresh) {
  const top = fresh.slice(0, 15);
  const lines = top.map(
    (d) =>
      `| [${d.name.replace(/\|/g, '\\|')}](https://store.playstation.com/${region.code}/product/${d.id}) | ${d.baseText} | **${d.priceText}** | -${d.discount}% |`
  );
  const body = [
    `New discounts in the ${region.name.en} PS Store (${fresh.length} games):`,
    '',
    '| Game | Was | Now | Discount |',
    '| --- | --- | --- | --- |',
    ...lines,
    '',
    fresh.length > top.length ? `…and ${fresh.length - top.length} more on the site.` : '',
    '',
    '— SaleStation',
  ].join('\n');
  return {
    subject: `🎮 ${fresh.length} new PS Store deals — ${region.name.en} (up to -${Math.max(...top.map((d) => d.discount))}%)`,
    body,
  };
}

async function sendNewsletter(region, fresh) {
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key || !fresh.length) return;
  const { subject, body } = buildEmail(region, fresh);
  try {
    const res = await fetch('https://api.buttondown.com/v1/emails', {
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        subject,
        body,
        status: 'sent',
        included_tags: [NEWSLETTER_TAG_PREFIX + region.country.toLowerCase()],
      }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    console.log(`  newsletter sent for ${region.code} (${fresh.length} deals)`);
  } catch (err) {
    console.warn(`  newsletter failed for ${region.code}: ${err.message}`);
  }
}

async function main() {
  const now = Math.floor(Date.now() / 1000);
  await mkdir(DATA_DIR, { recursive: true });
  const results = [];
  for (const region of REGIONS) {
    console.log(`Fetching ${region.code}…`);
    try {
      results.push(await fetchRegion(region, now));
    } catch (err) {
      console.error(`  FAILED ${region.code}: ${err.message}`);
    }
    await sleep(500);
  }
  await writeFile(
    path.join(DATA_DIR, 'regions.json'),
    JSON.stringify(
      REGIONS.map(({ code, country, flag, currency, symbol, name }) => ({ code, country, flag, currency, symbol, name })),
      null,
      2
    )
  );
  for (const { region, fresh } of results) await sendNewsletter(region, fresh);
  if (!results.length) process.exit(1);
  console.log('Done.');
}

main();