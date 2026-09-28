/* ============================================================
   VIDNO — SCRIPT
   Sections:
    1. Helpers & data
    2. Navigation & routing
    3. Mobile burger
    4. Modal system
    5. Toast
    6. FAQ accordion
    7. Analyze text rotation
    8. AOS init
    ============================================================ */

'use strict';

/* ============ 1. HELPERS & DATA ============ */
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));
const AUTH_API_BASE = location.protocol === 'file:' ? 'http://localhost:8000/api' : (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '8000' ? `http://${location.hostname}:8000/api` : '/api');
localStorage.removeItem('vidno-session-token');

function applyTheme() {
    const theme = localStorage.getItem('vidno-theme') || 'light';
    document.documentElement.dataset.theme = theme;
    const button = $('#themeToggle');
    if (button) {
        const lightAction = theme === 'dark';
        button.innerHTML = `<i class="fa-${lightAction ? 'regular' : 'solid'} ${lightAction ? 'fa-lightbulb' : 'fa-moon'}"></i>`;
        button.setAttribute('aria-label', lightAction ? 'Включить светлую тему' : 'Включить тёмную тему');
        button.title = lightAction ? 'Включить светлую тему' : 'Включить тёмную тему';
    }
}
function toggleTheme() {
    localStorage.setItem('vidno-theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    applyTheme();
}
applyTheme();
document.addEventListener('click', event => { if (event.target.closest('#themeToggle')) toggleTheme(); });

function initializeLogosMarquee() {
    const track = $('.logos-track');
    const group = track?.querySelector('.logos-group');
    if (!track || !group) return;
    while (track.children.length < 4) {
        const clone = group.cloneNode(true);
        clone.setAttribute('aria-hidden', 'true');
        track.appendChild(clone);
    }
    track.classList.add('is-ready');
}

initializeLogosMarquee();
document.addEventListener('click', async event => {
    const email = event.target.closest('[data-copy-email]');
    if (!email) return;
    const value = email.dataset.copyEmail;
    try {
        await navigator.clipboard.writeText(value);
        showToast('Email скопирован', 'fa-regular fa-copy');
    } catch {
        const field = document.createElement('textarea');
        field.value = value; field.style.position = 'fixed'; field.style.opacity = '0';
        document.body.appendChild(field); field.select(); document.execCommand('copy'); field.remove();
        showToast('Email скопирован', 'fa-regular fa-copy');
    }
});

async function syncLandingAccount() {
    try {
        const response = await fetch(`${AUTH_API_BASE}/auth/me`, { credentials: 'include' });
        if (!response.ok) return;
        const { user } = await response.json();
        const actions = $('.header-actions');
        if (!actions) return;
        actions.querySelector('[data-cta="login"]')?.remove();
        actions.querySelector('[data-cta="signup"]')?.remove();
        const account = document.createElement('a');
        account.className = 'account-pill'; account.href = 'dashboard.html';
        account.innerHTML = `<i class="fa-solid fa-user"></i><span>${user.name || user.email}</span>`;
        actions.insertBefore(account, $('#burger'));
    } catch { }
}
syncLandingAccount();

async function authRequest(path, options = {}) {
    const response = await fetch(`${AUTH_API_BASE}${path}`, { credentials: 'include', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || 'Не удалось выполнить запрос');
    return payload;
}

const FEATURE_DETAILS = {
    'feat-1': { title: 'Мониторинг видимости', icon: 'fa-solid fa-chart-line',
        body: 'Проверяйте выбранный запрос в GigaChat, Алисе AI, ChatGPT, Gemini и Perplexity. Результаты сохраняются в истории кабинета и используются для показателей видимости.' },
    'feat-2': { title: 'Анализ ответов', icon: 'fa-solid fa-brain',
        body: 'В результате проверки доступны ответ AI-системы, упоминание и роль бренда, контекст и выводы анализа.' },
    'feat-3': { title: 'Сравнение с конкурентами', icon: 'fa-solid fa-scale-balanced',
        body: 'В кабинете можно сопоставить бренд с конкурентами, обнаруженными в сохранённых результатах, и посмотреть долю упоминаний.' },
    'feat-4': { title: 'План роста', icon: 'fa-solid fa-clipboard-check',
        body: 'Повторные проверки одного запроса помогают подтвердить возможность для роста. По ней можно создать задачу, а после изменений провести контрольную проверку.' },
    'feat-5': { title: 'Источники', icon: 'fa-solid fa-link',
        body: 'В результатах проверки доступны найденные ссылки. Раздел «Источники» показывает, какие из них встречаются в сохранённой истории чаще.' },
    'feat-6': { title: 'История проверок', icon: 'fa-solid fa-clock-rotate-left',
        body: 'Завершённые проверки сохраняются в кабинете. Их можно открыть позже и сравнить показатели по брендам и AI-системам.' },
    'about': { title: 'О Vidno', icon: 'fa-solid fa-circle-info',
        body: 'Мы помогаем сотрудникам быть более продуктивными, а компаниям — более прибыльными — вот в чём наша основная задача. Мы ценим искренность и заботу, и то же самое мы стараемся дарить нашим клиентам. Спасибо, что выбираете Vidno.' }
};

/* ============ 2. NAVIGATION & ROUTING ============ */
const pages = $$('.page');
const navLinks = $$('.nav-link');

function navigate(pageId) {
    const sectionMap = {
        features: 'section-features',
        how: 'section-how',
        faq: 'section-faq',
        contacts: 'section-contacts'
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
    const isLogin = type === 'login';
    if (isLogin) {
        openModal(`
            <h2>Вход в Vidno</h2>
            <p>Войдите в личный кабинет, чтобы открыть проверки, историю и План роста.</p>
            <form class="modal-form ym-hide-content" id="modalForm">
                <div class="form-row"><label>Email</label><input type="email" name="email" autocomplete="username" required placeholder="you@yandex.ru"></div>
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
        <h2>Регистрация</h2>
        <p>Создайте аккаунт. Проверки и управление брендами станут доступны после активации доступа.</p>
        <form class="modal-form ym-hide-content" id="modalForm" autocomplete="off">
            <div class="form-row"><label>Имя</label><input type="text" name="name" autocomplete="name" required placeholder="Ваше имя"></div>
            <div class="form-row"><label>Email</label><input type="email" name="email" autocomplete="email" required placeholder="you@yandex.ru"></div>
            <div class="form-row"><label>Бренд</label><input type="text" name="brand" autocomplete="organization" placeholder="Название компании"></div>
            <div class="form-row"><label>Пароль</label><input type="password" name="password" required placeholder="Не менее 8 символов" minlength="8" maxlength="128" autocomplete="new-password"></div><p class="form-error" id="authError" role="alert" hidden></p>
            <button type="submit" class="btn btn-primary btn-block"><i class="fa-solid fa-rocket"></i> Создать аккаунт</button>
        </form>
    `);
    $('#modalForm').addEventListener('submit', async e => {
        e.preventDefault();
        const form = e.currentTarget; const button = form.querySelector('button[type="submit"]'); const error = $('#authError');
        button.disabled = true; error.hidden = true;
        try {
            const payload = Object.fromEntries(new FormData(form));
            await authRequest('/auth/register', { method: 'POST', body: JSON.stringify(payload) });
            closeModal(); showToast('Аккаунт создан. Доступ ожидает активации.', 'fa-solid fa-circle-check');
            setTimeout(() => { window.location.href = 'dashboard.html'; }, 400);
        } catch (requestError) { error.textContent = requestError.message; error.hidden = false; button.disabled = false; }
    });
}

if (new URLSearchParams(location.search).get('auth') === 'login') {
    history.replaceState({}, '', location.pathname);
    openCtaModal('login');
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
        <button class="btn btn-primary btn-block" data-cta="signup"><i class="fa-solid fa-rocket"></i> Создать аккаунт</button>
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

/* ============ 6. FAQ ============ */
$$('.acc-head').forEach(head => {
    head.addEventListener('click', () => {
        const item = head.parentElement;
        const wasOpen = item.classList.contains('open');
        $$('.acc-item').forEach(i => i.classList.remove('open'));
        if (!wasOpen) item.classList.add('open');
    });
});

/* ============ 7. ANALYZE TEXT ROTATION ============ */
const analyzeModels = [
    'ChatGPT',
    'Perplexity',
    'Алиса AI',
    'GigaChat',
    'Gemini'
];

let currentModel = 0;
setInterval(() => {
    const el = document.getElementById('analyzeText');
    if (el) {
        currentModel = (currentModel + 1) % analyzeModels.length;
        el.textContent = `Проверяем ответ ${analyzeModels[currentModel]}…`;
    }
}, 5000);

/* ============ 8. INIT ============ */
document.addEventListener('DOMContentLoaded', () => {
    // init AOS
    if (window.AOS) {
        AOS.init({ duration: 700, once: true, offset: 60, easing: 'ease-out-cubic' });
    }
    // mark home nav active
    navLinks[0].classList.add('active');
});
