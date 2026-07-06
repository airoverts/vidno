/* ============================================================
   VIDNO — SCRIPT
   Sections:
   1. Helpers & data
   2. Navigation & routing
   3. Theme toggle
   4. Mobile burger
   5. Modal system
   6. Toast
   7. Dashboard: KPIs, charts, tables, tabs, recommendations
   8. Pricing: FAQ accordion & plan modal
   9. Resources: blog/video/cases + glossary
   10. Contact form
   11. AOS init
   ============================================================ */

'use strict';

/* ============ 1. HELPERS & DATA ============ */
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
const rnd = (min, max) => Math.random() * (max - min) + min;
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
    { name: 'Vidno',    sov: 34, me: true,  grad: 'linear-gradient(135deg,#1a1a1a,#666666)' },
    { name: 'BrandA',   sov: 26, me: false, grad: 'linear-gradient(135deg,#333333,#1a1a1a)' },
    { name: 'BrandB',   sov: 21, me: false, grad: 'linear-gradient(135deg,#666666,#1a1a1a)' },
    { name: 'BrandC',   sov: 19, me: false, grad: 'linear-gradient(135deg,#1a1a1a,#4d4d4d)' }
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

const BLOG_POSTS = [
    { id: 1, title: 'Что такое Generative Engine Optimization (GEO)', date: '12 июня 2026', grad: 'linear-gradient(135deg,#1a1a1a,#666666)', icon: 'fa-solid fa-route',
      excerpt: 'GEO — новая дисциплина SEO, ориентированная на попадание в ответы AI-ассистентов. Разбираем основы.',
      body: 'Generative Engine Optimization (GEO) — это практика оптимизации контента и цифрового присутствия бренда для AI-генеративных систем (ChatGPT, Claude, Perplexity). В отличие от классического SEO, ориентированного на ранжирование ссылок, GEO фокусируется на том, чтобы AI упоминал ваш бренд в ответах. Ключевые факторы: структурированные данные, авторитетные источники, цитируемость, разметка schema.org, частота упоминаний на трастовых ресурсах.' },
    { id: 2, title: '5 стратегий роста видимости в ChatGPT', date: '28 мая 2026', grad: 'linear-gradient(135deg,#333333,#1a1a1a)', icon: 'fa-solid fa-rocket',
      excerpt: 'Практические шаги: от разметки до контент-стратегии, которые дают измеримый рост уже через 4–6 недель.',
      body: '1. Добавьте структурированные данные (Organization, FAQPage, HowTo). 2. Создавайте контент с прямым сравнением. 3. Получайте упоминания на авторитетных ресурсах. 4. Используйте списки и таблицы. 5. Обновляйте контент регулярно — AI предпочитает свежие данные.' },
    { id: 3, title: 'Метрики AI-видимости: что отслеживать', date: '5 мая 2026', grad: 'linear-gradient(135deg,#666666,#1a1a1a)', icon: 'fa-solid fa-chart-line',
      excerpt: 'Visibility Score, Share of Voice, цитируемость и позиция — разбираем, как считать и интерпретировать.',
      body: 'Основные метрики: Visibility Score — процент запросов, где бренд упомянут; Share of Voice — доля упоминаний среди конкурентов; Цитируемость — число ссылок на ваш ресурс; Средняя позиция — ранг бренда в выдаче AI. Каждую метрику важно отслеживать в динамике и по каждой модели отдельно.' }
];

const VIDEO_TUTORIALS = [
    { id: 1, title: 'Знакомство с дашбордом Vidno', duration: '4:32', grad: 'linear-gradient(135deg,#333333,#666666)', icon: 'fa-solid fa-gauge-high' },
    { id: 2, title: 'Настройка отслеживания конкурентов', duration: '6:15', grad: 'linear-gradient(135deg,#1a1a1a,#4d4d4d)', icon: 'fa-solid fa-users' },
    { id: 3, title: 'Как читать рекомендации и действовать', duration: '8:48', grad: 'linear-gradient(135deg,#666666,#1a1a1a)', icon: 'fa-solid fa-clipboard-check' }
];

const CASES = [
    { company: 'FinFlow', author: 'Анна Корсакова', role: 'Head of Brand', avatar: 'АК', grad: 'linear-gradient(135deg,#1a1a1a,#666666)',
      quote: 'За месяц подняли видимость в ChatGPT с 18% до 47%. Рост трафика — 30%.',
      nums: [{ v: '18→47%', l: 'видимость' }, { v: '+30%', l: 'трафик' }, { v: '1 мес', l: 'срок' }], industry: 'Финтех' },
    { company: 'EduPrime', author: 'Игорь Зайцев', role: 'CMO', avatar: 'ИЗ', grad: 'linear-gradient(135deg,#333333,#1a1a1a)',
      quote: 'Рекомендации Vidno по контенту дали +62% упоминаний в Claude за 2 месяца.',
      nums: [{ v: '+62%', l: 'упоминания' }, { v: 'x2.4', l: 'лиды из AI' }, { v: '2 мес', l: 'срок' }], industry: 'EdTech' },
    { company: 'RetailHub', author: 'Мария Волкова', role: 'Marketing Director', avatar: 'МВ', grad: 'linear-gradient(135deg,#666666,#1a1a1a)',
      quote: 'Доля голоса в Perplexity выросла с 12% до 29%. Теперь мы №1 в нише.',
      nums: [{ v: '12→29%', l: 'SoV' }, { v: '№1', l: 'в нише' }, { v: '3 мес', l: 'срок' }], industry: 'Ритейл' }
];

const GLOSSARY = [
    { term: 'Visibility Score', def: 'Процент запросов, в ответах на которые AI упоминает ваш бренд.' },
    { term: 'Share of Voice (SoV)', def: 'Доля упоминаний бренда от общего числа упоминаний всех конкурентов.' },
    { term: 'GEO', def: 'Generative Engine Optimization — оптимизация для AI-генеративных систем.' },
    { term: 'Цитируемость', def: 'Количество случаев, когда AI ссылается на ваш ресурс как на источник.' },
    { term: 'Роль бренда', def: 'Контекст упоминания: лидер, альтернатива, упоминание или отсутствие.' },
    { term: 'Intent-анализ', def: 'Определение намерения пользователя в запросе: информационный, транзакционный, сравнительный.' },
    { term: 'AI-модель', def: 'Большая языковая модель: ChatGPT, Claude, Perplexity, YandexGPT и др.' },
    { term: 'Позиция в AI', def: 'Условный ранг упоминания бренда в ответе (1 — первым, далее ниже).' }
];

const FEATURE_DETAILS = {
    'feat-1': { title: 'Мониторинг видимости', icon: 'fa-solid fa-chart-line', grad: 'linear-gradient(135deg,#1a1a1a,#666666)',
        body: 'Модуль собирает ответы 15+ AI-моделей по вашим запросам и показывает: позицию бренда, роль в ответе, динамику за период. Фильтры по моделям, ролям и трендам. Экспорт в CSV/PDF.' },
    'feat-2': { title: 'Анализ намерений', icon: 'fa-solid fa-brain', grad: 'linear-gradient(135deg,#333333,#1a1a1a)',
        body: 'Каждый запрос классифицируется по интенту: информационный, транзакционный, навигационный, сравнительный. Это помогает понять, на каких этапах воронки AI не упоминает ваш бренд.' },
    'feat-3': { title: 'Сравнение с конкурентами', icon: 'fa-solid fa-scale-balanced', grad: 'linear-gradient(135deg,#666666,#1a1a1a)',
        body: 'Столбчатая и линейная диаграммы доли голоса. Сравнение по моделям, периодам, ролям. Видно, где вы опережаете, а где — отстаёте от конкретных конкурентов.' },
    'feat-4': { title: 'Приоритезированный план действий', icon: 'fa-solid fa-clipboard-check', grad: 'linear-gradient(135deg,#1a1a1a,#4d4d4d)',
        body: 'Алгоритм анализирует инсайты и формирует список задач с приоритетом (высокий/средний/низкий), ожидаемым эффектом и подсказками по реализации. Чекбоксы — для отслеживания выполнения.' },
    'feat-5': { title: 'Технический аудит страниц', icon: 'fa-solid fa-stethoscope', grad: 'linear-gradient(135deg,#4d4d4d,#1a1a1a)',
        body: 'Индекс здоровья контента: разметка schema.org, скорость, структура, цитируемость. Система находит страницы, которые мешают попаданию в AI-ответы, и предлагает конкретные правки.' },
    'feat-6': { title: 'Отчёты и экспорт', icon: 'fa-solid fa-file-export', grad: 'linear-gradient(135deg,#333333,#666666)',
        body: 'Готовые шаблоны отчётов для команд, клиентов и руководства. Экспорт в PDF, XLSX, PNG (для графиков). White-label на тарифе «Бизнес». Расписание автоматической отправки на email.' }
};

/* ============ 2. NAVIGATION & ROUTING ============ */
const pages = $$('.page');
const navLinks = $$('.nav-link');

function navigate(pageId) {
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
});

/* ============ 3. THEME TOGGLE ============ */
// module-level state (declared early so setTheme can safely reference it at load time)
const state = {
    charts: {},
    dashReady: false,
    queries: [],
    filter: ''
};

const themeToggle = $('#themeToggle');
const themeIcon = themeToggle.querySelector('i');
function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeIcon.className = theme === 'dark' ? 'fa-solid fa-moon' : 'fa-solid fa-sun';
    try { localStorage.setItem('vidno-theme', theme); } catch (e) {}
    // update chart colors
    if (state.charts) {
        Object.values(state.charts).forEach(c => c && c.update && c.update());
    }
}
themeToggle.addEventListener('click', () => {
    const cur = document.documentElement.getAttribute('data-theme');
    setTheme(cur === 'dark' ? 'light' : 'dark');
});
// restore / sync icon with current theme
try {
    const saved = localStorage.getItem('vidno-theme');
    setTheme(saved || document.documentElement.getAttribute('data-theme') || 'light');
} catch (e) {
    setTheme('light');
}

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
        <div class="modal-thumb" style="background:${f.grad}; display:grid; place-items:center; color:#fff; font-size:3rem;">
            <i class="${f.icon}"></i>
        </div>
        <h2>${f.title}</h2>
        <p>${f.body}</p>
        <button class="btn btn-primary btn-block" data-cta="signup"><i class="fa-solid fa-rocket"></i> Попробовать</button>
    `);
}

function openBlogModal(post) {
    openModal(`
        <div class="modal-thumb" style="background:${post.grad}; display:grid; place-items:center; color:#fff; font-size:3rem;">
            <i class="${post.icon}"></i>
        </div>
        <div class="modal-meta">${post.date}</div>
        <h2>${post.title}</h2>
        <p>${post.body}</p>
        <p style="margin-top:14px;"><a href="#" class="btn btn-ghost btn-sm" onclick="event.preventDefault()"><i class="fa-solid fa-book-open"></i> Читать полностью</a></p>
    `);
}

function openVideoModal(video) {
    openModal(`
        <h2>${video.title}</h2>
        <div class="modal-meta">Длительность: ${video.duration}</div>
        <div class="video-frame" style="background:${video.grad}">
            <div style="text-align:center">
                <i class="fa-solid fa-play"></i>
                <p style="margin-top:10px; font-size:0.9rem;">Видеоплеер (демонстрационная заглушка)</p>
            </div>
        </div>
        <p class="muted">В реальном продукте здесь встроенный YouTube/ Vimeo плеер.</p>
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
    // pick 7 random queries with random attrs
    const pool = [...QUERIES_POOL].sort(() => Math.random() - 0.5).slice(0, 7);
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
        accent: cs.getPropertyValue('--accent').trim() || '#000000',
        accent2: cs.getPropertyValue('--accent-2').trim() || '#333333',
        accent3: cs.getPropertyValue('--accent-3').trim() || '#000000',
        text: cs.getPropertyValue('--text-soft').trim() || '#666666',
        grid: 'rgba(0,0,0,0.08)'
    };
}

function initDashboard() {
    // randomize KPIs
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
                { label: 'ChatGPT', data: genTrendData(), borderColor: '#1a1a1a', backgroundColor: 'rgba(0,0,0,0.06)', tension: 0.4, fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5 },
                { label: 'Claude', data: genTrendData(), borderColor: '#4d4d4d', backgroundColor: 'rgba(77,77,77,0.06)', tension: 0.4, fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5 },
                { label: 'Perplexity', data: genTrendData(), borderColor: '#999999', backgroundColor: 'rgba(153,153,153,0.06)', tension: 0.4, fill: true, borderWidth: 2, pointRadius: 0, pointHoverRadius: 5 }
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
                backgroundColor: ['#1a1a1a', '#4d4d4d', '#666666', '#999999', '#cccccc'],
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
                backgroundColor: ['#1a1a1a', '#4d4d4d', '#999999', '#cccccc'],
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
                backgroundColor: comp.name === 'Vidno' ? '#1a1a1a' : (comp.name === 'BrandA' ? '#4d4d4d' : (comp.name === 'BrandB' ? '#666666' : '#999999')),
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
    return BRANDS_ORDER.map(b => Math.max(0, Math.round(base[b] * (1 + (Math.random() - 0.5) * 0.08))));
}

function renderBrandsChart(ai = 'all') {
    // уничтожаем старый график перед перерисовкой
    if (state.charts.brands) { state.charts.brands.destroy(); state.charts.brands = null; }
    const ctx = $('#brandsChart').getContext('2d');
    const c = chartColors();
    const data = getBrandsData(ai);
    // градиенты серого для столбцов (от тёмного к светлому — визуальный рейтинг)
    const bars = ['#1a1a1a', '#2b2b2b', '#3d3d3d', '#555555', '#777777', '#999999'];
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
                    backgroundColor: 'rgba(26,26,26,0.95)',
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
            tooltip: { backgroundColor: 'rgba(26,26,26,0.95)', padding: 12, titleColor: '#fff', bodyColor: '#fff', borderColor: c.accent, borderWidth: 1 }
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

/* ============ 9. RESOURCES ============ */
function renderBlog() {
    $('#blogGrid').innerHTML = BLOG_POSTS.map(p => `
        <article class="blog-card" data-blog="${p.id}">
            <div class="blog-thumb" style="background:${p.grad}">
                <span><i class="${p.icon}"></i></span>
            </div>
            <div class="blog-body">
                <div class="blog-date"><i class="fa-regular fa-calendar"></i> ${p.date}</div>
                <h3>${p.title}</h3>
                <p>${p.excerpt}</p>
            </div>
        </article>
    `).join('');
    $$('#blogGrid .blog-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = +card.dataset.blog;
            openBlogModal(BLOG_POSTS.find(p => p.id === id));
        });
    });
}

function renderVideos() {
    $('#videoGrid').innerHTML = VIDEO_TUTORIALS.map(v => `
        <article class="video-card" data-video="${v.id}">
            <div class="video-thumb" style="background:${v.grad}">
                <div class="play"><div class="play-btn"><i class="fa-solid fa-play"></i></div></div>
            </div>
            <div class="video-body">
                <div class="video-date"><i class="fa-regular fa-clock"></i> ${v.duration}</div>
                <h3>${v.title}</h3>
            </div>
        </article>
    `).join('');
    $$('#videoGrid .video-card').forEach(card => {
        card.addEventListener('click', () => {
            const id = +card.dataset.video;
            openVideoModal(VIDEO_TUTORIALS.find(v => v.id === id));
        });
    });
}

function renderCases() {
    $('#caseGrid').innerHTML = CASES.map(c => `
        <article class="case-card">
            <div class="case-author">
                <div class="case-avatar" style="background:${c.grad}">${c.avatar}</div>
                <div>
                    <strong>${c.author}</strong>
                    <span>${c.role}, ${c.company} · ${c.industry}</span>
                </div>
            </div>
            <p class="case-quote">«${c.quote}»</p>
            <div class="case-nums">
                ${c.nums.map(n => `<div><strong>${n.v}</strong><span>${n.l}</span></div>`).join('')}
            </div>
        </article>
    `).join('');
}

function renderGlossary() {
    $('#glossary').innerHTML = GLOSSARY.map(g => `
        <div class="gloss-item">
            <div class="gloss-term">${g.term}</div>
            <div class="gloss-def">${g.def}</div>
        </div>
    `).join('');
}

// resources tabs
$$('.tab[data-rtab]').forEach(tab => {
    tab.addEventListener('click', () => {
        $$('.tab[data-rtab]').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        $$('.rtab-panel').forEach(p => p.classList.remove('active'));
        $('#rtab-' + tab.dataset.rtab).classList.add('active');
    });
});

/* ============ 10. CONTACT FORM ============ */
$('#contactForm').addEventListener('submit', e => {
    e.preventDefault();
    const data = new FormData(e.target);
    const name = data.get('name');
    e.target.reset();
    showToast(`Спасибо, ${name}! Сообщение отправлено.`, 'fa-solid fa-paper-plane');
});

/* ============ 11. INIT ============ */
document.addEventListener('DOMContentLoaded', () => {
    // init AOS
    if (window.AOS) {
        AOS.init({ duration: 700, once: true, offset: 60, easing: 'ease-out-cubic' });
    }
    renderBlog();
    renderVideos();
    renderCases();
    renderGlossary();
    // mark home nav active
    navLinks[0].classList.add('active');
});
