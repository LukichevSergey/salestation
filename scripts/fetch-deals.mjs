// Fetches PS Store deals + full game catalog for configured regions.
// Writes data/<region>.json (deals) and data/catalog-<region>.json (all games).
// Run: node scripts/fetch-deals.mjs
// Optional env: BUTTONDOWN_API_KEY — sends newsletters about new discounts.

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
const DEALS_CATEGORY = '3f772501-f6f8-49b7-abac-874a88ca4897';
// PS5 grid returns concepts, PS4 grid returns products; filter keys differ.
const CATALOG_CATEGORIES = [
  { id: 'd0446d4b-dc9a-4f1e-86ec-651f099c9b29', genreKey: 'conceptGenres', releaseKey: 'conceptReleaseDate' },
  { id: '30e3fe35-8f2d-4496-95bc-844f56952e3c', genreKey: 'productGenres', releaseKey: 'productReleaseDate' },
];
// Persisted-query hash of the store's categoryGridRetrieve document.
// If Sony rotates it: open the store in a browser, find the categoryGridRetrieve
// request and copy extensions.persistedQuery.sha256Hash from its URL.
const QUERY_HASH = '88c0b9a1273c6d320c51cd73e390924e21ae28bf09f01cde8b84b1034b16cd03';

const KEEP_CLASSIFICATIONS = new Set(['FULL_GAME', 'PREMIUM_EDITION', 'GAME_BUNDLE']);
const PAGE_SIZE = 1000;
const HISTORY_LIMIT = 120;
const REGION_TAG_PREFIX = 'psdeals-';
const WATCH_TAG_PREFIX = 'w-';
const PORTAL_URL = 'https://buttondown.com/login?subscriber=1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parsePrice(text) {
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

function coverOf(p) {
  return (
    pickMedia(p.media, 'GAMEHUB_COVER_ART') ||
    pickMedia(p.media, 'MASTER') ||
    pickMedia(p.media, 'EDITION_KEY_ART')
  );
}

// SKU ids encode platform: PPSA = PS5, CUSA = PS4.
function platformsFromSkus(ids) {
  const set = new Set();
  for (const id of ids || []) {
    if (id.includes('PPSA')) set.add('PS5');
    if (id.includes('CUSA')) set.add('PS4');
  }
  return [...set];
}

async function fetchPage(categoryId, locale, offset, filterBy = [], attempt = 1) {
  const variables = {
    id: categoryId,
    pageArgs: { size: PAGE_SIZE, offset },
    sortBy: null,
    filterBy,
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
      signal: AbortSignal.timeout(25000),
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
    console.warn(`  retry ${attempt} (${categoryId.slice(0, 8)} ${locale} offset ${offset}): ${err.message}`);
    await sleep(1500 * attempt);
    return fetchPage(categoryId, locale, offset, filterBy, attempt + 1);
  }
}

async function* gridPages(categoryId, locale, filterBy = []) {
  let offset = 0;
  for (;;) {
    const grid = await fetchPage(categoryId, locale, offset, filterBy);
    yield grid;
    if (grid.pageInfo.isLast || offset + PAGE_SIZE >= grid.pageInfo.totalCount) return;
    offset += PAGE_SIZE;
    await sleep(300);
  }
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function toDeal(p, now) {
  const base = parsePrice(p.price?.basePrice);
  const price = parsePrice(p.price?.discountedPrice);
  if (base == null || price == null || price >= base) return null;
  const cover = coverOf(p);
  if (!cover) return null;
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
    shots: (p.media || []).filter((m) => m.role === 'SCREENSHOT' && m.type === 'IMAGE').slice(0, 5).map((m) => m.url),
    hist: [[now, price]],
  };
}

async function fetchRegion(region, now) {
  const dealsFile = path.join(DATA_DIR, `${region.code}.json`);
  const prev = await readJson(dealsFile, null);
  const prevDeals = new Map((prev?.deals || []).map((d) => [d.id, d]));

  // --- deals ---
  const deals = [];
  let genreKeys = [];
  for await (const grid of gridPages(DEALS_CATEGORY, region.code)) {
    if (!genreKeys.length) {
      genreKeys = (grid.facetOptions?.find((f) => f.name === 'productGenres')?.values || []).map((v) => v.key);
    }
    for (const p of grid.products || []) {
      if (!KEEP_CLASSIFICATIONS.has(p.storeDisplayClassification)) continue;
      const deal = toDeal(p, now);
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
    console.log(`  ${region.code} deals: ${deals.length} so far`);
  }

  // --- catalog (all games, both platforms, deduped) ---
  // PS5 grid returns concepts (game + edition SKUs), PS4 grid returns products.
  const catalog = new Map();
  const entryBySku = new Map();
  const addEntry = (entry) => {
    catalog.set(entry.id, entry);
    for (const sku of entry.skus) if (!entryBySku.has(sku)) entryBySku.set(sku, entry);
  };
  const tagEntry = (entry, genre) => {
    if (entry && !entry.genres.includes(genre)) entry.genres.push(genre);
  };
  for (const cat of CATALOG_CATEGORIES) {
    for await (const grid of gridPages(cat.id, region.code)) {
      for (const c of grid.concepts || []) {
        const skus = (c.products || []).map((p) => p.id);
        if (!skus.length || entryBySku.has(skus[0])) continue;
        const cover = coverOf(c);
        if (!cover) continue;
        addEntry({
          id: c.id,
          name: c.name,
          platforms: platformsFromSkus(skus),
          base: parsePrice(c.price?.basePrice),
          baseText: c.price?.basePrice || null,
          cover,
          genres: [],
          new: false,
          skus,
        });
      }
      for (const p of grid.products || []) {
        if (!KEEP_CLASSIFICATIONS.has(p.storeDisplayClassification)) continue;
        const existing = entryBySku.get(p.id);
        if (existing) {
          existing.platforms = [...new Set([...existing.platforms, ...(p.platforms || [])])];
          continue;
        }
        const cover = coverOf(p);
        if (!cover) continue;
        addEntry({
          id: p.id,
          name: p.name,
          platforms: p.platforms || [],
          base: parsePrice(p.price?.basePrice),
          baseText: p.price?.basePrice || null,
          cover,
          genres: [],
          new: false,
          skus: [p.id],
        });
      }
    }
    console.log(`  ${region.code} catalog: ${catalog.size} games`);
  }

  // --- genre tags (server-side facet filters, ids only) ---
  for (const genre of genreKeys) {
    let tagged = 0;
    try {
      for (const cat of CATALOG_CATEGORIES) {
        for await (const grid of gridPages(cat.id, region.code, [`${cat.genreKey}:${genre}`])) {
          for (const c of grid.concepts || []) tagEntry(catalog.get(c.id), genre);
          for (const p of grid.products || []) tagEntry(entryBySku.get(p.id), genre);
          tagged += (grid.concepts?.length || 0) + (grid.products?.length || 0);
        }
      }
    } catch (err) {
      console.warn(`  genre ${genre} failed: ${err.message}`);
    }
    console.log(`  ${region.code} genre ${genre}: ${tagged}`);
  }
  console.log(`  ${region.code}: tagged ${genreKeys.length} genres`);

  // --- new releases (last 30 days) ---
  for (const cat of CATALOG_CATEGORIES) {
    try {
      for await (const grid of gridPages(cat.id, region.code, [`${cat.releaseKey}:last_thirty_days`])) {
        for (const c of grid.concepts || []) {
          const e = catalog.get(c.id);
          if (e) e.new = true;
        }
        for (const p of grid.products || []) {
          const e = entryBySku.get(p.id);
          if (e) e.new = true;
        }
      }
    } catch (err) {
      console.warn(`  new releases failed: ${err.message}`);
    }
  }

  const skuGroups = new Map();
  for (const e of catalog.values()) for (const s of e.skus) skuGroups.set(s, e.skus);

  const byId = new Map(deals.map((d) => [d.id, d]));
  for (const entry of catalog.values()) {
    for (const sku of entry.skus) {
      const deal = byId.get(sku);
      if (deal) {
        deal.genres = entry.genres;
        deal.new = entry.new;
      }
    }
  }

  deals.sort((a, b) => b.discount - a.discount);
  const fresh = deals.filter((d) => {
    const old = prevDeals.get(d.id);
    return !old || d.price < old.price;
  });

  await writeFile(
    dealsFile,
    JSON.stringify({
      region: region.code,
      country: region.country,
      currency: region.currency,
      symbol: region.symbol,
      updatedAt: now,
      count: deals.length,
      deals,
    })
  );
  const games = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(
    path.join(DATA_DIR, `catalog-${region.code}.json`),
    JSON.stringify({ region: region.code, updatedAt: now, count: games.length, games })
  );
  console.log(`  ${region.code}: saved ${deals.length} deals (${fresh.length} new/cheaper), ${games.length} catalog games`);
  return { region, fresh, skuGroups };
}

/* ---------- Newsletter ---------- */

async function bdApi(key, url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

async function listAll(key, url) {
  const out = [];
  let next = url;
  for (let i = 0; i < 20 && next; i++) {
    const page = await bdApi(key, next);
    out.push(...(page.results || []));
    next = page.next || null;
  }
  return out;
}

const tagNames = (sub) => (sub.tags || []).map((t) => (typeof t === 'string' ? t : t.name));

function dealsTable(region, list) {
  return [
    '| Game | Was | Now | Discount |',
    '| --- | --- | --- | --- |',
    ...list.map(
      (d) =>
        `| [${d.name.replace(/\|/g, '\\|')}](https://store.playstation.com/${region.code}/product/${d.id}) | ${d.baseText} | **${d.priceText}** | -${d.discount}% |`
    ),
  ].join('\n');
}

async function sendEmails(key, results) {
  const subscribers = await listAll(key, 'https://api.buttondown.com/v1/subscribers?limit=100');
  const active = subscribers.filter((s) => s.email && (s.subscriber_type || 'regular') !== 'unsubscribed');
  console.log(`  subscribers: ${active.length}`);

  const freshByCountry = new Map(results.map(({ region, fresh, skuGroups }) => [region.country.toLowerCase(), { region, fresh, skuGroups }]));

  // Region digests, grouped by region + preferred language.
  const groups = new Map();
  for (const sub of active) {
    const tags = tagNames(sub);
    const regionTag = tags.find((t) => t.startsWith(REGION_TAG_PREFIX));
    if (!regionTag) continue;
    const entry = freshByCountry.get(regionTag.slice(REGION_TAG_PREFIX.length));
    if (!entry || !entry.fresh.length) continue;
    const lang = sub.metadata?.lang === 'en' ? 'en' : 'ru';
    const gk = regionTag + '|' + lang;
    if (!groups.has(gk)) groups.set(gk, { ...entry, lang, emails: [] });
    groups.get(gk).emails.push(sub.email);
  }
  for (const { region, fresh, lang, emails } of groups.values()) {
    const top = fresh.slice(0, 15);
    const subject =
      lang === 'ru'
        ? `🎮 ${fresh.length} новых скидок PS Store — ${region.name.ru} (до -${Math.max(...top.map((d) => d.discount))}%)`
        : `🎮 ${fresh.length} new PS Store deals — ${region.name.en} (up to -${Math.max(...top.map((d) => d.discount))}%)`;
    const body = [
      lang === 'ru' ? `Новые скидки в PS Store (${region.name.ru}):` : `New discounts in the ${region.name.en} PS Store:`,
      '',
      dealsTable(region, top),
      '',
      fresh.length > top.length ? (lang === 'ru' ? `…и ещё ${fresh.length - top.length} на сайте.` : `…and ${fresh.length - top.length} more on the site.`) : '',
      '',
      lang === 'ru' ? `Управление подпиской и отслеживаемыми играми: ${PORTAL_URL}` : `Manage subscription and watched games: ${PORTAL_URL}`,
    ].join('\n');
    try {
      await bdApi(key, 'https://api.buttondown.com/v1/emails', {
        method: 'POST',
        body: JSON.stringify({ subject, body, status: 'sent', included_subscribers: emails }),
      });
      console.log(`  digest sent: ${region.code} ${lang} → ${emails.length} subscribers`);
    } catch (err) {
      console.warn(`  digest failed ${region.code} ${lang}: ${err.message}`);
    }
  }

  // Personalized watch alerts: watched games that just got discounted.
  for (const sub of active) {
    const tags = tagNames(sub);
    const watches = tags.filter((t) => t.startsWith(WATCH_TAG_PREFIX)).map((t) => t.slice(WATCH_TAG_PREFIX.length));
    if (!watches.length) continue;
    const regionTag = tags.find((t) => t.startsWith(REGION_TAG_PREFIX));
    const entry = regionTag && freshByCountry.get(regionTag.slice(REGION_TAG_PREFIX.length));
    if (!entry) continue;
    // A watch on one edition covers all editions of the same game.
    const expanded = new Set();
    for (const w of watches) {
      expanded.add(w);
      for (const s of entry.skuGroups.get(w) || []) expanded.add(s);
    }
    const hits = entry.fresh.filter((d) => expanded.has(d.id));
    if (!hits.length) continue;
    const lang = sub.metadata?.lang === 'en' ? 'en' : 'ru';
    const subject =
      lang === 'ru'
        ? `🔔 Скидки на игры из вашего списка: ${hits.length}`
        : `🔔 Deals on your watched games: ${hits.length}`;
    const body = [
      lang === 'ru' ? 'Игры, за которыми вы следите, теперь со скидкой:' : 'Games you watch are now discounted:',
      '',
      dealsTable(entry.region, hits),
      '',
      lang === 'ru' ? `Отключить отслеживание игры: ${PORTAL_URL}` : `Unwatch games: ${PORTAL_URL}`,
    ].join('\n');
    try {
      await bdApi(key, 'https://api.buttondown.com/v1/emails', {
        method: 'POST',
        body: JSON.stringify({ subject, body, status: 'sent', included_subscribers: [sub.email] }),
      });
      console.log(`  watch alert → ${sub.email} (${hits.length} games)`);
    } catch (err) {
      console.warn(`  watch alert failed ${sub.email}: ${err.message}`);
    }
  }

  // Let subscribers unwatch games themselves via Portal checkboxes.
  try {
    const tags = await listAll(key, 'https://api.buttondown.com/v1/tags?limit=100');
    for (const tag of tags) {
      if (tag.name?.startsWith(WATCH_TAG_PREFIX) && !tag.subscriber_editable) {
        await bdApi(key, `https://api.buttondown.com/v1/tags/${tag.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ subscriber_editable: true }),
        });
      }
    }
  } catch (err) {
    console.warn(`  tag editable update failed: ${err.message}`);
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
  const key = process.env.BUTTONDOWN_API_KEY;
  if (key && results.length) {
    try {
      await sendEmails(key, results);
    } catch (err) {
      console.warn(`newsletter step failed: ${err.message}`);
    }
  }
  if (!results.length) process.exit(1);
  console.log('Done.');
}

main();