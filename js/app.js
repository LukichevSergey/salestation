(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const PAGE = 120;

  const state = {
    lang: localStorage.getItem('ss_lang') || 'ru',
    region: localStorage.getItem('ss_region') || 'en-IN',
    regions: [],
    data: null,
    cache: new Map(),
    search: '',
    platform: 'all',
    sort: 'discount',
    wishlistOnly: false,
    wishlist: JSON.parse(localStorage.getItem('ss_wishlist') || '{}'),
    filtered: [],
    rendered: 0,
    loading: false,
  };

  const t = (key, vars) => {
    let s = (I18N[state.lang] && I18N[state.lang][key]) || I18N.ru[key] || key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    return s;
  };

  const currentRegion = () => state.regions.find((r) => r.code === state.region);
  const wishlistFor = (code) => new Set(state.wishlist[code] || []);
  const saveWishlist = () => localStorage.setItem('ss_wishlist', JSON.stringify(state.wishlist));

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

  /* ---------- i18n ---------- */
  function applyI18n() {
    document.documentElement.lang = state.lang;
    document.querySelectorAll('[data-i18n]').forEach((el) => (el.textContent = t(el.dataset.i18n)));
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder)));
    document.querySelectorAll('.lang-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.lang === state.lang));
    document.title = state.lang === 'ru' ? 'SaleStation — скидки PS Store' : 'SaleStation — PS Store deals';
    const r = currentRegion();
    if (r) $('#regionName').textContent = r.name[state.lang] || r.name.en;
    if (state.data) renderStats();
    updateWishlistChip();
    if (!$('#subscribeModal').hidden) fillSubscribeText();
    if (!$('#gameModal').hidden && state.modalDeal) fillWishlistButton(state.modalDeal);
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
      li.children[1].textContent = (state.regions.find((x) => x.code === li.dataset.code).name[state.lang]) || li.dataset.code;
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

    try {
      let data = state.cache.get(state.region);
      if (!data) {
        const res = await fetch(`data/${state.region}.json`);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
        state.cache.set(state.region, data);
      }
      state.data = data;
      renderStats();
      applyFilters();
    } catch (err) {
      console.error(err);
      showError(true);
    } finally {
      state.loading = false;
      showSkeleton(false);
    }
  }

  function renderStats() {
    const d = state.data;
    $('#statCount').textContent = d.count.toLocaleString(state.lang === 'ru' ? 'ru-RU' : 'en-US');
    $('#statMax').textContent = '-' + Math.max(...d.deals.map((x) => x.discount)) + '%';
    $('#statUpdated').textContent = relTime(d.updatedAt);
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
  function applyFilters() {
    if (!state.data) return;
    const q = state.search.trim().toLowerCase();
    const wl = wishlistFor(state.region);
    let list = state.data.deals.filter((d) => {
      if (q && !d.name.toLowerCase().includes(q)) return false;
      if (state.platform !== 'all' && !d.platforms.includes(state.platform)) return false;
      if (state.wishlistOnly && !wl.has(d.id)) return false;
      return true;
    });
    const sorters = {
      discount: (a, b) => b.discount - a.discount || a.price - b.price,
      priceAsc: (a, b) => a.price - b.price,
      priceDesc: (a, b) => b.price - a.price,
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
    const frag = document.createDocumentFragment();
    const end = Math.min(state.rendered + PAGE, state.filtered.length);
    for (let i = state.rendered; i < end; i++) frag.appendChild(buildCard(state.filtered[i], wl, i));
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

  function buildCard(d, wl, index) {
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

    const badge = document.createElement('span');
    badge.className = 'badge' + (d.discount >= 75 ? ' badge-hot' : '');
    badge.textContent = '-' + d.discount + '%';
    cover.appendChild(badge);

    const heart = document.createElement('button');
    heart.className = 'card-heart' + (wl.has(d.id) ? ' active' : '');
    heart.setAttribute('aria-label', 'wishlist');
    heart.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21s-7.5-4.7-10-9.3C.6 8 2.6 4.5 6.2 4.5c2.2 0 3.7 1.2 4.6 2.6.9-1.4 2.4-2.6 4.6-2.6 3.6 0 5.6 3.5 4.2 7.2C19.5 16.3 12 21 12 21Z"/></svg>';
    heart.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWishlist(d.id);
      heart.classList.toggle('active', wishlistFor(state.region).has(d.id));
    });
    cover.appendChild(heart);
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
    const old = document.createElement('span');
    old.className = 'price-old';
    old.textContent = d.baseText;
    const nw = document.createElement('span');
    nw.className = 'price-new';
    nw.textContent = d.priceText;
    prices.append(old, nw);
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
    saveWishlist();
    updateWishlistChip();
    if (state.wishlistOnly) applyFilters();
  }

  function updateWishlistChip() {
    $('#wishlistCount').textContent = wishlistFor(state.region).size;
  }

  /* ---------- Game modal ---------- */
  function openGameModal(d) {
    state.modalDeal = d;
    $('#modalCover').src = imgUrl(d.cover, 800);
    $('#modalCover').alt = d.name;
    $('#modalBadge').textContent = '-' + d.discount + '%';
    $('#modalBadge').className = 'badge modal-badge' + (d.discount >= 75 ? ' badge-hot' : '');
    $('#modalName').textContent = d.name;
    const plat = $('#modalPlatforms');
    plat.innerHTML = '';
    for (const p of d.platforms) {
      const tag = document.createElement('span');
      tag.className = 'platform-tag';
      tag.textContent = p;
      plat.appendChild(tag);
    }
    $('#modalBase').textContent = d.baseText;
    $('#modalPrice').textContent = d.priceText;
    $('#modalStoreLink').href = `https://store.playstation.com/${state.region}/product/${d.id}`;
    fillWishlistButton(d);

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

    $('#gameModal').hidden = false;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => drawChart(d));
  }

  function fillWishlistButton(d) {
    const inWl = wishlistFor(state.region).has(d.id);
    $('#modalWishlist').textContent = inWl ? t('inWishlist') : t('addWishlist');
    $('#modalWishlist').onclick = () => {
      toggleWishlist(d.id);
      fillWishlistButton(d);
      applyFilters();
    };
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
    const name = r ? `${r.flag} ${r.name[state.lang] || r.name.en}` : '';
    $('#subscribeText').textContent = t('subscribeText', { region: name });
  }

  function openSubscribeModal() {
    fillSubscribeText();
    $('#subscribeSuccess').hidden = true;
    $('#subscribeError').hidden = true;
    $('#subscribeForm').hidden = false;
    $('#subscribeModal').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => $('#emailInput').focus(), 50);
  }

  function closeSubscribeModal() {
    $('#subscribeModal').hidden = true;
    document.body.style.overflow = '';
  }

  async function handleSubscribe(e) {
    e.preventDefault();
    const username = window.APP_CONFIG.buttondownUsername;
    const errEl = $('#subscribeError');
    if (!username || username === 'YOUR_BUTTONDOWN_USERNAME') {
      errEl.textContent = t('subscribeNotConfigured');
      errEl.hidden = false;
      return;
    }
    const email = $('#emailInput').value.trim();
    if (!email) return;
    const r = currentRegion();
    const body = new URLSearchParams({ email, tag: 'psdeals-' + (r ? r.country.toLowerCase() : 'in') });
    try {
      await fetch(`https://buttondown.com/api/emails/embed-subscribe/${username}`, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      $('#subscribeForm').hidden = true;
      $('#subscribeSuccess').hidden = false;
    } catch {
      errEl.textContent = t('error');
      errEl.hidden = false;
    }
  }

  /* ---------- Events ---------- */
  function bindEvents() {
    $('#regionBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      const picker = $('#regionPicker');
      const open = picker.classList.toggle('open');
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
        if (state.data) renderStats();
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
      } else {
        state.platform = chip.dataset.platform;
        document.querySelectorAll('#platformChips .chip[data-platform]').forEach((c) => c.classList.toggle('active', c === chip));
      }
      applyFilters();
    });

    $('#sortSelect').addEventListener('change', (e) => {
      state.sort = e.target.value;
      applyFilters();
    });

    $('#retryBtn').addEventListener('click', loadRegion);
    $('#subscribeBtn').addEventListener('click', openSubscribeModal);
    $('#modalNotify').addEventListener('click', () => {
      closeGameModal();
      openSubscribeModal();
    });
    $('#subscribeForm').addEventListener('submit', handleSubscribe);

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
      if (!$('#gameModal').hidden && state.modalDeal) drawChart(state.modalDeal);
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