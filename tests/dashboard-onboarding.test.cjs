const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:8801';
const stamp = '2026-10-06T10:00:00Z';
const providers = ['gigachat', 'yandex', 'openai', 'gemini', 'perplexity'];
let browser;

before(async () => {
    browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
});
after(async () => { await browser?.close(); });

function brand(id = 101, name = 'Acme') {
    return { id, canonical_id: `brand-${id}`, canonical_name: name, aliases: [], domains: ['acme.test'], identity_changed_at: stamp };
}

function check(id = 501, status = 'completed', mentioned = true, query = 'Какой сервис выбрать?') {
    const count = status === 'partial' ? 3 : 5;
    const result = {
        provider: 'all', analysis_version: 'perplexity-direct-v1', mentioned,
        competitors: ['OtherBrand'], sources: [{ url: 'https://example.test/review', title: 'Обзор' }],
        provider_results: providers.slice(0, count).map(provider => ({
            provider, model: provider, mentioned, analysis_version: 'perplexity-direct-v1',
            raw_answer: mentioned ? `Рекомендуем Acme. ${provider} ${id}` : `Рекомендуем OtherBrand. ${provider} ${id}`,
            ordered_mentions: [{ name: mentioned ? 'Acme' : 'OtherBrand', position: 1, role: 'рекомендация' }],
            competitors: ['OtherBrand'], sources: [],
        })),
        provider_errors: status === 'partial' ? [{ provider: 'gemini', error: 'provider_timeout' }, { provider: 'perplexity', error: 'provider_timeout' }] : [],
    };
    return {
        id, brand_id: 101, brand: 'Acme', query, provider: 'all', status,
        created_at: stamp, completed_at: status === 'running' ? null : stamp,
        result: ['completed', 'partial'].includes(status) ? result : null,
        error: status === 'failed' ? 'analysis_failed' : null,
    };
}

function state(overrides = {}) {
    return {
        account: { id: 1, name: 'Тестовый клиент', email: 'client@example.test', role: 'client', onboarding_completed_at: null },
        access: {
            status: 'active', plan: 'basic',
            checks: { limit: 20, used: 0, remaining: 20 }, brands: { limit: 2, used: 0, remaining: 2 },
            capabilities: { workspace_write: true, run_checks: true, create_brands: true, manage_existing_brands: true },
        },
        brands: [], checks: [], requests: [], checkMode: 'completed', checkReads: 0,
        ...overrides,
    };
}

async function fixture(server = state(), width = 1440, stored = {}) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(values => {
        localStorage.setItem('vidno_analytics_consent', 'denied');
        for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
    }, stored);
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
        const request = route.request();
        const url = new URL(request.url());
        const api = url.pathname.startsWith('/api/');
        const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        if (api) {
            const endpoint = url.pathname.slice(4);
            const method = request.method();
            const body = request.postDataJSON();
            server.requests.push({ endpoint, method, body, hostname: url.hostname });
            if (server.unauthorized === endpoint) return json({ detail: 'Session expired' }, 401);
            if (endpoint === '/auth/me') {
                if (server.sessionFailure === 'network') return route.abort('failed');
                if (server.sessionFailure) return json({ detail: 'session unavailable' }, 503);
                return json({ user: server.account });
            }
            if (endpoint === '/auth/register') {
                server.account.name = body.name;
                server.account.email = body.email;
                return json({ user: server.account }, 201);
            }
            if (endpoint === '/account') {
                if (server.accountFailure) return json({ detail: 'account unavailable' }, 503);
                return json({ account: server.account });
            }
            if (endpoint === '/access') return json({ access: server.access });
            if (endpoint === '/brands' && method === 'GET') {
                if (server.brandReadFailure) return json({ detail: 'brands unavailable' }, 503);
                return json({ brands: server.brands });
            }
            if (endpoint === '/brands' && method === 'POST') {
                if (server.brandFailure) return json({ detail: 'brand unavailable' }, 503);
                const item = { ...brand(), ...body };
                server.brands.push(item);
                if (server.brandDrop) {
                    if (server.brandDrop === 'unreadable') server.brandReadFailure = true;
                    return route.abort('failed');
                }
                return json({ brand: item }, 201);
            }
            if (endpoint === '/checks' && method === 'GET') {
                server.checkReads++;
                if (server.checkReadFailure) return json({ detail: 'checks unavailable' }, 503);
                return json({ checks: server.checks });
            }
            if (endpoint === '/checks' && method === 'POST') return json({ detail: 'Unexpected duplicate save' }, 409);
            if (/^\/checks\/\d+$/.test(endpoint) && method === 'DELETE') {
                server.checks = server.checks.filter(item => String(item.id) !== endpoint.split('/').at(-1));
                return route.fulfill({ status: 204, body: '' });
            }
            if (endpoint === '/growth-tasks') return json({ tasks: [] });
            if (endpoint === '/dismissed-opportunities') return json({ items: [] });
            if (endpoint === '/prompt-suggestions') {
                if (server.suggestionFailure) return json({ detail: 'suggestions unavailable' }, 503);
                return json({ prompts: ['Как выбрать сервис?', 'Какие компании рекомендуют?', 'Какой инструмент лучше?'] });
            }
            if (endpoint === '/check-all') {
                if (server.checkDelay) await new Promise(resolve => setTimeout(resolve, server.checkDelay));
                const status = server.checkMode.startsWith('drop') ? 'running' : server.checkMode;
                const item = check(501, status, server.mentioned !== false, body.query);
                server.checks.push(item);
                if (server.checkMode.startsWith('drop')) {
                    if (server.checkMode === 'drop-unreadable') server.checkReadFailure = true;
                    return route.abort('failed');
                }
                if (status === 'failed') return json({ error: 'analysis_failed' }, 502);
                server.account.onboarding_completed_at = stamp;
                return json({ ...item.result, check: { id: item.id, brand_id: item.brand_id, created_at: item.created_at, completed_at: stamp, status: item.status } });
            }
            return json({ detail: `Unexpected API ${method} ${endpoint}` }, 404);
        }
        if (url.origin !== origin) return route.fulfill({ status: 200, contentType: url.pathname.endsWith('.js') ? 'application/javascript' : 'text/css', body: '' });
        const relative = decodeURIComponent(url.pathname).replace(/^\//, '');
        if (!/^(?:dashboard\.html|index\.html|js\/[\w.-]+\.js|css\/[\w.-]+\.css|assets\/(?:[\w.-]+\/)*[\w.-]+\.(?:svg|png|jpg|jpeg|webp))$/.test(relative)) return route.fulfill({ status: 404, body: '' });
        const target = path.resolve(root, relative);
        if (!target.startsWith(root + path.sep)) return route.fulfill({ status: 404, body: '' });
        try {
            const contentType = relative.endsWith('.html') ? 'text/html' : relative.endsWith('.js') ? 'application/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
            return route.fulfill({ status: 200, contentType, body: await fs.readFile(target) });
        } catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto(`${origin}/dashboard.html`);
    return { page, server, errors, close: () => context.close() };
}

async function visible(page, selector) { await page.locator(selector).waitFor({ state: 'visible' }); }
async function hidden(page, selector) { await page.locator(selector).waitFor({ state: 'hidden' }); }
async function enabled(page, selector) { await page.waitForFunction(selector => !document.querySelector(selector).disabled, selector); }
async function company(page, domain = 'https://WWW.Acme.test/path?ref=1') {
    await visible(page, '#onboardingCompanyForm');
    await page.locator('#onboardingBrand').fill('  Acme  ');
    await page.locator('#onboardingDomain').fill(domain);
    await page.locator('#onboardingContinue').click();
    await visible(page, '#onboardingCheckForm');
}
async function run(page, query = 'Какой сервис выбрать?') {
    await page.locator('#onboardingQuery').fill(query);
    await enabled(page, '#onboardingRunCheck');
    await page.locator('#onboardingRunCheck').click();
}
function count(server, endpoint, method = 'POST') { return server.requests.filter(item => item.endpoint === endpoint && item.method === method).length; }

for (const width of [1440, 768, 375]) {
    test(`new startup fits ${width}px and exposes accessible company form`, async () => {
        const f = await fixture(state(), width);
        try {
            await visible(f.page, '#onboardingCompanyForm');
            assert.equal(await f.page.locator('.app-shell').isVisible(), false);
            assert.equal(await f.page.locator('.onboarding-explainer').isVisible(), width > 768);
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.equal(await f.page.locator('#onboardingTitle').evaluate(element => element === document.activeElement), true);
            await f.page.keyboard.press('Tab');
            assert.equal(await f.page.locator('#onboardingBrand').evaluate(element => element === document.activeElement), true);
            await f.page.locator('#onboardingContinue').click();
            assert.equal(count(f.server, '/brands'), 0);
            assert.deepEqual(f.errors, []);
            const directory = path.join(os.tmpdir(), 'vidno-onboarding-qa');
            await fs.mkdir(directory, { recursive: true });
            await f.page.screenshot({ path: path.join(directory, `after-${width}.png`), fullPage: true });
            await company(f.page);
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await f.page.locator('#onboardingSuggest').click();
            await f.page.waitForFunction(() => document.querySelectorAll('#onboardingSuggestions button').length === 3);
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await f.page.screenshot({ path: path.join(directory, `step2-${width}.png`), fullPage: true });
        } finally { await f.close(); }
    });
}

test('registration asks no brand and sends account fields before opening one-time startup', async () => {
    const f = await fixture();
    try {
        await f.page.goto(`${origin}/index.html`);
        await f.page.locator('[data-cta="signup"]').first().click();
        await visible(f.page, '#modalForm');
        assert.equal(await f.page.locator('#modalForm [name="brand"]').count(), 0);
        await f.page.locator('#modalForm [name="name"]').fill('Клиент');
        await f.page.locator('#modalForm [name="email"]').fill('client@example.test');
        await f.page.locator('#modalForm [name="password"]').fill('test-only-password');
        await f.page.locator('#modalForm [type="submit"]').click();
        await visible(f.page, '#onboardingCompanyForm');
        const registration = f.server.requests.find(item => item.endpoint === '/auth/register');
        assert.deepEqual(Object.keys(registration.body).sort(), ['email', 'name', 'password']);
        assert.deepEqual([...new Set(f.server.requests.map(item => item.hostname))], ['127.0.0.1']);
        assert.equal(count(f.server, '/brands'), 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('legacy account payload without new marker keeps ordinary dashboard', async () => {
    const server = state();
    delete server.account.onboarding_completed_at;
    const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState');
        await hidden(f.page, '#onboarding');
        assert.equal(await f.page.locator('.app-shell').isVisible(), true);
    } finally { await f.close(); }
});

test('company domain normalizes, saved brand survives reload, and no duplicate brand is created', async () => {
    const f = await fixture();
    try {
        await company(f.page);
        assert.deepEqual(f.server.brands[0].domains, ['acme.test']);
        assert.equal(f.server.brands[0].canonical_name, 'Acme');
        assert.equal(count(f.server, '/brands'), 1);
        await f.page.reload();
        await visible(f.page, '#onboardingCheckForm');
        assert.equal(await f.page.locator('#onboardingSavedBrand').textContent(), 'Acme');
        assert.equal(count(f.server, '/brands'), 1);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('optional domain stays empty and invalid schemes are rejected without API writes', async () => {
    const f = await fixture();
    try {
        await visible(f.page, '#onboardingCompanyForm');
        await f.page.locator('#onboardingBrand').fill('Acme');
        await f.page.locator('#onboardingDomain').fill('ftp://acme.test');
        await f.page.locator('#onboardingContinue').click();
        assert.equal(count(f.server, '/brands'), 0);
        assert.equal(await f.page.locator('#onboardingDomain').evaluate(element => element.validity.valid), false);
        await f.page.locator('#onboardingDomain').fill('');
        await f.page.locator('#onboardingContinue').click();
        await visible(f.page, '#onboardingCheckForm');
        assert.deepEqual(f.server.brands[0].domains, []);
    } finally { await f.close(); }
});

test('failed brand save preserves inputs and remains on company step', async () => {
    const f = await fixture(state({ brandFailure: true }));
    try {
        await visible(f.page, '#onboardingCompanyForm');
        await f.page.locator('#onboardingBrand').fill('Acme');
        await f.page.locator('#onboardingDomain').fill('acme.test');
        await f.page.locator('#onboardingContinue').click();
        await visible(f.page, '#onboardingError');
        assert.equal(await f.page.locator('#onboardingBrand').inputValue(), 'Acme');
        assert.equal(await f.page.locator('#onboardingDomain').inputValue(), 'acme.test');
        assert.equal(await f.page.locator('#onboardingCompanyForm').isVisible(), true);
        assert.equal(f.server.brands.length, 0);
    } finally { await f.close(); }
});

test('lost company response locks draft until saved brand is recovered without duplicate POST', async () => {
    const server = state({ brandDrop: 'unreadable' });
    const f = await fixture(server, 375);
    try {
        await visible(f.page, '#onboardingCompanyForm');
        await f.page.locator('#onboardingBrand').fill('Acme');
        await f.page.locator('#onboardingDomain').fill('https://www.acme.test/page');
        await f.page.locator('#onboardingContinue').click();
        await visible(f.page, '#onboardingRefreshCompany');
        assert.equal(await f.page.locator('#onboardingContinue').isDisabled(), true);
        assert.equal(await f.page.locator('#onboardingBrand').evaluate(element => element.readOnly), true);
        assert.equal(await f.page.locator('#onboardingDomain').evaluate(element => element.readOnly), true);
        assert.equal(await f.page.locator('#onboardingBrand').inputValue(), 'Acme');
        assert.equal(count(server, '/brands'), 1);
        await f.page.locator('#onboardingRefreshCompany').click();
        await f.page.waitForFunction(() => document.querySelector('#onboardingError').textContent.includes('Попробуйте обновить'));
        assert.equal(await f.page.locator('#onboardingContinue').isDisabled(), true);
        server.brandReadFailure = false;
        await f.page.locator('#onboardingRefreshCompany').click();
        await visible(f.page, '#onboardingCheckForm');
        await hidden(f.page, '#onboardingRefreshCompany');
        assert.equal(await f.page.locator('#onboardingSavedBrand').textContent(), 'Acme');
        assert.equal(await f.page.locator('#onboardingSavedDomain').textContent(), 'acme.test');
        assert.equal(count(server, '/brands'), 1);
        assert.equal(server.brands.length, 1);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('three suggested prompts remain editable and suggestion failure allows manual successful check', async () => {
    const f = await fixture(state({ brands: [brand()] }));
    try {
        await visible(f.page, '#onboardingCheckForm');
        await f.page.locator('#onboardingSuggest').click();
        await f.page.waitForFunction(() => document.querySelectorAll('#onboardingSuggestions button').length === 3);
        await f.page.locator('#onboardingSuggestions button').first().click();
        assert.equal(await f.page.locator('#onboardingQuery').inputValue(), 'Как выбрать сервис?');
        f.server.suggestionFailure = true;
        await enabled(f.page, '#onboardingSuggest');
        await f.page.locator('#onboardingSuggest').click();
        await f.page.waitForFunction(() => document.querySelector('#onboardingSuggestionStatus').textContent.includes('Введите свой вопрос'));
        await run(f.page, 'Мой изменённый вопрос');
        await visible(f.page, '#wsResult');
        assert.equal(f.server.checks[0].query, 'Мой изменённый вопрос');
        assert.equal(count(f.server, '/check-all'), 1);
        assert.equal(count(f.server, '/checks'), 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

for (const [mode, mentioned, width] of [['completed', true, 375], ['partial', true, 375], ['completed', false, 768]]) {
    test(`${mode}, mentioned=${mentioned} exits startup and remains complete across browser storage loss and deleted data`, async () => {
        const server = state({ brands: [brand()], checkMode: mode, mentioned, checkDelay: 200 });
        const f = await fixture(server, width);
        try {
            await visible(f.page, '#onboardingCheckForm');
            await run(f.page);
            await visible(f.page, '#onboardingWaiting');
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.equal(await f.page.locator('#onboardingRunCheck').isDisabled(), true);
            assert.equal(await f.page.locator('#onboardingQuery').evaluate(element => element.readOnly), true);
            await visible(f.page, '#wsResult');
            await hidden(f.page, '#onboarding');
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.equal(await f.page.locator('#wsResultWarning').isVisible(), mode === 'partial');
            assert.match(await f.page.locator('#wsResultContext').textContent(), new RegExp(`ответили ${mode === 'partial' ? 3 : 5} из 5`));
            assert.match(await f.page.locator('#wsVerdict').textContent(), mentioned ? /Бренд упомянут/ : /Бренд не упомянут/);
            assert.equal(count(server, '/check-all'), 1);
            assert.equal(count(server, '/checks'), 0);
            await f.page.reload();
            await hidden(f.page, '#dashboardLoadState');
            await hidden(f.page, '#onboarding');
            server.brands = []; server.checks = [];
            const fresh = await fixture(server);
            try {
                await hidden(fresh.page, '#dashboardLoadState');
                await hidden(fresh.page, '#onboarding');
                assert.equal(await fresh.page.locator('.app-shell').isVisible(), true);
                assert.deepEqual(fresh.errors, []);
            } finally { await fresh.close(); }
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });
}

test('provider or analysis failure restores failed saved check without negative verdict or completion', async () => {
    const server = state({ brands: [brand()], checkMode: 'failed' });
    const f = await fixture(server, 375);
    try {
        await visible(f.page, '#onboardingCheckForm');
        await run(f.page);
        await visible(f.page, '#onboardingError');
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.match(await f.page.locator('#onboardingError').textContent(), /analysis_failed/);
        await enabled(f.page, '#onboardingRunCheck');
        assert.equal(await f.page.locator('#wsResult').isVisible(), false);
        assert.equal(server.account.onboarding_completed_at, null);
        await f.page.reload();
        await visible(f.page, '#onboardingError');
        assert.equal(await f.page.locator('#onboardingQuery').inputValue(), 'Какой сервис выбрать?');
        server.checkMode = 'completed';
        await run(f.page);
        await visible(f.page, '#wsResult');
        assert.equal(count(server, '/check-all'), 2);
    } finally { await f.close(); }
});

test('running check restores query and polling completes without submitting duplicate', async () => {
    const server = state({ brands: [brand()], checks: [check(501, 'running')] });
    const f = await fixture(server);
    try {
        await visible(f.page, '#onboardingWaiting');
        assert.equal(await f.page.locator('#onboardingQuery').inputValue(), 'Какой сервис выбрать?');
        assert.equal(await f.page.locator('#onboardingRunCheck').isDisabled(), true);
        assert.equal(count(server, '/check-all'), 0);
        server.checks = [check()]; server.account.onboarding_completed_at = stamp;
        await f.page.locator('#wsResult').waitFor({ state: 'visible', timeout: 9000 });
        await hidden(f.page, '#onboarding');
        assert.equal(count(server, '/check-all'), 0);
        assert.ok(server.checkReads >= 2);
    } finally { await f.close(); }
});

test('lost response rereads persisted running check and manual refresh opens eventual result', async () => {
    const server = state({ brands: [brand()], checkMode: 'drop' });
    const f = await fixture(server, 768);
    try {
        await visible(f.page, '#onboardingCheckForm');
        await run(f.page);
        await visible(f.page, '#onboardingRefreshStatus');
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.ok(server.checkReads >= 2);
        assert.equal(await f.page.locator('#onboardingRunCheck').isDisabled(), true);
        assert.equal(count(server, '/check-all'), 1);
        server.checks = [check()]; server.account.onboarding_completed_at = stamp;
        await f.page.locator('#onboardingRefreshStatus').click();
        await visible(f.page, '#wsResult');
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        assert.equal(count(server, '/check-all'), 1);
    } finally { await f.close(); }
});

test('unreadable recovery blocks resubmission until refresh confirms state', async () => {
    const server = state({ brands: [brand()], checkMode: 'drop-unreadable' });
    const f = await fixture(server, 768);
    try {
        await visible(f.page, '#onboardingCheckForm');
        await run(f.page);
        await visible(f.page, '#onboardingError');
        assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await visible(f.page, '#onboardingRefreshStatus');
        assert.equal(await f.page.locator('#onboardingRunCheck').isDisabled(), true);
        assert.match(await f.page.locator('#onboardingError').textContent(), /Сначала обновите состояние/);
        assert.equal(await f.page.locator('#onboardingQuery').evaluate(element => element.readOnly), true);
        assert.equal(await f.page.locator('#onboardingSuggest').isDisabled(), true);
        server.checkReadFailure = false; server.checks = [check(501, 'failed')];
        await f.page.locator('#onboardingRefreshStatus').click();
        await enabled(f.page, '#onboardingRunCheck');
        assert.equal(count(server, '/check-all'), 1);
    } finally { await f.close(); }
});

test('initial API failure exposes retry rather than treating account as empty', async () => {
    const server = state({ accountFailure: true });
    const f = await fixture(server);
    try {
        await visible(f.page, '#dashboardLoadRetry');
        assert.equal(await f.page.locator('#onboarding').isVisible(), false);
        assert.equal(await f.page.locator('.app-shell').isVisible(), false);
        server.accountFailure = false;
        await f.page.locator('#dashboardLoadRetry').click();
        await visible(f.page, '#onboardingCompanyForm');
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

for (const sessionFailure of ['network', 'server']) {
    test(`session ${sessionFailure} outage offers retry without redirecting to login`, async () => {
        const server = state({ sessionFailure });
        const f = await fixture(server);
        try {
            await visible(f.page, '#dashboardLoadRetry');
            assert.match(f.page.url(), /dashboard\.html$/);
            assert.equal(await f.page.locator('#onboarding').isVisible(), false);
            server.sessionFailure = false;
            await f.page.locator('#dashboardLoadRetry').click();
            await visible(f.page, '#onboardingCompanyForm');
            assert.equal(count(server, '/auth/me', 'GET'), 2);
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });
}

test('explicit access refresh activates pending account while retaining draft', async () => {
    const server = state();
    server.access.status = 'pending';
    for (const key of Object.keys(server.access.capabilities)) server.access.capabilities[key] = false;
    const f = await fixture(server);
    try {
        await visible(f.page, '#onboardingRefreshAccess');
        await f.page.locator('#onboardingBrand').fill('Acme');
        server.access.status = 'active';
        for (const key of Object.keys(server.access.capabilities)) server.access.capabilities[key] = true;
        await f.page.locator('#onboardingRefreshAccess').click();
        await enabled(f.page, '#onboardingContinue');
        assert.equal(await f.page.locator('#onboardingBrand').inputValue(), 'Acme');
        assert.equal(count(server, '/brands'), 0);
    } finally { await f.close(); }
});

test('pending access retains company draft and visibility refresh enables activation', async () => {
    const server = state();
    server.access.status = 'pending';
    for (const key of Object.keys(server.access.capabilities)) server.access.capabilities[key] = false;
    const f = await fixture(server);
    try {
        await visible(f.page, '#onboardingCompanyForm');
        await f.page.locator('#onboardingBrand').fill('Acme');
        await f.page.locator('#onboardingDomain').fill('acme.test');
        assert.equal(await f.page.locator('#onboardingContinue').isDisabled(), true);
        assert.match(await f.page.locator('#onboardingAccessNotice').textContent(), /не активирован/);
        assert.equal(count(server, '/brands'), 0);
        server.access.status = 'active';
        for (const key of Object.keys(server.access.capabilities)) server.access.capabilities[key] = true;
        await f.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await enabled(f.page, '#onboardingContinue');
        assert.equal(await f.page.locator('#onboardingBrand').inputValue(), 'Acme');
        await f.page.locator('#onboardingContinue').click();
        await visible(f.page, '#onboardingCheckForm');
    } finally { await f.close(); }
});

test('fresh access check prevents submitting after check quota becomes exhausted', async () => {
    const server = state({ brands: [brand()] });
    const f = await fixture(server);
    try {
        await visible(f.page, '#onboardingCheckForm');
        server.access.capabilities.run_checks = false;
        server.access.checks = { limit: 20, used: 20, remaining: 0 };
        await run(f.page);
        await visible(f.page, '#onboardingError');
        assert.match(await f.page.locator('#onboardingError').textContent(), /Лимит проверок исчерпан/);
        assert.equal(count(server, '/check-all'), 0);
        assert.equal(await f.page.locator('#onboardingRunCheck').isDisabled(), true);
    } finally { await f.close(); }
});

test('401 from account redirects to login', async () => {
    const f = await fixture(state({ unauthorized: '/account' }));
    try {
        await f.page.waitForURL('**/index.html?auth=login');
        await visible(f.page, '#modalOverlay.open');
        assert.match(await f.page.locator('#modalBody h2').textContent(), /Вход в Vidno/);
    } finally { await f.close(); }
});

test('uncertain dropped request does not recover an older successful result for the same query', async () => {
    const server = state({ brands: [brand()], checks: [check(500, 'failed')], checkMode: 'drop-unreadable' });
    const f = await fixture(server);
    try {
        await visible(f.page, '#onboardingCheckForm');
        await run(f.page);
        await visible(f.page, '#onboardingRefreshStatus');
        server.checkReadFailure = false;
        server.checks = [check(500)];
        await f.page.locator('#onboardingRefreshStatus').click();
        await enabled(f.page, '#onboardingRunCheck');
        assert.equal(await f.page.locator('#onboarding').isVisible(), true);
        assert.equal(await f.page.locator('#wsResult').isVisible(), false);
        assert.equal(server.account.onboarding_completed_at, null);
        assert.equal(count(server, '/check-all'), 1);
    } finally { await f.close(); }
});

test('existing account opens history, scoped answers and report using saved IDs while preserving preferences', async () => {
    const server = state({ brands: [brand()], checks: [check(), check(502, 'completed', true, 'Другой вопрос')] });
    server.account.onboarding_completed_at = stamp;
    const f = await fixture(server, 1440, { 'vidno-theme': 'dark', 'vidno-dashboard-active-brand': 'brand-101' });
    try {
        await hidden(f.page, '#dashboardLoadState');
        await hidden(f.page, '#onboarding');
        await f.page.locator('.app-nav [data-view="prompts"]').click();
        await f.page.locator('[data-open-check="501"]').click();
        await visible(f.page, '#wsResult');
        assert.match(await f.page.locator('#wsResultContext').textContent(), /Какой сервис выбрать/);
        await f.page.locator('#resultAnswers').click();
        await visible(f.page, '#view-answers');
        assert.equal(await f.page.locator('.ai-answer-card').count(), 5);
        assert.doesNotMatch(await f.page.locator('#aiAnswerList').textContent(), /Другой вопрос/);
        await f.page.locator('.app-nav [data-view="prompts"]').click();
        await f.page.locator('[data-open-check="501"]').click();
        await f.page.locator('#resultReport').click();
        await visible(f.page, '#view-reports');
        assert.equal(await f.page.locator('#view-reports').getAttribute('data-check-id'), '501');
        assert.equal(await f.page.locator('#view-reports').getAttribute('data-brand-id'), '101');
        assert.match(await f.page.locator('#reportCheckContext').textContent(), /Какой сервис выбрать/);
        await f.page.locator('#reportBackToCheck').click();
        await visible(f.page, '#wsResult');
        await f.page.locator('#resultAnalytics').click();
        await visible(f.page, '#view-home');
        assert.equal(await f.page.evaluate(() => localStorage.getItem('vidno-theme')), 'dark');
        assert.equal(await f.page.evaluate(() => localStorage.getItem('vidno-dashboard-active-brand')), 'brand-101');
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('switching project in reports clears saved-check context and result', async () => {
    const server = state({ brands: [brand(), brand(102, 'SecondBrand')], checks: [check()] });
    server.account.onboarding_completed_at = stamp;
    const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState');
        await f.page.locator('.app-nav [data-view="prompts"]').click();
        await f.page.locator('[data-open-check="501"]').click();
        await f.page.locator('#resultReport').click();
        await visible(f.page, '#view-reports');
        assert.equal(await f.page.locator('#view-reports').getAttribute('data-check-id'), '501');
        await f.page.locator('#activeBrandSelect').selectOption('brand-102');
        assert.equal(await f.page.locator('#view-reports').getAttribute('data-check-id'), '');
        assert.equal(await f.page.locator('#view-reports').getAttribute('data-brand-id'), '');
        assert.match(await f.page.locator('#reportCheckContext').textContent(), /Откройте сохранённую проверку/);
        assert.equal(await f.page.locator('#reportBackToCheck').isVisible(), false);
        await f.page.locator('.app-nav [data-view="prompts"]').click();
        assert.equal(await f.page.locator('#wsResult').isVisible(), false);
        assert.equal(await f.page.locator('[data-open-check="501"]').count(), 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('deleting selected check removes result and previously selected report context', async () => {
    const server = state({ brands: [brand()], checks: [check()] });
    server.account.onboarding_completed_at = stamp;
    const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState');
        await f.page.locator('.app-nav [data-view="prompts"]').click();
        await f.page.locator('[data-open-check="501"]').click();
        await f.page.locator('#resultReport').click();
        await visible(f.page, '#view-reports');
        await f.page.locator('.app-nav [data-view="prompts"]').click();
        f.page.once('dialog', dialog => dialog.accept());
        await f.page.locator('[data-delete-check="501"]').click();
        await hidden(f.page, '[data-open-check="501"]');
        await hidden(f.page, '#wsResult');
        assert.equal(server.checks.length, 0);
        assert.equal(count(server, '/checks/501', 'DELETE'), 1);
        assert.equal(await f.page.locator('#view-reports').getAttribute('data-check-id'), '');
        assert.equal(await f.page.locator('#view-reports').getAttribute('data-brand-id'), '');
        assert.match(await f.page.locator('#reportCheckContext').textContent(), /Откройте сохранённую проверку/);
        await f.page.locator('.app-nav [data-view="reports"]').click();
        assert.equal(await f.page.locator('#reportBackToCheck').isVisible(), false);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});
