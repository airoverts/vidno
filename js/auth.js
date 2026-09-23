'use strict';

const AUTH_API_BASE = location.protocol === 'file:' ? 'http://localhost:8000/api' : (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '8000' ? `http://${location.hostname}:8000/api` : '/api');
localStorage.removeItem('vidno-session-token');

function applyTheme() {
    const theme = localStorage.getItem('vidno-theme') || 'light';
    document.documentElement.dataset.theme = theme;
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
    if (!choice) return;
    localStorage.setItem('vidno-theme', choice.dataset.themeChoice);
    applyTheme();
    window.dispatchEvent(new CustomEvent('vidno-theme-change'));
});
document.addEventListener('keydown', event => {
    const choice = event.target.closest('[data-theme-choice]');
    if (!choice || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const choices = [...document.querySelectorAll('[data-theme-choice]')];
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
    const next = choices[(choices.indexOf(choice) + direction + choices.length) % choices.length];
    next.click();
    next.focus();
});

async function loadSession() {
    try {
        const response = await fetch(`${AUTH_API_BASE}/auth/me`, { credentials: 'include' });
        if (!response.ok) throw new Error();
        const { user } = await response.json();
        document.querySelector('#appUserName').textContent = user.name;
        return user;
    } catch {
        window.location.replace('index.html?auth=login');
        throw new Error('Требуется вход');
    }
}

document.querySelector('#appLogout').addEventListener('click', async () => {
    const button = document.querySelector('#appLogout');
    button.disabled = true;
    try { await fetch(`${AUTH_API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' }); } finally { window.location.replace('index.html'); }
});

window.vidnoSessionPromise = loadSession();
