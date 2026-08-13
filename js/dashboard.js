const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const API_BASE = location.protocol === 'file:' ? 'http://localhost:8000/api' : '/api';
const PROVIDERS = { gigachat: 'GigaChat', deepseek: 'DeepSeek' };
const HISTORY_KEY = 'vidno-dashboard-check-history';
const LEGACY_HISTORY_KEY = 'vidno-workspace-history';
const BRIEFS_KEY = 'vidno-growth-briefs';
const TASKS_KEY = 'vidno-growth-tasks';
const DISMISSED_KEY = 'vidno-growth-dismissed';
const TASKS_MIGRATION_KEY = 'vidno-growth-tasks-migrated-v1';
const ACTIVE_BRAND_KEY = 'vidno-dashboard-active-brand';
let history = loadHistory();
let growthTasks = loadJson(TASKS_KEY);
let activeBrandKey = loadActiveBrandKey();
let activeRecommendation = null;
let activeGrowthTaskId = null;

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
$$('[data-empty-chart-action]').forEach(button => button.addEventListener('click', () => selectView('prompts')));

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
    const saved = { id: crypto.randomUUID(), createdAt: Date.now(), brand: normalizedBrand, brandKey: brandKey(normalizedBrand), query, provider: data.provider || provider, model: data.model || PROVIDERS[provider], mentioned: Boolean(data.mentioned), position: Number(data.weighted_position || data.position) || null, role: data.role || '', competitors: (data.mentioned_brands || []).filter(name => name && brandKey(name) !== brandKey(normalizedBrand)), sources, cited, sentiments, reasoning: data.reasoning || '', quotes: data.quotes || [] };
    history.push(saved);
    history = history.slice(-100);
    saveHistory();
    setActiveBrand(normalizedBrand, false, false);
    return saved;
}
function renderHistory() {
    const rows = activeHistory();
    $('#historyCount').textContent = `${rows.length} ${rows.length === 1 ? 'проверка' : 'проверок'}`;
    $('#historyList').innerHTML = rows.length ? rows.slice().reverse().slice(0, 10).map(item => `<div class="app-history-row"><div><strong>${escapeHtml(item.query)}</strong><span>${escapeHtml(item.brand)} · ${escapeHtml(PROVIDERS[item.provider] || item.provider)} · ${item.mentioned ? 'бренд упомянут' : 'бренд не упомянут'}</span></div><span>${new Date(item.createdAt).toLocaleDateString('ru-RU')}</span></div>`).join('') : '<div class="app-empty"><strong>Пока нет проверок</strong><span>Запустите первую проверку выше.</span></div>';
}

function normalizeQuery(value) { return String(value || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU'); }
function isRecommendationRole(value) { return String(value || '').toLocaleLowerCase('ru-RU').includes('рекомендац'); }
function opportunityKey(item, type) { return `${brandKey(item.brand)}|${item.provider}|${normalizeQuery(item.query)}|${type}`; }
function opportunityAction(type, brand) { return type === 'brand_missing' ? `Создать или усилить материал, который прямо отвечает на этот запрос и объясняет ценность ${brand}.` : `Усилить позиционирование ${brand}: добавить доказательства, сравнение и причины рекомендовать бренд.`; }
function recommendations() {
    const groups = new Map();
    activeHistory().filter(item => item.brand && item.query && item.provider).forEach(item => {
        const key = `${brandKey(item.brand)}|${item.provider}|${normalizeQuery(item.query)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    });
    return [...groups.values()].flatMap(items => {
        const missing = items.filter(item => !item.mentioned);
        const weak = items.filter(item => item.mentioned && (item.competitors || []).length && !isRecommendationRole(item.role));
        return [{ type: 'brand_missing', rows: missing }, { type: 'weak_role', rows: weak }].filter(group => group.rows.length >= 2).map(group => {
            const latest = group.rows.at(-1); const type = group.type; const evidenceRows = group.rows; const count = evidenceRows.length;
            const competitors = [...new Set(evidenceRows.flatMap(item => item.competitors || []))];
            const id = opportunityKey(latest, type);
            return {
                id, type, brand: latest.brand, query: latest.query, provider: latest.provider, model: latest.model,
                count, competitors, priority: count >= 3 ? 'high' : 'med', evidenceRows,
                title: type === 'brand_missing' ? `${latest.brand} системно отсутствует в запросе` : `${latest.brand} упоминается, но не рекомендуется`,
                description: type === 'brand_missing' ? `Проблема подтверждена в ${count} проверках ${PROVIDERS[latest.provider] || latest.provider}.` : `В ${count} проверках бренд назван рядом с конкурентами, но не в роли рекомендации.`,
                suggestedAction: opportunityAction(type, latest.brand)
            };
        });
    }).filter(Boolean).sort((a, b) => b.count - a.count);
}
function saveGrowthTasks() { localStorage.setItem(TASKS_KEY, JSON.stringify(growthTasks)); }
function migrateLegacyBriefs() {
    if (localStorage.getItem(TASKS_MIGRATION_KEY)) return;
    const existingLegacyIds = new Set(growthTasks.map(task => task.legacyBriefId).filter(Boolean));
    loadJson(BRIEFS_KEY).forEach(brief => {
        if (existingLegacyIds.has(brief.id)) return;
        const legacyParts = String(brief.id || '').split('|');
        const inferredBrand = brief.brand || legacyParts[0] || 'Vidno';
        const inferredQuery = brief.query || legacyParts.slice(1).filter(part => part !== 'weak').join('|');
        const related = history.filter(item => brandKey(item.brand) === brandKey(inferredBrand) && normalizeQuery(item.query) === normalizeQuery(inferredQuery));
        const baselineRow = related.at(-1) || null;
        const migratedOpportunity = recommendations().find(item => brandKey(item.brand) === brandKey(inferredBrand) && normalizeQuery(item.query) === normalizeQuery(inferredQuery) && item.provider === (brief.provider || baselineRow?.provider || 'gigachat'));
        growthTasks.push({
            version: 1, id: crypto.randomUUID(), legacyBriefId: brief.id, opportunityId: migratedOpportunity?.id || brief.id,
            brand: inferredBrand, brandKey: brandKey(inferredBrand),
            query: inferredQuery || baselineRow?.query || '', provider: brief.provider || baselineRow?.provider || 'gigachat', model: baselineRow?.model || PROVIDERS[brief.provider] || '',
            problemType: 'legacy', workType: 'content', title: brief.title || 'Задача из сохранённого брифа', goal: brief.goal || '', action: brief.action || '', verification: brief.verification || '',
            owner: '', deadline: '', targetUrl: '', notes: '', status: 'planned', createdAt: brief.createdAt || Date.now(), updatedAt: Date.now(),
            baseline: baselineRow ? snapshotCheck(baselineRow) : null, evidence: { count: related.length, competitors: baselineRow?.competitors || [], reasoning: baselineRow?.reasoning || '', quotes: baselineRow?.quotes || [] }, postCheck: null, verdict: null
        });
    });
    saveGrowthTasks();
    localStorage.setItem(TASKS_MIGRATION_KEY, '1');
}
function snapshotCheck(item) { return item ? { id: item.id || null, createdAt: item.createdAt || Date.now(), mentioned: Boolean(item.mentioned), position: Number(item.position) || null, role: item.role || '', competitors: item.competitors || [], reasoning: item.reasoning || '', quotes: item.quotes || [] } : null; }
function growthTaskForBrand(task) { return brandKey(task.brand) === activeBrandKey; }
function statusLabel(status) { return ({ planned: 'Запланировано', in_progress: 'В работе', ready_for_check: 'Готово к проверке', measured: 'Измерено' })[status] || status; }
function workTypeLabel(type) { return ({ content: 'Контент', seo: 'SEO', pr: 'PR', technical: 'Техническая' })[type] || type; }
function emptyGrowth(icon, title, text, action = '') { return `<div class="app-empty"><i class="fa-solid ${icon}"></i><strong>${title}</strong><span>${text}</span>${action}</div>`; }
function renderGrowth() {
    migrateLegacyBriefs();
    const dismissed = new Set(loadJson(DISMISSED_KEY));
    const accepted = new Set(growthTasks.map(task => task.opportunityId));
    const opportunities = recommendations().filter(item => !dismissed.has(item.id) && !accepted.has(item.id));
    const tasks = growthTasks.filter(task => growthTaskForBrand(task) && task.status !== 'measured');
    const results = growthTasks.filter(task => growthTaskForBrand(task) && task.status === 'measured');
    $('#opportunityCount').textContent = opportunities.length; $('#taskCount').textContent = tasks.length; $('#resultCount').textContent = results.length;
    $('#growthOpportunities').innerHTML = opportunities.length ? opportunities.map(renderOpportunityCard).join('') : emptyGrowth('fa-seedling', 'Пока нет подтверждённых возможностей', 'Для рекомендации нужны две проверки одного промпта в одной модели.', '<button class="btn btn-primary btn-sm" data-growth-view="prompts">Запустить проверку</button>');
    $('#growthTasks').innerHTML = tasks.length ? tasks.sort((a, b) => b.updatedAt - a.updatedAt).map(renderTaskCard).join('') : emptyGrowth('fa-list-check', 'Нет задач в работе', 'Примите подтверждённую возможность, чтобы создать первую задачу.');
    $('#growthResults').innerHTML = results.length ? results.sort((a, b) => b.updatedAt - a.updatedAt).map(renderResultCard).join('') : emptyGrowth('fa-chart-line', 'Пока нет измеренных результатов', 'Завершите задачу и выполните свежую проверку эффекта.');
    bindGrowthActions();
}
function renderOpportunityCard(item) {
    const competitors = item.competitors.length ? item.competitors.slice(0, 4).join(', ') : 'не обнаружены';
    const latest = item.evidenceRows.at(-1);
    return `<article class="growth-card growth-opportunity"><div class="growth-card-main"><div class="growth-card-badges"><span class="growth-priority ${item.priority}">${item.priority === 'high' ? 'Высокий' : 'Средний'} приоритет</span><span class="growth-tag">${escapeHtml(PROVIDERS[item.provider] || item.provider)}</span><span class="growth-tag">${item.count} подтверждения</span></div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p><div class="growth-evidence"><strong>Промпт</strong><span>${escapeHtml(item.query)}</span><strong>Конкуренты</strong><span>${escapeHtml(competitors)}</span><strong>Последнее доказательство</strong><span>${escapeHtml(latest.reasoning || (latest.mentioned ? 'Бренд упомянут без рекомендации.' : 'Бренд не найден в результате.'))}</span></div><div class="growth-suggestion"><strong>Что предлагает Vidno</strong><span>${escapeHtml(item.suggestedAction)}</span></div></div><div class="growth-card-actions"><button class="btn btn-primary btn-sm" data-create-task="${encodeURIComponent(item.id)}">Создать задачу</button><button class="btn btn-ghost btn-sm" data-dismiss="${encodeURIComponent(item.id)}">Неактуально</button></div></article>`;
}
function renderTaskCard(task) {
    return `<article class="growth-card"><div class="growth-card-main"><div class="growth-card-badges"><span class="growth-status status-${task.status}">${statusLabel(task.status)}</span><span class="growth-tag">${workTypeLabel(task.workType)}</span><span class="growth-tag">${escapeHtml(PROVIDERS[task.provider] || task.provider)}</span></div><h3>${escapeHtml(task.title)}</h3><p>${escapeHtml(task.action)}</p><div class="growth-task-meta"><span><i class="fa-regular fa-user"></i>${escapeHtml(task.owner || 'Не назначен')}</span><span><i class="fa-regular fa-calendar"></i>${task.deadline ? new Date(`${task.deadline}T00:00:00`).toLocaleDateString('ru-RU') : 'Без срока'}</span></div></div><div class="growth-card-actions"><button class="btn btn-ghost btn-sm" data-edit-task="${task.id}">Открыть</button>${task.status === 'ready_for_check' ? `<button class="btn btn-primary btn-sm" data-measure-task="${task.id}">Проверить эффект</button>` : ''}</div></article>`;
}
function checkSummary(item) { if (!item) return 'Нет данных'; if (!item.mentioned) return 'Бренд не упомянут'; return `${isRecommendationRole(item.role) ? 'Рекомендация' : 'Бренд упомянут'}${item.position ? ` · позиция №${item.position}` : ''}`; }
function renderResultCard(task) {
    const tone = task.verdict === 'improved' ? 'positive' : task.verdict === 'declined' ? 'negative' : 'neutral';
    const label = task.verdict === 'improved' ? 'Предварительно улучшилось' : task.verdict === 'declined' ? 'Предварительно ухудшилось' : 'Без изменений';
    return `<article class="growth-card growth-result"><div class="growth-card-main"><div class="growth-card-badges"><span class="growth-verdict ${tone}">${label}</span><span class="growth-tag">${escapeHtml(PROVIDERS[task.provider] || task.provider)}</span></div><h3>${escapeHtml(task.title)}</h3><div class="growth-before-after"><div><span>До</span><strong>${escapeHtml(checkSummary(task.baseline))}</strong><small>${task.baseline?.createdAt ? new Date(task.baseline.createdAt).toLocaleDateString('ru-RU') : 'Дата неизвестна'}</small></div><i class="fa-solid fa-arrow-right"></i><div><span>После</span><strong>${escapeHtml(checkSummary(task.postCheck))}</strong><small>${new Date(task.postCheck.createdAt).toLocaleDateString('ru-RU')}</small></div></div><p class="growth-disclaimer">Один контрольный запуск показывает предварительную динамику и не доказывает причинность.</p></div><div class="growth-card-actions"><button class="btn btn-ghost btn-sm" data-edit-task="${task.id}">Открыть</button></div></article>`;
}
function bindGrowthActions() {
    $$('[data-create-task]').forEach(button => button.addEventListener('click', () => openOpportunity(decodeURIComponent(button.dataset.createTask))));
    $$('[data-dismiss]').forEach(button => button.addEventListener('click', () => { const rows = new Set(loadJson(DISMISSED_KEY)); rows.add(decodeURIComponent(button.dataset.dismiss)); localStorage.setItem(DISMISSED_KEY, JSON.stringify([...rows])); renderGrowth(); }));
    $$('[data-edit-task]').forEach(button => button.addEventListener('click', () => openTask(button.dataset.editTask)));
    $$('[data-measure-task]').forEach(button => button.addEventListener('click', () => measureTask(button.dataset.measureTask, button)));
    $$('[data-growth-view="prompts"]').forEach(button => button.addEventListener('click', () => selectView('prompts')));
}
async function openOpportunity(id) {
    activeRecommendation = recommendations().find(item => item.id === id);
    activeGrowthTaskId = null;
    if (!activeRecommendation) return;
    const opportunityId = activeRecommendation.id;
    renderTaskDialog(activeRecommendation, null, true);
    $('#briefDialog').showModal();
    try {
        const item = activeRecommendation;
        const evidence = `${item.description} Промпт: «${item.query}». Конкуренты: ${item.competitors.join(', ') || 'не обнаружены'}. Последние выводы: ${item.evidenceRows.slice(-2).map(row => row.reasoning).filter(Boolean).join(' | ')}`;
        const response = await fetch(`${API_BASE}/brief`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand: item.brand, query: item.query, provider: item.provider, competitors: item.competitors, checks_count: item.count, evidence }) });
        const brief = await response.json();
        if (!response.ok) throw new Error(brief.detail || 'Не удалось создать бриф');
        if (!$('#briefDialog').open || activeRecommendation?.id !== opportunityId || !$('#growthTitle')) return;
        $('#growthTitle').value = brief.title || item.title; $('#growthGoal').value = brief.goal || ''; $('#growthAction').value = brief.action || item.suggestedAction; $('#growthVerification').value = brief.verification || `Повторить тот же промпт в ${PROVIDERS[item.provider] || item.provider}.`;
        const status = $('#growthBriefStatus');
        status.textContent = 'AI-бриф готов — проверьте и отредактируйте его.'; status.className = 'growth-form-status success';
    } catch (error) {
        const status = $('#briefDialog').open && activeRecommendation?.id === opportunityId ? $('#growthBriefStatus') : null;
        if (status) { status.textContent = `AI-бриф недоступен: ${error.message}. Можно создать задачу с локальным советом.`; status.className = 'growth-form-status error'; }
    }
}
function renderTaskDialog(opportunity, task, creating) {
    const source = task || opportunity;
    const evidence = task?.evidence || { count: opportunity.count, competitors: opportunity.competitors, reasoning: opportunity.evidenceRows.at(-1)?.reasoning || '', quotes: opportunity.evidenceRows.flatMap(row => row.quotes || []).slice(-3) };
    $('#briefContent').innerHTML = `<p class="app-eyebrow">${creating ? 'Новая задача' : task.status === 'measured' ? 'Измеренный результат' : 'Задача роста'}</p><h2>${creating ? 'Превратить возможность в работу' : escapeHtml(task.title)}</h2><div class="growth-dialog-evidence"><strong>Почему появилась задача</strong><p>${escapeHtml(opportunity?.description || `${evidence.count || 0} подтверждённых проверок`)}</p><dl><div><dt>Промпт</dt><dd>${escapeHtml(source.query || 'Нет связанного промпта')}</dd></div><div><dt>Модель</dt><dd>${escapeHtml(PROVIDERS[source.provider] || source.model || source.provider || 'Не указана')}</dd></div><div><dt>Конкуренты</dt><dd>${escapeHtml((evidence.competitors || []).join(', ') || 'Не обнаружены')}</dd></div></dl>${evidence.reasoning ? `<blockquote>${escapeHtml(evidence.reasoning)}</blockquote>` : ''}</div><form id="growthTaskForm" class="growth-task-form"><label>Название задачи *<input id="growthTitle" required maxlength="200" value="${escapeHtml(task?.title || opportunity?.title || '')}"></label><div class="growth-form-grid"><label>Тип работы<select id="growthWorkType"><option value="content">Контент</option><option value="seo">SEO</option><option value="pr">PR</option><option value="technical">Техническая</option></select></label>${creating ? '' : `<label>Статус<select id="growthStatus"><option value="planned">Запланировано</option><option value="in_progress">В работе</option><option value="ready_for_check">Готово к проверке</option>${task.status === 'measured' ? '<option value="measured">Измерено</option>' : ''}</select></label>`}<label>Ответственный<input id="growthOwner" maxlength="120" value="${escapeHtml(task?.owner || '')}" placeholder="Имя или роль"></label><label>Дедлайн<input id="growthDeadline" type="date" value="${escapeHtml(task?.deadline || '')}"></label></div><label>Цель<textarea id="growthGoal" rows="2" maxlength="2000">${escapeHtml(task?.goal || '')}</textarea></label><label>Что сделать *<textarea id="growthAction" required rows="5" maxlength="6000">${escapeHtml(task?.action || opportunity?.suggestedAction || '')}</textarea></label><label>Как проверить эффект<textarea id="growthVerification" rows="3" maxlength="2000">${escapeHtml(task?.verification || (source.query ? `Повторить тот же промпт в ${PROVIDERS[source.provider] || source.provider}.` : ''))}</textarea></label><div class="growth-form-grid"><label>Целевой URL<input id="growthTargetUrl" type="url" value="${escapeHtml(task?.targetUrl || '')}" placeholder="https://example.com/page"></label><label>Заметки<textarea id="growthNotes" rows="2" maxlength="3000">${escapeHtml(task?.notes || '')}</textarea></label></div><p id="growthBriefStatus" class="growth-form-status">${creating ? 'Готовим AI-бриф на основе доказательств…' : ''}</p><div class="growth-dialog-actions"><button class="btn btn-primary" type="submit">${creating ? 'Создать задачу' : 'Сохранить изменения'}</button>${!creating && task.status === 'ready_for_check' ? '<button class="btn btn-ghost" type="button" id="dialogMeasureTask">Проверить эффект</button>' : ''}${!creating ? '<button class="btn btn-ghost growth-delete" type="button" id="deleteGrowthTask">Удалить задачу</button>' : ''}</div></form>`;
    $('#growthWorkType').value = task?.workType || 'content';
    if (!creating) $('#growthStatus').value = task.status;
    $('#growthTaskForm').addEventListener('submit', event => { event.preventDefault(); creating ? createTaskFromDialog() : updateTaskFromDialog(); });
    $('#deleteGrowthTask')?.addEventListener('click', deleteActiveTask);
    $('#dialogMeasureTask')?.addEventListener('click', event => measureTask(task.id, event.currentTarget));
}
function dialogValues() { return { title: $('#growthTitle').value.trim(), workType: $('#growthWorkType').value, owner: $('#growthOwner').value.trim(), deadline: $('#growthDeadline').value, goal: $('#growthGoal').value.trim(), action: $('#growthAction').value.trim(), verification: $('#growthVerification').value.trim(), targetUrl: $('#growthTargetUrl').value.trim(), notes: $('#growthNotes').value.trim() }; }
function createTaskFromDialog() {
    const form = $('#growthTaskForm'); if (!form.reportValidity() || !activeRecommendation) return;
    const item = activeRecommendation; const latest = item.evidenceRows.at(-1); const now = Date.now();
    growthTasks.push({ version: 1, id: crypto.randomUUID(), opportunityId: item.id, brand: item.brand, brandKey: brandKey(item.brand), query: item.query, provider: item.provider, model: item.model, problemType: item.type, ...dialogValues(), status: 'planned', createdAt: now, updatedAt: now, baseline: snapshotCheck(latest), evidence: { count: item.count, checkIds: item.evidenceRows.map(row => row.id), competitors: item.competitors, reasoning: latest.reasoning || '', quotes: item.evidenceRows.flatMap(row => row.quotes || []).slice(-5) }, postCheck: null, verdict: null });
    saveGrowthTasks(); $('#briefDialog').close(); showGrowthTab('tasks'); renderGrowth();
}
function openTask(id) { const task = growthTasks.find(item => item.id === id); if (!task) return; activeRecommendation = null; activeGrowthTaskId = id; renderTaskDialog(null, task, false); $('#briefDialog').showModal(); }
function updateTaskFromDialog() {
    const form = $('#growthTaskForm'); if (!form.reportValidity()) return;
    const task = growthTasks.find(item => item.id === activeGrowthTaskId); if (!task) return;
    Object.assign(task, dialogValues(), { status: task.status === 'measured' ? 'measured' : $('#growthStatus').value, updatedAt: Date.now() });
    saveGrowthTasks(); $('#briefDialog').close(); renderGrowth();
}
function deleteActiveTask() {
    const task = growthTasks.find(item => item.id === activeGrowthTaskId); if (!task || !confirm(`Удалить задачу «${task.title}» навсегда?`)) return;
    growthTasks = growthTasks.filter(item => item.id !== task.id); saveGrowthTasks(); $('#briefDialog').close(); renderGrowth();
}
function resultLevel(item) { if (!item?.mentioned) return 0; return isRecommendationRole(item.role) ? 2 : 1; }
function compareChecks(before, after) { const beforeLevel = resultLevel(before); const afterLevel = resultLevel(after); if (afterLevel > beforeLevel) return 'improved'; if (afterLevel < beforeLevel) return 'declined'; const beforePosition = Number(before?.position) || null; const afterPosition = Number(after?.position) || null; if (beforePosition && afterPosition && afterPosition < beforePosition) return 'improved'; if (beforePosition && afterPosition && afterPosition > beforePosition) return 'declined'; return 'unchanged'; }
async function measureTask(id, button) {
    const task = growthTasks.find(item => item.id === id); if (!task || task.status !== 'ready_for_check' || !task.query) return;
    const original = button.textContent; button.disabled = true; button.textContent = 'Проверяем…';
    const errorTarget = $('#briefDialog').open ? $('#growthBriefStatus') : null;
    try {
        const response = await fetch(`${API_BASE}/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ brand: task.brand, query: task.query, provider: task.provider, force_refresh: true }) });
        const data = await response.json(); if (!response.ok || data.error) throw new Error(data.error || data.detail || `HTTP ${response.status}`);
        const saved = saveCheck(data, task.brand, task.query, task.provider);
        task.postCheck = snapshotCheck(saved); task.verdict = compareChecks(task.baseline, task.postCheck); task.status = 'measured'; task.updatedAt = Date.now(); saveGrowthTasks();
        if ($('#briefDialog').open) $('#briefDialog').close(); showGrowthTab('results'); renderGrowth();
    } catch (error) {
        if (errorTarget) { errorTarget.textContent = `Проверка не выполнена: ${error.message}`; errorTarget.className = 'growth-form-status error'; }
        else alert(`Проверка не выполнена: ${error.message}`);
    } finally { button.disabled = false; button.textContent = original; }
}
function showGrowthTab(tabName) { $$('[data-growth-tab]').forEach(tab => tab.classList.toggle('active', tab.dataset.growthTab === tabName)); $('#growthOpportunities').hidden = tabName !== 'opportunities'; $('#growthTasks').hidden = tabName !== 'tasks'; $('#growthResults').hidden = tabName !== 'results'; }
$('#briefClose').addEventListener('click', () => $('#briefDialog').close());
$$('[data-growth-tab]').forEach(button => button.addEventListener('click', () => showGrowthTab(button.dataset.growthTab)));
function renderCompetitors() { const counts = new Map(); activeHistory().flatMap(item => item.competitors || []).forEach(name => counts.set(name, (counts.get(name) || 0) + 1)); $('#competitorList').innerHTML = counts.size ? [...counts].sort((a,b) => b[1]-a[1]).map(([name,count]) => `<div class="app-data-row"><strong>${escapeHtml(name)}</strong><span>${count} упоминаний в проверках</span></div>`).join('') : '<div class="app-empty"><strong>Нет данных о конкурентах</strong><span>Они появятся в результатах live-проверок.</span></div>'; }
function sourceCategory(domain) { if (/(forbes|rbc|tass|ria|vedomosti|kommersant|lenta|gazeta|news|media)/.test(domain)) return 'СМИ'; if (/(vc\.ru|habr|reddit|forum|otzovik|irecommend)/.test(domain)) return 'Сообщество и отзывы'; if (/(wiki|catalog|yell|2gis|zoon)/.test(domain)) return 'Каталог и справочник'; return 'Профильный сайт'; }
function renderSources() {
    const counts = new Map();
    activeHistory().flatMap(item => item.sources || []).forEach(source => {
        try {
            const value = typeof source === 'string' ? source : source.url;
            const host = new URL(value).hostname.replace(/^www\./, '');
            counts.set(host, (counts.get(host) || 0) + 1);
        } catch {}
    });
    const rows = [...counts].sort((a, b) => b[1] - a[1]);
    const empty = '<div class="app-empty"><strong>Нет источников</strong><span>Они появятся после первой live-проверки.</span></div>';
    const markup = rows.length ? rows.map(([name, count]) => `<div class="app-data-row"><strong>${escapeHtml(name)}</strong><span>${count} цитирований · ${sourceCategory(name)}</span></div>`).join('') : empty;
    $('#sourceList').innerHTML = markup;
    $('#homeSourceList').innerHTML = rows.length ? rows.slice(0, 5).map(([name, count]) => `<div class="app-data-row"><strong>${escapeHtml(name)}</strong><span>${count} цитирований · ${sourceCategory(name)}</span></div>`).join('') : empty;
}
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
    renderLeaderBoard(); renderModelMetrics(); renderDashboardCharts();
}
function renderLeaderBoard() { $('#leaderboardBody').innerHTML = brandRows().length ? brandRows().map(row => `<tr class="${brandKey(row.name) === activeBrandKey ? 'is-current' : ''}"><td><strong>${escapeHtml(row.name)}</strong></td><td>${row.sov}%</td><td>${row.visibility}%</td><td>${row.mentions}</td><td>${row.averagePosition ? row.averagePosition.toFixed(1) : '—'}</td><td>${row.citationRate}%</td><td>${escapeHtml(dominantSentiment(row.sentiments))}</td></tr>`).join('') : '<tr><td colspan="7" class="ws-empty-row">Данные появятся после первой проверки</td></tr>'; }
function modelGroups() { const groups = new Map(); activeHistory().forEach(item => { const name = PROVIDERS[item.provider] || item.model || item.provider; if (!groups.has(name)) groups.set(name, { total: 0, mentioned: 0 }); const row = groups.get(name); row.total++; if (item.mentioned) row.mentioned++; }); return groups; }
function renderModelMetrics() { const groups = modelGroups(); $('#modelMetrics').innerHTML = groups.size ? [...groups].map(([name, row]) => `<div class="app-data-row"><strong>${escapeHtml(name)}</strong><span>${percentage(row.mentioned, row.total)}% · ${row.mentioned} из ${row.total}</span></div>`).join('') : '<div class="app-empty"><strong>Нет данных по моделям</strong></div>'; }
function renderExclusivity() { const mentioned = activeHistory().filter(item => item.mentioned); const exclusive = mentioned.filter(item => !(item.competitors || []).length).length; const compared = mentioned.length - exclusive; $('#exclusivityMetrics').innerHTML = `<div class="app-data-row"><strong>Эксклюзивное упоминание</strong><span>${percentage(exclusive, mentioned.length)}% · ${exclusive} ответов</span></div><div class="app-data-row"><strong>В сравнении с конкурентами</strong><span>${percentage(compared, mentioned.length)}% · ${compared} ответов</span></div>`; }
function chartTheme() {
    const style = getComputedStyle(document.documentElement);
    return { accent: style.getPropertyValue('--accent').trim(), accent2: style.getPropertyValue('--accent-2').trim(), night: style.getPropertyValue('--night').trim(), text: style.getPropertyValue('--text').trim(), muted: style.getPropertyValue('--text-soft').trim(), border: style.getPropertyValue('--border').trim(), soft: style.getPropertyValue('--bg-soft').trim() };
}
function chartDate(item, index) {
    if (!item.createdAt) return `Проверка ${index + 1}`;
    return new Date(item.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
function lineGradient(chart, color) {
    const { ctx, chartArea } = chart;
    if (!chartArea) return color;
    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, 'transparent');
    return gradient;
}
const centerLabelPlugin = { id: 'centerLabel', afterDraw(chart, args, options) { if (!options?.label) return; const { ctx, chartArea } = chart; const x = (chartArea.left + chartArea.right) / 2; const y = (chartArea.top + chartArea.bottom) / 2; ctx.save(); ctx.textAlign = 'center'; ctx.fillStyle = options.color; ctx.font = '800 26px Inter'; ctx.fillText(options.label, x, y - 2); ctx.fillStyle = options.muted; ctx.font = '600 11px Inter'; ctx.fillText(options.caption, x, y + 17); ctx.restore(); } };
function renderDashboardCharts() {
    if (!window.Chart) return;
    const rowsHistory = activeHistory(); const theme = chartTheme(); const rows = brandRows().slice(0, 5);
    const own = rows.find(row => brandKey(row.name) === activeBrandKey) || rows[0];
    destroyChart('trend'); destroyChart('sov'); destroyChart('visibility');
    const hasHistory = rowsHistory.length > 0;
    [['overviewChart', 'overviewEmpty'], ['sovChart', 'sovEmpty'], ['visibilityChart', 'visibilityEmpty']].forEach(([chartId, emptyId]) => { $(`#${chartId}`).hidden = !hasHistory; $(`#${emptyId}`).hidden = hasHistory; });
    if (!hasHistory) {
        $('#overviewInsight').textContent = 'Начните с проверки';
        $('#sovInsight').textContent = 'Данные появятся здесь';
        $('#visibilityInsight').textContent = 'Нужны проверки';
        return;
    }
    const ownTrend = own ? rowsHistory.map((item, index) => percentage(rowsHistory.slice(0, index + 1).filter(value => value.mentioned).length, index + 1)) : [];
    const trendDelta = ownTrend.length > 1 ? ownTrend.at(-1) - ownTrend[0] : 0;
    $('#overviewInsight').textContent = own ? `${trendDelta >= 0 ? '+' : ''}${trendDelta} п.п. за период` : 'Нужны проверки';
    dashboardCharts.trend = new Chart($('#overviewChart'), {
        type: 'line',
        data: { labels: rowsHistory.map(chartDate), datasets: rows.map(row => {
            const isOwn = brandKey(row.name) === activeBrandKey;
            return { label: row.name, data: rowsHistory.map((item, index) => { const relevant = rowsHistory.slice(0, index + 1); return isOwn ? percentage(relevant.filter(value => value.mentioned).length, relevant.length) : percentage(relevant.filter(value => value.competitors?.some(name => brandKey(name) === brandKey(row.name))).length, relevant.length); }), borderColor: isOwn ? theme.accent : theme.muted, backgroundColor: context => isOwn ? lineGradient(context.chart, theme.accent) : 'transparent', borderWidth: isOwn ? 3 : 1.5, tension: .38, fill: isOwn, pointRadius: context => isOwn && context.dataIndex === rowsHistory.length - 1 ? 5 : 0, pointHoverRadius: 6, pointBackgroundColor: theme.accent };
        }) },
        options: { responsive: true, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 7, color: theme.text, font: { size: 11 } } }, tooltip: { callbacks: { label: context => `${context.dataset.label}: ${context.parsed.y}%` } } }, scales: { x: { grid: { display: false }, ticks: { color: theme.muted, maxTicksLimit: 5, font: { size: 10 } } }, y: { min: 0, max: 100, ticks: { color: theme.muted, callback: value => `${value}%`, font: { size: 10 } }, grid: { color: theme.border } } } }
    });
    const ownRank = own ? rows.findIndex(row => brandKey(row.name) === brandKey(own.name)) + 1 : 0;
    $('#sovInsight').textContent = own ? `#${ownRank} в нише · ${own.sov}% SoV` : 'Нужны проверки';
    dashboardCharts.sov = new Chart($('#sovChart'), {
        type: 'doughnut', data: { labels: rows.map(row => row.name), datasets: [{ data: rows.map(row => row.sov), backgroundColor: rows.map(row => brandKey(row.name) === activeBrandKey ? theme.accent : theme.soft), borderColor: theme.border, borderWidth: 2, hoverOffset: 7 }] },
        options: { cutout: '68%', plugins: { centerLabel: { label: own ? `${own.sov}%` : '—', caption: 'Share of Voice', color: theme.text, muted: theme.muted }, legend: { position: 'right', labels: { usePointStyle: true, boxWidth: 8, color: theme.text, font: { size: 11 }, generateLabels: chart => chart.data.labels.map((label, index) => ({ text: `${label}  ${chart.data.datasets[0].data[index] || 0}%`, fillStyle: chart.data.datasets[0].backgroundColor[index], strokeStyle: 'transparent', index })) } }, tooltip: { callbacks: { label: context => `${context.label}: ${context.parsed}%` } } } }, plugins: [centerLabelPlugin]
    });
    const models = [...modelGroups()].map(([name, row]) => ({ name, value: percentage(row.mentioned, row.total), total: row.total })).sort((a, b) => b.value - a.value);
    const best = models[0];
    $('#visibilityInsight').textContent = best ? `Лидер: ${best.name} · ${best.value}%` : 'Нужны проверки';
    dashboardCharts.visibility = new Chart($('#visibilityChart'), {
        type: 'bar', data: { labels: models.map(model => model.name), datasets: [{ data: models.map(model => model.value), backgroundColor: models.map((model, index) => index === 0 ? theme.accent : theme.accent2), borderRadius: 7, borderSkipped: false, barThickness: 24 }] },
        options: { indexAxis: 'y', responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => `${context.parsed.x}% · ${models[context.dataIndex].total} проверок` } } }, scales: { x: { min: 0, max: 100, ticks: { color: theme.muted, callback: value => `${value}%` }, grid: { color: theme.border } }, y: { ticks: { color: theme.text, font: { weight: '600' } }, grid: { display: false } } } }
    });
}
renderBrandSelector();
$('#wsBrand').value = currentBrand();
renderAllForActiveBrand();
