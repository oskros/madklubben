const REPO = { owner: 'oskros', name: 'madklubben' };

// ---------- budget math ----------

const DAY = 86400000;
const toMs = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = ms => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);

export function rateFor(rates, month) {
  let rate = 0;
  for (const r of [...rates].sort((a, b) => a.from.localeCompare(b.from))) if (r.from <= month) rate = r.perPerson;
  return rate;
}

// Each member pays into the account on the 1st of every month.
function* months(after, until) {
  let y = +after.slice(0, 4), m = +after.slice(5, 7);
  for (;;) {
    if (++m > 12) { m = 1; y++; }
    const month = `${y}-${String(m).padStart(2, '0')}`;
    if (`${month}-01` > until) return;
    yield month;
  }
}

export function depositsBetween(data, after, until) {
  let sum = 0;
  for (const month of months(after, until)) sum += rateFor(data.rates, month) * data.members;
  return sum;
}

// Bank CSV export (Danish): semicolon separated, header row with "Dato" and "Saldo", dates dd.mm.yyyy,
// amounts like "9.700,00", newest transaction first.
export function latestBalance(csv) {
  const rows = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(r => r.trim()).map(r => r.split(';').map(c => c.trim().replace(/^"|"$/g, '')));
  const head = rows[0].map(h => h.toLowerCase());
  const di = head.indexOf('dato'), si = head.indexOf('saldo');
  if (di < 0 || si < 0) throw new Error('Filen har ikke kolonnerne Dato og Saldo.');
  let best = null;
  for (const r of rows.slice(1)) {
    const m = r[di]?.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    const balance = Number(r[si]?.replace(/\./g, '').replace(',', '.'));
    if (!m || !Number.isFinite(balance)) continue;
    const date = `${m[3]}-${m[2]}-${m[1]}`;
    if (!best || date > best.date) best = { date, balance };
  }
  if (!best) throw new Error('Fandt ingen posteringer i filen.');
  return best;
}

// Dinners outside the club (Oskar's own visits) never touch the madkonto.
export const isClub = d => (d.group ?? 'madklubben') === 'madklubben';
export const fromFund = d => (d.price ?? 0) - (d.outOfPocket ?? 0);
const spentBetween = (data, after, until) => data.dinners.filter(d => isClub(d) && d.date > after && d.date <= until).reduce((s, d) => s + fromFund(d), 0);

// A checkpoint is the bank balance at the end of its date, so dinners that day are already paid.
export function balance(data, date) {
  const cp = data.checkpoints.filter(c => c.date <= date).sort((a, b) => a.date.localeCompare(b.date)).at(-1)
    ?? { date: '0000-00-00', balance: 0 };
  return cp.balance + depositsBetween(data, cp.date, date) - spentBetween(data, cp.date, date);
}

// Everything paid in since the account opened, against everything the dinners took out of it.
export function ledger(data, date) {
  const start = [...data.checkpoints].sort((a, b) => a.date.localeCompare(b.date))[0] ?? { date: '0000-00-00', balance: 0 };
  const periods = [];
  for (const month of months(start.date, date)) {
    const perPerson = rateFor(data.rates, month), last = periods.at(-1);
    if (last?.perPerson === perPerson) { last.months++; last.amount += perPerson * data.members; }
    else periods.push({ from: month, perPerson, months: 1, amount: perPerson * data.members });
  }
  const paidIn = periods.reduce((s, p) => s + p.amount, 0);
  const spent = spentBetween(data, start.date, date);
  const expected = start.balance + paidIn - spent, actual = balance(data, date);
  return { start, periods, paidIn, spent, expected, actual, difference: actual - expected };
}

export function forecast(data, today) {
  const dates = data.dinners.filter(isClub).map(d => d.date).sort();
  if (dates.length < 2) return null;
  const avgDays = daysBetween(dates[0], dates.at(-1)) / (dates.length - 1);
  const next = toIso(Math.max(toMs(dates.at(-1)) + avgDays * DAY, toMs(today)));
  return { avgDays: Math.round(avgDays), next, savings: balance(data, next) };
}

// ---------- everything below needs a browser ----------

if (typeof document !== 'undefined') main();

function main() {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const safeUrl = u => /^https?:\/\//i.test(u ?? '') ? esc(u) : '';
  const kr = n => n == null ? '–' : new Intl.NumberFormat('da-DK', { style: 'currency', currency: 'DKK', maximumFractionDigits: 0 }).format(n);
  const dato = iso => new Date(toMs(iso)).toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(/ /g, '\u00a0');
  const maaned = ym => new Date(toMs(`${ym}-01`)).toLocaleDateString('da-DK', { month: 'long', year: 'numeric', timeZone: 'UTC' }).replace(/ /g, '\u00a0');
  const today = () => new Date().toLocaleDateString('sv-SE');
  const slug = s => s.toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const byDate = (a, b) => b.date.localeCompare(a.date);

  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };
  let token = store.get('gh-token');
  let data;
  let editingIdea = null;
  const GROUPS = { madklubben: 'Madklubben', ida: 'Ida', andre: 'Andre' };
  const personal = () => store.get('mig') === '1';
  const groupFilter = () => personal() ? store.get('mig-filter') ?? 'madklubben' : 'madklubben';
  const shown = () => data.dinners.filter(d => groupFilter() === 'alle' || (d.group ?? 'madklubben') === groupFilter());
  const localUrls = {};

  // ---------- GitHub as storage ----------

  const base = `/repos/${REPO.owner}/${REPO.name}`;
  async function gh(path, opts = {}) {
    const r = await fetch('https://api.github.com' + path, {
      ...opts,
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}`, Accept: opts.accept ?? 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error(`GitHub svarede ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return opts.accept ? r.text() : r.json();
  }
  const post = (path, body, method = 'POST') => gh(path, { method, body: JSON.stringify(body) });

  const b64 = blob => new Promise((ok, fail) => {
    const fr = new FileReader();
    fr.onload = () => ok(fr.result.split(',')[1]);
    fr.onerror = fail;
    fr.readAsDataURL(blob);
  });

  // Applies `mutate` to the newest data.json on GitHub (not our possibly stale copy) and commits it
  // together with `files` ({path: Blob | null}) in one commit. A concurrent edit makes the ref update fail.
  async function save(message, mutate, files = {}, progress = () => {}) {
    const blobs = [];
    const entries = Object.entries(files);
    for (const [i, [path, blob]] of entries.entries()) {
      progress(`Uploader ${i + 1}/${entries.length}`);
      const sha = blob && (await post(`${base}/git/blobs`, { content: await b64(blob), encoding: 'base64' })).sha;
      blobs.push({ path, mode: '100644', type: 'blob', sha: sha ?? null });
    }
    progress('Gemmer');
    for (let attempt = 1; ; attempt++) {
      const ref = await gh(`${base}/git/ref/heads/main`);
      const head = await gh(`${base}/git/commits/${ref.object.sha}`);
      const fresh = JSON.parse(await gh(`${base}/contents/data.json?ref=${ref.object.sha}`, { accept: 'application/vnd.github.raw+json' }));
      mutate(fresh);
      const tree = [{ path: 'data.json', mode: '100644', type: 'blob', content: JSON.stringify(fresh, null, 1) + '\n' }, ...blobs];
      const t = await post(`${base}/git/trees`, { base_tree: head.tree.sha, tree });
      const c = await post(`${base}/git/commits`, { message, tree: t.sha, parents: [ref.object.sha] });
      try {
        await post(`${base}/git/refs/heads/main`, { sha: c.sha }, 'PATCH');
        data = fresh;
        return;
      } catch (e) {
        if (!e.message.includes('422') || attempt === 3) throw e;
      }
    }
  }

  async function load() {
    if (!token) {
      data = await (await fetch('data.json', { cache: 'no-cache' })).json();
      return;
    }
    const ref = await gh(`${base}/git/ref/heads/main`);
    data = JSON.parse(await gh(`${base}/contents/data.json?ref=${ref.object.sha}`, { accept: 'application/vnd.github.raw+json' }));
  }

  // ---------- photos ----------

  async function shrink(file, max, quality) {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise(ok => c.toBlob(ok, 'image/jpeg', quality));
  }

  const isVideo = name => name.endsWith('.mp4');
  const MEAT = ['Okse', 'Svin', 'Lam', 'Fjerkræ', 'Vildt'];
  const withMeat = tags => tags.some(t => MEAT.includes(t)) ? [...tags, 'Kød'] : tags;
  const COLOURS = ['rød', 'orange', 'gul', 'grøn', 'blå', 'lilla', 'lyserød', 'brun', 'sort', 'hvid'];
  const CATEGORIES = ['Fisk', 'Skaldyr', 'Okse', 'Svin', 'Lam', 'Fjerkræ', 'Vildt', 'Kød', 'Grønt', 'Svampe', 'Frugt', 'Nødder', 'Ost', 'Æg', 'Brød', 'Pasta & ris', 'Snack', 'Forret', 'Hovedret', 'Dessert', 'Petit four', 'Vin', 'Drinks'];
  const photoPath = (d, name, thumb) => `photos/${d.id}/${thumb ? 't/' : ''}${thumb && isVideo(name) ? name.replace(/\.mp4$/, '.jpg') : name}`;
  const photoUrl = (d, name, thumb) => localUrls[photoPath(d, name, thumb)] ?? photoPath(d, name, thumb);

  async function preparePhotos(d, fileList, progress) {
    const files = {}, names = [], failed = [];
    const stamp = Date.now().toString(36);
    for (const [i, f] of [...fileList].entries()) {
      progress(`Formindsker ${i + 1}/${fileList.length}`);
      try {
        const name = `${stamp}-${i}.jpg`;
        for (const [thumb, max, q] of [[false, 1600, 0.82], [true, 480, 0.75]]) {
          const blob = await shrink(f, max, q);
          files[photoPath(d, name, thumb)] = blob;
          localUrls[photoPath(d, name, thumb)] = URL.createObjectURL(blob);
        }
        names.push(name);
      } catch {
        failed.push(f.name);
      }
    }
    return { files, names, failed };
  }

  // ---------- views ----------

  const views = {
    '': dinnersPage,
    d: dinnerPage,
    ny: () => dinnerForm(null),
    ret: id => dinnerForm(data.dinners.find(d => d.id === id)),
    regnskab: balancePage,
    retter: dishesPage,
    forslag: ideasPage,
    login: loginPage,
    opsaetning: setupPage,
    config: configPage,
  };

  const ADP = 'https://cdn.jsdelivr.net/npm/air-datepicker@3.6.0';
  let datepickerLib, pickers = [];
  async function datePickers(inputs) {
    datepickerLib ??= Promise.all([import(`${ADP}/+esm`), import(`${ADP}/locale/da.js/+esm`)]).then(([dp, da]) => {
      $('link[href="style.css"]').insertAdjacentHTML('beforebegin', `<link rel="stylesheet" href="${ADP}/air-datepicker.css">`);
      const l = da.default.default ?? da.default;
      const lower = a => a.map(x => x.toLowerCase());
      return { AirDatepicker: dp.default, locale: { ...l, days: lower(l.days), daysShort: lower(l.daysShort), daysMin: lower(l.daysMin), months: lower(l.months), monthsShort: lower(l.monthsShort) } };
    });
    const { AirDatepicker, locale } = await datepickerLib;
    for (const input of inputs) {
      if (!input.isConnected) continue;
      const month = input.type === 'month';
      const shown = document.createElement('input');
      shown.readOnly = true;
      shown.className = 'date-shown';
      input.before(shown);
      input.type = 'hidden';
      const dp = new AirDatepicker(shown, {
        locale, autoClose: true, toggleSelected: false, altField: input,
        selectedDates: input.value ? [new Date(`${month ? `${input.value}-01` : input.value}T12:00`)] : [],
        dateFormat: month ? 'MMMM yyyy' : 'd. MMMM yyyy',
        altFieldDateFormat: month ? 'yyyy-MM' : 'yyyy-MM-dd',
        ...(month ? { view: 'months', minView: 'months' } : {}),
        navTitles: { days: 'MMMM <i>yyyy</i>', months: '<i>yyyy</i>', years: 'yyyy1 – yyyy2' },
        prevHtml: icon('prev'), nextHtml: icon('next'),
        buttons: [{ content: icon('today'), tagName: 'button', attrs: { type: 'button', title: 'Gå til i dag', 'aria-label': 'Gå til i dag' }, className: 'adp-today', onClick: dp => { dp.setViewDate(new Date()); dp.setCurrentView(month ? 'months' : 'days'); } }],
      });
      dp.$datepicker.addEventListener('click', e => {
        if (dp.currentView === 'days' && e.target.closest('.air-datepicker-nav--title i')) { e.stopPropagation(); dp.setCurrentView('years'); }
        if (e.target.closest(`.air-datepicker-cell.-selected-.-${month ? 'month' : 'day'}-`)) { e.stopPropagation(); dp.hide(); }
      }, true);
      pickers.push(dp);
    }
  }

  function render() {
    pickers.forEach(p => p.destroy());
    pickers = [];
    const [, view = '', arg] = decodeURIComponent(location.hash).split('/');
    const html = (views[view] ?? dinnersPage)(arg);
    $('main').innerHTML = html ?? '<p>Ikke fundet.</p>';
    $('#auth').innerHTML = `${icon(token ? 'logout' : 'login')}<span>${token ? 'Log ud' : 'Log ind'}</span>`;
    $('#auth').href = token ? '#/logud' : '#/login';
    renderFilter();
    const section = ['d', 'ny', 'ret'].includes(view) ? '' : view;
    document.querySelectorAll('.top nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === `#/${section}`));
    const dinner = $('form[data-form=dinner]');
    if (dinner) { billPreview(dinner); refreshCourseSelects(dinner); }
    document.querySelectorAll('textarea.grow').forEach(grow);
    if ($('#map')) drawMap($('#map'));
    if ($('.dish-search')?.value) filterDishes();
    const dates = document.querySelectorAll('main input[type=date], main input[type=month]');
    if (dates.length) datePickers(dates);
    const pick = $('.pick'), courses = $('.menu-edit');
    if (pick || courses) import('https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/+esm').then(({ default: Sortable }) => {
      const hold = { delay: 300, delayOnTouchOnly: true, touchStartThreshold: 6 };
      if (pick) Sortable.create(pick, { animation: 150, forceFallback: true, ...hold, filter: '.del, .course-btn, .note-btn', preventOnFilter: false });
      if (courses) Sortable.create(courses, { animation: 150, forceFallback: true, ...hold, handle: '.grip', onEnd: () => refreshCourseSelects(dinner) });
    });
  }

  const editOnly = html => token ? html : '';

  const ICONS = {
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    pin: '<path d="M20 10c0 5-5.5 10.2-7.4 11.8a1 1 0 0 1-1.2 0C9.5 20.2 4 15 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    album: '<path d="M18 22H4a2 2 0 0 1-2-2V6"/><path d="m22 13-1.3-1.3a2.4 2.4 0 0 0-3.4 0L11 18"/><circle cx="12" cy="8" r="2"/><rect width="16" height="16" x="6" y="2" rx="2"/>',
    edit: '<path d="M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8L2 21.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z"/><path d="m15 5 4 4"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
    camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    eye: '<path d="M2.1 12.3a1 1 0 0 1 0-.6 10.8 10.8 0 0 1 19.8 0 1 1 0 0 1 0 .6 10.8 10.8 0 0 1-19.8 0"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M10.7 5.1A10.7 10.7 0 0 1 21.9 11.7a1 1 0 0 1 0 .7 10.8 10.8 0 0 1-1.4 2.4"/><path d="M14.1 14.2a3 3 0 0 1-4.2-4.2"/><path d="M17.5 17.5a10.8 10.8 0 0 1-15.4-5.1 1 1 0 0 1 0-.7 10.8 10.8 0 0 1 4.4-5.2"/><path d="m2 2 20 20"/>',
    grip: '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',
    next: '<path d="m9 18 6-6-6-6"/>',
    video: '<rect width="14" height="12" x="2" y="6" rx="2"/><path d="m22 8-6 4 6 4z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4.2-4.2"/>',
    play: '<path d="M7 4.5v15l12.5-7.5z" fill="currentColor" stroke="none"/>',
    prev: '<path d="m15 18-6-6 6-6"/>',
    today: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><circle cx="12" cy="15.5" r="1.7" fill="currentColor" stroke="none"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  };
  const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  const iconLink = (href, name, label, extra = '') => `<a class="icon-btn" href="${href}" aria-label="${label}" title="${label}" ${extra}>${icon(name)}</a>`;
  const iconButton = (name, label, attrs = '') => `<button type="button" class="icon-btn" aria-label="${label}" title="${label}" ${attrs}>${icon(name)}</button>`;
  const host = u => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/$/, '')}`; } catch { return u; } };
  const heads = d => isClub(d) ? data.members : d.people || 2;
  const estKr = (d, v) => (v && d.priceEstimate ? '~' : '') + kr(v);
  const perPerson = d => d.price ? estKr(d, d.price / heads(d)) : '–';

  function mediaCount(d) {
    const videos = d.photos.filter(isVideo).length, pics = d.photos.length - videos;
    return `<span class="photos${d.photos.length ? '' : ' none'}"><span title="${pics} billeder">${icon('camera')}${pics}</span>${videos ? `<span title="${videos} ${videos === 1 ? 'video' : 'videoer'}">${icon('video')}${videos}</span>` : ''}</span>`;
  }

  function cover(d) {
    const src = d.image ?? (d.photos[0] && photoUrl(d, d.photos[0], true));
    return src
      ? `<img src="${esc(src)}" alt="" loading="lazy">`
      : `<span class="initial">${esc(d.restaurant[0])}</span>`;
  }

  const menuList = d => `<ol class="menu">${d.menu.map(c => `<li>${esc(c)}</li>`).join('')}</ol>`;

  function dinnerPage(id) {
    const d = data.dinners.find(x => x.id === id);
    if (!d) return null;
    const hero = d.image ?? (d.photos[0] && photoUrl(d, d.photos[0], isVideo(d.photos[0])));
    return `
      <div class="toolbar">
        ${iconLink('#/', 'back', 'Til forsiden')}
        ${editOnly(iconLink(`#/ret/${esc(d.id)}`, 'edit', 'Redigér middag og billeder'))}
      </div>
      <div class="dinner${hero || d.menu.length ? '' : ' single'}">
      ${hero || d.menu.length ? `<div class="dinner-side">
        ${hero ? `<img class="dinner-img" src="${esc(hero)}" alt="">` : ''}
        ${d.menu.length ? `<section class="menu-card"><h2>Menu</h2>${menuList(d)}</section>` : ''}
      </div>` : ''}
      <div class="dinner-main">
        <header class="dinner-head">
          <p class="date">${dato(d.date)}</p>
          <h1>${esc(d.restaurant)}</h1>
          <ul class="links">
            ${d.address ? `<li><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${d.restaurant}, ${d.address}`)}" target="_blank" rel="noopener">${icon('pin')}<span>${esc(d.address)}</span></a></li>` : ''}
            ${safeUrl(d.website) ? `<li><a href="${safeUrl(d.website)}" target="_blank" rel="noopener">${icon('external')}<span>${esc(host(d.website))}</span></a></li>` : ''}
            ${safeUrl(d.album) ? `<li><a href="${safeUrl(d.album)}" target="_blank" rel="noopener">${icon('album')}<span>Google Photos</span></a></li>` : ''}
            ${d.closed ? `<li class="muted">Lukket</li>` : ''}
          </ul>
          ${d.note ? `<p class="note">${esc(d.note)}</p>` : ''}
          <dl class="figures">
            <div><dt>Regning${d.priceEstimate ? ' (anslået)' : ''}</dt><dd>${estKr(d, d.price)}</dd></div>
            <div><dt>Pr. person</dt><dd>${perPerson(d)}</dd></div>
            ${isClub(d) ? `<div><dt>Fra madkonto</dt><dd>${d.price ? estKr(d, fromFund(d)) : '–'}</dd></div>
            <div><dt>Eget indskud pr. person</dt><dd>${d.outOfPocket == null ? '–' : estKr(d, d.outOfPocket / data.members)}</dd></div>` : `<div><dt>Med</dt><dd>${GROUPS[d.group] ?? 'Andre'}</dd></div>`}
          </dl>
        </header>
        <section class="dinner-photos">
          <h2>Billeder <span class="count">${d.photos.length || ''}</span></h2>
          ${d.photos.length ? `<div class="grid">${d.photos.map((p, i) => `
            <button data-photo="${i}" aria-label="Billede ${i + 1}"${d.photoCredits?.[p] ? ` title="Foto: ${esc(d.photoCredits[p])}"` : ''}><img src="${esc(photoUrl(d, p, true))}" alt="" loading="lazy">${isVideo(p) ? `<span class="play-badge" aria-label="Video">${icon('play')}</span>` : ''}${d.photoCredits?.[p] ? `<span class="credit-badge" aria-label="Lånt billede">${icon('external')}</span>` : ''}</button>`).join('')}</div>`
            : `<p class="muted">Ingen billeder endnu.${token ? ` <a href="#/ret/${esc(d.id)}">Tilføj billeder</a>` : ''}</p>`}
        </section>
      </div>
      </div>`;
  }

  let courseKeys = 0;
  const courseRow = (c = '', key = `n${courseKeys++}`) => `<li><span class="grip" title="Træk for at flytte">${icon('grip')}</span><input type="hidden" name="menuKey" value="${esc(key)}"><input name="menu" value="${esc(c)}" aria-label="Ret" autocomplete="off">${iconButton('x', 'Fjern ret', 'data-action="remove-course" tabindex="-1"')}</li>`;
  const coursesOf = (d, p) => [d.photoCourses?.[p] ?? []].flat().filter(n => d.menu[n] != null);
  const courseRows = form => [...form.querySelectorAll('.menu-edit li')]
    .map(li => ({ key: li.querySelector('[name=menuKey]').value, text: li.querySelector('[name=menu]').value.trim() }))
    .filter(r => r.text);

  function refreshCourseSelects(form) {
    const rows = courseRows(form);
    form.querySelectorAll('.tile [name=course]').forEach(input => {
      const picked = rows.map((r, i) => ({ ...r, i })).filter(r => input.value.split(' ').includes(r.key));
      input.value = picked.map(r => r.key).join(' ');
      const btn = input.nextElementSibling;
      btn.innerHTML = picked.length
        ? `<span>${picked[0].i + 1}. ${esc(picked[0].text)}</span>${picked.length > 1 ? `<b>+${picked.length - 1}</b>` : ''}`
        : '<span>Tilføj ret</span>';
      btn.title = picked.map(r => `${r.i + 1}. ${r.text}`).join('\n');
      btn.classList.toggle('on', picked.length > 0);
    });
  }

  function editPhotoNote(btn) {
    const tile = btn.parentElement;
    const note = tile.querySelector('[name=photoNote]'), credit = tile.querySelector('[name=photoCredit]');
    let dlg = $('#photo-note');
    if (!dlg) {
      document.body.insertAdjacentHTML('beforeend', `<dialog id="photo-note"><form method="dialog">
        <h3>Billedet</h3>
        <label>Note <input name="n" autocomplete="off" placeholder="Vises i billedfremviseren"></label>
        <label>Kilde, hvis billedet ikke er vores <input name="c" autocomplete="off" placeholder="fx Jonathan Snook, fifty.snook.ca (nov. 2018)"></label>
        <div class="row"><button class="btn" value="ok">Færdig</button> <button class="btn ghost" value="cancel" formnovalidate>Annullér</button></div>
      </form></dialog>`);
      dlg = $('#photo-note');
    }
    const f = dlg.querySelector('form');
    f.n.value = note.value;
    f.c.value = credit.value;
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return;
      note.value = f.n.value.trim();
      credit.value = f.c.value.trim();
      btn.classList.toggle('on', !!(note.value || credit.value));
      btn.title = [note.value, credit.value && `Foto: ${credit.value}`].filter(Boolean).join(' · ') || 'Note og kilde';
    };
    dlg.returnValue = '';
    dlg.showModal();
    f.n.focus();
  }

  function pickCourses(btn) {
    const input = btn.previousElementSibling, form = btn.form;
    let dlg = $('#course-picker');
    if (!dlg) {
      document.body.insertAdjacentHTML('beforeend', '<dialog id="course-picker"><form method="dialog"><h3>Retter på billedet</h3><div class="opts"></div><button class="btn">Færdig</button></form></dialog>');
      dlg = $('#course-picker');
    }
    const on = input.value.split(' ');
    const rows = courseRows(form);
    dlg.querySelector('.opts').innerHTML = rows.length
      ? rows.map((r, i) => `<label class="check"><input type="checkbox" value="${esc(r.key)}" ${on.includes(r.key) ? 'checked' : ''}> ${i + 1}. ${esc(r.text)}</label>`).join('')
      : '<p class="muted">Skriv menuen først.</p>';
    dlg.onclose = () => {
      input.value = [...dlg.querySelectorAll('.opts input:checked')].map(c => c.value).join(' ');
      refreshCourseSelects(form);
    };
    dlg.showModal();
  }

  function billPreview(form) {
    const price = +form.price.value || 0;
    const club = (form.group?.value ?? 'madklubben') === 'madklubben';
    form.querySelectorAll('.club-only').forEach(el => { el.hidden = !club; });
    form.querySelectorAll('.own-only').forEach(el => { el.hidden = club; });
    const n = club ? data.members : +form.people?.value || 2;
    const own = (+form.outOfPocket.value || 0) * data.members;
    form.querySelector('.bill').textContent = !price ? '' : club
      ? `${kr(price - own)} fra madkontoen, ${kr(price / n)} pr. person`
      : `${kr(price / n)} pr. person`;
  }

  function dinnerForm(d) {
    if (!token) return loginPage();
    const v = d ?? { date: today(), restaurant: '', website: '', price: '', outOfPocket: 0, note: '', menu: [], photos: [], closed: false, group: groupFilter() === 'alle' ? 'madklubben' : groupFilter() };
    return `
      <div class="toolbar">${iconLink(d ? `#/d/${esc(d.id)}` : '#/', 'back', 'Tilbage')}</div>
      <h1>${d ? esc(d.restaurant) : 'Ny middag'}</h1>
      <form data-form="dinner" data-id="${esc(d?.id ?? '')}" class="dinner-form">
        <section>
          ${personal() || !isClub(v) ? `<label>Hvem <select name="group">${Object.entries(GROUPS).map(([k, n]) => `<option value="${k}" ${(v.group ?? 'madklubben') === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}
          <label>Restaurant <input name="restaurant" required value="${esc(v.restaurant)}" autocomplete="off"></label>
          <div class="pair">
            <label>Dato <input name="date" type="date" required value="${esc(v.date)}"></label>
            <label>Hjemmeside <input name="website" type="url" value="${esc(v.website)}" placeholder="https://"></label>
          </div>
          <div class="address-field">
            <label>Adresse <input name="addressQuery" value="${esc(v.address ?? '')}" placeholder="Søg efter adressen" autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="address-list"></label>
            <input type="hidden" name="address" value="${esc(v.address ?? '')}"><input type="hidden" name="lat" value="${esc(v.lat ?? '')}"><input type="hidden" name="lon" value="${esc(v.lon ?? '')}">
            <ul class="suggest" id="address-list" role="listbox" hidden></ul>
          </div>
          <label>Note <textarea name="note" rows="3" class="grow">${esc(v.note)}</textarea></label>
          ${d ? `<label class="check"><input name="closed" type="checkbox" ${v.closed ? 'checked' : ''}> Restauranten er lukket</label>` : ''}
        </section>
        <section>
          <h2>Regning</h2>
          <div class="pair">
            <label>I alt, kr. <input name="price" type="number" min="0" inputmode="numeric" value="${esc(v.price)}"></label>
            <label class="own-only">Antal personer <input name="people" type="number" min="1" inputmode="numeric" value="${esc(v.people ?? 2)}"></label>
            <label class="club-only">Eget indskud pr. person, kr. <input name="outOfPocket" type="number" min="0" step="any" inputmode="decimal" value="${v.outOfPocket == null ? '' : Math.round(v.outOfPocket / data.members * 100) / 100}"></label>
          </div>
          <label class="check"><input name="priceEstimate" type="checkbox" ${v.priceEstimate ? 'checked' : ''}> Beløbet er anslået</label>
          <p class="bill muted"></p>
        </section>
        <section>
          <h2>Menu</h2>
          <ol class="menu-edit">${(v.menu.length ? v.menu : ['']).map((c, i) => courseRow(c, `o${i}`)).join('')}</ol>
          <button type="button" class="add-row" data-action="add-course">${icon('plus')}Tilføj ret</button>
        </section>
        <section class="drop">
          <h2>Billeder <span class="count">${v.photos.length || ''}</span></h2>
          <label class="upload">${icon('plus')}<span>Vælg billeder</span><input name="photos" type="file" accept="image/*" multiple></label>
          <p class="muted small">Eller træk dem herind. De formindskes før upload.${v.photos.length ? ' Træk billederne nedenfor for at ændre rækkefølgen.' : ''}</p>
          ${v.photos.length ? `<div class="grid pick">${v.photos.map(p => `
            <div class="tile"><input type="hidden" name="order" value="${esc(p)}"><img src="${esc(photoUrl(d, p, true))}" alt="" loading="lazy" draggable="false">
              <label class="del" title="Slet billede"><input type="checkbox" name="delete" value="${esc(p)}" aria-label="Slet billede">${icon('trash')}</label>
              <input type="hidden" name="photoNote" value="${esc(v.photoNotes?.[p] ?? '')}">
              <input type="hidden" name="photoCredit" value="${esc(v.photoCredits?.[p] ?? '')}">
              <button type="button" class="note-btn${v.photoNotes?.[p] || v.photoCredits?.[p] ? ' on' : ''}" data-action="photo-note" title="${esc([v.photoNotes?.[p], v.photoCredits?.[p] && `Foto: ${v.photoCredits[p]}`].filter(Boolean).join(' · ') || 'Note og kilde')}" aria-label="Note og kilde til billedet">${icon('edit')}</button>
              <input type="hidden" name="course" value="${coursesOf(v, p).map(n => `o${n}`).join(' ')}"><button type="button" class="course-btn" data-action="pick-courses" aria-label="Retter på billedet"></button></div>`).join('')}</div>` : ''}
        </section>
        <div class="actions">
          <button class="btn">${icon('check')}Gem</button> <span class="status"></span>
          ${d ? `<button type="button" class="btn danger" data-action="delete-dinner">${icon('trash')}Slet middag</button>` : ''}
        </div>
      </form>`;
  }

  function dishPhoto(d) {
    const linked = d.photos.filter(p => coursesOf(d, p).length);
    const notMenu = d.photos.filter(p => !d.photoTags?.[p]?.includes('menukort'));
    const pool = linked.length ? linked : notMenu.length ? notMenu : d.photos;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function photoStrip() {
    const withPhotos = [...shown()].sort(byDate).filter(d => d.photos.length);
    if (!withPhotos.length) return '';
    return `<div class="strip">${withPhotos.map(d => `
      <a href="#/d/${esc(d.id)}" title="${esc(d.restaurant)}">
        <img src="${esc(photoUrl(d, dishPhoto(d), true))}" alt="${esc(d.restaurant)}" loading="lazy">
        <span>${esc(d.restaurant)}</span>
      </a>`).join('')}</div>`;
  }

  function timeline() {
    const dates = shown().map(d => d.date).sort();
    if (!dates.length) return '';
    const first = +dates[0].slice(0, 4), last = +today().slice(0, 4) + 1;
    const start = toMs(`${first}-01-01`), span = toMs(`${last}-01-01`) - start;
    const pos = iso => ((toMs(iso) - start) / span * 100).toFixed(2);
    const years = Array.from({ length: last - first + 1 }, (_, i) => first + i);
    return `
      <section class="timeline">
        <h2>Tidslinje</h2>
        <div class="track">
          ${years.map(y => `<span class="year" style="left:${pos(`${y}-01-01`)}%">${y < last ? y : ''}</span>`).join('')}
          ${[...shown()].sort((a, b) => a.date.localeCompare(b.date)).map(d => `<a class="dot${isClub(d) ? '' : ' own'}" href="#/d/${esc(d.id)}" style="left:${pos(d.date)}%" title="${esc(d.restaurant)}, ${dato(d.date)}" aria-label="${esc(d.restaurant)}"></a>`).join('')}
          <span class="now" style="left:${pos(today())}%" title="I dag"></span>
        </div>
      </section>`;
  }

  function dinnersPage() {
    const list = shown();
    return `
      ${photoStrip()}
      ${timeline()}
      <div class="section-head">
        <h1>${groupFilter() === 'madklubben' || groupFilter() === 'alle' ? 'Middage' : GROUPS[groupFilter()]} <span class="count">${list.length}</span></h1>
        ${editOnly(`<a class="btn" href="#/ny">${icon('plus')}Ny middag</a>`)}
      </div>
      <div class="cards">${[...list].sort(byDate).map(d => `<a class="card${isClub(d) ? '' : ' own'}" href="#/d/${esc(d.id)}">
        <span class="card-logo">${cover(d)}</span>
        <span class="card-text"><strong>${esc(d.restaurant)}</strong>
          <span class="card-meta"><span>${dato(d.date)}</span>${mediaCount(d)}${isClub(d) || groupFilter() !== 'alle' ? '' : `<span class="tag">${GROUPS[d.group] ?? 'Andre'}</span>`}</span></span>
      </a>`).join('')}</div>
      ${list.some(d => d.lat) ? '<section class="map-section"><h2>Kort</h2><div id="map" role="region" aria-label="Kort over restauranterne"></div></section>' : ''}`;
  }

  function balancePage() {
    const now = today();
    const f = forecast(data, now);
    const l = ledger(data, now);
    const club = data.dinners.filter(isClub).sort(byDate);
    const total = fn => club.reduce((sum, d) => sum + fn(d), 0);
    const row = (label, amount, detail = '', cls = '') => `<tr${cls ? ` class="${cls}"` : ''}><td>${label}${detail ? ` <span class="muted">${detail}</span>` : ''}</td><td class="num">${amount}</td></tr>`;
    return `
      <h1>Regnskab</h1>
      <dl class="keyfigs">
        <div class="main"><dt>Saldo</dt><dd>${kr(l.actual)}</dd><small>${dato(now)}</small></div>
        ${f ? `<div><dt>Næste middag</dt><dd>${dato(f.next)}</dd><small>Gns. hver ${f.avgDays}. dag</small></div>
        <div><dt>Opsparet til næste middag</dt><dd>${kr(f.savings)}</dd><small>${kr(f.savings / data.members)} pr. person</small></div>` : ''}
      </dl>
      <div class="books">
        <section class="b-in">
          <h2>Indtægter</h2>
          <table class="plain ledger">
            ${l.periods.filter(p => p.amount).map(p => row(`${kr(p.perPerson)}/md. fra ${maaned(p.from)}`, kr(p.amount), `${p.months} mdr. × ${data.members}`)).join('')}
            ${row('Indtægter i alt', kr(l.paidIn), '', 'sum')}
          </table>
          ${editOnly(`<details class="add"><summary>${icon('plus')}Ny sats</summary><form data-form="rate" class="add-form">
            <label>Fra måned <input name="from" type="month" required value="${now.slice(0, 7)}"></label>
            <label>Kr. pr. person <input name="perPerson" type="number" min="0" inputmode="numeric" required></label>
            <div class="add-actions"><button class="btn">${icon('check')}Gem</button> <span class="status"></span></div></form></details>`)}
        </section>
        <section class="b-st">
          <h2>Kontoudtog</h2>
          <table class="plain ledger">${[...data.checkpoints].sort((a, b) => a.date.localeCompare(b.date)).map(c => row(dato(c.date), kr(c.balance), c.note ? esc(c.note) : '')).join('')}</table>
          ${editOnly(`<div class="bank-add"><details class="add"><summary>${icon('plus')}Ny saldo</summary><form data-form="checkpoint" class="add-form">
            <label>Dato <input name="date" type="date" required value="${now}"></label>
            <label>Saldo, kr. <input name="balance" type="number" step="any" inputmode="decimal" required></label>
            <label class="span2">Note <input name="note"></label>
            <div class="add-actions"><button class="btn">${icon('check')}Gem</button> <span class="status"></span></div></form></details>
          <label class="csv-link">eller upload CSV fra banken<input name="bankcsv" type="file" accept=".csv,text/csv"></label></div>
          <p class="muted small bank-status"></p>`)}
        </section>
      <section class="expenses">
        <h2>Udgifter</h2>
        <table class="plain ledger">
          <thead><tr><th class="wide">Dato</th><th>Restaurant</th><th class="num wide">Regning</th><th class="num">Fra madkonto</th><th class="num wide">Eget indskud</th><th class="num wide">Pr. person</th></tr></thead>
          <tbody>${club.map(d => `<tr data-href="#/d/${esc(d.id)}">
            <td class="wide">${dato(d.date)}</td>
            <td><a href="#/d/${esc(d.id)}">${esc(d.restaurant)}</a><span class="narrow sub">${dato(d.date)}</span></td>
            <td class="num wide">${estKr(d, d.price)}</td>
            <td class="num">${d.price ? estKr(d, fromFund(d)) : '–'}<span class="narrow sub">af ${estKr(d, d.price)}</span></td>
            <td class="num wide">${estKr(d, d.outOfPocket)}</td><td class="num wide">${perPerson(d)}</td></tr>`).join('')}</tbody>
          <tfoot><tr class="sum"><td class="wide">Udgifter i alt</td><td><span class="narrow">Udgifter i alt</span></td><td class="num wide">${kr(total(d => d.price))}</td><td class="num">${kr(total(fromFund))}<span class="narrow sub">af ${kr(total(d => d.price))}</span></td>
            <td class="num wide">${kr(total(d => d.outOfPocket ?? 0))}</td><td class="num wide">${kr(total(d => (d.price ?? 0) / heads(d)))}</td></tr></tfoot>
        </table>
      </section>
      <section class="reconciliation">
        <h2>Afstemning</h2>
        <table class="plain ledger">
          ${row('Indtægter i alt', kr(l.paidIn))}
          ${row('Udgifter i alt', `−${kr(l.spent)}`, 'fra madkontoen')}
          ${row('Forventet balance', kr(l.expected), '', 'sum')}
          ${row('Balance', kr(l.actual))}
          ${row('Difference', kr(l.difference).replace('-', '−'), '', 'sum')}
        </table>
        ${data.ledgerNote ? `<p class="muted small">${esc(data.ledgerNote)}</p>` : ''}
      </section>
      </div>`;
  }

  function dishesPage(query = '') {
    const tiles = [...shown()].sort(byDate).flatMap(d => {
      const list = [], byPhoto = {};
      d.menu.forEach((c, n) => {
        const i = d.photos.findIndex(p => coursesOf(d, p).includes(n));
        if (i >= 0 && byPhoto[i]) return byPhoto[i].names.push(c);
        list.push(byPhoto[i] = { d, i, names: [c] });
      });
      d.photos.forEach((p, i) => {
        if (!coursesOf(d, p).length && d.photoTags?.[p]?.some(t => t === 'Vin' || t === 'Drinks')) list.push({ d, i, names: [], drink: true });
      });
      return list.map(t => {
        const photoTags = withMeat(t.i >= 0 ? d.photoTags?.[d.photos[t.i]] ?? [] : []);
        const dishTags = name => withMeat(d.dishTags?.[name] ?? []);
        const cats = CATEGORIES.filter(c => photoTags.includes(c) || t.names.some(name => dishTags(name).includes(c)));
        const per = Object.fromEntries(cats.map(c => [c, t.names.filter(name => dishTags(name).includes(c)).length || 1]));
        return { ...t, cats, per, colours: photoTags.filter(w => COLOURS.includes(w)), words: photoTags.filter(w => !CATEGORIES.includes(w) && !COLOURS.includes(w)) };
      });
    });
    return `
      <div class="section-head"><h1>Retter${query ? `<span class="query">: ${esc(query)}</span>` : ''} <span class="count">${tiles.reduce((n, t) => n + t.names.length, 0)}</span></h1>${iconButton('search', 'Søg', 'data-action="open-search"')}</div>
      <form class="dish-search-form" role="search">${icon('search')}<input type="search" class="dish-search" value="${esc(query)}" enterkeyhint="search" placeholder="Søg, fx fisk, ost eller dessert" aria-label="Søg i retter" autocomplete="off"><button class="search-go">Søg</button></form>
      <div class="dishes">${tiles.map(({ d, i, names, cats, per, colours, words, drink }) => `
        <figure data-n="${names.length}" data-colours="${esc(colours.join(' '))}" data-cats="${esc(cats.map(c => `${c}:${per[c]}`).join('|'))}" data-q="${esc(`${names.join(' ')} ${d.restaurant} ${cats.join(' ')} ${words.join(' ')}`.toLowerCase())}">
          ${i >= 0
            ? `<button data-photo="${i}" data-dinner="${esc(d.id)}" aria-label="Se billedet af ${esc(names.join(', '))}"><img src="${esc(photoUrl(d, d.photos[i], true))}" alt="" loading="lazy">${isVideo(d.photos[i]) ? `<span class="play-badge" aria-label="Video">${icon('play')}</span>` : ''}</button>`
            : `<a class="no-photo" href="#/d/${esc(d.id)}" aria-label="${esc(d.restaurant)}">${icon('camera')}<span>Intet billede</span></a>`}
          <figcaption><span>${drink ? esc(cats.filter(c => c === 'Vin' || c === 'Drinks').join(', ')) : names.map(esc).join('<br>')}</span>${names.length > 1 ? `<small>${names.length} retter på billedet</small>` : ''}<a href="#/d/${esc(d.id)}">${esc(d.restaurant)}, ${esc(d.date.slice(0, 4))}</a></figcaption>
        </figure>`).join('')}</div>
      <p class="muted dish-empty" hidden>Ingen retter matcher søgningen.</p>`;
  }

  function ideasPage() {
    const fields = (x = {}) => `
      <label>Restaurant <input name="name" required value="${esc(x.name)}"></label>
      <label>Link <input name="url" type="url" value="${esc(x.url)}"></label>
      <label>Note <input name="note" value="${esc(x.note)}"></label>`;
    return `
      <div class="section-head"><h1>Forslag <span class="count">${data.ideas.length || ''}</span></h1></div>
      <ul class="ideas">${data.ideas.map((x, i) => token && i === editingIdea ? `
        <li class="idea">
          <form data-form="editIdea" data-i="${i}" class="card-form">${fields(x)}
            <div class="add-actions"><button class="btn">${icon('check')}Gem</button>${iconButton('x', 'Annuller', 'data-action="cancel-idea"')} <span class="status"></span></div>
          </form></li>` : `
        <li class="idea">
          <strong>${esc(x.name)}</strong>
          ${safeUrl(x.url) ? `<a class="host" href="${safeUrl(x.url)}" target="_blank" rel="noopener">${icon('external')}${esc(host(x.url))}</a>` : ''}
          ${x.note ? `<p class="muted">${esc(x.note)}</p>` : ''}
          ${editOnly(`<span class="tools">${iconButton('edit', 'Ret forslag', `data-action="edit-idea" data-i="${i}"`)}${iconButton('trash', 'Fjern forslag', `data-action="delete-idea" data-i="${i}"`)}</span>`)}
        </li>`).join('')}
        ${editOnly(`<li class="idea add-card"><details class="add"><summary>${icon('plus')}Nyt forslag</summary>
          <form data-form="idea" class="card-form">${fields()}
            <div class="add-actions"><button class="btn">${icon('check')}Gem</button> <span class="status"></span></div></form></details></li>`)}
      </ul>
      ${data.ideas.length ? '' : `<p class="muted">Ingen forslag endnu.${token ? '' : ' Log ind for at tilføje et.'}</p>`}`;
  }

  const secret = (name, autocomplete) => `<span class="secret"><input name="${name}" type="password" required autocomplete="${autocomplete}">${iconButton('eye', 'Vis kodeord', 'data-action="reveal" aria-pressed="false"')}</span>`;

  function configPage() {
    return `
      <h1>Indstillinger</h1>
      <p>Gælder kun i denne browser.</p>
      <label class="check big-check"><input type="checkbox" data-action="toggle-mine" ${personal() ? 'checked' : ''}> Vis mine egne besøg</label>
      <p class="muted small">Tilføjer et filter i toppen (Alle, Madklubben, Ida, Andre) og et Hvem-felt, når du opretter en middag. Madkontoen tæller altid kun Madklubben.</p>`;
  }

  function renderFilter() {
    const el = $('#filter');
    el.hidden = !personal();
    if (!personal()) return;
    el.classList.toggle('on', groupFilter() !== 'madklubben');
    el.innerHTML = [['alle', 'Alle'], ...Object.entries(GROUPS)].map(([k, n]) => `<option value="${k}" ${groupFilter() === k ? 'selected' : ''}>${n}</option>`).join('');
  }

  function loginPage() {
    return `
      <h1>Log ind</h1>
      <p>Alle kan se siden. For at redigere skal du bruge madklubbens kodeord.</p>
      <form data-form="login" class="inline">
        <label>Kodeord ${secret('password', 'current-password')}</label>
        <button class="btn">${icon('login')}Log ind</button> <span class="status"></span>
      </form>`;
  }

  function setupPage() {
    return `
      <h1>Ny nøgle</h1>
      <p>Kun hvis login holder op med at virke.</p>
      <p class="muted">Lav en ny GitHub-token med skriveadgang til madklubben og vælg kodeordet, den skal låses med. Kun den krypterede nøgle gemmes.</p>
      <form data-form="setup" class="inline">
        <label>GitHub-token ${secret('token', 'off')}</label>
        <label>Kodeord ${secret('password', 'new-password')}</label>
        <button class="btn">${icon('check')}Gem</button> <span class="status"></span>
      </form>`;
  }

  // ---------- the GitHub token, locked with the club password ----------

  const bytes64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unbytes64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  async function passwordKey(password, salt) {
    const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function lockToken(tok, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await passwordKey(password, salt), new TextEncoder().encode(tok));
    return { salt: bytes64(salt), iv: bytes64(iv), token: bytes64(ct) };
  }

  async function unlockToken(password) {
    const r = await fetch('key.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('Login er ikke sat op endnu.');
    const k = await r.json();
    try {
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbytes64(k.iv) }, await passwordKey(password, unbytes64(k.salt)), unbytes64(k.token));
      return new TextDecoder().decode(pt);
    } catch {
      throw new Error('Forkert kodeord.');
    }
  }

  // ---------- actions ----------

  const num = v => v === '' ? null : Number(v);
  const orNull = v => v.trim() || null;

  async function useToken(tok) {
    token = tok;
    try {
      const repo = await gh(base);
      if (!repo.permissions?.push) throw new Error('Nøglen må ikke skrive til madklubben.');
    } catch (e) {
      token = null;
      throw e;
    }
    store.set('gh-token', token);
  }

  const forms = {
    async login(fd, form, progress) {
      progress('Låser op…');
      await useToken(await unlockToken(fd.get('password')));
      await load();
      location.hash = '#/';
    },

    async setup(fd, form, progress) {
      await useToken(fd.get('token').trim());
      progress('Krypterer…');
      const locked = await lockToken(token, fd.get('password'));
      await save('Ny krypteret nøgle', () => {}, { 'key.json': new Blob([JSON.stringify(locked, null, 1) + '\n']) });
      await load();
      location.hash = '#/';
    },

    async dinner(fd, form, progress) {
      const oldId = form.dataset.id;
      const fields = {
        restaurant: fd.get('restaurant').trim(),
        date: fd.get('date'),
        price: num(fd.get('price')),
        priceEstimate: fd.get('priceEstimate') === 'on' || undefined,
        outOfPocket: fd.get('outOfPocket') === '' ? null : Math.round(Number(fd.get('outOfPocket')) * data.members),
        ...(fd.get('group') && fd.get('group') !== 'madklubben'
          ? { group: fd.get('group'), people: num(fd.get('people')), outOfPocket: null }
          : { group: undefined, people: undefined }),
        website: orNull(fd.get('website')),
        closed: fd.get('closed') === 'on',
        address: orNull(fd.get('address')),
        lat: num(fd.get('lat')),
        lon: num(fd.get('lon')),
        menu: fd.getAll('menu').map(c => c.trim()).filter(Boolean),
        note: orNull(fd.get('note')),
      };
      const keys = fd.getAll('menuKey').filter((_, i) => fd.getAll('menu')[i].trim());
      const linked = Object.fromEntries(fd.getAll('order')
        .map((p, i) => [p, fd.getAll('course')[i].split(' ').map(k => keys.indexOf(k)).filter(n => n >= 0).sort((a, b) => a - b)])
        .filter(([, ns]) => ns.length));
      const notes = Object.fromEntries(fd.getAll('order').map((p, i) => [p, fd.getAll('photoNote')[i].trim()]).filter(([, n]) => n));
      const credits = Object.fromEntries(fd.getAll('order').map((p, i) => [p, fd.getAll('photoCredit')[i].trim()]).filter(([, n]) => n));
      const id = oldId || `${fields.date.slice(0, 4)}-${slug(fields.restaurant)}-${Date.now().toString(36).slice(-3)}`;
      const del = fd.getAll('delete');
      const order = fd.getAll('order');
      const { files, names, failed } = await preparePhotos({ id }, fd.getAll('photos').filter(f => f.size), progress);
      for (const p of del) for (const thumb of [false, true]) files[photoPath({ id }, p, thumb)] = null;
      await save(`${oldId ? 'Ret' : 'Ny middag:'} ${fields.restaurant}`, fresh => {
        let d = fresh.dinners.find(x => x.id === id);
        if (!d) fresh.dinners.push(d = { id, photos: [] });
        Object.assign(d, fields);
        const kept = order.filter(p => d.photos.includes(p)).concat(d.photos.filter(p => !order.includes(p)));
        d.photos = kept.filter(p => !del.includes(p)).concat(names);
        const keep = (field, from, still) => {
          const kept = Object.fromEntries(Object.entries(from ?? {}).filter(([k]) => still.includes(k)));
          if (Object.keys(kept).length) d[field] = kept; else delete d[field];
        };
        keep('photoCourses', linked, d.photos);
        keep('photoNotes', notes, d.photos);
        keep('photoCredits', credits, d.photos);
        keep('photoTags', d.photoTags, d.photos);
        keep('dishTags', d.dishTags, d.menu);
      }, files, progress);
      if (failed.length) alert(`Kunne ikke læse: ${failed.join(', ')}. (HEIC-billeder virker kun i Safari - eksportér som JPEG.)`);
      location.replace(`#/d/${id}`);
    },

    async rate(fd) {
      await save('Ny indbetalingssats', fresh => {
        fresh.rates = fresh.rates.filter(r => r.from !== fd.get('from'));
        fresh.rates.push({ from: fd.get('from'), perPerson: Number(fd.get('perPerson')) });
      });
    },

    async checkpoint(fd) {
      await save('Ny saldo', fresh => {
        fresh.checkpoints = fresh.checkpoints.filter(c => c.date !== fd.get('date'));
        fresh.checkpoints.push({ date: fd.get('date'), balance: Number(fd.get('balance')), note: orNull(fd.get('note')) });
      });
    },

    async idea(fd) {
      await save(`Nyt forslag: ${fd.get('name')}`, fresh => {
        fresh.ideas.push({ name: fd.get('name').trim(), url: orNull(fd.get('url')), note: orNull(fd.get('note')) });
      });
    },

    async editIdea(fd, form) {
      const before = JSON.stringify(data.ideas[+form.dataset.i]);
      await save(`Ret forslag: ${fd.get('name')}`, fresh => {
        const i = fresh.ideas.findIndex(x => JSON.stringify(x) === before);
        if (i < 0) throw new Error('Forslaget er lige blevet ændret af en anden. Genindlæs siden.');
        fresh.ideas[i] = { name: fd.get('name').trim(), url: orNull(fd.get('url')), note: orNull(fd.get('note')) };
      });
      editingIdea = null;
    },
  };

  document.addEventListener('submit', e => {
    if (!e.target.matches('.dish-search-form')) return;
    e.preventDefault();
    const q = e.target.querySelector('input').value.trim();
    e.target.querySelector('input').blur();
    const target = q ? `#/retter/${encodeURIComponent(q)}` : '#/retter';
    if (location.hash === target) filterDishes(); else location.hash = target;
  });
  document.addEventListener('submit', async e => {
    const form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    const status = form.querySelector('.status');
    const progress = msg => { status.textContent = msg; };
    const buttons = form.querySelectorAll('button');
    buttons.forEach(b => b.disabled = true);
    try {
      progress('Arbejder…');
      await forms[form.dataset.form](new FormData(form), form, progress);
      render();
    } catch (err) {
      progress(/422|409/.test(err.message) ? 'En anden har lige gemt. Genindlæs siden og prøv igen.' : err.message);
      buttons.forEach(b => b.disabled = false);
    }
  });

  let stripDrag = null;
  document.addEventListener('pointerdown', e => {
    const strip = e.target.closest('.strip');
    if (!strip || e.pointerType !== 'mouse' || e.button !== 0) return;
    stripDrag = { strip, x: e.clientX, left: strip.scrollLeft, moved: false };
  });
  document.addEventListener('pointermove', e => {
    if (!stripDrag) return;
    const dx = e.clientX - stripDrag.x;
    if (!stripDrag.moved && Math.abs(dx) < 5) return;
    if (!stripDrag.moved) { stripDrag.moved = true; stripDrag.strip.classList.add('dragging'); }
    stripDrag.strip.scrollLeft = stripDrag.left - dx;
  });
  document.addEventListener('pointerup', () => {
    if (!stripDrag) return;
    const { strip, moved } = stripDrag;
    stripDrag = null;
    strip.classList.remove('dragging');
    if (moved) strip.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); }, { capture: true, once: true });
  });
  document.addEventListener('dragstart', e => { if (e.target.closest('.strip')) e.preventDefault(); });
  document.addEventListener('click', async e => {
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a')) location.hash = row.dataset.href;
    const photo = e.target.closest('[data-photo]');
    if (photo) return openViewer(data.dinners.find(x => x.id === (photo.dataset.dinner ?? decodeURIComponent(location.hash).split('/')[2])), +photo.dataset.photo);
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'toggle-mine') {
      store.set('mig', btn.checked ? '1' : null);
      if (!btn.checked) store.set('mig-filter', null);
      renderFilter();
      return;
    }
    if (btn.dataset.action === 'reveal') {
      const input = btn.previousElementSibling, show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = icon(show ? 'eyeOff' : 'eye');
      btn.setAttribute('aria-pressed', show);
      btn.setAttribute('aria-label', show ? 'Skjul kodeord' : 'Vis kodeord');
      btn.title = btn.getAttribute('aria-label');
      input.focus();
    }
    if (btn.dataset.action === 'open-search') {
      const form = $('.dish-search-form');
      form.classList.toggle('open');
      if (form.classList.contains('open')) { const input = form.querySelector('input'); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }
    if (btn.dataset.action === 'pick-courses') pickCourses(btn);
    if (btn.dataset.action === 'photo-note') editPhotoNote(btn);
    if (btn.dataset.action === 'add-course') {
      $('.menu-edit').insertAdjacentHTML('beforeend', courseRow());
      $('.menu-edit li:last-child [name=menu]').focus();
      refreshCourseSelects(btn.form);
    }
    if (btn.dataset.action === 'remove-course') {
      const li = btn.closest('li');
      const form = btn.form;
      if (li.parentElement.children.length > 1) li.remove(); else li.querySelector('[name=menu]').value = '';
      refreshCourseSelects(form);
    }
    if (btn.dataset.action === 'edit-idea' || btn.dataset.action === 'cancel-idea') {
      editingIdea = btn.dataset.action === 'edit-idea' ? +btn.dataset.i : null;
      render();
      document.querySelector('[data-form=editIdea] input')?.focus();
    }
    if (btn.dataset.action === 'delete-idea') {
      const idea = JSON.stringify(data.ideas[+btn.dataset.i]);
      btn.disabled = true;
      await save(`Fjern forslag: ${JSON.parse(idea).name}`, fresh => {
        const i = fresh.ideas.findIndex(x => JSON.stringify(x) === idea);
        if (i >= 0) fresh.ideas.splice(i, 1);
      }).catch(err => alert(err.message));
      render();
    }
    if (btn.dataset.action === 'delete-dinner') {
      const id = btn.closest('form').dataset.id;
      const d = data.dinners.find(x => x.id === id);
      if (!confirm(`Slet ${d.restaurant} og alle ${d.photos.length} billeder?`)) return;
      const files = {};
      for (const p of d.photos) for (const thumb of [false, true]) files[photoPath(d, p, thumb)] = null;
      if (d.image) files[d.image] = null;
      btn.disabled = true;
      await save(`Slet middag: ${d.restaurant}`, fresh => { fresh.dinners = fresh.dinners.filter(x => x.id !== id); }, files)
        .then(() => { location.hash = '#/'; }).catch(err => alert(err.message));
    }
  });

  // ---------- photo viewer ----------

  let photoswipe;
  const ratio = src => new Promise(ok => {
    const im = new Image();
    im.onload = () => ok(im.naturalWidth / im.naturalHeight || 4 / 3);
    im.onerror = () => ok(4 / 3);
    im.src = src;
  });
  async function openViewer(d, i) {
    photoswipe ??= import('https://cdn.jsdelivr.net/npm/photoswipe@5.4.4/dist/photoswipe.esm.min.js').then(m => {
      document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/photoswipe@5.4.4/dist/photoswipe.css">');
      return m.default;
    });
    const [PhotoSwipe, ratios] = await Promise.all([photoswipe, Promise.all(d.photos.map(p => ratio(photoUrl(d, p, true))))]);
    const long = 1600;
    const pswp = new PhotoSwipe({
      dataSource: d.photos.map((p, k) => isVideo(p)
        ? { html: `<div class="pswp-video"><video src="${esc(photoUrl(d, p, false))}" poster="${esc(photoUrl(d, p, true))}" controls playsinline preload="metadata"></video></div>` }
        : {
          src: photoUrl(d, p, false),
          msrc: photoUrl(d, p, true),
          width: ratios[k] >= 1 ? long : Math.round(long * ratios[k]),
          height: ratios[k] >= 1 ? Math.round(long / ratios[k]) : long,
        }),
      index: i,
      bgOpacity: 1,
      showHideAnimationType: 'fade',
      wheelToZoom: true,
      loop: false,
      closeTitle: 'Luk',
      zoomTitle: 'Zoom',
      arrowPrevTitle: 'Forrige',
      arrowNextTitle: 'Næste',
      errorMsg: 'Billedet kunne ikke hentes',
    });
    const videos = () => [...(pswp.element?.querySelectorAll('.pswp-video video') ?? [])];
    const syncVideos = () => videos().forEach(v => {
      const current = v.closest('.pswp__item')?.getAttribute('aria-hidden') === 'false';
      if (!current && !v.paused) { v.pause(); v.currentTime = 0; }
    });
    pswp.on('change', () => setTimeout(syncVideos));
    pswp.on('contentAppend', () => setTimeout(syncVideos));
    pswp.on('close', () => videos().forEach(v => v.pause()));
    pswp.on('pointerDown', e => {
      const v = e.originalEvent.target.closest?.('.pswp-video video');
      if (v && e.originalEvent.clientY > v.getBoundingClientRect().bottom - 56) e.preventDefault();
    });
    pswp.on('uiRegister', () => {
      pswp.ui.registerElement({
        name: 'title', order: 4, isButton: false, appendTo: 'bar',
        html: `<strong>${esc(d.restaurant)}</strong> <span>${esc(dato(d.date))}</span>`,
      });
      pswp.ui.registerElement({
        name: 'course', order: 9, isButton: false, appendTo: 'root',
        onInit: (el, p) => p.on('change', () => {
          el.classList.remove('open');
          el.onclick = e => { if (e.target.closest('small')) el.classList.toggle('open'); };
          const photo = d.photos[p.currIndex];
          const ns = coursesOf(d, photo);
          const note = d.photoNotes?.[photo];
          const credit = d.photoCredits?.[photo];
          el.hidden = !ns.length && !note && !credit;
          el.classList.toggle('many', ns.length > 2);
          el.innerHTML = ns.map(n => `<div><span class="n">${n + 1}</span>${esc(d.menu[n])}</div>`).join('')
            + (note ? `<small${ns.length ? '' : ' class="alone"'}>${esc(note)}</small>` : '')
            + (credit ? `<em class="credit"><span class="tag">${icon('external')}Lånt billede</span>Foto: ${esc(credit)}</em>` : '');
          p.element.style.setProperty('--cap', `${el.hidden ? 0 : el.offsetHeight}px`);
        }),
      });
    });
    history.pushState({ viewer: true }, '');
    let closedByBack = false;
    const onBack = () => { closedByBack = true; pswp.close(); };
    addEventListener('popstate', onBack, { once: true });
    pswp.on('destroy', () => {
      removeEventListener('popstate', onBack);
      if (!closedByBack && history.state?.viewer) history.back();
    });
    pswp.init();
  }
  function filterDishes() {
    const words = ($('.dish-search')?.value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const cats = words.map(w => CATEGORIES.find(c => c.toLowerCase() === w));
    const starts = words.map(w => new RegExp(`(?:^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
    let n = 0;
    document.querySelectorAll('.dishes figure').forEach(f => {
      const per = Object.fromEntries(f.dataset.cats.split('|').filter(Boolean).map(x => [x.slice(0, x.lastIndexOf(':')), +x.slice(x.lastIndexOf(':') + 1)]));
      const colours = f.dataset.colours.split(' ');
      f.hidden = !words.every((w, k) => cats[k] ? per[cats[k]] : COLOURS.includes(w) ? colours.includes(w) : starts[k].test(f.dataset.q));
      const cat = cats.find(Boolean);
      if (!f.hidden) n += cat ? per[cat] : +f.dataset.n;
    });
    $('main h1 .count').textContent = n;
    $('.dish-empty').hidden = n > 0;
  }
  const grow = el => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; };
  document.addEventListener('input', e => {
    if (e.target.matches('textarea.grow')) grow(e.target);
    if (e.target.name === 'menu') refreshCourseSelects(e.target.form);
    const form = e.target.closest('form[data-form=dinner]');
    if (form && ['price', 'outOfPocket'].includes(e.target.name)) billPreview(form);
  });
  document.addEventListener('change', e => {
    if (e.target.id === 'filter') { store.set('mig-filter', e.target.value); render(); }
    if (e.target.name === 'group') billPreview(e.target.form);
  });
  document.addEventListener('change', async e => {
    if (e.target.name !== 'bankcsv' || !e.target.files.length) return;
    const status = $('.bank-status');
    try {
      const { date, balance: amount } = latestBalance(await e.target.files[0].text());
      status.textContent = 'Gemmer…';
      await save(`Kontoudtog ${date}`, fresh => {
        const same = fresh.checkpoints.find(c => c.date === date);
        fresh.checkpoints = fresh.checkpoints.filter(c => c.date !== date);
        fresh.checkpoints.push({ date, balance: amount, note: same?.note ?? 'Kontoudtog' });
      });
      render();
    } catch (err) {
      status.textContent = err.message;
      e.target.value = '';
    }
  });
  document.addEventListener('change', e => {
    if (e.target.name !== 'photos') return;
    const n = e.target.files.length;
    e.target.closest('.upload').querySelector('span').textContent = n ? `${n} ${n === 1 ? 'billede' : 'billeder'} valgt` : 'Vælg billeder';
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.name === 'menu') {
      e.preventDefault();
      e.target.closest('li').insertAdjacentHTML('afterend', courseRow());
      e.target.closest('li').nextElementSibling.querySelector('[name=menu]').focus();
      refreshCourseSelects(e.target.form);
    }
  });
  document.addEventListener('paste', e => {
    if (e.target.name !== 'menu') return;
    const courses = e.clipboardData.getData('text').split(/\r?\n/).map(c => c.trim()).filter(Boolean);
    if (courses.length < 2) return;
    e.preventDefault();
    const li = e.target.closest('li');
    e.target.value = courses[0];
    li.insertAdjacentHTML('afterend', courses.slice(1).map(c => courseRow(c)).join(''));
    refreshCourseSelects(e.target.form);
  });
  document.addEventListener('dragover', e => {
    const drop = e.target.closest('.drop');
    if (drop && e.dataTransfer.types.includes('Files')) { e.preventDefault(); drop.classList.add('over'); }
  });
  document.addEventListener('dragleave', e => e.target.closest?.('.drop')?.classList.remove('over'));
  document.addEventListener('drop', e => {
    const drop = e.target.closest('.drop');
    if (!drop || !e.dataTransfer.files.length) return;
    e.preventDefault();
    drop.classList.remove('over');
    const input = drop.querySelector('input[type=file]');
    input.files = e.dataTransfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // ---------- map and address search (OpenStreetMap) ----------

  let leaflet;
  async function drawMap(el) {
    leaflet ??= import('https://cdn.jsdelivr.net/npm/leaflet@1.9.4/+esm').then(m => {
      document.head.insertAdjacentHTML('beforeend', '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css">');
      return m;
    });
    const L = await leaflet;
    if (!el.isConnected) return;
    const touch = matchMedia('(hover: none)').matches;
    const map = L.map(el, { wheelPxPerZoomLevel: 240, zoomSnap: .5, zoomDelta: .5, dragging: !touch });
    map.attributionControl.setPrefix(false);
    if (touch) {
      el.insertAdjacentHTML('beforeend', '<div class="map-hint">Tryk på kortet for at flytte det</div>');
      let hide;
      const activate = on => {
        el.classList.toggle('active', on);
        if (on) { clearTimeout(pending); clearTimeout(hide); el.classList.remove('hinting'); }
        on ? map.dragging.enable() : map.dragging.disable();
      };
      let startY, multi, pending;
      const show = () => {
        pending = null;
        if (multi) return;
        el.classList.add('hinting');
        clearTimeout(hide);
        hide = setTimeout(() => el.classList.remove('hinting'), 1200);
      };
      el.addEventListener('touchstart', e => {
        if (e.touches.length === 1) { startY = e.touches[0].clientY; multi = false; } else { multi = true; clearTimeout(pending); pending = null; }
      }, { passive: true });
      el.addEventListener('touchmove', e => {
        if (e.touches.length > 1) multi = true;
        if (el.classList.contains('active') || multi || pending || Math.abs(e.touches[0].clientY - startY) < 12) return;
        pending = setTimeout(show, 150);
      }, { passive: true });
      map.on('click', () => activate(true));
      document.addEventListener('touchstart', e => { if (!el.contains(e.target)) activate(false); }, { passive: true });
      new IntersectionObserver(([e]) => { if (!e.isIntersecting) activate(false); }).observe(el);
    }
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const placed = shown().filter(d => d.lat != null && d.lon != null);
    for (const d of placed) {
      const dot = L.circleMarker([d.lat, d.lon], { radius: touch ? 6 : 5.5, color: getComputedStyle(document.body).backgroundColor, weight: 1.5, fillColor: color, fillOpacity: 1 });
      if (touch) {
        const short = new Date(toMs(d.date)).toLocaleDateString('da-DK', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
        dot.bindPopup(`<strong>${esc(d.restaurant)}</strong><span class="muted">${short}</span><a href="#/d/${esc(d.id)}" aria-label="Se middag">${icon('next')}</a>`, { closeButton: false, offset: [0, -4], className: 'dot-popup' });
      } else {
        dot.bindTooltip(`${esc(d.restaurant)}<br><span class="muted">${esc(d.date.slice(0, 4))}</span>`, { direction: 'top', offset: [0, -6] })
          .on('click', () => { location.hash = `#/d/${d.id}`; });
      }
      dot.addTo(map);
    }
    const inCopenhagen = placed.filter(d => map.distance([d.lat, d.lon], [55.6761, 12.5683]) < 50000);
    const home = () => map.fitBounds((inCopenhagen.length ? inCopenhagen : placed).map(d => [d.lat, d.lon]), { padding: [28, 28], maxZoom: 15 });
    home();
    const reset = L.DomUtil.create('a', 'map-reset', map.zoomControl.getContainer());
    reset.href = '#';
    reset.title = 'Vis alle restauranter';
    reset.setAttribute('role', 'button');
    reset.setAttribute('aria-label', reset.title);
    reset.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="2.5"/></svg>';
    L.DomEvent.disableClickPropagation(reset);
    L.DomEvent.on(reset, 'click', e => { L.DomEvent.preventDefault(e); home(); });
  }

  const addressLabel = p => {
    const street = [p.street ?? p.name, p.housenumber].filter(Boolean).join(' ');
    return [street, [p.postcode, p.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  };
  let addressTimer, addressReq = 0;
  async function searchAddress(input) {
    const form = input.form, list = form.querySelector('.suggest'), q = input.value.trim();
    for (const n of ['address', 'lat', 'lon']) form[n].value = '';
    input.setCustomValidity(q ? 'Vælg en adresse fra listen.' : '');
    if (q.length < 3) { list.hidden = true; return; }
    const req = ++addressReq;
    try {
      const r = await fetch(`https://photon.komoot.io/api/?${new URLSearchParams({ q, limit: 6, lat: 55.68, lon: 12.57 })}`);
      const features = (await r.json()).features.filter(f => f.properties.street || f.properties.housenumber);
      if (req !== addressReq) return;
      list.innerHTML = features.map(f => {
        const [lon, lat] = f.geometry.coordinates, label = addressLabel(f.properties);
        const place = f.properties.name && f.properties.name !== f.properties.street ? `<span class="muted">${esc(f.properties.name)}</span>` : '';
        return `<li role="option" tabindex="-1" data-label="${esc(label)}" data-lat="${lat}" data-lon="${lon}">${esc(label)}${place}</li>`;
      }).join('') || '<li class="none">Ingen adresser fundet</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    } catch {
      list.innerHTML = '<li class="none">Adressesøgningen svarer ikke lige nu</li>';
      list.hidden = false;
    }
  }
  function pickAddress(li) {
    const field = li.closest('.address-field'), form = li.closest('form');
    form.addressQuery.value = form.address.value = li.dataset.label;
    form.lat.value = (+li.dataset.lat).toFixed(6);
    form.lon.value = (+li.dataset.lon).toFixed(6);
    form.addressQuery.setCustomValidity('');
    field.querySelector('.suggest').hidden = true;
    form.addressQuery.setAttribute('aria-expanded', 'false');
  }
  document.addEventListener('input', e => {
    if (e.target.name !== 'addressQuery') return;
    clearTimeout(addressTimer);
    addressTimer = setTimeout(() => searchAddress(e.target), 300);
  });
  document.addEventListener('click', e => {
    const li = e.target.closest('.suggest li[data-label]');
    if (li) return pickAddress(li);
    if (!e.target.closest('.address-field')) document.querySelectorAll('.suggest').forEach(l => { l.hidden = true; });
  });
  document.addEventListener('keydown', e => {
    if (e.target.name !== 'addressQuery' && !e.target.closest?.('.suggest')) return;
    const list = e.target.closest('.address-field')?.querySelector('.suggest');
    if (!list || list.hidden) return;
    const items = [...list.querySelectorAll('li[data-label]')], i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (e.key === 'Enter' && items.length) {
      e.preventDefault();
      pickAddress(i >= 0 ? items[i] : items[0]);
      e.target.closest('form').addressQuery.focus();
    } else if (e.key === 'Escape') {
      list.hidden = true;
    }
  });

  // ---------- new version check ----------

  const assets = ['app.js', 'style.css'];
  const fetchAssets = cache => Promise.all(assets.map(a => fetch(a, { cache }).then(r => r.text()))).then(t => t.join());
  const running = fetchAssets('default');
  async function checkVersion() {
    try {
      if (await fetchAssets('no-store') !== await running) $('#update').hidden = false;
    } catch {}
  }
  checkVersion();
  setInterval(checkVersion, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkVersion());
  $('#update button').addEventListener('click', async () => {
    await fetchAssets('reload').catch(() => {});
    location.reload();
  });

  // ---------- boot ----------

  const isFront = h => ['', '#', '#/'].includes(h);
  let frontScroll = 0, onFront = isFront(location.hash);
  window.addEventListener('scroll', () => { if (onFront) frontScroll = window.scrollY; }, { passive: true });
  window.addEventListener('hashchange', () => {
    if (location.hash === '#/logud') {
      token = null;
      store.set('gh-token', null);
      location.hash = '#/';
      return;
    }
    editingIdea = null;
    onFront = false;
    render();
    const front = isFront(location.hash);
    window.scrollTo(0, front ? frontScroll : 0);
    onFront = front;
  });

  load()
    .catch(async () => {
      token = null;
      store.set('gh-token', null);
      await load();
    })
    .then(render);
}
