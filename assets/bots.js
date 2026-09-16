/**
 * Боты: воронки из warehouse/bots/funnel.
 * Primary sync: n8n `[Bots] Funnel Metrics Daily` → HTTP ingest.
 */
(function () {
    'use strict';

    var WAREHOUSE_BASE = window.MGMT_WAREHOUSE_BASE || './warehouse';
    var DATASET_ID = 'bots.funnel';
    var DATASET_PATH = 'bots/funnel';

    var FUNNEL_STAGES = [
        { key: 'entered', label: 'Зашли в бот' },
        { key: 'survey', label: 'Прошли анкету' },
        { key: 'goals_set', label: 'Поставили цели' },
        { key: 'goals_achieved', label: 'Достигли цели' },
        { key: 'completed', label: 'Завершили работу' }
    ];

    var BOT_META = [
        { id: 'all', label: 'Все' },
        { id: 'pomogator', label: 'Помогатор' },
        { id: 'dostigator_sp', label: 'Достигатор СП' },
        { id: 'dostigator_vr', label: 'Достигатор ВР' }
    ];

    var state = {
        period: null,
        bot: 'all',
        periods: [],
        cache: {},
        charts: {}
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

    function fmtInt(n) {
        if (n == null) return '—';
        return Number(n).toLocaleString('ru-RU');
    }

    function emptyFunnel() {
        return { entered: 0, survey: 0, goals_set: 0, goals_achieved: 0, completed: 0 };
    }

    function emptyBot(id, label) {
        return {
            id: id,
            label: label || id,
            participants_total: 0,
            participants_active: 0,
            participants_churned: 0,
            participants_completed: 0,
            funnel_active: emptyFunnel(),
            funnel_churned: emptyFunnel()
        };
    }

    function sumBots(bots) {
        var out = emptyBot('all', 'Все');
        (bots || []).forEach(function (b) {
            out.participants_total += b.participants_total || 0;
            out.participants_active += b.participants_active || 0;
            out.participants_churned += b.participants_churned || 0;
            out.participants_completed += b.participants_completed || 0;
            FUNNEL_STAGES.forEach(function (s) {
                out.funnel_active[s.key] += (b.funnel_active && b.funnel_active[s.key]) || 0;
                out.funnel_churned[s.key] += (b.funnel_churned && b.funnel_churned[s.key]) || 0;
            });
        });
        return out;
    }

    function pickBot(data) {
        var bots = (data && data.bots) || [];
        if (state.bot === 'all') return sumBots(bots);
        for (var i = 0; i < bots.length; i++) {
            if (bots[i].id === state.bot) return bots[i];
        }
        return emptyBot(state.bot);
    }

    function fetchJson(url) {
        return fetch(url, { cache: 'no-store' }).then(function (r) {
            if (!r.ok) throw new Error(r.status + ' ' + url);
            return r.json();
        });
    }

    function moscowDateString(d) {
        d = d || new Date();
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Moscow',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).format(d);
    }

    function probeFunnelPeriods() {
        // Fallback, если manifest перетёрли деплоем warehouse без bots.funnel
        var candidates = [];
        var base = new Date();
        for (var i = 0; i < 14; i++) {
            var d = new Date(base.getTime() - i * 86400000);
            candidates.push(moscowDateString(d));
        }
        return Promise.all(
            candidates.map(function (period) {
                var url = WAREHOUSE_BASE + '/' + DATASET_PATH + '/' + period + '.json';
                return fetch(url, { method: 'HEAD', cache: 'no-store' })
                    .then(function (r) {
                        return r.ok ? period : null;
                    })
                    .catch(function () {
                        return null;
                    });
            })
        ).then(function (found) {
            return found.filter(Boolean).sort();
        });
    }

    function loadManifest() {
        return fetchJson(WAREHOUSE_BASE + '/manifest.json').then(function (m) {
            var ds = (m.datasets && m.datasets[DATASET_ID]) || null;
            var periods = ds && ds.periods ? Object.keys(ds.periods).sort() : [];
            var loadPeriods = periods.length
                ? Promise.resolve({ periods: periods, ds: ds, via: 'manifest' })
                : probeFunnelPeriods().then(function (probed) {
                      return { periods: probed, ds: null, via: probed.length ? 'probe' : 'none' };
                  });
            return loadPeriods.then(function (res) {
                state.periods = res.periods;
                if (!state.period || state.periods.indexOf(state.period) < 0) {
                    state.period = state.periods.length ? state.periods[state.periods.length - 1] : null;
                }
                var info = el('warehouse-info');
                if (info) {
                    if (state.period) {
                        var cover =
                            res.ds && res.ds.coverage
                                ? ' · покрытие ' + res.ds.coverage.from + '…' + res.ds.coverage.to
                                : '';
                        var note = res.via === 'probe' ? ' · (файлы, manifest без bots.funnel)' : '';
                        info.textContent = 'Снимок: ' + state.period + cover + note;
                    } else {
                        info.textContent =
                            'Нет снимков bots.funnel в warehouse — запусти n8n [Bots] Funnel Metrics Daily';
                    }
                }
                return state.periods;
            });
        });
    }

    function loadPeriod(period) {
        if (!period) return Promise.resolve(null);
        if (state.cache[period]) return Promise.resolve(state.cache[period]);
        var url = WAREHOUSE_BASE + '/' + DATASET_PATH + '/' + period + '.json';
        return fetchJson(url).then(function (env) {
            state.cache[period] = env;
            return env;
        });
    }

    function renderChips(containerId, items, activeId, onClick) {
        var root = el(containerId);
        if (!root) return;
        root.innerHTML = '';
        items.forEach(function (it) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'management-dashboard__chip' + (it.id === activeId ? ' is-active' : '');
            btn.textContent = it.label;
            btn.addEventListener('click', function () {
                onClick(it.id);
            });
            root.appendChild(btn);
        });
    }

    function renderFilters() {
        renderChips(
            'filter-period',
            state.periods.map(function (p) {
                return { id: p, label: p };
            }),
            state.period,
            function (id) {
                state.period = id;
                refresh();
            }
        );
        renderChips('filter-bot', BOT_META, state.bot, function (id) {
            state.bot = id;
            refresh();
        });
    }

    function renderKpi(bot) {
        var root = el('kpi-grid');
        if (!root) return;
        var cards = [
            { label: 'Всего участников', value: bot.participants_total },
            { label: 'Активные', value: bot.participants_active },
            { label: 'Отпавшие', value: bot.participants_churned },
            { label: 'Завершили', value: bot.participants_completed }
        ];
        root.innerHTML = cards
            .map(function (c) {
                return (
                    '<article class="management-dashboard__kpi">' +
                    '<div class="management-dashboard__kpi-label">' +
                    c.label +
                    '</div>' +
                    '<div class="management-dashboard__kpi-value">' +
                    fmtInt(c.value) +
                    '</div>' +
                    '</article>'
                );
            })
            .join('');
    }

    function funnelRows(funnel) {
        var f = funnel || emptyFunnel();
        return FUNNEL_STAGES.map(function (s) {
            return { label: s.label, value: f[s.key] || 0 };
        });
    }

    function renderTable(containerId, rows) {
        var root = el(containerId);
        if (!root) return;
        var max = rows.reduce(function (m, r) {
            return Math.max(m, r.value || 0);
        }, 0) || 1;
        root.innerHTML =
            '<table class="management-dashboard__table"><thead><tr><th>Этап</th><th>Кол-во</th><th></th></tr></thead><tbody>' +
            rows
                .map(function (r) {
                    var pct = Math.round((100 * (r.value || 0)) / max);
                    return (
                        '<tr><td>' +
                        r.label +
                        '</td><td>' +
                        fmtInt(r.value) +
                        '</td><td><div class="management-dashboard__bar" style="width:' +
                        pct +
                        '%"></div></td></tr>'
                    );
                })
                .join('') +
            '</tbody></table>';
    }

    function renderChart(canvasId, key, rows, color) {
        var canvas = el(canvasId);
        if (!canvas || typeof Chart === 'undefined') return;
        if (state.charts[key]) {
            state.charts[key].destroy();
            state.charts[key] = null;
        }
        state.charts[key] = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: rows.map(function (r) {
                    return r.label;
                }),
                datasets: [
                    {
                        label: 'Участники',
                        data: rows.map(function (r) {
                            return r.value;
                        }),
                        backgroundColor: color,
                        borderRadius: 4
                    }
                ]
            },
            options: {
                responsive: true,
                plugins: { legend: { display: false } },
                scales: {
                    y: { beginAtZero: true, ticks: { precision: 0 } }
                }
            }
        });
    }

    function refresh() {
        renderFilters();
        if (!state.period) {
            setStatus('Нет данных bots.funnel', true);
            renderKpi(emptyBot('all'));
            renderTable('table-active', funnelRows(null));
            renderTable('table-churned', funnelRows(null));
            return;
        }
        setStatus('Загрузка ' + state.period + '…');
        loadPeriod(state.period)
            .then(function (env) {
                var bot = pickBot(env && env.data);
                renderKpi(bot);
                var activeRows = funnelRows(bot.funnel_active);
                var churnRows = funnelRows(bot.funnel_churned);
                renderTable('table-active', activeRows);
                renderTable('table-churned', churnRows);
                renderChart('chart-active', 'active', activeRows, 'rgba(46, 125, 90, 0.75)');
                renderChart('chart-churned', 'churned', churnRows, 'rgba(180, 83, 49, 0.75)');
                setStatus('Ок · ' + state.period + ' · ' + (bot.label || state.bot));
            })
            .catch(function (e) {
                setStatus(String(e.message || e), true);
            });
    }

    function init() {
        el('btn-reload').addEventListener('click', function () {
            state.cache = {};
            loadManifest().then(refresh).catch(function (e) {
                setStatus(String(e.message || e), true);
            });
        });
        loadManifest()
            .then(refresh)
            .catch(function (e) {
                setStatus(String(e.message || e), true);
                renderFilters();
            });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
