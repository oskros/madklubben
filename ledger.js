const DAY = 86400000;
export const toMs = iso => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
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
