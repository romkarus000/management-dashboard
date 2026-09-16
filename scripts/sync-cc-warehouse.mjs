#!/usr/bin/env node
/**
 * Sync call-center KPIs into warehouse/cc/kpis/{YYYY-MM}.json
 * via mcp_cc_qualification_rate + mcp_cc_sla_first_call.
 *
 * Env:
 *   MCP_EDPROBIZ_URL   default http://127.0.0.1:3120
 *   MCP_EDPROBIZ_TOKEN Bearer token (or MCP_TOKEN_CURSOR_MARAT from tool_mcp_edprobiz/.env)
 *
 * Usage:
 *   node scripts/sync-cc-warehouse.mjs --from=2026-08 --to=2026-09 --companies=0,3
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'warehouse', 'cc', 'kpis');
const MANIFEST_PATH = join(ROOT, 'warehouse', 'manifest.json');

function parseArgs(argv) {
  const out = { from: null, to: null, companies: [0, 3] };
  for (const a of argv) {
    if (a.startsWith('--from=')) out.from = a.slice(7);
    else if (a.startsWith('--to=')) out.to = a.slice(5);
    else if (a.startsWith('--companies=')) {
      out.companies = a
        .slice(12)
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n));
    }
  }
  return out;
}

function monthRange(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, '0');
  const from = `${y}-${mm}-01`;
  let toDay = last;
  const nowMsk = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }),
  );
  const curYm = `${nowMsk.getFullYear()}-${String(nowMsk.getMonth() + 1).padStart(2, '0')}`;
  if (ym === curYm) {
    toDay = Math.min(last, nowMsk.getDate());
  }
  const to = `${y}-${mm}-${String(toDay).padStart(2, '0')}`;
  return {
    from,
    to,
    capped_to_today: ym === curYm,
  };
}

function listMonths(fromYm, toYm) {
  const out = [];
  let [y, m] = fromYm.split('-').map(Number);
  const [ty, tm] = toYm.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function checksum(obj) {
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
}

async function loadToken() {
  if (process.env.MCP_EDPROBIZ_TOKEN) return process.env.MCP_EDPROBIZ_TOKEN.trim();
  if (process.env.MCP_TOKEN_CURSOR_MARAT) return process.env.MCP_TOKEN_CURSOR_MARAT.trim();
  const candidates = [
    join(ROOT, '..', 'n8n-corp', 'tool_mcp_edprobiz', '.env'),
    join(process.env.HOME || '', 'n8n-corp', 'tool_mcp_edprobiz', '.env'),
  ];
  for (const p of candidates) {
    try {
      const text = await readFile(p, 'utf8');
      const line = text.split('\n').find((l) => l.startsWith('MCP_TOKEN_CURSOR_MARAT='));
      if (line) return line.slice('MCP_TOKEN_CURSOR_MARAT='.length).trim();
    } catch {
      /* next */
    }
  }
  throw new Error('Нет MCP_EDPROBIZ_TOKEN / MCP_TOKEN_CURSOR_MARAT');
}

class McpClient {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.session = null;
  }

  async init() {
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'sync-cc-warehouse', version: '1.0' },
        },
      }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (!sid) throw new Error('MCP initialize: нет mcp-session-id');
    this.session = sid;
    await res.text();
  }

  async call(name, args) {
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${this.token}`,
        'mcp-session-id': this.session,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const text = await res.text();
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const outer = JSON.parse(t.slice(5).trim());
      const result = outer.result || {};
      const payload = (result.content || [{}])[0].text || '';
      if (result.isError) throw new Error(`${name}: ${payload.slice(0, 300)}`);
      const data = JSON.parse(payload);
      if (data.ok === false) throw new Error(`${name}: ${JSON.stringify(data).slice(0, 300)}`);
      return data;
    }
    throw new Error(`${name}: пустой SSE ответ`);
  }
}

async function fetchCompanyMonth(mcp, companyId, ym) {
  const range = monthRange(ym);
  const qual = await mcp.call('mcp_cc_qualification_rate', {
    date_from: range.from,
    date_to: range.to,
    company_id: companyId,
    mode: 'total',
  });
  const sla = await mcp.call('mcp_cc_sla_first_call', {
    date_from: range.from,
    date_to: range.to,
    company_id: companyId,
    mode: 'total',
  });
  return {
    cc_touched: Number(qual.cc_touched ?? 0),
    cc_qualified_same_month: Number(qual.cc_qualified_same_month ?? 0),
    qualification_rate:
      qual.qualification_rate == null ? null : Number(qual.qualification_rate),
    sla_first_call_avg_min:
      sla.avg_minutes == null ? null : Number(sla.avg_minutes),
    sla_first_call_median_min:
      sla.median_minutes == null ? null : Number(sla.median_minutes),
    sla_orders_with_call: Number(sla.orders_with_sla ?? 0),
    sla_p70_min: sla.p70_minutes == null ? null : Number(sla.p70_minutes),
    sla_p90_min: sla.p90_minutes == null ? null : Number(sla.p90_minutes),
    sla_within_5min: Number(sla.within_5min ?? 0),
    sla_within_15min: Number(sla.within_15min ?? 0),
    sla_within_1h: Number(sla.within_1h ?? 0),
    sla_src_order: Number(sla.src_order ?? 0),
    sla_src_user: Number(sla.src_user ?? 0),
    sla_src_unbound: Number(sla.src_unbound ?? 0),
    dial_rate: null,
    qual_period: {
      from: range.from,
      to: range.to,
      capped_to_today: range.capped_to_today,
    },
    sla_period: {
      from: range.from,
      to: range.to,
      capped_to_today: range.capped_to_today,
    },
  };
}

async function writePeriod(ym, byCompany) {
  const fetchedAt = new Date().toISOString();
  const data = { byCompany };
  const envelope = {
    warehouseVersion: '2.0',
    dataset: 'cc.kpis',
    period: ym,
    fetchedAt,
    checksum: '',
    filters: { periodType: 'month', period: ym },
    meta: {
      source: 'mcp_cc_qualification_rate + mcp_cc_sla_first_call',
      canon: 'docs/cc-warehouse-contract.md',
      funnel_version: 'v2',
      was_in_cc_value: 'Да',
      qualified_cc_value: 'Да',
      first_touch_attr: 'cc_sla_first_touch_at',
      qualification_date_attr: 'cc_qualification_date',
      sla_cc_department_id: 47,
      sla_work_hours: '09:00–20:00',
      sla_exclude: 'returned_from_op + заявки вне 09:00–20:00',
    },
    data,
  };
  envelope.checksum = checksum({ period: ym, data });
  await mkdir(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${ym}.json`);
  await writeFile(file, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  return { file: `cc/kpis/${ym}.json`, checksum: envelope.checksum, fetchedAt };
}

async function updateManifest(periodMeta) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch {
    manifest = { warehouseVersion: '2.0', datasets: {} };
  }
  if (!manifest.datasets) manifest.datasets = {};
  const periods = {};
  for (const [ym, meta] of Object.entries(periodMeta)) {
    periods[ym] = {
      fetchedAt: meta.fetchedAt,
      checksum: meta.checksum,
      file: meta.file,
      changed: true,
      durationMs: meta.durationMs ?? null,
      source: 'sync-cc-warehouse.mjs',
    };
  }
  const prev = manifest.datasets['cc.kpis']?.periods || {};
  const merged = { ...prev, ...periods };
  const keys = Object.keys(merged).sort();
  manifest.datasets['cc.kpis'] = {
    path: 'cc/kpis',
    coverage: {
      from: keys[0] || null,
      to: keys[keys.length - 1] || null,
      count: keys.length,
    },
    periods: merged,
  };
  manifest.updatedAt = new Date().toISOString();
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nowMsk = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }),
  );
  const defaultYm = `${nowMsk.getFullYear()}-${String(nowMsk.getMonth() + 1).padStart(2, '0')}`;
  const from = args.from || defaultYm;
  const to = args.to || from;
  const months = listMonths(from, to);
  const companies = args.companies.length ? args.companies : [0, 3];

  const baseUrl = process.env.MCP_EDPROBIZ_URL || 'http://127.0.0.1:3120';
  const token = await loadToken();
  const mcp = new McpClient(baseUrl, token);
  await mcp.init();
  console.log(`MCP ${baseUrl} · months ${months.join(', ')} · companies ${companies.join(',')}`);

  const periodMeta = {};
  for (const ym of months) {
    const t0 = Date.now();
    const byCompany = {};
    for (const cid of companies) {
      process.stdout.write(`  ${ym} company=${cid}… `);
      byCompany[String(cid)] = await fetchCompanyMonth(mcp, cid, ym);
      const row = byCompany[String(cid)];
      console.log(
        `touched=${row.cc_touched} qual=${row.cc_qualified_same_month} rate=${
          row.qualification_rate == null
            ? '—'
            : (row.qualification_rate * 100).toFixed(2) + '%'
        } sla_avg=${row.sla_first_call_avg_min ?? '—'}m med=${row.sla_first_call_median_min ?? '—'}m (${row.qual_period.from}…${row.qual_period.to})`,
      );
    }
    const meta = await writePeriod(ym, byCompany);
    meta.durationMs = Date.now() - t0;
    periodMeta[ym] = meta;
    console.log(`→ ${meta.file} (${meta.durationMs}ms)`);
  }
  await updateManifest(periodMeta);
  console.log('manifest updated');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
