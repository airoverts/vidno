/* ============================================================
   VIDNO — SCRIPT
   Sections:
    1. Helpers & data
    2. Navigation & routing
    3. Mobile burger
    4. Modal system
    5. Toast
    6. Dashboard: KPIs, charts, tables, tabs, recommendations
    7. Pricing: FAQ accordion & plan modal
    8. Contact form
    9. AOS init
    ============================================================ */

'use strict';

/* ============ 1. HELPERS & DATA ============ */
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

function mulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

let _seededRandom = mulberry32(42);
const resetSeed = () => { _seededRandom = mulberry32(42); };

const rnd = (min, max) => _seededRandom() * (max - min) + min;
const rndInt = (min, max) => Math.floor(rnd(min, max + 1));
const pick = arr => arr[rndInt(0, arr.length - 1)];

const AI_MODELS = ['ChatGPT', 'Claude', 'Perplexity', 'YandexGPT', 'GigaChat', 'Gemini', 'Copilot'];

const QUERIES_POOL = [
    'лучший сервис видимости бренда в AI',
    'топ платформа для мониторинга AI',
    'как измерить видимость в ChatGPT',
    'инструмент GEO оптимизации',
    'сравнение брендов в AI-ответах',
    'аналитика AI-поиска для маркетинга',
    'доля голоса в ChatGPT',
    'мониторинг упоминаний в Claude',
    'отчёт по AI-видимости',
    'трекинг позиций в Perplexity',
    'как AI рекомендует бренды',
    'инструменты generative SEO'
];

const COMPETITORS = [
    { name: 'Vidno',    sov: 34, me: true,  grad: 'linear-gradient(135deg,#028090,#008896)' },
    { name: 'BrandA',   sov: 26, me: false, grad: 'linear-gradient(135deg,#4F6F6F,#0B2B2F)' },
    { name: 'BrandB',   sov: 21, me: false, grad: 'linear-gradient(135deg,#5B6B6D,#4F6F6F)' },
    { name: 'BrandC',   sov: 19, me: false, grad: 'linear-gradient(135deg,#888780,#5B6B6D)' }
];

// Рейтинг цитируемости брендов смартфонов в AI-ответах (за 30 дней)
// базовые значения по каждой AI-модели; при рендере добавляется случайная вариация
const BRANDS_DATA = {
    all:        { Apple: 1240, Samsung: 980, Xiaomi: 720, Google: 560, OnePlus: 390, Huawei: 210 },
    ChatGPT:    { Apple: 520,  Samsung: 410, Xiaomi: 300, Google: 230, OnePlus: 160, Huawei: 90  },
    Claude:     { Apple: 340,  Samsung: 270, Xiaomi: 200, Google: 160, OnePlus: 110, Huawei: 55  },
    Perplexity: { Apple: 380,  Samsung: 300, Xiaomi: 220, Google: 170, OnePlus: 120, Huawei: 65  }
};
const BRANDS_ORDER = ['Apple', 'Samsung', 'Xiaomi', 'Google', 'OnePlus', 'Huawei'];

const ROLE_TYPES = [
    { key: 'leader',   label: 'Лидер',     cls: 'role-leader' },
    { key: 'alt',      label: 'Альтернатива', cls: 'role-alt' },
    { key: 'mention',  label: 'Упоминание',    cls: 'role-mention' },
    { key: 'none',     label: 'Нет',       cls: 'role-none' }
];

const RECOMMENDATIONS = [
    { prio: 'high', title: 'Добавить контент по запросу «GEO оптимизация»', tip: 'Создайте статью 1500+ слов с разметкой FAQPage и HowTo — это повысит шанс попадания в AI-ответы на 35%.', done: false },
    { prio: 'high', title: 'Усилить сравнительные страницы', tip: 'Конкуренты опережают в ответах «сравнение брендов». Добавьте таблицу сравнения с преимуществами.', done: false },
    { prio: 'med',  title: 'Обновить структуру данных на главной', tip: 'Внедрите Organization schema.org — это поможет AI корректно идентифицировать бренд.', done: false },
    { prio: 'med',  title: 'Получить упоминания на авторитетных ресурсах', tip: 'Цитирования на 3+ трастовых сайтах увеличивают видимость в среднем на 18%.', done: false },
    { prio: 'low',  title: 'Добавить глоссарий терминов отрасли', tip: 'Глоссарий с определениями часто попадает в ответы на «что такое …» запросы.', done: true },
    { prio: 'low',  title: 'Оптимизировать скорость загрузки', tip: 'LCP < 2.5с и CLS < 0.1 — положительный сигнал для AI-краулеров.', done: false }
];



const FEATURE_DETAILS = {
    'feat-1': { title: 'Мониторинг видимости', icon: 'fa-solid fa-chart-line',
        body: 'Модуль собирает ответы 15+ AI-моделей по вашим запросам и показывает: позицию бренда, роль в ответе, динамику за период. Фильтры по моделям, ролям и трендам. Экспорт в CSV/PDF.' },
    'feat-2': { title: 'Анализ намерений', icon: 'fa-solid fa-brain',
        body: 'Каждый запрос классифицируется по интенту: информационный, транзакционный, навигационный, сравнительный. Это помогает понять, на каких этапах воронки AI не упоминает ваш бренд.' },
    'feat-3': { title: 'Сравнение с конкурентами', icon: 'fa-solid fa-scale-balanced',
        body: 'Столбчатая и линейная диаграммы доли голоса. Сравнение по моделям, периодам, ролям. Видно, где вы опережаете, а где — отстаёте от конкретных конкурентов.' },
    'feat-4': { title: 'Приоритезированный план действий', icon: 'fa-solid fa-clipboard-check',
        body: 'Алгоритм анализирует инсайты и формирует список задач с приоритетом (высокий/средний/низкий), ожидаемым эффектом и подсказками по реализации. Чекбоксы — для отслеживания выполнения.' },
    'feat-5': { title: 'Технический аудит страниц', icon: 'fa-solid fa-stethoscope',
        body: 'Индекс здоровья контента: разметка schema.org, скорость, структура, цитируемость. Система находит страницы, которые мешают попаданию в AI-ответы, и предлагает конкретные правки.' },
    'feat-6': { title: 'Отчёты и экспорт', icon: 'fa-solid fa-file-export',
        body: 'Готовые шаблоны отчётов для команд, клиентов и руководства. Экспорт в PDF, XLSX, PNG (для графиков). White-label на тарифе «Бизнес». Расписание автоматической отправки на email.' }
};

/* ============ 2. NAVIGATION & ROUTING ============ */
const pages = $$('.page');
const navLinks = $$('.nav-link');

function navigate(pageId) {
    const sectionMap = {
        features: 'section-features',
        how: 'section-how',
        pricing: 'section-pricing',
        faq: 'section-faq',
        contacts: 'section-contacts',
        resources: 'section-features'
    };

    if (sectionMap[pageId] || pageId === 'home') {
        pages.forEach(p => p.classList.remove('active'));
        $('#page-home').classList.add('active');
        navLinks.forEach(l => l.classList.toggle('active', l.dataset.nav === 'home'));
        $('#navMenu').classList.remove('open');
        $('#burger').classList.remove('open');

        const sectionId = sectionMap[pageId];
        if (sectionId) {
            const sec = document.getElementById(sectionId);
            if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
        if (window.AOS) setTimeout(() => AOS.refresh(), 200);
        return;
    }

    const target = document.getElementById('page-' + pageId);
    if (!target) return;
    pages.forEach(p => p.classList.remove('active'));
    target.classList.add('active');

    navLinks.forEach(l => l.classList.toggle('active', l.dataset.nav === pageId));

    // close mobile menu
    $('#navMenu').classList.remove('open');
    $('#burger').classList.remove('open');

    window.scrollTo({ top: 0, behavior: 'smooth' });

    // lazy-init dashboard charts when first opened
    if (pageId === 'dashboard' && !state.dashReady) {
        initDashboard();
        state.dashReady = true;
    }
    // re-trigger AOS
    if (window.AOS) setTimeout(() => AOS.refresh(), 100);
}

// delegate all data-nav clicks
document.addEventListener('click', e => {
    const navEl = e.target.closest('[data-nav]');
    if (navEl) {
        e.preventDefault();
        navigate(navEl.dataset.nav);
    }
    const ctaEl = e.target.closest('[data-cta]');
    if (ctaEl) {
        e.preventDefault();
        openCtaModal(ctaEl.dataset.cta);
    }
    const planEl = e.target.closest('[data-plan]');
    if (planEl) {
        e.preventDefault();
        openPlanModal(planEl.dataset.plan);
    }
    const featEl = e.target.closest('[data-modal-open]');
    if (featEl) {
        e.preventDefault();
        openFeatureModal(featEl.dataset.modalOpen);
    }
    const tabEl = e.target.closest('.scenario-tab');
    if (tabEl) {
        const tabs = tabEl.parentElement;
        const content = tabs.nextElementSibling;
        tabs.querySelectorAll('.scenario-tab').forEach(t => t.classList.remove('active'));
        tabEl.classList.add('active');
        content.querySelectorAll('.scenario-panel').forEach(p => p.classList.remove('active'));
        content.querySelector(`[data-panel="${tabEl.dataset.tab}"]`).classList.add('active');
    }
});

/* ============ 3. STATE & MOBILE BURGER ============ */
const state = {
    charts: {},
    dashReady: false,
    queries: [],
    filter: ''
};

/* ============ 4. MOBILE BURGER ============ */
$('#burger').addEventListener('click', () => {
    $('#navMenu').classList.toggle('open');
    $('#burger').classList.toggle('open');
});

/* ============ 5. MODAL SYSTEM ============ */
const modalOverlay = $('#modalOverlay');
const modalBody = $('#modalBody');
const modalClose = $('#modalClose');

function openModal(html) {
    modalBody.innerHTML = html;
    modalOverlay.classList.add('open');
    document.body.style.overflow = 'hidden';
}
function closeModal() {
    modalOverlay.classList.remove('open');
    document.body.style.overflow = '';
    setTimeout(() => modalBody.innerHTML = '', 200);
}
modalClose.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function openCtaModal(type) {
    const isDemo = type === 'demo';
    const isLogin = type === 'login';
    if (isLogin) {
        openModal(`
            <h2>Вход в Vidno</h2>
            <p>Войдите в личный кабинет, чтобы открыть дашборд и отчёты.</p>
            <form class="modal-form" id="modalForm">
                <div class="form-row"><label>Email</label><input type="email" name="email" required placeholder="you@company.com"></div>
                <div class="form-row"><label>Пароль</label><input type="password" name="password" required placeholder="••••••••" minlength="6"></div>
                <button type="submit" class="btn btn-primary btn-block"><i class="fa-solid fa-right-to-bracket"></i> Войти</button>
            </form>
        `);
        $('#modalForm').addEventListener('submit', e => {
            e.preventDefault();
            closeModal();
            showToast('Вход выполнен! Открываем дашборд…', 'fa-solid fa-circle-check');
            setTimeout(() => navigate('dashboard'), 600);
        });
        return;
    }
    openModal(`
        <h2>${isDemo ? 'Запрос демо-отчёта' : 'Регистрация'}</h2>
        <p>${isDemo ? 'Оставьте контакты — пришлём отчёт по 10 запросам бесплатно.' : 'Создайте аккаунт за 30 секунд и получите 7 дней тарифа «Про».'}</p>
        <form class="modal-form" id="modalForm">
            <div class="form-row"><label>Имя</label><input type="text" name="name" required placeholder="Ваше имя"></div>
            <div class="form-row"><label>Email</label><input type="email" name="email" required placeholder="you@company.com"></div>
            <div class="form-row"><label>Бренд</label><input type="text" name="brand" placeholder="Название компании"></div>
            <button type="submit" class="btn btn-primary btn-block"><i class="fa-solid fa-rocket"></i> ${isDemo ? 'Получить демо' : 'Создать аккаунт'}</button>
        </form>
    `);
    $('#modalForm').addEventListener('submit', e => {
        e.preventDefault();
        closeModal();
        showToast(isDemo ? 'Заявка принята! Демо-отчёт придёт на почту.' : 'Аккаунт создан! Проверьте почту для активации.');
    });
}

function openPlanModal(plan) {
    openModal(`
        <h2>Тариф «${plan}»</h2>
        <p>Заполните форму — менеджер свяжется с вами для оформления и подбора оптимальной конфигурации.</p>
        <form class="modal-form" id="modalForm">
            <div class="form-row"><label>Имя</label><input type="text" name="name" required placeholder="Ваше имя"></div>
            <div class="form-row"><label>Email</label><input type="email" name="email" required placeholder="you@company.com"></div>
            <div class="form-row"><label>Компания</label><input type="text" name="company" placeholder="Название компании"></div>
            <input type="hidden" name="plan" value="${plan}">
            <button type="submit" class="btn btn-primary btn-block"><i class="fa-solid fa-check"></i> Оформить «${plan}»</button>
        </form>
    `);
    $('#modalForm').addEventListener('submit', e => {
        e.preventDefault();
        closeModal();
        showToast(`Заявка на тариф «${plan}» отправлена!`);
    });
}

function openFeatureModal(id) {
    const f = FEATURE_DETAILS[id];
    if (!f) return;
    openModal(`
        <div class="modal-thumb" style="background:var(--bg-soft); display:grid; place-items:center; color:var(--accent); font-size:3rem;">
            <i class="${f.icon}"></i>
        </div>
        <h2>${f.title}</h2>
        <p>${f.body}</p>
        <button class="btn btn-primary btn-block" data-cta="signup"><i class="fa-solid fa-rocket"></i> Попробовать</button>
    `);
}



/* ============ 6. TOAST ============ */
const toastEl = $('#toast');
let toastTimer;
function showToast(msg, icon = 'fa-solid fa-circle-check') {
    toastEl.innerHTML = `<i class="${icon}"></i> ${msg}`;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
}

/* ============ 7. DASHBOARD ============ */
function buildQueries() {
    const pool = [...QUERIES_POOL].sort(() => _seededRandom() - 0.5).slice(0, 7);
    return pool.map(q => ({
        text: q,
        pos: parseFloat(rnd(1, 5).toFixed(1)),
        role: pick(ROLE_TYPES),
        trend: rndInt(0, 1) ? 'up' : 'down',
        delta: rndInt(1, 8),
        updated: `${rndInt(1, 24)} ч назад`
    }));
}

function chartColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
        accent: cs.getPropertyValue('--accent').trim() || '#028090',
        accent2: cs.getPropertyValue('--accent-2').trim() || '#008896',
        accent3: cs.getPropertyValue('--accent-3').trim() || '#008896',
        text: cs.getPropertyValue('--text-soft').trim() || '#5B6B6D',
        grid: 'rgba(11,43,47,0.08)'
    };
}

function initDashboard() {
    resetSeed();
    const vis = rndInt(70, 92);
    const sov = rndInt(25, 42);
    const cit = rndInt(900, 1500);
    const pos = parseFloat(rnd(2, 3.5).toFixed(1));
    $('#kpi-vis').textContent = vis + '%';
    $('#kpi-sov').textContent = sov + '%';
    $('#kpi-cit').textContent = cit.toLocaleString('ru-RU');
    $('#kpi-pos').textContent = pos;

    state.queries = buildQueries();
    renderQueries();
    renderReco();
    renderCompCards();
    renderTrendChart();
    renderSovChart();
    renderRoleChart();
    renderCompChart();
    renderBrandsChart('all');
}

function renderQueries() {
    const tbody = $('#queriesTable tbody');
    const list = state.queries.filter(q => q.text.toLowerCase().includes(state.filter));
    tbody.innerHTML = list.map(q => `
        <tr>
            <td>${q.text}</td>
            <td><span class="pos-badge">${q.pos}</span></td>
            <td><span class="role-tag ${q.role.cls}">${q.role.label}</span></td>
            <td class="${q.trend === 'up' ? 'trend-up' : 'trend-down'}">
                <i class="fa-solid fa-arrow-${q.trend === 'up' ? 'up' : 'down'}"></i>
                ${q.delta}
            </td>
            <td class="muted">${q.updated}</td>
        </tr>
    `).join('') || `<tr><td colspan="5" class="muted" style="text-align:center;padding:20px;">Ничего не найдено</td></tr>`;
}

function renderReco() {
    const list = $('#recoList');
    list.innerHTML = RECOMMENDATIONS.map((r, i) => `
        <li class="reco-item ${r.done ? 'done' : ''}" data-i="${i}">
            <div class="reco-check">${r.done ? '<i class="fa-solid fa-check"></i>' : ''}</div>
            <div class="reco-text">
                <strong>${r.title}</strong>
                <div class="reco-tip">${r.tip}</div>
            </div>
            <span class="prio prio-${r.prio === 'high' ? 'high' : r.prio === 'med' ? 'med' : 'low'}">${r.prio === 'high' ? 'Высокий' : r.prio === 'med' ? 'Средний' : 'Низкий'}</span>
        </li>
    `).join('');

    $$('#recoList .reco-item').forEach(el => {
        el.addEventListener('click', e => {
            // toggle done only when clicking the checkbox area
            if (e.target.closest('.reco-check')) {
                const i = +el.dataset.i;
                RECOMMENDATIONS[i].done = !RECOMMENDATIONS[i].done;
                el.classList.toggle('done');
                const chk = el.querySelector('.reco-check');
                chk.innerHTML = RECOMMENDATIONS[i].done ? '<i class="fa-solid fa-check"></i>' : '';
                showToast(RECOMMENDATIONS[i].done ? 'Задача отмечена выполненной' : 'Задача возвращена в работу');
            } else {
                el.classList.toggle('open');
            }
        });
    });
}

function renderCompCards() {
    const wrap = $('#compCards');
    wrap.innerHTML = COMPETITORS.map(c => `
        <div class="comp-card ${c.me ? 'me' : ''}">
            <div class="comp-avatar" style="background:${c.grad}">${c.name[0]}</div>
            <div class="comp-name">${c.name}${c.me ? ' (вы)' : ''}</div>
            <div class="comp-sov">${c.sov}%</div>
            <div class="muted">доля голоса</div>
            <div class="comp-bar"><span style="width:${c.sov}%"></span></div>
        </div>
    `).join('');
}

function genTrendData(points = 30) {
    let v = rnd(50, 65);
    const arr = [];
    for (let i = 0; i < points; i++) {
        v += rnd(-5, 7);
        v = Math.max(20, Math.min(95, v));
        arr.push(Math.round(v));
    }
    return arr;
}

function renderTrendChart() {
    const ctx = $('#trendChart').getContext('2d');
    const labels = Array.from({ length: 30 }, (_, i) => `${i + 1}`);
    const c = chartColors();
    state.charts.trend = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'ChatGPT', data: genTrendData(), borderColor: '#028090', backgroundColor: 'rgba(2,128,144,0.08)', tension: 0.4, fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5 },
                { label: 'Claude', data: genTrendData(), borderColor: '#008896', backgroundColor: 'rgba(0,136,150,0.08)', tension: 0.4, fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5 },
                { label: 'Perplexity', data: genTrendData(), borderColor: '#5B6B6D', backgroundColor: 'rgba(91,107,109,0.08)', tension: 0.4, fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5 }
            ]
        },
        options: chartOpts(c)
    });
}

function renderSovChart() {
    const ctx = $('#sovChart').getContext('2d');
    const c = chartColors();
    state.charts.sov = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: AI_MODELS.slice(0, 5),
            datasets: [{
                data: [rndInt(15,30), rndInt(10,25), rndInt(10,20), rndInt(5,15), rndInt(5,15)],
                backgroundColor: ['#028090', '#008896', '#4F6F6F', '#5B6B6D', '#888780'],
                borderWidth: 0
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { color: c.text, padding: 14, font: { size: 11 } } } }
        }
    });
}

function renderRoleChart() {
    const ctx = $('#roleChart').getContext('2d');
    const c = chartColors();
    const counts = { leader: 0, alt: 0, mention: 0, none: 0 };
    state.queries.forEach(q => counts[q.role.key]++);
    state.charts.role = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: ['Лидер', 'Альтернатива', 'Упоминание', 'Нет'],
            datasets: [{
                data: [counts.leader, counts.alt, counts.mention, counts.none],
                backgroundColor: ['#028090', '#008896', '#5B6B6D', '#888780'],
                borderRadius: 6
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { ticks: { color: c.text }, grid: { display: false } }, y: { ticks: { color: c.text, stepSize: 1 }, grid: { color: c.grid } } }
        }
    });
}

function renderCompChart() {
    const ctx = $('#compChart').getContext('2d');
    const c = chartColors();
    // data per AI model
    const models = AI_MODELS.slice(0, 4);
    state.charts.comp = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: models,
            datasets: COMPETITORS.map(comp => ({
                label: comp.name,
                data: models.map(() => rndInt(5, 35)),
                backgroundColor: comp.name === 'Vidno' ? '#028090' : (comp.name === 'BrandA' ? '#008896' : (comp.name === 'BrandB' ? '#4F6F6F' : '#888780')),
                borderRadius: 4
            }))
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: { legend: { position: 'bottom', labels: { color: c.text } } },
            scales: {
                x: { stacked: true, ticks: { color: c.text }, grid: { display: false } },
                y: { stacked: true, ticks: { color: c.text }, grid: { color: c.grid } }
            }
        }
    });
}

// ===== Рейтинг цитируемости брендов (горизонтальный bar chart, монохром) =====
// возвращает массив значений для выбранного AI с небольшой случайной вариацией
function getBrandsData(ai) {
    const base = BRANDS_DATA[ai] || BRANDS_DATA.all;
    return BRANDS_ORDER.map(b => Math.max(0, Math.round(base[b] * (1 + (_seededRandom() - 0.5) * 0.08))));
}

function renderBrandsChart(ai = 'all') {
    // уничтожаем старый график перед перерисовкой
    if (state.charts.brands) { state.charts.brands.destroy(); state.charts.brands = null; }
    const ctx = $('#brandsChart').getContext('2d');
    const c = chartColors();
    const data = getBrandsData(ai);
    // чирнозовый нейтральный градиент: лидер — акцент, далее нейтральные
    const bars = ['#028090', '#008896', '#4F6F6F', '#5B6B6D', '#888780', '#8faca9'];
    state.charts.brands = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: BRANDS_ORDER,
            datasets: [{
                label: 'Упоминаний за 30 дней',
                data,
                backgroundColor: bars,
                borderColor: bars,
                borderWidth: 0,
                borderRadius: 4,
                barThickness: 28
            }]
        },
        options: {
            indexAxis: 'y', // горизонтальная ориентация
            responsive: true, maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(1,37,51,0.95)',
                    padding: 12, borderColor: c.accent, borderWidth: 1,
                    titleColor: '#fff', bodyColor: '#fff',
                    callbacks: {
                        title: items => `Бренд: ${items[0].label}`,
                        label: item => `упоминаний: ${item.parsed.x.toLocaleString('ru-RU')}`
                    }
                }
            },
            scales: {
                x: {
                    beginAtZero: true,
                    title: { display: true, text: 'Упоминаний в AI', color: c.text },
                    ticks: { color: c.text },
                    grid: { color: c.grid }
                },
                y: {
                    ticks: { color: c.text, font: { weight: '600' } },
                    grid: { display: false }
                }
            }
        }
    });
}

function chartOpts(c) {
    return {
        responsive: true, maintainAspectRatio: false,
        interaction: { intersect: false, mode: 'index' },
        plugins: {
            legend: { display: false },
            tooltip: { backgroundColor: 'rgba(1,37,51,0.95)', padding: 12, titleColor: '#fff', bodyColor: '#fff', borderColor: c.accent, borderWidth: 1 }
        },
        scales: {
            x: { ticks: { color: c.text, maxTicksLimit: 10, font: { size: 10 } }, grid: { display: false } },
            y: { ticks: { color: c.text, font: { size: 10 } }, grid: { color: c.grid }, beginAtZero: true, max: 100 }
        }
    };
}

// dashboard tabs
$$('.tab[data-tab]').forEach(tab => {
    tab.addEventListener('click', () => {
        $$('.tab[data-tab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        $$('.tab-panel').forEach(p => p.classList.remove('active'));
        $('#tab-' + tab.dataset.tab).classList.add('active');
        // resize charts on tab switch
        setTimeout(() => Object.values(state.charts).forEach(c => c && c.resize && c.resize()), 50);
    });
});

// query search
$('#querySearch').addEventListener('input', e => {
    state.filter = e.target.value.toLowerCase().trim();
    renderQueries();
});

// refresh dashboard
$('#refreshDash').addEventListener('click', () => {
    // destroy old charts
    Object.values(state.charts).forEach(c => c && c.destroy && c.destroy());
    state.charts = {};
    initDashboard();
    showToast('Данные обновлены');
});

// фильтры рейтинга брендов по AI-модели
$$('#brandFilters .pill').forEach(pill => {
    pill.addEventListener('click', () => {
        $$('#brandFilters .pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        renderBrandsChart(pill.dataset.ai);
    });
});

/* ============ 8. PRICING — FAQ ============ */
$$('.acc-head').forEach(head => {
    head.addEventListener('click', () => {
        const item = head.parentElement;
        const wasOpen = item.classList.contains('open');
        $$('.acc-item').forEach(i => i.classList.remove('open'));
        if (!wasOpen) item.classList.add('open');
    });
});

/* ============ 9. PRICING TOGGLE ============ */
const pricingToggle = $('#pricingToggle');
if (pricingToggle) {
    const labels = $$('.pricing-toggle-label');
    const priceValues = $$('.price-value[data-monthly]');
    const annualNotes = $$('.price-annual-note');

    pricingToggle.addEventListener('change', () => {
        const isAnnual = pricingToggle.checked;
        labels.forEach(l => l.classList.remove('active'));
        labels[isAnnual ? 1 : 0].classList.add('active');

        priceValues.forEach(el => {
            const price = isAnnual ? el.dataset.annual : el.dataset.monthly;
            el.innerHTML = `${price}<span>/мес</span>`;
        });

        annualNotes.forEach(n => {
            if (isAnnual) { n.classList.add('visible'); } else { n.classList.remove('visible'); }
        });
    });
}

/* ============ 10. CONTACT FORM ============ */
$('#contactForm').addEventListener('submit', e => {
    e.preventDefault();
    const data = new FormData(e.target);
    const name = data.get('name');
    e.target.reset();
    showToast(`Спасибо, ${name}! Сообщение отправлено.`, 'fa-solid fa-paper-plane');
});

/* ============ 10. ANALYZE TEXT ROTATION ============ */
const analyzeModels = [
    { name: 'ChatGPT', percent: 78 },
    { name: 'Claude', percent: 57 },
    { name: 'Perplexity', percent: 92 },
    { name: 'YandexGPT', percent: 64 },
    { name: 'GigaChat', percent: 45 },
    { name: 'Gemini', percent: 83 }
];

let currentModel = 0;
setInterval(() => {
    const el = document.getElementById('analyzeText');
    if (el) {
        currentModel = (currentModel + 1) % analyzeModels.length;
        const model = analyzeModels[currentModel];
        el.textContent = `Анализируем ${model.name}… ${model.percent}%`;
    }
}, 5000);

/* ============ 10.5 WORKSPACE — GigaChat check ============ */
const WS_API = 'http://localhost:8000/api';

$('#wsClearCache').addEventListener('click', async () => {
    try {
        const resp = await fetch(WS_API + '/cache', { method: 'DELETE' });
        const data = await resp.json();
        if (data.status === 'cleared') {
            const btn = $('#wsClearCache');
            const icon = btn.querySelector('i');
            icon.className = 'fa-solid fa-check';
            btn.style.color = 'var(--ok)';
            setTimeout(() => {
                icon.className = 'fa-solid fa-trash-can';
                btn.style.color = '';
            }, 1500);
        }
    } catch (e) {
        console.error('Cache clear failed:', e);
    }
});

$('#wsCheck').addEventListener('click', async () => {
    const brand = $('#wsBrand').value.trim();
    const query = $('#wsQuery').value.trim();
    const loader = $('#wsLoader');
    const result = $('#wsResult');
    const error = $('#wsError');

    if (!brand || !query) {
        error.textContent = 'Заполните оба поля: бренд и запрос';
        error.hidden = false;
        result.hidden = true;
        return;
    }

    error.hidden = true;
    result.hidden = true;
    loader.hidden = false;

    try {
        const resp = await fetch(WS_API + '/check', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brand, query })
        });
        const data = await resp.json();

        if (data.error) {
            error.textContent = 'Ошибка: ' + data.error;
            error.hidden = false;
            loader.hidden = true;
            return;
        }

        renderWsResult(data);
    } catch (e) {
        error.textContent = 'Не удалось подключиться к серверу. Убедитесь, что бэкенд запущен на localhost:8000';
        error.hidden = false;
    } finally {
        loader.hidden = true;
    }
});

function renderWsResult(data) {
    const result = $('#wsResult');
    const verdict = $('#wsVerdict');
    const meta = $('#wsMeta');
    const reasoningWrap = $('#wsReasoningWrap');
    const reasoning = $('#wsReasoning');
    const quotesWrap = $('#wsQuotesWrap');
    const quotes = $('#wsQuotes');
    const brandsWrap = $('#wsBrandsWrap');
    const brands = $('#wsBrands');
    const sourcesWrap = $('#wsSourcesWrap');
    const sources = $('#wsSources');

    if (data.mentioned) {
        verdict.className = 'ws-verdict mentioned';
        verdict.innerHTML = '<i class="fa-solid fa-check-circle"></i> Бренд упомянут';
    } else {
        verdict.className = 'ws-verdict not-mentioned';
        verdict.innerHTML = '<i class="fa-solid fa-times-circle"></i> Бренд не упомянут';
    }

    let metaHtml = '';
    if (data.position) {
        metaHtml += `<div class="ws-meta-item"><span class="ws-meta-label">Позиция в топе</span><span class="ws-meta-value">#${data.position}</span></div>`;
    }
    if (data.role && data.role !== 'не упомянут') {
        metaHtml += `<div class="ws-meta-item"><span class="ws-meta-label">Роль</span><span class="ws-meta-value">${data.role}</span></div>`;
    }
    meta.innerHTML = metaHtml;

    if (data.reasoning) {
        reasoning.textContent = data.reasoning;
        reasoningWrap.hidden = false;
    } else {
        reasoningWrap.hidden = true;
    }

    if (data.quotes && data.quotes.length) {
        quotes.innerHTML = data.quotes.map(q => `<li>${q}</li>`).join('');
        quotesWrap.hidden = false;
    } else {
        quotesWrap.hidden = true;
    }

    if (data.mentioned_brands && data.mentioned_brands.length) {
        brands.innerHTML = data.mentioned_brands.map(b => `<li>${b}</li>`).join('');
        brandsWrap.hidden = false;
    } else {
        brandsWrap.hidden = true;
    }

    if (data.sources && data.sources.length) {
        const analysisMap = {};
        if (data.source_analysis && data.source_analysis.length) {
            data.source_analysis.forEach(a => {
                analysisMap[a.source_index] = a;
            });
        }

        let sourcesHtml = '';
        data.sources.forEach((source, idx) => {
            const analysis = analysisMap[idx + 1];
            const mentioned = analysis ? analysis.mentions_brand : null;
            const statusIcon = mentioned === true ? '<i class="fa-solid fa-check-circle ws-source-mentioned"></i>' :
                               mentioned === false ? '<i class="fa-solid fa-times-circle ws-source-not-mentioned"></i>' :
                               '<i class="fa-solid fa-question-circle ws-source-unknown"></i>';

            const authClass = source.authority_score >= 8 ? 'ws-auth-high' :
                              source.authority_score >= 5 ? 'ws-auth-med' : 'ws-auth-low';

            const title = source.title || 'Без названия';
            const url = source.url || '#';

            sourcesHtml += `
                <div class="ws-source-card">
                    ${statusIcon}
                    <a href="${url}" target="_blank" rel="noopener" class="ws-source-link">${title}</a>
                    <span class="ws-source-auth ${authClass}">${source.authority_label}</span>
                </div>
            `;
        });

        sources.innerHTML = sourcesHtml;
        sourcesWrap.hidden = false;
    } else {
        sourcesWrap.hidden = true;
    }

    result.hidden = false;
}

/* ============ 11. INIT ============ */
document.addEventListener('DOMContentLoaded', () => {
    // init AOS
    if (window.AOS) {
        AOS.init({ duration: 700, once: true, offset: 60, easing: 'ease-out-cubic' });
    }
    // mark home nav active
    navLinks[0].classList.add('active');
});
