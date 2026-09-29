import assert from 'node:assert/strict';
import { balance, depositsBetween, forecast, rateFor } from './app.js';

const data = {
  members: 3,
  rates: [{ from: '2024-01', perPerson: 100 }, { from: '2024-03', perPerson: 300 }],
  checkpoints: [{ date: '2023-12-31', balance: 0 }],
  dinners: [
    { date: '2024-02-15', price: 1000, outOfPocket: 500 },
    { date: '2024-04-10', price: 2000, outOfPocket: 0 },
  ],
};

assert.equal(rateFor(data.rates, '2023-12'), 0);
assert.equal(rateFor(data.rates, '2024-02'), 100);
assert.equal(rateFor(data.rates, '2024-05'), 300);
assert.equal(depositsBetween(data, '2023-12-31', '2024-01-01'), 300);
assert.equal(depositsBetween(data, '2024-01-01', '2024-01-31'), 0);
assert.equal(depositsBetween(data, '2023-12-31', '2024-04-30'), 300 + 300 + 900 + 900);
assert.equal(balance(data, '2024-02-15'), 600 - 500);
assert.equal(balance(data, '2024-04-30'), 2400 - 500 - 2000);

data.checkpoints.push({ date: '2024-04-10', balance: 50 });
assert.equal(balance(data, '2024-04-10'), 50, 'dinner on checkpoint day is already in the bank balance');
assert.equal(balance(data, '2024-05-01'), 950);

const f = forecast(data, '2024-05-01');
assert.equal(f.avgDays, 55);
assert.equal(f.next, '2024-06-04');
assert.equal(f.savings, 50 + 900 + 900);

console.log('ok');
