'use strict';

const AUTH_API_BASE = location.protocol === 'file:' ? 'http://localhost:8000/api' : (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '8000' ? `http://${location.hostname}:8000/api` : '/api');
localStorage.removeItem('vidno-session-token');

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
