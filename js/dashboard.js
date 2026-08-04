const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const API_BASE = location.protocol === 'file:' ? 'http://localhost:8000/api' : '/api';
const PROVIDERS = { gigachat: 'GigaChat', deepseek: 'DeepSeek' };
const HISTORY_KEY = 'vidno-dashboard-check-history';
const LEGACY_HISTORY_KEY = 'vidno-workspace-history';
const BRIEFS_KEY = 'vidno-growth-briefs';
const ACTIVE_BRAND_KEY = 'vidno-dashboard-active-brand';
let history = loadHistory();
let activeBrandKey = loadActiveBrandKey();
let activeRecommendation = null;

function loadJson(key) {
    try { const value = JSON.parse(localStorage.getItem(key) || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
function loadHistory() {
    const current = loadJson(HISTORY_KEY);
    if (current.length) return current.slice(-100);
    const legacy = loadJson(LEGACY_HISTORY_KEY).slice(-100);
    if (legacy.length) localStorage.setItem(HISTORY_KEY, JSON.stringify(legacy));
    return legacy;
}
function saveHistory() { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-100))); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : '#'; } catch { return '#'; } }
function normalizeBrandName(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
function brandKey(value) { return normalizeBrandName(value).toLocaleLowerCase('ru-RU'); }
function loadActiveBrandKey() {
    const saved = brandKey(localStorage.getItem(ACTIVE_BRAND_KEY));
    const available = new Set(history.map(item => brandKey(item.brand)).filter(Boolean));
    if (saved && available.has(saved)) return saved;
    return brandKey(history.at(-1)?.brand || $('#wsBrand')?.value || 'Vidno');
}
function activeHistory() { return history.filter(item => brandKey(item.brand) === activeBrandKey); }
function currentBrand() {
    return [...history].reverse().find(item => brandKey(item.brand) === activeBrandKey)?.brand || normalizeBrandName($('#wsBrand').value) || 'Vidno';
}
function brandOptions() {
    const brands = new Map();
    history.forEach(item => { const key = brandKey(item.brand); if (key) brands.set(key, normalizeBrandName(item.brand)); });
    if (!brands.has(activeBrandKey)) brands.set(activeBrandKey, normalizeBrandName($('#wsBrand').value) || 'Vidno');
    return [...brands].map(([key, name]) => ({ key, name }));
}
function renderBrandSelector() {
    const select = $('#activeBrandSelect');
    select.innerHTML = brandOptions().map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`).join('');
    select.value = activeBrandKey;
}
function setActiveBrand(value, syncInput = true, resetResult = true) {
    const key = brandKey(value);
    if (!key) return;
    activeBrandKey = key;
    localStorage.setItem(ACTIVE_BRAND_KEY, key);
    renderBrandSelector();
    if (syncInput) $('#wsBrand').value = currentBrand();
    if (resetResult) $('#wsResult').hidden = true;
    $('#wsError').hidden = true;
    renderAllForActiveBrand();
}
function renderAllForActiveBrand() {
    renderHistory();
    renderCompetitors();
    renderSources();
    renderMetricsDashboard();
    renderGrowth();
}

$('#activeBrandSelect').addEventListener('change', event => setActiveBrand(event.target.value));

function selectView(view) {
    $$('.app-nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    $$('.app-view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
    $('#appBreadcrumb').textContent = $(`.app-nav-item[data-view="${view}"]`)?.textContent.trim() || (view === 'setup' ? 'Настроить проект' : 'Главная');
    if (view === 'growth') renderGrowth();
    if (view === 'sources') renderSources();
    if (view === 'competitors') renderCompetitors();
}
$$('[data-view]').forEach(button => button.addEventListener('click', () => selectView(button.dataset.view)));

function updateProvider() {
    const name = PROVIDERS[$('#wsProvider').value] || PROVIDERS.gigachat;
    $('#wsCheckText').textContent = `Проверить в ${name}`;
    $('#wsLoaderText').textContent = `Анализируем ответ через ${name}…`;
}
$('#wsProvider').addEventListener('change', updateProvider);
updateProvider();

$('#wsClearCache').addEventListener('click', async () => {
    try {
        const response = await fetch(`${API_BASE}/cache`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Не удалось очистить кэш');
        $('#wsClearCache').innerHTML = '<i class="fa-solid fa-check"></i>';
        setTimeout(() => { $('#wsClearCache').innerHTML = '<i class="fa-solid fa-trash-can"></i>'; }, 1400);
    } catch (error) { showError(error.message); }
});

$('#wsCheck').addEventListener('click', async () => {
    const brand = normalizeBrandName($('#wsBrand').value);
    const query = $('#wsQuery').value.trim();
    const provider = $('#wsProvider').value;
    if (!brand || !query) return showError('Введите бренд и промпт для проверки.');
    $('#wsError').hidden = true; $('#wsResult').hidden = true; $('#wsLoader').hidden = false;
    try {
        const response = await fetch(`${API_BASE}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand, query, provider }) });
        const data = await response.json();
        if (!response.ok || data.error) throw new Error(data.error || data.detail || `HTTP ${response.status}`);
        renderResult(data); saveCheck(data, brand, query, provider);
    } catch (error) { showError(`Не удалось выполнить проверку: ${error.message}`); }
    finally { $('#wsLoader').hidden = true; }
});

function showError(message) { const error = $('#wsError'); error.textContent = message; error.hidden = false; }
function renderResult(data) {
    const result = $('#wsResult');
    $('#wsVerdict').className = `ws-verdict ${data.mentioned ? 'mentioned' : 'not-mentioned'}`;
    $('#wsVerdict').innerHTML = data.mentioned ? '<i class="fa-solid fa-circle-check"></i> Бренд упомянут' : '<i class="fa-solid fa-circle-xmark"></i> Бренд не упомянут';
    $('#wsMeta').innerHTML = [data.provider && ['Провайдер', PROVIDERS[data.provider] || data.provider], data.model && ['Модель', data.model], data.position && ['Позиция', `#${data.position}`], data.role && data.role !== 'не упомянут' && ['Роль', data.role]].filter(Boolean).map(([label, value]) => `<div class="ws-meta-item"><span class="ws-meta-label">${escapeHtml(label)}</span><span class="ws-meta-value">${escapeHtml(value)}</span></div>`).join('');
    setTextBlock('#wsReasoningWrap', '#wsReasoning', data.reasoning);
    const quotes = Array.isArray(data.quotes) ? data.quotes : [];
    $('#wsQuotes').innerHTML = quotes.map(item => `<li>${escapeHtml(item)}</li>`).join(''); $('#wsQuotesWrap').hidden = !quotes.length;
    const brands = Array.isArray(data.mentioned_brands) ? data.mentioned_brands : [];
    $('#wsBrands').innerHTML = brands.map(item => `<li>${escapeHtml(item)}</li>`).join(''); $('#wsBrandsWrap').hidden = !brands.length;
    const analysis = new Map((data.source_analysis || []).map(item => [item.source_index, item]));
    const sources = Array.isArray(data.sources) ? data.sources : [];
    $('#wsSources').innerHTML = sources.map((source, index) => { const item = analysis.get(index + 1); return `<div class="ws-source-card"><i class="fa-solid ${item?.mentions_brand ? 'fa-circle-check ws-source-mentioned' : 'fa-circle-minus ws-source-not-mentioned'}"></i><a class="ws-source-link" href="${escapeHtml(safeUrl(source.url))}" target="_blank" rel="noopener">${escapeHtml(source.title || source.url)}</a><span class="ws-source-auth">${escapeHtml(source.authority_label || '')}</span></div>`; }).join(''); $('#wsSourcesWrap').hidden = !sources.length;
    result.hidden = false;
}
function setTextBlock(wrapSelector, contentSelector, value) { $(contentSelector).textContent = value || ''; $(wrapSelector).hidden = !value; }
function saveCheck(data, brand, query, provider) {
    const sources = (data.sources || []).map(source => ({ title: source.title, url: source.url }));
    const cited = sources.some(source => `${source.title || ''} ${source.url || ''}`.toLowerCase().includes(brand.toLowerCase()));
    const sentiments = (data.source_analysis || []).filter(item => item.mentions_brand).map(item => item.sentiment).filter(Boolean);
    const normalizedBrand = normalizeBrandName(brand);
    history.push({ id: crypto.randomUUID(), createdAt: Date.now(), brand: normalizedBrand, brandKey: brandKey(normalizedBrand), query, provider: data.provider || provider, model: data.model || PROVIDERS[provider], mentioned: Boolean(data.mentioned), position: Number(data.weighted_position || data.position) || null, role: data.role || '', competitors: (data.mentioned_brands || []).filter(name => name && brandKey(name) !== brandKey(normalizedBrand)), sources, cited, sentiments, reasoning: data.reasoning || '', quotes: data.quotes || [] });
    history = history.slice(-100);
    saveHistory();
    setActiveBrand(normalizedBrand, false, false);
}
function renderHistory() {
    const rows = activeHistory();
    $('#historyCount').textContent = `${rows.length} ${rows.length === 1 ? 'проверка' : 'проверок'}`;
    $('#historyList').innerHTML = rows.length ? rows.slice().reverse().slice(0, 10).map(item => `<div class="app-history-row"><div><strong>${escapeHtml(item.query)}</strong><span>${escapeHtml(item.brand)} · ${escapeHtml(PROVIDERS[item.provider] || item.provider)} · ${item.mentioned ? 'бренд упомянут' : 'бренд не упомянут'}</span></div><span>${new Date(item.createdAt).toLocaleDateString('ru-RU')}</span></div>`).join('') : '<div class="app-empty"><strong>Пока нет проверок</strong><span>Запустите первую проверку выше.</span></div>';
}

function recommendations() {
    const groups = new Map();
    activeHistory().filter(item => item.brand && item.query).forEach(item => { const key = `${brandKey(item.brand)}|${item.query.toLowerCase()}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); });
    return [...groups.values()].map(items => {
        const latest = items.at(-1); const missed = items.filter(item => !item.mentioned); const competitors = [...new Set(missed.flatMap(item => item.competitors))]; const count = missed.length;
        const weak = items.filter(item => item.mentioned && item.competitors.length && !item.role.toLowerCase().includes('рекомендац'));
        if (!count && !weak.length) return null;
        if (!count) {
            const priority = weak.length >= 3 ? 'high' : weak.length === 2 ? 'med' : 'low';
            return { id: `${latest.brand}|${latest.query}|weak`, brand: latest.brand, query: latest.query, provider: latest.provider, competitors: [...new Set(weak.flatMap(item => item.competitors))], count: weak.length, priority, title: `${latest.brand} упоминается, но не рекомендован`, description: `В ${weak.length} ${weak.length === 1 ? 'проверке' : 'проверках'} AI называет бренд вместе с конкурентами, но не в роли рекомендации.` };
        }
        const priority = count >= 3 ? 'high' : count === 2 ? 'med' : 'low';
        const recurring = count >= 2;
        return { id: `${latest.brand}|${latest.query}`, brand: latest.brand, query: latest.query, provider: latest.provider, competitors, count, priority, title: recurring ? `Конкуренты регулярно вытесняют ${latest.brand}` : `${latest.brand} отсутствует в важном промпте`, description: competitors.length ? `В ${count} ${count === 1 ? 'проверке' : 'проверках'} по промпту «${latest.query}» AI упомянул ${competitors.slice(0, 3).join(', ')}, но не ${latest.brand}.` : `В ${count} ${count === 1 ? 'проверке' : 'проверках'} бренд не был упомянут.` };
    }).filter(Boolean).sort((a, b) => b.count - a.count);
}
function renderGrowth() {
    const rows = recommendations(); const dismissed = new Set(loadJson('vidno-growth-dismissed')); const visible = rows.filter(item => !dismissed.has(item.id));
    $('#growthRecommendations').innerHTML = visible.length ? visible.map(item => `<article class="growth-card"><div><span class="growth-priority ${item.priority}">${item.priority === 'high' ? 'Высокий' : item.priority === 'med' ? 'Средний' : 'Низкий'} приоритет</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p></div><div><button class="btn btn-primary btn-sm" data-brief="${encodeURIComponent(item.id)}">Открыть бриф</button><button class="btn btn-ghost btn-sm" data-dismiss="${encodeURIComponent(item.id)}">Неактуально</button></div></article>`).join('') : '<div class="app-empty"><i class="fa-solid fa-seedling"></i><strong>Пока нет подтверждённых возможностей</strong><span>Выполните проверки по важным промптам, чтобы Vidno нашёл разрывы.</span></div>';
    $('#growthBriefs').innerHTML = renderBriefRows();
    $$('[data-brief]').forEach(button => button.addEventListener('click', () => openBrief(decodeURIComponent(button.dataset.brief))));
    $$('[data-dismiss]').forEach(button => button.addEventListener('click', () => { dismissed.add(decodeURIComponent(button.dataset.dismiss)); localStorage.setItem('vidno-growth-dismissed', JSON.stringify([...dismissed])); renderGrowth(); }));
}
function briefBrandKey(brief) { return brandKey(brief.brand || String(brief.id || '').split('|')[0]); }
function renderBriefRows() { const briefs = loadJson(BRIEFS_KEY).filter(brief => briefBrandKey(brief) === activeBrandKey); return briefs.length ? briefs.slice().reverse().map(brief => `<article class="growth-card"><div><span class="growth-priority">Сохранённый бриф</span><h3>${escapeHtml(brief.title)}</h3><p>${escapeHtml(brief.action)}</p></div><button class="btn btn-ghost btn-sm" data-open-saved="${escapeHtml(brief.id)}">Открыть</button></article>`).join('') : '<div class="app-empty"><strong>Нет сохранённых брифов</strong><span>Откройте рекомендацию и сохраните готовый бриф.</span></div>'; }
async function openBrief(id) { activeRecommendation = recommendations().find(item => item.id === id); if (!activeRecommendation) return; const item = activeRecommendation; $('#briefContent').innerHTML = '<p class="app-eyebrow">Проверяемый бриф</p><h2>Готовим бриф…</h2><p>Нейросеть использует только подтверждённые результаты проверок.</p>'; $('#briefDialog').showModal(); try { const response = await fetch(`${API_BASE}/brief`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand: item.brand, query: item.query, provider: item.provider, competitors: item.competitors, checks_count: item.count, evidence: item.description }) }); const brief = await response.json(); if (!response.ok) throw new Error(brief.detail || 'Не удалось создать бриф'); item.brief = brief; $('#briefContent').innerHTML = `<p class="app-eyebrow">Проверяемый бриф</p><h2>${escapeHtml(brief.title || item.title)}</h2><h3>Цель</h3><p>${escapeHtml(brief.goal)}</p><h3>Что сделать</h3><p>${escapeHtml(brief.action)}</p><h3>Как проверить эффект</h3><p>${escapeHtml(brief.verification)}</p><button class="btn btn-primary" id="saveBrief">Сохранить бриф</button>`; $('#saveBrief').addEventListener('click', saveBrief); } catch (error) { $('#briefContent').innerHTML = `<p class="app-eyebrow">Проверяемый бриф</p><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.description)}</p><p>Не удалось обратиться к нейросети: ${escapeHtml(error.message)}</p>`; } }
function saveBrief() { if (!activeRecommendation?.brief) return; const briefs = loadJson(BRIEFS_KEY); if (!briefs.some(item => item.id === activeRecommendation.id)) briefs.push({ id: activeRecommendation.id, brand: activeRecommendation.brand, ...activeRecommendation.brief, createdAt: Date.now() }); localStorage.setItem(BRIEFS_KEY, JSON.stringify(briefs)); $('#briefDialog').close(); renderGrowth(); }
$('#briefClose').addEventListener('click', () => $('#briefDialog').close());
$$('[data-growth-tab]').forEach(button => button.addEventListener('click', () => { $$('[data-growth-tab]').forEach(tab => tab.classList.toggle('active', tab === button)); $('#growthRecommendations').hidden = button.dataset.growthTab !== 'recommendations'; $('#growthBriefs').hidden = button.dataset.growthTab !== 'briefs'; }));
function renderCompetitors() { const counts = new Map(); activeHistory().flatMap(item => item.competitors || []).forEach(name => counts.set(name, (counts.get(name) || 0) + 1)); $('#competitorList').innerHTML = counts.size ? [...counts].sort((a,b) => b[1]-a[1]).map(([name,count]) => `<div class="app-data-row"><strong>${escapeHtml(name)}</strong><span>${count} упоминаний в проверках</span></div>`).join('') : '<div class="app-empty"><strong>Нет данных о конкурентах</strong><span>Они появятся в результатах live-проверок.</span></div>'; }
function sourceCategory(domain) { if (/(forbes|rbc|tass|ria|vedomosti|kommersant|lenta|gazeta|news|media)/.test(domain)) return 'СМИ'; if (/(vc\.ru|habr|reddit|forum|otzovik|irecommend)/.test(domain)) return 'Сообщество и отзывы'; if (/(wiki|catalog|yell|2gis|zoon)/.test(domain)) return 'Каталог и справочник'; return 'Профильный сайт'; }
function renderSources() { const counts = new Map(); activeHistory().flatMap(item => item.sources || []).forEach(source => { try { const value = typeof source === 'string' ? source : source.url; const host = new URL(value).hostname.replace(/^www\./, ''); counts.set(host, (counts.get(host) || 0) + 1); } catch {} }); $('#sourceList').innerHTML = counts.size ? [...counts].sort((a,b) => b[1]-a[1]).map(([name,count]) => `<div class="app-data-row"><strong>${escapeHtml(name)}</strong><span>${count} цитирований · ${sourceCategory(name)}</span></div>`).join('') : '<div class="app-empty"><strong>Нет источников</strong><span>Они появятся после первой live-проверки.</span></div>'; }
const dashboardCharts = {};
function destroyChart(key) { if (dashboardCharts[key]) dashboardCharts[key].destroy(); }
function percentage(value, total) { return total ? Math.round(value / total * 100) : 0; }
function brandRows() {
    const rowsHistory = activeHistory();
    const ownName = currentBrand(); const rows = new Map([[activeBrandKey, { name: ownName, mentions: 0, positions: [], citations: 0, sentiments: [] }]]);
    rowsHistory.forEach(item => { const key = brandKey(item.brand); const own = rows.get(key) || rows.get(activeBrandKey); if (item.mentioned) own.mentions++; if (item.position) own.positions.push(item.position); if (item.cited) own.citations++; own.sentiments.push(...(item.sentiments || [])); (item.competitors || []).forEach(name => { const competitorKey = brandKey(name); if (!rows.has(competitorKey)) rows.set(competitorKey, { name, mentions: 0, positions: [], citations: 0, sentiments: [] }); rows.get(competitorKey).mentions++; }); });
    const totalMentions = [...rows.values()].reduce((sum, row) => sum + row.mentions, 0);
    return [...rows.values()].map(row => ({ ...row, sov: percentage(row.mentions, totalMentions), visibility: percentage(row.mentions, rowsHistory.length), citationRate: percentage(row.citations, rowsHistory.length), averagePosition: row.positions.length ? row.positions.reduce((sum, value) => sum + value, 0) / row.positions.length : null })).sort((a, b) => b.mentions - a.mentions);
}
function dominantSentiment(values) { const counts = values.reduce((result, value) => ({ ...result, [value]: (result[value] || 0) + 1 }), {}); return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'Нет данных'; }
function renderMetricsDashboard() {
    const rowsHistory = activeHistory();
    const own = brandRows().find(row => brandKey(row.name) === activeBrandKey) || brandRows()[0] || { sov: 0, visibility: 0, citationRate: 0, averagePosition: null };
    $('#metricSov').textContent = `${own.sov}%`; $('#metricSovNote').textContent = rowsHistory.length ? `${own.mentions || 0} упоминаний среди брендов` : 'Нет проверок';
    $('#metricVisibility').textContent = `${own.visibility}%`; $('#metricVisibilityNote').textContent = rowsHistory.length ? `в ${own.mentions || 0} из ${rowsHistory.length} ответов` : 'Нет проверок';
    $('#metricCitation').textContent = `${own.citationRate}%`; $('#metricCitationNote').textContent = rowsHistory.length ? `${own.citations || 0} ответов со ссылкой` : 'Нет проверок';
    $('#metricPosition').textContent = own.averagePosition ? own.averagePosition.toFixed(1) : '—'; $('#metricPositionNote').textContent = own.averagePosition ? 'в списочных рекомендациях' : 'Нет позиций';
    renderLeaderBoard(); renderModelMetrics(); renderExclusivity(); renderDashboardCharts();
}
function renderLeaderBoard() { $('#leaderboardBody').innerHTML = brandRows().length ? brandRows().map(row => `<tr class="${brandKey(row.name) === activeBrandKey ? 'is-current' : ''}"><td><strong>${escapeHtml(row.name)}</strong></td><td>${row.sov}%</td><td>${row.visibility}%</td><td>${row.mentions}</td><td>${row.averagePosition ? row.averagePosition.toFixed(1) : '—'}</td><td>${row.citationRate}%</td><td>${escapeHtml(dominantSentiment(row.sentiments))}</td></tr>`).join('') : '<tr><td colspan="7" class="ws-empty-row">Данные появятся после первой проверки</td></tr>'; }
function modelGroups() { const groups = new Map(); activeHistory().forEach(item => { const name = PROVIDERS[item.provider] || item.model || item.provider; if (!groups.has(name)) groups.set(name, { total: 0, mentioned: 0 }); const row = groups.get(name); row.total++; if (item.mentioned) row.mentioned++; }); return groups; }
function renderModelMetrics() { const groups = modelGroups(); $('#modelMetrics').innerHTML = groups.size ? [...groups].map(([name, row]) => `<div class="app-data-row"><strong>${escapeHtml(name)}</strong><span>${percentage(row.mentioned, row.total)}% · ${row.mentioned} из ${row.total}</span></div>`).join('') : '<div class="app-empty"><strong>Нет данных по моделям</strong></div>'; }
function renderExclusivity() { const mentioned = activeHistory().filter(item => item.mentioned); const exclusive = mentioned.filter(item => !(item.competitors || []).length).length; const compared = mentioned.length - exclusive; $('#exclusivityMetrics').innerHTML = `<div class="app-data-row"><strong>Эксклюзивное упоминание</strong><span>${percentage(exclusive, mentioned.length)}% · ${exclusive} ответов</span></div><div class="app-data-row"><strong>В сравнении с конкурентами</strong><span>${percentage(compared, mentioned.length)}% · ${compared} ответов</span></div>`; }
function renderDashboardCharts() { if (!window.Chart) return; const rowsHistory = activeHistory(); const style = getComputedStyle(document.documentElement); const accent = style.getPropertyValue('--accent').trim(); const colors = [accent, style.getPropertyValue('--accent-2').trim(), style.getPropertyValue('--surface-1').trim(), style.getPropertyValue('--neutral').trim()]; const rows = brandRows().slice(0, 5); destroyChart('trend'); destroyChart('sov'); destroyChart('visibility'); dashboardCharts.trend = new Chart($('#overviewChart'), { type: 'line', data: { labels: rowsHistory.map((_, index) => index + 1), datasets: rows.map((row, index) => ({ label: row.name, data: rowsHistory.map((item, itemIndex) => { const relevant = rowsHistory.slice(0, itemIndex + 1); return brandKey(row.name) === activeBrandKey ? percentage(relevant.filter(value => value.mentioned).length, relevant.length) : percentage(relevant.filter(value => value.competitors?.some(name => brandKey(name) === brandKey(row.name))).length, relevant.length); }), borderColor: colors[index % colors.length], tension: .35, fill: false })) }, options: { plugins: { legend: { position: 'bottom' } }, scales: { y: { min: 0, max: 100 } } } }); dashboardCharts.sov = new Chart($('#sovChart'), { type: 'doughnut', data: { labels: rows.map(row => row.name), datasets: [{ data: rows.map(row => row.mentions), backgroundColor: colors, borderWidth: 0 }] }, options: { plugins: { legend: { position: 'right' } } } }); const models = [...modelGroups()]; dashboardCharts.visibility = new Chart($('#visibilityChart'), { type: 'bar', data: { labels: models.map(([name]) => name), datasets: [{ data: models.map(([, row]) => percentage(row.mentioned, row.total)), backgroundColor: accent }] }, options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100 } } } }); }
renderBrandSelector();
$('#wsBrand').value = currentBrand();
renderAllForActiveBrand();
