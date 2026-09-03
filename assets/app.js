/**
 * Первичный дашборд управленческой отчётности (schema 2.0).
 */
(function () {
    'use strict';

    var API_BASE = window.MGMT_REPORT_API_BASE || '/api/v1/management-report';
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
    var RARE_KEYS = ['hybrid', 'overlap'];

    var METRICS = {
        total: {
            label: 'Всего с активностью',
            hint: 'Партнёры с act = 1 в выбранных периодах',
            group: 'overview'
        },
        earned: {
            label: 'Заработано (всего)',
            hint: 'Total минус ручная: все заработанные способы включая ПП и обучение/мероприятие',
            group: 'overview',
            computed: true
        },
        manual: {
            label: 'Ручная (всего)',
            hint: 'Нет ни одного заработанного способа',
            group: 'overview'
        },
        purchase: {
            label: 'Покупка 100+ баллов',
            hint: 'Закрыли активность только покупкой на 100+ баллов',
            group: 'earned'
        },
        registration: {
            label: '20+ в 1-ю линию',
            hint: '20+ регистраций 1 линии за период (не «новые партнёры»)',
            group: 'earned'
        },
        hybrid: {
            label: 'Гибрид',
            hint: 'Сумма баллов и регистраций ≥ 100, пороги по отдельности не взяты',
            group: 'earned',
            rare: true
        },
        adv: {
            label: 'Реклама в соцсетях',
            hint: '2+ принятых рекламных интеграций',
            group: 'earned'
        },
        club: {
            label: 'Клуб',
            hint: 'Покупка клуба или перенос через WAH',
            group: 'earned'
        },
        partner_registration: {
            label: 'Регистрация в ПП (ЗС)',
            hint: 'Закрыли активность только заказом из пака ЗС 8485',
            group: 'earned'
        },
        product_education: {
            label: 'Покупка / мероприятие',
            hint: 'Завершённый заказ с правилом «Партнер» или регистрация на мероприятие (не пак ЗС)',
            group: 'earned'
        },
        overlap: {
            label: 'Несколько способов',
            hint: 'Больше одного заработанного способа',
            group: 'earned',
            rare: true
        },
        manual_ambassador: {
            label: 'Амбассадоры Fitstars',
            hint: 'Ручная: parent 4264877 или комментарий «амбассадор*»',
            group: 'manual'
        },
        manual_barter_influence: {
            label: 'Бартер Инфлюенс',
            hint: 'Ручная: группа user_group 3823, не амбассадор',
            group: 'manual'
        },
        manual_barter_solo: {
            label: 'Бартер самостоятельный',
            hint: 'Ручная: комментарий «блогер*», без Fitstars и без группы 3823',
            group: 'manual'
        },
        manual_coach: {
            label: 'Коучи / наставники',
            hint: 'Ручная: коуч, наставник, куратор, сотрудник — по комментарию',
            group: 'manual'
        },
        manual_human: {
            label: 'Ручное действие',
            hint: 'Ручная без амбассадора, бартера и коуча',
            group: 'manual'
        }
    };

    var TABLE_ORDER = [
        'total', 'earned', 'manual',
        'purchase', 'registration', 'hybrid', 'adv', 'club',
        'partner_registration', 'product_education', 'overlap',
        'manual_ambassador', 'manual_barter_influence', 'manual_barter_solo',
        'manual_coach', 'manual_human'
    ];

    var state = {
        catalog: null,
        snapshot: null,
        loading: false,
        showRare: false
    };

    var totalChart = null;
    var structureChart = null;

    /**
     * @returns {HTMLElement}
     */
    function el(id) {
        return document.getElementById(id);
    }

    /**
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
                throw new Error(payload.data && payload.data.error ? payload.data.error : 'API error');
            }
            return payload.data;
        });
    }

    /**
     * @param {string} message
     * @param {boolean} isError
     * @returns {void}
     */
    function setStatus(message, isError) {
        var node = el('dashboard-status');
        node.textContent = message;
        node.classList.toggle('is-error', !!isError);
    }

    /**
     * @returns {string}
     */
    function getToken() {
        var fromQuery = new URLSearchParams(window.location.search).get('token');
        if (fromQuery) {
            localStorage.setItem(TOKEN_STORAGE_KEY, fromQuery);
            return fromQuery;
        }
        return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
    }

    /**
     * @returns {Object}
     */
    function readFiltersFromForm() {
        return {
            periodType: el('filter-period-type').value,
            period: el('filter-period').value,
            compareMode: el('filter-compare-mode').value,
            compareFrom: el('filter-compare-from').value || null,
            compareTo: el('filter-compare-to').value || null,
            companyId: parseInt(el('filter-company').value, 10) || 0
        };
    }

    /**
     * @param {Object} filters
     * @returns {string}
     */
    function buildQueryString(filters) {
        var params = new URLSearchParams();
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

    /**
     * @param {string} periodType
     * @returns {void}
     */
    function syncPeriodInputType(periodType) {
        var input = el('filter-period');
        if (periodType === 'day') {
            input.type = 'date';
            return;
        }
        if (periodType === 'month') {
            input.type = 'month';
            return;
        }
        input.type = 'text';
        input.placeholder = periodType === 'quarter' ? '2026-Q3' : '2026';
    }

    /**
     * @param {Object} catalog
     * @returns {void}
     */
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

    /**
     * @param {Object} defaults
     * @returns {Object}
     */
    function preferClosedMonth(defaults) {
        var next = Object.assign({}, defaults || {});
        if ((next.periodType || 'month') !== 'month') {
            return next;
        }

        var now = new Date();
        var year = now.getFullYear();
        var month = now.getMonth();
        if (month === 0) {
            year -= 1;
            month = 12;
        }
        next.periodType = 'month';
        next.period = year + '-' + String(month).padStart(2, '0');
        return next;
    }

    /**
     * @param {Object} defaults
     * @returns {void}
     */
    function applyDefaults(defaults) {
        if (!defaults) {
            return;
        }

        var values = preferClosedMonth(defaults);
        el('filter-period-type').value = values.periodType || 'month';
        syncPeriodInputType(el('filter-period-type').value);
        el('filter-period').value = values.period || '';
        el('filter-compare-mode').value = values.compareMode || 'previous';
        el('filter-company').value = String(values.companyId || 0);
        toggleCustomCompare();
    }

    /**
     * @returns {void}
     */
    function toggleCustomCompare() {
        var visible = el('filter-compare-mode').value === 'custom';
        el('custom-compare-fields').classList.toggle('is-visible', visible);
    }

    /**
     * @param {Object} row
     * @returns {number}
     */
    function computeEarned(row) {
        if (!row) {
            return 0;
        }
        return EARNED_KEYS.reduce(function (sum, key) {
            return sum + (Number(row[key]) || 0);
        }, 0);
    }

    /**
     * @param {Object} row
     * @param {string} key
     * @returns {number}
     */
    function metricValue(row, key) {
        if (!row) {
            return 0;
        }
        if (key === 'earned') {
            return computeEarned(row);
        }
        return Number(row[key]) || 0;
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    function isVisibleMetric(key) {
        var meta = METRICS[key];
        if (!meta || !meta.rare) {
            return true;
        }
        return state.showRare;
    }

    /**
     * @param {Object|null} delta
     * @returns {string}
     */
    function formatDelta(delta) {
        if (!delta) {
            return '';
        }

        var abs = delta.absolute;
        var pct = delta.percent;
        var sign = abs > 0 ? '+' : '';
        var text = sign + abs;

        if (pct !== null && pct !== undefined) {
            text += ' (' + sign + pct + '%)';
        }

        return text;
    }

    /**
     * @param {Object|null} delta
     * @returns {string}
     */
    function deltaClass(delta) {
        if (!delta || delta.absolute === 0) {
            return 'is-neutral';
        }
        return delta.absolute > 0 ? 'is-up' : 'is-down';
    }

    /**
     * @param {Object} summaryBlock
     * @param {string} key
     * @returns {Object|null}
     */
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

    /**
     * @param {HTMLElement} container
     * @param {Object} summaryBlock
     * @param {string[]} keys
     * @returns {void}
     */
    function renderKpiCards(container, summaryBlock, keys) {
        container.innerHTML = '';
        var current = (summaryBlock && summaryBlock.current) || {};

        keys.forEach(function (key) {
            if (!isVisibleMetric(key)) {
                return;
            }

            var meta = METRICS[key] || { label: key, group: 'overview' };
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

            if (meta.hint) {
                var hint = document.createElement('div');
                hint.className = 'management-dashboard__kpi-hint';
                hint.textContent = meta.hint;
                card.appendChild(label);
                card.appendChild(value);
                card.appendChild(delta);
                card.appendChild(hint);
            } else {
                card.appendChild(label);
                card.appendChild(value);
                card.appendChild(delta);
            }

            container.appendChild(card);
        });
    }

    /**
     * URL drill-страницы с текущими фильтрами шапки.
     *
     * @param {string} type
     * @returns {string}
     */
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

    /**
     * @param {Object} block
     * @returns {void}
     */
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

    /**
     * @param {Object} summaryBlock
     * @returns {void}
     */
    function renderTotalChart(summaryBlock) {
        var canvas = el('activity-total-chart');
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
                plugins: {
                    legend: {
                        position: 'top'
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    }

    /**
     * @param {Object} summaryBlock
     * @returns {void}
     */
    function renderStructureChart(summaryBlock) {
        var canvas = el('activity-structure-chart');
        var current = summaryBlock.current || {};
        var keys = EARNED_KEYS.concat(MANUAL_KEYS).filter(isVisibleMetric);
        var labels = [];
        var values = [];
        var colors = [];

        keys.forEach(function (key) {
            var meta = METRICS[key];
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
                datasets: [{
                    label: 'Людей',
                    data: values,
                    backgroundColor: colors
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    },
                    tooltip: {
                        callbacks: {
                            afterLabel: function (ctx) {
                                var key = keys[ctx.dataIndex];
                                return METRICS[key] ? METRICS[key].hint : '';
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        ticks: {
                            maxRotation: 45,
                            minRotation: 25
                        }
                    },
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    }

    /**
     * @param {Object} summaryBlock
     * @returns {void}
     */
    function renderActivityTable(summaryBlock) {
        var tbody = el('activity-table-body');
        tbody.innerHTML = '';

        var current = summaryBlock.current || {};
        var previous = summaryBlock.previous || {};

        TABLE_ORDER.forEach(function (key) {
            if (!isVisibleMetric(key)) {
                return;
            }

            var meta = METRICS[key];
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
                ? (delta.absolute > 0 ? '+' : '') + delta.percent + '%'
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
     * @param {Object} batchPayload
     * @returns {void}
     */
    function renderDashboard(batchPayload) {
        var owner = (batchPayload.blocks && batchPayload.blocks.owner) || {};
        var activity = owner.partnerActivity;
        var marketing = owner.companyMarketing;
        var summary = activity && activity.summary;

        renderPeriods(activity || marketing);

        if (summary) {
            renderKpiCards(el('activity-overview-kpi'), summary, ['total', 'earned', 'manual']);
            renderKpiCards(el('activity-earned-kpi'), summary, EARNED_KEYS);
            renderKpiCards(el('activity-manual-kpi'), summary, MANUAL_KEYS);
            renderTotalChart(summary);
            renderStructureChart(summary);
            renderActivityTable(summary);
        }

        if (marketing && marketing.summary) {
            el('marketing-section').classList.remove('management-dashboard__hidden');
            renderKpiCards(
                el('marketing-kpi'),
                marketing.summary,
                ['control_paidSum', 'control_orderCount', 'marketing_total_money', 'marketing_total_profit']
            );
            // Override labels for marketing KPIs
            var mk = el('marketing-kpi');
            if (mk && mk.children.length >= 4) {
                mk.children[0].querySelector('.management-dashboard__kpi-label').textContent = 'Оплачено';
                mk.children[1].querySelector('.management-dashboard__kpi-label').textContent = 'Заказов';
                mk.children[2].querySelector('.management-dashboard__kpi-label').textContent = 'Деньги';
                mk.children[3].querySelector('.management-dashboard__kpi-label').textContent = 'Прибыль';
            }
        } else {
            el('marketing-section').classList.add('management-dashboard__hidden');
        }

        var meta = batchPayload.meta || {};
        setStatus(
            'Обновлено: ' + (meta.generatedAt || '—') +
            ' | cacheHits: ' + (meta.cacheHits != null ? meta.cacheHits : '—')
        );
    }

    /**
     * @returns {Promise<void>}
     */
    function loadSnapshotFile() {
        return fetch('./snapshot.json?_=' + Date.now())
            .then(function (response) {
                if (!response.ok) {
                    throw new Error('snapshot.json не найден');
                }
                return response.json();
            })
            .then(function (snapshot) {
                state.snapshot = snapshot;
                if (snapshot.filtersCatalog) {
                    state.catalog = snapshot.filtersCatalog;
                    fillCompanySelect(snapshot.filtersCatalog);
                }
                if (snapshot.filters) {
                    applyDefaults(snapshot.filters);
                }
                renderDashboard(snapshot);
            });
    }

    /**
     * @returns {Promise<void>}
     */
    function loadCatalog(token) {
        return apiGet('/filters', token).then(function (catalog) {
            state.catalog = catalog;
            fillCompanySelect(catalog);
            applyDefaults(catalog.defaults);
        });
    }

    /**
     * @param {boolean} disabled
     * @returns {void}
     */
    function setRefreshDisabled(disabled) {
        var btn = el('btn-refresh-live');
        if (btn) {
            btn.disabled = !!disabled;
        }
    }

    /**
     * @returns {Promise<void>}
     */
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
        setStatus('Загрузка данных с API… (первый прогон может занять 1–2 мин)');

        var filters = readFiltersFromForm();
        var path = '/query-batch?' + buildQueryString(filters);

        return apiGet(path, token)
            .then(function (payload) {
                renderDashboard(payload);
            })
            .catch(function (error) {
                setStatus('Ошибка API: ' + error.message, true);
            })
            .then(function () {
                state.loading = false;
                setRefreshDisabled(false);
            });
    }

    /**
     * @returns {void}
     */
    function bindEvents() {
        el('filter-period-type').addEventListener('change', function (event) {
            syncPeriodInputType(event.target.value);
        });

        el('filter-compare-mode').addEventListener('change', toggleCustomCompare);
        el('btn-refresh-live').addEventListener('click', refreshLive);
        el('btn-load-snapshot').addEventListener('click', function () {
            loadSnapshotFile().catch(function (error) {
                setStatus(error.message, true);
            });
        });

        el('toggle-rare').addEventListener('change', function (event) {
            state.showRare = !!event.target.checked;
            if (state.snapshot) {
                renderDashboard(state.snapshot);
            }
        });
    }

    /**
     * @returns {void}
     */
    function init() {
        bindEvents();
        toggleCustomCompare();

        var token = getToken();

        // Live API предпочтительнее snapshot: иначе после смены ключей метрик
        // старый snapshot.json показывает нули по новым корзинам.
        if (token) {
            loadCatalog(token)
                .then(function () {
                    return refreshLive();
                })
                .catch(function (error) {
                    setStatus('API недоступен, пробуем snapshot: ' + error.message, true);
                    return loadSnapshotFile().catch(function (snapError) {
                        setStatus('Нет данных: ' + snapError.message, true);
                    });
                });
            return;
        }

        loadSnapshotFile()
            .then(function () {
                setStatus('Snapshot загружен. Добавь ?token=... и нажми «Обновить с API».');
            })
            .catch(function (error) {
                setStatus('Нет snapshot.json и нет token: ' + error.message, true);
            });
    }

    document.addEventListener('DOMContentLoaded', init);
})();
