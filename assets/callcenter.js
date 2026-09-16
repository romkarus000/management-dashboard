/**
 * Колл-центр: KPI из warehouse/cc/kpis/{YYYY-MM}.json
 * Канон: docs/cc-warehouse-contract.md
 */
(function () {
    'use strict';

    var WAREHOUSE_BASE = window.MGMT_WAREHOUSE_BASE || './warehouse';
    var FILTERS_URL = WAREHOUSE_BASE + '/filters.json';
    var MANIFEST_URL = WAREHOUSE_BASE + '/manifest.json';
    var MONTH_LABELS = [
        'Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн',
        'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'
    ];

    var METRICS = [
        {
            key: 'qualification_rate',
            label: '% квалификации',
            hint: 'квал. в месяце ÷ первое касание КЦ в том же месяце',
            format: 'pct'
        },
        {
            key: 'sla_first_call_avg_min',
            label: 'SLA 1 звонка · среднее',
            hint: 'исключены звонки в нерабочее время и возвращенные из ОП',
            format: 'min'
        },
        {
            key: 'sla_first_call_median_min',
            label: 'SLA 1 звонка · медиана',
            hint: 'исключены звонки в нерабочее время и возвращенные из ОП',
            format: 'min'
        },
        {
            key: 'dial_rate',
            label: '% дозвона',
            hint: 'скоро · этап «В работе КЦ»',
            format: 'pct'
        }
    ];

    var VALUE_KEYS = [
        'qualification_rate',
        'cc_touched',
        'cc_qualified_same_month',
        'sla_first_call_avg_min',
        'sla_first_call_median_min',
        'sla_orders_with_call',
        'sla_p70_min',
        'sla_p90_min',
        'sla_within_5min',
        'sla_within_15min',
        'sla_within_1h',
        'sla_src_order',
        'sla_src_user',
        'sla_src_unbound',
        'dial_rate'
    ];

    var state = {
        year: 2026,
        month: 9,
        companyId: 0,
        companies: [{ id: 0, name: 'Все' }],
        availablePeriods: [],
        values: {},
        previous: {},
        meta: null
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

    function emptyValues() {
        var out = {};
        VALUE_KEYS.forEach(function (k) {
            out[k] = null;
        });
        METRICS.forEach(function (m) {
            if (!(m.key in out)) out[m.key] = null;
        });
        return out;
    }

    function ymKey(year, month) {
        return year + '-' + String(month).padStart(2, '0');
    }

    function prevYm(year, month) {
        if (month <= 1) return { year: year - 1, month: 12 };
        return { year: year, month: month - 1 };
    }

    function fmtValue(value, format) {
        if (value == null || Number.isNaN(Number(value))) return '—';
        var n = Number(value);
        if (format === 'pct') {
            return (Math.round(n * 1000) / 10).toLocaleString('ru-RU') + '%';
        }
        if (format === 'hours') {
            return (Math.round(n * 10) / 10).toLocaleString('ru-RU') + ' ч';
        }
        if (format === 'min') {
            return (Math.round(n * 10) / 10).toLocaleString('ru-RU') + ' мин';
        }
        return Math.round(n).toLocaleString('ru-RU');
    }

    function fmtDelta(cur, prev, format) {
        if (cur == null || prev == null || Number.isNaN(Number(cur)) || Number.isNaN(Number(prev))) {
            return '—';
        }
        var c = Number(cur);
        var p = Number(prev);
        if (format === 'pct') {
            var dpp = (c - p) * 100;
            var sign = dpp > 0 ? '+' : '';
            return sign + (Math.round(dpp * 10) / 10).toLocaleString('ru-RU') + ' п.п.';
        }
        if (format === 'min' || format === 'hours') {
            var d = c - p;
            var s2 = d > 0 ? '+' : '';
            return s2 + (Math.round(d * 10) / 10).toLocaleString('ru-RU') + (format === 'min' ? ' мин' : ' ч');
        }
        if (p === 0) return '—';
        var pct = (100 * (c - p)) / p;
        var s = pct > 0 ? '+' : '';
        return s + (Math.round(pct * 10) / 10).toLocaleString('ru-RU') + '%';
    }

    function periodLabel() {
        return MONTH_LABELS[state.month - 1] + ' ' + state.year;
    }

    function companyLabel() {
        var found = state.companies.find(function (c) {
            return Number(c.id) === Number(state.companyId);
        });
        return found ? found.name : 'Все';
    }

    function renderPeriodInfo() {
        var node = el('period-info');
        if (!node) return;
        var src = state.meta && state.meta.fetchedAt
            ? ' · warehouse ' + state.meta.fetchedAt.slice(0, 16).replace('T', ' ')
            : '';
        node.textContent =
            'Период: ' +
            periodLabel() +
            ' · Компания: ' +
            companyLabel() +
            ' · Данные: cc.kpis' +
            src;
    }

    function renderKpis() {
        var grid = el('kpi-grid');
        if (!grid) return;
        grid.innerHTML = '';
        METRICS.forEach(function (metric, idx) {
            var card = document.createElement('div');
            card.className = 'management-dashboard__kpi';
            if (idx === 0) {
                card.classList.add('management-dashboard__kpi--overview');
            }

            var label = document.createElement('div');
            label.className = 'management-dashboard__kpi-label';
            label.textContent = metric.label;

            var value = document.createElement('div');
            value.className = 'management-dashboard__kpi-value';
            value.textContent = fmtValue(state.values[metric.key], metric.format);

            var hint = document.createElement('div');
            hint.className = 'management-dashboard__kpi-hint';
            if (metric.key === 'qualification_rate') {
                hint.textContent =
                    fmtValue(state.values.cc_qualified_same_month, 'num') +
                    ' ÷ ' +
                    fmtValue(state.values.cc_touched, 'num') +
                    ' · ' +
                    metric.hint;
            } else if (
                metric.key === 'sla_first_call_avg_min' ||
                metric.key === 'sla_first_call_median_min'
            ) {
                hint.textContent =
                    metric.hint +
                    ' · заказов со звонком: ' +
                    fmtValue(state.values.sla_orders_with_call, 'num');
            } else {
                hint.textContent = metric.hint;
            }

            card.appendChild(label);
            card.appendChild(value);
            card.appendChild(hint);
            grid.appendChild(card);
        });
        renderQualControl();
        renderSlaControl();
    }

    function renderQualControl() {
        var list = el('qual-control-list');
        if (!list) return;
        var cur = state.values;
        var prev = state.previous;
        var rows = [
            {
                label: 'Первое касание КЦ (знаменатель)',
                cur: cur.cc_touched,
                prev: prev.cc_touched,
                extra: 'was_in_cc + cc_sla_first_touch_at в месяце'
            },
            {
                label: 'Квалифицированы в том же месяце',
                cur: cur.cc_qualified_same_month,
                prev: prev.cc_qualified_same_month,
                extra: 'из когорты · qualified_cc + cc_qualification_date'
            },
            {
                label: '% квалификации',
                cur: cur.qualification_rate,
                prev: prev.qualification_rate,
                format: 'pct',
                extra:
                    fmtValue(cur.cc_qualified_same_month, 'num') +
                    ' / ' +
                    fmtValue(cur.cc_touched, 'num')
            }
        ];
        list.innerHTML = '';
        rows.forEach(function (row) {
            var li = document.createElement('li');
            li.className = 'sales-c2-control__item';
            var format = row.format || 'num';
            li.innerHTML =
                '<span class="sales-c2-control__label">' +
                row.label +
                '</span>' +
                '<span class="sales-c2-control__value">' +
                fmtValue(row.cur, format) +
                '</span>' +
                '<span class="sales-c2-control__delta">' +
                fmtDelta(row.cur, row.prev, format) +
                '</span>' +
                '<span class="sales-c2-control__extra">' +
                row.extra +
                '</span>';
            list.appendChild(li);
        });
    }

    function renderSlaControl() {
        var list = el('sla-control-list');
        if (!list) return;
        var cur = state.values;
        var prev = state.previous;
        var rows = [
            {
                label: 'Заказов со звонком КЦ',
                cur: cur.sla_orders_with_call,
                prev: prev.sla_orders_with_call,
                extra: 'v2 · was_in_cc · без returned_from_op · 09:00–20:00'
            },
            {
                label: 'Среднее',
                cur: cur.sla_first_call_avg_min,
                prev: prev.sla_first_call_avg_min,
                format: 'min',
                extra: 'минут до 1-го звонка dept=47'
            },
            {
                label: 'Медиана (p50)',
                cur: cur.sla_first_call_median_min,
                prev: prev.sla_first_call_median_min,
                format: 'min',
                extra: 'p50'
            },
            {
                label: 'p70',
                cur: cur.sla_p70_min,
                prev: prev.sla_p70_min,
                format: 'min',
                extra: 'деталка'
            },
            {
                label: 'p90',
                cur: cur.sla_p90_min,
                prev: prev.sla_p90_min,
                format: 'min',
                extra: 'деталка'
            },
            {
                label: '≤5 мин',
                cur: cur.sla_within_5min,
                prev: prev.sla_within_5min,
                extra: 'деталка'
            },
            {
                label: '≤15 мин',
                cur: cur.sla_within_15min,
                prev: prev.sla_within_15min,
                extra: 'деталка'
            },
            {
                label: '≤1 ч',
                cur: cur.sla_within_1h,
                prev: prev.sla_within_1h,
                extra: 'деталка'
            },
            {
                label: 'Источник: заказ / user / unbound',
                cur: null,
                prev: null,
                extra:
                    fmtValue(cur.sla_src_order, 'num') +
                    ' / ' +
                    fmtValue(cur.sla_src_user, 'num') +
                    ' / ' +
                    fmtValue(cur.sla_src_unbound, 'num')
            }
        ];
        list.innerHTML = '';
        rows.forEach(function (row) {
            var li = document.createElement('li');
            li.className = 'sales-c2-control__item';
            var format = row.format || 'num';
            li.innerHTML =
                '<span class="sales-c2-control__label">' +
                row.label +
                '</span>' +
                '<span class="sales-c2-control__value">' +
                (row.cur == null && row.prev == null ? '—' : fmtValue(row.cur, format)) +
                '</span>' +
                '<span class="sales-c2-control__delta">' +
                (row.cur == null ? '—' : fmtDelta(row.cur, row.prev, format)) +
                '</span>' +
                '<span class="sales-c2-control__extra">' +
                row.extra +
                '</span>';
            list.appendChild(li);
        });
    }

    function renderTable() {
        var body = el('metrics-table-body');
        if (!body) return;
        body.innerHTML = '';
        METRICS.forEach(function (metric) {
            var tr = document.createElement('tr');
            var cells = [
                metric.label,
                fmtValue(state.values[metric.key], metric.format),
                fmtValue(state.previous[metric.key], metric.format),
                fmtDelta(state.values[metric.key], state.previous[metric.key], metric.format)
            ];
            cells.forEach(function (text, i) {
                var td = document.createElement('td');
                if (i > 0) td.className = 'is-num';
                td.textContent = text;
                tr.appendChild(td);
            });
            body.appendChild(tr);
        });
    }

    function renderChips(containerId, items, selected, onPick) {
        var wrap = el(containerId);
        if (!wrap) return;
        wrap.innerHTML = '';
        items.forEach(function (item) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'management-dashboard__chip';
            if (item.value === selected) btn.classList.add('is-active');
            btn.textContent = item.label;
            btn.addEventListener('click', function () {
                onPick(item.value);
            });
            wrap.appendChild(btn);
        });
    }

    function renderYearMonth() {
        var years = [2025, 2026];
        renderChips(
            'filter-year-buttons',
            years.map(function (y) {
                return { value: y, label: String(y) };
            }),
            state.year,
            function (y) {
                state.year = y;
                renderYearMonth();
                refresh();
            }
        );
        renderChips(
            'filter-month-buttons',
            MONTH_LABELS.map(function (label, i) {
                return { value: i + 1, label: label };
            }),
            state.month,
            function (m) {
                state.month = m;
                renderYearMonth();
                refresh();
            }
        );
    }

    function renderCompanies() {
        var select = el('filter-company');
        if (!select) return;
        select.innerHTML = '';
        state.companies.forEach(function (c) {
            var opt = document.createElement('option');
            opt.value = String(c.id);
            opt.textContent = c.name;
            if (Number(c.id) === Number(state.companyId)) opt.selected = true;
            select.appendChild(opt);
        });
    }

    function pickCompanyRow(byCompany, companyId) {
        if (!byCompany || typeof byCompany !== 'object') return null;
        var key = String(companyId);
        if (byCompany[key]) return byCompany[key];
        if (byCompany['0']) return byCompany['0'];
        return null;
    }

    function rowToValues(row) {
        var out = emptyValues();
        if (!row) return out;
        out.cc_touched = row.cc_touched == null ? null : Number(row.cc_touched);
        out.cc_qualified_same_month =
            row.cc_qualified_same_month == null ? null : Number(row.cc_qualified_same_month);
        out.qualification_rate =
            row.qualification_rate == null ? null : Number(row.qualification_rate);
        if (
            out.qualification_rate == null &&
            out.cc_touched != null &&
            out.cc_touched > 0 &&
            out.cc_qualified_same_month != null
        ) {
            out.qualification_rate = out.cc_qualified_same_month / out.cc_touched;
        }
        out.sla_first_call_avg_min =
            row.sla_first_call_avg_min == null ? null : Number(row.sla_first_call_avg_min);
        out.sla_first_call_median_min =
            row.sla_first_call_median_min == null ? null : Number(row.sla_first_call_median_min);
        out.sla_orders_with_call =
            row.sla_orders_with_call == null ? null : Number(row.sla_orders_with_call);
        out.sla_p70_min = row.sla_p70_min == null ? null : Number(row.sla_p70_min);
        out.sla_p90_min = row.sla_p90_min == null ? null : Number(row.sla_p90_min);
        out.sla_within_5min = row.sla_within_5min == null ? null : Number(row.sla_within_5min);
        out.sla_within_15min = row.sla_within_15min == null ? null : Number(row.sla_within_15min);
        out.sla_within_1h = row.sla_within_1h == null ? null : Number(row.sla_within_1h);
        out.sla_src_order = row.sla_src_order == null ? null : Number(row.sla_src_order);
        out.sla_src_user = row.sla_src_user == null ? null : Number(row.sla_src_user);
        out.sla_src_unbound = row.sla_src_unbound == null ? null : Number(row.sla_src_unbound);
        out.dial_rate = row.dial_rate == null ? null : Number(row.dial_rate);
        return out;
    }

    function fetchJson(url) {
        return fetch(url, { cache: 'no-store' }).then(function (res) {
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
            var ctype = (res.headers.get('content-type') || '').toLowerCase();
            return res.text().then(function (text) {
                var trimmed = (text || '').trim();
                if (!trimmed || trimmed.charAt(0) === '<') return null;
                if (ctype && ctype.indexOf('json') === -1 && trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') {
                    return null;
                }
                try {
                    return JSON.parse(trimmed);
                } catch (err) {
                    return null;
                }
            });
        });
    }

    function loadPeriodFile(ym) {
        return fetchJson(WAREHOUSE_BASE + '/cc/kpis/' + ym + '.json');
    }

    function loadMetrics() {
        var curYm = ymKey(state.year, state.month);
        var prev = prevYm(state.year, state.month);
        var prevKey = ymKey(prev.year, prev.month);

        return Promise.all([loadPeriodFile(curYm), loadPeriodFile(prevKey)]).then(function (pair) {
            var curFile = pair[0];
            var prevFile = pair[1];
            if (!curFile) {
                state.values = emptyValues();
                state.previous = emptyValues();
                state.meta = null;
                throw new Error('Нет cc.kpis для ' + curYm + ' — запусти sync-cc-warehouse.mjs');
            }
            var curRow = pickCompanyRow(curFile.data && curFile.data.byCompany, state.companyId);
            var prevRow = prevFile
                ? pickCompanyRow(prevFile.data && prevFile.data.byCompany, state.companyId)
                : null;
            if (
                state.companyId !== 0 &&
                curFile.data &&
                curFile.data.byCompany &&
                !curFile.data.byCompany[String(state.companyId)]
            ) {
                state.values = emptyValues();
                state.previous = emptyValues();
                state.meta = { fetchedAt: curFile.fetchedAt, missingCompany: true };
                return;
            }
            state.values = rowToValues(curRow);
            state.previous = rowToValues(prevRow);
            state.meta = {
                fetchedAt: curFile.fetchedAt,
                checksum: curFile.checksum,
                period: curFile.period
            };
        });
    }

    function refresh() {
        setStatus('Загрузка…');
        return loadMetrics()
            .then(function () {
                renderPeriodInfo();
                renderKpis();
                renderTable();
                if (state.meta && state.meta.missingCompany) {
                    setStatus('Для этой компании среза нет', true);
                } else {
                    setStatus('Готово · ' + periodLabel());
                }
            })
            .catch(function (err) {
                renderPeriodInfo();
                renderKpis();
                renderTable();
                setStatus(err.message || String(err), true);
            });
    }

    function loadFilters() {
        return fetchJson(FILTERS_URL).then(function (data) {
            if (data && Array.isArray(data.companies) && data.companies.length) {
                state.companies = data.companies;
            }
        });
    }

    function loadManifestPeriods() {
        return fetchJson(MANIFEST_URL).then(function (man) {
            var ds = man && man.datasets && man.datasets['cc.kpis'];
            if (ds && ds.periods) {
                state.availablePeriods = Object.keys(ds.periods).sort();
                if (state.availablePeriods.length) {
                    var last = state.availablePeriods[state.availablePeriods.length - 1];
                    var parts = last.split('-');
                    state.year = Number(parts[0]);
                    state.month = Number(parts[1]);
                }
            }
        });
    }

    function bind() {
        var company = el('filter-company');
        if (company) {
            company.addEventListener('change', function () {
                state.companyId = Number(company.value) || 0;
                refresh();
            });
        }
        var reload = el('btn-reload');
        if (reload) {
            reload.addEventListener('click', function () {
                refresh();
            });
        }
    }

    function init() {
        state.values = emptyValues();
        state.previous = emptyValues();
        bind();
        setStatus('Инициализация…');
        Promise.all([loadFilters(), loadManifestPeriods()])
            .then(function () {
                renderCompanies();
                renderYearMonth();
                return refresh();
            })
            .catch(function (err) {
                setStatus(err.message || String(err), true);
            });
    }

    init();
})();
