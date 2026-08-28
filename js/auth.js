'use strict';

const AUTH_API_BASE = location.protocol === 'file:' ? 'http://localhost:8000/api' : (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '8000' ? `http://${location.hostname}:8000/api` : '/api');
const SESSION_TOKEN_KEY = 'vidno-session-token';

function sessionHeaders() {
    const token = localStorage.getItem(SESSION_TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
}

async function loadSession() {
    try {
        const response = await fetch(`${AUTH_API_BASE}/auth/me`, { credentials: 'include', headers: sessionHeaders() });
        if (!response.ok) throw new Error();
        const { user } = await response.json();
        document.querySelector('#appUserName').textContent = user.name;
        document.body.classList.remove('auth-pending');
        if (user.brand && typeof ensureBrandIdentity === 'function') {
            ensureBrandIdentity(user.brand);
            const brandInput = document.querySelector('#wsBrand');
            if (brandInput && (!brandInput.value || brandInput.value === 'Vidno')) brandInput.value = user.brand;
            if (typeof renderBrandSwitcher === 'function') renderBrandSwitcher();
        }
    } catch {
        window.location.replace('index.html?auth=login');
    }
}

document.querySelector('#appLogout').addEventListener('click', async () => {
    const button = document.querySelector('#appLogout');
    button.disabled = true;
    try { await fetch(`${AUTH_API_BASE}/auth/logout`, { method: 'POST', credentials: 'include', headers: sessionHeaders() }); } finally { localStorage.removeItem(SESSION_TOKEN_KEY); window.location.replace('index.html'); }
});

loadSession();
