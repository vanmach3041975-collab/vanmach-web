import crypto from 'node:crypto';
import {plans} from './plans.mjs';

const fail = (status, message) => { throw Object.assign(new Error(message), {status}); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

// Internal accounting only. A payment adapter must verify the provider receipt
// before calling applyVerifiedPeriod. No HTTP route accepts these claims.
// All amounts are integer millionths of USD; no floating point balances.
export class AiBudget {
  constructor(db, {now = Date.now} = {}) {
    this.db = db; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS ai_budget_periods (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT NOT NULL,
      starts INTEGER NOT NULL, ends INTEGER NOT NULL, allowance INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ai_budget_events (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_budget_requests (
        id TEXT PRIMARY KEY, period_id TEXT NOT NULL, model TEXT NOT NULL,
        reserved INTEGER NOT NULL, charged INTEGER, state TEXT NOT NULL);`);
  }
  transaction(action) {
    this.db.exec('SAVEPOINT ai_budget_operation');
    try { const value = action(); this.db.exec('RELEASE ai_budget_operation'); return value; }
    catch (error) { this.db.exec('ROLLBACK TO ai_budget_operation; RELEASE ai_budget_operation'); throw error; }
  }
  applyVerifiedPeriod({eventId, periodId, userId, planId, starts, ends, revoked = false}) {
    const plan = plans.find(item => item.id === planId && item.id !== 'free');
    if (![eventId, periodId, userId].every(identifier) || !plan ||
        !integer(starts) || !integer(ends) || ends <= starts || typeof revoked !== 'boolean') {
      fail(400, 'Giao dịch gói không hợp lệ.');
    }
    const payload = JSON.stringify({periodId, userId, planId, starts, ends, revoked});
    return this.transaction(() => {
      const event = this.db.prepare('SELECT payload FROM ai_budget_events WHERE id=?').get(eventId);
      if (event) {
        if (event.payload !== payload) fail(409, 'Mã giao dịch đã được sử dụng.');
        return false;
      }
      const existing = this.db.prepare('SELECT * FROM ai_budget_periods WHERE id=?').get(periodId);
      if (existing && (existing.user_id !== userId || existing.plan_id !== planId ||
          existing.starts !== starts || existing.ends !== ends)) fail(409, 'Kỳ gói không khớp.');
      if (!existing && !revoked && this.db.prepare(
        'SELECT id FROM ai_budget_periods WHERE user_id=? AND revoked=0 AND starts<? AND ends>?'
      ).get(userId, ends, starts)) fail(409, 'Kỳ gói bị trùng.');
      this.db.prepare('INSERT OR IGNORE INTO ai_budget_periods VALUES(?,?,?,?,?,?,?)')
        .run(periodId, userId, planId, starts, ends, Math.round(plan.aiBudgetUsd * 1000000), revoked ? 1 : 0);
      // Refunds are terminal for this provider period, even if older events arrive later.
      if (revoked) this.db.prepare('UPDATE ai_budget_periods SET revoked=1 WHERE id=?').run(periodId);
      this.db.prepare('INSERT INTO ai_budget_events VALUES(?,?)').run(eventId, payload);
      return true;
    });
  }
  current(userId) {
    return this.db.prepare('SELECT * FROM ai_budget_periods WHERE user_id=? AND revoked=0 AND starts<=? AND ends>?')
      .get(userId, this.now(), this.now());
  }
  remaining(period) {
    const {used} = this.db.prepare(`SELECT coalesce(sum(CASE WHEN state='settled' THEN charged
      WHEN state='pending' THEN reserved ELSE 0 END),0) AS used FROM ai_budget_requests WHERE period_id=?`).get(period.id);
    return period.allowance - used;
  }
  reserve(userId, {model, maximumMicros}) {
    if (!identifier(model) || !integer(maximumMicros) || maximumMicros === 0) fail(400, 'Chi phí dự phòng không hợp lệ.');
    // Caller must use a server-side model allowlist and verified tariff/counts.
    return this.transaction(() => {
      const period = this.current(userId);
      if (!period || period.allowance === 0) fail(403, 'Tài khoản chưa có ngân sách AI trả phí.');
      if (this.remaining(period) < maximumMicros) fail(429, 'Ngân sách AI còn lại không đủ cho yêu cầu này.');
      const id = crypto.randomUUID();
      this.db.prepare("INSERT INTO ai_budget_requests VALUES(?,?,?,?,NULL,'pending')")
        .run(id, period.id, model, maximumMicros);
      return id;
    });
  }
  settle(id, actualMicros) {
    if (!integer(actualMicros)) fail(400, 'Chi phí thực tế không hợp lệ.');
    return this.transaction(() => {
      const request = this.db.prepare('SELECT * FROM ai_budget_requests WHERE id=?').get(id);
      if (!request) fail(404, 'Không tìm thấy yêu cầu AI.');
      if (request.state === 'settled' && request.charged === actualMicros) return false;
      if (request.state !== 'pending') fail(409, 'Yêu cầu đã được quyết toán.');
      if (actualMicros > request.reserved) fail(409, 'Chi phí vượt dự phòng; cần đối soát máy chủ.');
      this.db.prepare("UPDATE ai_budget_requests SET state='settled',charged=? WHERE id=?").run(actualMicros, id);
      return true;
    });
  }
  // Only release when upstream is known not to have charged. Timeouts/crashes
  // remain reserved for reconciliation; elapsed time alone must not refund.
  cancelUncharged(id) {
    this.db.prepare("UPDATE ai_budget_requests SET state='cancelled' WHERE id=? AND state='pending'").run(id);
  }
}
