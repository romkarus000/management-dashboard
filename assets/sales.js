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
            hint: 'оплаты-заказы ÷ пары клиент×курс (subline) · cat 17/29 ÷ 15/19/45 (+ads)',
            format: 'pct'
        },
        {
            key: 'application_client_sublines',
            label: 'Заявки (клиент×курс)',
            hint: 'Σ уник. клиентов по subline · created · cat 15/19/45 + ads',
            format: 'num'
        },
        {
            key: 'payments',
            label: 'Оплаты (заказы)',
            hint: 'заказы · paid · cat 17/29 · status 20 · price_paid>0',
            format: 'num'
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
            hint: 'ср. (квал.лиды/МОП) по дням 1…N · N=сегодня в тек. месяце',
            format: 'num'
        },
        {
            key: 'sla_first_call',
            label: 'SLA 1 звонка ОП',
            hint: 'ср. LEAST(CRM op_sla, первый timeline) · часы',
            format: 'hours'
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
            hint: 'посл. 7 дней месяца · статус «не берет» + закрыто НДЗ/«Контакт не состоялся» ÷ V2 без «В работе КЦ»',
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

    var VALUE_KEYS = [
        'c2',
        'c2_users',
        'application_client_sublines',
        'application_users',
        'payment_users',
        'applications',
        'payments',
        'avg_check',
        'qual_leads_mop_day',
        'sla_first_call',
        'ndz_share'
    ];

    var state = {
        year: 2026,
        month: 8,
        companyId: 3,
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
            if (metric.key === 'application_client_sublines') {
                hint.textContent =
                    metric.hint +
                    ' · заказов: ' +
                    fmtValue(state.values.applications, 'num') +
                    ' · уник. клиентов: ' +
                    fmtValue(state.values.application_users, 'num');
            } else if (metric.key === 'payments') {
                hint.textContent =
                    metric.hint +
                    ' · уник. клиентов: ' +
                    fmtValue(state.values.payment_users, 'num');
            } else if (metric.key === 'c2') {
                hint.textContent =
                    fmtValue(state.values.payments, 'num') +
                    ' ÷ ' +
                    fmtValue(state.values.application_client_sublines, 'num') +
                    ' · ' +
                    metric.hint;
            } else {
                hint.textContent = metric.hint;
            }

            card.appendChild(label);
            card.appendChild(value);
            card.appendChild(hint);
            grid.appendChild(card);
        });
        renderC2Control();
    }

    function renderC2Control() {
        var list = el('c2-control-list');
        if (!list) return;
        var cur = state.values;
        var prev = state.previous;
        var rows = [
            {
                label: 'Заявки · клиент×курс',
                cur: cur.application_client_sublines,
                prev: prev.application_client_sublines,
                extra:
                    'заказов: ' +
                    fmtValue(cur.applications, 'num') +
                    ' · уник. клиентов: ' +
                    fmtValue(cur.application_users, 'num')
            },
            {
                label: 'Оплаты · заказы',
                cur: cur.payments,
                prev: prev.payments,
                extra:
                    'уник. клиентов: ' +
                    fmtValue(cur.payment_users, 'num')
            },
            {
                label: 'C2 = заказы ÷ (клиент×курс)',
                cur: cur.c2,
                prev: prev.c2,
                format: 'pct',
                extra:
                    fmtValue(cur.payments, 'num') +
                    ' / ' +
                    fmtValue(cur.application_client_sublines, 'num')
            },
            {
                label: 'C2 (старый) · уник. клиенты',
                cur: cur.c2_users,
                prev: prev.c2_users,
                format: 'pct',
                extra:
                    fmtValue(cur.payment_users, 'num') +
                    ' / ' +
                    fmtValue(cur.application_users, 'num')
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
            if (k === 'sla_first_call') {
                out[k] = row.sla_first_call_hours == null ? null : Number(row.sla_first_call_hours);
            } else {
                out[k] = row[k] == null ? null : Number(row[k]);
            }
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
