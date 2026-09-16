/**
 * n8n Code node: Bots Funnel → warehouse/bots/funnel → dashboard ingest
 * Keep in sync with docs/bots-warehouse-contract.md
 *
 * Ожидает три Postgres-ноды (по одной строке JSON-метрик):
 *   - Neon: pomogator_da
 *   - Neon: pomogator (СП)
 *   - Neon: pomogator_vr
 *
 * Секреты ingest: Authorization Bearer из HTTP-ноды / $env, не хранить в git.
 */

const WAREHOUSE_VERSION = '2.0';
const DATASET = 'bots.funnel';
const REL_PATH = 'bots/funnel';
const DASHBOARD_BASE = 'https://dashboard.edpro.ru/warehouse';

const BOT_SPECS = [
  { id: 'pomogator', label: 'Помогатор', schema: 'pomogator_da', node: 'Neon: pomogator_da' },
  { id: 'dostigator_sp', label: 'Достигатор на СП', schema: 'pomogator', node: 'Neon: pomogator' },
  { id: 'dostigator_vr', label: 'Достигатор на внешний рынок', schema: 'pomogator_vr', node: 'Neon: pomogator_vr' },
];

const FUNNEL_KEYS = ['entered', 'survey', 'goals_set', 'goals_achieved', 'completed'];

function moscowDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
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

function emptyFunnel() {
  const o = {};
  for (const k of FUNNEL_KEYS) o[k] = 0;
  return o;
}

function emptyBot(spec) {
  return {
    id: spec.id,
    label: spec.label,
    schema: spec.schema,
    participants_total: 0,
    participants_active: 0,
    participants_churned: 0,
    participants_completed: 0,
    funnel_active: emptyFunnel(),
    funnel_churned: emptyFunnel(),
    _error: null,
  };
}

function pickFunnel(raw) {
  const out = emptyFunnel();
  if (!raw || typeof raw !== 'object') return out;
  for (const k of FUNNEL_KEYS) {
    const n = Number(raw[k]);
    out[k] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

function normalizeBotRow(spec, row) {
  const base = emptyBot(spec);
  if (!row) {
    base._error = 'empty';
    return base;
  }
  if (row.message && row.error) {
    const msg = typeof row.message === 'string' ? row.message : JSON.stringify(row.message);
    base._error = msg.slice(0, 180);
    return base;
  }
  if (row.error) {
    base._error = typeof row.error === 'string' ? row.error : JSON.stringify(row.error).slice(0, 180);
    return base;
  }
  // Postgres может вернуть metrics как jsonb / string / развернутые колонки
  let src = row.metrics != null ? row.metrics : row;
  if (typeof src === 'string') {
    try {
      src = JSON.parse(src);
    } catch (e) {
      base._error = 'bad_metrics_json';
      return base;
    }
  }
  if (!src || typeof src !== 'object') {
    base._error = 'empty_metrics';
    return base;
  }
  return {
    id: spec.id,
    label: spec.label,
    schema: spec.schema,
    participants_total: Number(src.participants_total) || 0,
    participants_active: Number(src.participants_active) || 0,
    participants_churned: Number(src.participants_churned) || 0,
    participants_completed: Number(src.participants_completed) || 0,
    funnel_active: pickFunnel(src.funnel_active),
    funnel_churned: pickFunnel(src.funnel_churned),
    debug: src.debug || null,
    _error: src.error || null,
  };
}

function readNodeJson(nodeName) {
  try {
    const item = $(nodeName).first()?.json;
    return item || null;
  } catch (e) {
    return { error: `node_missing:${nodeName}` };
  }
}

async function fetchJson(url) {
  try {
    return await this.helpers.httpRequest({ method: 'GET', url, json: true });
  } catch (e) {
    return null;
  }
}

function buildEnvelope(period, data, meta = {}) {
  const fetchedAt = new Date().toISOString();
  return {
    warehouseVersion: WAREHOUSE_VERSION,
    dataset: DATASET,
    period,
    fetchedAt,
    checksum: checksumData(data),
    filters: {
      periodType: 'day',
      period,
      timezone: 'Europe/Moscow',
      churnDays: data.churnDays ?? 7,
    },
    meta: {
      source: 'n8n-bots-funnel',
      department: 'bots',
      generatedAt: fetchedAt,
      ...meta,
    },
    data,
  };
}

function upsertManifest(periodsPatch, period, envelope) {
  const entry = {
    fetchedAt: envelope.fetchedAt,
    checksum: envelope.checksum,
    file: `${REL_PATH}/${period}.json`,
    changed: true,
    source: 'n8n-bots-funnel',
  };
  const prev = periodsPatch[DATASET];
  if (prev?.periods) {
    periodsPatch[DATASET] = {
      path: REL_PATH,
      coverage: prev.coverage,
      periods: { ...prev.periods, [period]: entry },
    };
  } else {
    periodsPatch[DATASET] = {
      path: REL_PATH,
      coverage: { from: period, to: period, count: 1 },
      periods: { [period]: entry },
    };
  }
  const keys = Object.keys(periodsPatch[DATASET].periods).sort();
  periodsPatch[DATASET].coverage = {
    from: keys[0],
    to: keys[keys.length - 1],
    count: keys.length,
  };
}

// ---- main ----
const asOf = moscowDateString();
const churnDays = 7;

const bots = BOT_SPECS.map((spec) => normalizeBotRow(spec, readNodeJson(spec.node)));
const sources = {};
for (const b of bots) {
  sources[b.id] = b._error ? `fail:${b._error}` : 'ok';
  delete b._error;
}

const data = { asOf, churnDays, bots };
const envelope = buildEnvelope(asOf, data, { asOf, sources });

const files = {};
files[`${REL_PATH}/${asOf}.json`] = envelope;

const manifestBotsDatasets = {};
const remoteManifest = await fetchJson.call(this, `${DASHBOARD_BASE}/manifest.json`);
if (remoteManifest?.datasets?.[DATASET]) {
  manifestBotsDatasets[DATASET] = JSON.parse(JSON.stringify(remoteManifest.datasets[DATASET]));
}
upsertManifest(manifestBotsDatasets, asOf, envelope);

return [
  {
    json: {
      asOf,
      generatedAt: new Date().toISOString(),
      files,
      manifestBotsDatasets,
      summary: {
        asOf,
        bots: bots.map((b) => ({
          id: b.id,
          total: b.participants_total,
          active: b.participants_active,
          churned: b.participants_churned,
          completed: b.participants_completed,
        })),
        sources,
      },
    },
  },
];
