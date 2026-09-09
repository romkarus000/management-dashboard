#!/usr/bin/env node
/**
 * Sync warehouse: тянет management-report API по месяцам и пишет файлы + manifest.
 *
 * Usage:
 *   node scripts/sync-warehouse.mjs --mode=mass --from=2021-01 --to=2026-08
 *   node scripts/sync-warehouse.mjs --mode=refresh
 *   node scripts/sync-warehouse.mjs --mode=refresh --months=2026-07,2026-08,2026-09
 *
 * Env:
 *   MGMT_REPORT_API_TOKEN   Bearer token (обязателен)
 *   MGMT_REPORT_API_BASE    default https://biz.edpro.ru/api/v1/management-report
 *   MGMT_SYNC_DELAY_MS      пауза между месяцами (default 8000)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WAREHOUSE_DIR = path.join(REPO_ROOT, 'warehouse');
const PERIODS_DIR = path.join(WAREHOUSE_DIR, 'periods');
const MANIFEST_PATH = path.join(WAREHOUSE_DIR, 'manifest.json');

const DEFAULT_API_BASE = 'https://biz.edpro.ru/api/v1/management-report';
const DEFAULT_FROM = '2021-01';
const DEFAULT_DELAY_MS = 8000;

/** @type {Record<string, {mainSections: string, ownerSections: string}>} */
const TAB_QUERY = {
    activity: { mainSections: '', ownerSections: 'partnerActivity' },
    owner: { mainSections: '', ownerSections: 'companyMarketing' },
    main: { mainSections: 'profit', ownerSections: '' },
    all: {
        mainSections: 'profit',
        ownerSections: 'companyMarketing,partnerActivity',
    },
};

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
 * Текущий календарный месяц (MTD) в Europe/Moscow приблизительно через локаль сервера.
 *
 * @returns {string}
 */
function currentMonthYm() {
    const now = new Date();
    return formatYm(now.getFullYear(), now.getMonth() + 1);
}

/**
 * @param {object} payload
 * @returns {string}
 */
function checksumPayload(payload) {
    const blocks = payload?.blocks || {};
    const slice = {
        main: blocks.main?.profit?.summary?.current || null,
        owner: blocks.owner?.companyMarketing?.summary?.current || null,
        activity: blocks.owner?.partnerActivity?.summary?.current || null,
    };
    return crypto.createHash('sha256').update(JSON.stringify(slice)).digest('hex').slice(0, 16);
}

/**
 * @param {string} tabsArg
 * @returns {string[]}
 */
function resolveTabs(tabsArg) {
    const raw = String(tabsArg || 'all')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (raw.includes('all')) {
        return ['all'];
    }
    for (const tab of raw) {
        if (!TAB_QUERY[tab]) {
            throw new Error(`Неизвестный tab: ${tab}. Допустимо: activity,owner,main,all`);
        }
    }
    return raw;
}

/**
 * Собирает query params для набора вкладок.
 *
 * @param {string[]} tabs
 * @returns {{mainSections: string, ownerSections: string}}
 */
function buildSectionsForTabs(tabs) {
    if (tabs.length === 1 && tabs[0] === 'all') {
        return TAB_QUERY.all;
    }
    const main = [];
    const owner = [];
    for (const tab of tabs) {
        const q = TAB_QUERY[tab];
        if (q.mainSections) {
            main.push(...q.mainSections.split(',').filter(Boolean));
        }
        if (q.ownerSections) {
            owner.push(...q.ownerSections.split(',').filter(Boolean));
        }
    }
    return {
        mainSections: [...new Set(main)].join(','),
        ownerSections: [...new Set(owner)].join(','),
    };
}

/**
 * Мержит новый ответ API в уже сохранённый артефакт месяца.
 *
 * @param {object|null} existing
 * @param {object} payload
 * @param {string} periodYm
 * @param {number} companyId
 * @param {string[]} tabs
 * @returns {object}
 */
function mergeArtifact(existing, payload, periodYm, companyId, tabs) {
    const base = existing && existing.blocks
        ? existing
        : {
            warehouseVersion: '1.0',
            period: periodYm,
            filters: {
                periodType: 'month',
                period: periodYm,
                compareMode: 'previous',
                companyId,
            },
            blocks: { main: {}, owner: {} },
        };

    const nextBlocks = {
        main: { ...(base.blocks.main || {}) },
        owner: { ...(base.blocks.owner || {}) },
    };
    const incoming = payload.blocks || {};

    if (incoming.main?.profit) {
        nextBlocks.main.profit = incoming.main.profit;
    }
    if (incoming.owner?.companyMarketing) {
        nextBlocks.owner.companyMarketing = incoming.owner.companyMarketing;
    }
    if (incoming.owner?.partnerActivity) {
        nextBlocks.owner.partnerActivity = incoming.owner.partnerActivity;
    }

    const tabsDone = new Set([...(base.tabs || []), ...tabs.filter((t) => t !== 'all')]);
    if (tabs.includes('all')) {
        tabsDone.add('activity');
        tabsDone.add('owner');
        tabsDone.add('main');
    }

    return {
        warehouseVersion: '1.0',
        period: periodYm,
        fetchedAt: new Date().toISOString(),
        tabs: [...tabsDone].sort(),
        checksum: null,
        filters: {
            periodType: 'month',
            period: periodYm,
            compareMode: 'previous',
            companyId,
        },
        meta: payload.meta || base.meta || null,
        blocks: nextBlocks,
    };
}

/**
 * @returns {object}
 */
function loadManifest() {
    if (!fs.existsSync(MANIFEST_PATH)) {
        return {
            version: '1.0',
            schemaVersion: '2.0',
            generatedAt: null,
            coverage: { from: null, to: null },
            lastRun: null,
            periods: {},
        };
    }
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
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
 * @param {string[]} tabs
 * @returns {Promise<object>}
 */
async function fetchMonth(apiBase, token, periodYm, companyId, tabs) {
    const base = apiBase.replace(/\/$/, '');
    const common = {
        periodType: 'month',
        period: periodYm,
        compareMode: 'previous',
        companyId: String(companyId),
    };

    // Один tab → лёгкий /query (query-batch без mainSections всё равно подставит profit).
    if (tabs.length === 1 && tabs[0] !== 'all') {
        const tab = tabs[0];
        let reportType;
        let section;
        if (tab === 'activity') {
            reportType = 'owner';
            section = 'partnerActivity';
        } else if (tab === 'owner') {
            reportType = 'owner';
            section = 'companyMarketing';
        } else if (tab === 'main') {
            reportType = 'main';
            section = 'profit';
        } else {
            throw new Error(`Неизвестный tab: ${tab}`);
        }

        const params = new URLSearchParams({ ...common, reportType, section });
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
        const blocks = { main: {}, owner: {} };
        if (reportType === 'main') {
            blocks.main[section] = block;
        } else {
            blocks.owner[section] = block;
        }
        return {
            meta: data.meta || null,
            blocks,
        };
    }

    const sections = buildSectionsForTabs(tabs);
    const params = new URLSearchParams(common);
    if (sections.mainSections) {
        params.set('mainSections', sections.mainSections);
    }
    if (sections.ownerSections) {
        params.set('ownerSections', sections.ownerSections);
    }
    if (!sections.mainSections && !sections.ownerSections) {
        throw new Error('Не выбраны секции для запроса');
    }

    const url = `${base}/query-batch?${params.toString()}`;
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json, */*;q=0.8',
        },
    });
    const body = await response.json();
    if (!body.success) {
        const err = body.data?.error || body.data?.code || `HTTP ${response.status}`;
        throw new Error(String(err));
    }
    if (body.data?.code) {
        throw new Error(`${body.data.code}: ${body.data.error || 'report failed'}`);
    }
    return body.data;
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
    // refresh: текущий месяц (+ опционально --include-previous)
    const months = [currentMonthYm()];
    if (args['include-previous']) {
        const cur = parseYm(months[0]);
        const prevMonth = cur.month === 1 ? 12 : cur.month - 1;
        const prevYear = cur.month === 1 ? cur.year - 1 : cur.year;
        months.unshift(formatYm(prevYear, prevMonth));
    }
    return months;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.h) {
        console.log(`Usage:
  node scripts/sync-warehouse.mjs --mode=mass --tabs=activity --from=2021-01 --to=2026-08
  node scripts/sync-warehouse.mjs --mode=refresh --tabs=activity --include-previous
  node scripts/sync-warehouse.mjs --tabs=all --months=2026-08,2026-09

Tabs: activity | owner | main | all (можно через запятую)
Env: MGMT_REPORT_API_TOKEN, MGMT_REPORT_API_BASE, MGMT_SYNC_DELAY_MS`);
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
    const tabs = resolveTabs(args.tabs);
    const months = resolveMonths(args);

    if (months.length === 0) {
        console.error('Список месяцев пуст');
        process.exit(1);
    }

    fs.mkdirSync(PERIODS_DIR, { recursive: true });
    const manifest = loadManifest();
    const failed = [];
    let ok = 0;
    let changed = 0;

    console.log(`mode=${mode} tabs=${tabs.join(',')} months=${months.length} delayMs=${delayMs} api=${apiBase}`);

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

    for (let i = 0; i < months.length; i += 1) {
        const ym = months[i];
        const started = Date.now();
        process.stdout.write(`[${i + 1}/${months.length}] ${ym} … `);
        try {
            const payload = await fetchMonth(apiBase, token, ym, companyId, tabs);
            const fileRel = `periods/${ym}.json`;
            const fileAbs = path.join(WAREHOUSE_DIR, fileRel);
            const existing = fs.existsSync(fileAbs)
                ? JSON.parse(fs.readFileSync(fileAbs, 'utf8'))
                : null;

            const artifact = mergeArtifact(existing, payload, ym, companyId, tabs);
            artifact.checksum = checksumPayload(artifact);

            const prevChecksum = existing?.checksum || manifest.periods[ym]?.checksum;
            const wasChanged = prevChecksum !== artifact.checksum;
            if (wasChanged) {
                changed += 1;
            }

            fs.writeFileSync(fileAbs, JSON.stringify(artifact, null, 2) + '\n', 'utf8');

            manifest.periods[ym] = {
                fetchedAt: artifact.fetchedAt,
                checksum: artifact.checksum,
                file: fileRel,
                tabs: artifact.tabs,
                changed: wasChanged,
                durationMs: Date.now() - started,
                sectionsFailed: payload.meta?.sectionsFailed ?? null,
            };
            ok += 1;
            console.log(
                `ok tabs=${artifact.tabs.join('+')} checksum=${artifact.checksum}` +
                `${wasChanged ? ' (changed)' : ''} ${Date.now() - started}ms`
            );
        } catch (error) {
            failed.push({ period: ym, error: String(error.message || error) });
            console.log(`FAIL ${error.message || error}`);
        }

        if (i < months.length - 1 && delayMs > 0) {
            await sleep(delayMs);
        }
    }

    const keys = Object.keys(manifest.periods).sort();
    manifest.generatedAt = new Date().toISOString();
    manifest.coverage = {
        from: keys[0] || null,
        to: keys[keys.length - 1] || null,
        count: keys.length,
    };
    manifest.lastRun = {
        mode,
        tabs,
        at: manifest.generatedAt,
        ok,
        failed,
        changed,
        monthsRequested: months.length,
    };
    saveManifest(manifest);

    const latestOk = [...months].reverse().find((ym) => manifest.periods[ym] && !failed.find((f) => f.period === ym));
    if (latestOk) {
        const latestSrc = path.join(WAREHOUSE_DIR, `periods/${latestOk}.json`);
        const latestDst = path.join(WAREHOUSE_DIR, 'latest.json');
        fs.copyFileSync(latestSrc, latestDst);
    }

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
