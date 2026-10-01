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

// Dinners outside the club (Oskar's own visits) never touch the madkonto.
export const isClub = d => (d.group ?? 'madklubben') === 'madklubben';
export const fromFund = d => (d.price ?? 0) - (d.outOfPocket ?? 0);

// A checkpoint is the bank balance at the end of its date, so dinners that day are already paid.
export function balance(data, date) {
  const cp = data.checkpoints.filter(c => c.date <= date).sort((a, b) => a.date.localeCompare(b.date)).at(-1)
    ?? { date: '0000-00-00', balance: 0 };
  const spent = data.dinners.filter(d => isClub(d) && d.date > cp.date && d.date <= date).reduce((s, d) => s + fromFund(d), 0);
  return cp.balance + depositsBetween(data, cp.date, date) - spent;
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
    if (!token) {
      data = await (await fetch('data.json', { cache: 'no-cache' })).json();
      return;
    }
    const ref = await gh(`${base}/git/ref/heads/${REPO.branch}`);
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
    retter: dishesPage,
    menuer: dishesPage,
    forslag: ideasPage,
    ideer: ideasPage,
    login: loginPage,
    opsaetning: setupPage,
    config: configPage,
  };

  function render() {
    const [, view = '', arg] = decodeURIComponent(location.hash).split('/');
    const html = (views[view] ?? dinnersPage)(arg);
    $('main').innerHTML = html ?? '<p>Ikke fundet.</p>';
    $('#auth').innerHTML = `${icon(token ? 'logout' : 'login')}<span>${token ? 'Log ud' : 'Log ind'}</span>`;
    $('#auth').href = token ? '#/logud' : '#/login';
    renderFilter();
    const section = ['d', 'ny', 'ret', 'budget'].includes(view) ? '' : view === 'ideer' ? 'forslag' : view;
    document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === `#/${section}`));
    const dinner = $('form[data-form=dinner]');
    if (dinner) { billPreview(dinner); refreshCourseSelects(dinner); }
    document.querySelectorAll('textarea.grow').forEach(grow);
    if ($('#map')) drawMap($('#map'));
    const pick = $('.pick'), courses = $('.menu-edit');
    if (pick || courses) import('https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/+esm').then(({ default: Sortable }) => {
      if (pick) Sortable.create(pick, { animation: 150, forceFallback: true, delay: 150, delayOnTouchOnly: true, filter: '.del, .course-btn, .note-btn', preventOnFilter: false });
      if (courses) Sortable.create(courses, { animation: 150, forceFallback: true, handle: '.grip', onEnd: () => refreshCourseSelects(dinner) });
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
    prev: '<path d="m15 18-6-6 6-6"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  };
  const icon = name => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  const iconLink = (href, name, label, extra = '') => `<a class="icon-btn" href="${href}" aria-label="${label}" title="${label}" ${extra}>${icon(name)}</a>`;
  const iconButton = (name, label, attrs = '') => `<button type="button" class="icon-btn" aria-label="${label}" title="${label}" ${attrs}>${icon(name)}</button>`;
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const heads = d => isClub(d) ? data.members : d.people || 2;
  const estKr = (d, v) => (v && d.priceEstimate ? '~' : '') + kr(v);
  const perPerson = d => d.price ? estKr(d, d.price / heads(d)) : '–';

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
    const hero = d.image ?? (d.photos[0] && photoUrl(d, d.photos[0], false));
    return `
      <div class="toolbar">
        ${iconLink('#/', 'back', 'Til forsiden')}
        ${editOnly(iconLink(`#/ret/${esc(d.id)}`, 'edit', 'Redigér middag og billeder'))}
      </div>
      <header class="dinner-head">
        ${hero ? `<img class="dinner-img" src="${esc(hero)}" alt="">` : ''}
        <div>
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
        </div>
      </header>
      <div class="dinner-body${d.menu.length ? '' : ' no-menu'}">
        ${d.menu.length ? `<section><h2>Menu</h2>${menuList(d)}</section>` : ''}
        <section>
          <h2>Billeder <span class="count">${d.photos.length || ''}</span></h2>
          ${d.photos.length ? `<div class="grid">${d.photos.map((p, i) => `
            <button data-photo="${i}" aria-label="Billede ${i + 1}"${d.photoCredits?.[p] ? ` title="Foto: ${esc(d.photoCredits[p])}"` : ''}><img src="${esc(photoUrl(d, p, true))}" alt="" loading="lazy">${d.photoCredits?.[p] ? `<span class="credit-badge" aria-label="Lånt billede">${icon('external')}</span>` : ''}</button>`).join('')}</div>`
            : `<p class="muted">Ingen billeder endnu.${token ? ` <a href="#/ret/${esc(d.id)}">Tilføj billeder</a>` : ''}</p>`}
        </section>
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

  // ponytail: without course links, menu cards are guessed to be the first photos of dinners with a menu; skip up to 3 of them.
  function dishPhoto(d) {
    const linked = d.photos.filter(p => coursesOf(d, p).length);
    const skip = d.menu.length ? Math.min(3, d.photos.length - 1) : 0;
    const pool = linked.length ? linked : d.photos.slice(skip);
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
    const list = shown(), priced = list.filter(d => d.price), clubPriced = priced.filter(isClub);
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
      ${list.some(d => d.lat) ? '<section class="map-section"><h2>Kort</h2><div id="map" role="region" aria-label="Kort over restauranterne"></div></section>' : ''}
      <div class="section-head">
        <h1>${groupFilter() === 'madklubben' || groupFilter() === 'alle' ? 'Middage' : GROUPS[groupFilter()]} <span class="count">${list.length}</span></h1>
        ${editOnly(`<a class="btn" href="#/ny">${icon('plus')}Ny middag</a>`)}
      </div>
      <div class="scroll"><table class="dinners">
        <thead><tr><th></th><th>Dato</th><th>Restaurant</th><th class="num">Regning</th><th class="num wide">Fra madkonto</th><th class="num wide">Eget indskud</th><th class="num wide">Pr. person</th></tr></thead>
        <tbody>${[...list].sort(byDate).map(d => `<tr data-href="#/d/${esc(d.id)}"${isClub(d) ? '' : ' class="own"'}>
          <td class="thumb-cell"><span class="thumb">${cover(d)}</span></td>
          <td><span class="wide">${dato(d.date)}</span><span class="narrow">${+d.date.slice(8)}.${+d.date.slice(5, 7)}.${d.date.slice(2, 4)}</span></td>
          <td class="place"><a href="#/d/${esc(d.id)}">${esc(d.restaurant)}</a>
            <span class="photos${d.photos.length ? '' : ' none'}" title="${d.photos.length} billeder">${icon('camera')}${d.photos.length}</span>${isClub(d) || groupFilter() !== 'alle' ? '' : `<span class="tag">${GROUPS[d.group] ?? 'Andre'}</span>`}</td>
          <td class="num"${d.priceEstimate ? ' title="Anslået"' : ''}>${estKr(d, d.price)}</td><td class="num wide">${isClub(d) && d.price ? estKr(d, fromFund(d)) : '–'}</td>
          <td class="num wide">${isClub(d) ? estKr(d, d.outOfPocket) : '–'}</td><td class="num wide">${perPerson(d)}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th colspan="3">I alt</th><th class="num">${kr(total(priced, d => d.price))}</th>
          <th class="num wide">${clubPriced.length ? kr(total(clubPriced, fromFund)) : '–'}</th><th class="num wide">${clubPriced.length ? kr(total(clubPriced, d => d.outOfPocket ?? 0)) : '–'}</th><th class="num wide">${kr(total(priced, d => d.price / heads(d)))}</th></tr></tfoot>
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

  function dishesPage() {
    const tiles = [...shown()].sort(byDate).flatMap(d => {
      const list = [], byPhoto = {};
      d.menu.forEach((c, n) => {
        const i = d.photos.findIndex(p => coursesOf(d, p).includes(n));
        if (i >= 0 && byPhoto[i]) return byPhoto[i].names.push(c);
        list.push(byPhoto[i] = { d, i, names: [c] });
      });
      return list;
    });
    return `
      <div class="section-head"><h1>Retter <span class="count">${tiles.reduce((n, t) => n + t.names.length, 0)}</span></h1></div>
      <input type="search" class="dish-search" placeholder="Søg efter ret, råvare eller restaurant" aria-label="Søg i retter" autocomplete="off">
      <div class="dishes">${tiles.map(({ d, i, names }) => `
        <figure data-n="${names.length}" data-q="${esc(`${names.join(' ')} ${d.restaurant}`.toLowerCase())}">
          ${i >= 0
            ? `<button data-photo="${i}" data-dinner="${esc(d.id)}" aria-label="Se billedet af ${esc(names.join(', '))}"><img src="${esc(photoUrl(d, d.photos[i], true))}" alt="" loading="lazy"></button>`
            : `<a class="no-photo" href="#/d/${esc(d.id)}" aria-label="${esc(d.restaurant)}">${icon('camera')}<span>Intet billede</span></a>`}
          <figcaption><span>${names.map(esc).join('<br>')}</span>${names.length > 1 ? `<small>${names.length} retter på billedet</small>` : ''}<a href="#/d/${esc(d.id)}">${esc(d.restaurant)}, ${esc(d.date.slice(0, 4))}</a></figcaption>
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
      <p class="lead">Gælder kun i denne browser.</p>
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
        const pc = Object.fromEntries(Object.entries(linked).filter(([p]) => d.photos.includes(p)));
        if (Object.keys(pc).length) d.photoCourses = pc; else delete d.photoCourses;
        const pn = Object.fromEntries(Object.entries(notes).filter(([p]) => d.photos.includes(p)));
        if (Object.keys(pn).length) d.photoNotes = pn; else delete d.photoNotes;
        const cr = Object.fromEntries(Object.entries(credits).filter(([p]) => d.photos.includes(p)));
        if (Object.keys(cr).length) d.photoCredits = cr; else delete d.photoCredits;
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
      dataSource: d.photos.map((p, k) => ({
        src: photoUrl(d, p, false),
        msrc: photoUrl(d, p, true),
        width: ratios[k] >= 1 ? long : Math.round(long * ratios[k]),
        height: ratios[k] >= 1 ? Math.round(long / ratios[k]) : long,
      })),
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
    pswp.on('uiRegister', () => {
      pswp.ui.registerElement({
        name: 'title', order: 4, isButton: false, appendTo: 'bar',
        html: `<strong>${esc(d.restaurant)}</strong> <span>${esc(dato(d.date))}</span>`,
      });
      pswp.ui.registerElement({
        name: 'course', order: 9, isButton: false, appendTo: 'root',
        onInit: (el, p) => p.on('change', () => {
          const photo = d.photos[p.currIndex];
          const ns = coursesOf(d, photo);
          const note = d.photoNotes?.[photo];
          const credit = d.photoCredits?.[photo];
          el.hidden = !ns.length && !note && !credit;
          el.classList.toggle('many', ns.length > 2);
          el.innerHTML = ns.map(n => `<div><span class="n">${n + 1}</span>${esc(d.menu[n])}</div>`).join('')
            + (note ? `<small${ns.length ? '' : ' class="alone"'}>${esc(note)}</small>` : '')
            + (credit ? `<em class="credit"><span class="tag">${icon('external')}Lånt billede</span>Foto: ${esc(credit)}</em>` : '');
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
  const grow = el => { el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; };
  document.addEventListener('input', e => {
    if (e.target.matches('textarea.grow')) grow(e.target);
    if (e.target.matches('.dish-search')) {
      const words = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
      let n = 0;
      document.querySelectorAll('.dishes figure').forEach(f => { f.hidden = !words.every(w => f.dataset.q.includes(w)); if (!f.hidden) n += +f.dataset.n; });
      $('main h1 .count').textContent = n;
      $('.dish-empty').hidden = n > 0;
    }
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
    const map = L.map(el, { wheelPxPerZoomLevel: 240, zoomSnap: .5, zoomDelta: .5 });
    map.attributionControl.setPrefix(false);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const placed = shown().filter(d => d.lat != null && d.lon != null);
    const touch = matchMedia('(hover: none)').matches;
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

  const isFront = h => ['', '#', '#/', '#/budget'].includes(h);
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
