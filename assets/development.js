/**
 * Отдел разработки: KPI и графики из warehouse/dev/*.
 * Контракт: docs/dev-flow-contract.md
 */
(function () {
    'use strict';

    var WAREHOUSE_BASE = window.DEV_WAREHOUSE_BASE || './warehouse';

    var SECTION_LABELS = {
        clarification: 'Требует уточнения',
        ready: 'Готово к планированию',
        committed: 'План текущего цикла',
        in_progress: 'В работе',
        testing: 'Тестирование',
        prod_check: 'Проверка PROD'
    };

    var METRIC_META = [
        {
            key: 'lead',
            label: 'Lead time',
            hint: 'board → done · 30д · без INC/Текучки',
            lowerBetter: true
        },
        {
            key: 'cycle',
            label: 'Cycle time',
            hint: 'В работе → done · 30д',
            lowerBetter: true
        },
        {
            key: 'ttm',
            label: 'TTM',
            hint: 'Lead для типа Разработка',
            lowerBetter: true
        },
        {
            key: 'time_to_commit',
            label: 'Time to commit',
            hint: 'до «План текущего цикла»',
            lowerBetter: true
        },
        {
            key: 'mttr',
            label: 'MTTR',
            hint: '[INC] · 7д',
            lowerBetter: true
        }
    ];

    var charts = {
        throughput: null,
        wip: null
    };

    function el(id) {
        return document.getElementById(id);
    }

    function setStatus(text, isError) {
        var node = el('dashboard-status');
        if (!node) return;
        node.textContent = text;
        node.classList.toggle('is-error', !!isError);
    }

    function fmtDays(v) {
        if (v == null || Number.isNaN(Number(v))) return '—';
        var n = Number(v);
        if (n < 1) return (Math.round(n * 24 * 10) / 10) + ' ч';
        return (Math.round(n * 10) / 10) + ' д';
    }

    function fmtNum(v) {
        if (v == null || Number.isNaN(Number(v))) return '—';
        return Number(v).toLocaleString('ru-RU');
    }

    function deltaClass(delta, lowerBetter) {
        if (delta == null || delta === 0) return 'is-neutral';
        var worse = lowerBetter ? delta > 0 : delta < 0;
        return worse ? 'is-down' : 'is-up';
    }

    function deltaText(delta, lowerBetter) {
        if (delta == null) return 'нет базы';
        if (delta === 0) return 'без изменений';
        var sign = delta > 0 ? '+' : '';
        var label = lowerBetter
            ? delta > 0
                ? 'медленнее'
                : 'быстрее'
            : delta > 0
              ? 'больше'
              : 'меньше';
        return sign + fmtDays(Math.abs(delta)).replace(' д', 'д').replace(' ч', 'ч') + ' · ' + label;
    }

    function fetchJson(url) {
        return fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now()).then(function (res) {
            if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
            return res.json();
        });
    }

    function destroyChart(key) {
        if (charts[key]) {
            charts[key].destroy();
            charts[key] = null;
        }
    }

    function renderKpis(card) {
        var metrics = (card.data && card.data.metrics) || {};
        var prevMetrics = (card.data && card.data.previous && card.data.previous.metrics) || null;
        var grid = el('kpi-grid');
        grid.innerHTML = '';

        METRIC_META.forEach(function (meta) {
            var m = metrics[meta.key] || {};
            var prev = prevMetrics && prevMetrics[meta.key];
            var delta =
                m.p50 != null && prev && prev.p50 != null ? Number(m.p50) - Number(prev.p50) : null;

            var cardEl = document.createElement('div');
            cardEl.className = 'management-dashboard__kpi';

            var label = document.createElement('div');
            label.className = 'management-dashboard__kpi-label';
            label.textContent = meta.label;

            var value = document.createElement('div');
            value.className = 'management-dashboard__kpi-value';
            value.textContent = fmtDays(m.p50);

            var sub = document.createElement('div');
            sub.className = 'management-dashboard__kpi-hint';
            sub.textContent =
                'p90 ' + fmtDays(m.p90) + ' · n=' + fmtNum(m.n) + (meta.hint ? ' · ' + meta.hint : '');

            var deltaEl = document.createElement('div');
            deltaEl.className =
                'management-dashboard__kpi-delta ' + deltaClass(delta, meta.lowerBetter);
            deltaEl.textContent = deltaText(delta, meta.lowerBetter);

            cardEl.appendChild(label);
            cardEl.appendChild(value);
            cardEl.appendChild(sub);
            cardEl.appendChild(deltaEl);
            grid.appendChild(cardEl);
        });

        // Throughput + WIP summary cards
        var thr = metrics.throughput || {};
        var wip = metrics.wip || {};

        function addSimple(label, value, hint) {
            var c = document.createElement('div');
            c.className = 'management-dashboard__kpi';
            c.innerHTML =
                '<div class="management-dashboard__kpi-label">' +
                label +
                '</div>' +
                '<div class="management-dashboard__kpi-value">' +
                value +
                '</div>' +
                '<div class="management-dashboard__kpi-hint">' +
                (hint || '') +
                '</div>';
            grid.appendChild(c);
        }

        addSimple(
            'Throughput (без INC)',
            fmtNum(thr.total_excl_inc),
            (thr.isoWeek || '—') +
                ' · dev ' +
                fmtNum(thr.development) +
                ' · bug ' +
                fmtNum(thr.bug) +
                ' · ops ' +
                fmtNum(thr.ops) +
                ' · inc ' +
                fmtNum(thr.inc)
        );
        addSimple(
            'WIP активный',
            fmtNum(wip.active_total),
            'aging >14д: ' + fmtNum(wip.aging_gt_14) + ' · inbox stale >30д в meta'
        );
    }

    function renderAging(wipEnv, card) {
        var aging = (wipEnv.data && wipEnv.data.aging) || {};
        var meta = card.meta || {};
        var grid = el('wip-aging');
        grid.innerHTML = '';
        [
            { label: 'Aging >7д', value: aging.gt_7 },
            { label: 'Aging >14д', value: aging.gt_14 },
            { label: 'Aging >30д', value: aging.gt_30 },
            { label: 'Inbox stale >30д', value: meta.inbox_stale_gt_30d }
        ].forEach(function (row) {
            var c = document.createElement('div');
            c.className = 'management-dashboard__kpi';
            c.innerHTML =
                '<div class="management-dashboard__kpi-label">' +
                row.label +
                '</div>' +
                '<div class="management-dashboard__kpi-value">' +
                fmtNum(row.value) +
                '</div>';
            grid.appendChild(c);
        });
    }

    function renderTable(card) {
        var metrics = (card.data && card.data.metrics) || {};
        var prevMetrics = (card.data && card.data.previous && card.data.previous.metrics) || null;
        var tbody = el('metrics-table-body');
        tbody.innerHTML = '';

        METRIC_META.forEach(function (meta) {
            var m = metrics[meta.key] || {};
            var prev = prevMetrics && prevMetrics[meta.key];
            var delta =
                m.p50 != null && prev && prev.p50 != null ? Number(m.p50) - Number(prev.p50) : null;
            var tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' +
                meta.label +
                '</td>' +
                '<td class="is-num">' +
                fmtDays(m.p50) +
                '</td>' +
                '<td class="is-num">' +
                fmtDays(m.p90) +
                '</td>' +
                '<td class="is-num">' +
                fmtNum(m.n) +
                '</td>' +
                '<td class="is-num">' +
                (delta == null ? '—' : (delta > 0 ? '+' : '') + fmtDays(delta)) +
                '</td>';
            tbody.appendChild(tr);
        });
    }

    function renderOldest(wipEnv) {
        var oldest = (wipEnv.data && wipEnv.data.oldest) || [];
        var tbody = el('oldest-table-body');
        tbody.innerHTML = '';
        if (!oldest.length) {
            tbody.innerHTML = '<tr><td colspan="4">Нет данных</td></tr>';
            return;
        }
        oldest.forEach(function (row) {
            var tr = document.createElement('tr');
            var name = row.url
                ? '<a href="' + row.url + '" target="_blank" rel="noopener">' + escapeHtml(row.name) + '</a>'
                : escapeHtml(row.name);
            tr.innerHTML =
                '<td>' +
                name +
                '</td>' +
                '<td>' +
                escapeHtml(SECTION_LABELS[row.section] || row.section || '—') +
                '</td>' +
                '<td>' +
                escapeHtml(row.type || '—') +
                '</td>' +
                '<td class="is-num">' +
                fmtNum(row.age_days) +
                '</td>';
            tbody.appendChild(tr);
        });
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderPlaybook(card) {
        var list = el('playbook-list');
        list.innerHTML = '';
        var items = (card.data && card.data.playbook) || [];
        items.forEach(function (item) {
            var li = document.createElement('li');
            li.innerHTML =
                '<strong>' + escapeHtml(item.metric) + '</strong> — ' + escapeHtml(item.hint);
            list.appendChild(li);
        });
    }

    function renderThroughputChart(series) {
        destroyChart('throughput');
        var weeks = (series.data && series.data.throughputWeekly) || [];
        var canvas = el('chart-throughput');
        if (!canvas || typeof Chart === 'undefined') return;

        charts.throughput = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: weeks.map(function (w) {
                    return w.isoWeek;
                }),
                datasets: [
                    {
                        label: 'Разработка',
                        data: weeks.map(function (w) {
                            return w.development || 0;
                        }),
                        backgroundColor: '#2563eb'
                    },
                    {
                        label: 'Баги',
                        data: weeks.map(function (w) {
                            return w.bug || 0;
                        }),
                        backgroundColor: '#dc2626'
                    },
                    {
                        label: 'Оперативка',
                        data: weeks.map(function (w) {
                            return w.ops || 0;
                        }),
                        backgroundColor: '#64748b'
                    },
                    {
                        label: '[INC]',
                        data: weeks.map(function (w) {
                            return w.inc || 0;
                        }),
                        backgroundColor: '#f59e0b'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { position: 'bottom' }
                },
                scales: {
                    x: { stacked: true },
                    y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } }
                }
            }
        });
    }

    function renderWipChart(wipEnv) {
        destroyChart('wip');
        var by = (wipEnv.data && wipEnv.data.by_section) || {};
        var order = [
            'clarification',
            'ready',
            'committed',
            'in_progress',
            'testing',
            'prod_check'
        ];
        var canvas = el('chart-wip');
        if (!canvas || typeof Chart === 'undefined') return;

        charts.wip = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: order.map(function (k) {
                    return SECTION_LABELS[k] || k;
                }),
                datasets: [
                    {
                        label: 'Задачи',
                        data: order.map(function (k) {
                            return by[k] || 0;
                        }),
                        backgroundColor: '#4338ca'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true, ticks: { precision: 0 } }
                }
            }
        });
    }

    function renderMeta(card, latest) {
        var meta = card.meta || {};
        var info = el('meta-info');
        info.textContent =
            'asOf ' +
            (card.period || latest.period || '—') +
            ' · fetched ' +
            (card.fetchedAt || '—') +
            ' · checksum ' +
            (card.checksum || '—') +
            ' · lookback ' +
            (meta.lookbackDays != null ? meta.lookbackDays + 'д' : '—') +
            ' · source ' +
            (meta.source || '—');
    }

    function loadAll() {
        setStatus('Загрузка warehouse/dev…');
        return fetchJson(WAREHOUSE_BASE + '/dev/latest.json')
            .then(function (latest) {
                var files = latest.files || {};
                return Promise.all([
                    fetchJson(WAREHOUSE_BASE + '/' + files.card),
                    fetchJson(WAREHOUSE_BASE + '/' + files.series),
                    fetchJson(WAREHOUSE_BASE + '/' + files.wip),
                    Promise.resolve(latest)
                ]);
            })
            .then(function (parts) {
                var card = parts[0];
                var series = parts[1];
                var wip = parts[2];
                var latest = parts[3];

                renderMeta(card, latest);
                renderKpis(card);
                renderAging(wip, card);
                renderTable(card);
                renderOldest(wip);
                renderPlaybook(card);
                renderThroughputChart(series);
                renderWipChart(wip);

                setStatus(
                    'warehouse · ' +
                        (card.period || latest.period) +
                        ' · WIP ' +
                        ((card.data && card.data.metrics && card.data.metrics.wip && card.data.metrics.wip.active_total) ||
                            '—')
                );
            })
            .catch(function (err) {
                console.error(err);
                setStatus('Ошибка: ' + err.message, true);
            });
    }

    el('btn-reload').addEventListener('click', function () {
        loadAll();
    });

    loadAll();
})();
