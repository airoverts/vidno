const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:8803';
let browser;

before(async () => { browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) }); });
after(async () => { await browser?.close(); });

async function fixture({ consent = null, webvisor = false, width = 1440 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(value => {
        window.metrikaCalls = [];
        if (value && localStorage.getItem('vidno_analytics_consent') === null) localStorage.setItem('vidno_analytics_consent', value);
    }, consent);
    const page = await context.newPage();
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname === 'mc.yandex.ru' && url.pathname === '/metrika/tag.js') {
            requests.push(url.href);
            return route.fulfill({ contentType: 'application/javascript', body: 'const queued = window.ym.a || []; window.ym = (...args) => window.metrikaCalls.push(args); queued.forEach(args => window.ym(...args));' });
        }
        if (url.origin !== origin) return route.abort();
        if (url.pathname === '/js/metrika.js') return route.fulfill({ contentType: 'application/javascript', body: await fs.readFile(path.join(root, 'js/metrika.js')) });
        if (url.pathname === '/css/style.css') return route.fulfill({ contentType: 'text/css', body: await fs.readFile(path.join(root, 'css/style.css')) });
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="ru"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/style.css"><script src="/js/metrika.js" data-webvisor="${webvisor}" data-cookie-policy="legal/cookies.html"></script></head><body><h1>Vidno</h1></body></html>` });
    });
    await page.goto(origin + '/index.html');
    return { page, requests, errors, close: () => context.close() };
}

test('new visitor and refusal do not load analytics', async () => {
    const f = await fixture();
    try {
        assert.equal(await f.page.locator('.cookie-consent').isVisible(), true);
        assert.deepEqual(f.requests, []);
        await f.page.locator('.cookie-consent-deny').click();
        await f.page.reload();
        assert.equal(await f.page.locator('.cookie-consent').isVisible(), false);
        assert.deepEqual(f.requests, []);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

for (const width of [1440, 390]) {
    test(`explicit consent loads counter-specific script once at ${width}px`, async () => {
        const f = await fixture({ width });
        try {
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await f.page.locator('.cookie-consent-allow').click();
            await f.page.waitForFunction(() => window.metrikaCalls.length === 1);
            assert.equal(f.requests.length, 1);
            assert.equal(new URL(f.requests[0]).searchParams.get('id'), '112845645');
            const [id, method, options] = await f.page.evaluate(() => window.metrikaCalls[0]);
            assert.equal(id, 112845645);
            assert.equal(method, 'init');
            assert.equal(options.ssr, true);
            assert.equal(options.url, origin + '/index.html');
            await f.page.locator('.cookie-preferences').click();
            await f.page.locator('.cookie-consent-allow').click();
            assert.equal(f.requests.length, 1);
            assert.equal(await f.page.evaluate(() => window.metrikaCalls.length), 1);
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });
}

for (const webvisor of [true, false]) {
    test(`saved permission retains page webvisor=${webvisor}`, async () => {
        const f = await fixture({ consent: 'granted', webvisor });
        try {
            await f.page.waitForFunction(() => window.metrikaCalls.length === 1);
            assert.equal(await f.page.evaluate(() => window.metrikaCalls[0][2].webvisor), webvisor);
            assert.equal(await f.page.locator('.cookie-consent').isVisible(), false);
            assert.equal(new URL(f.requests[0]).searchParams.get('id'), '112845645');
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });
}

test('refusal can be changed and revocation survives reload without another load', async () => {
    const f = await fixture({ consent: 'denied' });
    try {
        assert.deepEqual(f.requests, []);
        await f.page.locator('.cookie-preferences').click();
        await f.page.locator('.cookie-consent-allow').click();
        await f.page.waitForFunction(() => window.metrikaCalls.length === 1);
        await f.page.locator('.cookie-preferences').click();
        await Promise.all([f.page.waitForEvent('domcontentloaded'), f.page.locator('.cookie-consent-deny').click()]);
        assert.equal(await f.page.evaluate(() => localStorage.getItem('vidno_analytics_consent')), 'denied');
        assert.equal(f.requests.length, 1);
        assert.equal(await f.page.evaluate(() => window.metrikaCalls.length), 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('all public entrypoints use the updated loader without changing dashboard privacy', async () => {
    const versions = new Set();
    for (const file of ['index.html', 'dashboard.html', 'legal/agreement.html', 'legal/consent.html', 'legal/cookies.html', 'legal/privacy.html']) {
        const html = await fs.readFile(path.join(root, file), 'utf8');
        const tags = html.match(/<script\b[^>]*src="[^"]*js\/metrika\.js[^>]*>/g) || [];
        assert.equal(tags.length, 1, file);
        const version = tags[0].match(/metrika\.js\?v=([\w.-]+)/);
        assert.ok(version, file);
        versions.add(version[1]);
        assert.match(tags[0], new RegExp(`data-webvisor="${file !== 'dashboard.html'}"`));
        assert.doesNotMatch(html, /<script[^>]*src="https:\/\/mc\.yandex/);
    }
    assert.equal(versions.size, 1);
});
