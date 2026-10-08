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
        brands: [], checks: [], growthTasks: [], requests: [], checkMode: 'completed', checkReads: 0, nextCheckId: 501,
        tariffs: [{ plan: 'basic', checks_limit: 3, brands_limit: 1 }, { plan: 'pro', checks_limit: 30, brands_limit: 3 }, { plan: 'business', checks_limit: 100, brands_limit: 10 }], voucherBatches: [],
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
            if (endpoint === '/access') {
                if (server.accessFailure) return json({ detail: 'access unavailable' }, 503);
                return json({ access: server.access });
            }
            if (endpoint === '/vouchers/redeem') {
                if (server.voucherMode === 'invalid') return json({ detail: { code: 'voucher_invalid', message: 'invalid' } }, 400);
                if (!server.access.can_redeem_voucher) return json({ detail: { code: 'voucher_not_allowed', message: 'not allowed' } }, 403);
                Object.assign(server.access, { status: 'active', administrative_status: 'active', plan: 'basic', expires_at: '2026-11-07T10:00:00Z', can_redeem_voucher: false, voucher_redeemed: true, checks: { limit: 3, used: 0, remaining: 3 }, brands: { limit: 1, used: server.brands.length, remaining: Math.max(0, 1 - server.brands.length) } });
                for (const key of Object.keys(server.access.capabilities)) server.access.capabilities[key] = true;
                if (server.voucherMode?.startsWith('drop')) {
                    if (server.voucherMode === 'drop-unreadable') server.accessFailure = true;
                    return route.abort('failed');
                }
                return json({ access: server.access });
            }
            if (endpoint === '/admin/tariffs') {
                if (server.tariffFailure) return json({ detail: 'tariffs unavailable' }, 503);
                return json({ items: server.tariffs });
            }
            if (/^\/admin\/tariffs\//.test(endpoint) && method === 'PATCH') {
                const tariff = server.tariffs.find(item => item.plan === endpoint.split('/').at(-1));
                if (server.tariffSaveDelay) await new Promise(resolve => setTimeout(resolve, server.tariffSaveDelay));
                Object.assign(tariff, body); return json(tariff);
            }
            if (endpoint.startsWith('/admin/clients') && method === 'GET') {
                if (endpoint === '/admin/clients') { const items = Object.values(server.clientDetails || {}); return json({ items, total: items.length, page: 1, page_size: 20 }); }
                const id = endpoint.split('/').at(-1);
                if (server.clientReadDelays?.[id]) await new Promise(resolve => setTimeout(resolve, server.clientReadDelays[id]));
                if (server.clientDetails?.[id]) return json(server.clientDetails[id]);
                return json({ account: { ...server.account, id: 2, role: 'client', name: 'Получатель' }, access: server.access });
            }
            if (/^\/admin\/clients\/\d+\/access$/.test(endpoint) && method === 'PATCH') {
                const id = endpoint.split('/').at(-2); const detail = server.clientDetails[id];
                if (server.clientSaveDelay) await new Promise(resolve => setTimeout(resolve, server.clientSaveDelay));
                return json({ account: detail.account, access: { ...detail.access, plan: body.plan } });
            }
            if (endpoint === '/admin/voucher-batches' && method === 'POST') {
                const tariff = server.tariffs.find(item => item.plan === body.plan);
                const batch = { id: server.voucherBatches.length + 1, ...tariff, ...body, created_at: stamp, available_count: body.quantity, redeemed_count: 0, revoked_count: 0 };
                const vouchers = Array.from({ length: body.quantity }, (_, index) => ({ id: batch.id * 100 + index, batch_id: batch.id, code_mask: `••••-0000${index}`, status: 'available', code: `AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-00000-0000${index}` }));
                server.voucherBatches.unshift({ batch, vouchers }); return json({ batch, vouchers }, 201);
            }
            if (endpoint === '/admin/voucher-batches') return json({ items: server.voucherBatches.map(item => item.batch) });
            if (/^\/admin\/voucher-batches\/\d+$/.test(endpoint)) {
                const item = server.voucherBatches.find(item => String(item.batch.id) === endpoint.split('/').at(-1));
                return item ? json({ batch: item.batch, vouchers: item.vouchers.map(({ code, ...voucher }) => voucher) }) : json({ detail: 'not found' }, 404);
            }
            if (/^\/admin\/vouchers\/\d+\/revoke$/.test(endpoint)) {
                const id = Number(endpoint.split('/').at(-2));
                const item = server.voucherBatches.find(item => item.vouchers.some(voucher => voucher.id === id));
                const voucher = item.vouchers.find(voucher => voucher.id === id); voucher.status = 'revoked'; voucher.revoked_at = stamp;
                item.batch.available_count--; item.batch.revoked_count++; return json({ voucher });
            }
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
            if (endpoint === '/growth-tasks' && method === 'GET') return json({ tasks: server.growthTasks });
            if (/^\/growth-tasks\/\d+$/.test(endpoint) && method === 'PATCH') {
                const id = Number(endpoint.split('/').at(-1));
                const item = server.growthTasks.find(task => Number(task.id) === id);
                if (!item) return json({ detail: 'Task not found' }, 404);
                Object.assign(item, body, { updated_at: stamp });
                return json({ task: item });
            }
            if (endpoint === '/dismissed-opportunities') return json({ items: [] });
            if (endpoint === '/prompt-suggestions') {
                if (server.suggestionFailure) return json({ detail: 'suggestions unavailable' }, 503);
                return json({ prompts: ['Как выбрать сервис?', 'Какие компании рекомендуют?', 'Какой инструмент лучше?'] });
            }
            if (endpoint === '/check') {
                const id = server.nextCheckId++;
                const result = { provider: body.provider, model: body.provider, analysis_version: 'perplexity-direct-v1', mentioned: true, raw_answer: `Рекомендуем Acme. ${body.provider} ${id}`, ordered_mentions: [{ name: 'Acme', position: 1, role: 'рекомендация' }], competitors: [], sources: [] };
                const item = { id, brand_id: 101, brand: 'Acme', query: body.query, provider: body.provider, status: 'completed', created_at: stamp, completed_at: stamp, result, error: null };
                server.checks.push(item);
                return json({ ...result, check: { id, brand_id: 101, created_at: stamp, completed_at: stamp, status: 'completed' } });
            }
            if (endpoint === '/check-all') {
                if (server.checkDelay) await new Promise(resolve => setTimeout(resolve, server.checkDelay));
                const status = server.checkMode.startsWith('drop') ? 'running' : server.checkMode;
                const item = check(server.nextCheckId++, status, server.mentioned !== false, body.query);
                if (Array.isArray(body.providers) && item.result) {
                    item.result.provider_results = item.result.provider_results.filter(result => body.providers.includes(result.provider));
                    item.result.requested_providers = [...body.providers];
                }
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

function pendingVoucherState(overrides = {}) {
    const server = state(overrides);
    server.access = { ...server.access, status: 'pending', administrative_status: 'pending', plan: 'custom', can_redeem_voucher: true, voucher_redeemed: false, capabilities: { workspace_write: false, run_checks: false, create_brands: false, manage_existing_brands: false } };
    return server;
}

for (const width of [1440, 768, 375]) {
    test(`voucher activation is inline, fits ${width}px and disappears after activation and reload`, async () => {
        const f = await fixture(pendingVoucherState(), width);
        try {
            await visible(f.page, '#voucherActivationForm');
            assert.equal(await f.page.locator('#onboardingVoucherSlot #voucherActivationForm').count(), 1);
            assert.equal(await f.page.locator('#voucherCode').count(), 1);
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.equal(await f.page.locator('#onboardingContinue').isDisabled(), true);
            const directory = path.join(os.tmpdir(), 'vidno-voucher-qa'); await fs.mkdir(directory, { recursive: true });
            await f.page.screenshot({ path: path.join(directory, `activation-${width}.png`), fullPage: true });
            await f.page.locator('#onboardingBrand').fill('Acme');
            await f.page.locator('#voucherCode').fill('FAKE-TEST-ONLY-VOUCHER');
            await f.page.locator('#voucherActivate').click();
            await hidden(f.page, '#voucherActivationForm'); await enabled(f.page, '#onboardingContinue');
            assert.equal(await f.page.locator('#onboardingBrand').inputValue(), 'Acme');
            assert.equal(await f.page.locator('#onboardingBrand').evaluate(element => element === document.activeElement), true);
            assert.match(await f.page.locator('#voucherActivationStatus').textContent(), /Basic/);
            assert.equal(count(f.server, '/vouchers/redeem'), 1);
            assert.equal(await f.page.locator('#voucherCode').inputValue(), '');
            await f.page.reload(); await hidden(f.page, '#dashboardLoadState');
            assert.equal(await f.page.locator('#voucherActivationForm').isVisible(), false);
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });
}

test('invalid voucher keeps input and error, retry activates without submitting a brand', async () => {
    const server = pendingVoucherState({ voucherMode: 'invalid' }); const f = await fixture(server, 375);
    try {
        await visible(f.page, '#voucherActivationForm'); await f.page.locator('#voucherCode').fill('WRONG-TEST-CODE');
        await f.page.locator('#voucherActivate').click();
        await f.page.waitForFunction(() => document.querySelector('#voucherActivationStatus').textContent.includes('Код неверный'));
        assert.equal(await f.page.locator('#voucherCode').inputValue(), 'WRONG-TEST-CODE');
        assert.equal(await f.page.locator('#voucherActivationForm').isVisible(), true);
        server.voucherMode = ''; await f.page.locator('#voucherActivate').click(); await hidden(f.page, '#voucherActivationForm');
        assert.equal(count(server, '/brands'), 0); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('lost successful voucher response recovers access without submitting code twice', async () => {
    const server = pendingVoucherState({ voucherMode: 'drop' }); const f = await fixture(server);
    try {
        await visible(f.page, '#voucherActivationForm'); await f.page.locator('#voucherCode').fill('FAKE-TEST-ONLY-VOUCHER');
        await f.page.locator('#voucherActivate').click(); await hidden(f.page, '#voucherActivationForm');
        await enabled(f.page, '#onboardingContinue');
        assert.match(await f.page.locator('#voucherActivationStatus').textContent(), /Доступ активирован/);
        assert.equal(count(server, '/vouchers/redeem'), 1); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('unreadable voucher recovery locks code until access can be checked', async () => {
    const server = pendingVoucherState({ voucherMode: 'drop-unreadable' }); const f = await fixture(server, 375);
    try {
        await visible(f.page, '#voucherActivationForm'); await f.page.locator('#voucherCode').fill('FAKE-TEST-ONLY-VOUCHER');
        await f.page.locator('#voucherActivate').click(); await visible(f.page, '#voucherRefreshAccess');
        assert.equal(await f.page.locator('#voucherActivate').isDisabled(), true);
        assert.equal(await f.page.locator('#voucherCode').evaluate(element => element.readOnly), true);
        server.accessFailure = false; await f.page.locator('#voucherRefreshAccess').click();
        await hidden(f.page, '#voucherActivationForm'); assert.equal(count(server, '/vouchers/redeem'), 1);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('legacy pending account redeems in access settings and does not store code locally', async () => {
    const server = pendingVoucherState({ account: { id: 1, name: 'Клиент', email: 'legacy@example.test', role: 'client', onboarding_completed_at: stamp } });
    const f = await fixture(server, 375);
    try {
        await hidden(f.page, '#dashboardLoadState'); await f.page.locator('#accountMenuTrigger').click();
        await f.page.locator('#accountMenu [data-settings-tab="access"]').click(); await visible(f.page, '#voucherActivationForm');
        assert.equal(await f.page.locator('#accountVoucherSlot #voucherActivationForm').count(), 1);
        await f.page.locator('#voucherCode').fill('FAKE-TEST-ONLY-VOUCHER'); await f.page.locator('#voucherActivate').click();
        await hidden(f.page, '#voucherActivationForm'); assert.equal(await f.page.locator('#accountPlan').textContent(), 'Basic');
        assert.equal(await f.page.evaluate(() => JSON.stringify({ ...localStorage }).includes('FAKE-TEST-ONLY-VOUCHER')), false);
        server.access.status = 'expired'; await f.page.reload(); await hidden(f.page, '#dashboardLoadState');
        assert.equal(await f.page.locator('#voucherActivationForm').isVisible(), false); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('manual first activation permanently removes voucher field', async () => {
    const server = pendingVoucherState(); const f = await fixture(server);
    try {
        await visible(f.page, '#voucherActivationForm');
        server.access.status = 'active'; server.access.can_redeem_voucher = false;
        for (const key of Object.keys(server.access.capabilities)) server.access.capabilities[key] = true;
        await f.page.locator('#onboardingRefreshAccess').click(); await hidden(f.page, '#voucherActivationForm');
        server.access.status = 'pending'; await f.page.reload(); await hidden(f.page, '#dashboardLoadState');
        assert.equal(await f.page.locator('#voucherActivationForm').isVisible(), false); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

for (const width of [1440, 375]) {
    test(`admin edits tariff, issues batch and revokes a voucher at ${width}px`, async () => {
        const server = state({ account: { id: 1, name: 'Администратор', email: 'admin@example.test', role: 'admin', onboarding_completed_at: stamp } });
        const f = await fixture(server, width);
        try {
            await hidden(f.page, '#dashboardLoadState'); await f.page.locator('#accountMenuTrigger').click();
            await f.page.locator('#adminMenuItem').click(); await f.page.locator('#adminTabTariffs').click();
            await visible(f.page, '[data-tariff="basic"]');
            await f.page.locator('[data-tariff="basic"] [name="checks_limit"]').fill('5');
            await f.page.locator('[data-tariff="basic"] [type="submit"]').click();
            await f.page.waitForFunction(() => document.querySelector('[data-tariff="basic"] [role="status"]').textContent.includes('Сохранено'));
            assert.equal(server.requests.find(item => item.endpoint === '/admin/tariffs/basic' && item.method === 'PATCH').body.checks_limit, 5);
            await f.page.locator('#adminTabVouchers').click(); await enabled(f.page, '#voucherBatchCreate');
            assert.match(await f.page.locator('#voucherBatchSummary').textContent(), /5 проверок/);
            await f.page.locator('#voucherBatchQuantity').fill('2'); await f.page.locator('#voucherBatchCreate').click();
            await visible(f.page, '#voucherIssued'); await f.page.locator('[data-revoke-voucher]').first().waitFor({ state: 'visible' });
            await enabled(f.page, '#voucherBatchCreate');
            assert.equal((await f.page.locator('#voucherIssuedCodes').inputValue()).split('\n').length, 2);
            assert.equal(await f.page.locator('#voucherBatchDetail').textContent().then(text => text.includes('AAAAA-BBBBB')), false);
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const directory = path.join(os.tmpdir(), 'vidno-voucher-qa'); await fs.mkdir(directory, { recursive: true });
            await f.page.screenshot({ path: path.join(directory, `admin-${width}.png`), fullPage: true });
            f.page.once('dialog', dialog => dialog.accept()); await f.page.locator('[data-revoke-voucher]').first().click();
            await f.page.waitForFunction(() => document.querySelector('#voucherBatchDetail').textContent.includes('Отозван'));
            assert.equal(count(server, '/admin/voucher-batches'), 1);
            await f.page.reload(); await hidden(f.page, '#dashboardLoadState');
            assert.equal(await f.page.locator('#voucherIssuedCodes').inputValue(), ''); assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });
}

test('admin cannot issue batch while tariff settings are unavailable and can recover', async () => {
    const server = state({ account: { id: 1, name: 'Админ', email: 'admin@example.test', role: 'admin', onboarding_completed_at: stamp }, tariffFailure: true });
    const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState'); await f.page.locator('#accountMenuTrigger').click(); await f.page.locator('#adminMenuItem').click();
        await f.page.locator('#adminTabVouchers').click();
        assert.equal(await f.page.locator('#voucherBatchCreate').isDisabled(), true);
        await f.page.locator('#adminTabTariffs').click(); await visible(f.page, '#adminTariffRetry');
        server.tariffFailure = false; await f.page.locator('#adminTariffRetry').click(); await visible(f.page, '[data-tariff="basic"]');
        await f.page.locator('#adminTabVouchers').click(); await enabled(f.page, '#voucherBatchCreate');
        assert.equal(count(server, '/admin/voucher-batches'), 0); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('pending administrator can manage vouchers without completing client onboarding', async () => {
    const server = pendingVoucherState({ account: { id: 1, name: 'Админ', email: 'admin@example.test', role: 'admin', onboarding_completed_at: null } });
    server.access.can_redeem_voucher = false;
    const f = await fixture(server, 375);
    try {
        await hidden(f.page, '#dashboardLoadState'); await hidden(f.page, '#onboarding');
        assert.equal(await f.page.locator('#voucherActivationForm').isVisible(), false);
        await f.page.locator('#accountMenuTrigger').click(); await f.page.locator('#adminMenuItem').click();
        await f.page.locator('#adminTabVouchers').click(); await enabled(f.page, '#voucherBatchCreate');
        assert.equal(count(server, '/brands'), 0); assert.equal(count(server, '/check-all'), 0); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

function adminClientRaceState(overrides = {}) {
    const server = state({ account: { id: 1, name: 'Админ', email: 'admin@example.test', role: 'admin', onboarding_completed_at: stamp }, ...overrides });
    server.clientDetails = {
        2: { account: { id: 2, name: 'Клиент A', email: 'a@example.test', role: 'client' }, access: { ...server.access, plan: 'basic', checks: { limit: 5, used: 0, remaining: 5 } } },
        3: { account: { id: 3, name: 'Клиент B', email: 'b@example.test', role: 'client' }, access: { ...server.access, plan: 'pro', checks: { limit: 30, used: 0, remaining: 30 } } },
    };
    return server;
}

test('late client profile does not overwrite another client or save limits to wrong recipient', async () => {
    const server = adminClientRaceState({ clientReadDelays: { 2: 350 } }); const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState'); await f.page.locator('#accountMenuTrigger').click(); await f.page.locator('#adminMenuItem').click();
        await visible(f.page, '[data-admin-client="2"]');
        const late = f.page.waitForResponse(response => response.url().endsWith('/admin/clients/2'));
        await f.page.locator('[data-admin-client="2"]').click(); await f.page.locator('[data-admin-client="3"]').click();
        await f.page.waitForFunction(() => document.querySelector('#adminClientEditor h2')?.textContent === 'Клиент B');
        await late;
        assert.equal(await f.page.locator('#adminClientEditor h2').textContent(), 'Клиент B');
        assert.equal(await f.page.locator('#adminChecksLimit').inputValue(), '30');
        await f.page.locator('#adminAccessForm [type="submit"]').click();
        await f.page.waitForFunction(() => document.querySelector('#adminAccessStatusMessage')?.textContent.includes('сохранены'));
        const saved = server.requests.find(item => item.endpoint === '/admin/clients/3/access' && item.method === 'PATCH');
        assert.equal(saved.body.checks_limit, 30); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('late client save response does not replace currently selected client', async () => {
    const server = adminClientRaceState({ clientSaveDelay: 350 }); const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState'); await f.page.locator('#accountMenuTrigger').click(); await f.page.locator('#adminMenuItem').click();
        await visible(f.page, '[data-admin-client="2"]'); await f.page.locator('[data-admin-client="2"]').click();
        await visible(f.page, '#adminAccessForm');
        const late = f.page.waitForResponse(response => response.url().endsWith('/admin/clients/2/access'));
        await f.page.locator('#adminAccessForm [type="submit"]').click(); await f.page.locator('[data-admin-client="3"]').click();
        await f.page.waitForFunction(() => document.querySelector('#adminClientEditor h2')?.textContent === 'Клиент B');
        await late;
        assert.equal(await f.page.locator('#adminClientEditor h2').textContent(), 'Клиент B');
        assert.equal(await f.page.locator('#adminChecksLimit').inputValue(), '30'); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('voucher batch waits for pending tariff save and uses updated conditions', async () => {
    const server = state({ account: { id: 1, name: 'Админ', email: 'admin@example.test', role: 'admin', onboarding_completed_at: stamp }, tariffSaveDelay: 350 });
    const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState'); await f.page.locator('#accountMenuTrigger').click(); await f.page.locator('#adminMenuItem').click();
        await f.page.locator('#adminTabTariffs').click(); await visible(f.page, '[data-tariff="basic"]');
        await f.page.locator('[data-tariff="basic"] [name="checks_limit"]').fill('9');
        await f.page.locator('[data-tariff="basic"] [type="submit"]').click(); await f.page.locator('#adminTabVouchers').click();
        assert.equal(await f.page.locator('#voucherBatchCreate').isDisabled(), true);
        await enabled(f.page, '#voucherBatchCreate'); assert.match(await f.page.locator('#voucherBatchSummary').textContent(), /9 проверок/);
        await f.page.locator('#voucherBatchQuantity').fill('1'); await f.page.locator('#voucherBatchCreate').click();
        await visible(f.page, '#voucherIssued'); assert.equal(server.voucherBatches[0].batch.checks_limit, 9);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

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

for (const width of [1440, 375]) {
    test(`saved check details and exact repeat work at ${width}px`, async () => {
        const saved = check();
        saved.result.requested_providers = [...providers];
        const server = state({ brands: [brand()], checks: [saved], nextCheckId: 502 });
        server.account.onboarding_completed_at = stamp;
        const f = await fixture(server, width);
        try {
            await hidden(f.page, '#dashboardLoadState');
            await f.page.locator('.app-nav [data-view="prompts"]').click();
            await f.page.locator('[data-check-details="501"]').click();
            await visible(f.page, '#checkDetailsDialog');
            assert.equal(await f.page.locator('.check-detail-model').count(), 5);
            assert.match(await f.page.locator('#checkDetailsDialog').textContent(), /gigachat 501/i);
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            await f.page.locator('#checkDetailsDialog [data-repeat-check="501"]').click();
            await visible(f.page, '#wsResult');
            const request = server.requests.filter(item => item.endpoint === '/check-all' && item.method === 'POST').at(-1);
            assert.equal(request.body.query, saved.query);
            assert.deepEqual(request.body.providers, providers);
            assert.equal(server.checks.length, 2);
            assert.equal(count(server, '/check', 'POST'), 0);
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });
}

test('history can reveal more than ten saved checks', async () => {
    const checks = Array.from({ length: 12 }, (_, index) => check(600 + index, 'completed', true, `Вопрос ${index + 1}`));
    const server = state({ brands: [brand()], checks });
    server.account.onboarding_completed_at = stamp;
    const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState');
        await f.page.locator('.app-nav [data-view="prompts"]').click();
        assert.equal(await f.page.locator('.app-history-row').count(), 10);
        await f.page.locator('#historyToggle').click();
        assert.equal(await f.page.locator('.app-history-row').count(), 12);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('single-model history repeats through the single-provider endpoint', async () => {
    const saved = check();
    const providerResult = saved.result.provider_results[0];
    saved.provider = providerResult.provider;
    saved.result = { ...providerResult };
    const server = state({ brands: [brand()], checks: [saved], nextCheckId: 502 });
    server.account.onboarding_completed_at = stamp;
    const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState');
        await f.page.locator('.app-nav [data-view="prompts"]').click();
        await f.page.locator('[data-repeat-check="501"]').click();
        await visible(f.page, '#wsResult');
        const request = server.requests.find(item => item.endpoint === '/check' && item.method === 'POST');
        assert.equal(request.body.provider, 'gigachat');
        assert.equal(request.body.query, saved.query);
        assert.equal(count(server, '/check-all'), 0);
        assert.equal(server.checks.length, 2);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('citation rate uses cited links on official domains only', async () => {
    const saved = check();
    saved.result.provider_results[0].sources = [{ url: 'https://shop.acme.test/page', title: 'Не содержит название', cited_in_answer: true }];
    saved.result.provider_results[1].sources = [{ url: 'https://example.test/?next=acme.test', title: 'Acme', cited_in_answer: true }];
    const server = state({ brands: [brand()], checks: [saved] });
    server.account.onboarding_completed_at = stamp;
    const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState');
        assert.equal(await f.page.locator('#metricCitation').textContent(), '20%');
        assert.match(await f.page.locator('#metricCitationNote').textContent(), /1 ответ/);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('growth control check repeats the exact prompt and provider set through check-all', async () => {
    const query = 'Какой сервис выбрать?';
    const baselineResults = ['gigachat', 'openai'].map(provider => ({ provider, model: provider, mentioned: false, position: null, role: 'не упомянут' }));
    const task = { id: 901, brand_id: 101, brand: 'Acme', brandKey: 'brand-101', query, provider: 'all', providers: ['gigachat', 'openai'], title: 'Усилить присутствие', action: 'Обновить материал', workType: 'content', status: 'ready_for_check', baseline: { id: 500, createdAt: Date.parse(stamp), provider: 'all', providers: ['gigachat', 'openai'], providerResults: baselineResults, mentioned: false }, created_at: stamp, updated_at: stamp };
    const server = state({ brands: [brand()], checks: [check(500, 'completed', false, query)], growthTasks: [task], nextCheckId: 501 });
    server.account.onboarding_completed_at = stamp;
    const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState');
        await f.page.locator('.app-nav [data-view="growth"]').click();
        await f.page.locator('[data-growth-tab="tasks"]').click();
        await f.page.locator('[data-measure-task="901"]').click();
        await f.page.locator('[data-growth-tab="results"]').click();
        await visible(f.page, '.growth-result');
        const request = server.requests.find(item => item.endpoint === '/check-all' && item.method === 'POST');
        assert.equal(request.body.query, query);
        assert.deepEqual(request.body.providers, ['gigachat', 'openai']);
        assert.equal(count(server, '/check', 'POST'), 0);
        assert.equal(server.growthTasks[0].status, 'measured');
        assert.deepEqual(server.growthTasks[0].comparison.providers, ['gigachat', 'openai']);
        assert.equal(server.checks.length, 2);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('growth control check saves partial history but does not compare different model sets', async () => {
    const query = 'Какой сервис выбрать?';
    const requested = ['gigachat', 'perplexity'];
    const baselineResults = requested.map(provider => ({ provider, model: provider, mentioned: false, position: null, role: 'не упомянут' }));
    const task = { id: 902, brand_id: 101, brand: 'Acme', brandKey: 'brand-101', query, provider: 'all', providers: requested, title: 'Усилить присутствие', action: 'Обновить материал', workType: 'content', status: 'ready_for_check', baseline: { id: 500, createdAt: Date.parse(stamp), provider: 'all', providers: requested, providerResults: baselineResults, mentioned: false }, created_at: stamp, updated_at: stamp };
    const server = state({ brands: [brand()], checks: [check(500, 'completed', false, query)], growthTasks: [task], nextCheckId: 501, checkMode: 'partial' });
    server.account.onboarding_completed_at = stamp;
    const f = await fixture(server);
    try {
        await hidden(f.page, '#dashboardLoadState');
        await f.page.locator('.app-nav [data-view="growth"]').click();
        await f.page.locator('[data-growth-tab="tasks"]').click();
        f.page.once('dialog', dialog => dialog.accept());
        await f.page.locator('[data-measure-task="902"]').click();
        await f.page.waitForFunction(() => document.querySelector('[data-measure-task="902"]')?.disabled === false);
        assert.equal(server.checks.length, 2);
        assert.equal(server.growthTasks[0].status, 'ready_for_check');
        assert.equal(count(server, '/growth-tasks/902', 'PATCH'), 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});
