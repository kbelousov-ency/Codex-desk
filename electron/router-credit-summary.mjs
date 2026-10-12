import { productLimits } from './portal-limits.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value
  : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const clamp = value => Math.min(100, Math.max(0, value));
const incompleteReason = 'Расход получен не полностью.';
const unknownReason = 'Сервер не передал расход в кредитах.';
const missingQuotaReason = 'Роутер не передал полный лимит в кредитах.';
const missingSpend = reason => ({ credits: null, partial: true, reason });

function safeText(value, key) {
  return typeof value === 'string' && !(key && value.includes(key))
    ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 240) : null;
}

function normalizeLimit(value, provider, key, snake = false) {
  const limitCredits = number(value[snake ? 'limit_credits' : 'limitCredits']);
  const usedCredits = number(value[snake ? 'used_credits' : 'usedCredits']);
  const remainingCredits = limitCredits !== null && usedCredits !== null
    ? Math.max(0, limitCredits - usedCredits) : snake ? null : number(value.remainingCredits);
  const usedPercent = limitCredits !== null && limitCredits > 0 && usedCredits !== null
    ? number(usedCredits / limitCredits * 100) : snake ? null : number(value.usedPercent);
  const suppliedLeft = snake ? null : number(value.left);
  const left = limitCredits !== null && limitCredits > 0 && remainingCredits !== null
    ? clamp(remainingCredits / limitCredits * 100) : suppliedLeft !== null ? clamp(suppliedLeft) : null;
  return {
    key: null, name: provider === 'claude' ? 'Claude' : 'Codex',
    available: typeof value.available === 'boolean' ? value.available : null,
    tier: safeText(value.tier, key), state: safeText(value.state, key),
    resetAt: date(value[snake ? 'reset_at' : 'resetAt']),
    limitCredits, usedCredits, remainingCredits, usedPercent, left,
    blocked: typeof value.blocked === 'boolean' ? value.blocked : null,
    blockedReason: safeText(value.blockedReason, key), bands: [],
  };
}

function fableBands(limit, key) {
  if (!Array.isArray(limit?.bands)) return [];
  return limit.bands.filter(band => record(band) && /fable/i.test(typeof band.name === 'string' ? band.name : ''))
    .slice(0, 16).map(band => ({
      ...normalizeLimit(band, 'claude', key), name: 'Fable',
      band: safeText(band.band, key), hours: number(band.hours), sharePercent: number(band.sharePercent),
    }));
}

function spendOf(result, { provider, session, key }) {
  if (!result?.ok || !record(result.value)) return missingSpend(safeText(result?.reason, key) || 'Не удалось получить расход роутера.');
  const value = result.value;
  const credits = number(value.totals?.credits);
  if (credits === null) return missingSpend(unknownReason);
  if (session) {
    const calls = number(value.totals?.calls);
    if (calls === null || !Number.isInteger(calls)) return missingSpend('Сервер не подтвердил число запросов диалога.');
    // Existing UUIDs with no journal rows are indistinguishable from expired or
    // unknown sessions. Only a genuinely new dialog (no UUID) has a known zero.
    if (calls === 0) return missingSpend('В журнале нет данных этого диалога.');
  }
  const sources = typeof value.sources === 'boolean'
    ? { core: value.sources, ledger: value.sources } : value.sources;
  const sourcesComplete = record(sources) && sources.core === true
    && (session || provider !== 'codex' || sources.ledger === true);
  // A zero aggregate can hide NULL prices (SQL SUM ignores them). Inspect the
  // returned sample as well, and honour explicit coverage/counts when supplied.
  const unknownRows = Array.isArray(value.turns) && value.turns.some(row => !record(row) || number(row.credits) === null);
  const unknownCount = ['unpriced_calls', 'unknown_credits', 'unpriced', 'unknown_calls']
    .some(field => number(value.totals?.[field]) > 0);
  const incompleteCoverage = record(value.coverage) && (value.coverage.complete === false
    || Object.values(value.coverage).some(source => record(source) && source.complete === false));
  const partial = !sourcesComplete || unknownRows || unknownCount || incompleteCoverage || value.partial === true;
  return partial ? { credits: credits > 0 ? credits : null, partial: true,
    reason: unknownRows || unknownCount ? unknownReason : incompleteReason } : { credits };
}

async function boundedMap(values, worker, concurrency = 4) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await worker(values[index]);
    }
  }));
  return results;
}

function sessionTotal(values) {
  if (!values.length) return { credits: 0, threadCount: 0 };
  const known = values.filter(value => value.credits !== null);
  const total = known.reduce((sum, value) => sum + value.credits, 0);
  if (!Number.isFinite(total)) return { ...missingSpend(unknownReason), threadCount: values.length };
  const partial = values.some(value => value.partial || value.credits === null);
  return { credits: partial && total === 0 ? null : total, threadCount: values.length,
    ...(partial ? { partial: true, reason: values.find(value => value.reason)?.reason || incompleteReason } : {}) };
}

/** Read only the selected provider, with credentials confined to the supplied clients. */
export async function readRouterCreditSummary({ routerClient, portalClient, apiKey, provider = 'codex', threadIds = [], now = Date.now } = {}) {
  const current = new Date(typeof now === 'function' ? now() : now);
  const fetchedAt = Number.isFinite(current.getTime()) ? current.toISOString() : new Date().toISOString();
  const midnight = new Date(fetchedAt);
  midnight.setHours(0, 0, 0, 0);
  const since = midnight.toISOString();
  const ids = [...new Set((Array.isArray(threadIds) ? threadIds : []).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
  const unsupported = provider !== 'codex' && provider !== 'claude';
  if (unsupported || typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n\0]/.test(apiKey)) {
    const reason = unsupported ? 'Неизвестный провайдер статистики.' : 'Ключ роутера недоступен.';
    return { provider, available: false, fetchedAt, limits: [], reason,
      spend: { session: ids.length ? { ...missingSpend(reason), threadCount: ids.length } : sessionTotal([]), today: { ...missingSpend(reason), since } } };
  }
  const key = apiKey.trim();
  const request = async params => {
    try { return await routerClient.requestJson(params, key); }
    catch { return { ok: false, reason: 'Не удалось получить статистику роутера.' }; }
  };
  const turnRequest = filters => request(`/v1/me/turns?${new URLSearchParams({ provider, ...filters, limit: '1' })}`);
  const [quotaReply, todayReply, portalReply, sessions] = await Promise.all([
    request(`/v1/me/limit/agents?${new URLSearchParams({ provider })}`),
    turnRequest({ since, until: fetchedAt }),
    (async () => { try { return await portalClient?.read(key); } catch { return null; } })(),
    boundedMap(ids, async session => spendOf(await turnRequest({ session }), { provider, session: true, key })),
  ]);
  const product = provider === 'claude' ? 'Claude' : 'Codex';
  const portal = productLimits(portalReply, product);
  // Multiple rows are not a single wallet. Never choose one arbitrarily.
  const portalValue = portal?.available && portal.limits?.length === 1 && record(portal.limits[0]) ? portal.limits[0] : null;
  const portalLimit = portalValue ? normalizeLimit(portalValue, provider, key) : null;
  const quotaValue = quotaReply?.ok && record(quotaReply.value) && quotaReply.value.available === true
    && (!quotaReply.value.provider || quotaReply.value.provider === provider) ? quotaReply.value : null;
  const quota = quotaValue ? normalizeLimit(quotaValue, provider, key, true) : null;
  const completeQuota = quota && quota.limitCredits !== null && quota.usedCredits !== null;
  const completePortal = portalLimit && portalLimit.available !== false && portalLimit.limitCredits !== null && portalLimit.usedCredits !== null;
  const limit = completeQuota ? quota : completePortal ? portalLimit : quota || portalLimit;
  if (limit && provider === 'claude') limit.bands = fableBands(portalValue, key);
  const limitReason = completeQuota || completePortal ? undefined : safeText(quotaReply?.reason, key) || missingQuotaReason;
  const spend = { session: sessionTotal(sessions), today: { ...spendOf(todayReply, { provider, session: false, key }), since } };
  const available = Boolean(limit || spend.today.credits !== null || (ids.length && spend.session.credits !== null));
  return { provider, available, fetchedAt, limits: limit ? [limit] : [], spend,
    ...(limitReason ? { limitReason } : {}),
    ...(!available ? { reason: limitReason || spend.today.reason || 'Статистика роутера недоступна.' } : {}),
  };
}
