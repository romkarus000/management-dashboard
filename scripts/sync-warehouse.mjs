#!/usr/bin/env node
/**
 * Sync warehouse v2: датасеты по папкам (см. docs/warehouse-v2-contract.md).
 *
 * Usage:
 *   node scripts/sync-warehouse.mjs --mode=mass --tabs=main,owner,activity --from=2021-01 --to=2026-08
 *   node scripts/sync-warehouse.mjs --mode=refresh --tabs=all --include-previous
 *   node scripts/sync-warehouse.mjs --tabs=activity-drill --drill-types=manual_human --months=2026-08
 *
 * Env:
 *   MGMT_REPORT_API_TOKEN   Bearer token (обязателен)
 *   MGMT_REPORT_API_BASE    default https://biz.edpro.ru/api/v1/management-report
 *   MGMT_SYNC_DELAY_MS      пауза между запросами (default 8000)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WAREHOUSE_DIR = path.join(REPO_ROOT, 'warehouse');
const MANIFEST_PATH = path.join(WAREHOUSE_DIR, 'manifest.json');

const DEFAULT_API_BASE = 'https://biz.edpro.ru/api/v1/management-report';
const DEFAULT_FROM = '2021-01';
const DEFAULT_DELAY_MS = 8000;
const WAREHOUSE_VERSION = '2.0';

/** Summary-датасеты (вкладки дашборда). */
const SUMMARY_DATASETS = {
    'main.profit': {
        path: 'main/profit',
        reportType: 'main',
        section: 'profit',
        tab: 'main',
    },
    'owner.marketing': {
        path: 'owner/marketing',
        reportType: 'owner',
        section: 'companyMarketing',
        tab: 'owner',
    },
    'activity.summary': {
        path: 'activity/summary',
        reportType: 'owner',
        section: 'partnerActivity',
        tab: 'activity',
    },
};

/** Корзины drill (activity.drill.{type}). */
const DEFAULT_DRILL_TYPES = [
    'total',
    'manual',
    'purchase',
    'registration',
    'hybrid',
    'adv',
    'club',
    'partner_registration',
    'product_education',
    'overlap',
    'manual_ambassador',
    'manual_barter_influence',
    'manual_cross_marketing',
    'manual_barter_solo',
    'manual_coach',
    'manual_human',
];

/**
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
    const out = {};
    for (const arg of argv) {
        if (!arg.startsWith('--')) {
            continue;
        }
        const eq = arg.indexOf('=');
        if (eq === -1) {
            out[arg.slice(2)] = true;
            continue;
        }
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
    return out;
}

/**
 * @param {string} ym YYYY-MM
 * @returns {{year: number, month: number}}
 */
function parseYm(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(ym);
    if (!m) {
        throw new Error(`Неверный месяц: ${ym} (ожидается YYYY-MM)`);
    }
    const year = Number(m[1]);
    const month = Number(m[2]);
    if (month < 1 || month > 12) {
        throw new Error(`Неверный месяц: ${ym}`);
    }
    return { year, month };
}

/**
 * @param {number} year
 * @param {number} month
 * @returns {string}
 */
function formatYm(year, month) {
    return `${year}-${String(month).padStart(2, '0')}`;
}

/**
 * @param {string} fromYm
 * @param {string} toYm
 * @returns {string[]}
 */
function listMonths(fromYm, toYm) {
    const from = parseYm(fromYm);
    const to = parseYm(toYm);
    const out = [];
    let y = from.year;
    let m = from.month;
    while (y < to.year || (y === to.year && m <= to.month)) {
        out.push(formatYm(y, m));
        m += 1;
        if (m > 12) {
            m = 1;
            y += 1;
        }
    }
    return out;
}

/**
 * @returns {string}
 */
function currentMonthYm() {
    const now = new Date();
    return formatYm(now.getFullYear(), now.getMonth() + 1);
}

/**
 * @param {unknown} data
 * @returns {string}
 */
function checksumData(data) {
    return crypto.createHash('sha256').update(JSON.stringify(data ?? null)).digest('hex').slice(0, 16);
}

/**
 * @param {string} tabsArg
 * @returns {{summaryIds: string[], drill: boolean}}
 */
function resolveTabs(tabsArg) {
    const raw = String(tabsArg || 'all')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    let drill = false;
    const summaryIds = [];

    for (const tab of raw) {
        if (tab === 'all') {
            summaryIds.push(...Object.keys(SUMMARY_DATASETS));
            continue;
        }
        if (tab === 'activity-drill') {
            drill = true;
            continue;
        }
        const match = Object.entries(SUMMARY_DATASETS).find(([, meta]) => meta.tab === tab);
        if (!match) {
            throw new Error(
                `Неизвестный tab: ${tab}. Допустимо: main,owner,activity,activity-drill,all`
            );
        }
        summaryIds.push(match[0]);
    }

    return {
        summaryIds: [...new Set(summaryIds)],
        drill,
    };
}

/**
 * @param {string|boolean|undefined} arg
 * @returns {string[]}
 */
function resolveDrillTypes(arg) {
    if (!arg || arg === true) {
        return DEFAULT_DRILL_TYPES.slice();
    }
    return String(arg)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * @returns {object}
 */
function loadManifest() {
    if (!fs.existsSync(MANIFEST_PATH)) {
        return emptyManifest();
    }
    const raw = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    return normalizeManifest(raw);
}

/**
 * @returns {object}
 */
function emptyManifest() {
    return {
        version: '2.0',
        schemaVersion: '2.0',
        warehouseVersion: WAREHOUSE_VERSION,
        generatedAt: null,
        coverage: { from: null, to: null, count: 0 },
        datasets: {},
        lastRun: null,
    };
}

/**
 * Поднимает legacy manifest (periods{}) до datasets.
 *
 * @param {object} raw
 * @returns {object}
 */
function normalizeManifest(raw) {
    if (raw && raw.datasets && raw.warehouseVersion === '2.0') {
        return raw;
    }
    const next = emptyManifest();
    next.generatedAt = raw?.generatedAt || null;
    next.lastRun = raw?.lastRun || null;
    // coverage пересчитаем позже
    return next;
}

/**
 * @param {object} manifest
 * @param {string} datasetId
 * @param {string} relPath
 * @returns {object}
 */
function ensureDataset(manifest, datasetId, relPath) {
    if (!manifest.datasets[datasetId]) {
        manifest.datasets[datasetId] = {
            path: relPath,
            coverage: { from: null, to: null, count: 0 },
            periods: {},
        };
    }
    return manifest.datasets[datasetId];
}

/**
 * @param {object} dataset
 * @returns {void}
 */
function recomputeDatasetCoverage(dataset) {
    const keys = Object.keys(dataset.periods || {}).sort();
    dataset.coverage = {
        from: keys[0] || null,
        to: keys[keys.length - 1] || null,
        count: keys.length,
    };
}

/**
 * Корневой coverage = объединение summary-датасетов.
 *
 * @param {object} manifest
 * @returns {void}
 */
function recomputeRootCoverage(manifest) {
    const set = new Set();
    for (const id of Object.keys(SUMMARY_DATASETS)) {
        const ds = manifest.datasets[id];
        if (!ds?.periods) {
            continue;
        }
        Object.keys(ds.periods).forEach((ym) => set.add(ym));
    }
    const keys = [...set].sort();
    manifest.coverage = {
        from: keys[0] || null,
        to: keys[keys.length - 1] || null,
        count: keys.length,
    };
}

/**
 * @param {object} manifest
 * @returns {void}
 */
function saveManifest(manifest) {
    fs.mkdirSync(WAREHOUSE_DIR, { recursive: true });
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * @param {string} relDir
 * @param {string} ym
 * @returns {string}
 */
function datasetFileAbs(relDir, ym) {
    return path.join(WAREHOUSE_DIR, relDir, `${ym}.json`);
}

/**
 * @param {object} envelope
 * @param {string} absPath
 * @returns {void}
 */
function writeDatasetFile(envelope, absPath) {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
}

/**
 * @param {string} absPath
 * @returns {object|null}
 */
function readJsonIfExists(absPath) {
    if (!fs.existsSync(absPath)) {
        return null;
    }
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

/**
 * @param {string} datasetId
 * @param {string} periodYm
 * @param {number} companyId
 * @param {object} data
 * @param {object|null} meta
 * @param {object} [extra]
 * @returns {object}
 */
function buildEnvelope(datasetId, periodYm, companyId, data, meta, extra = {}) {
    return {
        warehouseVersion: WAREHOUSE_VERSION,
        dataset: datasetId,
        period: periodYm,
        fetchedAt: new Date().toISOString(),
        checksum: checksumData(data),
        filters: {
            periodType: 'month',
            period: periodYm,
            compareMode: 'previous',
            companyId,
        },
        meta: meta || null,
        data,
        ...extra,
    };
}

/**
 * @param {string} apiBase
 * @param {string} token
 * @returns {Promise<object>}
 */
async function fetchFilters(apiBase, token) {
    const url = `${apiBase.replace(/\/$/, '')}/filters`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json, */*;q=0.8',
        },
    });
    const body = await response.json();
    if (!body.success) {
        throw new Error(body.data?.error || `filters HTTP ${response.status}`);
    }
    return body.data;
}

/**
 * @param {string} apiBase
 * @param {string} token
 * @param {string} periodYm
 * @param {number} companyId
 * @param {{reportType: string, section: string}} spec
 * @returns {Promise<{block: object, meta: object|null}>}
 */
async function fetchSummarySection(apiBase, token, periodYm, companyId, spec) {
    const base = apiBase.replace(/\/$/, '');
    const params = new URLSearchParams({
        periodType: 'month',
        period: periodYm,
        compareMode: 'previous',
        companyId: String(companyId),
        reportType: spec.reportType,
        section: spec.section,
    });
    const url = `${base}/query?${params.toString()}`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json, */*;q=0.8',
        },
    });
    const body = await response.json();
    if (!body.success) {
        throw new Error(String(body.data?.error || body.data?.code || `HTTP ${response.status}`));
    }
    if (body.data?.code) {
        throw new Error(`${body.data.code}: ${body.data.error || 'report failed'}`);
    }
    const data = body.data;
    const block = data.block || data.data || null;
    if (!block) {
        throw new Error(`Пустой block для ${spec.reportType}/${spec.section}`);
    }
    return { block, meta: data.meta || null };
}

/**
 * Delta одной метрики — та же семантика, что ManagementReportMapper::buildMetricDelta.
 *
 * @param {number} current
 * @param {number|null|undefined} previous
 * @returns {{absolute: number, percent: number|null, meaningful: boolean, isNew: boolean}}
 */
function buildMetricDelta(current, previous) {
    if (previous === null || previous === undefined) {
        return {
            absolute: current,
            percent: null,
            meaningful: false,
            isNew: true,
        };
    }
    const absolute = current - previous;
    const sameSign = current >= 0 === previous >= 0;
    const meaningful = previous > 0 && sameSign;
    const percent = meaningful ? Math.round((absolute / Math.abs(previous)) * 10000) / 100 : null;
    return {
        absolute: Math.round(absolute * 10000) / 10000,
        percent,
        meaningful,
        isNew: false,
    };
}

/**
 * KPI drill: totals / previous / delta.
 * До миграции бэка totals суммируем из partners; previous без бэка — null.
 *
 * @param {object} payload
 * @returns {object}
 */
function ensureDrillTotals(payload) {
    const next = { ...payload };
    if (!next.type && next.filter?.type) {
        next.type = next.filter.type;
    }
    if (!next.totals) {
        let reg = 0;
        let revenue = 0;
        for (const row of next.partners || []) {
            reg += Number(row.reg_count) || 0;
            revenue += Number(row.revenue) || 0;
        }
        next.totals = {
            reg_count: reg,
            revenue: Math.round(revenue * 100) / 100,
        };
    }
    if (!next.previous) {
        next.previous = { reg_count: null, revenue: null };
    }
    if (!next.delta) {
        const prevReg = next.previous.reg_count;
        const prevRev = next.previous.revenue;
        next.delta = {
            reg_count: buildMetricDelta(Number(next.totals.reg_count) || 0, prevReg),
            revenue: buildMetricDelta(Number(next.totals.revenue) || 0, prevRev),
        };
    }
    return next;
}

/**
 * @param {string} apiBase
 * @param {string} token
 * @param {string} periodYm
 * @param {number} companyId
 * @param {string} type
 * @returns {Promise<object>}
 */
async function fetchDrill(apiBase, token, periodYm, companyId, type) {
    const base = apiBase.replace(/\/$/, '');
    const params = new URLSearchParams({
        type,
        periodType: 'month',
        period: periodYm,
        companyId: String(companyId),
        compareMode: 'previous',
    });
    const url = `${base}/partner-activity/drill?${params.toString()}`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json, */*;q=0.8',
        },
    });
    const body = await response.json();
    if (!body.success) {
        throw new Error(String(body.data?.error || body.data?.code || `HTTP ${response.status}`));
    }
    if (body.data?.code) {
        throw new Error(`${body.data.code}: ${body.data.error || 'drill failed'}`);
    }
    return ensureDrillTotals(body.data);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} args
 * @returns {string[]}
 */
function resolveMonths(args) {
    const mode = String(args.mode || 'refresh');
    if (args.months) {
        return String(args.months).split(',').map((s) => s.trim()).filter(Boolean);
    }
    if (mode === 'mass') {
        const from = String(args.from || DEFAULT_FROM);
        const to = String(args.to || currentMonthYm());
        return listMonths(from, to);
    }
    const months = [currentMonthYm()];
    if (args['include-previous']) {
        const cur = parseYm(months[0]);
        const prevMonth = cur.month === 1 ? 12 : cur.month - 1;
        const prevYear = cur.month === 1 ? cur.year - 1 : cur.year;
        months.unshift(formatYm(prevYear, prevMonth));
    }
    return months;
}

/**
 * @param {object} manifest
 * @param {string} datasetId
 * @param {string} relDir
 * @param {string} ym
 * @param {object} envelope
 * @param {number} durationMs
 * @returns {boolean} changed
 */
function commitDatasetPeriod(manifest, datasetId, relDir, ym, envelope, durationMs) {
    const ds = ensureDataset(manifest, datasetId, relDir);
    const abs = datasetFileAbs(relDir, ym);
    const existing = readJsonIfExists(abs);
    const prevChecksum = existing?.checksum || ds.periods[ym]?.checksum;
    const wasChanged = prevChecksum !== envelope.checksum;

    writeDatasetFile(envelope, abs);

    ds.periods[ym] = {
        fetchedAt: envelope.fetchedAt,
        checksum: envelope.checksum,
        file: `${relDir}/${ym}.json`,
        changed: wasChanged,
        durationMs,
    };
    recomputeDatasetCoverage(ds);
    return wasChanged;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h) {
        console.log(`Usage:
  node scripts/sync-warehouse.mjs --mode=mass --tabs=main,owner,activity --from=2021-01 --to=2026-08
  node scripts/sync-warehouse.mjs --mode=refresh --tabs=all --include-previous
  node scripts/sync-warehouse.mjs --tabs=activity-drill --drill-types=manual_human --months=2026-08

Tabs: main | owner | activity | activity-drill | all
Env: MGMT_REPORT_API_TOKEN, MGMT_REPORT_API_BASE, MGMT_SYNC_DELAY_MS
Contract: docs/warehouse-v2-contract.md`);
        process.exit(0);
    }

    const token = process.env.MGMT_REPORT_API_TOKEN || String(args.token || '');
    if (!token) {
        console.error('Нужен MGMT_REPORT_API_TOKEN или --token=...');
        process.exit(1);
    }

    const apiBase = process.env.MGMT_REPORT_API_BASE || String(args['api-base'] || DEFAULT_API_BASE);
    const delayMs = Number(process.env.MGMT_SYNC_DELAY_MS || args.delay || DEFAULT_DELAY_MS);
    const companyId = Number(args.companyId || 0);
    const mode = String(args.mode || 'refresh');
    const { summaryIds, drill } = resolveTabs(args.tabs);
    const drillTypes = drill ? resolveDrillTypes(args['drill-types']) : [];
    const months = resolveMonths(args);

    if (months.length === 0) {
        console.error('Список месяцев пуст');
        process.exit(1);
    }
    if (summaryIds.length === 0 && !drill) {
        console.error('Не выбраны tabs');
        process.exit(1);
    }

    const manifest = loadManifest();
    const failed = [];
    let ok = 0;
    let changed = 0;
    let requestIndex = 0;

    const jobs = [];
    for (const ym of months) {
        for (const datasetId of summaryIds) {
            jobs.push({ kind: 'summary', ym, datasetId });
        }
        for (const type of drillTypes) {
            jobs.push({ kind: 'drill', ym, type });
        }
    }

    console.log(
        `mode=${mode} summary=${summaryIds.join(',') || '—'} ` +
        `drill=${drill ? drillTypes.join(',') : '—'} ` +
        `jobs=${jobs.length} delayMs=${delayMs} api=${apiBase}`
    );

    try {
        process.stdout.write('filters … ');
        const catalog = await fetchFilters(apiBase, token);
        fs.writeFileSync(
            path.join(WAREHOUSE_DIR, 'filters.json'),
            JSON.stringify(catalog, null, 2) + '\n',
            'utf8'
        );
        console.log('ok');
    } catch (error) {
        console.log(`skip (${error.message || error})`);
    }

    for (let i = 0; i < jobs.length; i += 1) {
        const job = jobs[i];
        const started = Date.now();
        const label = job.kind === 'summary'
            ? `${job.ym} ${job.datasetId}`
            : `${job.ym} activity.drill.${job.type}`;
        process.stdout.write(`[${i + 1}/${jobs.length}] ${label} … `);

        try {
            if (job.kind === 'summary') {
                const spec = SUMMARY_DATASETS[job.datasetId];
                const { block, meta } = await fetchSummarySection(
                    apiBase,
                    token,
                    job.ym,
                    companyId,
                    spec
                );
                const envelope = buildEnvelope(job.datasetId, job.ym, companyId, block, meta);
                const wasChanged = commitDatasetPeriod(
                    manifest,
                    job.datasetId,
                    spec.path,
                    job.ym,
                    envelope,
                    Date.now() - started
                );
                if (wasChanged) {
                    changed += 1;
                }
                ok += 1;
                console.log(
                    `ok checksum=${envelope.checksum}` +
                    `${wasChanged ? ' (changed)' : ''} ${Date.now() - started}ms`
                );
            } else {
                const datasetId = `activity.drill.${job.type}`;
                const relDir = `activity/drill/${job.type}`;
                const data = await fetchDrill(apiBase, token, job.ym, companyId, job.type);
                const envelope = buildEnvelope(datasetId, job.ym, companyId, data, data.meta || null, {
                    type: job.type,
                });
                const wasChanged = commitDatasetPeriod(
                    manifest,
                    datasetId,
                    relDir,
                    job.ym,
                    envelope,
                    Date.now() - started
                );
                if (wasChanged) {
                    changed += 1;
                }
                ok += 1;
                console.log(
                    `ok checksum=${envelope.checksum}` +
                    `${wasChanged ? ' (changed)' : ''} ${Date.now() - started}ms`
                );
            }
        } catch (error) {
            failed.push({ job: label, error: String(error.message || error) });
            console.log(`FAIL ${error.message || error}`);
        }

        requestIndex += 1;
        if (i < jobs.length - 1 && delayMs > 0) {
            await sleep(delayMs);
        }
    }

    recomputeRootCoverage(manifest);
    manifest.warehouseVersion = WAREHOUSE_VERSION;
    manifest.version = '2.0';
    manifest.schemaVersion = '2.0';
    manifest.generatedAt = new Date().toISOString();
    manifest.lastRun = {
        mode,
        tabs: String(args.tabs || 'all').split(',').map((s) => s.trim()).filter(Boolean),
        at: manifest.generatedAt,
        ok,
        failed,
        changed,
        jobsRequested: jobs.length,
        requests: requestIndex,
    };
    // убрать legacy ключ periods если был
    if (manifest.periods) {
        delete manifest.periods;
    }
    saveManifest(manifest);

    console.log(`\nDone. ok=${ok} failed=${failed.length} changed=${changed}`);
    console.log(`manifest: ${MANIFEST_PATH}`);
    if (failed.length) {
        process.exit(2);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
