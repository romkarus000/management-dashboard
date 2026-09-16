#!/usr/bin/env node
/**
 * Sync warehouse/dev/* — метрики потока ⌘ dev EDPRObiz (Asana).
 *
 * См. vault: 06_Notes/N019, N020; docs/dev-flow-contract.md
 *
 * Usage:
 *   node scripts/sync-dev-warehouse.mjs
 *   node scripts/sync-dev-warehouse.mjs --as-of=2026-09-10
 *   node scripts/sync-dev-warehouse.mjs --lookback-days=90
 *   node scripts/sync-dev-warehouse.mjs --skip-stories
 *
 * Env:
 *   ASANA_PAT                 — обязателен (или ~/.config/asana.env)
 *   ASANA_FLOW_PROJECT_GID    — default 1203496842794391
 *   ASANA_FLOW_LOOKBACK_DAYS  — default 180
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const WAREHOUSE_DIR = path.join(REPO_ROOT, 'warehouse');
const DEV_DIR = path.join(WAREHOUSE_DIR, 'dev');
const MANIFEST_PATH = path.join(WAREHOUSE_DIR, 'manifest.json');
const CACHE_PATH = path.join(REPO_ROOT, '.cache', 'dev-flow-timestamps.json');
const LOG_DIR = path.join(REPO_ROOT, 'logs');

const ASANA_API = 'https://app.asana.com/api/1.0';
const DEFAULT_PROJECT_GID = '1203496842794391';
const WAREHOUSE_VERSION = '2.0';
const SCHEMA_VERSION = '1.0';
const LEAD_CLIP_DAYS = 365;

const SECTION = {
    inbox: 'Входящие',
    clarification: 'Требует уточнения',
    ready: 'Готово к планированию',
    committed: 'План текущего цикла',
    in_progress: 'В работе',
    testing: 'Тестирование',
    prod_check: 'Проверка PROD',
    closed: 'Закрыто',
};

const SECTION_ORDER = Object.values(SECTION);
const ACTIVE_FUNNEL = new Set([
    SECTION.clarification,
    SECTION.ready,
    SECTION.committed,
    SECTION.in_progress,
    SECTION.testing,
    SECTION.prod_check,
]);
const CYCLE_SECTIONS = [SECTION.in_progress, SECTION.testing, SECTION.prod_check];
const SECTION_KEY = Object.fromEntries(Object.entries(SECTION).map(([k, v]) => [v, k]));

const CF_TYPE = '⌘ Тип';
const CF_PRIORITY = '⌘ Приоритет';

const PLAYBOOK = [
    { metric: 'time_to_commit', hint: 'SLA на уточнения, лимит WIP в «Требует уточнения», триаж' },
    { metric: 'lead', hint: 'Если cycle в норме — очередь до разработки; жёстче отбор в «План цикла»' },
    { metric: 'cycle', hint: 'WIP-лимит «В работе»; не стартовать новую, пока старая в тесте' },
    { metric: 'ttm', hint: 'Резать размер фич + рычаги lead/cycle' },
    { metric: 'mttr', hint: 'Дедуп алертов, on-call, runbook' },
    { metric: 'throughput', hint: 'Падение при норм. cycle → снизить WIP; рост за счёт INC → чинить алерты' },
    { metric: 'wip', hint: 'Weekly triage aging >14д в активной воронке' },
];

// ---------------------------------------------------------------------------
// CLI / env
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv
 * @returns {Record<string, string|boolean>}
 */
function parseArgs(argv) {
    const out = {};
    for (const arg of argv) {
        if (!arg.startsWith('--')) continue;
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
 * @param {string} filePath
 */
function loadDotenvFile(filePath) {
    if (!fs.existsSync(filePath)) return;
    for (const raw of fs.readFileSync(filePath, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || !line.includes('=')) continue;
        const i = line.indexOf('=');
        const key = line.slice(0, i).trim();
        let val = line.slice(i + 1).trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        if (!(key in process.env) || process.env[key] === '') {
            process.env[key] = val;
        }
    }
}

/**
 * @param {unknown} data
 * @returns {string}
 */
function checksumData(data) {
    return crypto.createHash('sha256').update(JSON.stringify(data ?? null)).digest('hex').slice(0, 16);
}

/**
 * Дата YYYY-MM-DD в Europe/Moscow.
 * @param {Date} [d]
 * @returns {string}
 */
function moscowDateString(d = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
}

/**
 * @param {string} isoDate YYYY-MM-DD
 * @returns {Date} start of that Moscow calendar day in UTC approx via offset parse
 */
function parseAsOfStartUtc(isoDate) {
    // Treat asOf as Moscow calendar day; use noon UTC-equivalent via fixed offset +03
    return new Date(`${isoDate}T00:00:00+03:00`);
}

/**
 * @param {string|null|undefined} s
 * @returns {Date|null}
 */
function parseDt(s) {
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        return new Date(`${s}T00:00:00.000Z`);
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {Date|null} a
 * @param {Date|null} b
 * @returns {number|null}
 */
function daysBetween(a, b) {
    if (!a || !b) return null;
    return (b.getTime() - a.getTime()) / 86400000;
}

/**
 * @param {(number|null|undefined)[]} vals
 * @param {number|null} clipMax
 * @returns {{n:number,p50:number|null,p75:number|null,p90:number|null,avg:number|null,min:number|null,max:number|null}}
 */
function stats(vals, clipMax = LEAD_CLIP_DAYS) {
    const clean = [];
    for (const v of vals) {
        if (v == null || Number.isNaN(v) || v < 0) continue;
        if (clipMax != null && v > clipMax) continue;
        clean.push(v);
    }
    if (!clean.length) {
        return { n: 0, p50: null, p75: null, p90: null, avg: null, min: null, max: null };
    }
    clean.sort((a, b) => a - b);
    const pct = (p) => {
        if (clean.length === 1) return clean[0];
        const k = ((clean.length - 1) * p) / 100;
        const f = Math.floor(k);
        const c = Math.min(f + 1, clean.length - 1);
        if (f === c) return clean[f];
        return clean[f] + (clean[c] - clean[f]) * (k - f);
    };
    const sum = clean.reduce((a, b) => a + b, 0);
    const round2 = (x) => Math.round(x * 100) / 100;
    return {
        n: clean.length,
        p50: round2(pct(50)),
        p75: round2(pct(75)),
        p90: round2(pct(90)),
        avg: round2(sum / clean.length),
        min: round2(clean[0]),
        max: round2(clean[clean.length - 1]),
    };
}

/**
 * @param {{p50:number|null,p75:number|null,p90:number|null,n:number}} s
 * @param {string} unit
 */
function metricBlock(s, unit = 'days') {
    return { unit, n: s.n, p50: s.p50, p75: s.p75, p90: s.p90 };
}

// ---------------------------------------------------------------------------
// Asana API
// ---------------------------------------------------------------------------

/**
 * @param {string} pat
 * @param {string} apiPath
 * @param {Record<string, string|number>} [params]
 */
async function asanaGet(pat, apiPath, params = {}) {
    const url = new URL(ASANA_API + apiPath);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${pat}`, Accept: 'application/json' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(`Asana ${res.status} ${apiPath}: ${JSON.stringify(body).slice(0, 400)}`);
    }
    return body;
}

/**
 * @param {string} pat
 * @param {string} apiPath
 * @param {Record<string, string|number>} [params]
 */
async function asanaPaginated(pat, apiPath, params = {}) {
    const out = [];
    const q = { ...params, limit: 100 };
    for (;;) {
        const body = await asanaGet(pat, apiPath, q);
        out.push(...(body.data || []));
        const offset = body.next_page?.offset;
        if (!offset) break;
        q.offset = offset;
        await sleep(120);
    }
    return out;
}

/** @param {number} ms */
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} task
 * @param {string} name
 */
function cfEnum(task, name) {
    for (const f of task.custom_fields || []) {
        if (f.name === name) {
            return f.enum_value?.name || '—';
        }
    }
    return '—';
}

/**
 * @param {object} task
 */
function sectionOf(task) {
    for (const m of task.memberships || []) {
        const n = m.section?.name;
        if (n) return n;
    }
    return '—';
}

/**
 * @param {string} text
 */
function parseMoveTo(text) {
    const t = text.trim();
    let m = /\bto (.+)$/i.exec(t);
    if (m) return m[1].trim().replace(/\.$/, '');
    m = /в «([^»]+)»/.exec(t);
    if (m) return m[1];
    return null;
}

/**
 * @param {object[]} stories
 * @returns {Record<string, string>} section -> ISO
 */
function firstEnters(stories) {
    /** @type {Record<string, string>} */
    const enters = {};
    for (const story of stories) {
        const created = story.created_at;
        if (!created) continue;
        let newSec = story.new_section?.name || null;
        const text = (story.text || '').trim();
        if (
            !newSec &&
            (text.toLowerCase().includes('moved') ||
                text.includes(' to ') ||
                text.toLowerCase().includes('перемес'))
        ) {
            newSec = parseMoveTo(text);
        }
        if (newSec && SECTION_ORDER.includes(newSec) && !enters[newSec]) {
            enters[newSec] = created;
        }
    }
    return enters;
}

/**
 * @param {Record<string, string>} enters
 * @returns {string|null}
 */
function pickCycleStart(enters) {
    for (const sn of CYCLE_SECTIONS) {
        if (enters[sn]) return enters[sn];
    }
    return null;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

function loadCache() {
    if (!fs.existsSync(CACHE_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } catch {
        return {};
    }
}

/**
 * @param {object} cache
 */
function saveCache(cache) {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Warehouse IO
// ---------------------------------------------------------------------------

/**
 * @param {string} dataset
 * @param {string} period
 * @param {object} data
 * @param {object} extraMeta
 */
function buildEnvelope(dataset, period, data, extraMeta = {}) {
    const fetchedAt = new Date().toISOString();
    return {
        warehouseVersion: WAREHOUSE_VERSION,
        dataset,
        period,
        fetchedAt,
        checksum: checksumData(data),
        filters: {
            projectGid: process.env.ASANA_FLOW_PROJECT_GID || DEFAULT_PROJECT_GID,
            projectName: '⌘ dev EDPRObiz',
            timezone: 'Europe/Moscow',
        },
        meta: {
            schemaVersion: SCHEMA_VERSION,
            department: 'development',
            generatedAt: fetchedAt,
            source: 'sync-dev-warehouse.mjs',
            ...extraMeta,
        },
        data,
    };
}

/**
 * @param {string} relPath relative to warehouse/
 * @param {object} envelope
 */
function writeEnvelope(relPath, envelope) {
    const full = path.join(WAREHOUSE_DIR, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
    return full;
}

/**
 * @param {string} datasetId
 * @param {string} relPath
 * @param {string} period
 * @param {object} envelope
 * @param {object} manifest
 */
function upsertManifestDataset(manifest, datasetId, relPath, period, envelope) {
    if (!manifest.datasets) manifest.datasets = {};
    if (!manifest.datasets[datasetId]) {
        manifest.datasets[datasetId] = {
            path: relPath,
            periodGranularity: 'day',
            coverage: { from: null, to: null, count: 0 },
            periods: {},
        };
    }
    const ds = manifest.datasets[datasetId];
    ds.path = relPath;
    ds.periodGranularity = 'day';
    if (!ds.periods) ds.periods = {};
    ds.periods[period] = {
        fetchedAt: envelope.fetchedAt,
        checksum: envelope.checksum,
        file: `${relPath}/${period}.json`,
        changed: true,
    };
    const keys = Object.keys(ds.periods).sort();
    ds.coverage = { from: keys[0] || null, to: keys[keys.length - 1] || null, count: keys.length };
}

/**
 * @param {Date} d
 * @returns {string} YYYY-Www
 */
function isoWeekKey(d) {
    const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    const day = tmp.getUTCDay() || 7;
    tmp.setUTCDate(tmp.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((tmp - yearStart) / 86400000 + 1) / 7);
    return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * @param {object} row
 */
function classifyThroughputBucket(row) {
    if (row.isInc) return 'inc';
    if (row.type === 'Разработка') return 'development';
    if (row.type === 'Ошибка') return 'bug';
    if (row.type === 'Текучка' || row.entryMode === 'direct_to_wip') return 'ops';
    return 'ops';
}

/**
 * @param {object} row
 */
function inLeadCohort(row) {
    if (row.isInc) return false;
    if (row.type === 'Текучка') return false;
    if (row.entryMode === 'direct_to_wip' && row.type !== 'Разработка') return false;
    return true;
}

// ---------------------------------------------------------------------------
// Main compute
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 */
async function run(opts) {
    loadDotenvFile(path.join(os.homedir(), '.config', 'asana.env'));
    const pat = (process.env.ASANA_PAT || '').trim();
    if (!pat) {
        throw new Error('ASANA_PAT missing (env or ~/.config/asana.env)');
    }

    const projectGid = (process.env.ASANA_FLOW_PROJECT_GID || DEFAULT_PROJECT_GID).trim();
    const lookbackDays = Number(opts['lookback-days'] || process.env.ASANA_FLOW_LOOKBACK_DAYS || 180);
    const asOf = String(opts['as-of'] || moscowDateString());
    const skipStories = Boolean(opts['skip-stories']);
    const asOfStart = parseAsOfStartUtc(asOf);
    const lookbackStart = new Date(asOfStart.getTime() - lookbackDays * 86400000);
    const flowWindowStart = new Date(asOfStart.getTime() - 30 * 86400000);
    const mttrWindowStart = new Date(asOfStart.getTime() - 7 * 86400000);
    const now = new Date();

    console.log(`asOf=${asOf} project=${projectGid} lookback=${lookbackDays}d skipStories=${skipStories}`);

    const optFields = [
        'gid',
        'name',
        'completed',
        'completed_at',
        'created_at',
        'memberships.section.name',
        'assignee.name',
        'custom_fields.name',
        'custom_fields.enum_value.name',
    ].join(',');

    console.log('Fetching tasks…');
    const rawTasks = await asanaPaginated(pat, `/projects/${projectGid}/tasks`, {
        completed_since: '2024-01-01T00:00:00.000Z',
        opt_fields: optFields,
    });
    console.log(`Tasks: ${rawTasks.length}`);

    /** @type {object[]} */
    const rows = rawTasks.map((t) => {
        const name = t.name || '';
        const section = sectionOf(t);
        const createdAt = parseDt(t.created_at);
        const completedAt = parseDt(t.completed_at);
        const type = cfEnum(t, CF_TYPE);
        const isInc = name.startsWith('[INC]');
        // direct_to_wip heuristic: created into in_progress without going inbox — refined via stories
        return {
            gid: t.gid,
            name: name.slice(0, 120),
            completed: Boolean(t.completed),
            createdAt,
            completedAt,
            section,
            type,
            priority: cfEnum(t, CF_PRIORITY),
            assignee: t.assignee?.name || '—',
            isInc,
            entryMode: 'funnel',
            enters: {},
            boardIn: createdAt,
            devStart: null,
            committedAt: null,
            done: completedAt,
            leadDays: null,
            cycleDays: null,
            timeToCommitDays: null,
        };
    });

    const cache = loadCache();
    const completedInWindow = rows.filter(
        (r) => r.completed && r.completedAt && r.completedAt >= lookbackStart && r.completedAt <= now
    );
    console.log(`Completed in lookback: ${completedInWindow.length}`);

    let storyFetches = 0;
    let cacheHits = 0;

    for (let i = 0; i < completedInWindow.length; i++) {
        const r = completedInWindow[i];
        const cached = cache[r.gid];

        if (skipStories) {
            r.boardIn = r.createdAt;
            r.done = r.completedAt;
            r.leadDays = daysBetween(r.boardIn, r.done);
            continue;
        }

        if (
            cached &&
            cached.done === (r.completedAt && r.completedAt.toISOString()) &&
            cached.enters
        ) {
            r.enters = cached.enters;
            cacheHits += 1;
        } else {
            const stories = await asanaPaginated(pat, `/tasks/${r.gid}/stories`, {
                opt_fields: 'created_at,text,resource_subtype,new_section.name',
            });
            r.enters = firstEnters(stories);
            storyFetches += 1;
            cache[r.gid] = {
                enters: r.enters,
                done: r.completedAt ? r.completedAt.toISOString() : null,
                updatedAt: new Date().toISOString(),
            };
            if (storyFetches % 40 === 0) {
                console.log(`  stories ${storyFetches}/${completedInWindow.length - cacheHits} (cacheHits=${cacheHits})`);
                saveCache(cache);
            }
            await sleep(80);
        }

        const enters = r.enters;
        const boardInIso = enters[SECTION.inbox] || (r.createdAt && r.createdAt.toISOString());
        r.boardIn = parseDt(boardInIso);
        const cycleIso = pickCycleStart(enters);
        r.devStart = parseDt(cycleIso);
        r.committedAt = parseDt(enters[SECTION.committed] || null);
        const doneIso = enters[SECTION.closed] || (r.completedAt && r.completedAt.toISOString());
        r.done = parseDt(doneIso);

        // entry mode: never saw inbox but saw in_progress near create
        if (!enters[SECTION.inbox] && enters[SECTION.in_progress] && r.createdAt) {
            const toWip = daysBetween(r.createdAt, parseDt(enters[SECTION.in_progress]));
            if (toWip != null && toWip < 0.05) {
                r.entryMode = 'direct_to_wip';
                r.boardIn = r.createdAt;
                r.devStart = r.devStart || r.createdAt;
            }
        }

        r.leadDays = daysBetween(r.boardIn, r.done);
        r.cycleDays = r.devStart ? daysBetween(r.devStart, r.done) : null;
        r.timeToCommitDays = r.committedAt ? daysBetween(r.boardIn, r.committedAt) : null;
    }

    if (!skipStories) saveCache(cache);
    console.log(`Stories fetched=${storyFetches} cacheHits=${cacheHits}`);

    // Cohorts for card windows
    const closed30 = completedInWindow.filter((r) => r.done && r.done >= flowWindowStart);
    const closed7 = completedInWindow.filter((r) => r.done && r.done >= mttrWindowStart);
    const leadCohort30 = closed30.filter(inLeadCohort);
    const ttmCohort30 = leadCohort30.filter((r) => r.type === 'Разработка');
    const mttrCohort7 = closed7.filter((r) => r.isInc);

    // Also compute 180d reference for series continuity
    const leadCohortAll = completedInWindow.filter(inLeadCohort);

    const leadStat = stats(leadCohort30.map((r) => r.leadDays));
    const cycleStat = stats(leadCohort30.map((r) => r.cycleDays));
    const ttmStat = stats(ttmCohort30.map((r) => r.leadDays));
    const ttcStat = stats(leadCohort30.map((r) => r.timeToCommitDays));
    const mttrStat = stats(
        mttrCohort7.map((r) => r.leadDays),
        null
    );

    // Throughput by week over lookback
    /** @type {Record<string, {development:number,bug:number,ops:number,inc:number}>} */
    const weeks = {};
    for (const r of completedInWindow) {
        if (!r.done) continue;
        const key = isoWeekKey(r.done);
        if (!weeks[key]) weeks[key] = { development: 0, bug: 0, ops: 0, inc: 0 };
        weeks[key][classifyThroughputBucket(r)] += 1;
    }
    const weekKeys = Object.keys(weeks).sort();
    const lastWeek = weekKeys[weekKeys.length - 1] || null;
    const throughputLast = lastWeek
        ? {
              isoWeek: lastWeek,
              ...weeks[lastWeek],
              total_excl_inc:
                  weeks[lastWeek].development + weeks[lastWeek].bug + weeks[lastWeek].ops,
          }
        : {
              isoWeek: null,
              development: 0,
              bug: 0,
              ops: 0,
              inc: 0,
              total_excl_inc: 0,
          };

    // WIP snapshot (open tasks)
    const wipRows = rows.filter((r) => !r.completed && SECTION_ORDER.includes(r.section) && r.section !== SECTION.closed);
    const activeWip = wipRows.filter((r) => ACTIVE_FUNNEL.has(r.section));
    const bySection = {
        clarification: 0,
        ready: 0,
        committed: 0,
        in_progress: 0,
        testing: 0,
        prod_check: 0,
    };
    for (const r of activeWip) {
        const key = SECTION_KEY[r.section];
        if (key && key in bySection) bySection[key] += 1;
    }
    const aging = activeWip.map((r) => ({
        ...r,
        ageDays: Math.round((daysBetween(r.createdAt, now) || 0) * 10) / 10,
    }));
    const inboxStale = wipRows.filter(
        (r) => r.section === SECTION.inbox && (daysBetween(r.createdAt, now) || 0) > 30
    ).length;

    const wipBlock = {
        active_total: activeWip.length,
        by_section: bySection,
        aging_gt_7: aging.filter((r) => r.ageDays > 7).length,
        aging_gt_14: aging.filter((r) => r.ageDays > 14).length,
        aging_gt_30: aging.filter((r) => r.ageDays > 30).length,
    };

    // previous card
    let previous = null;
    const prevAsOfFixed = (() => {
        const d = parseAsOfStartUtc(asOf);
        d.setTime(d.getTime() - 86400000);
        return moscowDateString(d);
    })();
    const prevCardPath = path.join(DEV_DIR, 'card', `${prevAsOfFixed}.json`);
    if (fs.existsSync(prevCardPath)) {
        try {
            const prevEnv = JSON.parse(fs.readFileSync(prevCardPath, 'utf8'));
            previous = { asOf: prevEnv.period || prevAsOfFixed, metrics: prevEnv.data?.metrics || null };
        } catch {
            previous = null;
        }
    }

    const cardData = {
        asOf,
        windows: { flowDays: 30, mttrDays: 7 },
        metrics: {
            lead: metricBlock(leadStat),
            cycle: metricBlock(cycleStat),
            ttm: metricBlock(ttmStat),
            time_to_commit: metricBlock(ttcStat),
            mttr: metricBlock(mttrStat),
            throughput: throughputLast,
            wip: wipBlock,
        },
        previous,
        playbook: PLAYBOOK,
    };

    // series: last 12 weeks throughput + daily stubs from this run only for asOf
    const throughputWeekly = weekKeys.slice(-12).map((isoWeek) => ({
        isoWeek,
        ...weeks[isoWeek],
    }));

    // Build daily p50 series from completedInWindow by done date (rolling on that day)
    /** @type {Record<string, object[]>} */
    const byDoneDay = {};
    for (const r of leadCohortAll) {
        if (!r.done) continue;
        const day = moscowDateString(r.done);
        if (!byDoneDay[day]) byDoneDay[day] = [];
        byDoneDay[day].push(r);
    }
    // Cumulative through each day for rolling 30d window is expensive; store point-in-time daily closes stats
    const leadP50Daily = [];
    const cycleP50Daily = [];
    const mttrP50Daily = [];
    const dayKeys = Object.keys(byDoneDay).sort().slice(-90);
    for (const day of dayKeys) {
        const dayStart = parseAsOfStartUtc(day);
        const from30 = new Date(dayStart.getTime() - 30 * 86400000);
        const from7 = new Date(dayStart.getTime() - 7 * 86400000);
        const end = new Date(dayStart.getTime() + 86400000 - 1);
        const leadRows = leadCohortAll.filter((r) => r.done && r.done >= from30 && r.done <= end);
        const mttrRows = completedInWindow.filter(
            (r) => r.isInc && r.done && r.done >= from7 && r.done <= end
        );
        const ls = stats(leadRows.map((r) => r.leadDays));
        const cs = stats(leadRows.map((r) => r.cycleDays));
        const ms = stats(
            mttrRows.map((r) => r.leadDays),
            null
        );
        leadP50Daily.push({ date: day, value: ls.p50, n: ls.n });
        cycleP50Daily.push({ date: day, value: cs.p50, n: cs.n });
        mttrP50Daily.push({ date: day, value: ms.p50, n: ms.n });
    }

    // WIP active daily — only today's point (historical needs stored history)
    const existingSeriesPath = path.join(DEV_DIR, 'series', `${prevAsOfFixed}.json`);
    let wipActiveDaily = [{ date: asOf, value: activeWip.length }];
    if (fs.existsSync(existingSeriesPath)) {
        try {
            const prevSeries = JSON.parse(fs.readFileSync(existingSeriesPath, 'utf8'));
            const prev = prevSeries.data?.wipActiveDaily || [];
            const map = new Map(prev.map((p) => [p.date, p]));
            map.set(asOf, { date: asOf, value: activeWip.length });
            wipActiveDaily = [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-90);
        } catch {
            /* keep today only */
        }
    }

    const seriesData = {
        throughputWeekly,
        leadP50Daily,
        cycleP50Daily,
        mttrP50Daily,
        wipActiveDaily,
    };

    const oldest = aging
        .slice()
        .sort((a, b) => b.ageDays - a.ageDays)
        .slice(0, 15)
        .map((r) => ({
            gid: r.gid,
            name: r.name,
            section: SECTION_KEY[r.section] || r.section,
            type: r.type,
            age_days: r.ageDays,
            url: `https://app.asana.com/0/${projectGid}/${r.gid}`,
        }));

    const wipData = {
        by_section: bySection,
        aging: {
            gt_7: wipBlock.aging_gt_7,
            gt_14: wipBlock.aging_gt_14,
            gt_30: wipBlock.aging_gt_30,
        },
        oldest,
    };

    // tasks closed on asOf (Moscow day)
    const dayStart = parseAsOfStartUtc(asOf);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const closedToday = completedInWindow.filter((r) => r.done && r.done >= dayStart && r.done < dayEnd);
    const tasksClosedData = {
        tasks: closedToday.map((r) => {
            const cohorts = [];
            if (inLeadCohort(r)) {
                cohorts.push('lead', 'cycle');
                if (r.type === 'Разработка') cohorts.push('ttm');
            }
            if (r.isInc) cohorts.push('mttr');
            return {
                gid: r.gid,
                name: r.name,
                type: r.type,
                is_inc: r.isInc,
                entry_mode: r.entryMode,
                board_in: r.boardIn ? r.boardIn.toISOString() : null,
                dev_start: r.devStart ? r.devStart.toISOString() : null,
                committed_at: r.committedAt ? r.committedAt.toISOString() : null,
                done: r.done ? r.done.toISOString() : null,
                lead_days: r.leadDays != null ? Math.round(r.leadDays * 1000) / 1000 : null,
                cycle_days: r.cycleDays != null ? Math.round(r.cycleDays * 1000) / 1000 : null,
                time_to_commit_days:
                    r.timeToCommitDays != null ? Math.round(r.timeToCommitDays * 1000) / 1000 : null,
                cohorts,
                url: `https://app.asana.com/0/${projectGid}/${r.gid}`,
            };
        }),
    };

    const metaExtra = {
        lookbackDays,
        inbox_stale_gt_30d: inboxStale,
        skipStories,
        storyFetches,
        cacheHits,
        completedInWindow: completedInWindow.length,
    };

    const cardEnv = buildEnvelope('dev.card', asOf, cardData, metaExtra);
    const seriesEnv = buildEnvelope('dev.series', asOf, seriesData, metaExtra);
    const wipEnv = buildEnvelope('dev.wip', asOf, wipData, metaExtra);
    const tasksEnv = buildEnvelope('dev.tasks_closed', asOf, tasksClosedData, metaExtra);

    writeEnvelope(`dev/card/${asOf}.json`, cardEnv);
    writeEnvelope(`dev/series/${asOf}.json`, seriesEnv);
    writeEnvelope(`dev/wip/${asOf}.json`, wipEnv);
    writeEnvelope(`dev/tasks_closed/${asOf}.json`, tasksEnv);

    const latest = {
        department: 'development',
        period: asOf,
        fetchedAt: cardEnv.fetchedAt,
        files: {
            card: `dev/card/${asOf}.json`,
            series: `dev/series/${asOf}.json`,
            wip: `dev/wip/${asOf}.json`,
            tasks_closed: `dev/tasks_closed/${asOf}.json`,
        },
    };
    fs.mkdirSync(DEV_DIR, { recursive: true });
    fs.writeFileSync(path.join(DEV_DIR, 'latest.json'), JSON.stringify(latest, null, 2) + '\n', 'utf8');

    // manifest merge
    let manifest = { version: '2.0', schemaVersion: '2.0', warehouseVersion: '2.0', datasets: {}, generatedAt: null };
    if (fs.existsSync(MANIFEST_PATH)) {
        manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
        if (!manifest.datasets) manifest.datasets = {};
    }
    upsertManifestDataset(manifest, 'dev.card', 'dev/card', asOf, cardEnv);
    upsertManifestDataset(manifest, 'dev.series', 'dev/series', asOf, seriesEnv);
    upsertManifestDataset(manifest, 'dev.wip', 'dev/wip', asOf, wipEnv);
    upsertManifestDataset(manifest, 'dev.tasks_closed', 'dev/tasks_closed', asOf, tasksEnv);
    manifest.generatedAt = new Date().toISOString();
    manifest.warehouseVersion = WAREHOUSE_VERSION;
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    fs.mkdirSync(LOG_DIR, { recursive: true });
    const logLine = `${new Date().toISOString()} asOf=${asOf} lead_p50=${leadStat.p50} cycle_p50=${cycleStat.p50} ttm_p50=${ttmStat.p50} mttr_p50=${mttrStat.p50} wip=${activeWip.length} stale_inbox=${inboxStale} stories=${storyFetches}\n`;
    fs.appendFileSync(path.join(LOG_DIR, `sync-dev-warehouse-${asOf}.log`), logLine, 'utf8');

    console.log('Wrote warehouse/dev/* and updated manifest.json');
    console.log(
        JSON.stringify(
            {
                asOf,
                lead: cardData.metrics.lead,
                cycle: cardData.metrics.cycle,
                ttm: cardData.metrics.ttm,
                time_to_commit: cardData.metrics.time_to_commit,
                mttr: cardData.metrics.mttr,
                throughput: cardData.metrics.throughput,
                wip: cardData.metrics.wip,
                inbox_stale_gt_30d: inboxStale,
            },
            null,
            2
        )
    );
}

// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
run(args).catch((err) => {
    console.error(err);
    process.exit(1);
});
