const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const IS_LOCAL_FRONTEND = location.protocol === 'file:' || (['localhost', '127.0.0.1'].includes(location.hostname) && location.port !== '8000');
const API_BASE = IS_LOCAL_FRONTEND ? 'http://localhost:8000/api' : '/api';
const PROVIDERS = { all: 'Все модели', gigachat: 'GigaChat', yandex: 'Алиса AI', openai: 'ChatGPT', gemini: 'Gemini', perplexity: 'Perplexity' };
const PROVIDER_ICONS = { gigachat: 'assets/ai/gigachat.svg', yandex: 'assets/ai/alice-ai.svg', openai: 'assets/ai/openai.svg', gemini: 'assets/ai/gemini.svg', perplexity: 'assets/ai/perplexity.svg' };
const CHECK_PROVIDERS = ['gigachat', 'yandex', 'openai', 'gemini', 'perplexity'];
const ACTIVE_BRAND_KEY = 'vidno-dashboard-active-brand';
const ANALYSIS_VERSION = 'perplexity-direct-v1';
let history = [];
let brandIdentities = [];
let growthTasks = [];
let dismissedOpportunities = new Set();
let activeBrandKey = '';
let activeRecommendation = null;
let activeGrowthTaskId = null;
let competitorExpanded = false;
let sourceExpanded = false;
let selectedProviders = new Set(CHECK_PROVIDERS);
let accountState = null;
let accessState = null;
let adminPage = 1;
let adminTotalPages = 1;
let selectedAdminClientId = null;

class ApiError extends Error {
    constructor(message, status, code = '', details = {}) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.details = details; }
}

function capability(name, fallback = false) { return accessState ? Boolean(accessState.capabilities?.[name]) : fallback; }
function requiredCapability(path, method) {
    if (method === 'GET' || method === 'HEAD') return '';
    if (/^\/(?:account|admin\/|auth\/)/.test(path)) return '';
    if (/^\/check(?:-all)?$/.test(path)) return 'run_checks';
    if (path === '/brands' && method === 'POST') return 'create_brands';
    if (/^\/brands\//.test(path)) return 'manage_existing_brands';
    return 'workspace_write';
}
function accessBlockedMessage(name) {
    if (accessState?.status === 'pending') return 'Доступ ещё не активирован. Вы можете просматривать сохранённые данные.';
    if (accessState?.status === 'expired') return 'Срок доступа истёк. Сохранённые данные доступны только для просмотра.';
    if (accessState?.status === 'suspended') return 'Доступ приостановлен. Сохранённые данные доступны только для просмотра.';
    if (name === 'run_checks') return 'Лимит проверок исчерпан. Подробности доступны в разделе «Аккаунт».';
    if (name === 'create_brands') return 'Лимит брендов исчерпан. Существующие бренды остаются доступны.';
    return 'Это действие недоступно для текущего уровня доступа.';
}
function requireCapability(name) {
    if (capability(name)) return true;
    const message = accessBlockedMessage(name);
    showError(message);
    renderAccessBanner();
    return false;
}

async function apiRequest(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const required = requiredCapability(path, method);
    if (required && !capability(required)) throw new ApiError(accessBlockedMessage(required), accessState?.status === 'active' ? 429 : 403, accessState?.status === 'active' ? 'quota_exceeded' : `access_${accessState?.status || 'pending'}`);
    const response = await fetch(`${API_BASE}${path}`, { credentials: 'include', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (response.status === 401) {
        window.location.replace('index.html?auth=login');
        throw new Error('Сессия истекла');
    }
    if (!response.ok || data.error) {
        const details = data?.detail && typeof data.detail === 'object' ? data.detail : data?.error && typeof data.error === 'object' ? data.error : data;
        const code = details?.code || data?.code || (typeof data?.error === 'string' && /^[a-z_]+$/.test(data.error) ? data.error : '');
        if (response.status === 403 || response.status === 429) setTimeout(() => refreshAccess().catch(() => {}), 0);
        throw new ApiError(apiErrorMessage(data, response.status), response.status, code, details || {});
    }
    return data;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
function normalizeAccount(value = {}) {
    const source = value && typeof value === 'object' ? value : {};
    const name = typeof source.name === 'string' ? normalizeBrandName(source.name) : '';
    const email = typeof source.email === 'string' ? source.email.trim() : '';
    const role = source.role === 'admin' || source.role === 'client' ? source.role : '';
    return { ...source, name, email, role };
}
function safeUrl(value) { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : '#'; } catch { return '#'; } }
function normalizeBrandName(value) { return String(value || '').trim().replace(/\s+/g, ' '); }
function plausibleBrandName(value) { const name = normalizeBrandName(value).replace(/^\d+\s*[.)-]\s*/, ''); return /[a-zа-яё]/i.test(name) ? name : ''; }
function identityText(value) { return normalizeBrandName(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ''); }
function automaticIdentityText(value) { const normalized = normalizeBrandName(value).toLocaleLowerCase('ru-RU').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').replace(/\.(?:ru|ру|рф|com|net|org|io|ai)$/i, ''); return identityText(normalized); }
function domainText(value) { const raw = normalizeBrandName(value); if (!/^https?:\/\//i.test(raw) && !raw.includes('.')) return ''; try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLocaleLowerCase('ru-RU').replace(/^www\./, '').replace(/\.$/, ''); } catch { return ''; } }
function identityVariants(identity) { return [identity.canonicalName, ...(identity.aliases || [])].map(normalizeBrandName).filter(Boolean); }
function identityFor(value) {
    const token = automaticIdentityText(value); const domain = domainText(value);
    return brandIdentities.find(identity => identityVariants(identity).some(alias => automaticIdentityText(alias) === token) || Boolean(domain && (identity.domains || []).some(item => domainText(item) === domain))) || null;
}
function brandKey(value) { const direct = brandIdentities.find(identity => identity.canonicalId === value); return direct?.canonicalId || identityFor(value)?.canonicalId || `auto:${automaticIdentityText(value)}`; }
function canonicalBrand(value) { const identity = identityFor(value); return identity ? { id: identity.canonicalId, name: identity.canonicalName, aliases: [...identity.aliases], domains: [...identity.domains] } : { id: brandKey(value), name: normalizeBrandName(value), aliases: [], domains: [] }; }
function normalizeBrandRecord(item) {
    return { id: String(item.id || ''), canonicalId: String(item.canonical_id || item.canonicalId || item.id || ''), canonicalName: normalizeBrandName(item.canonical_name || item.canonicalName || item.name), aliases: Array.isArray(item.aliases) ? item.aliases.map(normalizeBrandName).filter(Boolean) : [], domains: Array.isArray(item.domains) ? item.domains.map(domainText).filter(Boolean) : [], identityChangedAt: item.identity_changed_at || item.identityChangedAt || null };
}
async function ensureBrandIdentity(value) {
    const name = normalizeBrandName(value); if (!name) return null;
    const existing = identityFor(name); if (existing) return existing;
    const data = await apiRequest('/brands', { method: 'POST', body: JSON.stringify({ canonical_name: name, aliases: [], domains: [] }) });
    const identity = normalizeBrandRecord(data.brand || data);
    brandIdentities.push(identity);
    await refreshAccess().catch(() => {});
    return identity;
}
async function persistBrandIdentity(identity) {
    const data = await apiRequest(`/brands/${encodeURIComponent(identity.id)}`, { method: 'PATCH', body: JSON.stringify({ canonical_name: identity.canonicalName, aliases: identity.aliases, domains: identity.domains }) });
    Object.assign(identity, normalizeBrandRecord(data.brand || data));
}
async function addBrandAlias(canonicalId, value, type = 'alias') {
    const name = normalizeBrandName(value); const target = brandIdentities.find(item => item.canonicalId === canonicalId); if (!target || !name) return false;
    const existing = identityFor(name);
    if (existing && existing.canonicalId !== target.canonicalId) throw new Error('Это название уже относится к другому бренду');
    const next = { ...target, aliases: [...target.aliases], domains: [...target.domains] };
    if (type === 'domain') { const domain = domainText(name); if (domain && !next.domains.some(item => domainText(item) === domain)) next.domains.push(domain); }
    else if (identityText(name) !== identityText(next.canonicalName) && !next.aliases.some(alias => identityText(alias) === identityText(name))) next.aliases.push(name);
    next.aliases = [...new Map(next.aliases.map(alias => [identityText(alias), alias])).values()].filter(alias => identityText(alias) !== identityText(next.canonicalName));
    next.domains = [...new Map(next.domains.map(domain => [domainText(domain), domainText(domain)])).values()].filter(Boolean);
    await persistBrandIdentity(next); Object.assign(target, next); return true;
}
async function removeBrandAlias(canonicalId, value, type = 'alias') {
    const target = brandIdentities.find(item => item.canonicalId === canonicalId); if (!target) return;
    const next = { ...target, aliases: [...target.aliases], domains: [...target.domains] };
    if (type === 'domain') next.domains = next.domains.filter(item => domainText(item) !== domainText(value)); else next.aliases = next.aliases.filter(item => identityText(item) !== identityText(value));
    await persistBrandIdentity(next); Object.assign(target, next);
}
function brandInitials(value) { const words = normalizeBrandName(value).split(/\s+/).filter(Boolean); return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : words[0]?.slice(0, 2) || '?').toLocaleUpperCase('ru-RU'); }
function faviconUrl(domain) { return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`; }
function monogramMarkup(name) { const tone = [...brandKey(name)].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4; return `<span class="identity-avatar identity-monogram tone-${tone}" aria-hidden="true">${escapeHtml(brandInitials(name))}</span>`; }
function imageAvatarMarkup(name, domain, type = 'company') { if (!domain) return monogramMarkup(name); return `<span class="identity-avatar" aria-hidden="true"><img src="${escapeHtml(faviconUrl(domain))}" alt="" data-avatar-name="${escapeHtml(name)}" data-avatar-type="${escapeHtml(type)}"></span>`; }
function modelAvatarMarkup(provider, name) { const label = name || provider || 'AI'; const src = PROVIDER_ICONS[provider]; return src ? `<span class="identity-avatar model-avatar" aria-hidden="true"><img src="${escapeHtml(src)}" alt="" data-avatar-name="${escapeHtml(label)}"></span>` : monogramMarkup(label); }
function brandDomainMap() {
    const candidates = new Map();
    activeHistory().forEach(item => {
        const sources = (item.sources || []).map(source => { try { const url = typeof source === 'string' ? source : source.url; return { domain: new URL(url).hostname.replace(/^www\./, ''), title: normalizeBrandName(typeof source === 'string' ? '' : source.title) }; } catch { return null; } }).filter(Boolean);
        (item.competitors || []).forEach(value => { const name = normalizeBrandName(value); const key = brandKey(name); const token = identityText(name); if (!key || token.length < 4) return; sources.forEach(source => { const host = identityText(source.domain.split('.')[0]); const title = identityText(source.title); if (!host.includes(token) && !title.includes(token)) return; if (!candidates.has(key)) candidates.set(key, new Map()); const domains = candidates.get(key); domains.set(source.domain, (domains.get(source.domain) || 0) + 1); }); });
    });
    const confirmed = new Map(); candidates.forEach((domains, key) => { const sorted = [...domains].sort((a, b) => b[1] - a[1]); if (sorted[0] && (!sorted[1] || sorted[0][1] > sorted[1][1])) confirmed.set(key, sorted[0][0]); }); return confirmed;
}
function companyAvatarMarkup(name) { return imageAvatarMarkup(name, brandDomainMap().get(brandKey(name))); }
function bindAvatarFallbacks() { $$('img[data-avatar-name]').forEach(image => { const replace = () => { const wrap = image.closest('.identity-avatar'); if (wrap) wrap.outerHTML = monogramMarkup(image.dataset.avatarName); }; image.addEventListener('error', replace, { once: true }); if (image.complete && !image.naturalWidth) replace(); }); }
function loadActiveBrandKey() {
    const saved = brandKey(localStorage.getItem(ACTIVE_BRAND_KEY));
    const available = new Set(brandIdentities.map(item => item.canonicalId));
    if (saved && available.has(saved)) return saved;
    return brandIdentities[0]?.canonicalId || '';
}
function selectedResults(item) {
    const results = Array.isArray(item.providerResults) ? item.providerResults : Array.isArray(item.provider_results) ? item.provider_results : [];
    const canonical = canonicalBrand(item.brand); const identity = { canonicalId: canonical.id, canonicalName: canonical.name, aliases: canonical.aliases, domains: canonical.domains };
    return results.filter(result => selectedProviders.has(result.provider)).map(result => canonicalizeProviderResult(result, identity));
}
function analysisVersion(item) { return item?.analysisVersion || item?.analysis_version || ''; }
function hasCurrentAnalysis(item) { return analysisVersion(item) === ANALYSIS_VERSION; }
function hasListedCompetitors(item) { return Array.isArray(item?.competitors) || Array.isArray(item?.mentioned_brands) || Array.isArray(item?.mentionedBrands); }
function listedCompetitors(item) {
    const values = Array.isArray(item?.competitors) ? item.competitors : Array.isArray(item?.mentioned_brands) ? item.mentioned_brands : Array.isArray(item?.mentionedBrands) ? item.mentionedBrands : [];
    const seen = new Set();
    return values.map(value => plausibleBrandName(typeof value === 'string' ? value : value?.name || value?.company || value?.brand)).filter(name => {
        const key = brandKey(name); if (!key || seen.has(key)) return false; seen.add(key); return true;
    });
}
function historyForActiveBrand() { return history.filter(item => brandKey(item.brand) === activeBrandKey); }
function enrichCompetitors(item) {
    const ownKey = brandKey(item.brand);
    const competitors = listedCompetitors(item).filter(name => brandKey(name) !== ownKey);
    return { ...item, competitors };
}
function activeHistory() {
    return historyForActiveBrand().filter(hasCurrentAnalysis).map(item => {
        const canonical = canonicalBrand(item.brand); const identity = { canonicalId: canonical.id, canonicalName: canonical.name, aliases: canonical.aliases, domains: canonical.domains };
        if (item.provider !== 'all') return selectedProviders.has(item.provider) ? enrichCompetitors({ ...item, ...canonicalizeProviderResult(item, identity), brand: canonical.name }) : null;
        const results = selectedResults(item);
        if (!results.length) {
            if (selectedProviders.size !== CHECK_PROVIDERS.length) return null;
            const ordered = orderedMentionsFor(item); const own = ordered.find(mention => mention.canonical_id === canonical.id || brandKey(mention.name) === canonical.id);
            return enrichCompetitors({ ...item, brand: canonical.name, mentioned: Boolean(own || item.mentioned), position: own?.position || item.position || null, orderedMentions: ordered });
        }
        if (results.length === 1) {
            const result = results[0];
            const position = resultPosition(result);
            return enrichCompetitors({ ...item, ...result, id: item.id, createdAt: item.createdAt, brand: item.brand, brandKey: item.brandKey, query: item.query, providerResults: results, orderedMentions: result.ordered_mentions || [], position: position.value, positionKind: position.kind, competitors: listedCompetitors(result), cited: (result.sources || []).some(source => `${source.title || ''} ${source.url || ''}`.toLowerCase().includes(item.brand.toLowerCase())) });
        }
        const mentionedResults = results.filter(result => result.mentioned);
        const ordered = canonicalizeMentionList(results.flatMap(result => result.ordered_mentions || []));
        return enrichCompetitors({ ...item, brand: canonical.name, providerResults: results, mentioned: Boolean(mentionedResults.length), position: mentionedResults.length ? mentionedResults.reduce((sum, result) => sum + Number(result.position || 0), 0) / mentionedResults.length : null, orderedMentions: ordered, competitors: results.flatMap(listedCompetitors) });
    }).filter(Boolean);
}
function currentBrand() {
    return brandIdentities.find(item => item.canonicalId === activeBrandKey)?.canonicalName || [...history].reverse().find(item => brandKey(item.brand) === activeBrandKey)?.brand || '';
}
function brandOptions() {
    return brandIdentities.map(identity => ({ key: identity.canonicalId, name: identity.canonicalName }));
}
function renderBrandSelector() {
    const select = $('#activeBrandSelect');
    select.innerHTML = brandOptions().map(item => `<option value="${escapeHtml(item.key)}">${escapeHtml(item.name)}</option>`).join('');
    select.value = activeBrandKey;
    if ($('#settingsProjectName')) $('#settingsProjectName').textContent = currentBrand() || 'Проект не выбран';
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
    renderAiAnswers();
    renderCompetitors();
    renderSources();
    renderMetricsDashboard();
    renderGrowth();
    renderBrandSettings();
    bindAvatarFallbacks();
    applyAccessGating();
}

$('#activeBrandSelect').addEventListener('change', event => setActiveBrand(event.target.value));

function closeAccountMenu(focusTrigger = false) {
    const menu = $('#accountMenu'); const trigger = $('#accountMenuTrigger');
    if (!menu || !trigger) return;
    menu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (focusTrigger) trigger.focus();
}
function selectView(view) {
    if (view === 'admin' && accountState?.role !== 'admin') return selectSettingsTab('profile');
    closeAccountMenu();
    $$('.app-nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    $$('.app-view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
    $('#appBreadcrumb').textContent = $(`.app-nav-item[data-view="${view}"]`)?.textContent.trim() || (view === 'settings' ? 'Настройки' : view === 'admin' ? 'Администрирование' : 'Главная');
    if (view === 'growth') renderGrowth();
    if (view === 'sources') renderSources();
    if (view === 'competitors') renderCompetitors();
    if (view === 'answers') renderAiAnswers();
    if (view === 'settings') { renderAccountProfile(); renderAccountAccess(); renderBrandSettings(); }
    if (view === 'admin' && !$('#adminClientList').children.length) loadAdminClients();
}
const SETTINGS_META = {
    project: ['Проект', 'Название, варианты написания и домены активного проекта.'],
    profile: ['Профиль', 'Личные данные вашего аккаунта.'],
    access: ['Доступ и лимиты', 'Тариф, срок действия и текущее использование.'],
    security: ['Безопасность', 'Смена email, пароля и удаление аккаунта.']
};
function selectSettingsTab(tab) {
    const selected = SETTINGS_META[tab] ? tab : 'profile';
    selectView('settings');
    $$('[data-settings-panel]').forEach(panel => { const active = panel.dataset.settingsPanel === selected; panel.hidden = !active; panel.classList.toggle('active', active); });
    $$('.settings-nav [data-settings-tab]').forEach(button => { const active = button.dataset.settingsTab === selected; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; });
    $('#settingsTitle').textContent = SETTINGS_META[selected][0];
    $('#settingsDescription').textContent = SETTINGS_META[selected][1];
    $('#appBreadcrumb').textContent = `Настройки · ${SETTINGS_META[selected][0]}`;
}
$$('[data-view]').forEach(button => button.addEventListener('click', () => selectView(button.dataset.view)));
$$('[data-settings-tab]').forEach(button => button.addEventListener('click', () => selectSettingsTab(button.dataset.settingsTab)));
$$('[data-empty-chart-action]').forEach(button => button.addEventListener('click', () => selectView('prompts')));
$('#accountMenuTrigger').addEventListener('click', event => { event.stopPropagation(); const menu = $('#accountMenu'); const opening = menu.hidden; menu.hidden = !opening; $('#accountMenuTrigger').setAttribute('aria-expanded', String(opening)); });
$('#accountMenuTrigger').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const menu = $('#accountMenu'); menu.hidden = false; $('#accountMenuTrigger').setAttribute('aria-expanded', 'true');
    const items = [...menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.hidden);
    (event.key === 'ArrowDown' ? items[0] : items.at(-1))?.focus();
});
$('#accountMenu').addEventListener('click', event => event.stopPropagation());
$('#accountMenu').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...event.currentTarget.querySelectorAll('[role="menuitem"]')].filter(item => !item.hidden);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length : (current - 1 + items.length) % items.length;
    items[next].focus();
});
$('.settings-nav').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(document.activeElement); if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
    selectSettingsTab(tabs[next].dataset.settingsTab); tabs[next].focus();
});
document.addEventListener('click', () => closeAccountMenu());
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#accountMenu').hidden) closeAccountMenu(true); });

function updateProviderFilter() {
    const total = CHECK_PROVIDERS.length;
    const count = selectedProviders.size;
    $('#providerFilterLabel').textContent = count === total ? 'Все' : count === 1 ? PROVIDERS[[...selectedProviders][0]] : `${count} выбрано`;
    $('#providerFilterCount').textContent = `${count}/${total}`;
    $$('#providerFilterMenu input').forEach(input => { input.checked = selectedProviders.has(input.value); });
}
$('#providerFilterTrigger').addEventListener('click', event => {
    event.stopPropagation();
    const menu = $('#providerFilterMenu');
    menu.hidden = !menu.hidden;
    $('#providerFilterTrigger').setAttribute('aria-expanded', String(!menu.hidden));
});
$('#providerFilterMenu').addEventListener('click', event => event.stopPropagation());
$$('#providerFilterMenu input').forEach(input => input.addEventListener('change', () => {
    if (input.checked) selectedProviders.add(input.value); else selectedProviders.delete(input.value);
    if (!selectedProviders.size) { selectedProviders.add(input.value); input.checked = true; }
    updateProviderFilter(); renderAllForActiveBrand();
}));
$('#providerFilterAll').addEventListener('click', () => { selectedProviders = new Set(CHECK_PROVIDERS); updateProviderFilter(); renderAllForActiveBrand(); });
document.addEventListener('click', () => { $('#providerFilterMenu').hidden = true; $('#providerFilterTrigger').setAttribute('aria-expanded', 'false'); });
updateProviderFilter();

async function suggestPrompts() {
    const brand = normalizeBrandName($('#wsBrand').value);
    if (!brand) return showError('Введите бренд, чтобы подобрать промпты.');
    const button = $('#wsSuggestPrompts'); const refresh = $('#refreshPromptSuggestions'); const wrap = $('#promptSuggestions');
    $('#wsError').hidden = true; wrap.hidden = false; button.disabled = true; refresh.disabled = true;
    $('#promptSuggestionList').innerHTML = '';
    $('#promptSuggestionStatus').innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Perplexity определяет категорию бренда и готовит запросы…';
    try {
        const existingQueries = [...new Set(history.filter(item => brandKey(item.brand) === brandKey(brand)).map(item => normalizeBrandName(item.query)).filter(Boolean))].slice(-12);
        const identity = identityFor(brand);
        const data = await apiRequest('/prompt-suggestions', { method: 'POST', body: JSON.stringify({ brand, existing_queries: existingQueries, domains: identity?.domains || [] }) });
        const prompts = Array.isArray(data.prompts) ? data.prompts.filter(value => typeof value === 'string' && value.trim()) : [];
        if (!prompts.length) throw new Error('Perplexity не вернул подходящих промптов');
        $('#promptSuggestionList').innerHTML = prompts.map((prompt, index) => `<button class="prompt-suggestion-item" type="button" data-suggested-prompt="${encodeURIComponent(prompt)}"><span>${index + 1}</span><strong>${escapeHtml(prompt)}</strong><i class="fa-solid fa-arrow-right"></i></button>`).join('');
        $('#promptSuggestionStatus').textContent = 'Выберите промпт — он подставится в поле проверки.';
        $$('[data-suggested-prompt]').forEach(item => item.addEventListener('click', () => { $('#wsQuery').value = decodeURIComponent(item.dataset.suggestedPrompt); $('#wsQuery').focus(); item.classList.add('selected'); setTimeout(() => item.classList.remove('selected'), 700); }));
    } catch (error) {
        $('#promptSuggestionStatus').textContent = error.message;
        showError(`Не удалось подобрать промпты: ${error.message}`);
    } finally { button.disabled = false; refresh.disabled = false; applyAccessGating(); }
}
$('#wsSuggestPrompts').addEventListener('click', suggestPrompts);
$('#refreshPromptSuggestions').addEventListener('click', suggestPrompts);

function apiErrorMessage(data, status) {
    const value = data?.error ?? data?.detail;
    const details = value && typeof value === 'object' && !Array.isArray(value) ? value : data;
    const code = details?.code || data?.code || (typeof value === 'string' && /^[a-z_]+$/.test(value) ? value : '');
    const messages = {
        access_pending: 'Доступ ещё не активирован. Сохранённые данные доступны только для просмотра.',
        access_suspended: 'Доступ приостановлен. Сохранённые данные доступны только для просмотра.',
        access_expired: 'Срок доступа истёк. Сохранённые данные доступны только для просмотра.',
        quota_exceeded: 'Лимит исчерпан. Проверьте доступные квоты в разделе «Аккаунт».',
        brand_identity_cooldown: 'Название и домены бренда можно изменять не чаще одного раза в 14 дней.'
    };
    if (messages[code]) {
        const next = details?.next_allowed_at || details?.nextAllowedAt;
        return next && code === 'brand_identity_cooldown' ? `${messages[code]} Следующее изменение: ${formatDateTime(next)}.` : messages[code];
    }
    if (typeof value === 'string' && value.trim()) return value;
    if (Array.isArray(value)) {
        const messages = value.map(item => typeof item === 'string' ? item : item?.error || item?.msg).filter(Boolean);
        if (messages.length) return messages.join('; ');
    }
    if (value && typeof value === 'object') {
        if (typeof value.error === 'string') return value.error;
        if (typeof value.message === 'string') return value.message;
        if (typeof value.msg === 'string') return value.msg;
    }
    return `Ошибка сервера (HTTP ${status})`;
}

function parseDate(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date : null; }
function formatDate(value, fallback = 'Бессрочно') { const date = parseDate(value); return date ? date.toLocaleDateString('ru-RU') : fallback; }
function formatDateTime(value) { const date = parseDate(value); return date ? date.toLocaleString('ru-RU') : 'неизвестно'; }
function normalizeQuota(value = {}) {
    const limit = value.limit === null || value.limit === undefined ? null : Number(value.limit);
    const used = Math.max(0, Number(value.used) || 0);
    const unlimited = Boolean(value.unlimited || limit === null);
    const remaining = unlimited ? null : Math.max(0, value.remaining === undefined || value.remaining === null ? limit - used : Number(value.remaining));
    return { limit, used, remaining, unlimited, periodStart: value.period_start || value.periodStart || null, periodEnd: value.period_end || value.periodEnd || null };
}
function normalizeAccess(value = {}) {
    return { status: value.status || value.effective_status || 'pending', administrativeStatus: value.administrative_status || value.administrativeStatus || value.status || 'pending', plan: value.plan || 'custom', activatedAt: value.activated_at || value.activatedAt || null, expiresAt: value.expires_at || value.expiresAt || null, checks: normalizeQuota(value.checks), brands: normalizeQuota(value.brands), capabilities: { workspace_write: Boolean(value.capabilities?.workspace_write ?? value.capabilities?.workspaceWrite), run_checks: Boolean(value.capabilities?.run_checks ?? value.capabilities?.runChecks), create_brands: Boolean(value.capabilities?.create_brands ?? value.capabilities?.createBrands), manage_existing_brands: Boolean(value.capabilities?.manage_existing_brands ?? value.capabilities?.manageExistingBrands) } };
}
function statusLabelAccess(status) { return ({ pending: 'Ожидает активации', active: 'Активен', expired: 'Срок истёк', suspended: 'Приостановлен' })[status] || status || 'Неизвестно'; }
function planLabel(plan) { return ({ basic: 'Basic', pro: 'Pro', business: 'Business', custom: 'Custom' })[plan] || plan || '—'; }
function quotaText(quota) { return quota.unlimited ? `${quota.used} использовано · безлимит` : `${quota.used} из ${quota.limit} · осталось ${quota.remaining}`; }
function quotaPeriodText(quota) { return quota.periodStart || quota.periodEnd ? `${formatDate(quota.periodStart, '—')} — ${formatDate(quota.periodEnd, '—')}` : ''; }
function quotaProgress(quota) { return quota.unlimited ? 100 : quota.limit > 0 ? Math.min(100, quota.used / quota.limit * 100) : 100; }
async function refreshAccess(render = true) {
    const data = await apiRequest('/access');
    accessState = normalizeAccess(data.access || data);
    if (render) { renderAccountAccess(); renderAccessBanner(); applyAccessGating(); }
    return accessState;
}
function renderAccessBanner() {
    if (!accessState) return;
    const banner = $('#accessBanner');
    const status = accessState.status;
    const checksExhausted = !accessState.checks.unlimited && accessState.checks.remaining <= 0;
    const brandsExhausted = !accessState.brands.unlimited && accessState.brands.remaining <= 0;
    if (status === 'active' && !checksExhausted && !brandsExhausted) { banner.hidden = true; return; }
    banner.hidden = false;
    banner.dataset.status = status;
    if (status !== 'active') {
        $('#accessBannerTitle').textContent = statusLabelAccess(status);
        $('#accessBannerText').textContent = accessBlockedMessage('workspace_write');
    } else {
        $('#accessBannerTitle').textContent = 'Ограничения тарифа';
        $('#accessBannerText').textContent = checksExhausted && brandsExhausted ? 'Исчерпаны лимиты проверок и брендов.' : checksExhausted ? 'Исчерпан лимит проверок.' : 'Исчерпан лимит новых брендов.';
    }
}
function renderAccountAccess() {
    if (!accessState || !$('#accountAccessStatus')) return;
    const status = accessState.status;
    ['#accountAccessStatus', '#accountMenuAccess', '#projectAccessStatus'].forEach(selector => { const badge = $(selector); badge.textContent = statusLabelAccess(status); badge.dataset.status = status; });
    $('#appUserAccessCompact').textContent = status === 'active' ? planLabel(accessState.plan) : statusLabelAccess(status);
    $('#accountPlan').textContent = planLabel(accessState.plan);
    $('#accountAccessExpires').textContent = formatDate(accessState.expiresAt);
    const periodStart = accessState.checks.periodStart || accessState.brands.periodStart;
    const periodEnd = accessState.checks.periodEnd || accessState.brands.periodEnd;
    $('#accountAccessPeriod').textContent = periodStart || periodEnd ? `${formatDate(periodStart, '—')} — ${formatDate(periodEnd, '—')}` : '—';
    $('#accountChecksQuota').textContent = quotaText(accessState.checks);
    $('#accountChecksPeriod').textContent = quotaPeriodText(accessState.checks);
    $('#accountChecksProgress').style.width = `${quotaProgress(accessState.checks)}%`;
    $('#accountBrandsQuota').textContent = quotaText(accessState.brands);
    $('#accountBrandsPeriod').textContent = quotaPeriodText(accessState.brands);
    $('#accountBrandsProgress').style.width = `${quotaProgress(accessState.brands)}%`;
}
function renderAccountProfile() {
    if (!accountState) return;
    accountState = normalizeAccount(accountState);
    $('#accountName').value = accountState.name || '';
    $('#accountEmail').value = accountState.email || '';
    $('#accountCreatedAt').textContent = formatDate(accountState.created_at || accountState.createdAt, '—');
    $('#accountRole').textContent = accountState.role === 'admin' ? 'Администратор' : accountState.role === 'client' ? 'Клиент' : '';
    $('#appUserName').textContent = accountState.name || accountState.email || '';
    $('#accountMenuName').textContent = accountState.name || 'Пользователь';
    $('#accountMenuEmail').textContent = accountState.email || '';
    const initials = brandInitials(accountState.name || accountState.email || 'Пользователь');
    $('#appUserInitials').textContent = initials;
    $('#accountMenuInitials').textContent = initials;
    const isAdmin = accountState.role === 'admin';
    $('#adminMenuItem').hidden = !isAdmin;
}
function setDisabled(selector, disabled) { $$(selector).forEach(element => { element.disabled = disabled; element.setAttribute('aria-disabled', String(disabled)); }); }
function projectIdentityCooldown(identity) {
    const changed = parseDate(identity?.identityChangedAt); if (!changed) return null;
    const next = new Date(changed.getTime() + 14 * 24 * 60 * 60 * 1000);
    return next.getTime() > Date.now() ? next : null;
}
function renderProjectSettingsState() {
    const identity = activeBrandIdentity(); const canManage = capability('manage_existing_brands'); const notice = $('#projectAccessNotice'); const cooldown = projectIdentityCooldown(identity);
    if (!identity) { notice.hidden = false; notice.querySelector('span').textContent = 'Проект не выбран. Запустите проверку для нового бренда или выберите существующий проект.'; }
    else if (!canManage) { notice.hidden = false; notice.querySelector('span').textContent = accessBlockedMessage('workspace_write'); }
    else notice.hidden = true;
    $('#brandIdentityCooldown').textContent = cooldown ? `Название и домены можно будет изменить ${formatDateTime(cooldown)}. Псевдонимы доступны сейчас.` : identity ? 'Название и домены можно менять вместе не чаще одного раза в 14 дней.' : '';
    return { identity, canManage, cooldown };
}
function applyAccessGating() {
    const canWrite = capability('workspace_write');
    const canCheck = capability('run_checks');
    const projectState = renderProjectSettingsState();
    const projectBlocked = !projectState.canManage || !projectState.identity;
    setDisabled('#wsCheck, .app-topbar-cta, [data-empty-chart-action], [data-view="prompts"]:not(.app-nav-item), [data-measure-task], #dialogMeasureTask', !canCheck);
    setDisabled('#wsBrand, #wsQuery, #wsSuggestPrompts, #refreshPromptSuggestions, [data-create-task], [data-dismiss], [data-quick-status], #growthTaskForm input, #growthTaskForm select, #growthTaskForm textarea, #growthTaskForm [type="submit"], #deleteGrowthTask', !canWrite);
    setDisabled('#addBrandAlias, #brandAliasInput, [data-merge-alias]', projectBlocked);
    setDisabled('#saveCanonicalBrand, #addBrandDomain, #brandDomainInput, #canonicalBrandName', projectBlocked || Boolean(projectState.cooldown));
    setDisabled('#deleteBrand', projectBlocked);
    $$('[data-remove-brand-value]').forEach(button => { const disabled = projectBlocked || button.dataset.brandValueType === 'domain' && Boolean(projectState.cooldown); button.disabled = disabled; button.setAttribute('aria-disabled', String(disabled)); });
    setDisabled('[data-delete-check]', !canWrite);
    $('.app-topbar-cta')?.classList.toggle('is-access-disabled', !canCheck);
}

$('#wsCheck').addEventListener('click', async () => {
    const brand = normalizeBrandName($('#wsBrand').value);
    const query = $('#wsQuery').value.trim();
    if (!brand || !query) return showError('Введите бренд и промпт для проверки.');
    const checkButton = $('#wsCheck');
    if (checkButton.disabled) return;
    $('#wsError').hidden = true; $('#wsResult').hidden = true; $('#wsLoader').hidden = false; $('#wsLoaderText').textContent = 'Формируем общий результат проверки…'; checkButton.disabled = true;
    try {
        const identity = await ensureBrandIdentity(brand);
        setActiveBrand(identity.canonicalId, false, false);
        const raw = await apiRequest('/check-all', { method: 'POST', body: JSON.stringify({ brand: identity.canonicalName, brand_id: identity.id, query, canonical_id: identity.canonicalId, canonical_name: identity.canonicalName, aliases: identity.aliases, domains: identity.domains }) });
        const data = canonicalizeCheckResult(raw, identity);
        renderResult(data);
        saveCheck(data, brand, query, 'all');
        await refreshAccess().catch(() => {});
        const errors = (data.provider_errors || []).map(item => `${PROVIDERS[item.provider] || item.provider}: ${item.error}`);
        if (errors.length) showError(`Часть данных недоступна: ${errors.join('; ')}`);
    } catch (error) { await refreshChecks().catch(() => {}); if ($('#wsError').hidden) showError(`Не удалось выполнить проверку: ${error.message}`); }
    finally { $('#wsLoader').hidden = true; checkButton.disabled = false; applyAccessGating(); }
});

function showError(message) { const error = $('#wsError'); error.textContent = message; error.hidden = false; }
function resultPosition(data) {
    const direct = Number(data?.position) || null;
    const weighted = Number(data?.weighted_position) || null;
    return direct ? { value: direct, kind: 'direct' } : weighted ? { value: weighted, kind: 'weighted' } : { value: null, kind: null };
}
function positionText(position, kind = 'direct') {
    if (!position) return '';
    const value = Number(Number(position).toFixed(2)).toString();
    return kind === 'weighted' ? `Средняя позиция ${value}` : `Позиция №${value}`;
}
function renderResult(data) {
    const result = $('#wsResult');
    const position = resultPosition(data);
    $('#wsVerdict').className = `ws-verdict ${data.mentioned ? 'mentioned' : 'not-mentioned'}`;
    $('#wsVerdict').innerHTML = data.mentioned ? '<i class="fa-solid fa-circle-check"></i> Бренд упомянут' : '<i class="fa-solid fa-circle-xmark"></i> Бренд не упомянут';
    const showModelDetails = data.provider !== 'all';
    $('#wsMeta').innerHTML = [showModelDetails && data.provider && ['Провайдер', PROVIDERS[data.provider] || data.provider, data.provider], showModelDetails && data.model && ['Модель', data.model], position.value && [position.kind === 'weighted' ? 'Средняя позиция' : 'Позиция', position.kind === 'weighted' ? positionText(position.value, position.kind).replace('Средняя позиция ', '') : `№${Number(Number(position.value).toFixed(2))}`], data.role && data.role !== 'не упомянут' && ['Роль', data.role]].filter(Boolean).map(([label, value, provider]) => `<div class="ws-meta-item"><span class="ws-meta-label">${escapeHtml(label)}</span><span class="ws-meta-value${provider ? ' ws-meta-provider' : ''}">${provider ? modelAvatarMarkup(provider, value) : ''}${escapeHtml(value)}</span></div>`).join('');
    bindAvatarFallbacks();
    const brands = listedCompetitors(data);
    $('#wsBrands').innerHTML = brands.map(item => `<li>${escapeHtml(item)}</li>`).join(''); $('#wsBrandsWrap').hidden = !brands.length;
    const sources = Array.isArray(data.sources) ? data.sources : [];
    $('#wsSources').innerHTML = sources.map(source => `<div class="ws-source-card"><a class="ws-source-link" href="${escapeHtml(safeUrl(source.url))}" target="_blank" rel="noopener">${escapeHtml(source.title || source.url)}</a><span class="ws-source-auth">${escapeHtml(source.authority_label || 'не определена')}</span></div>`).join(''); $('#wsSourcesWrap').hidden = !sources.length;
    result.hidden = false;
}
function canonicalizeMentionList(values) {
    const rows = Array.isArray(values) ? values : []; const seen = new Set();
    return rows.map((mention, index) => { const observedName = plausibleBrandName(mention?.observed_name || mention?.name || mention?.company || mention?.brand); const identity = canonicalBrand(mention?.canonical_name || observedName); return { ...mention, name: identity.name, observed_name: observedName, canonical_id: identity.id, canonical_name: identity.name, position: Number(mention?.position) || index + 1, role: mention?.role || 'упоминание' }; }).sort((a, b) => a.position - b.position).filter(mention => { if (!mention.observed_name || !mention.canonical_id || seen.has(mention.canonical_id)) return false; seen.add(mention.canonical_id); return true; }).map((mention, index) => ({ ...mention, position: index + 1 }));
}
function normalizedAnswerText(value) { return ` ${String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9.]+/gi, ' ').replace(/\s+/g, ' ').trim()} `; }
function answerContainsIdentity(answer, identity) {
    const text = normalizedAnswerText(answer); if (!text.trim()) return false;
    return identityVariants(identity).some(alias => { const needle = normalizedAnswerText(alias); return needle.trim().length > 1 && text.includes(needle); }) || (identity.domains || []).some(domain => text.includes(` ${domainText(domain)} `));
}
function canonicalizeProviderResult(result, targetIdentity) {
    const supplied = result?.ordered_mentions || result?.orderedMentions || [];
    let ordered = canonicalizeMentionList(supplied);
    const rawAnswer = result?.raw_answer || result?.rawAnswer || '';
    const competitors = listedCompetitors(result).filter(name => brandKey(name) !== targetIdentity.canonicalId);
    const targetPresent = ordered.some(mention => mention.canonical_id === targetIdentity.canonicalId);
    const foundInAnswer = answerContainsIdentity(rawAnswer, targetIdentity);
    if (!hasCurrentAnalysis(result) && foundInAnswer && !targetPresent) ordered.push({ name: targetIdentity.canonicalName, observed_name: targetIdentity.canonicalName, canonical_id: targetIdentity.canonicalId, canonical_name: targetIdentity.canonicalName, position: ordered.length + 1, role: result?.role && result.role !== 'не упомянут' ? result.role : 'упоминание' });
    ordered = canonicalizeMentionList(ordered);
    if (hasListedCompetitors(result)) {
        const allowed = new Set([targetIdentity.canonicalId, ...competitors.map(brandKey)]);
        ordered = ordered.filter(mention => allowed.has(mention.canonical_id)).map((mention, index) => ({ ...mention, position: index + 1 }));
    }
    const own = ordered.find(mention => mention.canonical_id === targetIdentity.canonicalId);
    const mentioned = hasCurrentAnalysis(result) ? Boolean(result?.mentioned) : Boolean(own || (!rawAnswer && result?.mentioned));
    return { ...result, canonical_id: targetIdentity.canonicalId, canonical_name: targetIdentity.canonicalName, observed_name: result?.observed_name || targetIdentity.canonicalName, mentioned, position: own?.position || null, ordered_mentions: ordered, competitors, mentioned_brands: competitors };
}
function canonicalizeCheckResult(data, identity) {
    if (!data || typeof data !== 'object') return data;
    const providerResults = (data.provider_results || []).map(result => canonicalizeProviderResult({ ...result, analysis_version: analysisVersion(result) || analysisVersion(data) }, identity));
    if (!providerResults.length) return canonicalizeProviderResult(data, identity);
    const ordered = canonicalizeMentionList(providerResults.flatMap(result => result.ordered_mentions || []));
    const mentionedResults = providerResults.filter(result => result.mentioned);
    const competitors = hasListedCompetitors(data) ? listedCompetitors(data) : providerResults.flatMap(listedCompetitors);
    return { ...data, canonical_id: identity.canonicalId, canonical_name: identity.canonicalName, observed_name: data.observed_name || identity.canonicalName, provider_results: providerResults, mentioned: Boolean(mentionedResults.length), position: mentionedResults.length ? mentionedResults.reduce((sum, result) => sum + Number(result.position || 0), 0) / mentionedResults.length : null, ordered_mentions: ordered, competitors, mentioned_brands: competitors };
}
function buildHistoryItem(data, brand, query, provider, record = {}) {
    const sources = (data.sources || []).map(source => ({ title: source.title, url: source.url }));
    const cited = sources.some(source => `${source.title || ''} ${source.url || ''}`.toLowerCase().includes(brand.toLowerCase()));
    const sentiments = (data.source_analysis || []).filter(item => item.mentions_brand).map(item => item.sentiment).filter(Boolean);
    const identity = brandIdentities.find(item => item.id === String(record.brand_id || '')) || identityFor(data.canonical_name || brand);
    const normalizedBrand = identity?.canonicalName || normalizeBrandName(brand);
    const position = resultPosition(data);
    const storedError = record.error; const error = typeof storedError === 'string' ? storedError : Array.isArray(storedError) ? storedError.map(item => item?.error || item?.message || item).join('; ') : storedError?.error || storedError?.message || '';
    return { id: String(record.id || data.check?.id || crypto.randomUUID()), createdAt: new Date(record.created_at || data.check?.created_at || Date.now()).getTime(), brand: normalizedBrand, brandKey: identity?.canonicalId || String(record.brand_id || ''), canonicalId: identity?.canonicalId || String(record.brand_id || ''), canonicalName: normalizedBrand, observedName: data.observed_name || brand, query, provider: data.provider || provider, model: data.model || PROVIDERS[provider], marketScope: data.market_scope || '', rawAnswer: data.raw_answer || data.rawAnswer || '', providerResults: data.provider_results || [], orderedMentions: data.ordered_mentions || [], mentioned: Boolean(data.mentioned), position: position.value, positionKind: position.kind, role: data.role || '', analysisVersion: analysisVersion(data), competitors: listedCompetitors(data).filter(name => brandKey(name) !== identity?.canonicalId), sources, cited, sentiments, reasoning: data.reasoning || '', quotes: data.quotes || [], status: record.status || data.check?.status || 'completed', error: String(error) };
}
function normalizeStoredCheck(record) {
    const identity = brandIdentities.find(item => item.id === String(record.brand_id || '')) || brandIdentities.find(item => item.canonicalId === String(record.canonical_id || '')) || identityFor(record.brand);
    const result = record.result && typeof record.result === 'object' ? canonicalizeCheckResult(record.result, identity || { canonicalId: String(record.brand_id || ''), canonicalName: record.brand, aliases: [], domains: [] }) : {};
    return buildHistoryItem(result, record.brand || identity?.canonicalName || '', record.query || '', record.provider || 'all', record);
}
function saveCheck(data, brand, query, provider) {
    const saved = buildHistoryItem(data, brand, query, provider, data.check || {});
    history = history.filter(item => item.id !== saved.id);
    history.push(saved);
    setActiveBrand(saved.brand, false, false);
    return saved;
}
function renderHistory() {
    const rows = historyForActiveBrand();
    $('#historyCount').textContent = `${rows.length} ${rows.length === 1 ? 'проверка' : 'проверок'}`;
    $('#historyList').innerHTML = rows.length ? rows.slice().reverse().slice(0, 10).map(item => `<div class="app-history-row"><div><strong>${escapeHtml(item.query)}</strong><span>${escapeHtml(item.brand)}${item.provider === 'all' ? '' : ` · ${escapeHtml(PROVIDERS[item.provider] || item.provider)}`} · ${item.status === 'failed' ? `ошибка: ${escapeHtml(item.error || 'проверка не выполнена')}` : item.mentioned ? 'бренд упомянут' : 'бренд не упомянут'}</span></div><div class="app-history-actions"><span>${new Date(item.createdAt).toLocaleDateString('ru-RU')}</span><button type="button" data-delete-check="${escapeHtml(item.id)}" aria-label="Удалить проверку" title="Удалить проверку"><i class="fa-regular fa-trash-can"></i></button></div></div>`).join('') : '<div class="app-empty"><strong>Пока нет проверок</strong><span>Запустите первую проверку выше.</span></div>';
    $$('[data-delete-check]').forEach(button => button.addEventListener('click', () => deleteCheck(button.dataset.deleteCheck)));
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
function snapshotCheck(item) { return item ? { id: item.id || null, createdAt: item.createdAt || Date.now(), mentioned: Boolean(item.mentioned), position: Number(item.position) || null, positionKind: item.positionKind || 'weighted', role: item.role || '', competitors: item.competitors || [], reasoning: item.reasoning || '', quotes: item.quotes || [] } : null; }
function growthTaskForBrand(task) { return brandKey(task.brand) === activeBrandKey; }
function statusLabel(status) { return ({ planned: 'Запланировано', in_progress: 'В работе', ready_for_check: 'Готово к проверке', measured: 'Измерено' })[status] || status; }
function workTypeLabel(type) { return ({ content: 'Контент', seo: 'SEO', pr: 'PR', technical: 'Техническая' })[type] || type; }
function emptyGrowth(title, text, action = '') { return `<div class="app-empty growth-empty"><strong>${title}</strong><span>${text}</span>${action}</div>`; }
function updateGrowthSummary(opportunities, tasks, results, activeTab = 'opportunities') {
    $('#growthOpportunityTotal').textContent = opportunities.length;
    $('#growthTaskTotal').textContent = tasks.length;
    $('#growthResultTotal').textContent = results.length;
    const summaries = {
        opportunities: opportunities.length ? [`${opportunities.length} ${opportunities.length === 1 ? 'возможность готова' : 'возможности готовы'} к разбору`, 'Изучите доказательства и создайте задачу для важного разрыва.'] : ['Найдите устойчивую точку роста', 'Две проверки одного промпта помогут подтвердить проблему.'],
        tasks: tasks.length ? [`${tasks.length} ${tasks.length === 1 ? 'задача находится' : 'задачи находятся'} в работе`, 'Обновляйте статус и проверяйте эффект готовых изменений.'] : ['Переведите возможность в работу', 'Здесь появятся задачи, ответственные и сроки.'],
        results: results.length ? [`Измерено ${results.length} ${results.length === 1 ? 'изменение' : 'изменения'}`, 'Сравните состояние до и после изменений.'] : ['Здесь появятся результаты', 'Завершите задачу и повторите исходную проверку.']
    };
    [$('#growthStageTitle').textContent, $('#growthStageText').textContent] = summaries[activeTab];
}
function renderGrowth() {
    const accepted = new Set(growthTasks.map(task => task.opportunityId));
    const opportunities = recommendations().filter(item => !dismissedOpportunities.has(item.id) && !accepted.has(item.id));
    const tasks = growthTasks.filter(task => growthTaskForBrand(task) && task.status !== 'measured');
    const results = growthTasks.filter(task => growthTaskForBrand(task) && task.status === 'measured');
    $('#opportunityCount').textContent = opportunities.length; $('#taskCount').textContent = tasks.length; $('#resultCount').textContent = results.length;
    const activeTab = $('[data-growth-tab].active')?.dataset.growthTab || 'opportunities';
    updateGrowthSummary(opportunities, tasks, results, activeTab);
    $('#growthOpportunities').innerHTML = opportunities.length ? opportunities.map(renderOpportunityCard).join('') : emptyGrowth('Пока нет подтверждённых возможностей', 'Для рекомендации нужны две проверки одного промпта в одной модели.', '<button class="btn btn-primary btn-sm" data-growth-view="prompts">Запустить проверку</button>');
    $('#growthTasks').innerHTML = tasks.length ? tasks.sort((a, b) => b.updatedAt - a.updatedAt).map(renderTaskCard).join('') : emptyGrowth('Нет задач в работе', 'Выберите подтверждённую возможность и превратите её в конкретную задачу.', '<button class="btn btn-ghost btn-sm" data-growth-open-tab="opportunities">Посмотреть возможности</button>');
    $('#growthResults').innerHTML = results.length ? results.sort((a, b) => b.updatedAt - a.updatedAt).map(renderResultCard).join('') : emptyGrowth('Пока нет измеренных результатов', 'Завершите задачу и выполните свежую проверку эффекта.', '<button class="btn btn-ghost btn-sm" data-growth-open-tab="tasks">Перейти к задачам</button>');
    bindGrowthActions();
    applyAccessGating();
}
function renderOpportunityCard(item) {
    const competitors = item.competitors.length ? item.competitors.slice(0, 4).join(', ') : 'не обнаружены';
    const latest = item.evidenceRows.at(-1);
    return `<article class="growth-card growth-opportunity"><div class="growth-card-main"><div class="growth-card-badges"><span class="growth-priority ${item.priority}">${item.priority === 'high' ? 'Высокий' : 'Средний'} приоритет</span><span class="growth-tag">${escapeHtml(PROVIDERS[item.provider] || item.provider)}</span><span class="growth-tag">${item.count} подтверждения</span></div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p><div class="growth-evidence"><strong>Промпт</strong><span>${escapeHtml(item.query)}</span><strong>Конкуренты</strong><span>${escapeHtml(competitors)}</span><strong>Последнее доказательство</strong><span>${escapeHtml(latest.reasoning || (latest.mentioned ? 'Бренд упомянут без рекомендации.' : 'Бренд не найден в результате.'))}</span></div><div class="growth-suggestion"><strong>Что предлагает Vidno</strong><span>${escapeHtml(item.suggestedAction)}</span></div></div><aside class="growth-card-actions"><span class="growth-action-label">Следующий шаг</span><button class="btn btn-primary btn-sm" data-create-task="${encodeURIComponent(item.id)}">Создать задачу</button><button class="btn btn-ghost btn-sm" data-dismiss="${encodeURIComponent(item.id)}">Неактуально</button></aside></article>`;
}
function renderTaskCard(task) {
    const statusControl = ['planned', 'in_progress', 'ready_for_check'].includes(task.status) ? `<label class="growth-quick-status"><span class="growth-action-label">Статус</span><select class="status-${task.status}" data-quick-status="${task.id}" aria-label="Статус задачи «${escapeHtml(task.title)}»"><option value="planned"${task.status === 'planned' ? ' selected' : ''}>Запланировано</option><option value="in_progress"${task.status === 'in_progress' ? ' selected' : ''}>В работе</option><option value="ready_for_check"${task.status === 'ready_for_check' ? ' selected' : ''}>Готово к проверке</option></select></label>` : `<span class="growth-status status-${task.status}">${statusLabel(task.status)}</span>`;
    return `<article class="growth-card growth-task"><div class="growth-card-main"><div class="growth-card-badges">${statusControl}<span class="growth-tag">${workTypeLabel(task.workType)}</span><span class="growth-tag">${escapeHtml(PROVIDERS[task.provider] || task.provider)}</span></div><h3>${escapeHtml(task.title)}</h3><div class="growth-suggestion growth-task-action"><strong>Что сделать</strong><span>${escapeHtml(task.action)}</span></div><div class="growth-task-meta"><span><i class="fa-regular fa-user"></i>${escapeHtml(task.owner || 'Не назначен')}</span><span><i class="fa-regular fa-calendar"></i>${task.deadline ? new Date(`${task.deadline}T00:00:00`).toLocaleDateString('ru-RU') : 'Без срока'}</span></div></div><aside class="growth-card-actions"><span class="growth-action-label">Управление</span>${task.status === 'ready_for_check' ? `<button class="btn btn-primary btn-sm" data-measure-task="${task.id}">Проверить эффект</button>` : ''}<button class="btn btn-ghost btn-sm" data-edit-task="${task.id}">Открыть задачу</button></aside></article>`;
}
function checkSummary(item) { if (!item) return 'Нет данных'; if (!item.mentioned) return 'Бренд не упомянут'; return `${isRecommendationRole(item.role) ? 'Рекомендация' : 'Бренд упомянут'}${item.position ? ` · ${positionText(item.position, item.positionKind || 'weighted').toLocaleLowerCase('ru-RU')}` : ''}`; }
function renderResultCard(task) {
    const tone = task.verdict === 'improved' ? 'positive' : task.verdict === 'declined' ? 'negative' : 'neutral';
    const label = task.verdict === 'improved' ? 'Предварительно улучшилось' : task.verdict === 'declined' ? 'Предварительно ухудшилось' : 'Без изменений';
    const icon = tone === 'positive' ? 'fa-arrow-trend-up' : tone === 'negative' ? 'fa-arrow-trend-down' : 'fa-equals';
    return `<article class="growth-card growth-result result-${tone}"><div class="growth-card-main"><div class="growth-result-head"><div><span class="growth-result-kicker">Результат контрольной проверки</span><div class="growth-result-verdict ${tone}"><i class="fa-solid ${icon}"></i><strong>${label}</strong></div></div><span class="growth-tag">${escapeHtml(PROVIDERS[task.provider] || task.provider)}</span></div><h3>${escapeHtml(task.title)}</h3><div class="growth-before-after"><div><span>До изменений</span><strong>${escapeHtml(checkSummary(task.baseline))}</strong><small>${task.baseline?.createdAt ? new Date(task.baseline.createdAt).toLocaleDateString('ru-RU') : 'Дата неизвестна'}</small></div><i class="fa-solid fa-arrow-right"></i><div class="growth-after"><span>После изменений</span><strong>${escapeHtml(checkSummary(task.postCheck))}</strong><small>${new Date(task.postCheck.createdAt).toLocaleDateString('ru-RU')}</small></div></div><p class="growth-disclaimer">Один контрольный запуск показывает предварительную динамику и не доказывает причинность.</p></div><aside class="growth-card-actions"><span class="growth-action-label">Подробнее</span><button class="btn btn-ghost btn-sm" data-edit-task="${task.id}">Открыть результат</button></aside></article>`;
}
function bindGrowthActions() {
    $$('[data-create-task]').forEach(button => button.addEventListener('click', () => openOpportunity(decodeURIComponent(button.dataset.createTask))));
    $$('[data-dismiss]').forEach(button => button.addEventListener('click', () => dismissOpportunity(decodeURIComponent(button.dataset.dismiss), button)));
    $$('[data-edit-task]').forEach(button => button.addEventListener('click', () => openTask(button.dataset.editTask)));
    $$('[data-quick-status]').forEach(select => select.addEventListener('change', () => updateTaskStatus(select.dataset.quickStatus, select.value)));
    $$('[data-measure-task]').forEach(button => button.addEventListener('click', () => measureTask(button.dataset.measureTask, button)));
    $$('[data-growth-view="prompts"]').forEach(button => button.addEventListener('click', () => selectView('prompts')));
    $$('[data-growth-open-tab]').forEach(button => button.addEventListener('click', () => showGrowthTab(button.dataset.growthOpenTab)));
}
function normalizeGrowthTask(task) {
    return { ...task, id: String(task.id), createdAt: task.created_at ? new Date(task.created_at).getTime() : task.createdAt || Date.now(), updatedAt: task.updated_at ? new Date(task.updated_at).getTime() : task.updatedAt || Date.now() };
}
async function dismissOpportunity(id, button) {
    button.disabled = true;
    try { await apiRequest('/dismissed-opportunities', { method: 'PUT', body: JSON.stringify({ opportunity_id: id }) }); dismissedOpportunities.add(id); renderGrowth(); }
    catch (error) { alert(`Не удалось скрыть рекомендацию: ${error.message}`); button.disabled = false; }
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
        const brief = await apiRequest('/brief', { method: 'POST', body: JSON.stringify({ brand: item.brand, query: item.query, provider: item.provider, competitors: item.competitors, checks_count: item.count, evidence }) });
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
    $('#briefContent').innerHTML = `
        <div class="brief-header">
            <div>
                <p class="app-eyebrow">${creating ? 'Новая задача' : task.status === 'measured' ? 'Измеренный результат' : 'Задача роста'}</p>
                <h2>${creating ? 'Превратить возможность в работу' : escapeHtml(task.title)}</h2>
            </div>
            <button class="brief-close" type="button" data-brief-close aria-label="Закрыть">×</button>
        </div>
        <div class="brief-body">
            <div class="brief-body-inner">
                <div class="growth-dialog-evidence">
                    <strong>Почему появилась задача</strong>
                    <p>${escapeHtml(opportunity?.description || `${evidence.count || 0} подтверждённых проверок`)}</p>
                    <dl>
                        <div><dt>Промпт</dt><dd>${escapeHtml(source.query || 'Нет связанного промпта')}</dd></div>
                        <div><dt>Модель</dt><dd>${escapeHtml(PROVIDERS[source.provider] || source.model || source.provider || 'Не указана')}</dd></div>
                        <div><dt>Конкуренты</dt><dd>${escapeHtml((evidence.competitors || []).join(', ') || 'Не обнаружены')}</dd></div>
                    </dl>
                    ${evidence.reasoning ? `<blockquote>${escapeHtml(evidence.reasoning)}</blockquote>` : ''}
                </div>
                <form id="growthTaskForm" class="growth-task-form">
                    <label>Название задачи *<input id="growthTitle" required maxlength="200" value="${escapeHtml(task?.title || opportunity?.title || '')}"></label>
                    <div class="growth-form-grid">
                        <label>Тип работы
                            <select id="growthWorkType">
                                <option value="content">Контент</option>
                                <option value="seo">SEO</option>
                                <option value="pr">PR</option>
                                <option value="technical">Техническая</option>
                            </select>
                        </label>
                        ${creating ? '' : `<label>Статус<select id="growthStatus"><option value="planned">Запланировано</option><option value="in_progress">В работе</option><option value="ready_for_check">Готово к проверке</option>${task.status === 'measured' ? '<option value="measured">Измерено</option>' : ''}</select></label>`}
                        <label>Ответственный<input id="growthOwner" maxlength="120" value="${escapeHtml(task?.owner || '')}" placeholder="Имя или роль"></label>
                        <label>Дедлайн<input id="growthDeadline" type="date" value="${escapeHtml(task?.deadline || '')}"></label>
                    </div>
                    <label>Цель<textarea id="growthGoal" rows="2" maxlength="2000">${escapeHtml(task?.goal || '')}</textarea></label>
                    <label>Что сделать *<textarea id="growthAction" required rows="5" maxlength="6000">${escapeHtml(task?.action || opportunity?.suggestedAction || '')}</textarea></label>
                    <label>Как проверить эффект<textarea id="growthVerification" rows="3" maxlength="2000">${escapeHtml(task?.verification || (source.query ? `Повторить тот же промпт в ${PROVIDERS[source.provider] || source.provider}.` : ''))}</textarea></label>
                    <div class="growth-form-grid">
                        <label>Целевой URL<input id="growthTargetUrl" type="url" value="${escapeHtml(task?.targetUrl || '')}" placeholder="https://example.com/page"></label>
                        <label>Заметки<textarea id="growthNotes" rows="2" maxlength="3000">${escapeHtml(task?.notes || '')}</textarea></label>
                    </div>
                    <p id="growthBriefStatus" class="growth-form-status">${creating ? 'Готовим AI-бриф на основе доказательств…' : ''}</p>
                </form>
            </div>
        </div>
        <div class="brief-footer">
            <div class="brief-footer-inner">
                <div class="growth-dialog-actions">
                    <button class="btn btn-ghost" type="button" data-brief-close>Отмена</button>
                    ${!creating && task.status === 'ready_for_check' ? '<button class="btn btn-ghost" type="button" id="dialogMeasureTask">Проверить эффект</button>' : ''}
                    ${!creating ? '<button class="btn btn-ghost growth-delete" type="button" id="deleteGrowthTask">Удалить</button>' : ''}
                    <button class="btn btn-primary" type="submit" form="growthTaskForm">${creating ? 'Создать задачу' : 'Сохранить изменения'}</button>
                </div>
            </div>
        </div>`;
    $('#growthWorkType').value = task?.workType || 'content';
    if (!creating) $('#growthStatus').value = task.status;
    $('#growthTaskForm').addEventListener('submit', event => { event.preventDefault(); creating ? createTaskFromDialog() : updateTaskFromDialog(); });
    $('#deleteGrowthTask')?.addEventListener('click', deleteActiveTask);
    $('#dialogMeasureTask')?.addEventListener('click', event => measureTask(task.id, event.currentTarget));
    applyAccessGating();
}

function dialogValues() { return { title: $('#growthTitle').value.trim(), workType: $('#growthWorkType').value, owner: $('#growthOwner').value.trim(), deadline: $('#growthDeadline').value, goal: $('#growthGoal').value.trim(), action: $('#growthAction').value.trim(), verification: $('#growthVerification').value.trim(), targetUrl: $('#growthTargetUrl').value.trim(), notes: $('#growthNotes').value.trim() }; }
async function createTaskFromDialog() {
    const form = $('#growthTaskForm'); if (!form.reportValidity() || !activeRecommendation) return;
    const item = activeRecommendation; const latest = item.evidenceRows.at(-1); const now = Date.now();
    const draft = { version: 1, opportunityId: item.id, brand_id: activeBrandIdentity()?.id || null, brand: item.brand, brandKey: brandKey(item.brand), query: item.query, provider: item.provider, model: item.model, problemType: item.type, ...dialogValues(), status: 'planned', createdAt: now, updatedAt: now, baseline: snapshotCheck(latest), evidence: { count: item.count, checkIds: item.evidenceRows.map(row => row.id), competitors: item.competitors, reasoning: latest.reasoning || '', quotes: item.evidenceRows.flatMap(row => row.quotes || []).slice(-5) }, postCheck: null, verdict: null };
    const submit = form.querySelector('[type="submit"]') || document.querySelector('[form="growthTaskForm"][type="submit"]'); if (submit) submit.disabled = true;
    try {
        const data = await apiRequest('/growth-tasks', { method: 'POST', body: JSON.stringify(draft) });
        growthTasks.push(normalizeGrowthTask(data.task || data)); $('#briefDialog').close(); showGrowthTab('tasks'); renderGrowth();
    } catch (error) { const status = $('#growthBriefStatus'); status.textContent = `Не удалось создать задачу: ${error.message}`; status.className = 'growth-form-status error'; }
    finally { if (submit) submit.disabled = false; }
}
function openTask(id) { const task = growthTasks.find(item => item.id === id); if (!task) return; activeRecommendation = null; activeGrowthTaskId = id; renderTaskDialog(null, task, false); $('#briefDialog').showModal(); }
async function updateTaskFromDialog() {
    const form = $('#growthTaskForm'); if (!form.reportValidity()) return;
    const task = growthTasks.find(item => item.id === activeGrowthTaskId); if (!task) return;
    const changes = { ...dialogValues(), status: task.status === 'measured' ? 'measured' : $('#growthStatus').value };
    try { const data = await apiRequest(`/growth-tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(changes) }); Object.assign(task, normalizeGrowthTask(data.task || data)); $('#briefDialog').close(); renderGrowth(); }
    catch (error) { const status = $('#growthBriefStatus'); status.textContent = `Не удалось сохранить задачу: ${error.message}`; status.className = 'growth-form-status error'; }
}
async function deleteActiveTask() {
    const task = growthTasks.find(item => item.id === activeGrowthTaskId); if (!task || !confirm(`Удалить задачу «${task.title}» навсегда?`)) return;
    try { await apiRequest(`/growth-tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' }); growthTasks = growthTasks.filter(item => item.id !== task.id); $('#briefDialog').close(); renderGrowth(); }
    catch (error) { const status = $('#growthBriefStatus'); status.textContent = `Не удалось удалить задачу: ${error.message}`; status.className = 'growth-form-status error'; }
}
function resultLevel(item) { if (!item?.mentioned) return 0; return isRecommendationRole(item.role) ? 2 : 1; }
function compareChecks(before, after) { const beforeLevel = resultLevel(before); const afterLevel = resultLevel(after); if (afterLevel > beforeLevel) return 'improved'; if (afterLevel < beforeLevel) return 'declined'; const beforePosition = Number(before?.position) || null; const afterPosition = Number(after?.position) || null; const beforeKind = before?.positionKind || 'weighted'; const afterKind = after?.positionKind || 'weighted'; if (beforePosition && afterPosition && beforeKind === afterKind && afterPosition < beforePosition) return 'improved'; if (beforePosition && afterPosition && beforeKind === afterKind && afterPosition > beforePosition) return 'declined'; return 'unchanged'; }
async function measureTask(id, button) {
    const task = growthTasks.find(item => item.id === id); if (!task || task.status !== 'ready_for_check' || !task.query) return;
    const original = button.textContent; button.disabled = true; button.textContent = 'Проверяем…';
    const errorTarget = $('#briefDialog').open ? $('#growthBriefStatus') : null;
    try {
        const identity = await ensureBrandIdentity(task.brand);
        const raw = await apiRequest('/check', { method: 'POST', body: JSON.stringify({ brand: identity.canonicalName, brand_id: identity.id, query: task.query, provider: task.provider, force_refresh: true, canonical_id: identity.canonicalId, canonical_name: identity.canonicalName, aliases: identity.aliases, domains: identity.domains }) });
        const data = canonicalizeCheckResult(raw, identity);
        const saved = saveCheck(data, task.brand, task.query, task.provider);
        await refreshAccess().catch(() => {});
        const changes = { postCheck: snapshotCheck(saved), verdict: compareChecks(task.baseline, snapshotCheck(saved)), status: 'measured' };
        const taskData = await apiRequest(`/growth-tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(changes) }); Object.assign(task, normalizeGrowthTask(taskData.task || taskData));
        if ($('#briefDialog').open) $('#briefDialog').close(); showGrowthTab('results'); renderGrowth();
    } catch (error) {
        if (errorTarget) { errorTarget.textContent = `Проверка не выполнена: ${error.message}`; errorTarget.className = 'growth-form-status error'; }
        else alert(`Проверка не выполнена: ${error.message}`);
    } finally { button.disabled = false; button.textContent = original; applyAccessGating(); }
}
function showGrowthTab(tabName) {
    $$('[data-growth-tab]').forEach(tab => { const active = tab.dataset.growthTab === tabName; tab.classList.toggle('active', active); tab.setAttribute('aria-selected', active); });
    $('#growthOpportunities').hidden = tabName !== 'opportunities'; $('#growthTasks').hidden = tabName !== 'tasks'; $('#growthResults').hidden = tabName !== 'results';
    updateGrowthSummary(Array(Number($('#opportunityCount').textContent)).fill(null), Array(Number($('#taskCount').textContent)).fill(null), Array(Number($('#resultCount').textContent)).fill(null), tabName);
}
async function updateTaskStatus(id, status) {
    const editableStatuses = ['planned', 'in_progress', 'ready_for_check'];
    if (!editableStatuses.includes(status)) return;
    const task = growthTasks.find(item => item.id === id);
    if (!task || !editableStatuses.includes(task.status) || task.status === status) return;
    try { const data = await apiRequest(`/growth-tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify({ status }) }); Object.assign(task, normalizeGrowthTask(data.task || data)); renderGrowth(); }
    catch (error) { alert(`Не удалось изменить статус: ${error.message}`); renderGrowth(); }
}
$('#briefDialog').addEventListener('click', event => { if (event.target.closest('[data-brief-close]')) $('#briefDialog').close(); });
$$('[data-growth-tab]').forEach(button => button.addEventListener('click', () => showGrowthTab(button.dataset.growthTab)));
function preferredVariant(variants) { return [...variants.entries()].sort((a, b) => b[1].count - a[1].count || a[1].order - b[1].order)[0]?.[0] || ''; }
function normalizedCompetitors() {
    const rows = new Map(); let order = 0;
    activeHistory().forEach(item => {
        const inCheck = new Map();
        (item.competitors || []).forEach(value => { const name = normalizeBrandName(value); const key = brandKey(name); if (key && key !== activeBrandKey && !inCheck.has(key)) inCheck.set(key, name); });
        inCheck.forEach((name, key) => { if (!rows.has(key)) rows.set(key, { key, mentions: 0, checks: 0, variants: new Map() }); const row = rows.get(key); row.mentions++; row.checks++; const variant = row.variants.get(name) || { count: 0, order: order++ }; variant.count++; row.variants.set(name, variant); });
    });
    return [...rows.values()].map(row => ({ ...row, name: preferredVariant(row.variants) })).sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name, 'ru'));
}

function aiAnswerRows() {
    return history.filter(item => brandKey(item.brand) === activeBrandKey).flatMap(item => {
        const providerResults = Array.isArray(item.providerResults) ? item.providerResults : Array.isArray(item.provider_results) ? item.provider_results : [];
        const results = providerResults.length ? providerResults : [item];
        return results.map((result, index) => ({
            id: `${item.id || item.createdAt}-${result.provider || item.provider || index}`,
            createdAt: item.createdAt,
            query: item.query,
            provider: result.provider || item.provider,
            model: result.model || item.model || PROVIDERS[result.provider || item.provider],
            answer: result.raw_answer || result.rawAnswer || (providerResults.length ? '' : item.raw_answer || item.rawAnswer || ''),
        }));
    }).filter(item => item.answer).sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
}

function renderAiAnswers() {
    const rows = aiAnswerRows();
    $('#aiAnswerCount').textContent = `${rows.length} ${rows.length === 1 ? 'ответ' : rows.length >= 2 && rows.length <= 4 ? 'ответа' : 'ответов'}`;
    $('#aiAnswerList').innerHTML = rows.length ? rows.map(row => {
        const providerName = PROVIDERS[row.provider] || row.model || row.provider || 'AI-модель';
        const date = row.createdAt ? new Date(row.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Дата неизвестна';
        return `<article class="ai-answer-card"><div class="ai-answer-head"><div class="ai-answer-model">${modelAvatarMarkup(row.provider, providerName)}<div><strong>${escapeHtml(providerName)}</strong><span>${escapeHtml(date)}</span></div></div><button class="btn btn-ghost btn-sm ai-answer-copy" type="button" data-copy-ai-answer="${escapeHtml(row.id)}"><i class="fa-regular fa-copy"></i>Копировать</button></div><div class="ai-answer-query"><span>Ваш запрос</span><strong>${escapeHtml(row.query || 'Запрос не сохранён')}</strong></div><div class="ai-answer-body">${escapeHtml(row.answer)}</div></article>`;
    }).join('') : '<div class="app-empty ai-answer-empty"><i class="fa-regular fa-message"></i><strong>Пока нет сохранённых ответов</strong><span>Запустите проверку — полные ответы GigaChat, Алисы, ChatGPT, Gemini и Perplexity появятся здесь.</span><button class="btn btn-primary btn-sm" type="button" data-view="prompts">Запустить проверку</button></div>';
    bindAvatarFallbacks();
    $$('[data-copy-ai-answer]').forEach(button => button.addEventListener('click', async () => {
        const row = rows.find(item => item.id === button.dataset.copyAiAnswer); if (!row) return;
        try { await navigator.clipboard.writeText(row.answer); button.innerHTML = '<i class="fa-solid fa-check"></i>Скопировано'; }
        catch { button.textContent = 'Не удалось скопировать'; }
        setTimeout(() => { button.innerHTML = '<i class="fa-regular fa-copy"></i>Копировать'; }, 1600);
    }));
    $$('#aiAnswerList [data-view]').forEach(button => button.addEventListener('click', () => selectView(button.dataset.view)));
}
function transliterateBrand(value) { const map = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya', ь: '', ъ: '' }; return normalizeBrandName(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'e').split('').map(char => map[char] ?? char).join('').replace(/[^a-z0-9]+/g, ''); }
function aliasSuggestion(name) { const own = currentBrand(); const candidate = domainText(name) ? domainText(name).split('.')[0] : name; return transliterateBrand(candidate) && transliterateBrand(candidate) === transliterateBrand(own); }
function rankedRow(name, value, detail, index, total, meta = '', avatar = '', action = '') { const width = percentage(value, total || value); return `<div class="app-data-row app-rank-row"><span class="app-rank-index">${index + 1}</span><div class="app-rank-main">${avatar}<div><strong>${escapeHtml(name)}</strong>${meta ? `<small>${escapeHtml(meta)}</small>` : ''}</div></div><div class="app-rank-result"><strong>${escapeHtml(detail)}</strong><span class="app-rank-track"><i style="width:${width}%"></i></span>${action}</div></div>`; }
function setRankingToggle(selector, expanded, count) { const button = $(selector); button.hidden = count <= 10; button.textContent = expanded ? 'Свернуть' : `Показать все · ${count}`; button.setAttribute('aria-expanded', expanded); }
function renderCompetitors() { const rows = normalizedCompetitors(); const total = activeHistory().length; const visible = competitorExpanded ? rows : rows.slice(0, 10); $('#competitorList').innerHTML = visible.length ? visible.map((row, index) => rankedRow(row.name, row.checks, `${row.mentions} упомин. · ${percentage(row.checks, total)}%`, index, total, `В ${row.checks} из ${total} проверок`, companyAvatarMarkup(row.name), `<button class="brand-merge-action${aliasSuggestion(row.name) ? ' suggested' : ''}" type="button" data-merge-alias="${encodeURIComponent(row.name)}">${aliasSuggestion(row.name) ? 'Возможный псевдоним' : 'Объединить с брендом'}</button>`)).join('') : '<div class="app-empty"><strong>Нет данных о конкурентах</strong><span>Они появятся в результатах live-проверок.</span></div>'; setRankingToggle('#competitorToggle', competitorExpanded, rows.length); bindAvatarFallbacks(); $$('[data-merge-alias]').forEach(button => button.addEventListener('click', () => mergeAliasWithActive(decodeURIComponent(button.dataset.mergeAlias)))); }
function activeBrandIdentity() { return brandIdentities.find(item => item.canonicalId === activeBrandKey) || null; }
async function mergeAliasWithActive(value) {
    const identity = activeBrandIdentity(); if (!identity || !window.confirm(`Считать «${value}» вариантом бренда «${identity.canonicalName}»? История и метрики будут пересчитаны.`)) return;
    try { await addBrandAlias(identity.canonicalId, value, domainText(value) ? 'domain' : 'alias'); renderBrandSelector(); renderAllForActiveBrand(); }
    catch (error) { showError(`Не удалось обновить бренд: ${error.message}`); }
}
function renderBrandSettings() {
    const identity = activeBrandIdentity(); if (!$('#canonicalBrandName')) return;
    $('#deleteBrand').disabled = !identity;
    if (!identity) { $('#canonicalBrandName').value = ''; $('#brandAliasList').innerHTML = '<span class="brand-settings-empty">Сначала создайте бренд через новую проверку</span>'; $('#brandDomainList').innerHTML = '<span class="brand-settings-empty">Домены пока не добавлены</span>'; $('#brandSuggestions').innerHTML = ''; return; }
    $('#canonicalBrandName').value = identity.canonicalName;
    const chip = (value, type) => `<span class="brand-chip">${escapeHtml(value)}<button type="button" aria-label="Удалить ${escapeHtml(value)}" data-remove-brand-value="${encodeURIComponent(value)}" data-brand-value-type="${type}">×</button></span>`;
    $('#brandAliasList').innerHTML = identity.aliases.length ? identity.aliases.map(value => chip(value, 'alias')).join('') : '<span class="brand-settings-empty">Других названий пока нет</span>';
    $('#brandDomainList').innerHTML = identity.domains.length ? identity.domains.map(value => chip(value, 'domain')).join('') : '<span class="brand-settings-empty">Домены пока не добавлены</span>';
    const suggestions = normalizedCompetitors().filter(row => aliasSuggestion(row.name)).slice(0, 5);
    $('#brandSuggestions').innerHTML = suggestions.length ? `<strong>Возможные варианты вашего бренда</strong><p>Подтвердите только те названия, которые действительно относятся к одной компании.</p><div class="brand-chip-list">${suggestions.map(row => `<button class="brand-suggestion-chip" type="button" data-merge-alias="${encodeURIComponent(row.name)}">${escapeHtml(row.name)} <i class="fa-solid fa-plus"></i></button>`).join('')}</div>` : '';
    $$('[data-remove-brand-value]').forEach(button => button.addEventListener('click', async () => { button.disabled = true; try { await removeBrandAlias(identity.canonicalId, decodeURIComponent(button.dataset.removeBrandValue), button.dataset.brandValueType); renderAllForActiveBrand(); } catch (error) { showError(`Не удалось обновить бренд: ${error.message}`); button.disabled = false; } }));
    $$('#brandSuggestions [data-merge-alias]').forEach(button => button.addEventListener('click', () => mergeAliasWithActive(decodeURIComponent(button.dataset.mergeAlias))));
}
async function addIdentityValue(inputSelector, type) {
    const input = $(inputSelector); const value = normalizeBrandName(input.value); const identity = activeBrandIdentity(); if (!value || !identity) return;
    try { await addBrandAlias(identity.canonicalId, value, type); input.value = ''; renderAllForActiveBrand(); }
    catch (error) { showError(`Не удалось обновить бренд: ${error.message}`); }
}
$('#addBrandAlias').addEventListener('click', () => addIdentityValue('#brandAliasInput', 'alias'));
$('#addBrandDomain').addEventListener('click', () => addIdentityValue('#brandDomainInput', 'domain'));
$('#brandAliasInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addIdentityValue('#brandAliasInput', 'alias'); } });
$('#brandDomainInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addIdentityValue('#brandDomainInput', 'domain'); } });
$('#saveCanonicalBrand').addEventListener('click', async () => {
    const identity = activeBrandIdentity(); const name = normalizeBrandName($('#canonicalBrandName').value); if (!identity || !name) return;
    const conflict = identityFor(name); if (conflict && conflict.canonicalId !== identity.canonicalId) return showError('Это название уже относится к другому бренду. Сначала удалите его из той карточки.');
    const next = { ...identity, aliases: [...identity.aliases], domains: [...identity.domains], canonicalName: name };
    if (identityText(identity.canonicalName) !== identityText(name)) next.aliases.push(identity.canonicalName);
    next.aliases = next.aliases.filter(alias => identityText(alias) !== identityText(name));
    const button = $('#saveCanonicalBrand'); button.disabled = true;
    try { await persistBrandIdentity(next); Object.assign(identity, next); history.filter(item => item.brandKey === identity.canonicalId).forEach(item => { item.brand = identity.canonicalName; item.canonicalName = identity.canonicalName; }); $('#wsBrand').value = name; renderBrandSelector(); renderAllForActiveBrand(); }
    catch (error) { showError(`Не удалось переименовать бренд: ${error.message}`); }
    finally { button.disabled = false; }
});
function sourceCategory(domain) { if (/(forbes|rbc|tass|ria|vedomosti|kommersant|lenta|gazeta|news|media)/.test(domain)) return 'СМИ'; if (/(vc\.ru|habr|reddit|forum|otzovik|irecommend)/.test(domain)) return 'Сообщество и отзывы'; if (/(wiki|catalog|yell|2gis|zoon)/.test(domain)) return 'Каталог и справочник'; return 'Профильный сайт'; }
function renderSources() {
    const counts = new Map();
    const checkCounts = new Map();
    activeHistory().flatMap(item => item.sources || []).forEach(source => {
        try {
            const value = typeof source === 'string' ? source : source.url;
            const host = new URL(value).hostname.replace(/^www\./, '');
            counts.set(host, (counts.get(host) || 0) + 1);
        } catch {}
    });
    activeHistory().forEach(item => { const domains = new Set(); (item.sources || []).forEach(source => { try { const value = typeof source === 'string' ? source : source.url; domains.add(new URL(value).hostname.replace(/^www\./, '')); } catch {} }); domains.forEach(host => checkCounts.set(host, (checkCounts.get(host) || 0) + 1)); });
    const rows = [...counts].sort((a, b) => b[1] - a[1]);
    const empty = '<div class="app-empty"><strong>Нет источников</strong><span>Они появятся после первой live-проверки.</span></div>';
    const total = activeHistory().length; const visible = sourceExpanded ? rows : rows.slice(0, 10);
    const markup = visible.length ? visible.map(([name, count], index) => rankedRow(name, checkCounts.get(name) || 0, `${count} появл. · ${percentage(checkCounts.get(name) || 0, total)}%`, index, total, sourceCategory(name), imageAvatarMarkup(name, name, 'source'))).join('') : empty;
    $('#sourceList').innerHTML = markup;
    $('#homeSourceList').innerHTML = rows.length ? rows.slice(0, 5).map(([name, count], index) => rankedRow(name, checkCounts.get(name) || 0, `${count} появл.`, index, total, sourceCategory(name), imageAvatarMarkup(name, name, 'source'))).join('') : empty;
    setRankingToggle('#sourceToggle', sourceExpanded, rows.length); bindAvatarFallbacks();
}
$$('[data-ranking-toggle]').forEach(button => button.addEventListener('click', () => { if (button.dataset.rankingToggle === 'competitors') { competitorExpanded = !competitorExpanded; renderCompetitors(); } else { sourceExpanded = !sourceExpanded; renderSources(); } }));
const dashboardCharts = {};
function destroyChart(key) { if (dashboardCharts[key]) dashboardCharts[key].destroy(); }
function percentage(value, total) { return total ? Math.round(value / total * 100) : 0; }
function answerRowsFor(item) {
    const results = selectedResults(item);
    return results.length ? results.map(result => ({ ...item, ...result, brand: item.brand, query: item.query, orderedMentions: result.ordered_mentions || result.orderedMentions || [], cited: (result.sources || []).some(source => `${source.title || ''} ${source.url || ''}`.toLowerCase().includes(item.brand.toLowerCase())), sentiments: (result.source_analysis || []).filter(analysis => analysis.mentions_brand).map(analysis => analysis.sentiment).filter(Boolean) })) : [item];
}
function orderedMentionsFor(item) {
    const supplied = Array.isArray(item.orderedMentions) ? item.orderedMentions : Array.isArray(item.ordered_mentions) ? item.ordered_mentions : [];
    if (supplied.length) {
        const mentions = canonicalizeMentionList(supplied);
        if (!hasListedCompetitors(item)) return mentions;
        const allowed = new Set([brandKey(item.brand), ...listedCompetitors(item).map(brandKey)]);
        return mentions.filter(mention => allowed.has(mention.canonical_id)).map((mention, index) => ({ ...mention, position: index + 1 }));
    }
    const names = listedCompetitors(item);
    if (item.mentioned) names.splice(Math.max(0, Math.min(names.length, (Number(item.position) || names.length + 1) - 1)), 0, normalizeBrandName(item.brand));
    const seen = new Set();
    return canonicalizeMentionList(names.filter(name => { const key = brandKey(name); if (!key || seen.has(key)) return false; seen.add(key); return true; }).map((name, index) => ({ name, observed_name: name, position: index + 1, role: brandKey(name) === brandKey(item.brand) ? item.role || 'упоминание' : 'упоминание' })));
}
function brandRows() {
    const rowsHistory = activeHistory();
    const answerRows = rowsHistory.flatMap(answerRowsFor);
    const ownName = currentBrand(); const rows = new Map([[activeBrandKey, { key: activeBrandKey, name: ownName, mentions: 0, voiceWeight: 0, positions: [], citations: 0, sentiments: [], variants: new Map([[ownName, { count: 1, order: 0 }]]) }]]); let order = 1;
    answerRows.forEach(item => {
        const own = rows.get(activeBrandKey); if (item.cited) own.citations++; own.sentiments.push(...(item.sentiments || []));
        orderedMentionsFor(item).forEach(mention => { const key = brandKey(mention.name); if (!rows.has(key)) rows.set(key, { key, name: mention.name, mentions: 0, voiceWeight: 0, positions: [], citations: 0, sentiments: [], variants: new Map() }); const row = rows.get(key); row.mentions++; row.voiceWeight += 1 / mention.position; row.positions.push(mention.position); const variant = row.variants.get(mention.name) || { count: 0, order: order++ }; variant.count++; row.variants.set(mention.name, variant); });
    });
    const totalWeight = [...rows.values()].reduce((sum, row) => sum + row.voiceWeight, 0);
    return [...rows.values()].map(row => ({ ...row, name: row.key === activeBrandKey ? ownName : preferredVariant(row.variants), sov: percentage(row.voiceWeight, totalWeight), visibility: percentage(row.mentions, answerRows.length), citationRate: percentage(row.citations, answerRows.length), averagePosition: row.positions.length ? row.positions.reduce((sum, value) => sum + value, 0) / row.positions.length : null, answerCount: answerRows.length })).sort((a, b) => b.voiceWeight - a.voiceWeight || b.mentions - a.mentions);
}
function dominantSentiment(values) { const counts = values.reduce((result, value) => ({ ...result, [value]: (result[value] || 0) + 1 }), {}); return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'Нет данных'; }
function renderMetricsDashboard() {
    const rowsHistory = activeHistory();
    const own = brandRows().find(row => brandKey(row.name) === activeBrandKey) || brandRows()[0] || { sov: 0, visibility: 0, citationRate: 0, averagePosition: null };
    $('#metricSov').textContent = `${own.sov}%`; $('#metricSovNote').textContent = rowsHistory.length ? `${own.mentions || 0} упоминаний среди брендов` : 'Нет проверок';
    $('#metricVisibility').textContent = `${own.visibility}%`; $('#metricVisibilityNote').textContent = rowsHistory.length ? `в ${own.mentions || 0} из ${own.answerCount || rowsHistory.length} ответов` : 'Нет проверок';
    $('#metricCitation').textContent = `${own.citationRate}%`; $('#metricCitationNote').textContent = rowsHistory.length ? `${own.citations || 0} ответов со ссылкой` : 'Нет проверок';
    $('#metricPosition').textContent = own.averagePosition ? Number(own.averagePosition.toFixed(2)).toString() : '—'; $('#metricPositionNote').textContent = own.averagePosition ? 'в списочных рекомендациях' : 'Нет позиций';
    renderLeaderBoard(); renderModelMetrics(); renderDashboardCharts();
}
function renderLeaderBoard() { const rows = brandRows().slice(0, 5); $('#leaderboardBody').innerHTML = activeHistory().length ? rows.map((row, index) => `<tr class="${row.key === activeBrandKey ? 'is-current' : ''}"><td>${index + 1}</td><td><span class="identity-name">${companyAvatarMarkup(row.name)}<strong>${escapeHtml(row.name)}</strong></span></td><td>${row.sov}%</td><td>${row.visibility}%</td><td>${row.mentions}</td><td>${row.averagePosition ? Number(row.averagePosition.toFixed(2)).toString() : '—'}</td><td>${row.citationRate}%</td><td>${escapeHtml(dominantSentiment(row.sentiments))}</td></tr>`).join('') : '<tr><td colspan="8" class="ws-empty-row">Запустите первую проверку — рейтинг появится здесь</td></tr>'; bindAvatarFallbacks(); }
function modelGroups() { const groups = new Map(); activeHistory().forEach(item => { const modelResults = selectedResults(item); (modelResults.length ? modelResults : [item]).forEach(result => { const provider = result.provider || ''; const name = PROVIDERS[provider] || result.model || provider; const key = provider || brandKey(name); if (!groups.has(key)) groups.set(key, { provider, name, total: 0, mentioned: 0 }); const row = groups.get(key); row.total++; if (result.mentioned) row.mentioned++; }); }); return groups; }
function modelRow(row, index, compact = false) { return `<div class="model-row${row.total < 2 ? ' low-sample' : ''}"><span class="model-rank">${index + 1}</span><div class="model-name">${modelAvatarMarkup(row.provider, row.name)}<div><strong>${escapeHtml(row.name)}</strong><small>${row.total < 2 ? 'Мало данных' : `${row.total} проверок`}</small></div></div><div class="model-score"><strong>${row.value}%</strong><span>${row.mentioned} из ${row.total}</span></div><div class="model-meter"><i style="width:${row.value}%"></i></div>${compact ? '' : `<span class="model-verdict">${row.value >= 60 ? 'Высокая видимость' : row.value >= 30 ? 'Есть потенциал' : 'Требует внимания'}</span>`}</div>`; }
function renderModelMetrics() { const groups = [...modelGroups().values()].map(row => ({ ...row, value: percentage(row.mentioned, row.total) })).sort((a, b) => b.value - a.value || b.total - a.total); const empty = '<div class="app-empty"><strong>Нет данных по моделям</strong><span>Запустите проверки в нужных AI-моделях.</span></div>'; $('#modelMetrics').innerHTML = groups.length ? groups.map((row, index) => modelRow(row, index, true)).join('') : empty; $('#visibilityMetrics').innerHTML = groups.length ? groups.map((row, index) => modelRow(row, index)).join('') : ''; $('#visibilityEmpty').hidden = Boolean(groups.length); const best = groups[0]; $('#visibilityInsight').textContent = best ? `Лидер: ${best.name} · ${best.value}%` : 'Нужны проверки'; }
function renderExclusivity() { const mentioned = activeHistory().filter(item => item.mentioned); const exclusive = mentioned.filter(item => !(item.competitors || []).length).length; const compared = mentioned.length - exclusive; $('#exclusivityMetrics').innerHTML = `<div class="app-data-row"><strong>Эксклюзивное упоминание</strong><span>${percentage(exclusive, mentioned.length)}% · ${exclusive} ответов</span></div><div class="app-data-row"><strong>В сравнении с конкурентами</strong><span>${percentage(compared, mentioned.length)}% · ${compared} ответов</span></div>`; }
function chartTheme() {
    const style = getComputedStyle(document.querySelector('.app-body') || document.documentElement);
    return { accent: style.getPropertyValue('--accent').trim(), accent2: style.getPropertyValue('--accent-2').trim(), ok: style.getPropertyValue('--ok').trim(), warn: style.getPropertyValue('--warn').trim(), night: style.getPropertyValue('--night').trim(), text: style.getPropertyValue('--text').trim(), muted: style.getPropertyValue('--text-soft').trim(), border: style.getPropertyValue('--border').trim(), soft: style.getPropertyValue('--bg-soft').trim(), surface: style.getPropertyValue('--surface').trim() };
}
function chartDate(item, index) {
    if (!item?.createdAt) return `Проверка ${index + 1}`;
    return new Date(item.createdAt).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function sovTimeline(rowsHistory, brandKeys) {
    const weights = new Map();
    let totalWeight = 0;
    const series = new Map(brandKeys.map(key => [key, []]));
    rowsHistory.forEach(item => {
        answerRowsFor(item).forEach(answer => orderedMentionsFor(answer).forEach(mention => { const key = brandKey(mention.name); const weight = 1 / mention.position; weights.set(key, (weights.get(key) || 0) + weight); totalWeight += weight; }));
        brandKeys.forEach(key => series.get(key).push(percentage(weights.get(key) || 0, totalWeight)));
    });
    return series;
}
function lineGradient(chart, color) {
    const { ctx, chartArea } = chart;
    if (!chartArea) return color;
    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0, color);
    gradient.addColorStop(.42, color);
    gradient.addColorStop(1, 'transparent');
    return gradient;
}
const centerLabelPlugin = { id: 'centerLabel', beforeDatasetsDraw(chart, args, options) { if (!options?.label) return; const { ctx, chartArea } = chart; const x = (chartArea.left + chartArea.right) / 2; const y = (chartArea.top + chartArea.bottom) / 2; ctx.save(); ctx.textAlign = 'center'; ctx.fillStyle = options.color; ctx.font = '800 26px Inter'; ctx.fillText(options.label, x, y - 2); ctx.fillStyle = options.muted; ctx.font = '600 11px Inter'; ctx.fillText(options.caption, x, y + 17); ctx.restore(); } };
function renderDashboardCharts() {
    if (!window.Chart) return;
    const rowsHistory = activeHistory(); const theme = chartTheme(); const allRows = brandRows(); const own = allRows.find(row => row.key === activeBrandKey) || allRows[0]; const rows = [own, ...allRows.filter(row => row.key !== activeBrandKey).slice(0, 4)].filter(Boolean);
    destroyChart('trend'); destroyChart('sov');
    const hasHistory = rowsHistory.length > 0;
    const hasTrend = rowsHistory.length > 1;
    $('#overviewChart').hidden = !hasTrend; $('#overviewEmpty').hidden = hasTrend;
    $('#sovChart').hidden = !hasHistory; $('#sovEmpty').hidden = hasHistory; $('#sovLegend').hidden = !hasHistory;
    $('#sovLegend').parentElement.classList.toggle('is-empty', !hasHistory);
    if (!hasHistory) {
        $('#overviewInsight').textContent = 'Начните с проверки';
        $('#sovInsight').textContent = 'Данные появятся здесь';
        return;
    }
    const trendSeries = sovTimeline(rowsHistory, rows.map(row => row.key));
    const ownTrend = own ? trendSeries.get(activeBrandKey) || [] : [];
    const trendDelta = ownTrend.length > 1 ? ownTrend.at(-1) - ownTrend[0] : 0;
    const leader = allRows[0]; $('#overviewInsight').textContent = own ? `${rowsHistory.length} проверок · ${trendDelta >= 0 ? '+' : ''}${trendDelta} п.п. · лидер ${leader?.name || '—'}` : 'Нужны проверки';
    if (!hasTrend) {
        $('#overviewInsight').textContent = 'Нужна ещё 1 проверка';
        $('#overviewEmpty').querySelector('strong').textContent = 'Для динамики нужны две проверки';
        $('#overviewEmpty').querySelector('p').textContent = 'Повторите проверку позже — мы сравним изменения и покажем тренд.';
    } else dashboardCharts.trend = new Chart($('#overviewChart'), {
        type: 'line',
        data: { labels: rowsHistory.map(chartDate), datasets: rows.map((row, datasetIndex) => {
            const isOwn = brandKey(row.name) === activeBrandKey;
            const comparisonColor = [theme.accent2, theme.ok, theme.warn, theme.muted][datasetIndex - 1] || theme.muted;
            return { label: row.name, data: trendSeries.get(row.key) || [], borderColor: isOwn ? theme.accent : comparisonColor, backgroundColor: isOwn ? theme.accent : comparisonColor, borderWidth: isOwn ? 3 : 1.5, borderDash: isOwn ? [] : [5, 5], tension: .28, cubicInterpolationMode: 'monotone', fill: false, pointRadius: context => isOwn || context.dataIndex === rowsHistory.length - 1 ? 3 : 0, pointHoverRadius: 6, pointBorderWidth: 2, pointBorderColor: theme.surface, pointBackgroundColor: isOwn ? theme.accent : comparisonColor };
        }) },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'top', align: 'start', labels: { usePointStyle: true, pointStyle: 'line', boxWidth: 22, padding: 18, color: theme.text, font: { size: 10, weight: '600' } } }, tooltip: { backgroundColor: theme.surface, titleColor: theme.text, bodyColor: theme.text, borderColor: theme.border, borderWidth: 1, cornerRadius: 8, padding: 10, displayColors: true, usePointStyle: true, callbacks: { title: contexts => { const index = contexts[0]?.dataIndex || 0; const item = rowsHistory[index]; const date = item?.createdAt ? new Date(item.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Дата неизвестна'; return `Проверка ${index + 1} · ${date}`; }, beforeBody: contexts => { const item = rowsHistory[contexts[0]?.dataIndex || 0]; return [`${PROVIDERS[item?.provider] || item?.model || item?.provider || 'AI-модель'}`, item?.query ? `Запрос: ${item.query}` : '']; }, label: context => ` ${context.dataset.label}: ${context.parsed.y}%` } } }, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: theme.muted, maxTicksLimit: 6, font: { size: 10, weight: '600' } } }, y: { min: 0, max: 100, border: { display: false }, ticks: { stepSize: 25, color: theme.muted, callback: value => `${value}%`, font: { size: 10 } }, grid: { color: theme.border, drawTicks: false } } } }
    });
    const ownRank = own ? allRows.findIndex(row => row.key === activeBrandKey) + 1 : 0;
    $('#sovInsight').textContent = own ? `#${ownRank} в нише · ${own.sov}% SoV` : 'Нужны проверки';
    const sovSelected = [own, ...allRows.filter(row => row.key !== activeBrandKey).slice(0, 3)].filter(Boolean); const selectedKeys = new Set(sovSelected.map(row => row.key)); const otherWeight = allRows.filter(row => !selectedKeys.has(row.key)).reduce((sum, row) => sum + row.voiceWeight, 0); const sovRows = otherWeight ? [...sovSelected, { key: 'other', name: 'Остальные', voiceWeight: otherWeight }] : sovSelected; const totalWeight = allRows.reduce((sum, row) => sum + row.voiceWeight, 0);
    $('#sovLegend').innerHTML = sovRows.map((row, index) => `<div><i data-sov-color="${index}"></i><span class="identity-name">${row.key === 'other' ? monogramMarkup(row.name) : companyAvatarMarkup(row.name)}<span>${escapeHtml(row.name)}</span></span><strong>${percentage(row.voiceWeight, totalWeight)}%</strong></div>`).join(''); bindAvatarFallbacks();
    dashboardCharts.sov = new Chart($('#sovChart'), {
        type: 'doughnut', data: { labels: sovRows.map(row => row.name), datasets: [{ data: sovRows.map(row => row.voiceWeight), backgroundColor: sovRows.map((row, index) => row.key === activeBrandKey ? theme.accent : index === 1 ? theme.accent2 : index === 2 ? theme.muted : index === 3 ? theme.border : theme.soft), borderColor: theme.surface, borderWidth: 5, hoverOffset: 0, spacing: 2 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '76%', rotation: -95, circumference: 360, layout: { padding: 2 }, plugins: { centerLabel: { label: own ? `${own.sov}%` : '—', caption: `место #${ownRank}`, color: theme.text, muted: theme.muted }, legend: { display: false }, tooltip: { displayColors: false, backgroundColor: theme.night, titleColor: theme.surface, bodyColor: theme.surface, caretPadding: 8, cornerRadius: 8, padding: 11, callbacks: { title: contexts => contexts[0]?.label || '', label: context => `${percentage(context.raw, totalWeight)}% доли голоса` } } } }, plugins: [centerLabelPlugin]
    });
}
async function refreshChecks(render = true) {
    const data = await apiRequest('/checks');
    history = (Array.isArray(data.checks) ? data.checks : []).map(normalizeStoredCheck).sort((a, b) => a.createdAt - b.createdAt);
    if (render) renderAllForActiveBrand();
}
async function deleteCheck(id) {
    const item = history.find(row => row.id === id); if (!item || !confirm(`Удалить проверку «${item.query}» навсегда?`)) return;
    try { await apiRequest(`/checks/${encodeURIComponent(id)}`, { method: 'DELETE' }); history = history.filter(row => row.id !== id); renderAllForActiveBrand(); }
    catch (error) { showError(`Не удалось удалить проверку: ${error.message}`); }
}
async function deleteActiveBrand() {
    const identity = activeBrandIdentity(); if (!identity || !confirm(`Удалить бренд «${identity.canonicalName}» вместе со всеми проверками и задачами?`)) return;
    const button = $('#deleteBrand'); button.disabled = true;
    try {
        await apiRequest(`/brands/${encodeURIComponent(identity.id)}`, { method: 'DELETE' });
        brandIdentities = brandIdentities.filter(item => item.canonicalId !== identity.canonicalId);
        history = history.filter(item => item.brandKey !== identity.canonicalId);
        growthTasks = growthTasks.filter(item => brandKey(item.brand) !== identity.canonicalId && item.brandKey !== identity.canonicalId);
        activeBrandKey = brandIdentities[0]?.canonicalId || '';
        if (activeBrandKey) localStorage.setItem(ACTIVE_BRAND_KEY, activeBrandKey); else localStorage.removeItem(ACTIVE_BRAND_KEY);
        $('#wsBrand').value = currentBrand(); renderBrandSelector(); renderAllForActiveBrand();
        await refreshAccess().catch(() => {});
    } catch (error) { showError(`Не удалось удалить бренд: ${error.message}`); button.disabled = false; }
}
function setFormStatus(selector, message, success = false) { const target = $(selector); target.textContent = message; target.className = `account-form-status${success ? ' success' : message ? ' error' : ''}`; }
async function saveAccount(event) {
    event.preventDefault();
    const form = event.currentTarget; if (!form.reportValidity() || !accountState) return;
    const name = $('#accountName').value.trim();
    const body = {};
    if (name !== accountState.name) body.name = name;
    if (!Object.keys(body).length) return setFormStatus('#accountProfileStatus', 'Нет изменений для сохранения.', true);
    const button = form.querySelector('[type="submit"]'); button.disabled = true; setFormStatus('#accountProfileStatus', '');
    try {
        const data = await apiRequest('/account', { method: 'PATCH', body: JSON.stringify(body) });
        accountState = normalizeAccount(data.account || data);
        renderAccountProfile();
        setFormStatus('#accountProfileStatus', 'Профиль сохранён.', true);
    } catch (error) { setFormStatus('#accountProfileStatus', error.message); }
    finally { button.disabled = false; }
}
async function changeEmail(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity() || !accountState) return;
    const email = $('#accountEmailNew').value.trim();
    if (email.toLocaleLowerCase('ru-RU') === String(accountState.email || '').toLocaleLowerCase('ru-RU')) return setFormStatus('#accountEmailStatus', 'Укажите новый email.');
    const button = form.querySelector('[type="submit"]'); button.disabled = true; setFormStatus('#accountEmailStatus', '');
    try {
        const data = await apiRequest('/account', { method: 'PATCH', body: JSON.stringify({ email, current_password: $('#accountEmailCurrentPassword').value }) });
        accountState = normalizeAccount(data.account || data);
        renderAccountProfile();
        form.reset();
        if (data.reauth_required) { setFormStatus('#accountEmailStatus', 'Email изменён. Выполняется повторный вход…', true); setTimeout(() => window.location.replace('index.html?auth=login'), 500); return; }
        setFormStatus('#accountEmailStatus', 'Email изменён.', true);
    } catch (error) { setFormStatus('#accountEmailStatus', error.message); }
    finally { button.disabled = false; }
}
async function changePassword(event) {
    event.preventDefault();
    const form = event.currentTarget; const currentPassword = $('#accountPasswordCurrent').value; const newPassword = $('#accountPasswordNew').value; const confirmation = $('#accountPasswordConfirm').value;
    $('#accountPasswordConfirm').setCustomValidity(newPassword === confirmation ? '' : 'Пароли не совпадают');
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]'); button.disabled = true; setFormStatus('#accountPasswordStatus', '');
    try {
        const data = await apiRequest('/account', { method: 'PATCH', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) });
        if (data.reauth_required) { setFormStatus('#accountPasswordStatus', 'Пароль изменён. Выполняется повторный вход…', true); setTimeout(() => window.location.replace('index.html?auth=login'), 500); return; }
        form.reset(); setFormStatus('#accountPasswordStatus', 'Пароль изменён.', true);
    } catch (error) { setFormStatus('#accountPasswordStatus', error.message); }
    finally { button.disabled = false; }
}
async function deleteAccount(event) {
    event.preventDefault();
    const form = event.currentTarget; if (!form.reportValidity()) return;
    if ($('#deleteAccountConfirmation').value !== 'УДАЛИТЬ') return setFormStatus('#deleteAccountStatus', 'Введите УДАЛИТЬ без кавычек.');
    if (!confirm('Удалить аккаунт и все данные Vidno навсегда? Это действие нельзя отменить.')) return;
    const button = $('#deleteAccount'); button.disabled = true; setFormStatus('#deleteAccountStatus', '');
    try { await apiRequest('/account', { method: 'DELETE', body: JSON.stringify({ current_password: $('#deleteAccountPassword').value, confirmation: 'УДАЛИТЬ' }) }); localStorage.removeItem(ACTIVE_BRAND_KEY); window.location.replace('index.html'); }
    catch (error) { setFormStatus('#deleteAccountStatus', error.message); button.disabled = false; }
}
function normalizeAdminAccount(value = {}) { return { id: String(value.id || ''), name: value.name || '', email: value.email || '', role: value.role || 'client', createdAt: value.created_at || value.createdAt || null }; }
function adminClientMarkup(item) {
    const account = normalizeAdminAccount(item.account || item.client || item);
    const access = normalizeAccess(item.access || item);
    const brand = item.brand || item.brand_name || (Array.isArray(item.brands) ? item.brands[0]?.canonical_name || item.brands[0]?.name : '');
    return `<button class="admin-client-item${selectedAdminClientId === account.id ? ' active' : ''}" type="button" data-admin-client="${escapeHtml(account.id)}"><span><strong>${escapeHtml(account.name || 'Без имени')}</strong><small>${escapeHtml(account.email)}</small>${brand ? `<small>${escapeHtml(brand)}</small>` : ''}</span><span><i class="access-status-badge" data-status="${escapeHtml(access.status)}">${escapeHtml(statusLabelAccess(access.status))}</i><small>${escapeHtml(planLabel(access.plan))}</small></span></button>`;
}
async function loadAdminClients(page = adminPage) {
    if (accountState?.role !== 'admin') return;
    adminPage = Math.max(1, page);
    const params = new URLSearchParams({ page: String(adminPage), page_size: '20' });
    const search = $('#adminSearch').value.trim(); const status = $('#adminStatusFilter').value; const plan = $('#adminPlanFilter').value;
    if (search) params.set('q', search); if (status) params.set('status', status); if (plan) params.set('plan', plan);
    const list = $('#adminClientList'); list.innerHTML = '<div class="admin-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Загружаем клиентов…</div>';
    try {
        const data = await apiRequest(`/admin/clients?${params}`);
        const items = Array.isArray(data.items) ? data.items : Array.isArray(data.clients) ? data.clients : [];
        const total = Math.max(0, Number(data.total) || items.length); const pageSize = Math.max(1, Number(data.page_size || data.pageSize) || 20);
        adminPage = Math.max(1, Number(data.page) || adminPage); adminTotalPages = Math.max(1, Math.ceil(total / pageSize));
        $('#adminClientCount').textContent = `${total} пользовател${total % 10 === 1 && total % 100 !== 11 ? 'ь' : total % 10 >= 2 && total % 10 <= 4 && (total % 100 < 10 || total % 100 >= 20) ? 'я' : 'ей'}`;
        $('#adminPageLabel').textContent = `${adminPage} из ${adminTotalPages}`; $('#adminPrevPage').disabled = adminPage <= 1; $('#adminNextPage').disabled = adminPage >= adminTotalPages;
        list.innerHTML = items.length ? items.map(adminClientMarkup).join('') : '<div class="app-empty"><strong>Пользователи не найдены</strong><span>Измените поиск или фильтры.</span></div>';
        $$('[data-admin-client]').forEach(button => button.addEventListener('click', () => loadAdminClient(button.dataset.adminClient)));
    } catch (error) { list.innerHTML = `<div class="admin-error">${escapeHtml(error.message)}</div>`; }
}
async function loadAdminClient(id) {
    selectedAdminClientId = String(id); $('#adminClientEditor').innerHTML = '<div class="admin-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Загружаем профиль…</div>';
    try {
        const data = await apiRequest(`/admin/clients/${encodeURIComponent(id)}`);
        renderAdminClient(data.account || data.client || data, data.access || data);
        $$('[data-admin-client]').forEach(button => button.classList.toggle('active', button.dataset.adminClient === selectedAdminClientId));
    } catch (error) { $('#adminClientEditor').innerHTML = `<div class="admin-error">${escapeHtml(error.message)}</div>`; }
}
function nullableLimitValue(quota) { return quota.limit === null ? '' : String(quota.limit); }
function renderAdminClient(accountValue, accessValue) {
    const account = normalizeAdminAccount(accountValue); const access = normalizeAccess(accessValue); const expires = parseDate(access.expiresAt);
    $('#adminClientEditor').innerHTML = `<div class="app-card-head"><div><h2>${escapeHtml(account.name || 'Без имени')}</h2><span>${escapeHtml(account.email)}</span></div><span class="account-role">${account.role === 'admin' ? 'Администратор' : 'Клиент'}</span></div><dl class="account-access-meta admin-client-meta"><div><dt>ID</dt><dd>${escapeHtml(account.id)}</dd></div><div><dt>Регистрация</dt><dd>${formatDate(account.createdAt, '—')}</dd></div><div><dt>Использование</dt><dd>Проверки: ${escapeHtml(quotaText(access.checks))}<br>Бренды: ${escapeHtml(quotaText(access.brands))}</dd></div></dl><form class="admin-access-form" id="adminAccessForm"><label>Статус<select id="adminAccessStatus"><option value="pending">Ожидает</option><option value="active">Активен</option><option value="suspended">Приостановлен</option></select></label><label>Тариф<select id="adminAccessPlan"><option value="basic">Basic</option><option value="pro">Pro</option><option value="business">Business</option><option value="custom">Custom</option></select></label><label>Доступ до<input id="adminAccessExpires" type="date" value="${expires ? expires.toISOString().slice(0, 10) : ''}"><small>Оставьте пустым для бессрочного доступа</small></label><div class="admin-limit"><label>Лимит проверок<input id="adminChecksLimit" type="number" min="0" step="1" value="${nullableLimitValue(access.checks)}"></label><label class="admin-unlimited"><input id="adminChecksUnlimited" type="checkbox"${access.checks.unlimited ? ' checked' : ''}>Безлимит</label></div><div class="admin-limit"><label>Лимит брендов<input id="adminBrandsLimit" type="number" min="0" step="1" value="${nullableLimitValue(access.brands)}"></label><label class="admin-unlimited"><input id="adminBrandsUnlimited" type="checkbox"${access.brands.unlimited ? ' checked' : ''}>Безлимит</label></div><label class="admin-reset"><input id="adminResetUsage" type="checkbox">Сбросить текущее использование квот</label><p class="account-form-status" id="adminAccessStatusMessage" role="status"></p><button class="btn btn-primary" type="submit">Сохранить доступ</button></form>`;
    $('#adminAccessStatus').value = access.administrativeStatus === 'suspended' ? 'suspended' : access.administrativeStatus === 'active' ? 'active' : 'pending'; $('#adminAccessPlan').value = access.plan;
    const syncUnlimited = (checkbox, input) => { $(input).disabled = $(checkbox).checked; $(checkbox).addEventListener('change', () => { $(input).disabled = $(checkbox).checked; if (!$(checkbox).checked && !$(input).value) $(input).value = '0'; }); };
    syncUnlimited('#adminChecksUnlimited', '#adminChecksLimit'); syncUnlimited('#adminBrandsUnlimited', '#adminBrandsLimit');
    $('#adminAccessForm').addEventListener('submit', saveAdminAccess);
}
async function saveAdminAccess(event) {
    event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity() || !selectedAdminClientId) return;
    const expiresDate = $('#adminAccessExpires').value;
    const body = { status: $('#adminAccessStatus').value, plan: $('#adminAccessPlan').value, expires_at: expiresDate ? `${expiresDate}T23:59:59.999Z` : null, checks_limit: $('#adminChecksUnlimited').checked ? null : Number($('#adminChecksLimit').value), brands_limit: $('#adminBrandsUnlimited').checked ? null : Number($('#adminBrandsLimit').value), reset_usage: $('#adminResetUsage').checked };
    const button = form.querySelector('[type="submit"]'); button.disabled = true; setFormStatus('#adminAccessStatusMessage', '');
    try { const data = await apiRequest(`/admin/clients/${encodeURIComponent(selectedAdminClientId)}/access`, { method: 'PATCH', body: JSON.stringify(body) }); renderAdminClient(data.account || data.client || data, data.access || data); setFormStatus('#adminAccessStatusMessage', 'Настройки доступа сохранены.', true); await loadAdminClients(adminPage); }
    catch (error) { setFormStatus('#adminAccessStatusMessage', error.message); button.disabled = false; }
}
async function initializeDashboard() {
    try {
        await window.vidnoSessionPromise;
        const [accountData, accessData] = await Promise.all([apiRequest('/account'), apiRequest('/access')]);
        accountState = normalizeAccount(accountData.account || accountData);
        accessState = normalizeAccess(accessData.access || accessData);
        renderAccountProfile(); renderAccountAccess(); renderAccessBanner(); applyAccessGating();
        const brandData = await apiRequest('/brands');
        brandIdentities = (Array.isArray(brandData.brands) ? brandData.brands : []).map(normalizeBrandRecord).filter(item => item.canonicalId && item.canonicalName);
        activeBrandKey = loadActiveBrandKey();
        const [checkData, taskData, dismissedData] = await Promise.all([apiRequest('/checks'), apiRequest('/growth-tasks'), apiRequest('/dismissed-opportunities')]);
        history = (Array.isArray(checkData.checks) ? checkData.checks : []).map(normalizeStoredCheck).sort((a, b) => a.createdAt - b.createdAt);
        growthTasks = (Array.isArray(taskData.tasks) ? taskData.tasks : []).map(normalizeGrowthTask);
        dismissedOpportunities = new Set(Array.isArray(dismissedData.items) ? dismissedData.items : []);
        $('#wsBrand').value = currentBrand(); renderBrandSelector(); renderAllForActiveBrand();
        document.body.classList.remove('auth-pending');
    } catch (error) {
        if (!location.search.includes('auth=login')) { document.body.classList.remove('auth-pending'); showError(`Не удалось загрузить данные кабинета: ${error.message}`); }
    }
}
$('#deleteBrand').addEventListener('click', deleteActiveBrand);
$('#accountProfileForm').addEventListener('submit', saveAccount);
$('#accountEmailForm').addEventListener('submit', changeEmail);
$('#accountPasswordForm').addEventListener('submit', changePassword);
$('#accountPasswordConfirm').addEventListener('input', () => $('#accountPasswordConfirm').setCustomValidity(''));
window.addEventListener('vidno-theme-change', () => { if (accountState) renderAllForActiveBrand(); });
$('#deleteAccountForm').addEventListener('submit', deleteAccount);
$('#adminFilters').addEventListener('submit', event => { event.preventDefault(); loadAdminClients(1); });
$('#adminPrevPage').addEventListener('click', () => loadAdminClients(adminPage - 1));
$('#adminNextPage').addEventListener('click', () => loadAdminClients(adminPage + 1));
initializeDashboard();
