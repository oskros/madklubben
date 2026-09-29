const REPO = { owner: 'oskros', name: 'madklubben', branch: 'main' };

// ---------- budget math ----------

const DAY = 86400000;
const toMs = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const toIso = ms => new Date(ms).toISOString().slice(0, 10);
export const daysBetween = (a, b) => Math.round((toMs(b) - toMs(a)) / DAY);

export function rateFor(rates, month) {
  let rate = 0;
  for (const r of [...rates].sort((a, b) => a.from.localeCompare(b.from))) if (r.from <= month) rate = r.perPerson;
  return rate;
}

// Each member pays into the account on the 1st of every month.
export function depositsBetween(data, after, until) {
  let sum = 0;
  let y = +after.slice(0, 4), m = +after.slice(5, 7);
  for (;;) {
    if (++m > 12) { m = 1; y++; }
    const month = `${y}-${String(m).padStart(2, '0')}`;
    if (`${month}-01` > until) return sum;
    sum += rateFor(data.rates, month) * data.members;
  }
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

export const fromFund = d => (d.price ?? 0) - (d.outOfPocket ?? 0);

// A checkpoint is the bank balance at the end of its date, so dinners that day are already paid.
export function balance(data, date) {
  const cp = data.checkpoints.filter(c => c.date <= date).sort((a, b) => a.date.localeCompare(b.date)).at(-1)
    ?? { date: '0000-00-00', balance: 0 };
  const spent = data.dinners.filter(d => d.date > cp.date && d.date <= date).reduce((s, d) => s + fromFund(d), 0);
  return cp.balance + depositsBetween(data, cp.date, date) - spent;
}

export function forecast(data, today) {
  const dates = data.dinners.map(d => d.date).sort();
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
  let visited = 0;
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
      const ref = await gh(`${base}/git/ref/heads/${REPO.branch}`);
      const head = await gh(`${base}/git/commits/${ref.object.sha}`);
      const fresh = JSON.parse(await gh(`${base}/contents/data.json?ref=${ref.object.sha}`, { accept: 'application/vnd.github.raw+json' }));
      mutate(fresh);
      const tree = [{ path: 'data.json', mode: '100644', type: 'blob', content: JSON.stringify(fresh, null, 1) + '\n' }, ...blobs];
      const t = await post(`${base}/git/trees`, { base_tree: head.tree.sha, tree });
      const c = await post(`${base}/git/commits`, { message, tree: t.sha, parents: [ref.object.sha] });
      try {
        await post(`${base}/git/refs/heads/${REPO.branch}`, { sha: c.sha }, 'PATCH');
        data = fresh;
        return;
      } catch (e) {
        if (!e.message.includes('422') || attempt === 3) throw e;
      }
    }
  }

  async function load() {
    data = token
      ? JSON.parse(await gh(`${base}/contents/data.json?ref=${REPO.branch}`, { accept: 'application/vnd.github.raw+json' }))
      : await (await fetch('data.json', { cache: 'no-cache' })).json();
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

  const photoPath = (d, name, thumb) => `photos/${d.id}/${thumb ? 't/' : ''}${name}`;
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
    budget: dinnersPage,
    saldo: balancePage,
    menuer: menusPage,
    forslag: ideasPage,
    ideer: ideasPage,
    login: loginPage,
    opsaetning: setupPage,
  };

  function render() {
    const [, view = '', arg] = decodeURIComponent(location.hash).split('/');
    const html = (views[view] ?? dinnersPage)(arg);
    $('main').innerHTML = html ?? '<p>Ikke fundet.</p>';
    $('#auth').innerHTML = `${icon(token ? 'logout' : 'login')}<span>${token ? 'Log ud' : 'Log ind'}</span>`;
    $('#auth').href = token ? '#/logud' : '#/login';
    const section = ['d', 'ny', 'ret', 'budget'].includes(view) ? '' : view === 'ideer' ? 'forslag' : view;
    document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === `#/${section}`));
    const dinner = $('form[data-form=dinner]');
    if (dinner) billPreview(dinner);
    const pick = $('.pick'), courses = $('.menu-edit');
    if (pick || courses) import('https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/+esm').then(({ default: Sortable }) => {
      if (pick) Sortable.create(pick, { animation: 150, forceFallback: true, delay: 150, delayOnTouchOnly: true, filter: '.del', preventOnFilter: false });
      if (courses) Sortable.create(courses, { animation: 150, forceFallback: true, handle: '.grip' });
    });
  }

  const editOnly = html => token ? html : '';

  const ICONS = {
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
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
    prev: '<path d="m15 18-6-6 6-6"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  };
  const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  const iconLink = (href, name, label, extra = '') => `<a class="icon-btn" href="${href}" aria-label="${label}" title="${label}" ${extra}>${icon(name)}</a>`;
  const iconButton = (name, label, attrs = '') => `<button type="button" class="icon-btn" aria-label="${label}" title="${label}" ${attrs}>${icon(name)}</button>`;
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const perPerson = d => d.price ? kr(d.price / data.members) : '–';

  function cover(d) {
    const src = d.image ?? (d.photos[0] && photoUrl(d, d.photos[0], true));
    return src
      ? `<img src="${esc(src)}" alt="" loading="lazy">`
      : `<span class="initial">${esc(d.restaurant[0])}</span>`;
  }

  const chips = themes => themes.length ? `<p class="chips">${themes.map(t => `<span>${esc(t)}</span>`).join('')}</p>` : '';
  const menuList = d => `<ol class="menu">${d.menu.map(c => `<li>${esc(c)}</li>`).join('')}</ol>`;

  function dinnerPage(id) {
    const d = data.dinners.find(x => x.id === id);
    if (!d) return null;
    const hero = d.image ?? (d.photos[0] && photoUrl(d, d.photos[0], false));
    return `
      <div class="toolbar">
        ${iconLink('#/', 'back', 'Tilbage', 'data-action="back"')}
        ${editOnly(iconLink(`#/ret/${esc(d.id)}`, 'edit', 'Redigér middag og billeder'))}
      </div>
      <header class="dinner-head">
        ${hero ? `<img class="dinner-img" src="${esc(hero)}" alt="">` : ''}
        <div>
          <p class="date">${dato(d.date)}</p>
          <h1>${esc(d.restaurant)}</h1>
          <p class="links">
            ${safeUrl(d.website) ? `<a href="${safeUrl(d.website)}" target="_blank" rel="noopener">${icon('external')}${esc(host(d.website))}</a>` : ''}
            ${safeUrl(d.album) ? `<a href="${safeUrl(d.album)}" target="_blank" rel="noopener">${icon('album')}Google Photos</a>` : ''}
            ${d.closed ? '<span class="muted">Lukket</span>' : ''}
          </p>
          ${chips(d.themes)}
          ${d.note ? `<p class="note">${esc(d.note)}</p>` : ''}
          <dl class="figures">
            <div><dt>Regning</dt><dd>${kr(d.price)}</dd></div>
            <div><dt>Pr. person</dt><dd>${perPerson(d)}</dd></div>
            <div><dt>Fra madkonto</dt><dd>${d.price ? kr(fromFund(d)) : '–'}</dd></div>
            <div><dt>Eget indskud pr. person</dt><dd>${d.outOfPocket == null ? '–' : kr(d.outOfPocket / data.members)}</dd></div>
          </dl>
        </div>
      </header>
      <div class="dinner-body${d.menu.length ? '' : ' no-menu'}">
        ${d.menu.length ? `<section><h2>Menu</h2>${menuList(d)}</section>` : ''}
        <section>
          <h2>Billeder <span class="count">${d.photos.length || ''}</span></h2>
          ${d.photos.length ? `<div class="grid">${d.photos.map((p, i) => `
            <button data-photo="${i}" aria-label="Billede ${i + 1}"><img src="${esc(photoUrl(d, p, true))}" alt="" loading="lazy"></button>`).join('')}</div>`
            : `<p class="muted">Ingen billeder endnu.${token ? ` <a href="#/ret/${esc(d.id)}">Tilføj billeder</a>` : ''}</p>`}
        </section>
      </div>`;
  }

  const courseRow = (c = '') => `<li><span class="grip" title="Træk for at flytte">${icon('grip')}</span><input name="menu" value="${esc(c)}" aria-label="Ret" autocomplete="off">${iconButton('x', 'Fjern ret', 'data-action="remove-course" tabindex="-1"')}</li>`;

  function billPreview(form) {
    const price = +form.price.value || 0, own = (+form.outOfPocket.value || 0) * data.members;
    form.querySelector('.bill').textContent = price
      ? `${kr(price - own)} fra madkontoen, ${kr(price / data.members)} pr. person`
      : '';
  }

  function dinnerForm(d) {
    if (!token) return loginPage();
    const v = d ?? { date: today(), restaurant: '', website: '', price: '', outOfPocket: 0, note: '', themes: [], menu: [], photos: [], closed: false };
    return `
      <div class="toolbar">${iconLink(d ? `#/d/${esc(d.id)}` : '#/', 'back', 'Tilbage', 'data-action="back"')}</div>
      <h1>${d ? esc(d.restaurant) : 'Ny middag'}</h1>
      <form data-form="dinner" data-id="${esc(d?.id ?? '')}" class="dinner-form">
        <section>
          <label>Restaurant <input name="restaurant" required value="${esc(v.restaurant)}" autocomplete="off"></label>
          <div class="pair">
            <label>Dato <input name="date" type="date" required value="${esc(v.date)}"></label>
            <label>Hjemmeside <input name="website" type="url" value="${esc(v.website)}" placeholder="https://"></label>
          </div>
          <label>Temaer <input name="themes" value="${esc(v.themes.join(', '))}" placeholder="fx nordisk, vinmenu"></label>
          <label>Note <input name="note" value="${esc(v.note)}"></label>
          ${d ? `<label class="check"><input name="closed" type="checkbox" ${v.closed ? 'checked' : ''}> Restauranten er lukket</label>` : ''}
        </section>
        <section>
          <h2>Regning</h2>
          <div class="pair">
            <label>I alt, kr. <input name="price" type="number" min="0" inputmode="numeric" value="${esc(v.price)}"></label>
            <label>Eget indskud pr. person, kr. <input name="outOfPocket" type="number" min="0" step="any" inputmode="decimal" value="${v.outOfPocket == null ? '' : Math.round(v.outOfPocket / data.members * 100) / 100}"></label>
          </div>
          <p class="bill muted"></p>
        </section>
        <section>
          <h2>Menu</h2>
          <ol class="menu-edit">${(v.menu.length ? v.menu : ['']).map(courseRow).join('')}</ol>
          <button type="button" class="add-row" data-action="add-course">${icon('plus')}Tilføj ret</button>
        </section>
        <section class="drop">
          <h2>Billeder <span class="count">${v.photos.length || ''}</span></h2>
          <label class="upload">${icon('plus')}<span>Vælg billeder</span><input name="photos" type="file" accept="image/*" multiple></label>
          <p class="muted small">Eller træk dem herind. De formindskes før upload.${v.photos.length ? ' Træk billederne nedenfor for at ændre rækkefølgen.' : ''}</p>
          ${v.photos.length ? `<div class="grid pick">${v.photos.map(p => `
            <div class="tile"><input type="hidden" name="order" value="${esc(p)}"><img src="${esc(photoUrl(d, p, true))}" alt="" loading="lazy" draggable="false">
              <label class="del" title="Slet billede"><input type="checkbox" name="delete" value="${esc(p)}" aria-label="Slet billede">${icon('trash')}</label></div>`).join('')}</div>` : ''}
        </section>
        <div class="actions">
          <button class="btn">${icon('check')}Gem</button> <span class="status"></span>
          ${d ? `<button type="button" class="btn danger" data-action="delete-dinner">${icon('trash')}Slet middag</button>` : ''}
        </div>
      </form>`;
  }

  // ponytail: menu cards are the first photos of dinners with a menu; skip up to 3 of them. A "not a dish" flag per photo if this guesses wrong.
  function dishPhoto(d) {
    const skip = d.menu.length ? Math.min(3, d.photos.length - 1) : 0;
    const pool = d.photos.slice(skip);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function photoStrip() {
    const withPhotos = [...data.dinners].sort(byDate).filter(d => d.photos.length);
    if (!withPhotos.length) return '';
    return `<div class="strip">${withPhotos.map(d => `
      <a href="#/d/${esc(d.id)}" title="${esc(d.restaurant)}">
        <img src="${esc(photoUrl(d, dishPhoto(d), true))}" alt="${esc(d.restaurant)}" loading="lazy">
        <span>${esc(d.restaurant)}</span>
      </a>`).join('')}</div>`;
  }

  function timeline() {
    const dates = data.dinners.map(d => d.date).sort();
    if (!dates.length) return '';
    const first = +dates[0].slice(0, 4), last = +today().slice(0, 4) + 1;
    const start = toMs(`${first}-01-01`), span = toMs(`${last}-01-01`) - start;
    const pos = iso => ((toMs(iso) - start) / span * 100).toFixed(2);
    const years = Array.from({ length: last - first + 1 }, (_, i) => first + i);
    return `
      <section class="timeline">
        <div class="track">
          ${years.map(y => `<span class="year" style="left:${pos(`${y}-01-01`)}%">${y < last ? y : ''}</span>`).join('')}
          ${[...data.dinners].sort((a, b) => a.date.localeCompare(b.date)).map(d => `<a class="dot" href="#/d/${esc(d.id)}" style="left:${pos(d.date)}%" title="${esc(d.restaurant)}, ${dato(d.date)}" aria-label="${esc(d.restaurant)}"></a>`).join('')}
          <span class="now" style="left:${pos(today())}%" title="I dag"></span>
        </div>
      </section>`;
  }

  function dinnersPage() {
    const priced = data.dinners.filter(d => d.price);
    const total = (list, fn) => list.reduce((s, d) => s + fn(d), 0);
    const f = forecast(data, today());
    return `
      ${photoStrip()}
      <a class="account" href="#/saldo">
        <span><span class="amount">${kr(balance(data, today()))}</span> på madkontoen</span>
        ${f ? `<span class="muted">Næste middag omkring ${dato(f.next)}</span>` : ''}
        ${icon('next')}
      </a>
      ${timeline()}
      <div class="section-head">
        <h1>Middage <span class="count">${data.dinners.length}</span></h1>
        ${editOnly(`<a class="btn" href="#/ny">${icon('plus')}Ny middag</a>`)}
      </div>
      <div class="scroll"><table class="dinners">
        <thead><tr><th></th><th>Dato</th><th>Restaurant</th><th class="num wide">Regning</th><th class="num wide">Fra madkonto</th><th class="num wide">Eget indskud</th><th class="num">Pr. person</th></tr></thead>
        <tbody>${[...data.dinners].sort(byDate).map(d => `<tr data-href="#/d/${esc(d.id)}">
          <td class="thumb-cell"><span class="thumb">${cover(d)}</span></td>
          <td><span class="wide">${dato(d.date)}</span><span class="narrow">${+d.date.slice(8)}.${+d.date.slice(5, 7)}.${d.date.slice(2, 4)}</span></td>
          <td class="place"><a href="#/d/${esc(d.id)}">${esc(d.restaurant)}</a>
            <span class="photos${d.photos.length ? '' : ' none'}" title="${d.photos.length} billeder">${icon('camera')}${d.photos.length}</span></td>
          <td class="num wide">${kr(d.price)}</td><td class="num wide">${d.price ? kr(fromFund(d)) : '–'}</td>
          <td class="num wide">${kr(d.outOfPocket)}</td><td class="num">${perPerson(d)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th colspan="3">I alt</th><th class="num wide">${kr(total(priced, d => d.price))}</th>
          <th class="num wide">${kr(total(priced, fromFund))}</th><th class="num wide">${kr(total(priced, d => d.outOfPocket ?? 0))}</th><th></th></tr></tfoot>
      </table></div>`;
  }

  function balancePage() {
    const now = today();
    const f = forecast(data, now);
    return `
      <h1 class="big">${kr(balance(data, now))}</h1>
      <p class="lead">på madkontoen i dag</p>
      ${f ? `<section class="forecast"><h2>Forventet ved næste middag</h2><dl class="figures">
        <div><dt>Dato</dt><dd>${dato(f.next)}</dd></div>
        <div><dt>Gns. interval</dt><dd>${f.avgDays} dage</dd></div>
        <div><dt>Beløb</dt><dd>${kr(f.savings)}</dd></div>
        <div><dt>Pr. person</dt><dd>${kr(f.savings / data.members)}</dd></div>
      </dl></section>` : ''}
      <div class="columns">
        <section>
          <h2>Indbetaling pr. person</h2>
          <table class="plain">${[...data.rates].sort((a, b) => b.from.localeCompare(a.from)).map(r => `<tr><td>Fra ${maaned(r.from)}</td><td class="num">${kr(r.perPerson)} / md.</td></tr>`).join('')}</table>
          ${editOnly(`<details class="add"><summary>${icon('plus')}Ny sats</summary><form data-form="rate" class="add-form">
            <label>Fra måned <input name="from" type="month" required value="${now.slice(0, 7)}"></label>
            <label>Kr. pr. person <input name="perPerson" type="number" min="0" inputmode="numeric" required></label>
            <div class="add-actions"><button class="btn">${icon('check')}Gem</button> <span class="status"></span></div></form></details>`)}
        </section>
        <section>
          <h2>Bankudtog</h2>
          <table class="plain">${[...data.checkpoints].sort(byDate).map(c => `<tr><td>${dato(c.date)}${c.note ? `<br><span class="muted small">${esc(c.note)}</span>` : ''}</td><td class="num">${kr(c.balance)}</td></tr>`).join('')}</table>
          ${editOnly(`<div class="bank-add"><details class="add"><summary>${icon('plus')}Ny saldo</summary><form data-form="checkpoint" class="add-form">
            <label>Dato <input name="date" type="date" required value="${now}"></label>
            <label>Saldo, kr. <input name="balance" type="number" step="any" inputmode="decimal" required></label>
            <label class="span2">Note <input name="note"></label>
            <div class="add-actions"><button class="btn">${icon('check')}Gem</button> <span class="status"></span></div></form></details>
          <label class="csv-link">eller upload CSV fra banken<input name="bankcsv" type="file" accept=".csv,text/csv"></label></div>
          <p class="muted small bank-status"></p>`)}
        </section>
      </div>`;
  }

  function menusPage(theme) {
    const all = [...new Set(data.dinners.flatMap(d => d.themes))].sort();
    const list = [...data.dinners].sort(byDate).filter(d => !theme || d.themes.includes(theme));
    const withMenu = list.filter(d => d.menu.length), without = list.filter(d => !d.menu.length);
    return `
      <h1>Menuer</h1>
      ${all.length ? `<p class="chips filter"><a href="#/menuer" class="${theme ? '' : 'on'}">Alle</a>${all.map(t => `<a href="#/menuer/${encodeURIComponent(t)}" class="${t === theme ? 'on' : ''}">${esc(t)}</a>`).join('')}</p>` : ''}
      <div class="compare">${withMenu.map(d => `
        <section>
          <h2><a href="#/d/${esc(d.id)}">${esc(d.restaurant)}</a></h2>
          <p class="muted small">${esc(d.date.slice(0, 4))}, ${d.menu.length} retter${d.price ? `, ${perPerson(d)} pr. person` : ''}</p>
          ${chips(d.themes)}
          ${menuList(d)}
        </section>`).join('')}</div>
      ${without.length ? `<p class="muted without">Uden menu: ${without.map(d => `<a href="#/${token ? 'ret' : 'd'}/${esc(d.id)}">${esc(d.restaurant)}</a>`).join(', ')}</p>` : ''}`;
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

  function loginPage() {
    return `
      <h1>Log ind</h1>
      <p class="lead">Alle kan se siden. For at redigere skal du bruge madklubbens kodeord.</p>
      <form data-form="login" class="inline">
        <label>Kodeord ${secret('password', 'current-password')}</label>
        <button class="btn">${icon('login')}Log ind</button> <span class="status"></span>
      </form>`;
  }

  function setupPage() {
    return `
      <h1>Ny nøgle</h1>
      <p class="lead">Kun hvis login holder op med at virke.</p>
      <p class="muted explain">Lav en ny GitHub-token med skriveadgang til madklubben og vælg kodeordet, den skal låses med. Kun den krypterede nøgle gemmes.</p>
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
        outOfPocket: fd.get('outOfPocket') === '' ? null : Math.round(Number(fd.get('outOfPocket')) * data.members),
        website: orNull(fd.get('website')),
        closed: fd.get('closed') === 'on',
        themes: fd.get('themes').split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
        menu: fd.getAll('menu').map(c => c.trim()).filter(Boolean),
        note: orNull(fd.get('note')),
      };
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
      }, files, progress);
      if (failed.length) alert(`Kunne ikke læse: ${failed.join(', ')}. (HEIC-billeder virker kun i Safari - eksportér som JPEG.)`);
      location.hash = `#/d/${id}`;
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

  document.addEventListener('click', async e => {
    const row = e.target.closest('tr[data-href]');
    if (row && !e.target.closest('a')) location.hash = row.dataset.href;
    const photo = e.target.closest('[data-photo]');
    if (photo) return openViewer(+photo.dataset.photo);
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'back' && visited > 0) {
      e.preventDefault();
      history.back();
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
    if (btn.dataset.action === 'add-course') {
      $('.menu-edit').insertAdjacentHTML('beforeend', courseRow());
      $('.menu-edit li:last-child input').focus();
    }
    if (btn.dataset.action === 'remove-course') {
      const li = btn.closest('li');
      if (li.parentElement.children.length > 1) li.remove(); else li.querySelector('input').value = '';
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

  let viewing = null;
  function openViewer(i) {
    const id = decodeURIComponent(location.hash).split('/')[2];
    viewing = { d: data.dinners.find(x => x.id === id), i };
    showPhoto(0);
    $('#viewer').showModal();
  }
  function showPhoto(step) {
    const { d } = viewing;
    viewing.i = (viewing.i + step + d.photos.length) % d.photos.length;
    $('#viewer img').src = photoUrl(d, d.photos[viewing.i], false);
    $('#viewer .count').textContent = `${viewing.i + 1} / ${d.photos.length}`;
  }
  $('#viewer').addEventListener('click', e => {
    const s = e.target.closest('[data-step]')?.dataset.step;
    if (s) showPhoto(+s);
    else if (e.target.matches('dialog') || e.target.closest('[data-close]')) $('#viewer').close();
  });
  document.addEventListener('input', e => {
    const form = e.target.closest('form[data-form=dinner]');
    if (form && ['price', 'outOfPocket'].includes(e.target.name)) billPreview(form);
  });
  document.addEventListener('change', async e => {
    if (e.target.name !== 'bankcsv' || !e.target.files.length) return;
    const status = $('.bank-status');
    try {
      const { date, balance: amount } = latestBalance(await e.target.files[0].text());
      status.textContent = 'Gemmer…';
      await save(`Bankudtog ${date}`, fresh => {
        const same = fresh.checkpoints.find(c => c.date === date);
        fresh.checkpoints = fresh.checkpoints.filter(c => c.date !== date);
        fresh.checkpoints.push({ date, balance: amount, note: same?.note ?? 'Bankudtog' });
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
      e.target.closest('li').nextElementSibling.querySelector('input').focus();
    }
  });
  document.addEventListener('paste', e => {
    if (e.target.name !== 'menu') return;
    const courses = e.clipboardData.getData('text').split(/\r?\n/).map(c => c.trim()).filter(Boolean);
    if (courses.length < 2) return;
    e.preventDefault();
    const li = e.target.closest('li');
    e.target.value = courses[0];
    li.insertAdjacentHTML('afterend', courses.slice(1).map(courseRow).join(''));
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
  document.addEventListener('keydown', e => {
    if (!$('#viewer').open) return;
    if (e.key === 'ArrowRight') showPhoto(1);
    if (e.key === 'ArrowLeft') showPhoto(-1);
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

  window.addEventListener('hashchange', () => {
    if (location.hash === '#/logud') {
      token = null;
      store.set('gh-token', null);
      location.hash = '#/';
      return;
    }
    editingIdea = null;
    visited++;
    render();
    window.scrollTo(0, 0);
  });

  load()
    .catch(async () => {
      token = null;
      store.set('gh-token', null);
      await load();
    })
    .then(render);
}
