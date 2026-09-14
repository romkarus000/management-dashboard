#!/usr/bin/env node
/**
 * Sync sales KPIs (C2 / ср.чек / квал.лиды) into warehouse/sales/kpis/{YYYY-MM}.json
 * via mcp_segment_orders + mcp_sales_qual_leads_per_mop.
 *
 * Env:
 *   MCP_EDPROBIZ_URL   default http://127.0.0.1:3120
 *   MCP_EDPROBIZ_TOKEN Bearer token (or MCP_TOKEN_CURSOR_MARAT from tool_mcp_edprobiz/.env)
 *
 * Usage:
 *   node scripts/sync-sales-warehouse.mjs --from=2026-07 --to=2026-08 --companies=0,3
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'warehouse', 'sales', 'kpis');
const MANIFEST_PATH = join(ROOT, 'warehouse', 'manifest.json');

/** Академия ОП без КЦ — канон sales-c2-contract. */
const ACADEMY_OP_DEPARTMENT_IDS = [5, 7, 9, 23, 25, 27];
const ACADEMY_COMPANY_ID = 3;

/**
 * Воронки funnel.version=v2 (по имени «V2»), без тестовой.
 * Discovery: mcp_funnel_list(search=v2, entity=order).
 */
const SALES_V2_FUNNEL_IDS = [257, 337, 339, 341, 343, 345, 347, 631];
const NDZ_SUBSTATUS = 'Клиент не берет телефон';
const NDZ_EXCLUDE_STAGE = 'В работе КЦ';
/** Причины отказа в «Закрыто…», которые считаем НДЗ. */
const NDZ_CLOSED_REASONS = ['Недозвон (НДЗ = 10)', 'Контакт не состоялся'];

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
  // Текущий месяц (МСК): среднее только до сегодняшнего числа.
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
    toPaid: `${to} 23:59:59`,
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
          clientInfo: { name: 'sync-sales-warehouse', version: '1.0' },
        },
      }),
    });
    const sid = res.headers.get('mcp-session-id');
    if (!sid) throw new Error('MCP initialize: нет mcp-session-id');
    this.session = sid;
    // drain body
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

function firstGroup(res) {
  const g = (res.groups || [])[0];
  return g || null;
}

/**
 * % недозвона (НДЗ) по снимку воронок V2.
 * Числитель:
 *   1) статус «Клиент не берет телефон» вне этапа «В работе КЦ»;
 *   2) этап «Закрыто…» + причина отказа из NDZ_CLOSED_REASONS
 *      («Недозвон (НДЗ = 10)» / «Контакт не состоялся»).
 * Знаменатель: все заказы в V2 за период входа, кроме этапа «В работе КЦ».
 * Период — funnel_entered; этап/статус/причина — текущий снимок.
 */
function computeNdzShare(funnelSummary) {
  const byStatus = funnelSummary?.by_status || [];
  let ndzOpen = 0;
  let ndzClosed = 0;
  let ndzOrdersInCc = 0;
  let baseOrders = 0;
  const closedByReason = Object.fromEntries(NDZ_CLOSED_REASONS.map((r) => [r, 0]));

  for (const row of byStatus) {
    const stage = row.status_name || row['Этап воронки'] || '';
    const stageCount = Number(row.orders_count) || 0;
    const isClosed = stage.includes('Закрыто');
    if (stage !== NDZ_EXCLUDE_STAGE) {
      baseOrders += stageCount;
    }
    for (const sub of row.substatuses || []) {
      const statusName = sub.funnel_substatus || sub['Статус воронки'] || '';
      const reason = sub.substatus || '';
      const c = Number(sub.orders_count) || 0;

      if (statusName === NDZ_SUBSTATUS) {
        if (stage === NDZ_EXCLUDE_STAGE) {
          ndzOrdersInCc += c;
        } else {
          ndzOpen += c;
        }
      }
      if (isClosed && NDZ_CLOSED_REASONS.includes(reason)) {
        ndzClosed += c;
        closedByReason[reason] = (closedByReason[reason] || 0) + c;
      }
    }
  }

  const ndzOrders = ndzOpen + ndzClosed;
  return {
    ndz_orders_open: ndzOpen,
    ndz_orders_closed: ndzClosed,
    ndz_orders_closed_by_reason: closedByReason,
    ndz_orders: ndzOrders,
    ndz_orders_in_cc: ndzOrdersInCc,
    ndz_base_orders: baseOrders,
    ndz_share: baseOrders > 0 ? ndzOrders / baseOrders : null,
  };
}

async function fetchCompanyMonth(mcp, companyId, ym, ndz = null) {
  const { from, to, toPaid, capped_to_today } = monthRange(ym);
  const companyArg = companyId === 0 ? {} : { company_id: companyId };
  const deptArg = { sales_department_ids: ACADEMY_OP_DEPARTMENT_IDS };

  const apps = await mcp.call('mcp_segment_orders', {
    date_from: from,
    date_to: toPaid,
    date_field: 'created',
    mode: 'summary',
    dimension: 'month',
    offer_categories: [15, 19, 45],
    application_match: 'offer_or_ads',
    ...companyArg,
  });
  const pays = await mcp.call('mcp_segment_orders', {
    date_from: from,
    date_to: toPaid,
    date_field: 'paid',
    mode: 'summary',
    dimension: 'month',
    offer_categories: [17, 29],
    status_id: 20,
    paid_only: true,
    ...companyArg,
  });
  const net = await mcp.call('mcp_segment_orders', {
    date_from: from,
    date_to: toPaid,
    mode: 'summary',
    dimension: 'month',
    with_payment_net: true,
    ...companyArg,
  });
  const qual = await mcp.call('mcp_sales_qual_leads_per_mop', {
    date_from: from,
    date_to: to,
    mode: 'total',
    ...companyArg,
    ...deptArg,
  });
  const sla = await mcp.call('mcp_sales_op_sla_first_call', {
    date_from: from,
    date_to: toPaid,
    ...companyArg,
  });

  const ag = firstGroup(apps);
  const pg = firstGroup(pays);
  const ng = firstGroup(net);
  const applications = ag ? Number(ag.orders_count) : 0;
  const applicationUsers = ag ? Number(ag.distinct_users) : 0;
  const payments = pg ? Number(pg.orders_count) : 0;
  const paymentUsers = pg ? Number(pg.distinct_users) : 0;
  // C2 по уникальным клиентам: иначе ~3 заявки/клиента занижают конверсию.
  const c2 = applicationUsers > 0 ? paymentUsers / applicationUsers : null;
  const avgCheck = ng && ng.avg_payment_net != null ? Number(ng.avg_payment_net) : null;
  const paymentNetSum = ng && ng.payment_net_sum != null ? Number(ng.payment_net_sum) : null;
  const completedPaid = ng && ng.completed_paid_count != null ? Number(ng.completed_paid_count) : null;

  return {
    company_id: companyId,
    applications,
    application_users: applicationUsers,
    payments,
    payment_users: paymentUsers,
    c2,
    payment_net_sum: paymentNetSum,
    completed_paid_count: completedPaid,
    avg_check: avgCheck,
    qualified_leads: Number(qual.qualified_leads ?? 0),
    mop_count: Number(qual.mop_count ?? 0),
    calendar_days: Number(qual.calendar_days ?? 0),
    mean_leads_per_mop:
      qual.mean_leads_per_mop == null ? null : Number(qual.mean_leads_per_mop),
    qual_leads_mop_day:
      qual.leads_per_mop_per_day == null ? null : Number(qual.leads_per_mop_per_day),
    sales_department_ids: qual.sales_department_ids ?? null,
    qual_period: { from, to, capped_to_today: !!capped_to_today },
    sla_first_call_hours:
      sla.avg_hours == null || !Number.isFinite(Number(sla.avg_hours))
        ? null
        : Number(sla.avg_hours),
    sla_first_call_minutes:
      sla.avg_minutes == null || !Number.isFinite(Number(sla.avg_minutes))
        ? null
        : Number(sla.avg_minutes),
    sla_orders_with_call: Number(sla.orders_with_sla ?? 0),
    // НДЗ пока без среза company_id (mcp_funnel_statistics не фильтрует по компании).
    ...(ndz || {
      ndz_orders_open: null,
      ndz_orders_closed: null,
      ndz_orders_closed_by_reason: null,
      ndz_orders: null,
      ndz_orders_in_cc: null,
      ndz_base_orders: null,
      ndz_share: null,
    }),
  };
}

async function fetchNdzForMonth(mcp, ym) {
  const { from, toPaid } = monthRange(ym);
  const summary = await mcp.call('mcp_funnel_statistics', {
    funnel_ids: SALES_V2_FUNNEL_IDS,
    date_from: from,
    date_to: toPaid,
    date_field: 'funnel_entered',
    mode: 'summary',
    channel: 'none',
  });
  if (!Array.isArray(summary?.by_status)) {
    throw new Error(
      `mcp_funnel_statistics: нет by_status для ${ym} (total=${summary?.total_orders ?? '—'})`,
    );
  }
  return computeNdzShare(summary);
}

async function writePeriod(ym, byCompany) {
  const fetchedAt = new Date().toISOString();
  const data = { byCompany };
  const envelope = {
    warehouseVersion: '2.0',
    dataset: 'sales.kpis',
    period: ym,
    fetchedAt,
    checksum: '',
    filters: { periodType: 'month', period: ym },
    meta: {
      source:
        'mcp_segment_orders + mcp_sales_qual_leads_per_mop + mcp_sales_op_sla_first_call + mcp_funnel_statistics',
      canon: 'tool_mcp_edprobiz/docs/sales-c2-contract.md',
      academy_op_department_ids: ACADEMY_OP_DEPARTMENT_IDS,
      sales_v2_funnel_ids: SALES_V2_FUNNEL_IDS,
      ndz_substatus: NDZ_SUBSTATUS,
      ndz_exclude_stage: NDZ_EXCLUDE_STAGE,
      ndz_closed_reasons: NDZ_CLOSED_REASONS,
    },
    data,
  };
  envelope.checksum = checksum({ period: ym, data });
  await mkdir(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${ym}.json`);
  await writeFile(file, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
  return { file: `sales/kpis/${ym}.json`, checksum: envelope.checksum, fetchedAt };
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
      source: 'sync-sales-warehouse.mjs',
    };
  }
  // merge with existing sales.kpis periods
  const prev = manifest.datasets['sales.kpis']?.periods || {};
  const merged = { ...prev, ...periods };
  const keys = Object.keys(merged).sort();
  manifest.datasets['sales.kpis'] = {
    path: 'sales/kpis',
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
  const now = new Date();
  const defaultYm = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
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
    process.stdout.write(`  ${ym} ndz… `);
    const ndz = await fetchNdzForMonth(mcp, ym);
    console.log(
      `share=${ndz.ndz_share == null ? '—' : (ndz.ndz_share * 100).toFixed(2) + '%'} (${ndz.ndz_orders}/${ndz.ndz_base_orders}; open=${ndz.ndz_orders_open} closed=${ndz.ndz_orders_closed} in_cc=${ndz.ndz_orders_in_cc})`,
    );
    for (const cid of companies) {
      process.stdout.write(`  ${ym} company=${cid}… `);
      byCompany[String(cid)] = await fetchCompanyMonth(mcp, cid, ym, ndz);
      console.log(
        `c2=${byCompany[String(cid)].c2?.toFixed?.(4) ?? '—'} avg=${byCompany[String(cid)].avg_check ?? '—'} qual=${byCompany[String(cid)].qual_leads_mop_day ?? '—'} sla_h=${byCompany[String(cid)].sla_first_call_hours ?? '—'} ndz=${byCompany[String(cid)].ndz_share == null ? '—' : (byCompany[String(cid)].ndz_share * 100).toFixed(2) + '%'}`,
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
