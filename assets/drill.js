/**
 * Drill-down страницы корзины partnerActivity.
 */
(function () {
    'use strict';

    var API_BASE = window.MGMT_REPORT_API_BASE || '/api/v1/management-report';
    var TOKEN_STORAGE_KEY = 'mgmtReportApiToken';

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
        manual_barter_solo: 'Бартер самостоятельный',
        manual_coach: 'Коучи / наставники',
        manual_human: 'Аккаунты компании'
    };

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
     * @returns {Object}
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
     * @param {boolean} isError
     * @returns {void}
     */
    function setStatus(message, isError) {
        var node = el('dashboard-status');
        node.textContent = message;
        node.classList.toggle('is-error', !!isError);
    }

    /**
     * @param {number} value
     * @returns {string}
     */
    function formatMoney(value) {
        var n = Number(value) || 0;
        return n.toLocaleString('ru-RU', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });
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
        // token не прокидываем — warehouse-страницы читают без API
        back.href = './management.html';
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
     * @returns {void}
     */
    function init() {
        var params = readParams();
        updateHeader(params);

        if (!params.type || !params.period) {
            setStatus('Нужны type и period в URL', true);
            return;
        }

        var token = getToken();
        if (!token) {
            setStatus('Нужен API token: один раз открой с ?token=... (сохранится локально)', true);
            return;
        }

        var qs = new URLSearchParams();
        qs.set('type', params.type);
        qs.set('periodType', params.periodType);
        qs.set('period', params.period);
        qs.set('companyId', params.companyId);
        qs.set('compareMode', 'previous');

        setStatus('Загрузка drill…');

        apiGet('/partner-activity/drill?' + qs.toString(), token)
            .then(function (payload) {
                if (payload.code) {
                    throw new Error(payload.error || payload.code);
                }
                var windowMeta = payload.window || {};
                el('periods-info').textContent =
                    (windowMeta.label || '') + ': ' +
                    (windowMeta.from || '') + ' — ' + (windowMeta.to || '') +
                    ' · партнёров: ' + ((payload.meta && payload.meta.partnerCount) || 0) +
                    ' · ' + ((payload.meta && payload.meta.elapsedMs) || 0) + ' мс';

                if (payload.meta && payload.meta.label) {
                    el('drill-title').textContent = payload.meta.label;
                }

                renderPartners(payload);
                renderLeads(payload);
                setStatus('Готово');
            })
            .catch(function (error) {
                setStatus('Ошибка: ' + error.message, true);
            });
    }

    init();
})();
