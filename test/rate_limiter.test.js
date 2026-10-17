import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuotaLimiter, QuotaExhaustedError, pacificDay } from '../rate_limiter.js';

// A fake clock: sleep() just advances time, so minutes of waiting run instantly.
function fakeClock(start = Date.UTC(2026, 9, 17, 12, 0, 0)) {
  const clock = { t: start, now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  return clock;
}
const tmpState = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'saab-quota-')), 'q.json');

test('never exceeds the requests-per-minute budget in ANY rolling 60s window', async () => {
  const c = fakeClock();
  const limiter = new QuotaLimiter({ name: 't', rpm: 3, now: c.now, sleep: c.sleep });
  const grants = [];
  for (let i = 0; i < 12; i++) { await limiter.acquire(); grants.push(c.t); }

  for (let i = 3; i < grants.length; i++) {
    assert.ok(grants[i] - grants[i - 3] >= 60000, `request ${i} came ${grants[i] - grants[i - 3]}ms after request ${i - 3}: more than 3 in a minute`);
  }
});

test('concurrent callers are served in order and still respect the budget', async () => {
  const c = fakeClock();
  const limiter = new QuotaLimiter({ name: 't', rpm: 4, now: c.now, sleep: c.sleep });
  const grants = [];
  await Promise.all(Array.from({ length: 12 }, async () => { await limiter.acquire(); grants.push(c.t); }));

  assert.equal(grants.length, 12);
  for (let i = 4; i < grants.length; i++) assert.ok(grants[i] - grants[i - 4] >= 60000);
  assert.equal(limiter.pending, 0);
});

test('minimum gap between requests is enforced', async () => {
  const c = fakeClock();
  const limiter = new QuotaLimiter({ name: 't', minGapMs: 2500, now: c.now, sleep: c.sleep });
  await limiter.acquire();
  const first = c.t;
  await limiter.acquire();
  assert.ok(c.t - first >= 2500);
});

test('penalize pauses the lane for the retry delay and halves the allowed rate; it recovers slowly', async () => {
  const c = fakeClock();
  const limiter = new QuotaLimiter({ name: 't', rpm: 10, now: c.now, sleep: c.sleep });
  await limiter.acquire();
  const before = c.t;

  limiter.penalize(7);
  assert.equal(limiter.effectiveRpm, 5);
  assert.ok(limiter.cooldownMs() > 6500 && limiter.cooldownMs() <= 7000);

  await limiter.acquire();
  assert.ok(c.t - before >= 7000, 'next request waits out the provider retry delay');

  c.t += 130000; // two quiet minutes
  await limiter.acquire();
  assert.equal(limiter.effectiveRpm, 6, 'creeps back up by one per quiet 2 minutes');

  for (let i = 0; i < 12; i++) limiter.penalize(1);
  assert.equal(limiter.effectiveRpm, 1, 'never drops below 1 request per minute');
});

test('an unconfigured lane still adapts after a 429', async () => {
  const c = fakeClock();
  const limiter = new QuotaLimiter({ name: 't', now: c.now, sleep: c.sleep });
  for (let i = 0; i < 6; i++) await limiter.acquire();
  limiter.penalize(1);
  assert.ok(Number.isFinite(limiter.effectiveRpm) && limiter.effectiveRpm <= 3);
});

test('daily budget: once spent, acquire() rejects with a 429-shaped error and sends nothing', async () => {
  const c = fakeClock();
  const limiter = new QuotaLimiter({ name: 'gemini:0', rpd: 2, now: c.now, sleep: c.sleep });
  await limiter.acquire();
  await limiter.acquire();
  await assert.rejects(() => limiter.acquire(), (err) => {
    assert.ok(err instanceof QuotaExhaustedError);
    assert.equal(err.status, 429);
    assert.match(err.message, /per day/i, 'matches the solver daily-quota detection');
    return true;
  });
  assert.equal(limiter.usage().used, 2);
});

test('daily usage and exhaustion persist across runs and reset at the next Pacific day', async () => {
  const file = tmpState();
  const c = fakeClock();
  let day = '2026-10-17';
  const make = () => new QuotaLimiter({ name: 'k', rpd: 5, statePath: file, now: c.now, sleep: c.sleep, day: () => day });

  const run1 = make();
  await run1.acquire();
  await run1.acquire();
  assert.equal(make().usage().used, 2, 'a new process sees what the last one used today');

  run1.markExhausted();
  assert.equal(make().isExhausted(), true, 'daily exhaustion is remembered, so no request is wasted discovering it again');

  day = '2026-10-18';
  const tomorrow = make();
  assert.equal(tomorrow.usage().used, 0);
  assert.equal(tomorrow.isExhausted(), false);
  await tomorrow.acquire();
  assert.equal(tomorrow.usage().used, 1);
});

test('a corrupt state file is ignored rather than crashing', () => {
  const file = tmpState();
  fs.writeFileSync(file, '{ nope');
  const limiter = new QuotaLimiter({ name: 'k', rpd: 5, statePath: file });
  assert.equal(limiter.usage().used, 0);
});

test('loadMs reflects queued callers so keys can be balanced', async () => {
  const c = fakeClock();
  const a = new QuotaLimiter({ name: 'a', rpm: 6, minGapMs: 1000, now: c.now, sleep: c.sleep });
  const b = new QuotaLimiter({ name: 'b', rpm: 6, minGapMs: 1000, now: c.now, sleep: c.sleep });
  const queued = [a.acquire(), a.acquire(), a.acquire()];
  assert.ok(a.loadMs() > b.loadMs(), 'the busier lane reports a higher load');
  await Promise.all(queued);
});

test('pacificDay uses Pacific time (Google resets daily quotas at midnight Pacific)', () => {
  assert.equal(pacificDay(new Date('2026-10-17T06:59:00Z')), '2026-10-16');
  assert.equal(pacificDay(new Date('2026-10-17T07:01:00Z')), '2026-10-17');
});
