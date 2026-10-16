'use strict';

const AUTH_API_BASE = location.protocol === 'file:' ? 'http://localhost:8000/api' : (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '8000' ? `http://${location.hostname}:8000/api` : '/api');
localStorage.removeItem('vidno-session-token');

function applyTheme() {
    const theme = window.VIDNO_DARK_THEME_ENABLED && localStorage.getItem('vidno-theme') === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-settings-tab="appearance"]').forEach(button => { button.hidden = !window.VIDNO_DARK_THEME_ENABLED; });
    document.querySelectorAll('[data-theme-choice]').forEach(button => {
        const selected = button.dataset.themeChoice === theme;
        button.classList.toggle('active', selected);
        button.setAttribute('aria-checked', String(selected));
        button.tabIndex = selected ? 0 : -1;
    });
}
applyTheme();
document.addEventListener('click', event => {
    const choice = event.target.closest('[data-theme-choice]');
    if (!window.VIDNO_DARK_THEME_ENABLED || !choice) return;
    localStorage.setItem('vidno-theme', choice.dataset.themeChoice);
    applyTheme();
    window.dispatchEvent(new CustomEvent('vidno-theme-change'));
});
document.addEventListener('keydown', event => {
    const choice = event.target.closest('[data-theme-choice]');
    if (!window.VIDNO_DARK_THEME_ENABLED || !choice || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const choices = [...document.querySelectorAll('[data-theme-choice]')];
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
    const next = choices[(choices.indexOf(choice) + direction + choices.length) % choices.length];
    next.click();
    next.focus();
});

async function loadSession() {
    let response;
    try { response = await fetch(`${AUTH_API_BASE}/auth/me`, { credentials: 'include' }); }
    catch { throw new Error('Нет связи с сервером. Повторите загрузку кабинета.'); }
    if (response.status === 401) {
        window.location.replace('index.html?auth=login');
        throw new Error('Требуется вход');
    }
    if (!response.ok) throw new Error('Не удалось проверить сессию. Повторите загрузку кабинета.');
    const { user } = await response.json();
    document.querySelector('#appUserName').textContent = user.name;
    return user;
}

document.querySelector('#appLogout').addEventListener('click', async () => {
    const button = document.querySelector('#appLogout');
    button.disabled = true;
    try { await fetch(`${AUTH_API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }); } finally { window.location.replace('index.html'); }
});

window.vidnoSessionPromise = loadSession();
window.vidnoSessionPromise.catch(() => {});
