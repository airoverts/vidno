const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const origin = 'http://127.0.0.1:8802';
const stamp = '2026-10-09T09:00:00Z';
const version = 'perplexity-direct-v1';
const providers = ['gigachat', 'yandex', 'openai', 'gemini', 'perplexity'];
let browser;

before(async () => { browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) }); });
after(async () => { await browser?.close(); });

function brand(id = 101, name = 'Acme') {
    return { id, canonical_id: `brand-${id}`, canonical_name: name, aliases: [], domains: [`${name.toLowerCase()}.test`], identity_changed_at: stamp };
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
        account: { id: 1, name: 'Тестовый клиент', email: 'client@example.test', role: 'client', onboarding_completed_at: stamp },
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
            server.requests.push({ endpoint, method });
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

async function openSidebar(page) {
    const toggle = page.locator('#mobileNavToggle');
    if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
async function navigate(page, view) {
    await openSidebar(page);
    await page.locator(`.app-nav [data-view="${view}"]`).click();
}
async function openAccountMenu(page) {
    await openSidebar(page);
    await page.locator('#accountMenuTrigger').click();
}
async function switchProject(page, key) {
    await openSidebar(page);
    await page.locator('#projectPickerTrigger').click();
    await page.locator(`#projectPickerList [data-project-key="${key}"]`).click();
}
async function reports(page) {
    await navigate(page, 'reports');
    await page.locator('#view-reports').waitFor({ state: 'visible' });
}

async function chooseProviders(page, chosen) {
    for (const provider of providers.filter(item => chosen.includes(item))) await page.locator(`[data-report-provider="${provider}"]`).check();
    for (const provider of providers.filter(item => !chosen.includes(item))) await page.locator(`[data-report-provider="${provider}"]`).uncheck();
}

async function metric(page, key) { return (await page.locator(`#reportDocument [data-report-metric="${key}"]`).textContent()).trim(); }
async function modelCells(page, name) {
    return page.locator('#reportModelBody tr').filter({ has: page.locator('th', { hasText: name }) }).locator('th, td').allTextContents();
}
async function setDate(page, selector, value) {
    await page.locator(selector).fill(value);
    await page.locator(selector).dispatchEvent('change');
}
async function sameMetrics(page) {
    const dashboard = { sov: '#metricSov', visibility: '#metricVisibility', citation: '#metricCitation', position: '#metricPosition' };
    for (const [key, selector] of Object.entries(dashboard)) assert.equal(await metric(page, key), (await page.locator(selector).textContent()).trim());
}

test('report and dashboard share model selection, answer denominators and sources', async () => {
    const official = { url: 'https://acme.test/article', title: 'Официальный материал', cited_in_answer: true };
    const unselected = { url: 'https://yandex-only.test/review', title: 'Обзор', cited_in_answer: true };
    const f = await fixture(state({ checks: [check(501, [answer('openai', true, { sources: [official] }), answer('yandex', false, { sources: [unselected] })]), check(502, [answer('openai', true, { position: 2 })])] }));
    try {
        await reports(f.page); await sameMetrics(f.page);
        assert.equal(await metric(f.page, 'visibility'), '67%');
        assert.equal(await metric(f.page, 'sov'), '43%');
        assert.equal(await metric(f.page, 'citation'), '33%');
        assert.equal(await metric(f.page, 'position'), '1.5');
        assert.match(await f.page.locator('#reportModelBody').textContent(), /ChatGPT/);
        assert.deepEqual(await modelCells(f.page, 'ChatGPT'), ['ChatGPT', '2', '2', '100%']);
        assert.deepEqual(await modelCells(f.page, 'Алиса AI'), ['Алиса AI', '1', '0', '0%']);
        assert.match(await f.page.locator('#reportSourceBody').textContent(), /yandex-only\.test/);
        await chooseProviders(f.page, ['openai']); await sameMetrics(f.page);
        assert.equal(await metric(f.page, 'visibility'), '100%');
        assert.equal(await metric(f.page, 'sov'), '60%');
        assert.equal(await metric(f.page, 'citation'), '50%');
        assert.doesNotMatch(await f.page.locator('#reportSourceBody').textContent(), /yandex-only\.test/);
        assert.doesNotMatch(await f.page.locator('#reportModelBody').textContent(), /Алиса/);
        assert.equal(await f.page.locator('#providerFilterMenu input[value="openai"]').isChecked(), true);
        assert.equal(await f.page.locator('#providerFilterMenu input[value="yandex"]').isChecked(), false);
        await navigate(f.page, 'home');
        await f.page.locator('#providerFilterTrigger').click();
        await f.page.locator('#providerFilterMenu label:has(input[value="yandex"])').click();
        await f.page.locator('#providerFilterMenu label:has(input[value="openai"])').click();
        await reports(f.page); await sameMetrics(f.page);
        assert.equal(await metric(f.page, 'visibility'), '0%');
        assert.equal(await f.page.locator('[data-report-provider="yandex"]').isChecked(), true);
        assert.equal(await f.page.locator('[data-report-provider="openai"]').isChecked(), false);
        assert.deepEqual(await modelCells(f.page, 'Алиса AI'), ['Алиса AI', '1', '0', '0%']);
        assert.equal(f.server.requests.filter(item => item.method !== 'GET').length, 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('custom dates include Moscow midnight boundaries and use creation time', async () => {
    const f = await fixture(state({ checks: [
        check(501, [answer('openai', false)], { created_at: '2026-10-07T20:59:59.999Z' }),
        check(502, [answer('openai', true)], { created_at: '2026-10-07T21:00:00.000Z', completed_at: '2026-10-09T10:00:00Z' }),
        check(503, [answer('openai', false)], { created_at: '2026-10-08T20:59:59.999Z' }),
        check(504, [answer('openai', true)], { created_at: '2026-10-08T21:00:00.000Z' }),
    ] }));
    try {
        await reports(f.page);
        assert.equal(await f.page.locator('#view-reports [data-analytics-dates]').isVisible(), false);
        assert.equal(await f.page.locator('#view-home [data-analytics-dates]').isVisible(), false);
        await f.page.locator('#view-reports [data-analytics-period]').selectOption('custom');
        assert.equal(await f.page.locator('#view-reports [data-analytics-dates]').isVisible(), true);
        await setDate(f.page, '#view-reports [data-analytics-start]', '2026-10-08');
        await setDate(f.page, '#view-reports [data-analytics-end]', '2026-10-08');
        assert.equal(await metric(f.page, 'visibility'), '50%'); await sameMetrics(f.page);
        assert.deepEqual(await modelCells(f.page, 'ChatGPT'), ['ChatGPT', '2', '1', '50%']);
        assert.equal(await f.page.locator('#view-home [data-analytics-period]').inputValue(), 'custom');
        assert.equal(await f.page.locator('#view-home [data-analytics-start]').inputValue(), '2026-10-08');
        await setDate(f.page, '#view-reports [data-analytics-start]', '2026-10-09');
        assert.equal(await f.page.locator('#reportPrint').isDisabled(), true);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('seven and thirty day presets use calendar days in Moscow and stay shared', async () => {
    const f = await fixture(state({ checks: [
        check(501, [answer('openai', true)], { created_at: '2026-10-02T21:00:00Z' }),
        check(502, [answer('openai', false)], { created_at: '2026-10-02T20:59:59Z' }),
        check(503, [answer('openai', true)], { created_at: '2026-09-09T21:00:00Z' }),
        check(504, [answer('openai', false)], { created_at: '2026-09-09T20:59:59Z' }),
    ] }));
    try {
        await reports(f.page);
        await f.page.locator('#view-reports [data-analytics-period]').selectOption('7');
        assert.equal(await metric(f.page, 'visibility'), '100%'); await sameMetrics(f.page);
        await f.page.locator('#view-reports [data-analytics-period]').selectOption('30');
        assert.equal(await metric(f.page, 'visibility'), '67%'); await sameMetrics(f.page);
        assert.equal(await f.page.locator('#view-home [data-analytics-period]').inputValue(), '30');
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('partial errors for the only selected provider are not negative answers', async () => {
    const partial = check(501, [answer('openai', true)], { status: 'partial' });
    partial.result.provider_errors = [{ provider: 'yandex', error: 'provider_timeout' }];
    partial.result.requested_providers = ['openai', 'yandex'];
    partial.error = partial.result.provider_errors;
    const f = await fixture(state({ checks: [partial] }));
    try {
        await reports(f.page); await chooseProviders(f.page, ['yandex']);
        assert.equal(await metric(f.page, 'visibility'), '—'); await sameMetrics(f.page);
        assert.match(await f.page.locator('#view-reports').textContent(), /ошиб/iu);
        assert.doesNotMatch(await f.page.locator('#reportModelBody').textContent(), /0%/);
        assert.equal(await f.page.locator('#reportPrint').isDisabled(), true);
        await chooseProviders(f.page, ['openai']);
        assert.equal(await metric(f.page, 'visibility'), '100%');
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('failed, running and obsolete analysis do not enter successful answer metrics', async () => {
    const old = check(504, [answer('openai', true, { analysis_version: 'old-analysis' })]);
    old.result.analysis_version = 'old-analysis';
    const f = await fixture(state({ checks: [
        check(501, [answer('openai', false)]),
        check(502, [answer('openai', true)], { status: 'failed', error: 'analysis_failed' }),
        check(503, [answer('openai', true)], { status: 'running', completed_at: null }), old,
    ] }));
    try {
        await reports(f.page);
        assert.equal(await metric(f.page, 'visibility'), '0%'); await sameMetrics(f.page);
        assert.equal(await metric(f.page, 'position'), '—');
        assert.match(await f.page.locator('#reportModelBody').textContent(), /0%/);
        assert.equal(await f.page.locator('#reportPrint').isDisabled(), false);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('aggregate-only current analysis cannot fabricate answers for a selected model', async () => {
    const legacy = check(502, []);
    Object.assign(legacy.result, { mentioned: true, raw_answer: 'Рекомендуем Acme', ordered_mentions: [{ name: 'Acme', position: 1 }], sources: [{ url: 'https://acme.test/aggregate', title: 'Acme', cited_in_answer: true }] });
    const f = await fixture(state({ checks: [check(501, [answer('openai', true)]), legacy] }));
    try {
        await reports(f.page); await chooseProviders(f.page, ['yandex']);
        assert.equal(await metric(f.page, 'visibility'), '—'); await sameMetrics(f.page);
        assert.equal(await metric(f.page, 'sov'), '—');
        assert.match(await f.page.locator('#reportCoverage').textContent(), /Получено ответов для расчёта: 0/);
        assert.match(await f.page.locator('#reportCoverage').textContent(), /Исключено проверок: 1/);
        assert.doesNotMatch(await f.page.locator('#reportSourceBody').textContent(), /acme\.test/);
        assert.equal(await f.page.locator('#reportPrint').isDisabled(), true);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('citation is undefined when the brand has no configured domains', async () => {
    const item = brand(); item.domains = [];
    const f = await fixture(state({ brands: [item], checks: [check(501, [answer('openai', true, { sources: [{ url: 'https://acme.test/page', title: 'Acme', cited_in_answer: true }] })])] }));
    try {
        await reports(f.page); await sameMetrics(f.page);
        assert.equal(await metric(f.page, 'visibility'), '100%');
        assert.equal(await metric(f.page, 'citation'), '—');
        assert.match(await f.page.locator('#reportCitationNote').textContent(), /Домены.*не указаны/);
        assert.equal(await f.page.locator('#reportPrint').isDisabled(), false);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('a current aggregate excludes individual answers from obsolete analysis', async () => {
    const current = answer('openai', false);
    const old = answer('yandex', true, { analysis_version: 'old-analysis', sources: [{ url: 'https://old-only.test/page', title: 'Прежний анализ' }] });
    const f = await fixture(state({ checks: [check(501, [current, old])] }));
    try {
        await reports(f.page); await sameMetrics(f.page);
        assert.equal(await metric(f.page, 'visibility'), '0%');
        assert.deepEqual(await modelCells(f.page, 'ChatGPT'), ['ChatGPT', '1', '0', '0%']);
        assert.deepEqual(await modelCells(f.page, 'Алиса AI'), ['Алиса AI', '0', '0', '—']);
        assert.match(await f.page.locator('#reportCoverage').textContent(), /Получено ответов для расчёта: 1/);
        assert.match(await f.page.locator('#reportCoverage').textContent(), /Ответов прежнего анализа: 1/);
        assert.doesNotMatch(await f.page.locator('#reportSourceBody').textContent(), /old-only\.test/);
        await chooseProviders(f.page, ['yandex']); await sameMetrics(f.page);
        assert.equal(await metric(f.page, 'visibility'), '—');
        assert.equal(await f.page.locator('#reportPrint').isDisabled(), true);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('an explicit mention without target in ordered brands stays consistent across visibility metrics', async () => {
    const result = answer('openai', true, { raw_answer: 'Acme упомянут в тексте. В списке рекомендуется OtherBrand.', ordered_mentions: [{ name: 'OtherBrand', position: 1, role: 'рекомендация' }], competitors: ['OtherBrand'] });
    const f = await fixture(state({ checks: [check(501, [result])] }));
    try {
        await reports(f.page); await sameMetrics(f.page);
        assert.equal(await metric(f.page, 'visibility'), '100%');
        assert.deepEqual(await modelCells(f.page, 'ChatGPT'), ['ChatGPT', '1', '1', '100%']);
        assert.equal(await metric(f.page, 'position'), '—');
        assert.equal(await metric(f.page, 'sov'), '0%');
        assert.match(await f.page.locator('#reportVisibilityNote').textContent(), /1 из 1 ответ/);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('empty report differs from real answers with zero visibility', async () => {
    const f = await fixture();
    try {
        await reports(f.page);
        for (const key of ['sov', 'visibility', 'citation', 'position']) assert.equal(await metric(f.page, key), '—');
        assert.equal(await f.page.locator('#reportPrint').isDisabled(), true);
        f.server.checks = [check(501, [answer('openai', false)])];
        await f.page.locator('#reportRefresh').click();
        await f.page.waitForFunction(() => document.querySelector('[data-report-metric="visibility"]').textContent.trim() === '0%');
        assert.equal(await f.page.locator('#reportPrint').isDisabled(), false);
        await sameMetrics(f.page); assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('saved-check context keeps the full report slice and clears on brand switch', async () => {
    const f = await fixture(state({ brands: [brand(), brand(102, 'SecondBrand')], checks: [
        check(501, [answer('openai', true)]), check(502, [answer('openai', false)]),
        check(503, [answer('openai', true, { name: 'SecondBrand' })], { brand_id: 102, brand: 'SecondBrand' }),
    ] }));
    try {
        await navigate(f.page, 'prompts');
        await f.page.locator('[data-open-check="501"]').click();
        await f.page.locator('#resultReport').click();
        assert.match(await f.page.locator('#reportCheckContext').textContent(), /Вопрос 501/);
        assert.equal(await metric(f.page, 'visibility'), '50%');
        await f.page.locator('#reportBackToCheck').click();
        await f.page.locator('#wsResult').waitFor({ state: 'visible' });
        await f.page.locator('#resultReport').click();
        await switchProject(f.page, 'brand-102');
        assert.equal(await metric(f.page, 'visibility'), '100%'); await sameMetrics(f.page);
        assert.equal(await f.page.locator('#view-reports').getAttribute('data-check-id'), '');
        assert.equal(await f.page.locator('#reportBackToCheck').isVisible(), false);
        assert.doesNotMatch(await f.page.locator('#reportDocument').textContent(), /Вопрос 501/);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

test('refresh failure disables printing and successful retry replaces stale numbers', async () => {
    const f = await fixture(state({ checks: [check(501)] }));
    try {
        await reports(f.page);
        assert.equal(await metric(f.page, 'visibility'), '100%');
        const reads = f.server.checkReads;
        f.server.checkReadFailure = true;
        await f.page.locator('#reportRefresh').click();
        await f.page.waitForFunction(() => /не удалось|ошиб|unavailable/iu.test(document.querySelector('#reportStatus').textContent));
        assert.equal(await f.page.locator('#reportPrint').isDisabled(), true);
        f.server.checkReadFailure = false;
        f.server.checks.push(check(502, [answer('openai', false)]));
        await f.page.locator('#reportRefresh').click();
        await f.page.waitForFunction(() => document.querySelector('[data-report-metric="visibility"]').textContent.trim() === '50%');
        assert.equal(await f.page.locator('#reportPrint').isDisabled(), false);
        assert.equal(f.server.checkReads, reads + 2);
        assert.equal(f.server.requests.filter(item => item.method !== 'GET').length, 0);
        assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
});

for (const width of [1440, 390]) {
    test(`snapshot citation survives current domain removal at ${width}px`, async () => {
        const result = answer('openai', true, {
            identity_normalization_version: 'company-options-v1', canonical_id: 'brand-101', canonical_name: 'Acme',
            citation_domains: ['acme.test'], brand_cited: true,
            sources: [{ url: 'https://acme.test/article', title: 'Acme', cited_in_answer: true }],
            ordered_mentions: [{ name: 'Acme', canonical_name: 'Acme', canonical_id: 'brand-101', observed_names: ['Acme'], position: 1, role: 'рекомендация' }],
        });
        const saved = check(706, [result]);
        Object.assign(saved.result, { identity_normalization_version: 'company-options-v1', citation_domains: ['acme.test'], brand_cited: true });
        const f = await fixture(state({ checks: [saved] }), width);
        try {
            await reports(f.page); await sameMetrics(f.page);
            assert.equal(await metric(f.page, 'citation'), '100%');
            f.server.brands[0].domains = [];
            await f.page.reload();
            await f.page.locator('#dashboardLoadState').waitFor({ state: 'hidden' });
            await reports(f.page); await sameMetrics(f.page);
            assert.equal(await metric(f.page, 'citation'), '100%');
            assert.match(await f.page.locator('#reportCitationNote').textContent(), /1 из 1 ответ/);
            assert.doesNotMatch(await f.page.locator('#reportCitationNote').textContent(), /Домены.*не указаны/);
            assert.equal(await f.page.locator('#reportPrint').isDisabled(), false);
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });

    test(`company snapshots preserve new bank rows and legacy metrics at ${width}px`, async () => {
        const target = brand(101, 'Т-Банк'); target.domains = [];
        const names = ['Т-Банк', 'Альфа-Банк', 'Точка Банк', 'ВТБ', 'СберБанк', 'СберБизнес'];
        const legacy = check(701, [answer('openai', true, {
            name: target.canonical_name, raw_answer: names.join(', '),
            ordered_mentions: names.map((name, index) => ({ name, position: index + 1, role: 'рекомендация' })),
            competitors: names.slice(1),
        })], { brand: target.canonical_name });
        const current = structuredClone(legacy); current.id = 702;
        const currentAnswer = current.result.provider_results[0];
        Object.assign(currentAnswer, {
            identity_normalization_version: 'company-options-v1', canonical_id: 'brand-101', canonical_name: target.canonical_name,
            ordered_mentions: names.slice(0, 5).map((name, index) => ({
                name, canonical_name: name, canonical_id: index ? `company:${index}` : 'brand-101',
                observed_name: name, observed_names: index === 4 ? ['СберБанк', 'СберБизнес'] : [name], position: index + 1, role: 'рекомендация',
            })), competitors: names.slice(1, 5),
        });
        Object.assign(current.result, { identity_normalization_version: 'company-options-v1', canonical_id: 'brand-101', canonical_name: target.canonical_name, ordered_mentions: currentAnswer.ordered_mentions, competitors: currentAnswer.competitors });
        const f = await fixture(state({ brands: [target], checks: [legacy] }), width);
        try {
            await reports(f.page); await sameMetrics(f.page);
            assert.equal(await f.page.locator('#reportBrandBody tr').count(), 6);
            assert.equal(await metric(f.page, 'sov'), '41%');
            assert.match(await f.page.locator('#reportBrandBody').textContent(), /СберБизнес/);
            f.server.checks = [current];
            await f.page.locator('#reportRefresh').click();
            await f.page.waitForFunction(() => document.querySelector('[data-report-metric="sov"]').textContent.trim() === '44%');
            assert.equal(await f.page.locator('#reportBrandBody tr').count(), 5);
            assert.doesNotMatch(await f.page.locator('#reportBrandBody').textContent(), /СберБизнес/);
            f.server.brands[0].aliases = ['СберБанк', 'СберБизнес'];
            await f.page.reload();
            await f.page.locator('#dashboardLoadState').waitFor({ state: 'hidden' });
            await reports(f.page); await sameMetrics(f.page);
            assert.equal(await metric(f.page, 'sov'), '44%');
            assert.equal(await metric(f.page, 'position'), '1');
            assert.equal(await f.page.locator('#reportBrandBody tr').count(), 5);
            assert.match(await f.page.locator('#reportBrandBody').textContent(), /СберБанк/);
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });

    test(`independent company brands in a saved snapshot stay separate at ${width}px`, async () => {
        const names = ['Acme', 'СберМаркет', 'Самокат'];
        const result = answer('openai', true, {
            identity_normalization_version: 'company-options-v1', canonical_id: 'brand-101', canonical_name: 'Acme',
            raw_answer: names.join(', '), competitors: names.slice(1),
            ordered_mentions: names.map((name, index) => ({ name, canonical_name: name, canonical_id: index ? `independent:${index}` : 'brand-101', observed_names: [name], position: index + 1, role: 'рекомендация' })),
        });
        const saved = check(703, [result]);
        saved.result.identity_normalization_version = 'company-options-v1';
        const f = await fixture(state({ checks: [saved] }), width);
        try {
            await reports(f.page); await sameMetrics(f.page);
            const rows = await f.page.locator('#reportBrandBody tr th').allTextContents();
            assert.deepEqual(rows, ['Acme · ваш бренд', 'СберМаркет', 'Самокат']);
            assert.equal(await metric(f.page, 'sov'), '55%');
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });

    test(`live success persists through API reload and errors retain active brand at ${width}px`, async () => {
        const target = brand(102, 'SecondBrand');
        const suggestedQuery = 'Какие сервисы стоит выбрать? Назови варианты и объясни выбор.';
        const saved = check(704, [answer('openai', true, { name: target.canonical_name })], { brand_id: 102, brand: target.canonical_name, query: `${suggestedQuery} Для небольшой команды.` });
        const f = await fixture(state({ brands: [brand(), target], promptSuggestions: [suggestedQuery], checkSubmission: { record: saved } }), width);
        try {
            await switchProject(f.page, 'brand-102');
            await navigate(f.page, 'prompts');
            await f.page.locator('#wsSuggestPrompts').click();
            await f.page.locator('[data-suggested-prompt]').first().click();
            assert.equal(await f.page.locator('#wsQuery').inputValue(), suggestedQuery);
            assert.equal(f.server.requests.filter(item => item.endpoint === '/check-all').length, 0);
            await f.page.locator('#wsQuery').fill(saved.query);
            await f.page.locator('#wsCheck').click();
            await f.page.locator('#wsResult').waitFor({ state: 'visible' });
            assert.equal(f.server.submitted.query, saved.query);
            assert.deepEqual(f.server.submitted.providers, providers);
            await f.page.reload();
            await f.page.locator('#dashboardLoadState').waitFor({ state: 'hidden' });
            assert.equal(await f.page.locator('#activeBrandSelect').inputValue(), 'brand-102');
            await reports(f.page); await sameMetrics(f.page);
            assert.equal(await metric(f.page, 'visibility'), '100%');
            f.server.checkSubmission = { status: 503, error: 'backend unavailable' };
            await navigate(f.page, 'prompts');
            await f.page.locator('#wsQuery').fill('Какие конкретные варианты подходят для новой задачи?');
            await f.page.locator('#wsCheck').click();
            await f.page.waitForFunction(() => /backend unavailable/.test(document.querySelector('#wsError').textContent));
            assert.equal(await f.page.locator('#wsResult').isVisible(), false);
            assert.equal(await f.page.evaluate(() => localStorage.getItem('vidno-dashboard-active-brand')), 'brand-102');
            await f.page.reload();
            await f.page.locator('#dashboardLoadState').waitFor({ state: 'hidden' });
            assert.equal(await f.page.locator('#activeBrandSelect').inputValue(), 'brand-102');
            await reports(f.page);
            assert.equal(await metric(f.page, 'visibility'), '100%');
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });

    test(`failed provider analysis retains raw answers without metrics at ${width}px`, async () => {
        const rawAnswer = 'Рекомендуем Acme и OtherBrand: первый удобен для отчётов, второй для интеграций.';
        const failed = check(705, [], { status: 'failed', query: 'Какие сервисы выбрать?', error: 'provider_model_mismatch' });
        failed.result.provider_errors = [{ provider: 'perplexity', error: 'provider_model_mismatch', analysis_error: true, raw_answer: rawAnswer, sources: [] }];
        failed.result.requested_providers = ['perplexity'];
        const f = await fixture(state({ checkSubmission: { status: 502, error: 'provider_model_mismatch', record: failed } }), width);
        try {
            await navigate(f.page, 'prompts');
            await f.page.locator('#wsQuery').fill(failed.query);
            await f.page.locator('#wsCheck').click();
            await f.page.waitForFunction(() => /provider_model_mismatch/.test(document.querySelector('#wsError').textContent));
            assert.equal(await f.page.locator('#wsResult').isVisible(), false);
            await f.page.locator('[data-check-details="705"]').click();
            assert.match(await f.page.locator('#checkDetailsContent').textContent(), /Рекомендуем Acme и OtherBrand/);
            assert.doesNotMatch(await f.page.locator('#checkDetailsContent').textContent(), /Бренд не упомянут|Бренд упомянут/);
            await f.page.locator('#checkDetailsDialog [data-check-details-close]').first().click();
            await reports(f.page); await sameMetrics(f.page);
            for (const key of ['sov', 'visibility', 'citation', 'position']) assert.equal(await metric(f.page, key), '—');
            assert.equal(await f.page.locator('#reportPrint').isDisabled(), true);
            await f.page.reload();
            await f.page.locator('#dashboardLoadState').waitFor({ state: 'hidden' });
            await navigate(f.page, 'prompts');
            await f.page.locator('[data-check-details="705"]').click();
            assert.match(await f.page.locator('#checkDetailsContent').textContent(), /Рекомендуем Acme и OtherBrand/);
            assert.equal(await f.page.evaluate(() => localStorage.getItem('vidno-dashboard-active-brand')), 'brand-101');
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });

    test(`report fits ${width}px and prints only the report with a valid PDF`, async () => {
        const f = await fixture(state({ checks: [check(501, [answer('openai', true, { sources: [{ url: 'https://acme.test/article', title: 'Материал', cited_in_answer: true }] }), answer('yandex', false)])] }), width);
        try {
            await reports(f.page);
            assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            const directory = path.join(os.tmpdir(), 'vidno-reports-qa'); await fs.mkdir(directory, { recursive: true });
            await f.page.screenshot({ path: path.join(directory, `report-${width}.png`), fullPage: true });
            const paperColors = await f.page.locator('#reportDocument').evaluate(element => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color]);
            await f.page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; window.dispatchEvent(new Event('vidno-theme-change')); });
            assert.deepEqual(await f.page.locator('#reportDocument').evaluate(element => [getComputedStyle(element).backgroundColor, getComputedStyle(element).color]), paperColors);
            await f.page.screenshot({ path: path.join(directory, `report-dark-${width}.png`), fullPage: true });
            await f.page.locator('#reportPrint').click();
            await f.page.waitForFunction(() => window.reportPrintCalls === 1);
            await f.page.emulateMedia({ media: 'print' });
            assert.equal(await f.page.locator('body').evaluate(element => getComputedStyle(element).backgroundColor), paperColors[0]);
            assert.equal(await f.page.locator('#reportDocument').isVisible(), true);
            assert.equal(await f.page.locator('.app-nav').isVisible(), false);
            assert.equal(await f.page.locator('#reportPrint').isVisible(), false);
            assert.equal(await f.page.locator('#reportRefresh').isVisible(), false);
            assert.equal(await f.page.locator('#reportBackToCheck').isVisible(), false);
            const exposed = await f.page.locator('.app-view:not(#view-reports)').evaluateAll(elements => elements.filter(element => getComputedStyle(element).display !== 'none').map(element => element.id));
            assert.deepEqual(exposed, []);
            await f.page.screenshot({ path: path.join(directory, `print-${width}.png`), fullPage: true });
            const pdfPath = path.join(directory, `report-${width}.pdf`);
            await f.page.pdf({ path: pdfPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
            const pdf = await fs.readFile(pdfPath);
            assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
            assert.ok(pdf.length > 5000);
            assert.deepEqual(f.errors, []);
        } finally { await f.close(); }
    });
}
