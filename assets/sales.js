/**
 * Отдел продаж: KPI из warehouse/sales/kpis/{YYYY-MM}.json
 * Канон: docs/sales-warehouse-contract.md + n8n-corp sales-c2-contract.md
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
            key: 'c2',
            label: 'C2 в оплату',
            hint: 'оплаты ÷ заявки · cat 17/29 ÷ 15/19/45 (+ads)',
            format: 'pct'
        },
        {
            key: 'avg_check',
            label: 'Средний чек',
            hint: 'чистый итог ÷ завершённые+оплаченные · reports/main',
            format: 'money'
        },
        {
            key: 'qual_leads_mop_day',
            label: 'Квал. лидов на МОП / день',
            hint: 'v2 + Да · op_call_date · ОП-отделы Академии (без КЦ)',
            format: 'num'
        },
        {
            key: 'sla_first_call',
            label: 'SLA 1 звонка',
            hint: 'скоро',
            format: 'pct'
        },
        {
            key: 'target_call_duration',
            label: 'Длит. целевого звонка',
            hint: 'скоро',
            format: 'num'
        },
        {
            key: 'target_tariff_share',
            label: 'Доля целевых тарифов',
            hint: 'в выручке МОПа · скоро',
            format: 'pct'
        },
        {
            key: 'lead_redistribution',
            label: 'Перераспределение лидов',
            hint: 'скоро',
            format: 'pct'
        },
        {
            key: 'ndz_share',
            label: '% недозвона (НДЗ)',
            hint: 'скоро',
            format: 'pct'
        },
        {
            key: 'payroll',
            label: 'ФОТ и подрядчики',
            hint: 'скоро',
            format: 'money'
        },
        {
            key: 'service_costs',
            label: 'Расходы на сервисы',
            hint: 'скоро',
            format: 'money'
        },
        {
            key: 'dkr',
            label: 'ДКР',
            hint: 'скоро',
            format: 'money'
        },
        {
            key: 'headcount',
            label: 'Людей',
            hint: 'скоро',
            format: 'num'
        }
    ];

    var VALUE_KEYS = ['c2', 'avg_check', 'qual_leads_mop_day'];

    var state = {
        year: 2026,
        month: 8,
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
        METRICS.forEach(function (m) {
            out[m.key] = null;
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
        if (format === 'money') {
            return Math.round(n).toLocaleString('ru-RU') + ' ₽';
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
            ' · Данные: sales.kpis' +
            src;
    }

    function renderKpis() {
        var grid = el('kpi-grid');
        if (!grid) return;
        grid.innerHTML = '';
        METRICS.forEach(function (metric, idx) {
            var card = document.createElement('div');
            card.className = 'management-dashboard__kpi';
            if (idx < 4) {
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
            hint.textContent = metric.hint;

            card.appendChild(label);
            card.appendChild(value);
            card.appendChild(hint);
            grid.appendChild(card);
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
        VALUE_KEYS.forEach(function (k) {
            out[k] = row[k] == null ? null : Number(row[k]);
        });
        return out;
    }

    function fetchJson(url) {
        return fetch(url, { cache: 'no-store' }).then(function (res) {
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(url + ': HTTP ' + res.status);
            var ctype = (res.headers.get('content-type') || '').toLowerCase();
            return res.text().then(function (text) {
                var trimmed = (text || '').trim();
                // Нет файла: nginx/SPA отдаёт HTML 200 вместо 404.
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
        return fetchJson(WAREHOUSE_BASE + '/sales/kpis/' + ym + '.json');
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
                throw new Error('Нет sales.kpis для ' + curYm + ' — запусти sync-sales-warehouse.mjs');
            }
            var curRow = pickCompanyRow(curFile.data && curFile.data.byCompany, state.companyId);
            var prevRow = prevFile
                ? pickCompanyRow(prevFile.data && prevFile.data.byCompany, state.companyId)
                : null;
            // Если выбранной компании нет в срезе — явно пусто, не подменяем «Все»
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
                    setStatus('Для этой компании среза нет (есть 0/Академия) — пересинхронизируй', true);
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
            var ds = man && man.datasets && man.datasets['sales.kpis'];
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
