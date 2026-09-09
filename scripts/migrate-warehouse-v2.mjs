#!/usr/bin/env node
/**
 * Миграция warehouse v1 (periods/YYYY-MM.json) → v2 (датасеты по папкам).
 * См. docs/warehouse-v2-contract.md
 *
 * Usage:
 *   node scripts/migrate-warehouse-v2.mjs
 *   node scripts/migrate-warehouse-v2.mjs --delete-legacy
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
const WAREHOUSE_VERSION = '2.0';

const SPLITS = [
    {
        datasetId: 'main.profit',
        relDir: 'main/profit',
        pick: (artifact) => artifact?.blocks?.main?.profit || null,
    },
    {
        datasetId: 'owner.marketing',
        relDir: 'owner/marketing',
        pick: (artifact) => artifact?.blocks?.owner?.companyMarketing || null,
    },
    {
        datasetId: 'activity.summary',
        relDir: 'activity/summary',
        pick: (artifact) => artifact?.blocks?.owner?.partnerActivity || null,
    },
];

function checksumData(data) {
    return crypto.createHash('sha256').update(JSON.stringify(data ?? null)).digest('hex').slice(0, 16);
}

function emptyManifest() {
    return {
        version: '2.0',
        schemaVersion: '2.0',
        warehouseVersion: WAREHOUSE_VERSION,
        generatedAt: new Date().toISOString(),
        coverage: { from: null, to: null, count: 0 },
        datasets: {},
        lastRun: null,
    };
}

function main() {
    const deleteLegacy = process.argv.includes('--delete-legacy');

    if (!fs.existsSync(PERIODS_DIR)) {
        console.error(`Нет ${PERIODS_DIR} — нечего мигрировать`);
        process.exit(1);
    }

    const files = fs.readdirSync(PERIODS_DIR).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort();
    if (!files.length) {
        console.error('periods/ пуст');
        process.exit(1);
    }

    const manifest = emptyManifest();
    let written = 0;
    let skipped = 0;

    for (const file of files) {
        const ym = file.replace(/\.json$/, '');
        const artifact = JSON.parse(fs.readFileSync(path.join(PERIODS_DIR, file), 'utf8'));
        const companyId = Number(artifact?.filters?.companyId || 0);

        for (const split of SPLITS) {
            const data = split.pick(artifact);
            if (!data) {
                skipped += 1;
                continue;
            }
            const envelope = {
                warehouseVersion: WAREHOUSE_VERSION,
                dataset: split.datasetId,
                period: ym,
                fetchedAt: artifact.fetchedAt || new Date().toISOString(),
                checksum: checksumData(data),
                filters: {
                    periodType: 'month',
                    period: ym,
                    compareMode: artifact?.filters?.compareMode || 'previous',
                    companyId,
                },
                meta: artifact.meta || null,
                data,
            };

            const abs = path.join(WAREHOUSE_DIR, split.relDir, `${ym}.json`);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, JSON.stringify(envelope, null, 2) + '\n', 'utf8');
            written += 1;

            if (!manifest.datasets[split.datasetId]) {
                manifest.datasets[split.datasetId] = {
                    path: split.relDir,
                    coverage: { from: null, to: null, count: 0 },
                    periods: {},
                };
            }
            manifest.datasets[split.datasetId].periods[ym] = {
                fetchedAt: envelope.fetchedAt,
                checksum: envelope.checksum,
                file: `${split.relDir}/${ym}.json`,
                changed: true,
                durationMs: null,
                migratedFrom: `periods/${file}`,
            };
        }
        process.stdout.write(`${ym} `);
    }
    console.log('');

    for (const id of Object.keys(manifest.datasets)) {
        const ds = manifest.datasets[id];
        const keys = Object.keys(ds.periods).sort();
        ds.coverage = {
            from: keys[0] || null,
            to: keys[keys.length - 1] || null,
            count: keys.length,
        };
    }

    const allYm = new Set();
    for (const id of ['main.profit', 'owner.marketing', 'activity.summary']) {
        const ds = manifest.datasets[id];
        if (ds?.periods) {
            Object.keys(ds.periods).forEach((ym) => allYm.add(ym));
        }
    }
    const keys = [...allYm].sort();
    manifest.coverage = {
        from: keys[0] || null,
        to: keys[keys.length - 1] || null,
        count: keys.length,
    };
    manifest.lastRun = {
        mode: 'migrate-v2',
        at: manifest.generatedAt,
        written,
        skippedEmpty: skipped,
        sourceFiles: files.length,
    };

    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    console.log(`Wrote ${written} dataset files, skipped empty=${skipped}`);
    console.log(`manifest: ${MANIFEST_PATH}`);

    if (deleteLegacy) {
        for (const file of files) {
            fs.unlinkSync(path.join(PERIODS_DIR, file));
        }
        const latest = path.join(WAREHOUSE_DIR, 'latest.json');
        if (fs.existsSync(latest)) {
            fs.unlinkSync(latest);
        }
        console.log('Legacy periods/ и latest.json удалены');
    } else {
        console.log('Legacy periods/ оставлены. Для удаления: --delete-legacy');
    }
}

main();
