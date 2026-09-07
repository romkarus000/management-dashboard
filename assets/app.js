/**
 * Управленческий дашборд: 3 вкладки + warehouse / live API.
 */
(function () {
    'use strict';

    var API_BASE = window.MGMT_REPORT_API_BASE || '/api/v1/management-report';
    var WAREHOUSE_BASE = window.MGMT_WAREHOUSE_BASE || './warehouse';
    var TOKEN_STORAGE_KEY = 'mgmtReportApiToken';

    var EARNED_KEYS = [
        'purchase', 'registration', 'hybrid', 'adv', 'club',
        'partner_registration', 'product_education', 'overlap'
    ];
    var MANUAL_KEYS = [
        'manual_ambassador',
        'manual_barter_influence',
        'manual_barter_solo',
        'manual_coach',
        'manual_human'
    ];
    var PERIOD_START_YEAR = 2021;
    var MONTH_LABELS = [
        'янв', 'фев', 'март', 'апр', 'май', 'июнь',
        'июль', 'авг', 'сен', 'окт', 'ноя', 'дек'
    ];

    var ACTIVITY_METRICS = {
        total: { label: 'Всего с активностью', hint: 'Партнёры с act = 1', group: 'overview' },
        earned: { label: 'Заработано (всего)', hint: 'Сумма заработанных способов', group: 'overview', computed: true },
        manual: { label: 'Ручная (всего)', hint: 'Нет заработанного способа', group: 'overview' },
        purchase: { label: 'Покупка 100+ баллов', hint: 'Только покупка 100+', group: 'earned' },
        registration: { label: '20+ в 1-ю линию', hint: '20+ регистраций 1 линии', group: 'earned' },
        hybrid: { label: 'Гибрид', hint: 'Сумма баллов+рег ≥ 100', group: 'earned', rare: true },
        adv: { label: 'Реклама в соцсетях', hint: '2+ verified интеграций', group: 'earned' },
        club: { label: 'Клуб', hint: 'Покупка клуба / WAH', group: 'earned' },
        partner_registration: { label: 'Регистрация в ПП (ЗС)', hint: 'Пак ЗС 8485', group: 'earned' },
        product_education: { label: 'Покупка / мероприятие', hint: 'Правило Партнер / мероприятие', group: 'earned' },
        overlap: { label: 'Несколько способов', hint: 'Больше одного earned', group: 'earned', rare: true },
        manual_ambassador: { label: 'Амбассадоры Fitstars', hint: 'parent 4264877 / амбассадор*', group: 'manual' },
        manual_barter_influence: { label: 'Бартер Инфлюенс', hint: 'Группа 3823', group: 'manual' },
        manual_barter_solo: { label: 'Бартер самостоятельный', hint: 'блогер*', group: 'manual' },
        manual_coach: { label: 'Коучи / наставники', hint: 'коуч/наставник/куратор', group: 'manual' },
        manual_human: { label: 'Ручное действие', hint: 'Без других оснований', group: 'manual' }
    };

    var ACTIVITY_TABLE_ORDER = [
        'total', 'earned', 'manual',
        'purchase', 'registration', 'hybrid', 'adv', 'club',
        'partner_registration', 'product_education', 'overlap',
        'manual_ambassador', 'manual_barter_influence', 'manual_barter_solo',
        'manual_coach', 'manual_human'
    ];

    var OWNER_METRICS = [
        { key: 'control_paidSum', label: 'Оплачено' },
        { key: 'control_orderCount', label: 'Заказов' },
        { key: 'marketing_total_money', label: 'Деньги маркетинг' },
        { key: 'marketing_total_profit', label: 'Прибыль маркетинг' }
    ];

    var MAIN_METRICS = [
        { key: 'grossTurnover', label: 'Валовый оборот' },
        { key: 'arrivalCashdesk', label: 'Приход в кассу' },
        { key: 'netTotal', label: 'Net total' },
        { key: 'creditTurnover', label: 'Кредитный оборот' },
        { key: 'bonusTurnover', label: 'Бонусный оборот' },
        { key: 'realRefund', label: 'Реальные возвраты' },
        { key: 'costPriceAmount', label: 'Себестоимость' },
        { key: 'acquiringCharge', label: 'Эквайринг' },
        { key: 'creditCharge', label: 'Кредитные комиссии' }
    ];

    var state = {
        catalog: null,
        payload: null,
        manifest: null,
        loading: false,
        showRare: false,
        selectedYear: null,
        selectedMonth: null,
        activeTab: 'owner',
        source: null
    };

    var totalChart = null;
    var structureChart = null;

    function el(id) {
        return document.getElementById(id);
    }

    function setStatus(message, isError) {
        var node = el('dashboard-status');
        node.textContent = message;
        node.classList.toggle('is-error', !!isError);
    }

    function getToken() {
        var fromQuery = new URLSearchParams(window.location.search).get('token');
        if (fromQuery) {
            localStorage.setItem(TOKEN_STORAGE_KEY, fromQuery);
            return fromQuery;
        }
        return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    }

    function apiGet(path, token) {
        return fetch(API_BASE + path, {
            headers: { Authorization: 'Bearer ' + token }
        }).then(function (response) {
            return response.json();
        }).then(function (payload) {
            if (!payload.success) {
                throw new Error(payload.data && payload.data.error ? payload.data.error : 'API error');
            }
            if (payload.data && payload.data.code) {
                throw new Error(payload.data.error || payload.data.code);
            }
            return payload.data;
        });
    }

    function getClosedMonth() {
        var now = new Date();
        var year = now.getFullYear();
        var month = now.getMonth();
        if (month === 0) {
            return { year: year - 1, month: 12 };
        }
        return { year: year, month: month };
    }

    function getMaxPeriodYear() {
        var nowYear = new Date().getFullYear();
        var selected = state.selectedYear || nowYear;
        return Math.max(nowYear, selected, PERIOD_START_YEAR);
    }

    function formatSelectedPeriod() {
        return state.selectedYear + '-' + String(state.selectedMonth).padStart(2, '0');
    }

    function createPeriodChip(label, active, onClick) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'management-dashboard__chip' + (active ? ' is-active' : '');
        button.textContent = label;
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        button.addEventListener('click', onClick);
        return button;
    }

    function renderPeriodButtons() {
        var yearWrap = el('filter-year-buttons');
        var monthWrap = el('filter-month-buttons');
        yearWrap.innerHTML = '';
        monthWrap.innerHTML = '';

        var maxYear = getMaxPeriodYear();
        for (var year = PERIOD_START_YEAR; year <= maxYear; year += 1) {
            yearWrap.appendChild(createPeriodChip(String(year), year === state.selectedYear, function (value) {
                state.selectedYear = value;
                renderPeriodButtons();
                loadSelectedPeriodPreferWarehouse();
            }.bind(null, year)));
        }

        MONTH_LABELS.forEach(function (label, index) {
            var month = index + 1;
            monthWrap.appendChild(createPeriodChip(label, month === state.selectedMonth, function () {
                state.selectedMonth = month;
                renderPeriodButtons();
                loadSelectedPeriodPreferWarehouse();
            }));
        });
    }

    function readFiltersFromForm() {
        return {
            periodType: 'month',
            period: formatSelectedPeriod(),
            compareMode: el('filter-compare-mode').value,
            compareFrom: el('filter-compare-from').value || null,
            compareTo: el('filter-compare-to').value || null,
            companyId: parseInt(el('filter-company').value, 10) || 0
        };
    }

    function buildQueryString(filters) {
        var params = new URLSearchParams();
        params.set('mainSections', 'profit');
        params.set('ownerSections', 'companyMarketing,partnerActivity');
        params.set('periodType', filters.periodType);
        params.set('period', filters.period);
        params.set('compareMode', filters.compareMode);
        params.set('companyId', String(filters.companyId));
        if (filters.compareMode === 'custom') {
            params.set('compareFrom', filters.compareFrom);
            params.set('compareTo', filters.compareTo);
        }
        return params.toString();
    }

    function fillCompanySelect(catalog) {
        var select = el('filter-company');
        select.innerHTML = '';
        (catalog.companies || []).forEach(function (company) {
            var option = document.createElement('option');
            option.value = String(company.id);
            option.textContent = company.name;
            select.appendChild(option);
        });
    }

    function applyDefaults(defaults) {
        var closed = getClosedMonth();
        state.selectedYear = closed.year;
        state.selectedMonth = closed.month;
        renderPeriodButtons();
        if (defaults) {
            el('filter-compare-mode').value = defaults.compareMode || 'previous';
            el('filter-company').value = String(defaults.companyId || 0);
        }
        toggleCustomCompare();
    }

    function toggleCustomCompare() {
        var visible = el('filter-compare-mode').value === 'custom';
        el('custom-compare-fields').classList.toggle('is-visible', visible);
    }

    function setActiveTab(tabId) {
        state.activeTab = tabId;
        document.querySelectorAll('.management-dashboard__tab').forEach(function (btn) {
            var active = btn.getAttribute('data-tab') === tabId;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        ['owner', 'main', 'activity'].forEach(function (id) {
            var panel = el('panel-' + id);
            var on = id === tabId;
            panel.classList.toggle('is-active', on);
            panel.hidden = !on;
        });
        el('toggle-rare-wrap').classList.toggle('management-dashboard__hidden', tabId !== 'activity');
        if (state.payload) {
            renderDashboard(state.payload, state.source);
        }
    }

    function computeEarned(row) {
        if (!row) {
            return 0;
        }
        return EARNED_KEYS.reduce(function (sum, key) {
            return sum + (Number(row[key]) || 0);
        }, 0);
    }

    function metricValue(row, key) {
        if (!row) {
            return 0;
        }
        if (key === 'earned') {
            return computeEarned(row);
        }
        return Number(row[key]) || 0;
    }

    function isVisibleMetric(key) {
        var meta = ACTIVITY_METRICS[key];
        if (!meta || !meta.rare) {
            return true;
        }
        return state.showRare;
    }

    function formatDelta(delta) {
        if (!delta) {
            return '';
        }
        var abs = delta.absolute;
        var pct = delta.percent;
        var sign = abs > 0 ? '+' : '';
        var text = sign + formatNumber(abs);
        if (pct !== null && pct !== undefined) {
            text += ' (' + sign + pct + '%)';
        }
        return text;
    }

    function deltaClass(delta) {
        if (!delta || delta.absolute === 0) {
            return 'is-neutral';
        }
        return delta.absolute > 0 ? 'is-up' : 'is-down';
    }

    function formatNumber(value) {
        if (value === null || value === undefined || Number.isNaN(Number(value))) {
            return '—';
        }
        var n = Number(value);
        if (Math.abs(n) >= 1000) {
            return Math.round(n).toLocaleString('ru-RU');
        }
        return (Math.round(n * 100) / 100).toLocaleString('ru-RU');
    }

    function getDelta(summaryBlock, key) {
        if (key === 'earned') {
            var current = computeEarned(summaryBlock.current);
            var previous = computeEarned(summaryBlock.previous);
            var abs = current - previous;
            var pct = previous > 0 ? Math.round(abs / previous * 1000) / 10 : (current > 0 ? 100 : 0);
            return {
                absolute: abs,
                percent: previous > 0 ? pct : null,
                meaningful: previous > 0,
                isNew: previous === 0 && current > 0
            };
        }
        return (summaryBlock.delta || {})[key] || null;
    }

    function buildDrillUrl(type) {
        var filters = readFiltersFromForm();
        var params = new URLSearchParams();
        params.set('type', type);
        params.set('periodType', filters.periodType);
        params.set('period', filters.period);
        params.set('companyId', String(filters.companyId || 0));
        var token = getToken();
        if (token) {
            params.set('token', token);
        }
        return 'drill.html?' + params.toString();
    }

    function renderPeriods(block) {
        if (!block || !block.periods) {
            el('periods-info').textContent = '';
            return;
        }
        var current = block.periods.current;
        var previous = block.periods.previous;
        var labels = block.labels || {};
        el('periods-info').textContent =
            'Текущий (' + (labels.current || '') + '): ' + current.from + ' — ' + current.to +
            ' | Сравнение (' + (labels.previous || '') + '): ' + previous.from + ' — ' + previous.to;
    }

    function renderWarehouseInfo() {
        var node = el('warehouse-info');
        if (!state.manifest) {
            node.textContent = '';
            return;
        }
        var ym = formatSelectedPeriod();
        var entry = state.manifest.periods && state.manifest.periods[ym];
        var cov = state.manifest.coverage || {};
        var last = state.manifest.lastRun || {};
        if (entry) {
            node.textContent =
                'Warehouse ' + ym + ': fetched ' + (entry.fetchedAt || '—') +
                ' | checksum ' + (entry.checksum || '—') +
                ' | coverage ' + (cov.from || '?') + '…' + (cov.to || '?') +
                ' (' + (cov.count || 0) + ')' +
                (last.mode ? ' | lastRun=' + last.mode : '');
        } else {
            node.textContent =
                'Warehouse: месяца ' + ym + ' нет. Coverage ' +
                (cov.from || '—') + '…' + (cov.to || '—') +
                '. Нажми «Обновить с API» или запусти sync.';
        }
    }

    function renderGenericKpi(container, summaryBlock, metrics) {
        container.innerHTML = '';
        var current = (summaryBlock && summaryBlock.current) || {};
        metrics.forEach(function (meta) {
            var card = document.createElement('div');
            card.className = 'management-dashboard__kpi management-dashboard__kpi--overview';
            var label = document.createElement('div');
            label.className = 'management-dashboard__kpi-label';
            label.textContent = meta.label;
            var value = document.createElement('div');
            value.className = 'management-dashboard__kpi-value';
            value.textContent = formatNumber(current[meta.key]);
            var delta = document.createElement('div');
            var d = getDelta(summaryBlock || {}, meta.key);
            delta.className = 'management-dashboard__kpi-delta ' + deltaClass(d);
            delta.textContent = formatDelta(d);
            card.appendChild(label);
            card.appendChild(value);
            card.appendChild(delta);
            container.appendChild(card);
        });
    }

    function renderGenericTable(tbody, summaryBlock, metrics) {
        tbody.innerHTML = '';
        var current = (summaryBlock && summaryBlock.current) || {};
        var previous = (summaryBlock && summaryBlock.previous) || {};
        metrics.forEach(function (meta) {
            var d = getDelta(summaryBlock || {}, meta.key) || {};
            var tr = document.createElement('tr');
            var pctText = d.percent !== null && d.percent !== undefined
                ? ((d.absolute > 0 ? '+' : '') + d.percent + '%')
                : '—';
            tr.innerHTML =
                '<td><strong>' + meta.label + '</strong><div class="management-dashboard__table-hint">' + meta.key + '</div></td>' +
                '<td class="is-num">' + formatNumber(current[meta.key]) + '</td>' +
                '<td class="is-num">' + formatNumber(previous[meta.key]) + '</td>' +
                '<td class="is-num ' + deltaClass(d) + '">' + (d.absolute > 0 ? '+' : '') + formatNumber(d.absolute || 0) + '</td>' +
                '<td class="is-num ' + deltaClass(d) + '">' + pctText + '</td>';
            tbody.appendChild(tr);
        });
    }

    function renderActivityKpiCards(container, summaryBlock, keys) {
        container.innerHTML = '';
        var current = (summaryBlock && summaryBlock.current) || {};
        keys.forEach(function (key) {
            if (!isVisibleMetric(key)) {
                return;
            }
            var meta = ACTIVITY_METRICS[key] || { label: key, group: 'overview' };
            var card = document.createElement('div');
            card.className = 'management-dashboard__kpi management-dashboard__kpi--' + (meta.group || 'overview');
            if (!meta.computed) {
                card.classList.add('management-dashboard__kpi--link');
                card.title = (meta.hint || meta.label) + ' — открыть drill';
                card.addEventListener('click', function () {
                    window.location.href = buildDrillUrl(key);
                });
            }
            var label = document.createElement('div');
            label.className = 'management-dashboard__kpi-label';
            label.textContent = meta.label;
            label.title = meta.hint || '';
            var value = document.createElement('div');
            value.className = 'management-dashboard__kpi-value';
            value.textContent = String(metricValue(current, key));
            var delta = document.createElement('div');
            delta.className = 'management-dashboard__kpi-delta ' + deltaClass(getDelta(summaryBlock, key));
            delta.textContent = formatDelta(getDelta(summaryBlock, key));
            card.appendChild(label);
            card.appendChild(value);
            card.appendChild(delta);
            if (meta.hint) {
                var hint = document.createElement('div');
                hint.className = 'management-dashboard__kpi-hint';
                hint.textContent = meta.hint;
                card.appendChild(hint);
            }
            container.appendChild(card);
        });
    }

    function renderTotalChart(summaryBlock) {
        var canvas = el('activity-total-chart');
        if (!canvas || state.activeTab !== 'activity') {
            return;
        }
        var current = summaryBlock.current || {};
        var previous = summaryBlock.previous || {};
        if (totalChart) {
            totalChart.destroy();
        }
        totalChart = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: ['Total', 'Заработано', 'Ручная'],
                datasets: [
                    {
                        label: 'Текущий',
                        data: [
                            metricValue(current, 'total'),
                            metricValue(current, 'earned'),
                            metricValue(current, 'manual')
                        ],
                        backgroundColor: '#4338ca'
                    },
                    {
                        label: 'Сравнение',
                        data: [
                            metricValue(previous, 'total'),
                            metricValue(previous, 'earned'),
                            metricValue(previous, 'manual')
                        ],
                        backgroundColor: '#c7d2fe'
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'top' } },
                scales: { y: { beginAtZero: true } }
            }
        });
    }

    function renderStructureChart(summaryBlock) {
        var canvas = el('activity-structure-chart');
        if (!canvas || state.activeTab !== 'activity') {
            return;
        }
        var current = summaryBlock.current || {};
        var keys = EARNED_KEYS.concat(MANUAL_KEYS).filter(isVisibleMetric);
        var labels = [];
        var values = [];
        var colors = [];
        keys.forEach(function (key) {
            var meta = ACTIVITY_METRICS[key];
            labels.push(meta.label);
            values.push(metricValue(current, key));
            colors.push(meta.group === 'manual' ? '#f97316' : '#16a34a');
        });
        if (structureChart) {
            structureChart.destroy();
        }
        structureChart = new Chart(canvas, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{ label: 'Людей', data: values, backgroundColor: colors }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            afterLabel: function (ctx) {
                                var key = keys[ctx.dataIndex];
                                return ACTIVITY_METRICS[key] ? ACTIVITY_METRICS[key].hint : '';
                            }
                        }
                    }
                },
                scales: {
                    x: { ticks: { maxRotation: 45, minRotation: 25 } },
                    y: { beginAtZero: true }
                }
            }
        });
    }

    function renderActivityTable(summaryBlock) {
        var tbody = el('activity-table-body');
        tbody.innerHTML = '';
        var current = summaryBlock.current || {};
        var previous = summaryBlock.previous || {};
        ACTIVITY_TABLE_ORDER.forEach(function (key) {
            if (!isVisibleMetric(key)) {
                return;
            }
            var meta = ACTIVITY_METRICS[key];
            var tr = document.createElement('tr');
            if (meta.group === 'manual') {
                tr.className = 'is-manual';
            } else if (meta.group === 'earned') {
                tr.className = 'is-earned';
            }
            var cur = metricValue(current, key);
            var prev = metricValue(previous, key);
            var delta = getDelta(summaryBlock, key) || {};
            var pctText = delta.percent !== null && delta.percent !== undefined
                ? ((delta.absolute > 0 ? '+' : '') + delta.percent + '%')
                : '—';
            tr.innerHTML =
                '<td><strong>' + meta.label + '</strong><div class="management-dashboard__table-hint">' + meta.hint + '</div></td>' +
                '<td class="is-num">' + cur + '</td>' +
                '<td class="is-num">' + prev + '</td>' +
                '<td class="is-num ' + deltaClass(delta) + '">' + (delta.absolute > 0 ? '+' : '') + (delta.absolute || 0) + '</td>' +
                '<td class="is-num ' + deltaClass(delta) + '">' + pctText + '</td>';
            tbody.appendChild(tr);
        });
    }

    /**
     * Нормализует payload warehouse / live / snapshot к единому виду {blocks, meta}.
     *
     * @param {Object} raw
     * @returns {Object}
     */
    function normalizePayload(raw) {
        if (raw.blocks) {
            return {
                blocks: raw.blocks,
                meta: raw.meta || {
                    generatedAt: raw.fetchedAt || raw.generatedAt || null,
                    filters: raw.filters || null
                },
                filters: raw.filters || null,
                fetchedAt: raw.fetchedAt || null,
                checksum: raw.checksum || null,
                period: raw.period || null
            };
        }
        return raw;
    }

    function pickPeriodBlock(payload) {
        var owner = (payload.blocks && payload.blocks.owner) || {};
        var main = (payload.blocks && payload.blocks.main) || {};
        return owner.partnerActivity || owner.companyMarketing || main.profit || null;
    }

    function renderDashboard(rawPayload, source) {
        var payload = normalizePayload(rawPayload);
        state.payload = payload;
        state.source = source || state.source || 'unknown';

        var owner = (payload.blocks && payload.blocks.owner) || {};
        var main = (payload.blocks && payload.blocks.main) || {};
        var marketing = owner.companyMarketing;
        var activity = owner.partnerActivity;
        var profit = main.profit;

        renderPeriods(pickPeriodBlock(payload));
        renderWarehouseInfo();

        if (marketing && marketing.summary) {
            renderGenericKpi(el('owner-kpi'), marketing.summary, OWNER_METRICS);
            renderGenericTable(el('owner-table-body'), marketing.summary, OWNER_METRICS);
        } else {
            el('owner-kpi').innerHTML = '';
            el('owner-table-body').innerHTML = '<tr><td colspan="5">Нет данных companyMarketing за период</td></tr>';
        }

        if (profit && profit.summary) {
            renderGenericKpi(el('main-kpi'), profit.summary, MAIN_METRICS);
            renderGenericTable(el('main-table-body'), profit.summary, MAIN_METRICS);
        } else {
            el('main-kpi').innerHTML = '';
            el('main-table-body').innerHTML = '<tr><td colspan="5">Нет данных profit за период</td></tr>';
        }

        if (activity && activity.summary) {
            renderActivityKpiCards(el('activity-overview-kpi'), activity.summary, ['total', 'earned', 'manual']);
            renderActivityKpiCards(el('activity-earned-kpi'), activity.summary, EARNED_KEYS);
            renderActivityKpiCards(el('activity-manual-kpi'), activity.summary, MANUAL_KEYS);
            renderTotalChart(activity.summary);
            renderStructureChart(activity.summary);
            renderActivityTable(activity.summary);
        } else {
            el('activity-overview-kpi').innerHTML = '';
            el('activity-earned-kpi').innerHTML = '';
            el('activity-manual-kpi').innerHTML = '';
            el('activity-table-body').innerHTML = '<tr><td colspan="5">Нет данных partnerActivity за период</td></tr>';
        }

        var meta = payload.meta || {};
        setStatus(
            'Источник: ' + state.source +
            ' | период: ' + (payload.period || (meta.filters && meta.filters.period) || formatSelectedPeriod()) +
            ' | ' + (payload.fetchedAt || meta.generatedAt || '—') +
            (payload.checksum ? ' | ' + payload.checksum : '') +
            (meta.cacheHits != null ? ' | cacheHits ' + meta.cacheHits : '')
        );
    }

    function loadManifest() {
        return fetch(WAREHOUSE_BASE + '/manifest.json?_=' + Date.now())
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('manifest не найден');
                }
                return response.json();
            })
            .then(function (manifest) {
                state.manifest = manifest;
                renderWarehouseInfo();
                return manifest;
            });
    }

    function loadWarehousePeriod(ym) {
        return fetch(WAREHOUSE_BASE + '/periods/' + ym + '.json?_=' + Date.now())
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('warehouse ' + ym + ' не найден');
                }
                return response.json();
            })
            .then(function (artifact) {
                if (artifact.filters && artifact.filters.period) {
                    var parts = String(artifact.filters.period).split('-');
                    if (parts.length === 2) {
                        state.selectedYear = Number(parts[0]);
                        state.selectedMonth = Number(parts[1]);
                        renderPeriodButtons();
                    }
                }
                renderDashboard(artifact, 'warehouse');
            });
    }

    /**
     * Только warehouse. Live API — исключительно по кнопке «Обновить с API».
     *
     * @returns {Promise<void>}
     */
    function loadSelectedPeriodPreferWarehouse() {
        var ym = formatSelectedPeriod();
        return loadWarehousePeriod(ym).catch(function (error) {
            renderWarehouseInfo();
            setStatus(
                'Нет данных в warehouse за ' + ym +
                '. Выбери другой месяц или нажми «Обновить с API».',
                true
            );
            throw error;
        });
    }

    /**
     * Ставит период на последний доступный в manifest (или closed month).
     *
     * @returns {void}
     */
    function applyPeriodFromManifest() {
        if (state.manifest && state.manifest.coverage && state.manifest.coverage.to) {
            var parts = String(state.manifest.coverage.to).split('-');
            if (parts.length === 2) {
                state.selectedYear = Number(parts[0]);
                state.selectedMonth = Number(parts[1]);
                renderPeriodButtons();
                return;
            }
        }
        applyDefaults(null);
    }

    /**
     * Каталог компаний из warehouse (без live API).
     *
     * @returns {Promise<void>}
     */
    function loadWarehouseFilters() {
        return fetch(WAREHOUSE_BASE + '/filters.json?_=' + Date.now())
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('filters.json нет');
                }
                return response.json();
            })
            .then(function (catalog) {
                state.catalog = catalog;
                fillCompanySelect(catalog);
            });
    }

    function loadSnapshotFile() {
        return fetch('./snapshot.json?_=' + Date.now())
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('snapshot.json не найден');
                }
                return response.json();
            })
            .then(function (snapshot) {
                if (snapshot.filtersCatalog) {
                    state.catalog = snapshot.filtersCatalog;
                    fillCompanySelect(snapshot.filtersCatalog);
                }
                if (snapshot.filters && snapshot.filters.period) {
                    var parts = String(snapshot.filters.period).split('-');
                    if (parts.length === 2) {
                        state.selectedYear = Number(parts[0]);
                        state.selectedMonth = Number(parts[1]);
                        renderPeriodButtons();
                    }
                } else {
                    applyDefaults(snapshot.filters || null);
                }
                renderDashboard(snapshot, 'snapshot');
            });
    }

    function loadCatalog(token) {
        return apiGet('/filters', token).then(function (catalog) {
            state.catalog = catalog;
            fillCompanySelect(catalog);
            applyDefaults(catalog.defaults);
        });
    }

    function setRefreshDisabled(disabled) {
        var btn = el('btn-refresh-live');
        if (btn) {
            btn.disabled = !!disabled;
        }
    }

    function refreshLive() {
        var token = getToken();
        if (!token) {
            setStatus('Нужен API token (?token=... в URL)', true);
            return Promise.resolve();
        }
        if (state.loading) {
            return Promise.resolve();
        }
        state.loading = true;
        setRefreshDisabled(true);
        setStatus('Загрузка с API…');
        var filters = readFiltersFromForm();
        return apiGet('/query-batch?' + buildQueryString(filters), token)
            .then(function (payload) {
                payload.period = filters.period;
                renderDashboard(payload, 'live-api');
            })
            .catch(function (error) {
                setStatus('Ошибка API: ' + error.message, true);
            })
            .then(function () {
                state.loading = false;
                setRefreshDisabled(false);
            });
    }

    function bindEvents() {
        el('filter-compare-mode').addEventListener('change', toggleCustomCompare);
        el('btn-refresh-live').addEventListener('click', refreshLive);
        el('btn-load-warehouse').addEventListener('click', function () {
            loadSelectedPeriodPreferWarehouse().catch(function () {
                // статус уже выставлен
            });
        });
        el('btn-load-snapshot').addEventListener('click', function () {
            loadSnapshotFile().catch(function (error) {
                setStatus(error.message, true);
            });
        });
        el('toggle-rare').addEventListener('change', function (event) {
            state.showRare = !!event.target.checked;
            if (state.payload) {
                renderDashboard(state.payload, state.source);
            }
        });
        document.querySelectorAll('.management-dashboard__tab').forEach(function (btn) {
            btn.addEventListener('click', function () {
                setActiveTab(btn.getAttribute('data-tab'));
            });
        });
    }

    function init() {
        bindEvents();
        toggleCustomCompare();
        setActiveTab('owner');
        // Token только сохраняем — live API на старте не дергаем.
        getToken();

        setStatus('Читаем warehouse…');

        loadManifest()
            .catch(function () {
                state.manifest = null;
            })
            .then(function () {
                return loadWarehouseFilters().catch(function () {
                    // компании подтянем из snapshot при fallback
                });
            })
            .then(function () {
                applyPeriodFromManifest();
                return loadSelectedPeriodPreferWarehouse();
            })
            .catch(function () {
                return loadSnapshotFile().then(function () {
                    setStatus('Показан snapshot. Заполни warehouse sync для быстрой загрузки.');
                });
            })
            .catch(function (error) {
                setStatus('Нет данных в warehouse/snapshot: ' + error.message, true);
            });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
