/* ============================================================
   VIDNO — SCRIPT
   Sections:
    1. Helpers & data
    2. Navigation & routing
    3. Mobile burger
    4. Modal system
    5. Toast
    6. Pricing: FAQ accordion & plan modal
    7. Contact form
    8. Analyze text rotation
    9. AOS init
    ============================================================ */

'use strict';

/* ============ 1. HELPERS & DATA ============ */
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
const AUTH_API_BASE = location.protocol === 'file:' ? 'http://localhost:8000/api' : (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '8000' ? `http://${location.hostname}:8000/api` : '/api');
localStorage.removeItem('vidno-session-token');

async function authRequest(path, options = {}) {
    const response = await fetch(`${AUTH_API_BASE}${path}`, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || 'Не удалось выполнить запрос');
    return payload;
}

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
        body: 'Готовые шаблоны отчётов для команд, клиентов и руководства. Экспорт в PDF, XLSX, PNG (для графиков). White-label на тарифе «Бизнес». Расписание автоматической отправки на email.' },
    'about': { title: 'О Vidno', icon: 'fa-solid fa-circle-info',
        body: 'Vidno — платформа для мониторинга видимости бренда в AI-ассистентах: ChatGPT, Claude, Perplexity и других. Мы помогаем компаниям понимать, как их бренд представлен в ответах генеративных моделей, и даём инструменты для улучшения позиций.' },
    'terms': { title: 'Условия пользования', icon: 'fa-solid fa-file-lines',
        body: 'Используя Vidno, вы соглашаетесь с настоящими условиями. Сервис предоставляется «как есть». Мы не несём ответственности за содержание ответов AI-моделей. Все данные обрабатываются в соответствии с политикой конфиденциальности.' },
    'agreement': { title: 'Пользовательское соглашение', icon: 'fa-solid fa-file-signature',
        body: 'Настоящее соглашение регулирует отношения между Vidno и пользователем сервиса. Регистрируясь, вы подтверждаете, что ознакомились и согласны с условиями использования платформы.' },
    'privacy': { title: 'Политика конфиденциальности', icon: 'fa-solid fa-shield-halved',
        body: 'Vidno собирает минимально необходимые данные для работы сервиса: email, имя, название бренда. Данные не передаются третьим лицам. Вы можете запросить удаление данных в любой момент через поддержку.' }
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

/* ============ 3. MOBILE BURGER ============ */
$('#burger').addEventListener('click', () => {
    $('#navMenu').classList.toggle('open');
    $('#burger').classList.toggle('open');
});

/* ============ 4. MODAL SYSTEM ============ */
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
                <p class="form-error" id="authError" role="alert" hidden></p>
                <button type="submit" class="btn btn-primary btn-block"><i class="fa-solid fa-right-to-bracket"></i> Войти</button>
            </form>
        `);
        $('#modalForm').addEventListener('submit', async e => {
            e.preventDefault();
            const form = e.currentTarget; const button = form.querySelector('button[type="submit"]'); const error = $('#authError');
            button.disabled = true; error.hidden = true;
            try {
                await authRequest('/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
                closeModal(); showToast('Вход выполнен! Открываем дашборд…', 'fa-solid fa-circle-check');
                setTimeout(() => { window.location.href = 'dashboard.html'; }, 400);
            } catch (requestError) { error.textContent = requestError.message; error.hidden = false; button.disabled = false; }
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
            ${isDemo ? '' : '<div class="form-row"><label>Пароль</label><input type="password" name="password" required placeholder="Не менее 8 символов" minlength="8" maxlength="128" autocomplete="new-password"></div><p class="form-error" id="authError" role="alert" hidden></p>'}
            <button type="submit" class="btn btn-primary btn-block"><i class="fa-solid fa-rocket"></i> ${isDemo ? 'Получить демо' : 'Создать аккаунт'}</button>
        </form>
    `);
    $('#modalForm').addEventListener('submit', async e => {
        e.preventDefault();
        if (isDemo) { closeModal(); showToast('Заявка принята! Демо-отчёт придёт на почту.'); return; }
        const form = e.currentTarget; const button = form.querySelector('button[type="submit"]'); const error = $('#authError');
        button.disabled = true; error.hidden = true;
        try {
            const payload = Object.fromEntries(new FormData(form));
            await authRequest('/auth/register', { method: 'POST', body: JSON.stringify(payload) });
            closeModal(); showToast('Аккаунт создан! Открываем дашборд…', 'fa-solid fa-circle-check');
            setTimeout(() => { window.location.href = 'dashboard.html'; }, 400);
        } catch (requestError) { error.textContent = requestError.message; error.hidden = false; button.disabled = false; }
    });
}

if (new URLSearchParams(location.search).get('auth') === 'login') {
    history.replaceState({}, '', location.pathname);
    openCtaModal('login');
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



/* ============ 5. TOAST ============ */
const toastEl = $('#toast');
let toastTimer;
function showToast(msg, icon = 'fa-solid fa-circle-check') {
    toastEl.innerHTML = `<i class="${icon}"></i> ${msg}`;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3500);
}

/* ============ 6. PRICING — FAQ ============ */
$$('.acc-head').forEach(head => {
    head.addEventListener('click', () => {
        const item = head.parentElement;
        const wasOpen = item.classList.contains('open');
        $$('.acc-item').forEach(i => i.classList.remove('open'));
        if (!wasOpen) item.classList.add('open');
    });
});

/* ============ 7. PRICING TOGGLE ============ */
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

/* ============ 8. CONTACT FORM ============ */
$('#contactForm').addEventListener('submit', e => {
    e.preventDefault();
    const data = new FormData(e.target);
    const name = data.get('name');
    e.target.reset();
    showToast(`Спасибо, ${name}! Сообщение отправлено.`, 'fa-solid fa-paper-plane');
});

/* ============ 9. ANALYZE TEXT ROTATION ============ */
const analyzeModels = [
    { name: 'ChatGPT', percent: 78 },
    { name: 'Claude', percent: 57 },
    { name: 'Perplexity', percent: 92 },
    { name: 'Алиса AI', percent: 64 },
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

/* ============ 10. INIT ============ */
document.addEventListener('DOMContentLoaded', () => {
    // init AOS
    if (window.AOS) {
        AOS.init({ duration: 700, once: true, offset: 60, easing: 'ease-out-cubic' });
    }
    // mark home nav active
    navLinks[0].classList.add('active');
});
