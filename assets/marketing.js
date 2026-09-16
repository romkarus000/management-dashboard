/**
 * CRM Маркетинг: опережающие метрики из warehouse/crm/{leading,base,rfm}.
 * Primary sync: n8n `[CRM] Leading Metrics Daily` → HTTP ingest.
 */
(function () {
    'use strict';

    var WAREHOUSE_BASE = window.MGMT_WAREHOUSE_BASE || './warehouse';
    var DATASET_PATH = {
        'crm.leading': 'crm/leading',
        'crm.base': 'crm/base',
        'crm.rfm': 'crm/rfm'
    };
    var MONTH_NAMES = [
        'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
        'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'
    ];
    var PERIODS = [];
    var PERIOD_LABELS = {};
    var DIRS = [
        { id: 'all', label: 'Все' },
        { id: 'nutra', label: 'Нутра' },
        { id: 'psi', label: 'Пси' },
        { id: 'sex', label: 'Секс' },
        { id: 'icf', label: 'Коуч' },
        { id: 'design', label: 'Дизайн' }
    ];
    var CHANNELS = [
        { id: 'all', label: 'Все' },
        { id: 'email', label: 'Email' },
        { id: 'messengers', label: 'Мессенджеры' }
    ];
    var RFM_ORDER = [
        'Champions',
        'Loyal',
        'Potential',
        'Need Attention',
        'At Risk',
        'Hibernating'
    ];
    var SHARED_MAX_DIRS = { psi: true, sex: true, icf: true };

    var state = {
        tab: 'overview',
        period: '2026-08',
        dir: 'all',
        channel: 'all',
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

    function fmtPct(n, digits) {
        if (n == null || Number.isNaN(n)) return '—';
        return Number(n).toFixed(digits == null ? 2 : digits) + '%';
    }

    function fmtMoney(n) {
        if (n == null || !n) return '—';
        return Math.round(n).toLocaleString('ru-RU') + ' ₽';
    }

    function fmtDelta(d) {
        if (d == null) return '—';
        var sign = d > 0 ? '+' : '';
        return sign + d.toFixed(1) + '%';
    }

    function deltaPct(cur, prev) {
        if (cur == null || prev == null || prev === 0) return null;
        return (100 * (cur - prev)) / prev;
    }

    function addCh(a, b) {
        function sum(x, y) {
            return x == null && y == null ? null : (x || 0) + (y || 0);
        }
        var sent = sum(a.sent, b.sent);
        var delivered = sum(a.delivered, b.delivered);
        var opens = sum(a.opens, b.opens);
        var clicks = sum(a.clicks, b.clicks);
        return {
            sent: sent,
            delivered: delivered,
            opens: opens,
            clicks: clicks,
            or_pct: delivered && opens != null ? (100 * opens) / delivered : null,
            ctr_pct: delivered && clicks != null ? (100 * clicks) / delivered : null
        };
    }

    function messengersCh(row) {
        return addCh(row.tg || {}, row.max || {});
    }

    function channelBundle(row, channel) {
        if (channel === 'email') return row.email || {};
        if (channel === 'messengers') return messengersCh(row);
        return addCh(row.email || {}, messengersCh(row));
    }

    function c1Sent(leads, sent) {
        if (sent == null || sent <= 0) return null;
        return (100 * leads) / sent;
    }

    function c1Clicks(leads, clicks) {
        if (clicks == null || clicks <= 0) return null;
        return (100 * leads) / clicks;
    }

    function sumMaxDedup(rows) {
        var sum = 0;
        var sawShared = false;
        rows.forEach(function (r) {
            if (r.messenger_max == null) return;
            if (SHARED_MAX_DIRS[r.direction]) {
                if (!sawShared) {
                    sum += r.messenger_max;
                    sawShared = true;
                }
                return;
            }
            sum += r.messenger_max;
        });
        return sum;
    }

    function attentionTone(c2) {
        if (c2 < 3) return 'danger';
        if (c2 < 8) return 'warning';
        if (c2 >= 15) return 'success';
        return 'neutral';
    }

    function deltaClass(d) {
        if (d == null) return 'is-neutral';
        if (d > 0) return 'is-up';
        if (d < 0) return 'is-down';
        return 'is-neutral';
    }

    function datasetUrl(datasetId, ym) {
        return WAREHOUSE_BASE + '/' + DATASET_PATH[datasetId] + '/' + ym + '.json?_=' + Date.now();
    }

    function periodLabel(ym, toDay) {
        var parts = String(ym).split('-');
        var y = Number(parts[0]);
        var m = Number(parts[1]);
        var name = MONTH_NAMES[m - 1] || ym;
        if (toDay && /^\d{4}-\d{2}-\d{2}$/.test(toDay)) {
            var day = Number(toDay.slice(8, 10));
            var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
            if (day < last) return name + ' 1–' + day;
        }
        return name + ' ' + y;
    }

    function previousPeriod(ym) {
        var i = PERIODS.indexOf(ym);
        if (i > 0) return PERIODS[i - 1];
        var parts = String(ym).split('-');
        var y = Number(parts[0]);
        var m = Number(parts[1]) - 1;
        if (m < 1) {
            m = 12;
            y -= 1;
        }
        return y + '-' + String(m).padStart(2, '0');
    }

    function loadPeriodCatalog() {
        return fetch(WAREHOUSE_BASE + '/manifest.json?_=' + Date.now())
            .then(function (res) {
                if (!res.ok) throw new Error('manifest HTTP ' + res.status);
                return res.json();
            })
            .then(function (manifest) {
                var ds = manifest && manifest.datasets && manifest.datasets['crm.leading'];
                var keys = ds && ds.periods ? Object.keys(ds.periods).sort() : [];
                if (!keys.length) keys = ['2026-08', '2026-09'];
                PERIODS = keys;
                PERIOD_LABELS = {};
                keys.forEach(function (ym) {
                    PERIOD_LABELS[ym] = periodLabel(ym);
                });
                if (PERIODS.indexOf(state.period) === -1) {
                    state.period = PERIODS[PERIODS.length - 1];
                }
            })
            .catch(function () {
                if (!PERIODS.length) {
                    PERIODS = ['2026-08', '2026-09'];
                    PERIOD_LABELS = {
                        '2026-08': 'Август 2026',
                        '2026-09': 'Сентябрь 2026'
                    };
                }
            });
    }

    function fetchEnvelope(datasetId, ym) {
        return fetch(datasetUrl(datasetId, ym)).then(function (res) {
            if (!res.ok) throw new Error(datasetId + ' ' + ym + ': HTTP ' + res.status);
            return res.json();
        });
    }

    function loadPeriod(ym) {
        if (state.cache[ym]) return Promise.resolve(state.cache[ym]);
        return Promise.all([
            fetchEnvelope('crm.leading', ym),
            fetchEnvelope('crm.base', ym),
            fetchEnvelope('crm.rfm', ym)
        ]).then(function (envs) {
            var pack = {
                period: ym,
                leading: envs[0],
                base: envs[1],
                rfm: envs[2]
            };
            state.cache[ym] = pack;
            return pack;
        });
    }

    function filterRows(rows, dir) {
        if (!rows) return [];
        if (dir === 'all') return rows.slice();
        return rows.filter(function (r) { return r.direction === dir; });
    }

    function aggregate(pack, dir, channel) {
        var leadingData = pack.leading.data || {};
        var rows = filterRows(leadingData.rows, dir);
        var bundles = rows.map(function (r) {
            return { row: r, ch: channelBundle(r, channel) };
        });
        var sent = 0;
        var delivered = 0;
        var opens = 0;
        var clicks = 0;
        var leads = 0;
        var leadUsers = 0;
        var paidUsers = 0;
        var paidNet = 0;
        var hasDelivered = false;
        var hasClicks = false;
        bundles.forEach(function (b) {
            sent += b.ch.sent || 0;
            delivered += b.ch.delivered || 0;
            opens += b.ch.opens || 0;
            clicks += b.ch.clicks || 0;
            leads += b.row.leads_orders || 0;
            leadUsers += b.row.lead_users || 0;
            paidUsers += b.row.paid_users || 0;
            paidNet += b.row.paid_net || 0;
            if (b.ch.delivered != null) hasDelivered = true;
            if (b.ch.clicks != null) hasClicks = true;
        });
        return {
            from: leadingData.from,
            to: leadingData.to,
            unmatched_email: leadingData.unmatched_email,
            unsub_cabinet: leadingData.unsub_cabinet,
            bundles: bundles,
            sent: sent,
            delivered: delivered,
            opens: opens,
            clicks: clicks,
            leads: leads,
            leadUsers: leadUsers,
            paidUsers: paidUsers,
            paidNet: paidNet,
            orAll: hasDelivered && delivered ? (100 * opens) / delivered : null,
            ctrAll: hasDelivered && delivered && hasClicks ? (100 * clicks) / delivered : null,
            c1s: c1Sent(leads, sent || null),
            c1c: hasClicks ? c1Clicks(leads, clicks || null) : null,
            c2All: leadUsers ? (100 * paidUsers) / leadUsers : null
        };
    }

    function destroyCharts() {
        Object.keys(state.charts).forEach(function (key) {
            try { state.charts[key].destroy(); } catch (e) { /* ignore */ }
        });
        state.charts = {};
    }

    function makeBarChart(canvasId, labels, datasets) {
        var canvas = el(canvasId);
        if (!canvas || typeof Chart === 'undefined') return;
        if (state.charts[canvasId]) {
            try { state.charts[canvasId].destroy(); } catch (e) { /* ignore */ }
        }
        state.charts[canvasId] = new Chart(canvas.getContext('2d'), {
            type: 'bar',
            data: { labels: labels, datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: datasets.length > 1 } },
                scales: {
                    x: { grid: { display: false } },
                    y: { beginAtZero: true }
                }
            }
        });
    }

    function kpiHtml(label, value, delta, hint) {
        var deltaHtml = '';
        if (delta !== undefined) {
            deltaHtml =
                '<div class="management-dashboard__kpi-delta ' + deltaClass(delta) + '">' +
                fmtDelta(delta) + ' к авг</div>';
        }
        var hintHtml = hint
            ? '<div class="management-dashboard__kpi-hint">' + hint + '</div>'
            : '';
        return (
            '<div class="management-dashboard__kpi">' +
            '<div class="management-dashboard__kpi-label">' + label + '</div>' +
            '<div class="management-dashboard__kpi-value">' + value + '</div>' +
            deltaHtml +
            hintHtml +
            '</div>'
        );
    }

    function tableWrap(headHtml, bodyHtml) {
        return (
            '<div class="management-dashboard__table-wrap"><table class="management-dashboard__table">' +
            '<thead><tr>' + headHtml + '</tr></thead><tbody>' + bodyHtml + '</tbody></table></div>'
        );
    }

    function renderOverview(cur, prev) {
        var panel = el('panel-overview');
        var attention = cur.bundles
            .map(function (b) {
                return {
                    label: b.row.label,
                    sent: b.ch.sent,
                    leads: b.row.leads_orders,
                    c2: b.row.c2_pct,
                    net: b.row.paid_net
                };
            })
            .sort(function (a, b) { return a.c2 - b.c2; });

        var attentionHtml = attention.map(function (a) {
            return (
                '<div class="crm-watch-row">' +
                '<div><strong>' + a.label + '</strong>' +
                '<div class="management-dashboard__kpi-hint">' +
                fmtInt(a.leads) + ' заявок · ' + fmtInt(a.sent) + ' sent</div></div>' +
                '<strong class="crm-tone crm-tone--' + attentionTone(a.c2) + '">' +
                fmtPct(a.c2) + '</strong></div>'
            );
        }).join('');

        panel.innerHTML =
            '<section class="management-dashboard__section">' +
            '<h2 class="management-dashboard__section-title">Обзор опережающих</h2>' +
            '<div class="management-dashboard__kpi-grid">' +
            kpiHtml('Отправлено', fmtInt(cur.sent), prev ? deltaPct(cur.sent, prev.sent) : null,
                'OR ' + fmtPct(cur.orAll) + ' · CTR ' + fmtPct(cur.ctrAll)) +
            kpiHtml('Заявки', fmtInt(cur.leads), prev ? deltaPct(cur.leads, prev.leads) : null) +
            kpiHtml('C1 (от sent)', fmtPct(cur.c1s, 3), prev ? deltaPct(cur.c1s, prev.c1s) : null) +
            kpiHtml('C2 · плательщики',
                fmtPct(cur.c2All) + ' · ' + fmtInt(cur.paidUsers),
                prev ? deltaPct(cur.c2All, prev.c2All) : null,
                'Net: ' + fmtMoney(cur.paidNet)) +
            '</div></section>' +
            '<section class="management-dashboard__section">' +
            '<h2 class="management-dashboard__section-title">Очередь внимания · C2 ↑</h2>' +
            '<p class="management-dashboard__section-hint">Направления с низким C2 — приоритет разбора</p>' +
            '<div class="management-dashboard__kpi">' + attentionHtml + '</div></section>' +
            '<section class="management-dashboard__section">' +
            '<h2 class="management-dashboard__section-title">Отправлено по направлениям</h2>' +
            '<div class="management-dashboard__chart-wrap management-dashboard__chart-wrap--tall">' +
            '<canvas id="chart-overview-sent"></canvas></div></section>';

        makeBarChart(
            'chart-overview-sent',
            cur.bundles.map(function (b) {
                return b.row.label.replace('Дизайн интерьера', 'Дизайн');
            }),
            [{
                label: 'Sent',
                data: cur.bundles.map(function (b) { return b.ch.sent || 0; }),
                backgroundColor: '#6366f1'
            }]
        );
    }

    function renderLeading(cur, prev) {
        var panel = el('panel-leading');
        var rowsHtml = cur.bundles.map(function (b) {
            var r = b.row;
            var ch = b.ch;
            return (
                '<tr>' +
                '<td>' + r.label + '</td>' +
                '<td>' + fmtInt(ch.sent) + '</td>' +
                '<td>' + fmtInt(ch.delivered) + '</td>' +
                '<td>' + fmtPct(ch.or_pct) + '</td>' +
                '<td>' + fmtInt(ch.clicks) + '</td>' +
                '<td>' + fmtPct(ch.ctr_pct) + '</td>' +
                '<td>' + fmtInt(r.leads_orders) + '</td>' +
                '<td>' + fmtPct(c1Sent(r.leads_orders, ch.sent), 4) + '</td>' +
                '<td>' + fmtPct(c1Clicks(r.leads_orders, ch.clicks), 2) + '</td>' +
                '<td>' + fmtInt(r.lead_users) + '</td>' +
                '<td>' + fmtInt(r.paid_users) + '</td>' +
                '<td class="crm-tone crm-tone--' + attentionTone(r.c2_pct) + '">' +
                fmtPct(r.c2_pct) + '</td>' +
                '<td>' + fmtMoney(r.paid_net) + '</td>' +
                '</tr>'
            );
        }).join('');

        panel.innerHTML =
            '<section class="management-dashboard__section">' +
            '<h2 class="management-dashboard__section-title">Коммуникации</h2>' +
            '<div class="management-dashboard__kpi-grid">' +
            kpiHtml('Отправлено', fmtInt(cur.sent), prev ? deltaPct(cur.sent, prev.sent) : null) +
            kpiHtml('OR', fmtPct(cur.orAll), prev ? deltaPct(cur.orAll, prev.orAll) : null) +
            kpiHtml('CTR', fmtPct(cur.ctrAll), prev ? deltaPct(cur.ctrAll, prev.ctrAll) : null) +
            kpiHtml('Заявки', fmtInt(cur.leads), prev ? deltaPct(cur.leads, prev.leads) : null) +
            kpiHtml('C1', fmtPct(cur.c1s, 3), prev ? deltaPct(cur.c1s, prev.c1s) : null) +
            kpiHtml('C2', fmtPct(cur.c2All) + ' · ' + fmtInt(cur.paidUsers),
                prev ? deltaPct(cur.c2All, prev.c2All) : null) +
            '</div></section>' +
            '<section class="management-dashboard__section">' +
            '<h2 class="management-dashboard__section-title">Sent по направлениям</h2>' +
            '<div class="management-dashboard__chart-wrap management-dashboard__chart-wrap--tall">' +
            '<canvas id="chart-leading-sent"></canvas></div></section>' +
            '<section class="management-dashboard__section">' +
            tableWrap(
                '<th>Направление</th><th>Sent</th><th>Delivered</th><th>OR</th><th>Клики</th><th>CTR</th>' +
                '<th>Заявки</th><th>C1 sent</th><th>C1 clicks</th><th>Лиды</th><th>Плательщ.</th><th>C2</th><th>Net</th>',
                rowsHtml
            ) +
            '<p class="management-dashboard__section-hint">Итого net: ' + fmtMoney(cur.paidNet) +
            ' · заявки: ' + fmtInt(cur.leads) + '</p></section>';

        makeBarChart(
            'chart-leading-sent',
            cur.bundles.map(function (b) {
                return b.row.label.replace('Дизайн интерьера', 'Дизайн');
            }),
            [{
                label: 'Sent',
                data: cur.bundles.map(function (b) { return b.ch.sent || 0; }),
                backgroundColor: '#8b5cf6'
            }]
        );
    }

    function renderBase(pack, cur) {
        var panel = el('panel-base');
        var baseRows = filterRows((pack.base.data && pack.base.data.rows) || [], state.dir);
        var emailBaseSum = baseRows.reduce(function (s, r) { return s + (r.email_base || 0); }, 0);
        var tgSum = baseRows.reduce(function (s, r) { return s + (r.messenger_tg || 0); }, 0);
        var vkSum = baseRows.reduce(function (s, r) { return s + (r.messenger_vk || 0); }, 0);
        var maxSum = sumMaxDedup(baseRows);
        var msgBaseSum = tgSum + vkSum + maxSum;
        var totalBaseSum = emailBaseSum + msgBaseSum;
        var activeSum = baseRows.reduce(function (s, r) { return s + (r.active_180d || 0); }, 0);
        var coldSum = baseRows.reduce(function (s, r) { return s + (r.cold_180d || 0); }, 0);
        var hotSum = baseRows.reduce(function (s, r) { return s + (r.hot_3clicks || 0); }, 0);
        var reanimSum = baseRows.reduce(function (s, r) { return s + (r.reanimation || 0); }, 0);

        var rowsHtml = baseRows.map(function (r) {
            var msg = (r.messenger_tg || 0) + (r.messenger_vk || 0) + (r.messenger_max || 0);
            return (
                '<tr>' +
                '<td>' + r.label + '</td>' +
                '<td>' + fmtInt((r.email_base || 0) + msg) + '</td>' +
                '<td>' + fmtInt(r.email_base) + '</td>' +
                '<td>' + fmtInt(msg) + '</td>' +
                '<td>' + fmtInt(r.messenger_tg) + '</td>' +
                '<td>' + fmtInt(r.messenger_vk) + '</td>' +
                '<td>' + fmtInt(r.messenger_max) + '</td>' +
                '<td>' + fmtInt(r.active_180d) + '</td>' +
                '<td>' + fmtInt(r.cold_180d) + '</td>' +
                '<td>' + fmtInt(r.hot_3clicks) + '</td>' +
                '</tr>'
            );
        }).join('');

        panel.innerHTML =
            '<section class="management-dashboard__section">' +
            '<h2 class="management-dashboard__section-title">База</h2>' +
            '<div class="management-dashboard__kpi-grid">' +
            kpiHtml('База общая', fmtInt(totalBaseSum)) +
            kpiHtml('Email', fmtInt(emailBaseSum)) +
            kpiHtml('Мессенджеры', fmtInt(msgBaseSum)) +
            kpiHtml('TG / VK / MAX', fmtInt(tgSum) + ' / ' + fmtInt(vkSum) + ' / ' + fmtInt(maxSum)) +
            kpiHtml('Активная (email)', fmtInt(activeSum)) +
            kpiHtml('Холодная (email)', fmtInt(coldSum)) +
            kpiHtml('Горячая (email)', fmtInt(hotSum)) +
            kpiHtml('Реанимация', fmtInt(reanimSum)) +
            '</div>' +
            '<p class="management-dashboard__section-hint">Отписки enKod за период: ' +
            fmtInt(cur.unsub_cabinet) + '</p></section>' +
            '<section class="management-dashboard__section">' +
            tableWrap(
                '<th>Направление</th><th>Общая</th><th>Email</th><th>Мессенджеры</th>' +
                '<th>TG</th><th>VK</th><th>MAX</th><th>Активная</th><th>Холодная</th><th>Горячая</th>',
                rowsHtml
            ) +
            '<p class="management-dashboard__section-hint">MAX ПКСД 737 — одна база на пси/коуч/секс; в сумме «Все» считается один раз. Active/cold/hot — только email.</p></section>';
    }

    function renderFunnel(pack, cur) {
        var panel = el('panel-funnel');
        var baseRows = filterRows((pack.base.data && pack.base.data.rows) || [], state.dir);
        var rowsHtml = baseRows.map(function (r) {
            var lead = cur.bundles.find(function (b) { return b.row.direction === r.direction; });
            var row = lead && lead.row;
            return (
                '<tr>' +
                '<td>' + r.label + '</td>' +
                '<td>' + fmtInt(row ? row.regs : null) + '</td>' +
                '<td>' + fmtInt(row ? row.leads_orders : null) + '</td>' +
                '<td>' + fmtInt(row ? row.paid_users : null) + '</td>' +
                '<td>' + fmtInt(r.payers_12m) + '</td>' +
                '<td>' + fmtInt(r.reanimation) + '</td>' +
                '</tr>'
            );
        }).join('');

        panel.innerHTML =
            '<section class="management-dashboard__section">' +
            '<h2 class="management-dashboard__section-title">Воронка</h2>' +
            '<div class="management-dashboard__kpi-grid">' +
            kpiHtml('Заявки', fmtInt(cur.leads)) +
            kpiHtml('Уник. лиды', fmtInt(cur.leadUsers)) +
            kpiHtml('Плательщики C2', fmtInt(cur.paidUsers)) +
            kpiHtml('C2%', fmtPct(cur.c2All)) +
            '</div></section>' +
            '<section class="management-dashboard__section">' +
            '<h2 class="management-dashboard__section-title">Заявки vs плательщики</h2>' +
            '<div class="management-dashboard__chart-wrap management-dashboard__chart-wrap--tall">' +
            '<canvas id="chart-funnel"></canvas></div></section>' +
            '<section class="management-dashboard__section">' +
            tableWrap(
                '<th>Направление</th><th>Рег.</th><th>Заявки</th><th>Плательщ. (C2)</th>' +
                '<th>Плательщ. 12м</th><th>Реанимация</th>',
                rowsHtml
            ) + '</section>';

        makeBarChart(
            'chart-funnel',
            cur.bundles.map(function (b) {
                return b.row.label.replace('Дизайн интерьера', 'Дизайн');
            }),
            [
                {
                    label: 'Заявки',
                    data: cur.bundles.map(function (b) { return b.row.leads_orders || 0; }),
                    backgroundColor: '#3b82f6'
                },
                {
                    label: 'Плательщики',
                    data: cur.bundles.map(function (b) { return b.row.paid_users || 0; }),
                    backgroundColor: '#22c55e'
                }
            ]
        );
    }

    function renderRfm(pack) {
        var panel = el('panel-rfm');
        var rfmData = pack.rfm.data || {};
        var byDir = rfmData.byDirection || {};
        var order = rfmData.segmentOrder || RFM_ORDER;
        var dirs = state.dir === 'all'
            ? ['nutra', 'psi', 'sex', 'icf', 'design']
            : [state.dir];
        var rfmAgg = {};
        order.forEach(function (lab) { rfmAgg[lab] = 0; });
        var rfmUsers = 0;
        var rfmTrunc = false;
        dirs.forEach(function (d) {
            var block = byDir[d];
            if (!block) return;
            rfmUsers += block.users || 0;
            if (block.truncated) rfmTrunc = true;
            order.forEach(function (lab) {
                rfmAgg[lab] += (block.segments && block.segments[lab] && block.segments[lab].count) || 0;
            });
        });
        var baseRows = filterRows((pack.base.data && pack.base.data.rows) || [], state.dir);
        var payers12Sum = baseRows.reduce(function (s, r) { return s + (r.payers_12m || 0); }, 0);

        var rowsHtml = order.filter(function (lab) { return rfmAgg[lab] > 0; }).map(function (lab) {
            return (
                '<tr><td>' + lab + '</td><td>' + fmtInt(rfmAgg[lab]) + '</td><td>' +
                fmtPct(rfmUsers ? (100 * rfmAgg[lab]) / rfmUsers : 0) + '</td></tr>'
            );
        }).join('');

        panel.innerHTML =
            '<section class="management-dashboard__section">' +
            '<h2 class="management-dashboard__section-title">RFM</h2>' +
            '<div class="management-dashboard__kpi-grid">' +
            kpiHtml('Плательщики в RFM', fmtInt(rfmUsers) + (rfmTrunc ? ' *' : '')) +
            kpiHtml('Champions', fmtInt(rfmAgg.Champions)) +
            kpiHtml('Hibernating', fmtInt(rfmAgg.Hibernating)) +
            '</div></section>' +
            '<section class="management-dashboard__section">' +
            '<h2 class="management-dashboard__section-title">Распределение RFM</h2>' +
            '<div class="management-dashboard__chart-wrap management-dashboard__chart-wrap--tall">' +
            '<canvas id="chart-rfm"></canvas></div>' +
            (rfmTrunc
                ? '<p class="management-dashboard__section-hint">*Нутра: sample 2000/16895 платежей</p>'
                : '') +
            '</section>' +
            '<section class="management-dashboard__section">' +
            tableWrap('<th>Сегмент</th><th>Клиенты</th><th>Доля</th>', rowsHtml) +
            '<p class="management-dashboard__section-hint">Плательщики 12м (сумма баз): ' +
            fmtInt(payers12Sum) + '</p></section>';

        makeBarChart(
            'chart-rfm',
            order.slice(),
            [{
                label: 'Клиенты',
                data: order.map(function (lab) { return rfmAgg[lab] || 0; }),
                backgroundColor: '#a855f7'
            }]
        );
    }

    function renderNotes(cur) {
        var panel = el('panel-notes');
        panel.innerHTML =
            '<section class="management-dashboard__section">' +
            '<h2 class="management-dashboard__section-title">Оговорки</h2>' +
            '<div class="crm-callout"><strong>Активная / холодная / горячая — только email.</strong> ' +
            'Считаем из enKod-сегментов. Нутра: активная ≈ 90д. ПКСД: холодная = «Неактивная», активная = база − холодная.</div>' +
            '<div class="crm-callout"><strong>C2 = когорта заявок → оплаты.</strong> ' +
            'Заявка по utm_medium в периоде → оплаты с даты заявки.</div>' +
            '<div class="crm-callout crm-callout--warn"><strong>Заявки не режутся по каналу.</strong> ' +
            'CRM utm_medium = направление. C1/C2 при фильтре канала — ориентир.</div>' +
            '<div class="crm-callout"><strong>Каналы и база.</strong> ' +
            'MAX BotHelp UI 2026-09-08: Нутра 22624 · ПКСД 737 на три направления · дизайн 8. ' +
            'Срез: авг / сен 2026.</div>' +
            '<p class="management-dashboard__section-hint">unmatched email: ' +
            fmtInt(cur.unmatched_email) +
            '. Сбор: n8n → EdproBiz + Salebot (TG/VK) + enKod (email). MAX/sent мессенджеров и email active/cold/hot — carry.</p>' +
            '<p class="management-dashboard__section-hint">Датасеты: <code>crm.leading</code>, <code>crm.base</code>, <code>crm.rfm</code>.</p>' +
            '</section>';
    }

    function showTab(tab) {
        state.tab = tab;
        document.querySelectorAll('.management-dashboard__tab').forEach(function (btn) {
            var active = btn.getAttribute('data-tab') === tab;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        ['overview', 'leading', 'base', 'funnel', 'rfm', 'notes'].forEach(function (id) {
            var panel = el('panel-' + id);
            if (!panel) return;
            var on = id === tab;
            panel.classList.toggle('is-active', on);
            panel.hidden = !on;
        });
    }

    function renderChips(containerId, items, activeId, onClick) {
        var box = el(containerId);
        box.innerHTML = '';
        items.forEach(function (item) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'management-dashboard__chip' + (item.id === activeId ? ' is-active' : '');
            btn.textContent = item.label;
            btn.addEventListener('click', function () { onClick(item.id); });
            box.appendChild(btn);
        });
    }

    function renderFilters() {
        renderChips(
            'filter-period',
            PERIODS.map(function (ym) { return { id: ym, label: PERIOD_LABELS[ym] || ym }; }),
            state.period,
            function (id) {
                state.period = id;
                refresh();
            }
        );
        renderChips('filter-direction', DIRS, state.dir, function (id) {
            state.dir = id;
            refresh();
        });
        renderChips('filter-channel', CHANNELS, state.channel, function (id) {
            state.channel = id;
            refresh();
        });
    }

    function updateMeta(pack, cur) {
        var info = el('warehouse-info');
        var range = el('period-range');
        var leading = pack.leading;
        info.textContent =
            'Warehouse crm.* · ' + pack.period +
            ' · leading ' + (leading.checksum || '—') +
            ' · fetched ' + (leading.fetchedAt || '—');
        range.textContent = 'Срез: ' + (cur.from || '—') + ' → ' + (cur.to || '—');
    }

    function refresh() {
        renderFilters();
        setStatus('Читаем warehouse…');
        var prevYm = previousPeriod(state.period);
        var loads = [loadPeriod(state.period)];
        if (prevYm && prevYm !== state.period && PERIODS.indexOf(prevYm) !== -1) {
            loads.push(loadPeriod(prevYm));
        }

        Promise.all(loads).then(function (packs) {
            var pack = packs[0];
            var prevPack = packs[1] || null;
            var cur = aggregate(pack, state.dir, state.channel);
            var prev = prevPack ? aggregate(prevPack, state.dir, state.channel) : null;
            if (cur.to) {
                PERIOD_LABELS[state.period] = periodLabel(state.period, cur.to);
                renderFilters();
            }
            destroyCharts();
            updateMeta(pack, cur);
            renderOverview(cur, prev);
            renderLeading(cur, prev);
            renderBase(pack, cur);
            renderFunnel(pack, cur);
            renderRfm(pack);
            renderNotes(cur);
            showTab(state.tab);
            setStatus('Готово · ' + (PERIOD_LABELS[state.period] || state.period));
        }).catch(function (err) {
            console.error(err);
            setStatus(String(err.message || err), true);
        });
    }

    function init() {
        document.querySelectorAll('.management-dashboard__tab').forEach(function (btn) {
            btn.addEventListener('click', function () {
                showTab(btn.getAttribute('data-tab'));
            });
        });
        el('btn-reload').addEventListener('click', function () {
            state.cache = {};
            refresh();
        });
        loadPeriodCatalog().then(refresh);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
