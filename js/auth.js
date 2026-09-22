'use strict';

const AUTH_API_BASE = location.protocol === 'file:' ? 'http://localhost:8000/api' : (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '8000' ? `http://${location.hostname}:8000/api` : '/api');
localStorage.removeItem('vidno-session-token');

function applyTheme() {
    const theme = localStorage.getItem('vidno-theme') || 'light';
    document.documentElement.dataset.theme = theme;
    const button = document.querySelector('#themeToggle');
    if (button) button.innerHTML = `<i class="fa-solid ${theme === 'dark' ? 'fa-sun' : 'fa-moon'}"></i>`;
}
applyTheme();
document.addEventListener('click', event => {
    if (!event.target.closest('#themeToggle')) return;
    localStorage.setItem('vidno-theme', document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    applyTheme();
    window.dispatchEvent(new CustomEvent('vidno-theme-change'));
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
