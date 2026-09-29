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
  const dato = iso => new Date(toMs(iso)).toLocaleDateString('da-DK', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const today = () => new Date().toLocaleDateString('sv-SE');
  const slug = s => s.toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean);
  const byDate = (a, b) => b.date.localeCompare(a.date);

  const store = {
    get: k => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
  };
  let token = store.get('gh-token');
  let data;
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
    '': timeline,
    d: dinnerPage,
    ny: () => dinnerForm(null),
    ret: id => dinnerForm(data.dinners.find(d => d.id === id)),
    budget: budgetPage,
    menuer: menusPage,
    ideer: ideasPage,
    login: loginPage,
  };

  function render() {
    const [, view = '', arg] = decodeURIComponent(location.hash).split('/');
    const html = (views[view] ?? timeline)(arg);
    $('main').innerHTML = html ?? '<p>Ikke fundet.</p>';
    $('#auth').textContent = token ? 'Log ud' : 'Log ind';
    $('#auth').href = token ? '#/logud' : '#/login';
    document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', a.getAttribute('href') === `#/${view}`));
    window.scrollTo(0, 0);
  }

  const editOnly = html => token ? html : '';

  function cover(d) {
    const src = d.photos[0] ? photoUrl(d, d.photos[0], true) : d.image;
    return src
      ? `<img src="${esc(src)}" alt="" loading="lazy">`
      : `<span class="initial">${esc(d.restaurant[0])}</span>`;
  }

  function timeline() {
    const f = forecast(data, today());
    return `
      <section class="hero">
        <p class="kicker">${data.dinners.length} middage siden ${data.dinners.map(d => d.date).sort()[0].slice(0, 4)}</p>
        <h1>Madklubben</h1>
        <p>På madkontoen nu <strong>${kr(balance(data, today()))}</strong>${f ? ` · næste middag omkring ${dato(f.next)}` : ''}</p>
        ${editOnly('<a class="btn" href="#/ny">+ Ny middag</a>')}
      </section>
      <ol class="cards">
        ${[...data.dinners].sort(byDate).map(d => `
          <li><a href="#/d/${esc(d.id)}">
            <div class="cover">${cover(d)}</div>
            <div class="body">
              <h2>${esc(d.restaurant)}</h2>
              <p class="muted">${dato(d.date)}${d.price ? ` · ${kr(d.price / data.members)} pr. person` : ''}</p>
              ${chips(d.themes)}
            </div>
          </a></li>`).join('')}
      </ol>`;
  }

  const chips = themes => themes.length ? `<p class="chips">${themes.map(t => `<span>${esc(t)}</span>`).join('')}</p>` : '';

  function dinnerPage(id) {
    const d = data.dinners.find(x => x.id === id);
    if (!d) return null;
    const links = [
      safeUrl(d.website) && `<a href="${safeUrl(d.website)}" target="_blank" rel="noopener">Restaurantens side</a>`,
      d.closed && '<span class="muted">Eksisterer ikke mere</span>',
      safeUrl(d.album) && `<a href="${safeUrl(d.album)}" target="_blank" rel="noopener">Album i Google Photos</a>`,
    ].filter(Boolean).join(' · ');
    return `
      <article class="dinner">
        <p class="kicker">${dato(d.date)}</p>
        <h1>${esc(d.restaurant)}</h1>
        ${links ? `<p>${links}</p>` : ''}
        ${chips(d.themes)}
        ${d.note ? `<p class="note">${esc(d.note)}</p>` : ''}
        <dl class="facts">
          <div><dt>Regning</dt><dd>${kr(d.price)}</dd></div>
          <div><dt>Pr. person</dt><dd>${d.price ? kr(d.price / data.members) : '–'}</dd></div>
          <div><dt>Fra madkonto</dt><dd>${d.price ? kr(fromFund(d)) : '–'}</dd></div>
          <div><dt>Eget indskud</dt><dd>${kr(d.outOfPocket)}</dd></div>
        </dl>
        ${d.menu.length ? `<h2>Menu</h2><ol class="menu">${d.menu.map(c => `<li>${esc(c)}</li>`).join('')}</ol>` : ''}
        ${editOnly(`<p><a class="btn" href="#/ret/${esc(d.id)}">Redigér middag og billeder</a></p>`)}
        ${d.photos.length ? `<h2>Billeder</h2><div class="grid">${d.photos.map((p, i) => `
          <button data-photo="${i}"><img src="${esc(photoUrl(d, p, true))}" alt="" loading="lazy"></button>`).join('')}</div>` : ''}
      </article>`;
  }

  function dinnerForm(d) {
    if (!token) return loginPage();
    const v = d ?? { date: today(), restaurant: '', website: '', album: '', price: '', outOfPocket: 0, note: '', themes: [], menu: [], photos: [], closed: false };
    return `
      <h1>${d ? `Redigér ${esc(d.restaurant)}` : 'Ny middag'}</h1>
      <form data-form="dinner" data-id="${esc(d?.id ?? '')}" class="stack">
        <label>Restaurant <input name="restaurant" required value="${esc(v.restaurant)}"></label>
        <label>Dato <input name="date" type="date" required value="${esc(v.date)}"></label>
        <label>Regning i alt (kr.) <input name="price" type="number" min="0" value="${esc(v.price)}"></label>
        <label>Eget indskud (kr., betalt ud over madkontoen) <input name="outOfPocket" type="number" min="0" value="${esc(v.outOfPocket)}"></label>
        <label>Restaurantens hjemmeside <input name="website" type="url" value="${esc(v.website)}"></label>
        <label><input name="closed" type="checkbox" ${v.closed ? 'checked' : ''}> Restauranten eksisterer ikke mere</label>
        <label>Link til album i Google Photos <input name="album" type="url" value="${esc(v.album)}"></label>
        <label>Temaer (adskilt af komma) <input name="themes" value="${esc(v.themes.join(', '))}" placeholder="nordisk, vin-parring, tasting menu"></label>
        <label>Menu (én ret pr. linje) <textarea name="menu" rows="8">${esc(v.menu.join('\n'))}</textarea></label>
        <label>Note <textarea name="note" rows="3">${esc(v.note)}</textarea></label>
        <label>Tilføj billeder <input name="photos" type="file" accept="image/*" multiple></label>
        <p class="muted small">Tip: I Google Photos-albummet vælg "Download alle", pak zip-filen ud, og vælg billederne her. De formindskes før upload.</p>
        ${v.photos.length ? `<fieldset><legend>Billeder (markér for at slette, første er forsidebillede)</legend><div class="grid pick">${v.photos.map(p => `
          <label><input type="checkbox" name="delete" value="${esc(p)}"><img src="${esc(photoUrl(d, p, true))}" alt="" loading="lazy"></label>`).join('')}</div></fieldset>` : ''}
        <p class="row"><button class="btn">Gem</button> <span class="status"></span>
          ${d ? '<button type="button" class="btn danger" data-action="delete-dinner">Slet middag</button>' : ''}</p>
      </form>`;
  }

  function budgetPage() {
    const now = today();
    const f = forecast(data, now);
    const cp = [...data.checkpoints].sort(byDate)[0];
    const monthly = rateFor(data.rates, now.slice(0, 7)) * data.members;
    const priced = data.dinners.filter(d => d.price);
    const total = (list, fn) => list.reduce((s, d) => s + fn(d), 0);
    return `
      <section class="hero">
        <p class="kicker">Madkontoen</p>
        <h1>${kr(balance(data, now))}</h1>
        <p class="muted">Beregnet ud fra bankens saldo ${kr(cp.balance)} d. ${dato(cp.date)} + indbetalinger ${kr(monthly)}/md. − middage siden.</p>
      </section>
      ${f ? `<dl class="facts">
        <div><dt>Gns. tid mellem middage</dt><dd>${f.avgDays} dage</dd></div>
        <div><dt>Forventet næste middag</dt><dd>${dato(f.next)}</dd></div>
        <div><dt>På madkontoen til den tid</dt><dd>${kr(f.savings)}</dd></div>
        <div><dt>Budget pr. person til den tid</dt><dd>${kr(f.savings / data.members)}</dd></div>
      </dl>` : ''}
      <h2>Middage</h2>
      <div class="scroll"><table>
        <thead><tr><th>Dato</th><th>Sted</th><th class="num">Regning</th><th class="num">Fra madkonto</th><th class="num">Eget indskud</th><th class="num">Pr. person</th></tr></thead>
        <tbody>${[...data.dinners].sort(byDate).map(d => `<tr>
          <td>${esc(d.date)}</td><td><a href="#/d/${esc(d.id)}">${esc(d.restaurant)}</a></td>
          <td class="num">${kr(d.price)}</td><td class="num">${d.price ? kr(fromFund(d)) : '–'}</td>
          <td class="num">${kr(d.outOfPocket)}</td><td class="num">${d.price ? kr(d.price / data.members) : '–'}</td></tr>`).join('')}</tbody>
        <tfoot><tr><th colspan="2">I alt</th><th class="num">${kr(total(priced, d => d.price))}</th>
          <th class="num">${kr(total(priced, fromFund))}</th><th class="num">${kr(total(priced, d => d.outOfPocket ?? 0))}</th><th></th></tr></tfoot>
      </table></div>
      <h2>Indbetaling pr. person</h2>
      <ul>${[...data.rates].sort((a, b) => a.from.localeCompare(b.from)).map(r => `<li>Fra ${esc(r.from)}: ${kr(r.perPerson)}/md.</li>`).join('')}</ul>
      ${editOnly(`<form data-form="rate" class="row">
        <label>Ny sats fra måned <input name="from" type="month" required value="${now.slice(0, 7)}"></label>
        <label>Kr. pr. person <input name="perPerson" type="number" min="0" required></label>
        <button class="btn">Tilføj</button> <span class="status"></span></form>`)}
      <h2>Saldo ifølge banken</h2>
      <ul>${[...data.checkpoints].sort(byDate).map(c => `<li>${esc(c.date)}: ${kr(c.balance)}${c.note ? ` · <span class="muted">${esc(c.note)}</span>` : ''}</li>`).join('')}</ul>
      ${editOnly(`<form data-form="checkpoint" class="row">
        <label>Dato <input name="date" type="date" required value="${now}"></label>
        <label>Saldo (kr.) <input name="balance" type="number" required></label>
        <label>Note <input name="note"></label>
        <button class="btn">Tilføj</button> <span class="status"></span></form>`)}`;
  }

  function menusPage(theme) {
    const all = [...new Set(data.dinners.flatMap(d => d.themes))].sort();
    const list = [...data.dinners].sort(byDate).filter(d => !theme || d.themes.includes(theme));
    return `
      <h1>Menuer og temaer</h1>
      ${all.length ? `<p class="chips filter"><a href="#/menuer" class="${theme ? '' : 'on'}">Alle</a>${all.map(t => `<a href="#/menuer/${encodeURIComponent(t)}" class="${t === theme ? 'on' : ''}">${esc(t)}</a>`).join('')}</p>` : ''}
      <div class="compare">${list.map(d => `
        <section>
          <h2><a href="#/d/${esc(d.id)}">${esc(d.restaurant)}</a></h2>
          <p class="muted">${esc(d.date.slice(0, 4))}${d.menu.length ? ` · ${d.menu.length} retter` : ''}${d.price ? ` · ${kr(d.price / data.members)} pr. person` : ''}</p>
          ${chips(d.themes)}
          ${d.menu.length ? `<ol class="menu">${d.menu.map(c => `<li>${esc(c)}</li>`).join('')}</ol>` : `<p class="muted small">Ingen menu endnu.${token ? ` <a href="#/ret/${esc(d.id)}">Tilføj</a>` : ''}</p>`}
        </section>`).join('')}</div>`;
  }

  function ideasPage() {
    return `
      <h1>Idéer til næste gang</h1>
      <ul class="ideas">${data.ideas.map((x, i) => `<li>
        ${safeUrl(x.url) ? `<a href="${safeUrl(x.url)}" target="_blank" rel="noopener">${esc(x.name)}</a>` : esc(x.name)}
        ${x.note ? `<span class="muted"> · ${esc(x.note)}</span>` : ''}
        ${editOnly(`<button class="link" data-action="delete-idea" data-i="${i}">Fjern</button>`)}</li>`).join('')}</ul>
      ${editOnly(`<form data-form="idea" class="row">
        <label>Restaurant <input name="name" required></label>
        <label>Link <input name="url" type="url"></label>
        <label>Note <input name="note"></label>
        <button class="btn">Tilføj</button> <span class="status"></span></form>`)}`;
  }

  function loginPage() {
    return `
      <h1>Log ind</h1>
      <p>Alle kan se siden. For at redigere skal du bruge madklubbens kodeord.</p>
      <form data-form="login" class="row">
        <label>Kodeord <input name="password" type="password" required autocomplete="current-password"></label>
        <button class="btn">Log ind</button> <span class="status"></span>
      </form>
      <details>
        <summary class="muted">Opsætning: ny GitHub-nøgle eller nyt kodeord</summary>
        <p class="muted small">Indsæt en GitHub-token med skriveadgang til madklubben og vælg kodeordet, den skal låses med. Kun den krypterede nøgle gemmes i repoet.</p>
        <form data-form="setup" class="row">
          <label>GitHub-token <input name="token" type="password" required autocomplete="off"></label>
          <label>Kodeord <input name="password" type="password" required autocomplete="new-password"></label>
          <button class="btn">Gem</button> <span class="status"></span>
        </form>
      </details>`;
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
    if (!r.ok) throw new Error('Login er ikke sat op endnu - se Opsætning nedenfor.');
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
        outOfPocket: num(fd.get('outOfPocket')),
        website: orNull(fd.get('website')),
        closed: fd.get('closed') === 'on',
        album: orNull(fd.get('album')),
        themes: fd.get('themes').split(',').map(t => t.trim().toLowerCase()).filter(Boolean),
        menu: lines(fd.get('menu')),
        note: orNull(fd.get('note')),
      };
      const id = oldId || `${fields.date.slice(0, 4)}-${slug(fields.restaurant)}-${Date.now().toString(36).slice(-3)}`;
      const del = fd.getAll('delete');
      const { files, names, failed } = await preparePhotos({ id }, fd.getAll('photos').filter(f => f.size), progress);
      for (const p of del) for (const thumb of [false, true]) files[photoPath({ id }, p, thumb)] = null;
      await save(`${oldId ? 'Ret' : 'Ny middag:'} ${fields.restaurant}`, fresh => {
        let d = fresh.dinners.find(x => x.id === id);
        if (!d) fresh.dinners.push(d = { id, photos: [] });
        Object.assign(d, fields);
        d.photos = d.photos.filter(p => !del.includes(p)).concat(names);
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
      await save('Ny saldo fra banken', fresh => {
        fresh.checkpoints = fresh.checkpoints.filter(c => c.date !== fd.get('date'));
        fresh.checkpoints.push({ date: fd.get('date'), balance: Number(fd.get('balance')), note: orNull(fd.get('note')) });
      });
    },

    async idea(fd) {
      await save(`Ny idé: ${fd.get('name')}`, fresh => {
        fresh.ideas.push({ name: fd.get('name').trim(), url: orNull(fd.get('url')), note: orNull(fd.get('note')) });
      });
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
    const photo = e.target.closest('[data-photo]');
    if (photo) return openViewer(+photo.dataset.photo);
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'delete-idea') {
      const idea = JSON.stringify(data.ideas[+btn.dataset.i]);
      btn.disabled = true;
      await save(`Fjern idé: ${JSON.parse(idea).name}`, fresh => {
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
    const s = e.target.dataset.step;
    if (s) showPhoto(+s);
    else if (e.target.matches('dialog, [data-close]')) $('#viewer').close();
  });
  document.addEventListener('keydown', e => {
    if (!$('#viewer').open) return;
    if (e.key === 'ArrowRight') showPhoto(1);
    if (e.key === 'ArrowLeft') showPhoto(-1);
  });

  // ---------- boot ----------

  window.addEventListener('hashchange', () => {
    if (location.hash === '#/logud') {
      token = null;
      store.set('gh-token', null);
      location.hash = '#/';
      return;
    }
    render();
  });

  load()
    .catch(async () => {
      token = null;
      store.set('gh-token', null);
      await load();
    })
    .then(render);
}
