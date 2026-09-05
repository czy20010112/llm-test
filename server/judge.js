'use strict';
/** Client for the code judge service (judge/app.py, runs in WSL2 Docker). */
const JUDGE_URL = process.env.JUDGE_URL || 'http://127.0.0.1:8901';

async function judgeRun(payload, timeoutMs = 15 * 60 * 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(JUDGE_URL + '/judge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error('judge HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function judgeHealth(timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(JUDGE_URL + '/health', { signal: controller.signal });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
    return { ok: true, ...(await r.json()) };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { JUDGE_URL, judgeRun, judgeHealth };
