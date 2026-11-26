(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const PAGE = 120;
  const PORTAL_URL = 'https://buttondown.com/login?subscriber=1';

  const GENRE_RU = {
    ACTION: 'Экшен', ADVENTURE: 'Приключения', ROLE_PLAYING_GAMES: 'Ролевые', SHOOTER: 'Шутеры',
    SIMULATION: 'Симуляторы', CASUAL: 'Казуальные', ARCADE: 'Аркады', PLATFORMER: 'Платформеры',
    SPORTS: 'Спорт', RACING: 'Гонки', FIGHTING: 'Файтинги', HORROR: 'Хоррор', STRATEGY: 'Стратегии',
    PUZZLE: 'Головоломки', MUSIC: 'Музыка', FAMILY: 'Семейные', EDUCATIONAL: 'Обучающие',
    UNIQUE: 'Уникальные', OTHER: 'Другое',
  };

  const state = {
    lang: localStorage.getItem('ss_lang') || 'ru',
    region: localStorage.getItem('ss_region') || 'en-IN',
    tab: 'deals',
    regions: [],
    data: null,
    catalog: null,
    skuDeals: new Map(),
    cache: new Map(),
    catalogCache: new Map(),
    search: '',
    platform: 'all',
    genre: '',
    priceMin: null,
    priceMax: null,
    newOnly: false,
    sort: 'discount',
    wishlistOnly: false,
    wishlist: JSON.parse(localStorage.getItem('ss_wishlist') || '{}'),
    watch: JSON.parse(localStorage.getItem('ss_watch') || '{}'),
    email: localStorage.getItem('ss_email') || '',
    pendingWatch: null,
    filtered: [],
    rendered: 0,
    loading: false,
    modalDeal: null,
  };

  const t = (key, vars) => {
    let s = (I18N[state.lang] && I18N[state.lang][key]) || I18N.ru[key] || key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    return s;
  };

  const currentRegion = () => state.regions.find((r) => r.code === state.region);
  const setFor = (store, code) => new Set(store[code] || []);
  const wishlistFor = (code) => setFor(state.wishlist, code);
  const watchFor = (code) => setFor(state.watch, code);
  const saveLocal = (key, val) => localStorage.setItem(key, JSON.stringify(val));
  const genreLabel = (g) => (state.lang === 'ru' ? GENRE_RU[g] || g : g.charAt(0) + g.slice(1).toLowerCase().replace(/_/g, ' '));
  const dealById = (id) => state.skuDeals.get(id);
  const entryDeal = (entry) => {
    let best = null;
    for (const sku of entry.skus || [entry.id]) {
      const d = state.skuDeals.get(sku);
      if (d && (!best || d.discount > best.discount)) best = d;
    }
    return best;
  };
  const watchIdOf = (d) => d.skus?.[0] || d.id;

  function imgUrl(url, w) {
    if (!url) return '';
    return url + (url.includes('?') ? '&' : '?') + 'w=' + w;
  }

  function relTime(ts) {
    const diff = Math.max(0, Date.now() / 1000 - ts);
    if (diff < 90) return t('justNow');
    if (diff < 3600) return t('minAgo', { n: Math.round(diff / 60) });
    if (diff < 86400) return t('hoursAgo', { n: Math.round(diff / 3600) });
    return t('daysAgo', { n: Math.round(diff / 86400) });
  }

  /* ---------- toast ---------- */
  let toastTimer;
  function showToast(html) {
    const el = $('#toast');
    el.innerHTML = html;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 6000);
  }

  /* ---------- i18n ---------- */
  function applyI18n() {
    document.documentElement.lang = state.lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
    document.querySelectorAll('.lang-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.lang === state.lang));
    document.title = state.lang === 'ru' ? 'SaleStation — скидки PS Store' : 'SaleStation — PS Store deals';
    const r = currentRegion();
    if (r) $('#regionName').textContent = r.name[state.lang] || r.name.en;
    rebuildGenreSelect();
    if (state.data || state.catalog) renderStats();
    updateWishlistChip();
    if (!$('#subscribeModal').hidden) fillSubscribeText();
    if (!$('#gameModal').hidden && state.modalDeal) {
      fillWishlistButton(state.modalDeal);
      fillWatchButton(state.modalDeal);
    }
  }

  /* ---------- Regions ---------- */
  async function loadRegions() {
    const res = await fetch('data/regions.json');
    state.regions = await res.json();
    if (!state.regions.some((r) => r.code === state.region)) state.region = state.regions[0].code;
    const menu = $('#regionMenu');
    menu.innerHTML = '';
    for (const r of state.regions) {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.dataset.code = r.code;
      li.innerHTML = `<span>${r.flag}</span><span></span><span class="region-currency">${r.currency}</span>`;
      li.children[1].textContent = r.name[state.lang] || r.name.en;
      li.addEventListener('click', () => {
        state.region = r.code;
        localStorage.setItem('ss_region', r.code);
        closeRegionMenu();
        syncRegionUI();
        loadRegion();
      });
      menu.appendChild(li);
    }
    syncRegionUI();
  }

  function syncRegionUI() {
    const r = currentRegion();
    if (!r) return;
    $('#regionFlag').textContent = r.flag;
    $('#regionName').textContent = r.name[state.lang] || r.name.en;
    document.querySelectorAll('#regionMenu li').forEach((li) => {
      li.classList.toggle('active', li.dataset.code === state.region);
      li.children[1].textContent = state.regions.find((x) => x.code === li.dataset.code).name[state.lang] || li.dataset.code;
    });
  }

  function closeRegionMenu() {
    $('#regionPicker').classList.remove('open');
    $('#regionBtn').setAttribute('aria-expanded', 'false');
  }

  /* ---------- Data ---------- */
  async function loadRegion() {
    if (state.loading) return;
    state.loading = true;
    showError(false);
    $('#emptyState').hidden = true;
    $('#grid').innerHTML = '';
    showSkeleton(true);
    state.catalog = null;

    try {
      let data = state.cache.get(state.region);
      if (!data) {
        const res = await fetch(`data/${state.region}.json`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
        state.cache.set(state.region, data);
      }
      state.data = data;
      state.skuDeals = new Map(data.deals.map((d) => [d.id, d]));
      renderStats();
      applyFilters();
      setTimeout(loadCatalog, 400);
    } catch (err) {
      console.error(err);
      showError(true);
    } finally {
      state.loading = false;
      showSkeleton(false);
    }
  }

  async function loadCatalog() {
    try {
      let cat = state.catalogCache.get(state.region);
      if (!cat) {
        const res = await fetch(`data/catalog-${state.region}.json`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        cat = await res.json();
        state.catalogCache.set(state.region, cat);
      }
      if (state.region !== cat.region) return;
      state.catalog = cat;
      $('#tabCatalogCount').textContent = cat.count.toLocaleString();
      if (state.tab === 'catalog') {
        showSkeleton(false);
        applyFilters();
      }
    } catch (err) {
      console.error(err);
      if (state.tab === 'catalog') showError(true);
    }
  }

  function renderStats() {
    const loc = state.lang === 'ru' ? 'ru-RU' : 'en-US';
    if (state.tab === 'deals' && state.data) {
      $('#statCount').textContent = state.data.count.toLocaleString(loc);
      $('#statMax').textContent = '-' + Math.max(...state.data.deals.map((x) => x.discount)) + '%';
      $('#statMax').nextElementSibling.textContent = t('statMax');
      $('#statUpdated').textContent = relTime(state.data.updatedAt);
    } else if (state.catalog) {
      $('#statCount').textContent = state.catalog.count.toLocaleString(loc);
      $('#statMax').textContent = state.catalog.games.filter((g) => g.new).length.toLocaleString(loc);
      $('#statMax').nextElementSibling.textContent = t('statNew');
      $('#statUpdated').textContent = relTime(state.catalog.updatedAt);
    }
    if (state.data) $('#tabDealsCount').textContent = state.data.count.toLocaleString(loc);
  }

  function showSkeleton(on) {
    const sk = $('#skeleton');
    sk.hidden = !on;
    if (on && !sk.children.length) {
      for (let i = 0; i < 12; i++) {
        const div = document.createElement('div');
        div.className = 'sk-card';
        div.innerHTML = '<div class="sk-cover"></div><div class="sk-line"></div><div class="sk-line" style="width:60%"></div>';
        sk.appendChild(div);
      }
    }
  }

  function showError(on) {
    $('#errorState').hidden = !on;
  }

  /* ---------- Filtering & rendering ---------- */
  function sourceList() {
    return state.tab === 'deals' ? state.data?.deals || [] : state.catalog?.games || [];
  }

  function rebuildGenreSelect() {
    const sel = $('#genreSelect');
    const genres = [...new Set(sourceList().flatMap((d) => d.genres || []))].sort();
    const current = state.genre;
    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = '';
    opt0.textContent = t('allGenres');
    sel.appendChild(opt0);
    for (const g of genres) {
      const opt = document.createElement('option');
      opt.value = g;
      opt.textContent = genreLabel(g);
      sel.appendChild(opt);
    }
    sel.value = genres.includes(current) ? current : '';
    state.genre = sel.value;
  }

  function applyFilters() {
    const src = sourceList();
    if (!src.length && !state.data) return;
    const q = state.search.trim().toLowerCase();
    const wl = wishlistFor(state.region);
    const isCatalog = state.tab === 'catalog';
    let list = src.filter((d) => {
      if (q && !d.name.toLowerCase().includes(q)) return false;
      if (state.platform !== 'all' && !d.platforms.includes(state.platform)) return false;
      if (state.newOnly && !d.new) return false;
      if (state.genre && !(d.genres || []).includes(state.genre)) return false;
      const effective = isCatalog ? entryDeal(d)?.price ?? d.base : d.price;
      if (state.priceMin != null && effective < state.priceMin) return false;
      if (state.priceMax != null && effective > state.priceMax) return false;
      if (state.wishlistOnly && !wl.has(watchIdOf(d))) return false;
      return true;
    });
    const disc = (d) => (isCatalog ? entryDeal(d)?.discount || 0 : d.discount || 0);
    const sorters = {
      discount: (a, b) => disc(b) - disc(a),
      priceAsc: (a, b) => (a.price ?? a.base) - (b.price ?? b.base),
      priceDesc: (a, b) => (b.price ?? b.base) - (a.price ?? a.base),
      name: (a, b) => a.name.localeCompare(b.name),
    };
    list.sort(sorters[state.sort] || sorters.discount);
    state.filtered = list;
    state.rendered = 0;
    $('#grid').innerHTML = '';
    $('#emptyState').hidden = list.length > 0;
    renderMore();
  }

  function renderMore() {
    const grid = $('#grid');
    const wl = wishlistFor(state.region);
    const ws = watchFor(state.region);
    const frag = document.createDocumentFragment();
    const end = Math.min(state.rendered + PAGE, state.filtered.length);
    for (let i = state.rendered; i < end; i++) frag.appendChild(buildCard(state.filtered[i], wl, ws, i));
    grid.appendChild(frag);
    state.rendered = end;
    ensureSentinel();
  }

  let sentinel = null;
  function ensureSentinel() {
    if (sentinel) sentinel.remove();
    if (state.rendered >= state.filtered.length) return;
    sentinel = document.createElement('div');
    sentinel.style.height = '1px';
    $('#grid').after(sentinel);
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        io.disconnect();
        renderMore();
      }
    }, { rootMargin: '600px' });
    io.observe(sentinel);
  }

  const HEART_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.7-10-9.3C.6 8 2.6 4.5 6.2 4.5c2.2 0 3.7 1.2 4.6 2.6.9-1.4 2.4-2.6 4.6-2.6 3.6 0 5.6 3.5 4.2 7.2C19.5 16.3 12 21 12 21Z"/></svg>';
  const BELL_SVG = '<svg viewBox="0 0 24 24" fill="none"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function buildCard(d, wl, ws, index) {
    const deal = state.tab === 'catalog' ? entryDeal(d) : d;
    const wid = watchIdOf(d);
    const card = document.createElement('article');
    card.className = 'card';
    card.style.animationDelay = Math.min(index % PAGE, 20) * 18 + 'ms';

    const cover = document.createElement('div');
    cover.className = 'card-cover';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = imgUrl(d.cover, 480);
    img.alt = d.name;
    cover.appendChild(img);

    if (deal) {
      const badge = document.createElement('span');
      badge.className = 'badge' + (deal.discount >= 75 ? ' badge-hot' : '');
      badge.textContent = '-' + deal.discount + '%';
      cover.appendChild(badge);
    } else if (d.new) {
      const badge = document.createElement('span');
      badge.className = 'badge badge-new';
      badge.textContent = t('newBadge');
      cover.appendChild(badge);
    }

    const heart = document.createElement('button');
    heart.className = 'card-heart' + (wl.has(wid) ? ' active' : '');
    heart.setAttribute('aria-label', 'wishlist');
    heart.innerHTML = HEART_SVG;
    heart.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWishlist(wid);
      heart.classList.toggle('active', wishlistFor(state.region).has(wid));
    });
    cover.appendChild(heart);

    const bell = document.createElement('button');
    bell.className = 'card-bell' + (ws.has(wid) ? ' active' : '');
    bell.dataset.bell = wid;
    bell.setAttribute('aria-label', 'watch');
    bell.title = t('watch');
    bell.innerHTML = BELL_SVG;
    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatch(d, wid);
    });
    cover.appendChild(bell);
    card.appendChild(cover);

    const body = document.createElement('div');
    body.className = 'card-body';
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = d.name;
    name.title = d.name;
    body.appendChild(name);

    const platforms = document.createElement('div');
    platforms.className = 'card-platforms';
    for (const p of d.platforms) {
      const tag = document.createElement('span');
      tag.className = 'platform-tag';
      tag.textContent = p;
      platforms.appendChild(tag);
    }
    body.appendChild(platforms);

    const prices = document.createElement('div');
    prices.className = 'card-prices';
    if (deal) {
      const old = document.createElement('span');
      old.className = 'price-old';
      old.textContent = deal.baseText;
      const nw = document.createElement('span');
      nw.className = 'price-new';
      nw.textContent = deal.priceText;
      prices.append(old, nw);
    } else {
      const nw = document.createElement('span');
      nw.className = 'price-new';
      nw.textContent = d.baseText || '—';
      prices.appendChild(nw);
    }
    body.appendChild(prices);
    card.appendChild(body);

    card.addEventListener('click', () => openGameModal(d));
    return card;
  }

  /* ---------- Wishlist ---------- */
  function toggleWishlist(id) {
    const set = wishlistFor(state.region);
    set.has(id) ? set.delete(id) : set.add(id);
    state.wishlist[state.region] = [...set];
    saveLocal('ss_wishlist', state.wishlist);
    updateWishlistChip();
    if (state.wishlistOnly) applyFilters();
  }

  function updateWishlistChip() {
    $('#wishlistCount').textContent = wishlistFor(state.region).size;
  }

  /* ---------- Watch (email alerts per game) ---------- */
  function embedUrl() {
    return `https://buttondown.com/api/emails/embed-subscribe/${window.APP_CONFIG.buttondownUsername}`;
  }

  function configured() {
    const u = window.APP_CONFIG.buttondownUsername;
    return u && u !== 'YOUR_BUTTONDOWN_USERNAME';
  }

  function postSubscribe(email, tags) {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = embedUrl();
    form.target = 'bdFrame';
    form.style.display = 'none';
    const add = (name, value) => {
      const i = document.createElement('input');
      i.type = 'hidden';
      i.name = name;
      i.value = value;
      form.appendChild(i);
    };
    add('email', email);
    for (const tag of tags) add('tag', tag);
    add('metadata__lang', state.lang);
    document.body.appendChild(form);
    form.submit();
    form.remove();
  }

  function regionTag() {
    const r = currentRegion();
    return 'psdeals-' + (r ? r.country.toLowerCase() : 'in');
  }

  function toggleWatch(d, wid) {
    const set = watchFor(state.region);
    if (set.has(wid)) {
      set.delete(wid);
      state.watch[state.region] = [...set];
      saveLocal('ss_watch', state.watch);
      syncBells(wid);
      showToast(
        t('watchRemoved') + (configured() ? ` <a href="${PORTAL_URL}" target="_blank" rel="noopener">${t('portal')}</a>` : '')
      );
      return;
    }
    if (!configured()) {
      showToast(t('subscribeNotConfigured'));
      return;
    }
    if (!state.email) {
      state.pendingWatch = { id: wid, name: d.name };
      openSubscribeModal();
      return;
    }
    set.add(wid);
    state.watch[state.region] = [...set];
    saveLocal('ss_watch', state.watch);
    postSubscribe(state.email, [regionTag(), 'w-' + wid]);
    syncBells(wid);
    showToast(t('watchAdded'));
  }

  function syncBells(id) {
    const on = watchFor(state.region).has(id);
    document.querySelectorAll(`[data-bell="${CSS.escape(id)}"]`).forEach((b) => b.classList.toggle('active', on));
    if (state.modalDeal && state.modalDeal.id === id) fillWatchButton(state.modalDeal);
  }

  /* ---------- Game modal ---------- */
  function openGameModal(d) {
    state.modalDeal = d;
    const deal = state.tab === 'catalog' ? entryDeal(d) : d;
    $('#modalCover').src = imgUrl(d.cover, 800);
    $('#modalCover').alt = d.name;
    if (deal) {
      $('#modalBadge').hidden = false;
      $('#modalBadge').textContent = '-' + deal.discount + '%';
      $('#modalBadge').className = 'badge modal-badge' + (deal.discount >= 75 ? ' badge-hot' : '');
      $('#modalBase').textContent = deal.baseText;
      $('#modalPrice').textContent = deal.priceText;
    } else {
      $('#modalBadge').hidden = true;
      $('#modalBase').textContent = '';
      $('#modalPrice').textContent = d.baseText || '—';
    }
    $('#modalName').textContent = d.name;
    const plat = $('#modalPlatforms');
    plat.innerHTML = '';
    for (const p of d.platforms) {
      const tag = document.createElement('span');
      tag.className = 'platform-tag';
      tag.textContent = p;
      plat.appendChild(tag);
    }
    $('#modalStoreLink').href = /^\d+$/.test(d.id)
      ? `https://store.playstation.com/${state.region}/concept/${d.id}`
      : `https://store.playstation.com/${state.region}/product/${d.id}`;
    fillWishlistButton(d);
    fillWatchButton(d);

    const shots = $('#modalShots');
    shots.innerHTML = '';
    for (const s of d.shots || []) {
      const img = document.createElement('img');
      img.src = imgUrl(s, 400);
      img.loading = 'lazy';
      img.alt = '';
      img.addEventListener('click', () => window.open(s, '_blank', 'noopener'));
      shots.appendChild(img);
    }
    $('.chart-block').hidden = !deal;

    $('#gameModal').hidden = false;
    document.body.style.overflow = 'hidden';
    if (deal) requestAnimationFrame(() => drawChart(deal));
  }

  function fillWishlistButton(d) {
    const wid = watchIdOf(d);
    const inWl = wishlistFor(state.region).has(wid);
    $('#modalWishlist').textContent = inWl ? t('inWishlist') : t('addWishlist');
    $('#modalWishlist').onclick = () => {
      toggleWishlist(wid);
      fillWishlistButton(d);
      syncBells(wid);
      applyFilters();
    };
  }

  function fillWatchButton(d) {
    const wid = watchIdOf(d);
    const on = watchFor(state.region).has(wid);
    $('#modalWatch').textContent = on ? t('watched') : t('watch');
    $('#modalWatch').onclick = () => toggleWatch(d, wid);
  }

  function drawChart(d) {
    const canvas = $('#priceChart');
    const note = $('#chartNote');
    const hist = d.hist || [];
    note.hidden = hist.length > 1;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 500;
    const h = 140;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (!hist.length) return;

    const pad = { l: 14, r: 14, t: 24, b: 24 };
    const prices = hist.map((p) => p[1]);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    const x = (i) => pad.l + (hist.length === 1 ? (w - pad.l - pad.r) / 2 : (i / (hist.length - 1)) * (w - pad.l - pad.r));
    const y = (p) => pad.t + (1 - (p - min) / span) * (h - pad.t - pad.b);

    ctx.strokeStyle = 'rgba(120,160,255,0.12)';
    ctx.lineWidth = 1;
    for (let g = 0; g < 3; g++) {
      const gy = pad.t + (g / 2) * (h - pad.t - pad.b);
      ctx.beginPath();
      ctx.moveTo(pad.l, gy);
      ctx.lineTo(w - pad.r, gy);
      ctx.stroke();
    }

    const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    grad.addColorStop(0, 'rgba(0,194,255,0.28)');
    grad.addColorStop(1, 'rgba(0,194,255,0)');
    ctx.beginPath();
    hist.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p[1])) : ctx.moveTo(x(i), y(p[1]))));
    ctx.lineTo(x(hist.length - 1), h - pad.b);
    ctx.lineTo(x(0), h - pad.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    hist.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p[1])) : ctx.moveTo(x(i), y(p[1]))));
    ctx.strokeStyle = '#00c2ff';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    hist.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(x(i), y(p[1]), 3, 0, Math.PI * 2);
      ctx.fillStyle = '#00c2ff';
      ctx.fill();
    });

    const symbol = state.data?.symbol || '';
    ctx.fillStyle = '#8b96ad';
    ctx.font = '11px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(symbol + max.toLocaleString(), pad.l, 14);
    ctx.textAlign = 'right';
    ctx.fillText(symbol + min.toLocaleString(), w - pad.r, 14);
    const fmt = (ts) => new Date(ts * 1000).toLocaleDateString(state.lang === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short' });
    ctx.textAlign = 'left';
    ctx.fillText(fmt(hist[0][0]), pad.l, h - 8);
    ctx.textAlign = 'right';
    ctx.fillText(fmt(hist[hist.length - 1][0]), w - pad.r, h - 8);
  }

  function closeGameModal() {
    $('#gameModal').hidden = true;
    document.body.style.overflow = '';
  }

  /* ---------- Subscribe ---------- */
  function fillSubscribeText() {
    const r = currentRegion();
    const regionName = r ? `${r.flag} ${r.name[state.lang] || r.name.en}` : '';
    if (state.pendingWatch) {
      $('#subscribeText').textContent = t('subscribeWatchText', { game: state.pendingWatch.name, region: regionName });
    } else {
      $('#subscribeText').textContent = t('subscribeText', { region: regionName });
    }
  }

  function openSubscribeModal() {
    fillSubscribeText();
    $('#subscribeSuccess').hidden = true;
    $('#subscribeError').hidden = true;
    $('#subscribeForm').hidden = false;
    if (state.email) $('#emailInput').value = state.email;

    const hidden = $('#subscribeHidden');
    hidden.innerHTML = '';
    const add = (name, value) => {
      const i = document.createElement('input');
      i.type = 'hidden';
      i.name = name;
      i.value = value;
      hidden.appendChild(i);
    };
    add('tag', regionTag());
    add('metadata__lang', state.lang);
    if (state.pendingWatch) add('tag', 'w-' + state.pendingWatch.id);
    $('#subscribeForm').action = configured() ? embedUrl() : '';

    $('#subscribeModal').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('#emailInput').focus(), 50);
  }

  function closeSubscribeModal() {
    $('#subscribeModal').hidden = true;
    state.pendingWatch = null;
    document.body.style.overflow = '';
  }

  function handleSubscribeSubmit(e) {
    if (!configured()) {
      e.preventDefault();
      const errEl = $('#subscribeError');
      errEl.textContent = t('subscribeNotConfigured');
      errEl.hidden = false;
      return;
    }
    const email = $('#emailInput').value.trim();
    if (!email) return;
    const frame = $('#bdFrame');
    const onLoad = () => {
      frame.removeEventListener('load', onLoad);
      state.email = email;
      localStorage.setItem('ss_email', email);
      if (state.pendingWatch) {
        const set = watchFor(state.region);
        set.add(state.pendingWatch.id);
        state.watch[state.region] = [...set];
        saveLocal('ss_watch', state.watch);
        syncBells(state.pendingWatch.id);
      }
      $('#subscribeForm').hidden = true;
      $('#subscribeSuccess').hidden = false;
    };
    frame.addEventListener('load', onLoad);
  }

  /* ---------- Tabs ---------- */
  function switchTab(tab) {
    if (state.tab === tab) return;
    state.tab = tab;
    $('#tabDeals').classList.toggle('active', tab === 'deals');
    $('#tabCatalog').classList.toggle('active', tab === 'catalog');
    $('#tabDeals').setAttribute('aria-selected', String(tab === 'deals'));
    $('#tabCatalog').setAttribute('aria-selected', String(tab === 'catalog'));
    rebuildGenreSelect();
    renderStats();
    if (tab === 'catalog' && !state.catalog) {
      $('#grid').innerHTML = '';
      showSkeleton(true);
      loadCatalog();
    } else {
      applyFilters();
    }
  }

  /* ---------- Events ---------- */
  function bindEvents() {
    $('#regionBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const open = $('#regionPicker').classList.toggle('open');
      $('#regionBtn').setAttribute('aria-expanded', String(open));
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#regionPicker')) closeRegionMenu();
    });

    document.querySelectorAll('.lang-toggle button').forEach((b) =>
      b.addEventListener('click', () => {
        state.lang = b.dataset.lang;
        localStorage.setItem('ss_lang', state.lang);
        applyI18n();
        syncRegionUI();
      })
    );

    let searchTimer;
    $('#searchInput').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = e.target.value;
        applyFilters();
      }, 250);
    });

    $('#platformChips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      if (chip.id === 'wishlistChip') {
        state.wishlistOnly = !state.wishlistOnly;
        chip.classList.toggle('active', state.wishlistOnly);
      } else if (chip.id === 'newChip') {
        state.newOnly = !state.newOnly;
        chip.classList.toggle('active', state.newOnly);
      } else {
        state.platform = chip.dataset.platform;
        document.querySelectorAll('#platformChips .chip[data-platform]').forEach((c) => c.classList.toggle('active', c === chip));
      }
      applyFilters();
    });

    $('#genreSelect').addEventListener('change', (e) => {
      state.genre = e.target.value;
      applyFilters();
    });

    const priceHandler = () => {
      const min = parseFloat($('#priceMin').value);
      const max = parseFloat($('#priceMax').value);
      state.priceMin = Number.isFinite(min) ? min : null;
      state.priceMax = Number.isFinite(max) ? max : null;
      applyFilters();
    };
    $('#priceMin').addEventListener('input', priceHandler);
    $('#priceMax').addEventListener('input', priceHandler);

    $('#sortSelect').addEventListener('change', (e) => {
      state.sort = e.target.value;
      applyFilters();
    });

    $('#tabDeals').addEventListener('click', () => switchTab('deals'));
    $('#tabCatalog').addEventListener('click', () => switchTab('catalog'));

    $('#retryBtn').addEventListener('click', () => (state.tab === 'catalog' ? loadCatalog() : loadRegion()));
    $('#subscribeBtn').addEventListener('click', () => {
      state.pendingWatch = null;
      openSubscribeModal();
    });
    $('#modalNotify').addEventListener('click', () => {
      closeGameModal();
      state.pendingWatch = null;
      openSubscribeModal();
    });
    $('#subscribeForm').addEventListener('submit', handleSubscribeSubmit);

    $('#gameModalClose').addEventListener('click', closeGameModal);
    $('#subscribeModalClose').addEventListener('click', closeSubscribeModal);
    for (const id of ['gameModal', 'subscribeModal']) {
      $('#' + id).addEventListener('click', (e) => {
        if (e.target.id === id) (id === 'gameModal' ? closeGameModal : closeSubscribeModal)();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeGameModal();
        closeSubscribeModal();
        closeRegionMenu();
      }
    });
    window.addEventListener('resize', () => {
      if (!$('#gameModal').hidden && state.modalDeal) {
        const deal = state.tab === 'catalog' ? entryDeal(state.modalDeal) : state.modalDeal;
        if (deal) drawChart(deal);
      }
    });
  }

  /* ---------- Init ---------- */
  async function init() {
    bindEvents();
    applyI18n();
    try {
      await loadRegions();
      await loadRegion();
    } catch (err) {
      console.error(err);
      showError(true);
    }
  }

  init();
})();