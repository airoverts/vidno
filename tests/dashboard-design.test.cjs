const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:8804';
const stamp = '2026-10-09T09:00:00Z';
const version = 'perplexity-direct-v1';
const providers = ['gigachat', 'yandex', 'openai', 'gemini', 'perplexity', 'deepseek'];
let browser;

before(async () => { browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) }); });
after(async () => { await browser?.close(); });

function brand(id = 101, name = 'Acme') {
    return { id, canonical_id: `brand-${id}`, canonical_name: name, aliases: [], domains: [`${name.toLowerCase()}.test`], identity_changed_at: '2026-09-01T09:00:00Z' };
}

function answer(provider = 'openai', mentioned = true, options = {}) {
    const name = options.name || 'Acme';
    const ordered = mentioned ? options.position === 2 ? ['OtherBrand', name] : [name] : ['OtherBrand'];
    return {
        provider, model: provider, analysis_version: version, mentioned,
        raw_answer: ordered.join(', '), role: mentioned ? 'рекомендация' : 'не упомянут',
        ordered_mentions: ordered.map((name, index) => ({ name, position: index + 1, role: 'рекомендация' })),
        competitors: ordered.filter(value => value !== name), sources: [], ...options,
    };
}

function check(id, results = [answer()], options = {}) {
    const result = {
        provider: 'all', analysis_version: version, mentioned: results.some(item => item.mentioned),
        competitors: [...new Set(results.flatMap(item => item.competitors || []))],
        sources: results.flatMap(item => item.sources || []), provider_results: results,
        requested_providers: results.map(item => item.provider), provider_errors: [],
    };
    return { id, brand_id: 101, brand: 'Acme', query: `Вопрос ${id}`, provider: 'all', status: 'completed', created_at: stamp, completed_at: stamp, result, error: null, ...options };
}

function state(options = {}) {
    return {
        brands: [brand()], checks: [], requests: [], checkReads: 0, checkReadFailure: false,
        account: { id: 1, name: 'Тестовый клиент', email: 'client@example.test', created_at: '2026-09-01T09:00:00Z', role: 'client', onboarding_completed_at: stamp },
        access: { status: 'active', plan: 'basic', checks: { limit: 100, used: 10, remaining: 90 }, brands: { limit: 10, used: 1, remaining: 9 }, capabilities: { workspace_write: true, run_checks: true, create_brands: true, manage_existing_brands: true } },
        ...options,
    };
}

async function fixture(server = state(), width = 1440) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.addInitScript(fixed => {
        const NativeDate = Date;
        window.Date = class extends NativeDate {
            constructor(...args) { super(...(args.length ? args : [fixed])); }
            static now() { return fixed; }
        };
        localStorage.setItem('vidno_analytics_consent', 'denied');
        if (!localStorage.getItem('vidno-dashboard-active-brand')) localStorage.setItem('vidno-dashboard-active-brand', 'brand-101');
        window.reportPrintCalls = 0;
        window.print = () => { window.reportPrintCalls++; };
    }, Date.parse(stamp));
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
        const request = route.request(); const url = new URL(request.url());
        const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
        if (url.pathname.startsWith('/api/')) {
            const endpoint = url.pathname.slice(4); const method = request.method();
                        const body = request.postData() ? request.postDataJSON() : null;
            server.requests.push({ endpoint, method, body });
            if (endpoint === '/account' && method === 'PATCH') {
                if (server.accountError) return json({detail:server.accountError},403);
                if (body.name) server.account.name=body.name;
                if (body.email) server.account.email=body.email;
                return json({account:server.account,reauth_required:Boolean(body.email || body.new_password)});
            }
            if (endpoint === '/account' && method === 'DELETE') {
                if (server.deleteAccountError) return json({detail:server.deleteAccountError},403);
                return json({ok:true});
            }
            if (/^\/brands\/\d+$/.test(endpoint)) {
                const index=server.brands.findIndex(item=>String(item.id)===endpoint.split('/').at(-1));
                if (method==='PATCH') {
                    if (server.brandError) return json({detail:server.brandError},409);
                    const previous=server.brands[index];
                    server.brands[index]={...previous,...body};
                    return json({brand:server.brands[index]});
                }
                if (method==='DELETE') {
                    if (server.deleteBrandError) return json({detail:server.deleteBrandError},503);
                    server.brands.splice(index,1);
                    return json({ok:true});
                }
            }
            if (endpoint === '/auth/me') return json({ user: server.account });
            if (endpoint === '/account') return json({ account: server.account });
            if (endpoint === '/access') return json({ access: server.access });
            if (endpoint === '/brands') return json({ brands: server.brands });
            if (endpoint === '/checks') {
                server.checkReads++;
                if (server.checkReadFailure) return json({ detail: 'checks unavailable' }, 503);
                return json({ checks: server.checks });
            }
            if (endpoint === '/growth-tasks') return json({ tasks: [] });
            if (endpoint === '/dismissed-opportunities') return json({ items: [] });
            if (endpoint === '/prompt-suggestions' && method === 'POST' && server.promptSuggestions) return json({ prompts: server.promptSuggestions });
            if (endpoint === '/check-all' && method === 'POST' && server.checkSubmission) {
                server.submitted = request.postDataJSON();
                const submission = server.checkSubmission;
                if (submission.record) server.checks.push(submission.record);
                return json(submission.status ? { detail: submission.error } : { ...submission.record.result, check: submission.record }, submission.status || 200);
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
    await page.locator('#dashboardLoadState').waitFor({ state: 'hidden' });
    return { page, server, errors, close: () => context.close() };
}

async function setDate(page, selector, value) {
    await page.locator(selector).fill(value);
    await page.locator(selector).dispatchEvent('change');
}
const filled = () => state({ checks: [
    check(501, [answer('openai', true, { sources: [{ url: 'https://acme.test/article', title: 'Официальный материал', cited_in_answer: true }] }), answer('yandex', false)]),
    check(502, [answer('openai', true, { position: 2 })]),
] });
async function settings(page, tab) {
    if (!await page.locator('#view-settings').isVisible()) await page.locator('.app-sidebar-bottom > [data-settings-tab="profile"]').click();
    await page.locator(`.settings-nav [data-settings-tab="${tab}"]`).click();
    await page.locator(`#settings-${tab}`).waitFor({ state: 'visible' });
}
async function project(page, name) {
    await page.locator('#projectPickerTrigger').click();
    await page.locator('#projectPickerList button').filter({ hasText: name }).click();
}
const writes = (server, endpoint) => server.requests.filter(item => item.method !== 'GET' && (!endpoint || item.endpoint === endpoint));
async function dashboardMetrics(page) {
    return Promise.all(['metricSov', 'metricVisibility', 'metricCitation', 'metricPosition'].map(id => page.locator(`#${id}`).textContent()));
}

test('approved layout preserves analytical values and fits desktop and mobile widths', async () => {
    for (const width of [1920, 1304, 768, 390]) {
        const f = await fixture(filled(), width);
        try {
            assert.deepEqual(await dashboardMetrics(f.page), ['43%', '67%', '33%', '1.5']);
            assert.equal(await f.page.locator('#sovChart').count(), 0);
            assert.equal(await f.page.locator('.app-leaderboard thead th').count(), 8);
            assert.equal(await f.page.locator('#accountMenuTrigger').count(), 1);
            const layout = await f.page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
            assert.ok(layout.scroll <= layout.width, `${width}: page overflows by ${layout.scroll - layout.width}px`);
            if (width > 768) {
                const trend = await f.page.locator('.app-card-trend').boundingBox();
                const models = await f.page.locator('#modelMetrics').boundingBox();
                const ranking = await f.page.locator('.app-leaderboard').boundingBox();
                const sources = await f.page.locator('#homeSourceList').boundingBox();
                assert.ok(models.x > trend.x && models.y < trend.y + trend.height);
                assert.ok(sources.x > ranking.x && sources.y < ranking.y + ranking.height);
            } else {
                assert.equal(await f.page.locator('#mobileNavToggle').isVisible(), true);
                await f.page.locator('#mobileNavToggle').click();
                assert.equal(await f.page.locator('#projectPickerTrigger').isVisible(), true);
                await f.page.locator('#accountMenuTrigger').click();
                assert.equal(await f.page.locator('#accountMenu').isVisible(), true);
                await f.page.keyboard.press('Escape');
                await f.page.keyboard.press('Escape');
            }
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    }
});

test('empty and partially answered projects distinguish missing data from real zero', async () => {
    const empty = await fixture();
    try {
        assert.deepEqual(await dashboardMetrics(empty.page), ['—', '—', '—', '—']);
        assert.match(await empty.page.locator('#homeCheckCount').textContent(), /0/);
        assert.match(await empty.page.locator('#homeAnswerCount').textContent(), /0/);
        assert.match(await empty.page.locator('#lastCheckTime').textContent(), /—/);
        assert.match(await empty.page.locator('#leaderboardBody').textContent(), /Запустите первую проверку/);
        assert.equal(await empty.page.locator('#overviewEmpty').isVisible(), true);
        assert.deepEqual(empty.errors, []);
    } finally { await empty.close(); }
    const partial = check(501, [answer('openai', false)], { status: 'partial' });
    partial.result.provider_errors = [{ provider: 'yandex', error: 'provider_timeout' }];
    partial.result.requested_providers = ['openai', 'yandex'];
    const f = await fixture(state({ checks: [partial] }));
    try {
        assert.equal((await dashboardMetrics(f.page))[1], '0%');
        await f.page.locator('#providerFilterTrigger').click();
        await f.page.locator('#providerFilterMenu label:has(input[value="openai"])').click();
        await f.page.locator('#providerFilterMenu label:has(input[value="gigachat"])').click();
        await f.page.locator('#providerFilterMenu label:has(input[value="gemini"])').click();
        await f.page.locator('#providerFilterMenu label:has(input[value="perplexity"])').click();
        assert.deepEqual(await dashboardMetrics(f.page), ['—', '—', '—', '—']);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('last successful check uses Moscow time and ignores analytical filters and newer failures', async () => {
    const f = await fixture(state({ checks: [
        check(501, [answer()], { created_at: '2026-10-07T09:00:00Z', completed_at: '2026-10-07T09:05:00Z' }),
        check(502, [answer()], { created_at: '2026-10-08T20:00:00Z', completed_at: '2026-10-08T21:15:00Z' }),
        check(503, [], { status: 'failed', created_at: '2026-10-09T08:00:00Z', completed_at: '2026-10-09T08:05:00Z', error: 'provider_timeout' }),
    ] }));
    try {
        const time = await f.page.locator('#lastCheckTime').textContent();
        assert.match(time, /9 октября|09\.10\.2026/);
        assert.match(time, /00:15/);
        await f.page.locator('#view-home [data-analytics-period]').selectOption('custom');
        await setDate(f.page, '#view-home [data-analytics-start]', '2026-10-07');
        await setDate(f.page, '#view-home [data-analytics-end]', '2026-10-07');
        assert.equal(await f.page.locator('#lastCheckTime').textContent(), time);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('account menu keeps only useful shortcuts and supports keyboard focus', async () => {
    const f = await fixture();
    try {
        await f.page.locator('#accountMenuTrigger').focus();
        await f.page.keyboard.press('ArrowDown');
        assert.equal(await f.page.locator('#accountMenu').isVisible(), true);
        assert.equal(await f.page.locator('#accountMenu [data-settings-tab="profile"]').evaluate(el => el === document.activeElement), true);
        assert.equal(await f.page.locator('#accountMenu [data-settings-tab="appearance"]').count(), 0);
        assert.equal(await f.page.locator('#accountMenu [data-settings-tab="security"]').count(), 0);
        assert.equal(await f.page.locator('#adminMenuItem').isVisible(), false);
        await f.page.keyboard.press('Escape');
        assert.equal(await f.page.locator('#accountMenu').isVisible(), false);
        assert.equal(await f.page.locator('#accountMenuTrigger').evaluate(el => el === document.activeElement), true);
        assert.deepEqual(writes(f.server), []);
    } finally { await f.close(); }
    const admin = state(); admin.account.role = 'admin';
    const a = await fixture(admin);
    try {
        await a.page.locator('#accountMenuTrigger').click();
        assert.equal(await a.page.locator('#adminMenuItem').isVisible(), true);
    } finally { await a.close(); }
});

test('account menu stays inside short desktop and mobile viewports for clients and administrators', async () => {
    for (const role of ['client', 'admin']) {
        for (const [width, height] of [[1360, 768], [1360, 620], [1088, 600], [768, 600], [390, 640], [320, 480]]) {
            const server = state(); server.account.role = role;
            const f = await fixture(server, width);
            try {
                await f.page.setViewportSize({ width, height });
                if (width <= 768) await f.page.locator('#mobileNavToggle').click();
                await f.page.locator('#accountMenuTrigger').click();
                const menu = await f.page.locator('#accountMenu').boundingBox();
                assert.ok(menu.x >= 8, `${role} ${width}x${height}: account menu leaves the left edge`);
                assert.ok(menu.x + menu.width <= width - 8, `${role} ${width}x${height}: account menu leaves the right edge`);
                assert.ok(menu.y >= 8 && menu.y + menu.height <= height - 8, `${role} ${width}x${height}: account menu leaves the viewport vertically`);
                const exit = f.page.locator('#appLogout');
                await exit.scrollIntoViewIfNeeded();
                const exitBox = await exit.boundingBox();
                assert.ok(exitBox.x >= 8 && exitBox.x + exitBox.width <= width - 8);
                assert.ok(exitBox.y >= 8 && exitBox.y + exitBox.height <= height - 8);
                assert.deepEqual(f.errors, []);
            } finally { await f.close(); }
        }
    }
});

test('profile save uses account API and updates sidebar account name', async () => {
    const f = await fixture();
    try {
        await settings(f.page, 'profile');
        await f.page.locator('#accountName').fill('Новое имя');
        await f.page.locator('#accountProfileForm button[type="submit"]').click();
        await f.page.locator('#accountProfileStatus.success').waitFor();
        assert.deepEqual(writes(f.server, '/account').map(item => item.body), [{ name: 'Новое имя' }]);
        assert.equal(await f.page.locator('#appUserName').textContent(), 'Новое имя');
        assert.equal(await f.page.locator('#accountEmail').isEditable(), false);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('project drafts submit one request and keep project identity and metrics', async () => {
    const f = await fixture(filled());
    try {
        await settings(f.page, 'project');
        await f.page.locator('#canonicalBrandName').fill('Acme New');
        await f.page.locator('#brandAliasInput').fill('Acme Other');
        await f.page.locator('#addBrandAlias').click();
        await f.page.locator('#brandDomainInput').fill('new-acme.test');
        await f.page.locator('#addBrandDomain').click();
        assert.deepEqual(writes(f.server), []);
        await f.page.locator('#saveCanonicalBrand').click();
        await f.page.locator('#projectSaveStatus.success').waitFor();
        const saved = writes(f.server, '/brands/101');
        assert.equal(saved.length, 1);
        assert.equal(saved[0].body.canonical_name, 'Acme New');
        assert.ok(saved[0].body.aliases.includes('Acme Other'));
        assert.ok(saved[0].body.domains.includes('new-acme.test'));
        assert.equal(f.server.brands[0].canonical_id, 'brand-101');
        assert.equal(await f.page.locator('#projectPickerName').textContent(), 'Acme New');
        await f.page.locator('.app-nav [data-view="home"]').click({ force: true });
        assert.deepEqual(await dashboardMetrics(f.page), ['43%', '67%', '33%', '1.5']);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('project switch preserves settings tab, restores selection and replaces analytical data', async () => {
    const f = await fixture(state({ brands: [brand(), brand(102, 'Other')], checks: [check(501), check(502, [answer('openai', false, { name: 'Other' })], { brand_id: 102, brand: 'Other' })] }));
    try {
        await settings(f.page, 'profile');
        await project(f.page, 'Other');
        assert.equal(await f.page.locator('#settings-profile').isVisible(), true);
        assert.equal(await f.page.locator('#projectPickerName').textContent(), 'Other');
        await f.page.locator('.app-nav [data-view="home"]').click({ force: true });
        assert.equal((await dashboardMetrics(f.page))[1], '0%');
        assert.equal(await f.page.evaluate(() => localStorage.getItem('vidno-dashboard-active-brand')), 'brand-102');
        await f.page.reload();
        await f.page.locator('#dashboardLoadState').waitFor({ state: 'hidden' });
        assert.equal(await f.page.locator('#projectPickerName').textContent(), 'Other');
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('unsaved project guard supports stay, discard and successful save before navigation', async () => {
    const f = await fixture(state({ brands: [brand(), brand(102, 'Other')] }));
    try {
        await settings(f.page, 'project');
        await f.page.locator('#brandAliasInput').fill('Черновик');
        await f.page.locator('#addBrandAlias').click();
        await project(f.page, 'Other');
        assert.equal(await f.page.locator('#projectLeaveDialog').isVisible(), true);
        await f.page.locator('#projectLeaveCancel').click();
        assert.equal(await f.page.locator('#projectPickerName').textContent(), 'Acme');
        assert.match(await f.page.locator('#brandAliasList').textContent(), /Черновик/);
        await project(f.page, 'Other');
        await f.page.locator('#projectLeaveDiscard').click();
        assert.equal(await f.page.locator('#projectPickerName').textContent(), 'Other');
        assert.deepEqual(writes(f.server), []);
        await project(f.page, 'Acme');
        assert.doesNotMatch(await f.page.locator('#brandAliasList').textContent(), /Черновик/);
        await f.page.locator('#brandAliasInput').fill('Сохранён');
        await f.page.locator('#addBrandAlias').click();
        await f.page.locator('.app-nav [data-view="home"]').click({ force: true });
        await f.page.locator('#projectLeaveSave').click();
        await f.page.locator('#view-home').waitFor({ state: 'visible' });
        assert.equal(writes(f.server, '/brands/101').length, 1);
        assert.ok(f.server.brands[0].aliases.includes('Сохранён'));
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('failed project save keeps unsaved form and prevents requested navigation', async () => {
    const f = await fixture(state({ brandError: 'Сохранение временно недоступно' }));
    try {
        await settings(f.page, 'project');
        await f.page.locator('#brandAliasInput').fill('Черновик');
        await f.page.locator('#addBrandAlias').click();
        await f.page.locator('.app-nav [data-view="home"]').click({ force: true });
        await f.page.locator('#projectLeaveSave').click();
        await f.page.waitForFunction(() => document.body.textContent.includes('Сохранение временно недоступно'));
        assert.equal(await f.page.locator('#view-settings').isVisible(), true);
        assert.match(await f.page.locator('#brandAliasList').textContent(), /Черновик/);
        assert.equal(writes(f.server, '/brands/101').length, 1);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('identity cooldown locks name and domains but allows alias-only save', async () => {
    const recent = brand(); recent.identity_changed_at = stamp;
    const f = await fixture(state({ brands: [recent] }));
    try {
        await settings(f.page, 'project');
        assert.equal(await f.page.locator('#canonicalBrandName').isDisabled(), true);
        assert.equal(await f.page.locator('#brandDomainInput').isDisabled(), true);
        assert.equal(await f.page.locator('#brandAliasInput').isDisabled(), false);
        assert.match(await f.page.locator('#brandIdentityCooldown').textContent(), /23\.10\.2026|14/);
        await f.page.locator('#brandAliasInput').fill('Дополнение');
        await f.page.locator('#addBrandAlias').click();
        await f.page.locator('#saveCanonicalBrand').click();
        await f.page.locator('#projectSaveStatus.success').waitFor();
        assert.equal(writes(f.server, '/brands/101').length, 1);
        assert.ok(f.server.brands[0].aliases.includes('Дополнение'));
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('appearance remains accessible while dark theme is disabled', async () => {
    const f = await fixture();
    try {
        await settings(f.page, 'appearance');
        assert.equal(await f.page.locator('[data-theme-choice="light"]').getAttribute('aria-checked'), 'true');
        assert.equal(await f.page.locator('[data-theme-choice="dark"]').isDisabled(), true);
        assert.match(await f.page.locator('#settings-appearance').textContent(), /Скоро/);
        assert.equal(await f.page.locator('html').getAttribute('data-theme'), 'light');
        assert.deepEqual(writes(f.server), []);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('access renders unlimited and exhausted real quotas without fake expiry', async () => {
    const server = state();
    server.access.checks = { limit: null, used: 42, remaining: null, unlimited: true };
    server.access.brands = { limit: 2, used: 2, remaining: 0 };
    const f = await fixture(server);
    try {
        await settings(f.page, 'access');
        assert.match(await f.page.locator('#accountChecksQuota').textContent(), /42.*безлимит/i);
        assert.match(await f.page.locator('#accountBrandsQuota').textContent(), /2.*2.*0/);
        assert.match(await f.page.locator('#accountAccessExpires').textContent(), /Бессрочно/i);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('security forms align vertically, reject mismatched passwords and use existing account API', async () => {
    const f = await fixture(state({ accountError: 'Текущий пароль указан неверно' }));
    try {
        await settings(f.page, 'security');
        const email = await f.page.locator('#accountEmailForm').boundingBox();
        const password = await f.page.locator('#accountPasswordForm').boundingBox();
        assert.ok(password.y > email.y + email.height);
        assert.ok(Math.abs(email.width - password.width) <= 2);
        await f.page.locator('#accountPasswordCurrent').fill('current-password');
        await f.page.locator('#accountPasswordNew').fill('new-password');
        await f.page.locator('#accountPasswordConfirm').fill('different-password');
        await f.page.locator('#accountPasswordForm button[type="submit"]').click();
        assert.deepEqual(writes(f.server), []);
        await f.page.locator('#accountPasswordConfirm').fill('new-password');
        await f.page.locator('#accountPasswordForm button[type="submit"]').click();
        await f.page.waitForFunction(() => document.querySelector('#accountPasswordStatus').textContent.includes('неверно'));
        assert.deepEqual(writes(f.server, '/account').map(item => item.body), [{ current_password: 'current-password', new_password: 'new-password' }]);
        assert.equal(await f.page.locator('#accountPasswordNew').inputValue(), 'new-password');
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('email and password changes honor required reauthentication', async () => {
    for (const kind of ['email', 'password']) {
        const f = await fixture();
        try {
            await settings(f.page, 'security');
            if (kind === 'email') {
                await f.page.locator('#accountEmailNew').fill('updated@example.test');
                await f.page.locator('#accountEmailCurrentPassword').fill('current-password');
                await f.page.locator('#accountEmailForm button[type="submit"]').click();
            } else {
                await f.page.locator('#accountPasswordCurrent').fill('current-password');
                await f.page.locator('#accountPasswordNew').fill('new-password');
                await f.page.locator('#accountPasswordConfirm').fill('new-password');
                await f.page.locator('#accountPasswordForm button[type="submit"]').click();
            }
            await f.page.waitForURL('**/index.html?auth=login');
            assert.equal(writes(f.server, '/account').length, 1);
        } finally { await f.close(); }
    }
});

test('account deletion requires modal password and exact confirmation and keeps errors visible', async () => {
    const f = await fixture(state({ deleteAccountError: 'Не удалось удалить аккаунт' }));
    try {
        await settings(f.page, 'security');
        assert.equal(await f.page.locator('#deleteAccountForm').isVisible(), false);
        await f.page.locator('#openDeleteAccount').click();
        assert.equal(await f.page.locator('#accountDeleteDialog').isVisible(), true);
        await f.page.locator('#deleteAccountPassword').fill('current-password');
        await f.page.locator('#deleteAccountConfirmation').fill('удалить');
        await f.page.locator('#deleteAccount').click();
        assert.deepEqual(writes(f.server), []);
        await f.page.locator('#deleteAccountConfirmation').fill('УДАЛИТЬ');
        await f.page.locator('#deleteAccount').click();
        await f.page.waitForFunction(() => document.querySelector('#deleteAccountStatus').textContent.includes('Не удалось'));
        assert.equal(await f.page.locator('#accountDeleteDialog').isVisible(), true);
        assert.deepEqual(writes(f.server, '/account').map(item => item.body), [{ current_password: 'current-password', confirmation: 'УДАЛИТЬ' }]);
        await f.page.keyboard.press('Escape');
        assert.equal(await f.page.locator('#openDeleteAccount').evaluate(el => el === document.activeElement), true);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('project deletion confirms explicitly and selects a remaining accessible project', async () => {
    const f = await fixture(state({ brands: [brand(), brand(102, 'Other')] }));
    try {
        await settings(f.page, 'project');
        await f.page.locator('#deleteBrand').click();
        assert.equal(await f.page.locator('#projectDeleteDialog').isVisible(), true);
        assert.deepEqual(writes(f.server), []);
        await f.page.locator('#confirmDeleteBrand').click();
        await f.page.waitForFunction(() => document.querySelector('#projectPickerName').textContent === 'Other');
        assert.equal(writes(f.server, '/brands/101').filter(item => item.method === 'DELETE').length, 1);
        assert.equal(f.server.brands.length, 1);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('metric explanations open for keyboard and tap without decorative metric icons', async () => {
    const f = await fixture(filled());
    try {
        const buttons = f.page.locator('[data-metric-help]');
        assert.equal(await buttons.count(), 4);
        for (let index = 0; index < 4; index++) {
            const button = buttons.nth(index);
            const tooltipId = await button.getAttribute('aria-describedby');
            assert.ok(tooltipId);
            const tooltip = f.page.locator(`#${tooltipId}`);
            assert.equal(await tooltip.getAttribute('role'), 'tooltip');
            await button.focus();
            assert.equal(await tooltip.isVisible(), true);
            await button.click();
            await f.page.keyboard.press('Escape');
            assert.equal(await tooltip.evaluate(el => getComputedStyle(el).visibility), 'hidden');
        }
        assert.equal(await f.page.locator('.app-kpis article > span > i').count(), 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('password visibility toggle updates input type and keeps its entered value', async () => {
    const f = await fixture();
    try {
        await settings(f.page, 'security');
        const input = f.page.locator('#accountPasswordNew');
        const toggle = f.page.locator('[data-password-toggle="accountPasswordNew"]');
        await input.fill('test-password');
        await toggle.click();
        assert.equal(await input.getAttribute('type'), 'text');
        assert.equal(await input.inputValue(), 'test-password');
        await toggle.click();
        assert.equal(await input.getAttribute('type'), 'password');
        assert.deepEqual(writes(f.server), []);
    } finally { await f.close(); }
});




test('one completed check shows real values and asks for a second observation', async () => {
    const f = await fixture(state({ checks: [check(501)] }));
    try {
        assert.deepEqual(await dashboardMetrics(f.page), ['100%', '100%', '0%', '1']);
        assert.match(await f.page.locator('#overviewEmpty').textContent(), /две проверки/);
        assert.match(await f.page.locator('#homeSourceList').textContent(), /Нет источников/);
        assert.match(await f.page.locator('#homeCheckCount').textContent(), /1/);
        assert.match(await f.page.locator('#homeAnswerCount').textContent(), /1/);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('closed mobile navigation is excluded from keyboard tab order', async () => {
    const f = await fixture(state(), 390);
    try {
        await f.page.locator('#mobileNavToggle').focus();
        for (let step = 0; step < 7; step++) {
            await f.page.keyboard.press('Tab');
            assert.equal(await f.page.evaluate(() => Boolean(document.activeElement.closest('#appSidebar'))), false);
        }
        await f.page.locator('#mobileNavToggle').click();
        assert.equal(await f.page.locator('#appSidebar .app-logo').evaluate(el => el === document.activeElement), true);
        await f.page.keyboard.press('Escape');
        assert.equal(await f.page.locator('#mobileNavToggle').evaluate(el => el === document.activeElement), true);
        await f.page.keyboard.press('Tab');
        assert.equal(await f.page.evaluate(() => Boolean(document.activeElement.closest('#appSidebar'))), false);
    } finally { await f.close(); }
});

test('suggested project alias is a visible draft and enables saving without immediate write', async () => {
    const result = answer('openai', true, { name: 'Sber', competitors: ['Сбер'], ordered_mentions: [{ name: 'Sber', position: 1 }, { name: 'Сбер', position: 2 }] });
    const f = await fixture(state({ brands: [brand(101, 'Sber')], checks: [check(501, [result], { brand: 'Sber' })] }));
    try {
        await settings(f.page, 'project');
        const suggestion = f.page.locator('#brandSuggestions [data-stage-alias]').filter({ hasText: 'Сбер' });
        assert.equal(await suggestion.isVisible(), true);
        await suggestion.click();
        assert.match(await f.page.locator('#brandAliasList').textContent(), /Сбер/);
        assert.equal(await f.page.locator('#saveCanonicalBrand').isEnabled(), true);
        assert.deepEqual(writes(f.server), []);
        await f.page.locator('#saveCanonicalBrand').click();
        await f.page.locator('#projectSaveStatus.success').waitFor();
        assert.ok(f.server.brands[0].aliases.includes('Сбер'));
    } finally { await f.close(); }
});

test('save before leaving explains invalid draft domain inside the open confirmation dialog', async () => {
    const f = await fixture();
    try {
        await settings(f.page, 'project');
        await f.page.locator('#brandDomainInput').fill('not a domain');
        await f.page.locator('.app-nav [data-view="home"]').click();
        await f.page.locator('#projectLeaveSave').click();
        assert.equal(await f.page.locator('#projectLeaveDialog').isVisible(), true);
        assert.match(await f.page.locator('#projectLeaveStatus').textContent(), /домен/);
        assert.deepEqual(writes(f.server), []);
    } finally { await f.close(); }
});

test('legacy task status and work type render neutral labels and fixed classes', async () => {
    const f = await fixture();
    try {
        const results = await f.page.evaluate(() => ['legacy value', '__proto__', 'constructor', 'toString'].map(value => {
            const target = document.createElement('div');
            target.innerHTML = renderTaskCard({ id: 1, title: 'Старая задача', status: value, workType: value, provider: 'openai' });
            return { status: target.querySelector('.growth-status').textContent, classes: target.querySelector('.growth-status').className, type: target.querySelector('.growth-tag').textContent };
        }));
        for (const result of results) {
            assert.equal(result.status, 'Неизвестный статус');
            assert.equal(result.classes.trim(), 'growth-status');
            assert.equal(result.type, 'Другой тип');
        }
    } finally { await f.close(); }
});
