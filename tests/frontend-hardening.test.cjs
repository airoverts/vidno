const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) }); });
after(async () => { await browser?.close(); });

async function fixture(filename, origin = 'http://localhost:5500', name = 'Иван <Клиент>') {
    const context = await browser.newContext();
    const requests = [];
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname.startsWith('/api/')) {
            requests.push(url);
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ user: { name, email: 'client@example.test' } }) });
        }
        if (url.protocol === 'file:') return route.continue();
        if (url.origin !== origin) return route.fulfill({ body: '' });
        const relative = url.pathname.slice(1);
        if (!/^(?:index\.html|dashboard\.html|js\/[\w.-]+\.js|css\/[\w.-]+\.css|assets\/(?:[\w.-]+\/)*[\w.-]+\.(?:svg|png|jpg|jpeg|webp))$/.test(relative)) return route.fulfill({ status: 404, body: '' });
        const contentType = relative.endsWith('.html') ? 'text/html' : relative.endsWith('.js') ? 'application/javascript' : relative.endsWith('.css') ? 'text/css' : 'image/svg+xml';
        return route.fulfill({ contentType, body: await fs.readFile(path.join(root, relative)) });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(origin === 'file:' ? pathToFileURL(path.join(root, filename)).href : `${origin}/${filename}`);
    return { page, requests, close: () => context.close() };
}

test('landing profile preserves punctuation as text and localhost API uses the same hostname', async () => {
    for (const hostname of ['localhost', '127.0.0.1']) {
        const f = await fixture('index.html', `http://${hostname}:5500`);
        try {
            await f.page.locator('.account-pill').waitFor();
            assert.equal(await f.page.locator('.account-pill span').textContent(), 'Иван <Клиент>');
            assert.equal(await f.page.locator('.account-pill span *').count(), 0);
            assert.equal(f.requests.length, 1);
            assert.equal(f.requests[0].hostname, hostname);
            assert.equal(f.requests[0].port, '8000');
        } finally { await f.close(); }
    }
});

test('file pages explain localhost and never send auth requests including retry and logout', async () => {
    for (const filename of ['index.html', 'dashboard.html']) {
        const f = await fixture(filename, 'file:');
        try {
            const instruction = filename === 'index.html' ? f.page.locator('#main > [role="status"]') : f.page.locator('#dashboardLoadMessage');
            await instruction.waitFor();
            assert.match(await instruction.textContent(), /http:\/\/localhost/);
            if (filename === 'index.html') {
                await f.page.locator('[data-cta="login"]').first().click();
                await f.page.locator('#localFileInstruction').waitFor();
                assert.equal(await f.page.locator('#modalForm').count(), 0);
                await f.page.evaluate(() => authRequest('/auth/login').catch(() => {}));
            } else {
                await f.page.locator('#dashboardLoadRetry').click();
                await f.page.evaluate(() => document.querySelector('#appLogout').click());
                await f.page.waitForURL('**/index.html');
            }
            assert.equal(f.requests.length, 0);
        } finally { await f.close(); }
    }
});
