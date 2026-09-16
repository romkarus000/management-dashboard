// n8n Code node: CRM Leading → warehouse/crm → dashboard ingest
// Keep in sync with docs/crm-warehouse-contract.md · PROJECT.md crm-leading
// Secrets: set EDPROBIZ_MCP_TOKEN + use same ingest Bearer as Dev Flow.

const EDPROBIZ_MCP_URL = 'https://edprobiz.mcp.ai.edpro.io/mcp';
const EDPROBIZ_MCP_TOKEN = 'REPLACE_EDPROBIZ_MCP_TOKEN';
const SALEBOT_API_KEY = 'REPLACE_SALEBOT_API_KEY';
const SALEBOT_API_BASE = 'https://chatter.salebot.pro/api';
const ENKOD_API_KEY = 'REPLACE_ENKOD_API_KEY';
const ENKOD_API_BASE = 'https://api.enkod.ru';
const DASHBOARD_BASE = 'https://dashboard.edpro.ru/warehouse';
const WAREHOUSE_VERSION = '2.0';
const OFFER_LEAD_CATS = [13, 15, 19, 45];
const RFM_SEGMENTS = ['Champions', 'Loyal', 'Potential', 'Need Attention', 'At Risk', 'Hibernating'];
/** RFM тяжёлый (до ~2000 платежей/направление) — считаем только за текущий месяц. */
const RFM_ONLY_CURRENT_MONTH = true;
/**
 * Режимы прогона:
 * - light (default, cron 07:00): Edpro + enKod metrics + кэш Salebot/email_base
 * - heavy (вс / webhook ?mode=heavy): полный Salebot + email_base + догон имён
 * Override: webhook body/query `mode`, или item.mode от Set-ноды.
 */
const DEFAULT_RUN_MODE = 'light';
/** В light не сканим Salebot; кэш старше N дней → status cache-stale, цифры всё равно берём. */
const SALEBOT_CACHE_MAX_AGE_DAYS = 7;
/** Сколько новых message id дозапрашивать за один light/heavy прогон. */
const ENKOD_NAME_FETCH_LIMIT_LIGHT = 400;
const ENKOD_NAME_FETCH_LIMIT_HEAVY = 5000;

/** Бот → направление (Salebot project 100122, short_name / VK group_id). */
const SALEBOT_BOTS = {
  nutra: { tg: ['edpronutricion_bot', 'vyalov_edpro_bot'], vk: [] },
  psi: { tg: ['edpropsi_bot'], vk: ['202635360'] },
  sex: { tg: ['edprosex_bot'], vk: ['201669944'] },
  icf: { tg: ['edprocoachingicf_bot', 'edprocoaching_bot'], vk: ['201669903', '202326818'] },
  design: { tg: ['edprodesign_bot'], vk: ['204324740'] },
};

/** enKod group systemName → направление (email_base). */
const ENKOD_BASE_GROUPS = {
  nutra: 'nutriciologia',
  psi: 'psychology',
  sex: 'sexology',
  icf: 'couching',
  design: 'design',
};

const DIRECTIONS = [
  { id: 'nutra', label: 'Нутрициология', utm: 'rass_edpro_nutra', line_id: 3 },
  { id: 'psi', label: 'Психология', utm: 'user_kp_psi', line_id: 17 },
  { id: 'sex', label: 'Сексология', utm: 'user_kp_sex', line_id: 5 },
  { id: 'icf', label: 'Коучинг', utm: 'user_kp_icf', line_id: 11 },
  { id: 'design', label: 'Дизайн интерьера', utm: 'user_kp_design', line_id: 23 },
];

function moscowDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

function ymOf(isoDate) {
  return isoDate.slice(0, 7);
}

function prevYm(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function monthBounds(ym, asOf) {
  const [y, m] = ym.split('-').map(Number);
  const from = `${ym}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthEnd = `${ym}-${String(lastDay).padStart(2, '0')}`;
  const to = ym === ymOf(asOf) && asOf < monthEnd ? asOf : monthEnd;
  const dateToExclusive = (() => {
    const nd = new Date(Date.UTC(y, m, 1)); // next month day 1
    return `${nd.getUTCFullYear()}-${String(nd.getUTCMonth() + 1).padStart(2, '0')}-01`;
  })();
  return { from, to, dateToExclusive };
}

function cacheAgeDays(asOfOrIso) {
  if (!asOfOrIso) return null;
  const day = String(asOfOrIso).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const today = moscowDateString();
  const t0 = Date.parse(`${day}T00:00:00Z`);
  const t1 = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(t0) || Number.isNaN(t1)) return null;
  return Math.max(0, Math.round((t1 - t0) / 86400000));
}

function resolveRunMode() {
  try {
    const item = ($input && $input.first && $input.first()?.json) || {};
    const q = item.query || {};
    const body = (item.body && typeof item.body === 'object') ? item.body : {};
    const raw = String(
      q.mode || body.mode || item.mode || DEFAULT_RUN_MODE,
    ).toLowerCase().trim();
    if (raw === 'heavy' || raw === 'full' || raw === 'scan') return 'heavy';
    return 'light';
  } catch (e) {
    return DEFAULT_RUN_MODE;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function checksumData(data) {
  const s = JSON.stringify(data ?? null);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + s.length.toString(16).padStart(8, '0');
}

function emptyCh() {
  return { sent: null, delivered: null, opens: null, clicks: null, or_pct: null, ctr_pct: null };
}

function buildEnvelope(dataset, period, data, meta = {}, filtersExtra = {}) {
  const fetchedAt = new Date().toISOString();
  return {
    warehouseVersion: WAREHOUSE_VERSION,
    dataset,
    period,
    fetchedAt,
    checksum: checksumData(data),
    filters: { periodType: 'month', period, timezone: 'Europe/Moscow', ...filtersExtra },
    meta: {
      source: 'n8n-crm-leading',
      department: 'crm',
      generatedAt: fetchedAt,
      ...meta,
    },
    data,
  };
}

async function fetchJson(url) {
  try {
    return await this.helpers.httpRequest({ method: 'GET', url, json: true });
  } catch (e) {
    return null;
  }
}

function resolveSalebotKey() {
  try {
    if (typeof $env !== 'undefined' && $env.SALEBOT_API_KEY) return String($env.SALEBOT_API_KEY);
  } catch (e) { /* no $env */ }
  if (SALEBOT_API_KEY && !SALEBOT_API_KEY.startsWith('REPLACE_')) return SALEBOT_API_KEY;
  return '';
}

function normToken(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^@/, '')
    .replace(/[^a-z0-9_]/g, '');
}

function matchDirChannel(haystack) {
  const h = normToken(haystack);
  if (!h) return null;
  for (const [dir, bots] of Object.entries(SALEBOT_BOTS)) {
    for (const name of bots.tg || []) {
      const n = normToken(name);
      if (n && (h === n || h.includes(n) || n.includes(h))) return { dir, channel: 'tg' };
    }
    for (const name of bots.vk || []) {
      const n = normToken(name);
      if (n && (h === n || h.includes(n) || n.includes(h))) return { dir, channel: 'vk' };
    }
  }
  return null;
}

function emptySalebotBases() {
  const out = {};
  for (const d of DIRECTIONS) out[d.id] = { messenger_tg: 0, messenger_vk: 0 };
  return out;
}

async function salebotGet(path, qs = {}) {
  const key = resolveSalebotKey();
  const q = Object.entries(qs)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const url = `${SALEBOT_API_BASE}/${key}/${path}${q ? `?${q}` : ''}`;
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await this.helpers.httpRequest({
        method: 'GET',
        url,
        json: true,
        timeout: 180000,
      });
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(60000, 1000 * 2 ** attempt));
    }
  }
  throw lastErr || new Error('salebotGet failed');
}

/**
 * Полный скан клиентов Salebot → счётчики TG/VK по направлениям.
 * Кладём также в crm/_cache/salebot_base.json через ingest.
 * @param {{ forceScan?: boolean }} opts
 */
async function fetchSalebotBases(opts = {}) {
  const forceScan = !!opts.forceScan;
  const bases = emptySalebotBases();
  const key = resolveSalebotKey();
  if (!key) {
    return { bases: null, status: 'skip:no-key', clients: 0, mappedGroups: 0 };
  }

  const cached = await fetchJson.call(this, `${DASHBOARD_BASE}/crm/_cache/salebot_base.json`);
  if (!forceScan && cached?.byDirection) {
    const ageDays = cacheAgeDays(cached.asOf || cached.fetchedAt);
    const stale = ageDays != null && ageDays > SALEBOT_CACHE_MAX_AGE_DAYS;
    return {
      bases: cached.byDirection,
      status: stale ? `cache-stale:${ageDays}d` : (ageDays === 0 ? 'cache-today' : `cache:${ageDays}d`),
      clients: cached.clients || 0,
      mappedGroups: cached.mappedGroups || 0,
      cache: cached,
    };
  }
  if (!forceScan) {
    return { bases: null, status: 'skip:no-cache', clients: 0, mappedGroups: 0 };
  }

  let channelsRaw;
  try {
    channelsRaw = await salebotGet.call(this, 'connected_channels');
  } catch (e) {
    if (cached?.byDirection) {
      return {
        bases: cached.byDirection,
        status: `fail-channels-carry:${String(e.message || e).slice(0, 80)}`,
        clients: cached.clients || 0,
        mappedGroups: cached.mappedGroups || 0,
        cache: cached,
      };
    }
    throw e;
  }

  /** group_id → {dir, channel} */
  const groupMap = new Map();
  const addChannel = (ch, forcedChannel) => {
    if (!ch || typeof ch !== 'object') return;
    const groupId = ch.group_id ?? ch.group ?? ch.short_name ?? ch.id;
    if (groupId == null || groupId === '') return;
    const needles = [
      ch.short_name, ch.group_id, ch.group, ch.name, ch.username, String(groupId),
    ];
    let hit = null;
    for (const n of needles) {
      hit = matchDirChannel(n);
      if (hit) break;
    }
    if (!hit) return;
    if (forcedChannel) hit = { ...hit, channel: forcedChannel };
    groupMap.set(String(groupId), hit);
  };

  if (channelsRaw && typeof channelsRaw === 'object' && !Array.isArray(channelsRaw)) {
    const tgList = channelsRaw.telegram || channelsRaw.tg || [];
    const vkList = channelsRaw.vkontakte || channelsRaw.vk || [];
    for (const ch of tgList) addChannel(ch, 'tg');
    for (const ch of vkList) addChannel(ch, 'vk');
  } else {
    const channels = Array.isArray(channelsRaw)
      ? channelsRaw
      : (channelsRaw?.channels || channelsRaw?.data || channelsRaw?.result || []);
    for (const ch of channels) addChannel(ch, null);
  }

  // Also map known bot ids directly (на случай если connected_channels урезан)
  for (const [dir, bots] of Object.entries(SALEBOT_BOTS)) {
    for (const name of bots.tg || []) groupMap.set(String(name), { dir, channel: 'tg' });
    for (const name of bots.vk || []) groupMap.set(String(name), { dir, channel: 'vk' });
  }

  let offset = 0;
  const limit = 500;
  let clients = 0;
  let pages = 0;
  const maxPages = 4000; // safety ~2M
  while (pages < maxPages) {
    let page;
    try {
      page = await salebotGet.call(this, 'get_clients', { offset, limit });
    } catch (e) {
      if (clients > 0) break; // partial ok
      if (cached?.byDirection) {
        return {
          bases: cached.byDirection,
          status: `fail-clients-carry:${String(e.message || e).slice(0, 80)}`,
          clients: cached.clients || 0,
          mappedGroups: groupMap.size,
          cache: cached,
        };
      }
      throw e;
    }
    const list = Array.isArray(page)
      ? page
      : (page?.clients || page?.data || page?.result || page?.items || []);
    if (!Array.isArray(list) || list.length === 0) break;
    for (const c of list) {
      clients += 1;
      const gid = String(c.group ?? c.group_id ?? c.groupId ?? '');
      const mapped = groupMap.get(gid);
      if (!mapped) continue;
      if (mapped.channel === 'tg') bases[mapped.dir].messenger_tg += 1;
      else if (mapped.channel === 'vk') bases[mapped.dir].messenger_vk += 1;
    }
    pages += 1;
    if (list.length < limit) break;
    offset += limit;
    if (pages % 20 === 0) await sleep(80);
    else await sleep(20);
  }

  return {
    bases,
    status: 'ok',
    clients,
    mappedGroups: groupMap.size,
    pages,
    cachePayload: {
      asOf: moscowDateString(),
      fetchedAt: new Date().toISOString(),
      clients,
      mappedGroups: groupMap.size,
      pages,
      byDirection: bases,
    },
  };
}

function resolveEnkodKey() {
  try {
    if (typeof $env !== 'undefined' && ($env.ENKOD_REPORTS_API_KEY || $env.ENKOD_API_KEY)) {
      return String($env.ENKOD_REPORTS_API_KEY || $env.ENKOD_API_KEY);
    }
  } catch (e) { /* no $env */ }
  if (ENKOD_API_KEY && !ENKOD_API_KEY.startsWith('REPLACE_')) return ENKOD_API_KEY;
  return '';
}

function dirFromEnkodName(name) {
  const n = String(name || '').toLowerCase();
  if (/nutra|нутра/.test(n)) return 'nutra';
  if (/vsepsi|vse.?psi|психо/.test(n)) return 'psi';
  if (/vsesex|секс/.test(n)) return 'sex';
  if (/vseicf|коуч|\bicf\b/.test(n)) return 'icf';
  if ((/vsedesign|дизайн|design/.test(n)) && !/graph|граф/.test(n)) return 'design';
  return null;
}

async function enkodGet(path) {
  const key = resolveEnkodKey();
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await this.helpers.httpRequest({
        method: 'GET',
        url: `${ENKOD_API_BASE}${path}`,
        headers: { apiKey: key, Accept: 'application/json' },
        json: true,
        timeout: 180000,
      });
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(30000, 800 * 2 ** attempt));
    }
  }
  throw lastErr || new Error('enkodGet failed');
}

async function enkodCountGroup(systemName) {
  const key = resolveEnkodKey();
  const url = `${ENKOD_API_BASE}/v1/group/subscribers/?systemName=${encodeURIComponent(systemName)}`;
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const raw = await this.helpers.httpRequest({
        method: 'GET',
        url,
        headers: { apiKey: key },
        encoding: 'utf8',
        timeout: 600000,
      });
      const text = typeof raw === 'string' ? raw : String(raw || '');
      const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
      return Math.max(0, lines.length - 1);
    } catch (e) {
      lastErr = e;
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  }
  throw lastErr || new Error('enkodCountGroup failed');
}

/**
 * Email leading по направлениям + unmatched/unsub.
 * Имена писем кэшируем в crm/_cache/enkod_message_names.json
 * @param {string} from
 * @param {string} to
 * @param {Record<string,string>} nameCache
 * @param {{ maxNameFetch?: number }} opts
 */
async function fetchEnkodEmailMetrics(from, to, nameCache, opts = {}) {
  const key = resolveEnkodKey();
  if (!key) return { byDir: null, unmatched: null, unsub: null, status: 'skip:no-key', nameCache };
  const maxNameFetch = opts.maxNameFetch != null ? opts.maxNameFetch : ENKOD_NAME_FETCH_LIMIT_LIGHT;
  const rows = await enkodGet.call(this, `/v1/statistic/general?from=${from}&to=${to}`);
  const list = Array.isArray(rows) ? rows : [];
  const missing = [];
  for (const r of list) {
    const id = String(r.id);
    if (!nameCache[id]) missing.push(id);
  }
  const toFetch = missing.slice(0, Math.max(0, maxNameFetch));
  const deferred = missing.length - toFetch.length;
  const batchSize = 20;
  for (let i = 0; i < toFetch.length; i += batchSize) {
    const chunk = toFetch.slice(i, i + batchSize);
    await Promise.all(chunk.map(async (id) => {
      try {
        const msg = await enkodGet.call(this, `/v1/statistic/message/${id}/`);
        nameCache[id] = msg?.name || '';
      } catch (e) {
        nameCache[id] = '';
      }
    }));
    await sleep(50);
  }

  const byDir = {};
  for (const d of DIRECTIONS) {
    byDir[d.id] = emptyCh();
    byDir[d.id].sent = 0;
    byDir[d.id].delivered = 0;
    byDir[d.id].opens = 0;
    byDir[d.id].clicks = 0;
  }
  let unmatched = 0;
  let unsub = 0;
  for (const r of list) {
    unsub += r.unsubscribes || 0;
    const id = String(r.id);
    // нет имени в кэше (отложено в light) — пропускаем агрегацию направления
    if (!Object.prototype.hasOwnProperty.call(nameCache, id)) continue;
    const dir = dirFromEnkodName(nameCache[id]);
    if (!dir) {
      unmatched += 1;
      continue;
    }
    const b = byDir[dir];
    b.sent += r.sent || 0;
    b.delivered += r.delivered || 0;
    b.opens += r.opens || 0;
    b.clicks += r.clicks || 0;
  }
  for (const d of Object.keys(byDir)) {
    const b = byDir[d];
    const deliv = b.delivered || 0;
    b.or_pct = deliv ? Math.round((10000 * b.opens) / deliv) / 100 : null;
    b.ctr_pct = deliv ? Math.round((10000 * b.clicks) / deliv) / 100 : null;
  }
  const status = deferred > 0
    ? `ok-partial-names:${deferred}`
    : (toFetch.length ? 'ok' : 'ok-cache-names');
  return {
    byDir, unmatched, unsub, status, nameCache,
    messages: list.length, namesFetched: toFetch.length, namesDeferred: deferred,
  };
}

async function fetchEnkodEmailBases() {
  const key = resolveEnkodKey();
  if (!key) return { bases: null, status: 'skip:no-key' };
  const bases = {};
  for (const [dir, systemName] of Object.entries(ENKOD_BASE_GROUPS)) {
    bases[dir] = await enkodCountGroup.call(this, systemName);
    await sleep(100);
  }
  return { bases, status: 'ok' };
}

let mcpSessionId = null;

async function mcpInit() {
  const res = await this.helpers.httpRequest({
    method: 'POST',
    url: EDPROBIZ_MCP_URL,
    headers: {
      Authorization: `Bearer ${EDPROBIZ_MCP_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'n8n-crm-leading', version: '0.1' },
      },
    },
    json: true,
    returnFullResponse: true,
  });
  const headers = res.headers || {};
  mcpSessionId = headers['mcp-session-id'] || headers['Mcp-Session-Id'] || null;
  await this.helpers.httpRequest({
    method: 'POST',
    url: EDPROBIZ_MCP_URL,
    headers: {
      Authorization: `Bearer ${EDPROBIZ_MCP_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
    },
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
    json: true,
  });
}

function parseSseOrJson(payload) {
  if (payload == null) return null;
  if (typeof payload === 'object') return payload;
  const text = String(payload);
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data:')) {
      try {
        return JSON.parse(line.slice(5).trim());
      } catch (e) {
        /* continue */
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function mcpCall(name, args) {
  const raw = await this.helpers.httpRequest({
    method: 'POST',
    url: EDPROBIZ_MCP_URL,
    headers: {
      Authorization: `Bearer ${EDPROBIZ_MCP_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
    },
    body: {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    },
    json: true,
  });
  const msg = parseSseOrJson(raw);
  const text = msg?.result?.content?.[0]?.text;
  if (!text) throw new Error(`MCP ${name}: empty result`);
  const parsed = typeof text === 'string' ? JSON.parse(text) : text;
  if (parsed && parsed.ok === false) {
    throw new Error(`MCP ${name}: ${parsed.error || 'ok=false'}`);
  }
  return parsed;
}

function carryChannel(prevRow) {
  if (!prevRow) {
    return { email: emptyCh(), tg: emptyCh(), vk: emptyCh(), max: emptyCh() };
  }
  return {
    email: prevRow.email || emptyCh(),
    tg: prevRow.tg || emptyCh(),
    vk: prevRow.vk || emptyCh(),
    max: prevRow.max || emptyCh(),
  };
}

function quintileRanks(values) {
  // values: number[], return map valueIndex -> score 1..5 (higher better for F/M, for R invert later)
  const indexed = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const n = indexed.length;
  const ranks = new Array(n).fill(1);
  if (n === 0) return ranks;
  for (let k = 0; k < n; k++) {
    const score = Math.min(5, Math.floor((k / n) * 5) + 1);
    ranks[indexed[k].i] = score;
  }
  return ranks;
}

function rfmSegment(r, f, m) {
  // Compact mapping close to snapshot labels
  if (r >= 4 && f >= 4 && m >= 4) return 'Champions';
  if (r >= 3 && f >= 3 && m >= 3) return 'Loyal';
  if (r >= 4 && f <= 2) return 'Potential';
  if (r >= 3 && f <= 2) return 'Need Attention';
  if (r <= 2 && f >= 3) return 'At Risk';
  return 'Hibernating';
}

async function fetchRfmForDirection(dir, paymentsFrom, paymentsTo) {
  const users = new Map(); // user_id -> { lastPaid, count, sum }
  let truncated = false;
  let offset = 0;
  const limit = 300;
  const hardCap = 2000;
  while (offset < hardCap) {
    const page = await mcpCall.call(this, 'mcp_segment_payments', {
      date_from: paymentsFrom,
      date_to: paymentsTo,
      date_field: 'paid',
      mode: 'list',
      payment_type: 1,
      line_id: dir.line_id,
      limit,
      offset,
    });
    const rows = page.payments || page.items || page.rows || page.data || [];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const p of rows) {
      const uid = p.user_id || p.userId;
      if (!uid) continue;
      const amount = Number(p.amount ?? p.receipt_sum ?? p.receipt_amount ?? 0);
      if (!amount || amount <= 1000) continue;
      const paidAt = p.paid_at || p.paid || p.date || p.created_at;
      const cur = users.get(uid) || { lastPaid: null, count: 0, sum: 0 };
      cur.count += 1;
      cur.sum += amount;
      if (!cur.lastPaid || String(paidAt) > String(cur.lastPaid)) cur.lastPaid = paidAt;
      users.set(uid, cur);
    }
    if (rows.length < limit) break;
    offset += limit;
    if (offset >= hardCap) {
      truncated = true;
      break;
    }
    await sleep(120);
  }

  const list = [...users.entries()].map(([userId, u]) => {
    const last = u.lastPaid ? new Date(u.lastPaid) : null;
    const recencyDays = last && !Number.isNaN(last.getTime())
      ? Math.max(0, (Date.now() - last.getTime()) / 86400000)
      : 9999;
    return { userId, recencyDays, frequency: u.count, monetary: u.sum };
  });

  const rScores = quintileRanks(list.map((x) => -x.recencyDays)); // higher score = more recent
  const fScores = quintileRanks(list.map((x) => x.frequency));
  const mScores = quintileRanks(list.map((x) => x.monetary));

  const segments = {};
  for (const lab of RFM_SEGMENTS) segments[lab] = { count: 0, share_pct: 0, avg_m: 0, sum_m: 0 };
  list.forEach((u, i) => {
    const lab = rfmSegment(rScores[i], fScores[i], mScores[i]);
    segments[lab].count += 1;
    segments[lab].sum_m += u.monetary;
  });
  const total = list.length || 1;
  for (const lab of RFM_SEGMENTS) {
    const s = segments[lab];
    s.share_pct = Math.round((10000 * s.count) / total) / 100;
    s.avg_m = s.count ? Math.round((s.sum_m / s.count) * 100) / 100 : 0;
    delete s.sum_m;
  }
  return { users: list.length, truncated, segments };
}

async function buildMonth(ym, asOf, sources, opts = {}) {
  const bounds = monthBounds(ym, asOf);
  const prevLeading = await fetchJson.call(this, `${DASHBOARD_BASE}/crm/leading/${ym}.json`);
  const prevBase = await fetchJson.call(this, `${DASHBOARD_BASE}/crm/base/${ym}.json`);
  const prevRfm = await fetchJson.call(this, `${DASHBOARD_BASE}/crm/rfm/${ym}.json`);
  const prevByDir = {};
  for (const row of prevLeading?.data?.rows || []) prevByDir[row.direction] = row;
  const prevBaseByDir = {};
  for (const row of prevBase?.data?.rows || []) prevBaseByDir[row.direction] = row;
  const computeRfm = opts.computeRfm !== false;
  const salebotBases = opts.salebotBases || null;
  const enkodEmail = opts.enkodEmail || null;
  const enkodBases = opts.enkodBases || null;

  const leadingRows = [];
  const baseRows = [];
  const rfmByDir = {};
  const paymentsFrom = (() => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1, 1));
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  })();

  for (const dir of DIRECTIONS) {
    let leadsOrders = prevByDir[dir.id]?.leads_orders ?? 0;
    let leadUsers = prevByDir[dir.id]?.lead_users ?? 0;
    let paidUsers = prevByDir[dir.id]?.paid_users ?? 0;
    let paidPayments = prevByDir[dir.id]?.paid_payments ?? 0;
    let paidNet = prevByDir[dir.id]?.paid_net ?? 0;
    let c2 = prevByDir[dir.id]?.c2_pct ?? 0;
    let regs = prevByDir[dir.id]?.regs ?? null;
    let edproOk = false;

    try {
      const orders = await mcpCall.call(this, 'mcp_segment_orders', {
        date_from: bounds.from,
        date_to: bounds.to,
        date_field: 'created',
        mode: 'summary',
        dimension: 'utm_medium',
        utm_medium: dir.utm,
        offer_categories: OFFER_LEAD_CATS,
      });
      const g = (orders.groups || [])[0];
      if (g) {
        leadsOrders = g.orders_count || 0;
      }
      await sleep(150);

      const c2res = await mcpCall.call(this, 'mcp_channel_segment_revenue', {
        date_from: bounds.from,
        date_to: bounds.dateToExclusive,
        utm_medium: dir.utm,
        offer_categories: OFFER_LEAD_CATS,
        attribution_mode: 'lead_cohort',
        since_lead: true,
        payments_to: bounds.to,
      });
      const v = c2res.values || {};
      leadUsers = v.lead_users || 0;
      paidUsers = v.paid_users || 0;
      paidPayments = v.gross_count || 0;
      paidNet = v.net_sum || 0;
      c2 = v.conversion_pct != null ? v.conversion_pct : (leadUsers ? (100 * paidUsers) / leadUsers : 0);
      edproOk = true;
      sources.edprobiz = 'ok';
    } catch (e) {
      sources.edprobiz = `fail:${String(e.message || e).slice(0, 120)}`;
    }

    const ch = carryChannel(prevByDir[dir.id]);
    if (enkodEmail?.byDir?.[dir.id]) {
      const em = enkodEmail.byDir[dir.id];
      ch.email = {
        sent: em.sent,
        delivered: em.delivered,
        opens: em.opens,
        clicks: em.clicks,
        or_pct: em.or_pct,
        ctr_pct: em.ctr_pct,
      };
      sources.enkod = sources.enkod || enkodEmail.status || 'ok';
    } else if (!prevByDir[dir.id]) {
      sources.channels = sources.channels || 'carry-empty';
    } else {
      sources.channels = sources.channels || 'carry';
    }

    leadingRows.push({
      direction: dir.id,
      label: dir.label,
      utm: dir.utm,
      ...ch,
      leads_orders: leadsOrders,
      lead_users: leadUsers,
      regs,
      paid_users: paidUsers,
      paid_payments: paidPayments,
      paid_net: paidNet,
      c2_pct: Math.round(c2 * 100) / 100,
      _edpro: edproOk,
    });

    if (computeRfm) {
      try {
        rfmByDir[dir.id] = await fetchRfmForDirection.call(this, dir, paymentsFrom, bounds.to);
        await sleep(200);
        sources.rfm = 'ok';
      } catch (e) {
        rfmByDir[dir.id] = (prevRfm?.data?.byDirection || {})[dir.id]
          || { users: prevBaseByDir[dir.id]?.payers_12m || 0, truncated: true, segments: {} };
        sources.rfm = `fail:${String(e.message || e).slice(0, 80)}`;
      }
    } else {
      rfmByDir[dir.id] = (prevRfm?.data?.byDirection || {})[dir.id]
        || { users: prevBaseByDir[dir.id]?.payers_12m || 0, truncated: false, segments: {} };
      sources.rfm = sources.rfm || 'carry';
    }

    const prevB = prevBaseByDir[dir.id] || {};
    const sb = salebotBases && salebotBases[dir.id];
    baseRows.push({
      direction: dir.id,
      label: dir.label,
      email_base: (enkodBases && enkodBases[dir.id] != null) ? enkodBases[dir.id] : (prevB.email_base ?? null),
      messenger_tg: sb ? sb.messenger_tg : (prevB.messenger_tg ?? null),
      messenger_vk: sb ? sb.messenger_vk : (prevB.messenger_vk ?? null),
      messenger_max: prevB.messenger_max ?? null,
      active_180d: prevB.active_180d ?? null,
      cold_180d: prevB.cold_180d ?? null,
      hot_3clicks: prevB.hot_3clicks ?? null,
      reanimation: prevB.reanimation ?? null,
      payers_12m: rfmByDir[dir.id]?.users ?? prevB.payers_12m ?? null,
    });
    if (enkodBases && enkodBases[dir.id] != null) sources.enkod_base = sources.enkod_base || 'ok';
    if (sb) sources.salebot = sources.salebot || 'ok';
    else sources.base = sources.base || 'carry';
  }

  const leadingData = {
    from: bounds.from,
    to: bounds.to,
    unmatched_email: enkodEmail?.unmatched != null ? enkodEmail.unmatched : (prevLeading?.data?.unmatched_email ?? null),
    unsub_cabinet: enkodEmail?.unsub != null ? enkodEmail.unsub : (prevLeading?.data?.unsub_cabinet ?? null),
    rows: leadingRows.map(({ _edpro, ...row }) => row),
  };
  const baseData = { asOf, rows: baseRows };
  const rfmData = {
    asOf,
    segmentOrder: RFM_SEGMENTS,
    byDirection: rfmByDir,
  };

  const metaCommon = {
    asOf,
    runMode: opts.runMode || 'light',
    sources: { ...sources },
    note: 'EdproBiz + Salebot TG/VK + enKod email. MAX/sent мессенджеров и email active/cold/hot — carry. Daily=light, heavy=вс/webhook mode=heavy.',
  };

  const leadingEnv = buildEnvelope('crm.leading', ym, leadingData, metaCommon);
  const baseEnv = buildEnvelope('crm.base', ym, baseData, metaCommon);
  const rfmEnv = buildEnvelope('crm.rfm', ym, rfmData, metaCommon);

  return { ym, bounds, leadingEnv, baseEnv, rfmEnv, leadingRows };
}

function upsertManifest(periodsPatch, datasetId, relPath, period, envelope) {
  const prev = periodsPatch[datasetId];
  const entry = {
    fetchedAt: envelope.fetchedAt,
    checksum: envelope.checksum,
    file: `${relPath}/${period}.json`,
    changed: true,
    source: 'n8n-crm-leading',
  };
  if (prev?.periods) {
    periodsPatch[datasetId] = {
      path: relPath,
      coverage: prev.coverage,
      periods: { ...prev.periods, [period]: entry },
    };
  } else {
    periodsPatch[datasetId] = {
      path: relPath,
      coverage: { from: period, to: period, count: 1 },
      periods: { [period]: entry },
    };
  }
  const keys = Object.keys(periodsPatch[datasetId].periods).sort();
  periodsPatch[datasetId].coverage = {
    from: keys[0],
    to: keys[keys.length - 1],
    count: keys.length,
  };
}

// ---- main ----
if (!EDPROBIZ_MCP_TOKEN || EDPROBIZ_MCP_TOKEN.startsWith('REPLACE_')) {
  throw new Error('Set EDPROBIZ_MCP_TOKEN in Code node');
}

const runMode = resolveRunMode();
const isHeavy = runMode === 'heavy';
const asOf = moscowDateString();
const curYm = ymOf(asOf);
const months = [prevYm(curYm), curYm];
const sources = {
  edprobiz: 'pending', channels: null, base: null, rfm: null,
  salebot: null, enkod: null, enkod_base: null, runMode,
};

await mcpInit.call(this);

let salebotBases = null;
let salebotCachePayload = null;
try {
  if (isHeavy) {
    // Полный Salebot scan (~10–15 мин) не влезает в n8n task timeout 300s.
    // Heavy Salebot: scripts/crm_heavy_refresh.py (вне Code node).
    const sb = await fetchSalebotBases.call(this, { forceScan: false });
    sources.salebot = sb.status === 'skip:no-cache'
      ? 'skip:use-external-heavy'
      : `${sb.status}+heavy-n8n-no-scan`;
    if (sb.bases) salebotBases = sb.bases;
  } else {
    // light: только кэш (любой давности); без полного get_clients
    const sb = await fetchSalebotBases.call(this, { forceScan: false });
    sources.salebot = sb.status;
    if (sb.bases) salebotBases = sb.bases;
  }
} catch (e) {
  sources.salebot = `fail:${String(e.message || e).slice(0, 120)}`;
}

let enkodNameCache = {};
const remoteNames = await fetchJson.call(this, `${DASHBOARD_BASE}/crm/_cache/enkod_message_names.json`);
if (remoteNames && typeof remoteNames === 'object') {
  enkodNameCache = remoteNames.names || remoteNames;
}

let enkodBases = null;
if (isHeavy) {
  try {
    const eb = await fetchEnkodEmailBases.call(this);
    sources.enkod_base = eb.status;
    if (eb.bases) enkodBases = eb.bases;
  } catch (e) {
    sources.enkod_base = `fail:${String(e.message || e).slice(0, 120)}`;
  }
} else {
  sources.enkod_base = 'carry';
}

const nameFetchLimit = isHeavy ? ENKOD_NAME_FETCH_LIMIT_HEAVY : ENKOD_NAME_FETCH_LIMIT_LIGHT;
let nameBudget = nameFetchLimit;
const enkodByMonth = {};
for (const ym of months) {
  const bounds = monthBounds(ym, asOf);
  try {
    const em = await fetchEnkodEmailMetrics.call(this, bounds.from, bounds.to, enkodNameCache, {
      maxNameFetch: nameBudget,
    });
    enkodNameCache = em.nameCache || enkodNameCache;
    nameBudget = Math.max(0, nameBudget - (em.namesFetched || 0));
    enkodByMonth[ym] = em;
    sources.enkod = em.status;
  } catch (e) {
    sources.enkod = `fail:${String(e.message || e).slice(0, 120)}`;
    enkodByMonth[ym] = null;
  }
}

const files = {};
const manifestCrmDatasets = {};
const remoteManifest = await fetchJson.call(this, `${DASHBOARD_BASE}/manifest.json`);
if (remoteManifest?.datasets) {
  for (const id of ['crm.leading', 'crm.base', 'crm.rfm']) {
    if (remoteManifest.datasets[id]) {
      manifestCrmDatasets[id] = JSON.parse(JSON.stringify(remoteManifest.datasets[id]));
    }
  }
}

const summaries = [];
for (const ym of months) {
  const computeRfm = !(RFM_ONLY_CURRENT_MONTH && ym !== curYm);
  const built = await buildMonth.call(this, ym, asOf, sources, {
    computeRfm,
    salebotBases,
    enkodEmail: enkodByMonth[ym],
    enkodBases,
    runMode,
  });
  files[`crm/leading/${ym}.json`] = built.leadingEnv;
  files[`crm/base/${ym}.json`] = built.baseEnv;
  files[`crm/rfm/${ym}.json`] = built.rfmEnv;
  upsertManifest(manifestCrmDatasets, 'crm.leading', 'crm/leading', ym, built.leadingEnv);
  upsertManifest(manifestCrmDatasets, 'crm.base', 'crm/base', ym, built.baseEnv);
  upsertManifest(manifestCrmDatasets, 'crm.rfm', 'crm/rfm', ym, built.rfmEnv);
  summaries.push({
    ym,
    from: built.bounds.from,
    to: built.bounds.to,
    leads: built.leadingRows.reduce((s, r) => s + (r.leads_orders || 0), 0),
    paidUsers: built.leadingRows.reduce((s, r) => s + (r.paid_users || 0), 0),
    enkodUnmatched: enkodByMonth[ym]?.unmatched ?? null,
    enkodNamesFetched: enkodByMonth[ym]?.namesFetched ?? null,
    enkodNamesDeferred: enkodByMonth[ym]?.namesDeferred ?? null,
  });
  await sleep(200);
}

if (salebotCachePayload) {
  files['crm/_cache/salebot_base.json'] = salebotCachePayload;
}
files['crm/_cache/enkod_message_names.json'] = {
  asOf,
  fetchedAt: new Date().toISOString(),
  count: Object.keys(enkodNameCache).length,
  names: enkodNameCache,
};

const ingestBody = {
  asOf,
  runMode,
  generatedAt: new Date().toISOString(),
  files,
  manifestCrmDatasets,
  summary: { asOf, runMode, months: summaries, sources },
};

return [{ json: ingestBody }];
