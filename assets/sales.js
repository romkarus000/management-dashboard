/**
 * Отдел продаж: KPI-карточки (пока без данных).
 * Канон C2 / ср.чека: n8n-corp tool_mcp_edprobiz/docs/sales-c2-contract.md
 */
(function () {
    'use strict';

    var FILTERS_URL = './warehouse/filters.json';
    var MONTH_LABELS = [
        'Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн',
        'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'
    ];

    /** Карточки первого экрана — от общего к частному. value: null = пусто. */
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
            hint: 'v2 + qualified_cc=Да · дата op_call_date ÷ неуволенные МОП',
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

    var state = {
        year: 2026,
        month: 8,
        companyId: 0,
        companies: [{ id: 0, name: 'Все' }],
        /** @type {Record<string, number|null>} */
        values: {},
        previous: {}
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

    function fmtValue(value, format) {
        if (value == null || Number.isNaN(Number(value))) return '—';
        var n = Number(value);
        if (format === 'pct') {
            return (Math.round(n * 1000) / 10).toLocaleString('ru-RU') + '%';
        }
        if (format === 'money') {
            return Math.round(n).toLocaleString('ru-RU') + ' ₽';
        }
        return n.toLocaleString('ru-RU');
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
        node.textContent =
            'Период: ' +
            periodLabel() +
            ' · Компания: ' +
            companyLabel() +
            ' · Данные: пока не подключены';
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
                '—'
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

    /**
     * Заглушка загрузки метрик. Позже: MCP / warehouse sales/*.
     * @returns {Promise<void>}
     */
    function loadMetrics() {
        state.values = emptyValues();
        state.previous = emptyValues();
        return Promise.resolve();
    }

    function refresh() {
        setStatus('Загрузка…');
        return loadMetrics()
            .then(function () {
                renderPeriodInfo();
                renderKpis();
                renderTable();
                setStatus('Карточки готовы · значения пока пустые');
            })
            .catch(function (err) {
                setStatus(err.message || String(err), true);
            });
    }

    function loadFilters() {
        return fetch(FILTERS_URL, { cache: 'no-store' })
            .then(function (res) {
                if (!res.ok) throw new Error('filters.json: HTTP ' + res.status);
                return res.json();
            })
            .then(function (data) {
                if (Array.isArray(data.companies) && data.companies.length) {
                    state.companies = data.companies;
                }
            })
            .catch(function () {
                /* оставляем дефолт «Все» */
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
        renderYearMonth();
        setStatus('Инициализация…');
        loadFilters()
            .then(function () {
                renderCompanies();
                return refresh();
            })
            .catch(function (err) {
                setStatus(err.message || String(err), true);
            });
    }

    init();
})();
