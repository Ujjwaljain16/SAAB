// rate_limiter.js — proactive, adaptive, persistent request limiter for one API lane (one Gemini key+model, Groq, Grok).
//
// Why: free-tier AI quotas are small (per-minute AND per-day) and are enforced per PROJECT, not per API key.
// Waiting for a 429 and then retrying wastes requests and can look like abuse. Instead every request first passes through
// acquire(), which keeps us under a configured requests-per-minute and requests-per-day budget.
//
//   rpm        max requests in any rolling 60 s window (0 = unlimited / unknown)
//   rpd        max requests per Pacific-time day, persisted across runs (0 = unlimited / unknown)
//   minGapMs   minimum gap between two requests
//
// Adaptive: a 429 (penalize) pauses the lane for the provider's retry delay and halves the effective RPM; it creeps back
// up by one every 2 quiet minutes. A genuine DAILY exhaustion is persisted (markExhausted) so the next run today does not
// even try. Pacific time is used because Google resets daily quotas at midnight Pacific.
//
// Circuit breaker: non-429 failures (5xx, network errors) are tracked separately. After failureThreshold consecutive
// failures the circuit opens and the lane is skipped for cooldownMs (default 60 s), then transitions to HALF-OPEN: one
// probe is allowed; success → CLOSED, failure → OPEN again. 429s never count toward the circuit breaker because they are
// expected quota behaviour that the QuotaLimiter already handles.
import fs from 'fs';
import path from 'path';

const dayFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });

/** YYYY-MM-DD in Pacific time. */
export function pacificDay(date = new Date()) {
  return dayFormatter.format(date);
}

/** Thrown by acquire() when today's budget is gone. status 429 + "per day" so callers' existing daily-quota handling applies. */
export class QuotaExhaustedError extends Error {
  constructor(name, detail) {
    super(`Daily request budget reached for ${name} (${detail}); per day limit`);
    this.name = 'QuotaExhaustedError';
    this.status = 429;
    this.synthetic = true;
  }
}

/** Thrown by CircuitBreaker.acquire() when the circuit is OPEN and we are not in HALF-OPEN probe mode. */
export class CircuitOpenError extends Error {
  constructor(name, remainingMs) {
    super(`Circuit OPEN for ${name}; remaining cooldown ${Math.ceil(remainingMs / 1000)}s`);
    this.name = 'CircuitOpenError';
    this.remainingMs = remainingMs;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Circuit Breaker -------------------------------------------------------------------------
// Tracks non-quota failures (5xx, network errors, model refusals) per lane independently of the
// per-minute rate limiter. The state machine is intentionally simple: each lane has exactly one
// CircuitBreaker, shared across all callers for that lane.
//
// CLOSED  — normal operation; failures are counted
// OPEN    — provider is considered down; acquire() throws immediately
// HALF-OPEN — cooldown expired; exactly one probe is in flight; on success → CLOSED, on failure → OPEN
//
// Design note: 429 quota responses should NOT be fed to markFailure(); the QuotaLimiter already
// handles them. Only genuine errors (network, 5xx, timeout) should be counted.

const CB_STATES = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

export class CircuitBreaker {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {number} [o.failureThreshold]  consecutive failures before OPEN (default 3)
   * @param {number} [o.cooldownMs]        how long to stay OPEN before allowing a probe (default 60 000)
   * @param {() => number} [o.now]         injectable clock (tests)
   */
  constructor({ name, failureThreshold = 3, cooldownMs = 60_000, now = () => Date.now() }) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;

    this._state = CB_STATES.CLOSED;
    this._consecutiveFailures = 0;
    this._openedAt = 0;
    this._probeInFlight = false;
  }

  get state() {
    this._maybeTransitionFromOpen();
    return this._state;
  }

  _maybeTransitionFromOpen() {
    if (this._state === CB_STATES.OPEN && this.now() - this._openedAt >= this.cooldownMs) {
      this._state = CB_STATES.HALF_OPEN;
      this._probeInFlight = false;
    }
  }

  /**
   * Check whether a request is allowed right now.
   * Throws CircuitOpenError when the lane is OPEN.
   * Returns true when this call is the HALF-OPEN probe (caller should mark success/failure).
   * Returns false in CLOSED state (normal path).
   */
  checkAndAcquire() {
    this._maybeTransitionFromOpen();

    if (this._state === CB_STATES.OPEN) {
      const remaining = this.cooldownMs - (this.now() - this._openedAt);
      throw new CircuitOpenError(this.name, Math.max(0, remaining));
    }

    if (this._state === CB_STATES.HALF_OPEN) {
      if (this._probeInFlight) {
        // Another concurrent caller already grabbed the probe slot; block this one as if OPEN.
        throw new CircuitOpenError(this.name, 0);
      }
      this._probeInFlight = true;
      return true; // is probe
    }

    return false; // CLOSED — normal
  }

  /** Call after a successful API call. Resets consecutive-failure counter and closes the circuit. */
  markSuccess() {
    this._consecutiveFailures = 0;
    this._probeInFlight = false;
    if (this._state !== CB_STATES.CLOSED) {
      console.log(`  [Circuit] ${this.name}: CLOSED (probe succeeded).`);
    }
    this._state = CB_STATES.CLOSED;
  }

  /**
   * Call after a non-quota failure (5xx, network, timeout).
   * Do NOT call this for 429 rate-limit responses; the QuotaLimiter handles those.
   * @param {Error|unknown} [err]
   */
  markFailure(err) {
    this._consecutiveFailures += 1;
    this._probeInFlight = false;

    if (this._state === CB_STATES.HALF_OPEN || this._consecutiveFailures >= this.failureThreshold) {
      this._state = CB_STATES.OPEN;
      this._openedAt = this.now();
      const coolSec = Math.ceil(this.cooldownMs / 1000);
      const reason = err?.message ? err.message.slice(0, 80) : 'unknown error';
      console.warn(`  [Circuit] ${this.name}: OPEN for ${coolSec}s after ${this._consecutiveFailures} failure(s). Last: "${reason}"`);
    }
  }

  /** Remaining cooldown in ms (0 when CLOSED or HALF-OPEN). */
  remainingCooldownMs() {
    if (this._state !== CB_STATES.OPEN) return 0;
    return Math.max(0, this.cooldownMs - (this.now() - this._openedAt));
  }

  isOpen() {
    return this.state === CB_STATES.OPEN;
  }

  isClosed() {
    return this.state === CB_STATES.CLOSED;
  }

  stats() {
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this._consecutiveFailures,
      remainingCooldownMs: this.remainingCooldownMs()
    };
  }
}

export class QuotaLimiter {
  /**
   * @param {object} o
   * @param {string} o.name
   * @param {number} [o.rpm]
   * @param {number} [o.rpd]
   * @param {number} [o.minGapMs]
   * @param {string|null} [o.statePath] JSON file for the daily counter (never contains the API key)
   * @param {() => number} [o.now]      injectable clock (tests)
   * @param {(ms:number) => Promise<void>} [o.sleep] injectable sleep (tests)
   * @param {() => string} [o.day]      injectable day key (tests)
   */
  constructor({ name, rpm = 0, rpd = 0, minGapMs = 0, statePath = null, now = () => Date.now(), sleep = realSleep, day = null }) {
    this.name = name;
    this.maxRpm = rpm > 0 ? rpm : Infinity;
    this.effectiveRpm = this.maxRpm;
    this.rpd = rpd > 0 ? rpd : 0;
    this.minGapMs = Math.max(0, minGapMs);
    this.statePath = statePath;
    this.now = now;
    this.sleep = sleep;
    this.dayFn = day || (() => pacificDay(new Date(this.now())));

    this.window = [];
    this.blockedUntil = 0;
    this.lastPenaltyAt = 0;
    this.lastGrantAt = 0;
    this.pending = 0;
    this.chain = Promise.resolve();

    this.dayKey = this.dayFn();
    this.used = 0;
    this.exhausted = false;
    this._load();
  }

  _load() {
    if (!this.statePath) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      if (saved?.day === this.dayKey) {
        this.used = Number(saved.used) || 0;
        this.exhausted = Boolean(saved.exhausted);
      }
    } catch {
      // no state yet, or unreadable: start the day fresh
    }
  }

  _save() {
    if (!this.statePath) return;
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      const tmp = `${this.statePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ name: this.name, day: this.dayKey, used: this.used, exhausted: this.exhausted }));
      fs.renameSync(tmp, this.statePath);
    } catch {
      // best-effort: losing the counter only makes us less precise, never wrong in a dangerous direction
    }
  }

  _rollDay() {
    const today = this.dayFn();
    if (today !== this.dayKey) {
      this.dayKey = today;
      this.used = 0;
      this.exhausted = false;
      this._save();
    }
  }

  _relaxRpm(t) {
    if (this.lastPenaltyAt && t - this.lastPenaltyAt > 120000 && this.effectiveRpm < this.maxRpm) {
      this.effectiveRpm = Math.min(this.maxRpm, this.effectiveRpm + 1);
      this.lastPenaltyAt = t;
    }
  }

  isExhausted() {
    this._rollDay();
    return this.exhausted || (this.rpd > 0 && this.used >= this.rpd);
  }

  /** Persist "out of daily quota" so the next run today skips this lane without spending a request. */
  markExhausted() {
    this._rollDay();
    this.exhausted = true;
    this._save();
  }

  /** The provider said slow down: pause for its retry delay and halve the allowed rate. */
  penalize(retryAfterSeconds = 5) {
    const t = this.now();
    this.blockedUntil = Math.max(this.blockedUntil, t + Math.max(1, Number(retryAfterSeconds) || 5) * 1000);
    const base = Number.isFinite(this.effectiveRpm) ? this.effectiveRpm : Math.max(2, this.window.filter((ts) => t - ts < 60000).length);
    this.effectiveRpm = Math.max(1, Math.floor(base / 2));
    this.lastPenaltyAt = t;
  }

  cooldownMs() {
    return Math.max(0, this.blockedUntil - this.now());
  }

  /** Estimated ms until a request could go out, ignoring other queued callers. */
  readyInMs() {
    const t = this.now();
    const waits = [this.blockedUntil - t, this.lastGrantAt ? this.lastGrantAt + this.minGapMs - t : 0];
    const recent = this.window.filter((ts) => t - ts < 60000);
    if (recent.length >= Math.floor(this.effectiveRpm)) waits.push(recent[0] + 60000 - t);
    return Math.max(0, ...waits);
  }

  /** readyInMs plus the time the callers already queued on this lane will take: used to balance work across keys. */
  loadMs() {
    const perCall = Math.max(this.minGapMs, Number.isFinite(this.effectiveRpm) ? 60000 / this.effectiveRpm : 0);
    return this.readyInMs() + this.pending * perCall;
  }

  usage() {
    this._rollDay();
    return { name: this.name, used: this.used, rpd: this.rpd, exhausted: this.isExhausted(), effectiveRpm: this.effectiveRpm, maxRpm: this.maxRpm };
  }

  /** Resolve when a request may be sent. Callers are served one at a time, in order. Rejects with QuotaExhaustedError. */
  acquire() {
    this.pending += 1;
    const run = this.chain.then(() => this._acquire()).finally(() => { this.pending -= 1; });
    this.chain = run.catch(() => {});
    return run;
  }

  async _acquire() {
    for (;;) {
      this._rollDay();
      if (this.isExhausted()) {
        throw new QuotaExhaustedError(this.name, this.rpd > 0 ? `${this.used}/${this.rpd} used today` : 'marked exhausted today');
      }

      const t = this.now();
      this._relaxRpm(t);
      this.window = this.window.filter((ts) => t - ts < 60000);

      const waits = [];
      if (this.blockedUntil > t) waits.push(this.blockedUntil - t);
      if (this.minGapMs > 0 && this.lastGrantAt) waits.push(this.lastGrantAt + this.minGapMs - t);
      if (this.window.length >= Math.floor(this.effectiveRpm)) waits.push(this.window[0] + 60000 - t + 1);

      const wait = Math.max(0, ...waits);
      if (wait <= 0) break;
      await this.sleep(wait);
    }

    const t = this.now();
    this.window.push(t);
    this.lastGrantAt = t;
    this.used += 1;
    this._save();
  }
}
