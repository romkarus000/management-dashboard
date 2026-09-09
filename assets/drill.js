/**
 * Drill-down страницы корзины partnerActivity.
 * Источник: warehouse v2 (activity/drill/{type}/YYYY-MM.json), fallback — live API.
 */
(function () {
    'use strict';

    var API_BASE = window.MGMT_REPORT_API_BASE || '/api/v1/management-report';
    var WAREHOUSE_BASE = window.MGMT_WAREHOUSE_BASE || './warehouse';
    var TOKEN_STORAGE_KEY = 'mgmtReportApiToken';

    var MONTH_LABELS = [
        'Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн',
        'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'
    ];

    var METRIC_LABELS = {
        total: 'Всего с активностью',
        manual: 'Ручная (всего)',
        purchase: 'Покупка 100+ баллов',
        registration: '20+ в 1-ю линию',
        hybrid: 'Гибрид',
        adv: 'Реклама в соцсетях',
        club: 'Клуб',
        partner_registration: 'Регистрация в ПП (ЗС)',
        product_education: 'Покупка / мероприятие',
        overlap: 'Несколько способов',
        manual_ambassador: 'Амбассадоры Fitstars',
        manual_barter_influence: 'Бартер Инфлюенс',
        manual_cross_marketing: 'Кросс-маркетинг',
        manual_barter_solo: 'Бартер самостоятельный',
        manual_coach: 'Коучи / наставники',
        manual_human: 'Аккаунты компании'
    };

    var regChart = null;
    var revenueChart = null;
    var currentParams = null;
    var currentPayload = null;

    /**
     * Warehouse v2 drill path: activity/drill/{type}/YYYY-MM.json
     * @param {string} type
     * @param {string} periodYm
     * @returns {string}
     */
    function drillWarehouseUrl(type, periodYm) {
        return WAREHOUSE_BASE + '/activity/drill/' + encodeURIComponent(type) +
            '/' + periodYm + '.json?_=' + Date.now();
    }

    /**
     * @param {string} id
     * @returns {HTMLElement}
     */
    function el(id) {
        return document.getElementById(id);
    }

    /**
     * Убирает token из адресной строки после сохранения в localStorage.
     * @returns {void}
     */
    function stripTokenFromUrl() {
        var url = new URL(window.location.href);
        if (!url.searchParams.has('token')) {
            return;
        }
        url.searchParams.delete('token');
        var qs = url.searchParams.toString();
        var next = url.pathname + (qs ? '?' + qs : '') + url.hash;
        window.history.replaceState({}, '', next);
    }

    /**
     * Токен только из localStorage (или один раз из ?token= для записи).
     * @returns {string}
     */
    function getToken() {
        var fromQuery = new URLSearchParams(window.location.search).get('token');
        if (fromQuery) {
            localStorage.setItem(TOKEN_STORAGE_KEY, fromQuery);
            stripTokenFromUrl();
            return fromQuery;
        }
        return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    }

    /**
     * @returns {{type: string, periodType: string, period: string, companyId: string}}
     */
    function readParams() {
        var q = new URLSearchParams(window.location.search);
        return {
            type: q.get('type') || '',
            periodType: q.get('periodType') || 'month',
            period: q.get('period') || '',
            companyId: q.get('companyId') || '0'
        };
    }

    /**
     * @param {string} message
     * @param {boolean} [isError]
     * @returns {void}
     */
    function setStatus(message, isError) {
        var node = el('dashboard-status');
        node.textContent = message;
        node.classList.toggle('is-error', !!isError);
    }

    /**
     * @param {number|null|undefined} value
     * @returns {string}
     */
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

    /**
     * @param {number|null|undefined} value
     * @returns {string}
     */
    function formatMoney(value) {
        if (value === null || value === undefined || Number.isNaN(Number(value))) {
            return '—';
        }
        return Number(value).toLocaleString('ru-RU', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });
    }

    /**
     * @param {{absolute?: number, percent?: number|null}|null} delta
     * @returns {string}
     */
    function formatDelta(delta) {
        if (!delta || delta.absolute === undefined || delta.absolute === null) {
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

    /**
     * @param {{absolute?: number}|null} delta
     * @returns {string}
     */
    function deltaClass(delta) {
        if (!delta || !delta.absolute) {
            return 'is-neutral';
        }
        return delta.absolute > 0 ? 'is-up' : 'is-down';
    }

    /**
     * @param {string} path
     * @param {string} token
     * @returns {Promise<Object>}
     */
    function apiGet(path, token) {
        return fetch(API_BASE + path, {
            headers: {
                Authorization: 'Bearer ' + token
            }
        }).then(function (response) {
            return response.json();
        }).then(function (payload) {
            if (!payload.success) {
                throw new Error(
                    (payload.data && payload.data.error) ||
                    payload.error ||
                    'API error'
                );
            }
            return payload.data;
        });
    }

    /**
     * Fallback totals из partners, если бэкенд/файл без KPI.
     *
     * @param {Object} payload
     * @returns {Object}
     */
    function ensureDrillKpi(payload) {
        var next = payload || {};
        if (!next.totals) {
            var reg = 0;
            var revenue = 0;
            (next.partners || []).forEach(function (row) {
                reg += Number(row.reg_count) || 0;
                revenue += Number(row.revenue) || 0;
            });
            next.totals = {
                reg_count: reg,
                revenue: Math.round(revenue * 100) / 100
            };
        }
        if (!next.previous) {
            next.previous = { reg_count: null, revenue: null };
        }
        if (!next.delta) {
            next.delta = {};
        }
        return next;
    }

    /**
     * @param {Object} params
     * @returns {void}
     */
    function updateHeader(params) {
        var label = METRIC_LABELS[params.type] || params.type;
        el('drill-title').textContent = label;
        el('drill-subtitle').textContent =
            'Корзина: ' + params.type +
            ' · ' + params.periodType + ' ' + params.period;

        var back = el('back-link');
        back.href = './management.html';
    }

    /**
     * @param {Object} payload
     * @param {string} sourceLabel
     * @returns {void}
     */
    function renderMeta(payload, sourceLabel) {
        var windowMeta = payload.window || {};
        var meta = payload.meta || {};
        el('periods-info').textContent =
            (windowMeta.label || '') + ': ' +
            (windowMeta.from || '') + ' — ' + (windowMeta.to || '') +
            ' · партнёров: ' + (meta.partnerCount || (payload.partners || []).length || 0) +
            (meta.elapsedMs ? ' · ' + meta.elapsedMs + ' мс' : '');

        el('source-info').textContent = sourceLabel || '';

        if (meta.label) {
            el('drill-title').textContent = meta.label;
        }
    }

    /**
     * @param {Object} payload
     * @returns {void}
     */
    function renderKpi(payload) {
        var root = el('drill-kpi');
        root.innerHTML = '';
        var totals = payload.totals || {};
        var delta = payload.delta || {};

        var cards = [
            {
                key: 'reg_count',
                label: 'Регистрации 1 линии',
                value: formatNumber(totals.reg_count),
                delta: delta.reg_count
            },
            {
                key: 'revenue',
                label: 'Выручка (чистый итог)',
                value: formatMoney(totals.revenue),
                delta: delta.revenue
            }
        ];

        cards.forEach(function (card) {
            var node = document.createElement('div');
            node.className = 'management-dashboard__kpi management-dashboard__kpi--overview';
            var label = document.createElement('div');
            label.className = 'management-dashboard__kpi-label';
            label.textContent = card.label;
            var value = document.createElement('div');
            value.className = 'management-dashboard__kpi-value';
            value.textContent = card.value;
            node.appendChild(label);
            node.appendChild(value);
            if (card.delta) {
                var d = document.createElement('div');
                d.className = 'management-dashboard__kpi-delta ' + deltaClass(card.delta);
                d.textContent = formatDelta(card.delta);
                node.appendChild(d);
            }
            root.appendChild(node);
        });
    }

    /**
     * @param {Object} payload
     * @returns {void}
     */
    function renderPartners(payload) {
        var tbody = el('partners-table').querySelector('tbody');
        tbody.innerHTML = '';
        var rows = payload.partners || [];

        if (!rows.length) {
            var empty = document.createElement('tr');
            empty.innerHTML = '<td colspan="4">Нет партнёров в корзине за интервал</td>';
            tbody.appendChild(empty);
            return;
        }

        rows.forEach(function (row) {
            var tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + escapeHtml(row.fio || ('#' + row.partner_id)) + '</td>' +
                '<td>' + escapeHtml(row.email || '') + '</td>' +
                '<td class="is-num">' + String(row.reg_count || 0) + '</td>' +
                '<td class="is-num">' + formatMoney(row.revenue) + '</td>';
            tbody.appendChild(tr);
        });
    }

    /**
     * @param {Object} payload
     * @returns {void}
     */
    function renderLeads(payload) {
        var tbody = el('leads-table').querySelector('tbody');
        tbody.innerHTML = '';
        var rows = payload.leads || [];

        if (!rows.length) {
            var empty = document.createElement('tr');
            empty.innerHTML = '<td colspan="5">Нет оплат 1 линии за интервал</td>';
            tbody.appendChild(empty);
            return;
        }

        rows.forEach(function (row) {
            var tr = document.createElement('tr');
            var channel = row.channel ? escapeHtml(row.channel) : '—';
            tr.innerHTML =
                '<td>' + escapeHtml(row.partner_fio || ('#' + row.partner_id)) + '</td>' +
                '<td>' + escapeHtml((row.client_fio || '') + ' · ' + (row.client_email || '')) + '</td>' +
                '<td>' + channel + '</td>' +
                '<td class="is-num">' + String(row.payment_count || 0) + '</td>' +
                '<td class="is-num">' + formatMoney(row.revenue) + '</td>';
            tbody.appendChild(tr);
        });
    }

    /**
     * @param {string} value
     * @returns {string}
     */
    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * @param {Chart|null} chart
     * @returns {null}
     */
    function destroyChart(chart) {
        if (chart) {
            chart.destroy();
        }
        return null;
    }

    /**
     * Загружает envelope месяца из warehouse.
     *
     * @param {string} type
     * @param {string} periodYm
     * @returns {Promise<Object|null>}
     */
    function fetchWarehouseMonth(type, periodYm) {
        return fetch(drillWarehouseUrl(type, periodYm))
            .then(function (response) {
                if (!response.ok) {
                    return null;
                }
                return response.json();
            })
            .catch(function () {
                return null;
            });
    }

    /**
     * Годовая серия totals из warehouse (12 файлов).
     *
     * @param {string} type
     * @param {number} year
     * @returns {Promise<{labels: string[], months: string[], rows: Array<Object|null>}>}
     */
    function loadDrillYearSeries(type, year) {
        var fetches = [];
        var months = [];
        for (var month = 1; month <= 12; month += 1) {
            var ym = year + '-' + String(month).padStart(2, '0');
            months.push(ym);
            fetches.push(
                fetchWarehouseMonth(type, ym).then(function (envelope) {
                    if (!envelope || !envelope.data) {
                        return null;
                    }
                    var data = ensureDrillKpi(envelope.data);
                    return data.totals || null;
                })
            );
        }
        return Promise.all(fetches).then(function (rows) {
            return {
                labels: MONTH_LABELS.slice(),
                months: months,
                rows: rows
            };
        });
    }

    /**
     * @param {{labels: string[], rows: Array<Object|null>}} series
     * @param {number} year
     * @returns {void}
     */
    function renderYearCharts(series, year) {
        var hint = el('drill-charts-hint');
        var filled = (series.rows || []).filter(Boolean).length;
        if (hint) {
            hint.textContent = 'Год ' + year +
                ': месяцев с drill в warehouse — ' + filled + ' из 12.';
        }

        var reg = [];
        var revenue = [];
        (series.rows || []).forEach(function (row) {
            if (!row) {
                reg.push(null);
                revenue.push(null);
                return;
            }
            reg.push(row.reg_count != null ? Number(row.reg_count) : null);
            revenue.push(row.revenue != null ? Number(row.revenue) : null);
        });

        regChart = destroyChart(regChart);
        revenueChart = destroyChart(revenueChart);

        var regCanvas = el('drill-reg-chart');
        var revCanvas = el('drill-revenue-chart');
        if (!window.Chart || !regCanvas || !revCanvas) {
            return;
        }

        regChart = new Chart(regCanvas, {
            type: 'line',
            data: {
                labels: series.labels,
                datasets: [{
                    label: 'Регистрации 1 линии',
                    data: reg,
                    borderColor: '#2563eb',
                    backgroundColor: 'rgba(37, 99, 235, 0.12)',
                    tension: 0.25,
                    spanGaps: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true }
                },
                scales: {
                    y: { beginAtZero: true }
                }
            }
        });

        revenueChart = new Chart(revCanvas, {
            type: 'line',
            data: {
                labels: series.labels,
                datasets: [{
                    label: 'Выручка (чистый итог)',
                    data: revenue,
                    borderColor: '#059669',
                    backgroundColor: 'rgba(5, 150, 105, 0.12)',
                    tension: 0.25,
                    spanGaps: false
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true },
                    tooltip: {
                        callbacks: {
                            label: function (context) {
                                var label = context.dataset.label || '';
                                var value = context.parsed.y;
                                if (value === null || value === undefined) {
                                    return label + ': —';
                                }
                                return label + ': ' + formatMoney(value);
                            }
                        }
                    }
                },
                scales: {
                    y: { beginAtZero: true }
                }
            }
        });
    }

    /**
     * @param {Object} payload
     * @param {string} sourceLabel
     * @returns {void}
     */
    function renderAll(payload, sourceLabel) {
        currentPayload = ensureDrillKpi(payload);
        renderMeta(currentPayload, sourceLabel);
        renderKpi(currentPayload);
        renderPartners(currentPayload);
        renderLeads(currentPayload);
    }

    /**
     * Загрузка из warehouse; при отсутствии файла — false.
     *
     * @param {Object} params
     * @returns {Promise<boolean>}
     */
    function loadFromWarehouse(params) {
        if (params.periodType !== 'month' || !/^\d{4}-\d{2}$/.test(params.period)) {
            return Promise.resolve(false);
        }
        setStatus('Загрузка из warehouse…');
        return fetchWarehouseMonth(params.type, params.period).then(function (envelope) {
            if (!envelope || !envelope.data) {
                return false;
            }
            var data = envelope.data;
            renderAll(data, 'Источник: warehouse · ' + (envelope.fetchedAt || params.period));
            setStatus('Готово (warehouse)');
            var year = Number(params.period.slice(0, 4));
            return loadDrillYearSeries(params.type, year).then(function (series) {
                // Подмешиваем текущий месяц из уже загруженного payload
                var monthIdx = Number(params.period.slice(5, 7)) - 1;
                if (series.rows && currentPayload && currentPayload.totals) {
                    series.rows[monthIdx] = currentPayload.totals;
                }
                renderYearCharts(series, year);
                return true;
            });
        });
    }

    /**
     * @param {Object} params
     * @returns {Promise<void>}
     */
    function loadFromApi(params) {
        var token = getToken();
        if (!token) {
            setStatus('Нужен API token: один раз открой с ?token=... (сохранится локально)', true);
            return Promise.resolve();
        }

        var qs = new URLSearchParams();
        qs.set('type', params.type);
        qs.set('periodType', params.periodType);
        qs.set('period', params.period);
        qs.set('companyId', params.companyId);
        qs.set('compareMode', 'previous');

        setStatus('Загрузка drill с API…');

        return apiGet('/partner-activity/drill?' + qs.toString(), token)
            .then(function (payload) {
                if (payload.code) {
                    throw new Error(payload.error || payload.code);
                }
                renderAll(payload, 'Источник: live API');
                setStatus('Готово (API)');

                if (params.periodType === 'month' && /^\d{4}-\d{2}$/.test(params.period)) {
                    var year = Number(params.period.slice(0, 4));
                    return loadDrillYearSeries(params.type, year).then(function (series) {
                        var monthIdx = Number(params.period.slice(5, 7)) - 1;
                        if (series.rows && currentPayload && currentPayload.totals) {
                            series.rows[monthIdx] = currentPayload.totals;
                        }
                        renderYearCharts(series, year);
                    });
                }
            });
    }

    /**
     * Warehouse first, иначе API.
     *
     * @param {Object} params
     * @returns {Promise<void>}
     */
    function loadPreferred(params) {
        return loadFromWarehouse(params).then(function (ok) {
            if (ok) {
                return;
            }
            return loadFromApi(params);
        }).catch(function (error) {
            setStatus('Ошибка: ' + error.message, true);
        });
    }

    /**
     * @returns {void}
     */
    function init() {
        currentParams = readParams();
        updateHeader(currentParams);

        if (!currentParams.type || !currentParams.period) {
            setStatus('Нужны type и period в URL', true);
            return;
        }

        el('btn-load-warehouse').addEventListener('click', function () {
            loadFromWarehouse(currentParams).then(function (ok) {
                if (!ok) {
                    setStatus('Файла warehouse нет для ' + currentParams.type + ' / ' + currentParams.period, true);
                }
            }).catch(function (error) {
                setStatus('Ошибка: ' + error.message, true);
            });
        });

        el('btn-refresh-live').addEventListener('click', function () {
            loadFromApi(currentParams).catch(function (error) {
                setStatus('Ошибка: ' + error.message, true);
            });
        });

        loadPreferred(currentParams);
    }

    init();
})();
