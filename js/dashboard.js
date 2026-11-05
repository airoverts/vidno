const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const API_BASE = AUTH_API_BASE;
const PROVIDERS = { all: 'Все модели', gigachat: 'GigaChat', yandex: 'Алиса AI', openai: 'ChatGPT', gemini: 'Gemini', perplexity: 'Perplexity', deepseek: 'DeepSeek' };
const PROVIDER_ICONS = { gigachat: 'assets/ai/gigachat.svg', yandex: 'assets/ai/alice-ai.svg', openai: 'assets/ai/openai.svg', gemini: 'assets/ai/gemini-color.svg', perplexity: 'assets/ai/perplexity.svg', deepseek: 'assets/ai/deepseek.svg' };
const CHECK_PROVIDERS = ['gigachat', 'yandex', 'openai', 'gemini', 'perplexity', 'deepseek'];
const ACTIVE_BRAND_KEY = 'vidno-dashboard-active-brand';
const ANALYSIS_VERSION = 'perplexity-direct-v1';
const IDENTITY_NORMALIZATION_VERSION = 'company-options-v1';
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
let adminTariffs = [];
let adminTariffsLoad = null;
const adminTariffSaves = new Set();
let selectedVoucherBatchId = null;
let voucherActivating = false;
let voucherActivationSucceeded = false;
let voucherActivationOutcomeUnknown = false;
let voucherBatchCreating = false;
let dashboardReady = false;
let dashboardInitializing = false;
let dashboardSessionAttempted = false;
let checkInFlight = false;
let checkOutcomeUnknown = false;
let pendingCheckContext = null;
let onboardingBrandSaving = false;
let onboardingBrandOutcomeUnknown = false;
let pendingBrandContext = null;
let onboardingSuggestionsBusy = false;
let trackedCheckId = null;
let checkPollTimer = null;
let checkPolling = false;
let selectedCheckId = null;
let answerCheckId = null;
let reportCheckId = null;
let historyExpanded = false;
const analyticsPeriod = { preset: 'all', start: '', end: '' };
const checksLoadState = { loading: false, error: '', updatedAt: null };
const reportState = { key: '', data: null, error: '', notice: '', loading: false, downloading: false, previewController: null, downloadController: null };
let projectDraft = null;
let projectSaving = false;
let pendingProjectNavigation = null;
let bypassProjectGuard = false;
let accountMutationBusy = false;
let projectDeleting = false;

function moscowDay(value = Date.now()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}
function shiftDay(day, amount) { return new Date(Date.parse(`${day}T00:00:00Z`) + amount * 86400000).toISOString().slice(0, 10); }
function analyticsBounds() {
    if (analyticsPeriod.preset === 'all') return { start: -Infinity, end: Infinity, label: 'Всё время · даты по Москве' };
    const end = analyticsPeriod.preset === 'custom' ? analyticsPeriod.end : moscowDay();
    const start = analyticsPeriod.preset === 'custom' ? analyticsPeriod.start : shiftDay(end, 1 - Number(analyticsPeriod.preset));
    const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!valid(start) || !valid(end) || start > end) return { error: 'Выберите корректные даты: начало не позднее конца периода.' };
    const label = value => value.split('-').reverse().join('.');
    return { start: Date.parse(`${start}T00:00:00+03:00`), end: Date.parse(`${shiftDay(end, 1)}T00:00:00+03:00`), label: `${label(start)} — ${label(end)} · даты по Москве` };
}
function analyticsRecords() {
    const bounds = analyticsBounds();
    return bounds.error ? [] : historyForActiveBrand().filter(item => item.createdAt >= bounds.start && item.createdAt < bounds.end && (item.provider === 'all' || selectedProviders.has(item.provider)));
}
function analyticsHistory() {
    const records = analyticsRecords().map(item => item.provider === 'all' ? { ...item, providerResults: item.providerResults.filter(hasCurrentAnalysis) } : item);
    return activeHistory(records).filter(item => item.provider !== 'all' || selectedResults(item).length).map(item => ({ ...item, sources: answerRowsFor(item).flatMap(answer => answer.sources || []) }));
}
function syncAnalyticsFilters() {
    const bounds = analyticsBounds();
    $$('[data-analytics-period]').forEach(input => { input.value = analyticsPeriod.preset; });
    $$('[data-analytics-start]').forEach(input => { input.value = analyticsPeriod.start; });
    $$('[data-analytics-end]').forEach(input => { input.value = analyticsPeriod.end; });
    $$('[data-analytics-dates]').forEach(element => { element.hidden = analyticsPeriod.preset !== 'custom'; });
    $$('[data-analytics-error]').forEach(element => { element.textContent = bounds.error || ''; element.hidden = !bounds.error; });
    $$('[data-report-provider]').forEach(input => { input.checked = selectedProviders.has(input.dataset.reportProvider); });
}
$$('[data-analytics-period]').forEach(input => input.addEventListener('change', () => {
    analyticsPeriod.preset = input.value;
    if (input.value === 'custom' && !analyticsPeriod.start) { analyticsPeriod.end = moscowDay(); analyticsPeriod.start = shiftDay(analyticsPeriod.end, -29); }
    renderAllForActiveBrand();
}));
$$('[data-analytics-start], [data-analytics-end]').forEach(input => input.addEventListener('change', () => {
    analyticsPeriod[input.hasAttribute('data-analytics-start') ? 'start' : 'end'] = input.value;
    renderAllForActiveBrand();
}));
$$('[data-report-provider]').forEach(input => input.addEventListener('change', () => {
    const provider = input.dataset.reportProvider;
    if (input.checked) selectedProviders.add(provider); else selectedProviders.delete(provider);
    if (!selectedProviders.size) selectedProviders.add(provider);
    updateProviderFilter(); renderAllForActiveBrand();
}));

class ApiError extends Error {
    constructor(message, status, code = '', details = {}) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; this.details = details; }
}

function capability(name, fallback = false) { return accessState ? Boolean(accessState.capabilities?.[name]) : fallback; }
function requiredCapability(path, method) {
    if (method === 'GET' || method === 'HEAD') return '';
    if (/^\/(?:account|admin\/|auth\/)/.test(path)) return '';
    if (path === '/vouchers/redeem') return '';
    if (/^\/check(?:-all)?$/.test(path)) return 'run_checks';
    if (path === '/brands' && method === 'POST') return 'create_brands';
    if (/^\/brands\//.test(path)) return 'manage_existing_brands';
    return 'workspace_write';
}
function accessBlockedMessage(name) {
    if (accessState?.status === 'pending') return accessState.canRedeemVoucher ? 'Доступ ещё не активирован. Введите ваучер в кабинете или обратитесь к администратору.' : 'Доступ ещё не активирован. Обратитесь к администратору. Сохранённые данные доступны для просмотра.';
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
    if (location.protocol === 'file:') throw new Error(LOCAL_FILE_MESSAGE);
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
function sourceHost(value) { try { return new URL(String(value || '')).hostname.toLocaleLowerCase('ru-RU').replace(/^www\./, '').replace(/\.$/, ''); } catch { return ''; } }
function sourceMatchesDomain(source, domain) { const host = sourceHost(typeof source === 'string' ? source : source?.url); const official = domainText(domain); return Boolean(host && official && (host === official || host.endsWith(`.${official}`))); }
function resultCitesIdentity(result, identity) {
    if (hasIdentitySnapshot(result) && typeof result?.brand_cited === 'boolean') return result.brand_cited;
    if (!identity?.domains?.length) return false;
    if (typeof result?.brand_cited === 'boolean') return result.brand_cited;
    if (typeof result?.brandCited === 'boolean') return result.brandCited;
    return (result?.sources || []).some(source => source?.cited_in_answer !== false && identity.domains.some(domain => sourceMatchesDomain(source, domain)));
}
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
function hasIdentitySnapshot(item) { return item?.identity_normalization_version === IDENTITY_NORMALIZATION_VERSION; }
function mentionIdentityKey(mention) { return hasIdentitySnapshot(mention) ? mention.canonical_id : brandKey(mention.name); }
function hasListedCompetitors(item) { return Array.isArray(item?.competitors) || Array.isArray(item?.mentioned_brands) || Array.isArray(item?.mentionedBrands); }
function listedCompetitors(item) {
    if (hasIdentitySnapshot(item)) return canonicalizeMentionList(item.ordered_mentions || item.orderedMentions || [], true).filter(mention => mention.canonical_id !== (item.canonical_id || item.canonicalId)).map(mention => mention.canonical_name);
    const values = Array.isArray(item?.competitors) ? item.competitors : Array.isArray(item?.mentioned_brands) ? item.mentioned_brands : Array.isArray(item?.mentionedBrands) ? item.mentionedBrands : [];
    const seen = new Set();
    return values.map(value => plausibleBrandName(typeof value === 'string' ? value : value?.name || value?.company || value?.brand)).filter(name => {
        const key = brandKey(name); if (!key || seen.has(key)) return false; seen.add(key); return true;
    });
}
function historyForActiveBrand() { return history.filter(item => (hasIdentitySnapshot(item) ? item.canonicalId : brandKey(item.brand)) === activeBrandKey); }
function enrichCompetitors(item) {
    if (hasIdentitySnapshot(item)) return { ...item, competitors: listedCompetitors(item) };
    const ownKey = brandKey(item.brand);
    const competitors = listedCompetitors(item).filter(name => brandKey(name) !== ownKey);
    return { ...item, competitors };
}
function activeHistory(records = historyForActiveBrand()) {
    return records.filter(item => ['completed', 'partial'].includes(item.status)).filter(hasCurrentAnalysis).map(item => {
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
            return enrichCompetitors({ ...item, ...result, id: item.id, createdAt: item.createdAt, brand: item.brand, brandKey: item.brandKey, query: item.query, providerResults: results, orderedMentions: result.ordered_mentions || [], position: position.value, positionKind: position.kind, competitors: listedCompetitors(result), cited: resultCitesIdentity(result, identity) });
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
    const identity = activeBrandIdentity();
    if ($('#projectPickerName')) $('#projectPickerName').textContent = identity?.canonicalName || 'Выберите проект';
    if ($('#projectPickerDomain')) $('#projectPickerDomain').textContent = identity?.domains[0] || 'Домены не указаны';
    if ($('#projectPickerInitials')) $('#projectPickerInitials').textContent = identity ? brandInitials(identity.canonicalName) : 'V';
    if ($('#projectPickerList')) $('#projectPickerList').innerHTML = brandIdentities.length ? brandIdentities.map(item => `<button class="project-picker-option" type="button" role="option" aria-selected="${item.canonicalId === activeBrandKey}" data-project-key="${escapeHtml(item.canonicalId)}"><span class="project-picker-initials">${escapeHtml(brandInitials(item.canonicalName))}</span><span><strong>${escapeHtml(item.canonicalName)}</strong><small>${escapeHtml(item.domains[0] || 'Домены не указаны')}</small></span><span class="project-picker-check" aria-hidden="true">${item.canonicalId === activeBrandKey ? '✓' : ''}</span></button>`).join('') : '<p class="project-picker-empty">Пока нет проектов. Создайте проект через новую проверку.</p>';
}
function setActiveBrand(value, syncInput = true, resetResult = true) {
    const key = brandKey(value);
    if (!brandIdentities.some(item => item.canonicalId === key)) return;
    if (key !== activeBrandKey && guardProjectNavigation(() => setActiveBrand(value, syncInput, resetResult))) { renderBrandSelector(); return; }
    if (key !== activeBrandKey) projectDraft = null;
    activeBrandKey = key;
    localStorage.setItem(ACTIVE_BRAND_KEY, key);
    renderBrandSelector();
    if (syncInput) $('#wsBrand').value = currentBrand();
    if (resetResult) { $('#wsResult').hidden = true; selectedCheckId = null; answerCheckId = null; renderReportContext(null); }
    $('#wsError').hidden = true;
    renderAllForActiveBrand();
}
function renderAllForActiveBrand() {
    syncAnalyticsFilters();
    renderHistory();
    renderAiAnswers();
    renderCompetitors();
    renderSources();
    renderMetricsDashboard();
    renderReport();
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
function selectView(view, checkId = null) {
    if (projectSaving && !bypassProjectGuard) return;
    if (view !== 'settings' && guardProjectNavigation(() => selectView(view, checkId))) return;
    if (view === 'admin' && accountState?.role !== 'admin') return selectSettingsTab('profile');
    closeAccountMenu();
    setProjectPicker(false);
    closeMobileNavigation();
    document.body.classList.toggle('report-view', view === 'reports');
    if (view === 'answers') answerCheckId = checkId;
    if (view === 'reports') renderReportContext(checkId);
    $(`#view-${view}`)?.setAttribute('data-check-id', checkId || '');
    $$('.app-nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    $$('.app-view').forEach(section => section.classList.toggle('active', section.id === `view-${view}`));
    $('#appBreadcrumb').textContent = $(`.app-nav-item[data-view="${view}"]`)?.textContent.trim() || (view === 'settings' ? 'Настройки' : view === 'admin' ? 'Администрирование' : 'Главная');
    if (view === 'growth') renderGrowth();
    if (view === 'sources') renderSources();
    if (view === 'competitors') renderCompetitors();
    if (view === 'answers') renderAiAnswers();
    if (view === 'reports') renderReport();
    else closeReportMenu();
    if (view === 'settings') { renderAccountProfile(); renderAccountAccess(); renderBrandSettings(); }
    if (view === 'admin' && !$('#adminClientList').children.length) { loadAdminClients(); loadAdminTariffs(); }
    if (view === 'home') Object.values(dashboardCharts).forEach(chart => chart?.resize());
}
const SETTINGS_META = {
    project: ['Проект', 'Название, варианты написания и домены активного проекта.'],
    profile: ['Профиль', 'Личные данные вашего аккаунта.'],
    appearance: ['Оформление', 'Выберите оформление вашего рабочего пространства.'],
    access: ['Доступ и лимиты', 'Тариф, срок действия и текущее использование.'],
    security: ['Безопасность', 'Смена email, пароля и удаление аккаунта.']
};
function selectSettingsTab(tab) {
    const selected = SETTINGS_META[tab] ? tab : 'profile';
    if (projectSaving && !bypassProjectGuard) return;
    if (selected !== 'project' && guardProjectNavigation(() => selectSettingsTab(selected))) return;
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
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(document.activeElement); if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : ['ArrowRight', 'ArrowDown'].includes(event.key) ? (current + 1) % tabs.length : (current - 1 + tabs.length) % tabs.length;
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
        const identity = identityFor(brand);
        const prompts = await requestPromptSuggestions(brand, identity?.domains || []);
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
        voucher_invalid: 'Код неверный, уже использован или отозван. Проверьте ваучер или обратитесь к администратору.',
        voucher_not_allowed: 'Ваучер доступен только для первой активации аккаунта. Дальнейший доступ меняет администратор.',
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
    return { status: value.status || value.effective_status || 'pending', administrativeStatus: value.administrative_status || value.administrativeStatus || value.status || 'pending', plan: value.plan || 'custom', activatedAt: value.activated_at || value.activatedAt || null, expiresAt: value.expires_at || value.expiresAt || null, canRedeemVoucher: Boolean(value.can_redeem_voucher), voucherRedeemed: Boolean(value.voucher_redeemed), checks: normalizeQuota(value.checks), brands: normalizeQuota(value.brands), capabilities: { workspace_write: Boolean(value.capabilities?.workspace_write ?? value.capabilities?.workspaceWrite), run_checks: Boolean(value.capabilities?.run_checks ?? value.capabilities?.runChecks), create_brands: Boolean(value.capabilities?.create_brands ?? value.capabilities?.createBrands), manage_existing_brands: Boolean(value.capabilities?.manage_existing_brands ?? value.capabilities?.manageExistingBrands) } };
}
function statusLabelAccess(status) { return ({ pending: 'Ожидает активации', active: 'Активен', expired: 'Срок истёк', suspended: 'Приостановлен' })[status] || status || 'Неизвестно'; }
function planLabel(plan) { return ({ basic: 'Basic', pro: 'Pro', business: 'Business', custom: 'Custom' })[plan] || plan || '—'; }
function quotaText(quota) { return quota.unlimited ? `${quota.used} использовано · безлимит` : `${quota.used} из ${quota.limit} · осталось ${quota.remaining}`; }
function quotaPeriodText(quota) { return quota.periodStart || quota.periodEnd ? `${formatDate(quota.periodStart, '—')} — ${formatDate(quota.periodEnd, '—')}` : ''; }
function quotaProgress(quota) { return quota.unlimited ? 100 : quota.limit > 0 ? Math.min(100, quota.used / quota.limit * 100) : 100; }
async function refreshAccess(render = true) {
    const data = await apiRequest('/access');
    accessState = normalizeAccess(data.access || data);
    if (render) { renderAccountAccess(); renderAccessBanner(); applyAccessGating(); renderOnboarding(); }
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
    renderVoucherActivation();
}
function renderVoucherActivation() {
    const root = $('#voucherActivation');
    const slot = $(needsOnboarding() ? '#onboardingVoucherSlot' : '#accountVoucherSlot');
    if (root.parentElement !== slot) slot.append(root);
    const eligible = Boolean(accessState?.status === 'pending' && accessState.canRedeemVoucher && !accessState.voucherRedeemed && accountState?.role === 'client');
    root.hidden = !eligible && !voucherActivationSucceeded;
    $('#voucherActivationForm').hidden = !eligible;
    $('#voucherRefreshAccess').hidden = !eligible || !voucherActivationOutcomeUnknown;
    $('#voucherCode').readOnly = voucherActivating || voucherActivationOutcomeUnknown;
    $('#voucherActivate').disabled = voucherActivating || voucherActivationOutcomeUnknown;
    $('#voucherActivate').textContent = voucherActivating ? 'Активируем…' : 'Активировать';
    if (!eligible) $('#voucherCode').value = '';
}
function completeVoucherActivation() {
    voucherActivationSucceeded = true;
    voucherActivationOutcomeUnknown = false;
    $('#voucherActivationForm').reset();
    setFormStatus('#voucherActivationStatus', `Доступ активирован: ${planLabel(accessState.plan)} до ${formatDate(accessState.expiresAt)}.`, true);
    renderAccountAccess(); renderAccessBanner(); applyAccessGating(); renderOnboarding();
    if (needsOnboarding()) $(activeBrandIdentity() || brandIdentities[0] ? '#onboardingQuery' : '#onboardingBrand').focus();
}
async function recoverVoucherActivation() {
    const button = $('#voucherRefreshAccess'); button.disabled = true;
    try {
        await refreshAccess();
        if (accessState.voucherRedeemed) completeVoucherActivation();
        else {
            voucherActivationOutcomeUnknown = false;
            setFormStatus('#voucherActivationStatus', accessState.canRedeemVoucher ? 'Активация пока не подтверждена. Можно повторить ввод кода.' : 'Доступ изменён. При необходимости обратитесь к администратору.');
        }
    } catch { setFormStatus('#voucherActivationStatus', 'Не удалось проверить активацию. Проверьте соединение и нажмите «Проверить активацию».'); }
    finally { button.disabled = false; renderVoucherActivation(); }
}
async function redeemVoucher(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (voucherActivating || voucherActivationOutcomeUnknown || !accessState?.canRedeemVoucher || !form.reportValidity()) return;
    const code = $('#voucherCode').value.trim();
    if (!code) return setFormStatus('#voucherActivationStatus', 'Введите код ваучера.');
    voucherActivating = true; setFormStatus('#voucherActivationStatus', ''); renderVoucherActivation();
    try {
        const data = await apiRequest('/vouchers/redeem', { method: 'POST', body: JSON.stringify({ code }) });
        accessState = normalizeAccess(data.access || data);
        completeVoucherActivation();
    } catch (error) {
        if (error instanceof ApiError && error.status < 500) {
            setFormStatus('#voucherActivationStatus', error.message);
            if (error.code === 'voucher_not_allowed') {
                await refreshAccess().catch(() => {});
                if (accessState.voucherRedeemed) completeVoucherActivation();
            }
        } else {
            voucherActivationOutcomeUnknown = true;
            await recoverVoucherActivation();
        }
    } finally { voucherActivating = false; renderVoucherActivation(); }
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
    setDisabled('#wsCheck, .app-topbar-cta, [data-empty-chart-action], [data-view="prompts"]:not(.app-nav-item), [data-measure-task], #dialogMeasureTask, [data-repeat-check]', !canCheck);
    setDisabled('#wsBrand, #wsQuery, #wsSuggestPrompts, #refreshPromptSuggestions, [data-create-task], [data-dismiss], [data-quick-status], #growthTaskForm input, #growthTaskForm select, #growthTaskForm textarea, #growthTaskForm [type="submit"], #deleteGrowthTask', !canWrite);
    setDisabled('#addBrandAlias, #brandAliasInput, [data-merge-alias], [data-stage-alias]', projectBlocked || projectSaving);
    setDisabled('#addBrandDomain, #brandDomainInput, #canonicalBrandName', projectBlocked || projectSaving || Boolean(projectState.cooldown));
    setDisabled('#deleteBrand', projectBlocked);
    $$('[data-remove-brand-value]').forEach(button => { const disabled = projectBlocked || projectSaving || button.dataset.brandValueType === 'domain' && Boolean(projectState.cooldown); button.disabled = disabled; button.setAttribute('aria-disabled', String(disabled)); });
    syncProjectSaveState();
    $$('[data-delete-check]').forEach(button => { button.disabled = !canWrite || history.find(item => item.id === button.dataset.deleteCheck)?.status === 'running'; button.setAttribute('aria-disabled', String(button.disabled)); });
    $$('[data-repeat-check]').forEach(button => { const running = history.find(item => item.id === button.dataset.repeatCheck)?.status === 'running'; button.disabled = !canCheck || running || checkInFlight || checkOutcomeUnknown || Boolean(trackedCheckId); button.setAttribute('aria-disabled', String(button.disabled)); });
    $('.app-topbar-cta')?.classList.toggle('is-access-disabled', !canCheck);
    setDisabled('#wsCheck', !canCheck || checkInFlight || checkOutcomeUnknown || Boolean(trackedCheckId));
    setDisabled('#wsBrand, #wsQuery', !canWrite || checkInFlight || checkOutcomeUnknown || Boolean(trackedCheckId));
    setDisabled('[data-suggested-prompt]', checkInFlight || checkOutcomeUnknown || Boolean(trackedCheckId));
}

$('#wsCheck').addEventListener('click', async () => {
    if (!$('#wsCheck').disabled) await runWorkspaceCheck($('#wsBrand').value, $('#wsQuery').value);
});

function needsOnboarding() { return dashboardReady && accountState?.role !== 'admin' && accountState?.onboarding_completed_at === null; }
function successfulCheck(item) { return item && ['completed', 'partial'].includes(item.status); }
function showCheckError(message) {
    const target = needsOnboarding() ? $('#onboardingError') : $('#wsError');
    target.textContent = message; target.hidden = !message;
}
function renderOnboarding() {
    const visible = needsOnboarding();
    $('#onboarding').hidden = !visible;
    document.body.classList.toggle('onboarding-active', visible);
    renderVoucherActivation();
    if (!visible) return;
    const identity = activeBrandIdentity() || brandIdentities[0];
    const step = identity ? 'check' : 'company';
    const changed = $('#onboarding').dataset.step !== step;
    $('#onboarding').dataset.step = step;
    $('#onboardingCompanyForm').hidden = Boolean(identity);
    $('#onboardingCheckForm').hidden = !identity;
    $('#onboardingTitle').textContent = identity ? 'Проверьте, рекомендует ли AI вашу компанию' : 'Добавьте вашу компанию';
    $('#onboardingDescription').textContent = identity ? 'Выберите один вопрос клиента. Мы посмотрим, какие компании AI предлагает в ответ.' : 'Начните с одного бренда. Мы проверим, появляется ли он в рекомендациях AI.';
    $('#onboardingSavedBrand').textContent = identity?.canonicalName || '';
    $('#onboardingSavedDomain').textContent = identity?.domains.join(', ') || 'Сайт не указан';
    $('#onboardingCompanyStep').setAttribute('aria-current', identity ? 'false' : 'step');
    $('#onboardingCheckStep').setAttribute('aria-current', identity ? 'step' : 'false');
    const waiting = checkInFlight || Boolean(trackedCheckId);
    const blocked = identity ? !capability('run_checks') : !capability('create_brands');
    const notice = $('#onboardingAccessNotice'); notice.hidden = !blocked;
    $('#onboardingRefreshAccess').hidden = !blocked;
    notice.textContent = blocked ? accessBlockedMessage(identity ? 'run_checks' : 'create_brands') : '';
    $('#onboardingContinue').disabled = onboardingBrandSaving || onboardingBrandOutcomeUnknown || blocked;
    $('#onboardingBrand').readOnly = onboardingBrandSaving || onboardingBrandOutcomeUnknown;
    $('#onboardingDomain').readOnly = onboardingBrandSaving || onboardingBrandOutcomeUnknown;
    $('#onboardingRefreshCompany').hidden = !onboardingBrandOutcomeUnknown;
    $('#onboardingRefreshCompany').disabled = onboardingBrandSaving;
    $('#onboardingContinue').textContent = onboardingBrandSaving ? 'Сохраняем компанию…' : 'Продолжить →';
    $('#onboardingRunCheck').disabled = blocked || waiting || checkOutcomeUnknown;
    $('#onboardingRunCheck').textContent = waiting ? 'Проверка выполняется…' : 'Запустить первую проверку →';
    $('#onboardingQuery').readOnly = waiting || checkOutcomeUnknown;
    $('#onboardingSuggest').disabled = !capability('workspace_write') || waiting || checkOutcomeUnknown || onboardingSuggestionsBusy;
    $$('#onboardingSuggestions button').forEach(button => { button.disabled = waiting || checkOutcomeUnknown; });
    $('#onboardingWaiting').hidden = !waiting;
    $('#onboardingRefreshStatus').hidden = !(trackedCheckId || checkOutcomeUnknown);
    if (changed && !document.body.classList.contains('auth-pending')) $('#onboardingTitle').focus();
}
function onboardingDomain(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(raw) ? raw : `https://${raw}`);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.') || /\s/.test(raw)) throw new Error();
        return url.hostname.toLocaleLowerCase('ru-RU').replace(/^www\./, '').replace(/\.$/, '');
    } catch { throw new Error('Введите домен компании или полный адрес сайта, например company.ru.'); }
}
async function saveOnboardingCompany(event) {
    event.preventDefault();
    if (onboardingBrandSaving || onboardingBrandOutcomeUnknown || !event.currentTarget.reportValidity()) return;
    const name = normalizeBrandName($('#onboardingBrand').value);
    if (!name) { $('#onboardingBrand').setCustomValidity('Введите название компании.'); $('#onboardingBrand').reportValidity(); return; }
    let domain;
    try { domain = onboardingDomain($('#onboardingDomain').value); }
    catch (error) { $('#onboardingDomain').setCustomValidity(error.message); $('#onboardingDomain').reportValidity(); return; }
    onboardingBrandSaving = true; showCheckError(''); renderOnboarding();
    let submitted = false;
    try {
        await refreshAccess();
        if (!capability('create_brands')) throw new Error(accessBlockedMessage('create_brands'));
        submitted = true; pendingBrandContext = { name, domain };
        const data = await apiRequest('/brands', { method: 'POST', body: JSON.stringify({ canonical_name: name, aliases: [], domains: domain ? [domain] : [] }) });
        const identity = normalizeBrandRecord(data.brand || data);
        brandIdentities = [...brandIdentities.filter(item => item.id !== identity.id), identity];
        setActiveBrand(identity.canonicalId);
        pendingBrandContext = null;
        $('#onboardingSuggestions').innerHTML = ''; $('#onboardingSuggestionStatus').textContent = '';
    } catch (error) {
        try {
            const data = await apiRequest('/brands');
            brandIdentities = (data.brands || []).map(normalizeBrandRecord);
            const identity = brandIdentities.find(item => identityText(item.canonicalName) === identityText(name) && (domain ? item.domains.includes(domain) : !item.domains.length));
            pendingBrandContext = null;
            if (identity) setActiveBrand(identity.canonicalId);
            else showCheckError(`Не удалось сохранить компанию: ${error.message}`);
        } catch { onboardingBrandOutcomeUnknown = submitted; showCheckError(submitted ? 'Не удалось подтвердить сохранение компании. Сначала проверьте её сохранение, чтобы не создать второй проект.' : `Не удалось сохранить компанию: ${error.message}`); }
    } finally { onboardingBrandSaving = false; await refreshAccess().catch(() => {}); renderOnboarding(); }
}
async function recoverCompanySave() {
    if (!pendingBrandContext || onboardingBrandSaving) return;
    onboardingBrandSaving = true; renderOnboarding();
    try {
        const data = await apiRequest('/brands'); brandIdentities = (data.brands || []).map(normalizeBrandRecord);
        const { name, domain } = pendingBrandContext;
        const identity = brandIdentities.find(item => identityText(item.canonicalName) === identityText(name) && (domain ? item.domains.includes(domain) : !item.domains.length));
        onboardingBrandOutcomeUnknown = false; pendingBrandContext = null;
        if (identity) { setActiveBrand(identity.canonicalId); showCheckError(''); }
        else showCheckError('Компания не найдена среди сохранённых проектов. Можно повторить сохранение.');
    } catch { showCheckError('Не удалось проверить сохранение компании. Попробуйте обновить состояние ещё раз.'); }
    finally { onboardingBrandSaving = false; renderOnboarding(); }
}
async function requestPromptSuggestions(brand, domains) {
    const existingQueries = [...new Set(history.filter(item => brandKey(item.brand) === brandKey(brand)).map(item => normalizeBrandName(item.query)).filter(Boolean))].slice(-12);
    const data = await apiRequest('/prompt-suggestions', { method: 'POST', body: JSON.stringify({ brand, domains, aliases: identityFor(brand)?.aliases || [], existing_queries: existingQueries }) });
    const prompts = Array.isArray(data.prompts) ? data.prompts.filter(value => typeof value === 'string' && value.trim()) : [];
    if (!prompts.length) throw new Error('Не удалось получить подходящие запросы');
    return prompts;
}
async function suggestOnboardingPrompts() {
    const identity = activeBrandIdentity(); if (!identity || onboardingSuggestionsBusy) return;
    onboardingSuggestionsBusy = true; renderOnboarding();
    $('#onboardingSuggestions').innerHTML = '';
    $('#onboardingSuggestionStatus').textContent = 'Определяем направление компании и подбираем вопросы…';
    try {
        await refreshAccess();
        const prompts = await requestPromptSuggestions(identity.canonicalName, identity.domains);
        $('#onboardingSuggestions').innerHTML = prompts.map((prompt, index) => `<button type="button" data-onboarding-prompt="${index}">${escapeHtml(prompt)}</button>`).join('');
        $$('#onboardingSuggestions button').forEach(button => button.addEventListener('click', () => {
            $('#onboardingQuery').value = prompts[Number(button.dataset.onboardingPrompt)]; $('#onboardingQuery').focus();
        }));
        $('#onboardingSuggestionStatus').textContent = 'Выберите вопрос и при необходимости измените его.';
    } catch (error) { $('#onboardingSuggestionStatus').textContent = `Не удалось подобрать запросы: ${error.message}. Введите свой вопрос выше.`; }
    finally { onboardingSuggestionsBusy = false; renderOnboarding(); }
}
function updateCheckWaiting() {
    const waiting = checkInFlight || Boolean(trackedCheckId);
    $('#wsLoader').hidden = !waiting;
    $('#wsLoaderText').textContent = 'Получаем ответы AI и анализируем их. Результат сохранится в проекте…';
    $('#wsRefreshStatus').hidden = !(trackedCheckId || checkOutcomeUnknown);
    applyAccessGating(); renderOnboarding();
}
function trackRunningCheck(item) {
    trackedCheckId = item.id;
    if (needsOnboarding()) $('#onboardingQuery').value = item.query;
    if (!checkPollTimer) checkPollTimer = setInterval(() => { if (!document.hidden) recoverCheckState(); }, 5000);
    updateCheckWaiting();
}
function stopTrackingCheck() {
    trackedCheckId = null;
    clearInterval(checkPollTimer); checkPollTimer = null;
}
function openSavedCheck(id, finishOnboarding = false) {
    const item = history.find(record => record.id === String(id)); if (!item) return;
    if (finishOnboarding && needsOnboarding() && successfulCheck(item)) accountState.onboarding_completed_at = item.completedAt || new Date(item.createdAt).toISOString();
    setActiveBrand(item.canonicalId || item.brand, true, false);
    $('#wsQuery').value = item.query;
    selectedCheckId = item.id;
    $('#wsResult').hidden = true; $('#wsError').hidden = true;
    renderOnboarding();
    if (!needsOnboarding()) selectView('prompts', item.id);
    if (item.status === 'running') { trackRunningCheck(item); return; }
    if (successfulCheck(item)) {
        renderResult(item.resultData);
        $('#wsResult').dataset.checkId = item.id;
        $('#wsResultContext').textContent = `${item.brand} · ${item.query} · ${formatDateTime(item.createdAt)} · ответили ${item.providerResults.length || 1} из ${requestedProvidersFor(item).length || 1} моделей`;
        const errors = item.providerErrors.map(error => `${PROVIDERS[error.provider] || error.provider}: ${error.error}`);
        $('#wsResultWarning').hidden = item.status !== 'partial';
        $('#wsResultWarning').textContent = errors.length ? `Часть данных недоступна: ${errors.join('; ')}` : 'Получен частичный результат: некоторые модели не ответили.';
        $('#wsVerdict').focus();
    } else showCheckError(`Проверка не выполнена: ${item.error === 'interrupted' ? 'ожидание превысило час. Можно запустить проверку снова.' : item.error || 'не удалось получить или проанализировать ответы AI'}`);
    updateCheckWaiting();
}
async function recoverCheckState() {
    if (checkPolling || checkInFlight || !dashboardReady) return;
    checkPolling = true;
    const trackedId = trackedCheckId;
    try {
        await refreshChecks();
        const data = await apiRequest('/account'); accountState = normalizeAccount(data.account || data);
        checkOutcomeUnknown = false;
        const item = trackedId ? history.find(record => record.id === trackedId) : pendingCheckContext ? history.filter(record => !pendingCheckContext.knownIds.has(record.id) && record.canonicalId === pendingCheckContext.brandKey && normalizeQuery(record.query) === normalizeQuery(pendingCheckContext.query) && record.provider === pendingCheckContext.provider).at(-1) : null;
        if (item?.status === 'running') trackRunningCheck(item);
        else {
            stopTrackingCheck();
            pendingCheckContext = null;
            if (item) { showCheckError(''); openSavedCheck(item.id, true); }
            else showCheckError('Выполняющаяся проверка не найдена. Можно отправить запрос снова.');
        }
    } catch { showCheckError('Не удалось обновить состояние проверки. Нажмите «Обновить состояние проверки» или дождитесь следующего обновления.'); }
    finally { checkPolling = false; updateCheckWaiting(); }
}
async function runWorkspaceCheck(brandValue, queryValue, provider = 'all', requestedProviders = null) {
    if (checkInFlight || trackedCheckId || checkOutcomeUnknown) return;
    const brand = normalizeBrandName(brandValue); const query = queryValue.trim();
    if (!brand || !query) return showCheckError('Введите бренд и вопрос для проверки.');
    checkInFlight = true; showCheckError(''); $('#wsResult').hidden = true; updateCheckWaiting();
    const knownIds = new Set(history.map(item => item.id));
    let submitted = false;
    try {
        await refreshAccess();
        if (!capability('run_checks')) throw new Error(accessBlockedMessage('run_checks'));
        const identity = await ensureBrandIdentity(brand);
        setActiveBrand(identity.canonicalId, false, false); $('#wsQuery').value = query;
        pendingCheckContext = { brandKey: identity.canonicalId, query, provider, knownIds };
        submitted = true;
        const body = { brand: identity.canonicalName, query, force_refresh: true, canonical_id: identity.canonicalId, canonical_name: identity.canonicalName, aliases: identity.aliases, domains: identity.domains };
        if (provider === 'all') body.providers = Array.isArray(requestedProviders) && requestedProviders.length ? requestedProviders : CHECK_PROVIDERS;
        else body.provider = provider;
        const raw = await apiRequest(provider === 'all' ? '/check-all' : '/check', { method: 'POST', body: JSON.stringify(body) });
        if (!raw.check?.id || !['completed', 'partial'].includes(raw.check.status)) throw new Error('Сервер не подтвердил сохранение результата');
        const data = canonicalizeCheckResult(raw, identity);
        const saved = saveCheck(data, identity.canonicalName, query, provider);
        pendingCheckContext = null; stopTrackingCheck(); openSavedCheck(saved.id, true);
    } catch (error) {
        if (submitted) {
            try {
                await refreshChecks();
                const saved = history.filter(item => !knownIds.has(item.id) && normalizeQuery(item.query) === normalizeQuery(query) && brandKey(item.brand) === brandKey(brand) && item.provider === provider).at(-1);
                if (saved?.status === 'running') trackRunningCheck(saved);
                else if (saved) { pendingCheckContext = null; openSavedCheck(saved.id, true); }
                else { pendingCheckContext = null; showCheckError(`Не удалось выполнить проверку: ${error.message}. Можно повторить запуск.`); }
            } catch { checkOutcomeUnknown = true; showCheckError('Связь с сервером прервалась. Сначала обновите состояние проверки: она могла уже запуститься.'); }
        } else showCheckError(`Не удалось выполнить проверку: ${error.message}`);
    } finally { checkInFlight = false; await refreshAccess().catch(() => {}); updateCheckWaiting(); }
}
function renderReportContext(id) {
    const item = history.find(record => record.id === String(id));
    reportCheckId = successfulCheck(item) ? item.id : null;
    const view = $('#view-reports');
    view.dataset.checkId = reportCheckId || ''; view.dataset.brandId = reportCheckId ? item.brandId : '';
    view.dataset.canonicalId = reportCheckId ? item.canonicalId : '';
    $('#reportCheckContext').textContent = reportCheckId ? `Выбрана проверка: ${item.brand} · ${item.query} · ${formatDateTime(item.createdAt)}${item.status === 'partial' ? ' · частичный результат' : ''}. Отчёт охватывает весь выбранный период.` : 'Откройте сохранённую проверку в истории, чтобы вернуться к её ответам. Отчёт охватывает весь выбранный период.';
    $('#reportBackToCheck').hidden = !reportCheckId;
    window.dispatchEvent(new CustomEvent('vidno-report-context', { detail: { checkId: reportCheckId, brandId: reportCheckId ? item.brandId : null, canonicalId: reportCheckId ? item.canonicalId : null } }));
}

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
function canonicalizeMentionList(values, preserveIdentity = false) {
    const rows = Array.isArray(values) ? values : []; const seen = new Set();
    return rows.map((mention, index) => { const observedName = plausibleBrandName(mention?.observed_name || mention?.name || mention?.company || mention?.brand); const saved = (preserveIdentity || hasIdentitySnapshot(mention)) && mention?.canonical_id && mention?.canonical_name; const identity = saved ? { id: mention.canonical_id, name: mention.canonical_name } : canonicalBrand(mention?.canonical_name || observedName); return { ...mention, ...(saved ? { identity_normalization_version: IDENTITY_NORMALIZATION_VERSION } : {}), name: identity.name, observed_name: observedName, canonical_id: identity.id, canonical_name: identity.name, position: Number(mention?.position) || index + 1, role: mention?.role || 'упоминание' }; }).sort((a, b) => a.position - b.position).filter(mention => { if (!mention.observed_name || !mention.canonical_id || seen.has(mention.canonical_id)) return false; seen.add(mention.canonical_id); return true; }).map((mention, index) => ({ ...mention, position: index + 1 }));
}
function normalizedAnswerText(value) { return ` ${String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/[^a-zа-я0-9.]+/gi, ' ').replace(/\s+/g, ' ').trim()} `; }
function answerContainsIdentity(answer, identity) {
    const text = normalizedAnswerText(answer); if (!text.trim()) return false;
    return identityVariants(identity).some(alias => { const needle = normalizedAnswerText(alias); return needle.trim().length > 1 && text.includes(needle); }) || (identity.domains || []).some(domain => text.includes(` ${domainText(domain)} `));
}
function canonicalizeProviderResult(result, targetIdentity) {
    if (hasIdentitySnapshot(result)) return { ...result, ordered_mentions: canonicalizeMentionList(result.ordered_mentions || [], true), competitors: listedCompetitors(result), mentioned_brands: listedCompetitors(result), cited: resultCitesIdentity(result, targetIdentity) };
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
    return { ...result, canonical_id: targetIdentity.canonicalId, canonical_name: targetIdentity.canonicalName, observed_name: result?.observed_name || targetIdentity.canonicalName, mentioned, position: own?.position || null, ordered_mentions: ordered, competitors, mentioned_brands: competitors, cited: resultCitesIdentity(result, targetIdentity) };
}
function canonicalizeCheckResult(data, identity) {
    if (!data || typeof data !== 'object') return data;
    if (hasIdentitySnapshot(data)) return { ...canonicalizeProviderResult(data, identity), provider_results: (data.provider_results || []).map(result => canonicalizeProviderResult(result, identity)) };
    const providerResults = (data.provider_results || []).map(result => canonicalizeProviderResult({ ...result, analysis_version: analysisVersion(result) || analysisVersion(data) }, identity));
    if (!providerResults.length) return canonicalizeProviderResult(data, identity);
    const ordered = canonicalizeMentionList(providerResults.flatMap(result => result.ordered_mentions || []));
    const mentionedResults = providerResults.filter(result => result.mentioned);
    const competitors = hasListedCompetitors(data) ? listedCompetitors(data) : providerResults.flatMap(listedCompetitors);
    return { ...data, canonical_id: identity.canonicalId, canonical_name: identity.canonicalName, observed_name: data.observed_name || identity.canonicalName, provider_results: providerResults, mentioned: Boolean(mentionedResults.length), position: mentionedResults.length ? mentionedResults.reduce((sum, result) => sum + Number(result.position || 0), 0) / mentionedResults.length : null, ordered_mentions: ordered, competitors, mentioned_brands: competitors };
}
function buildHistoryItem(data, brand, query, provider, record = {}) {
    const snapshotFields = hasIdentitySnapshot(data) ? { identity_normalization_version: data.identity_normalization_version, citation_domains: Array.isArray(data.citation_domains) ? [...data.citation_domains] : [], ...(typeof data.brand_cited === 'boolean' ? { brand_cited: data.brand_cited } : {}) } : {};
    const sources = (data.sources || []).map(source => ({ ...source }));
    const identity = brandIdentities.find(item => item.id === String(record.brand_id || '')) || identityFor(data.canonical_name || brand);
    const cited = resultCitesIdentity(data, identity);
    const sentiments = (data.source_analysis || []).filter(item => item.mentions_brand).map(item => item.sentiment).filter(Boolean);
    const normalizedBrand = hasIdentitySnapshot(data) ? data.canonical_name || normalizeBrandName(brand) : identity?.canonicalName || normalizeBrandName(brand);
    const position = resultPosition(data);
    const storedError = record.error; const error = typeof storedError === 'string' ? storedError : Array.isArray(storedError) ? storedError.map(item => item?.error || item?.message || item).join('; ') : storedError?.error || storedError?.message || '';
    return { ...snapshotFields, id: String(record.id || data.check?.id || crypto.randomUUID()), brandId: String(record.brand_id || data.check?.brand_id || identity?.id || ''), completedAt: record.completed_at || data.check?.completed_at || null, resultData: data, providerErrors: data.provider_errors || (Array.isArray(record.error) ? record.error : []), createdAt: new Date(record.created_at || data.check?.created_at || Date.now()).getTime(), brand: normalizedBrand, brandKey: identity?.canonicalId || String(record.brand_id || ''), canonicalId: data.canonical_id || identity?.canonicalId || String(record.brand_id || ''), canonicalName: normalizedBrand, observedName: data.observed_name || brand, query, provider: data.provider || provider, model: data.model || PROVIDERS[provider], marketScope: data.market_scope || '', rawAnswer: data.raw_answer || data.rawAnswer || '', providerResults: data.provider_results || [], orderedMentions: data.ordered_mentions || [], mentioned: Boolean(data.mentioned), position: position.value, positionKind: position.kind, role: data.role || '', analysisVersion: analysisVersion(data), competitors: hasIdentitySnapshot(data) ? listedCompetitors(data) : listedCompetitors(data).filter(name => brandKey(name) !== identity?.canonicalId), sources, cited, sentiments, reasoning: data.reasoning || '', quotes: data.quotes || [], status: record.status || data.check?.status || 'completed', error: String(error) };
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
function requestedProvidersFor(item) {
    if (item?.provider !== 'all') return item?.provider ? [item.provider] : [];
    const stored = item.resultData?.requested_providers || item.resultData?.requestedProviders;
    if (Array.isArray(stored) && stored.length) return [...new Set(stored.filter(provider => CHECK_PROVIDERS.includes(provider)))];
    const observed = [...(item.providerResults || item.resultData?.provider_results || []), ...(item.providerErrors || item.resultData?.provider_errors || [])].map(result => result.provider);
    return observed.length ? [...new Set(observed.filter(provider => CHECK_PROVIDERS.includes(provider)))] : CHECK_PROVIDERS.filter(provider => provider !== 'deepseek');
}
function checkDetailRows(item) {
    const results = item.status === 'failed' ? [] : item.providerResults.length ? item.providerResults : item.provider === 'all' ? [] : [item.resultData];
    const rows = results.map(result => ({ ...result, error: '', provider: result.provider || item.provider }));
    item.providerErrors.forEach(error => {
        if (!rows.some(result => result.provider === error.provider)) rows.push({ ...error, provider: error.provider, model: PROVIDERS[error.provider] || error.provider, error: error.error || 'Модель не ответила', sources: error.sources || [] });
    });
    return rows.sort((a, b) => requestedProvidersFor(item).indexOf(a.provider) - requestedProvidersFor(item).indexOf(b.provider));
}
function renderCheckDetails(item) {
    const rows = checkDetailRows(item);
    const status = item.status === 'partial' ? 'Частичный результат' : item.status === 'failed' ? 'Ошибка' : item.status === 'running' ? 'Выполняется' : 'Завершена';
    const modelCards = rows.map(result => {
        const providerName = PROVIDERS[result.provider] || result.model || result.provider || 'AI-модель';
        if (result.error) return `<article class="check-detail-model check-detail-error"><div class="check-detail-model-head">${modelAvatarMarkup(result.provider, providerName)}<div><strong>${escapeHtml(providerName)}</strong><span>${result.raw_answer ? 'Ответ получен, анализ недоступен' : 'Ответ недоступен'}</span></div></div><p>${escapeHtml(result.error)}</p>${result.raw_answer ? `<div class="check-detail-answer">${escapeHtml(result.raw_answer)}</div>` : ''}</article>`;
        const position = resultPosition(result);
        const identity = identityFor(item.brand);
        const cited = resultCitesIdentity(result, identity);
        const sources = (result.sources || []).filter(source => source?.cited_in_answer !== false);
        return `<article class="check-detail-model"><div class="check-detail-model-head">${modelAvatarMarkup(result.provider, providerName)}<div><strong>${escapeHtml(providerName)}</strong><span>${result.mentioned ? 'Бренд упомянут' : 'Бренд не упомянут'}${position.value ? ` · ${escapeHtml(positionText(position.value, position.kind))}` : ''}${cited ? ' · есть ссылка на сайт бренда' : ''}</span></div></div><div class="check-detail-answer">${escapeHtml(result.raw_answer || result.rawAnswer || 'Полный ответ модели не сохранён.')}</div>${sources.length ? `<div class="check-detail-sources"><strong>Ссылки в ответе</strong>${sources.map(source => `<a href="${escapeHtml(safeUrl(source.url))}" target="_blank" rel="noopener">${escapeHtml(source.title || source.url)}</a>`).join('')}</div>` : ''}</article>`;
    }).join('');
    return `<div class="check-details-head"><div><p class="app-eyebrow">Сохранённая проверка</p><h2>${escapeHtml(item.query)}</h2><p>${escapeHtml(item.brand)} · ${escapeHtml(formatDateTime(item.createdAt))} · ${escapeHtml(status)}</p></div><button class="brief-close" type="button" data-check-details-close aria-label="Закрыть">×</button></div><div class="check-details-body"><div class="check-details-summary"><strong>${item.status === 'failed' ? 'Анализ не завершён' : item.mentioned ? 'Бренд упомянут' : 'Бренд не упомянут'}</strong><span>${rows.filter(row => !row.error).length} из ${requestedProvidersFor(item).length || 1} моделей дали результат</span></div><div class="check-detail-models">${modelCards || '<div class="app-empty"><strong>Нет сохранённых ответов</strong><span>Для этой проверки доступен только общий статус.</span></div>'}</div></div><div class="check-details-actions"><button class="btn btn-ghost" type="button" data-check-details-close>Закрыть</button><button class="btn btn-ghost" type="button" data-open-check-result="${escapeHtml(item.id)}">Открыть общий результат</button><button class="btn btn-primary" type="button" data-repeat-check="${escapeHtml(item.id)}">Повторить проверку</button></div>`;
}
function openCheckDetails(id) {
    const item = history.find(record => record.id === String(id)); if (!item) return;
    $('#checkDetailsContent').innerHTML = renderCheckDetails(item);
    const dialog = $('#checkDetailsDialog'); dialog.showModal(); bindAvatarFallbacks(); applyAccessGating();
}
async function repeatSavedCheck(id) {
    const item = history.find(record => record.id === String(id)); if (!item || item.status === 'running') return;
    $('#checkDetailsDialog').close(); selectView('prompts');
    await runWorkspaceCheck(item.brand, item.query, item.provider, requestedProvidersFor(item));
}
function renderHistory() {
    const rows = historyForActiveBrand();
    $('#historyCount').textContent = `${rows.length} ${rows.length === 1 ? 'проверка' : 'проверок'}`;
    const visibleRows = rows.slice().reverse().slice(0, historyExpanded ? rows.length : 10);
    $('#historyList').innerHTML = rows.length ? visibleRows.map(item => {
        const status = item.status === 'running' ? 'проверка выполняется' : item.status === 'failed' ? `ошибка: ${item.error === 'interrupted' ? 'проверка прервана' : item.error || 'проверка не выполнена'}` : `${item.status === 'partial' ? 'частичный результат · ' : ''}${item.mentioned ? 'бренд упомянут' : 'бренд не упомянут'}`;
        return `<div class="app-history-row"><button class="history-open-check" type="button" data-open-check="${escapeHtml(item.id)}"><strong>${escapeHtml(item.query)}</strong><span>${escapeHtml(item.brand)}${item.provider === 'all' ? ' · Все модели' : ` · ${escapeHtml(PROVIDERS[item.provider] || item.provider)}`} · ${escapeHtml(status)}</span></button><div class="app-history-actions"><span>${new Date(item.createdAt).toLocaleDateString('ru-RU')}</span><button type="button" data-check-details="${escapeHtml(item.id)}" aria-label="Посмотреть полный результат" title="Полный результат"><i class="fa-regular fa-eye"></i></button><button type="button" data-repeat-check="${escapeHtml(item.id)}" aria-label="Повторить проверку" title="Повторить проверку"${item.status === 'running' ? ' disabled' : ''}><i class="fa-solid fa-rotate-right"></i></button><button type="button" data-delete-check="${escapeHtml(item.id)}" aria-label="Удалить проверку" title="Удалить проверку"${item.status === 'running' ? ' disabled' : ''}><i class="fa-regular fa-trash-can"></i></button></div></div>`;
    }).join('') : '<div class="app-empty"><strong>Пока нет проверок</strong><span>Запустите первую проверку выше.</span></div>';
    $$('#historyList [data-open-check]').forEach(button => button.addEventListener('click', () => openSavedCheck(button.dataset.openCheck)));
    $$('#historyList [data-check-details]').forEach(button => button.addEventListener('click', () => openCheckDetails(button.dataset.checkDetails)));
    $$('#historyList [data-repeat-check]').forEach(button => button.addEventListener('click', () => repeatSavedCheck(button.dataset.repeatCheck)));
    $$('#historyList [data-delete-check]').forEach(button => button.addEventListener('click', () => deleteCheck(button.dataset.deleteCheck)));
    const toggle = $('#historyToggle'); toggle.hidden = rows.length <= 10; toggle.textContent = historyExpanded ? 'Свернуть историю' : `Показать все · ${rows.length}`; toggle.setAttribute('aria-expanded', String(historyExpanded));
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
function snapshotResult(item) { return item ? { provider: item.provider || '', model: item.model || '', mentioned: Boolean(item.mentioned), position: Number(item.position) || null, positionKind: item.positionKind || (item.weighted_position ? 'weighted' : 'direct'), role: item.role || '' } : null; }
function snapshotCheck(item) {
    if (!item) return null;
    const providerResults = item.providerResults || item.provider_results || item.resultData?.provider_results || [];
    const snapshots = providerResults.map(snapshotResult).filter(Boolean);
    const providers = snapshots.length ? snapshots.map(result => result.provider).filter(Boolean) : item.provider && item.provider !== 'all' ? [item.provider] : requestedProvidersFor(item);
    return { id: item.id || null, createdAt: item.createdAt || Date.now(), provider: item.provider || '', providers: [...new Set(providers)], providerResults: snapshots, mentioned: Boolean(item.mentioned), position: Number(item.position) || null, positionKind: item.positionKind || 'weighted', role: item.role || '', competitors: item.competitors || [], reasoning: item.reasoning || '', quotes: item.quotes || [] };
}
function growthTaskForBrand(task) { return brandKey(task.brand) === activeBrandKey; }
const TASK_STATUSES = new Map([
    ['planned', { label: 'Запланировано', className: 'status-planned' }],
    ['in_progress', { label: 'В работе', className: 'status-in_progress' }],
    ['ready_for_check', { label: 'Готово к проверке', className: 'status-ready_for_check' }],
    ['measured', { label: 'Измерено', className: 'status-measured' }],
]);
const TASK_WORK_TYPES = new Map([['content', 'Контент'], ['seo', 'SEO'], ['pr', 'PR'], ['technical', 'Техническая']]);
function taskStatus(status) { return TASK_STATUSES.get(status) || { label: 'Неизвестный статус', className: '' }; }
function statusLabel(status) { return taskStatus(status).label; }
function workTypeLabel(type) { return TASK_WORK_TYPES.get(type) || 'Другой тип'; }
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
    const statusControl = ['planned', 'in_progress', 'ready_for_check'].includes(task.status) ? `<label class="growth-quick-status"><span class="growth-action-label">Статус</span><select class="${taskStatus(task.status).className}" data-quick-status="${task.id}" aria-label="Статус задачи «${escapeHtml(task.title)}»"><option value="planned"${task.status === 'planned' ? ' selected' : ''}>Запланировано</option><option value="in_progress"${task.status === 'in_progress' ? ' selected' : ''}>В работе</option><option value="ready_for_check"${task.status === 'ready_for_check' ? ' selected' : ''}>Готово к проверке</option></select></label>` : `<span class="growth-status ${taskStatus(task.status).className}">${statusLabel(task.status)}</span>`;
    return `<article class="growth-card growth-task"><div class="growth-card-main"><div class="growth-card-badges">${statusControl}<span class="growth-tag">${workTypeLabel(task.workType)}</span><span class="growth-tag">${escapeHtml(PROVIDERS[task.provider] || task.provider)}</span></div><h3>${escapeHtml(task.title)}</h3><div class="growth-suggestion growth-task-action"><strong>Что сделать</strong><span>${escapeHtml(task.action)}</span></div><div class="growth-task-meta"><span><i class="fa-regular fa-user"></i>${escapeHtml(task.owner || 'Не назначен')}</span><span><i class="fa-regular fa-calendar"></i>${task.deadline ? new Date(`${task.deadline}T00:00:00`).toLocaleDateString('ru-RU') : 'Без срока'}</span></div></div><aside class="growth-card-actions"><span class="growth-action-label">Управление</span>${task.status === 'ready_for_check' ? `<button class="btn btn-primary btn-sm" data-measure-task="${task.id}">Проверить эффект</button>` : ''}<button class="btn btn-ghost btn-sm" data-edit-task="${task.id}">Открыть задачу</button></aside></article>`;
}
function checkSummary(item) { if (!item) return 'Нет данных'; if (!item.mentioned) return 'Бренд не упомянут'; return `${isRecommendationRole(item.role) ? 'Рекомендация' : 'Бренд упомянут'}${item.position ? ` · ${positionText(item.position, item.positionKind || 'weighted').toLocaleLowerCase('ru-RU')}` : ''}`; }
function renderResultCard(task) {
    const tone = task.verdict === 'improved' ? 'positive' : task.verdict === 'declined' ? 'negative' : 'neutral';
    const label = task.verdict === 'improved' ? 'Предварительно улучшилось' : task.verdict === 'declined' ? 'Предварительно ухудшилось' : 'Без изменений';
    const icon = tone === 'positive' ? 'fa-arrow-trend-up' : tone === 'negative' ? 'fa-arrow-trend-down' : 'fa-equals';
    const compared = task.comparison?.providers?.length ? `Сравнены одинаковые модели: ${task.comparison.providers.map(provider => PROVIDERS[provider] || provider).join(', ')}.` : 'Сравнение выполнено по одинаковому промпту и модели.';
    const unavailable = task.comparison?.unavailable?.length ? ` Не ответили: ${task.comparison.unavailable.map(provider => PROVIDERS[provider] || provider).join(', ')}.` : '';
    return `<article class="growth-card growth-result result-${tone}"><div class="growth-card-main"><div class="growth-result-head"><div><span class="growth-result-kicker">Результат контрольной проверки</span><div class="growth-result-verdict ${tone}"><i class="fa-solid ${icon}"></i><strong>${label}</strong></div></div><span class="growth-tag">${escapeHtml(PROVIDERS[task.provider] || task.provider)}</span></div><h3>${escapeHtml(task.title)}</h3><div class="growth-before-after"><div><span>До изменений</span><strong>${escapeHtml(checkSummary(task.baseline))}</strong><small>${task.baseline?.createdAt ? new Date(task.baseline.createdAt).toLocaleDateString('ru-RU') : 'Дата неизвестна'}</small></div><i class="fa-solid fa-arrow-right"></i><div class="growth-after"><span>После изменений</span><strong>${escapeHtml(checkSummary(task.postCheck))}</strong><small>${new Date(task.postCheck.createdAt).toLocaleDateString('ru-RU')}</small></div></div><p class="growth-disclaimer">${escapeHtml(compared + unavailable)} Один контрольный запуск показывает предварительную динамику и не доказывает причинность.</p></div><aside class="growth-card-actions"><span class="growth-action-label">Подробнее</span><button class="btn btn-ghost btn-sm" data-edit-task="${task.id}">Открыть результат</button></aside></article>`;
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
    const baseline = snapshotCheck(latest);
    const draft = { version: 2, opportunityId: item.id, brand_id: activeBrandIdentity()?.id || null, brand: item.brand, brandKey: brandKey(item.brand), query: item.query, provider: item.provider, providers: baseline.providers, model: item.model, problemType: item.type, ...dialogValues(), status: 'planned', createdAt: now, updatedAt: now, baselineCheckId: latest.id || null, baseline, evidence: { count: item.count, checkIds: item.evidenceRows.map(row => row.id), competitors: item.competitors, reasoning: latest.reasoning || '', quotes: item.evidenceRows.flatMap(row => row.quotes || []).slice(-5) }, postCheck: null, verdict: null };
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
function compareSingleCheck(before, after) { const beforeLevel = resultLevel(before); const afterLevel = resultLevel(after); if (afterLevel > beforeLevel) return 'improved'; if (afterLevel < beforeLevel) return 'declined'; const beforePosition = Number(before?.position) || null; const afterPosition = Number(after?.position) || null; const beforeKind = before?.positionKind || 'weighted'; const afterKind = after?.positionKind || 'weighted'; if (beforePosition && afterPosition && beforeKind === afterKind && afterPosition < beforePosition) return 'improved'; if (beforePosition && afterPosition && beforeKind === afterKind && afterPosition > beforePosition) return 'declined'; return 'unchanged'; }
function compareChecks(before, after, requestedProviders = []) {
    const beforeRows = new Map((before?.providerResults || []).map(item => [item.provider, item]));
    const afterRows = new Map((after?.providerResults || []).map(item => [item.provider, item]));
    const requested = requestedProviders.length ? requestedProviders : [...new Set([...beforeRows.keys(), ...afterRows.keys()])];
    if (!beforeRows.size && !afterRows.size) return { verdict: compareSingleCheck(before, after), providers: before?.provider ? [before.provider] : [], unavailable: [] };
    const unavailable = requested.filter(provider => !beforeRows.has(provider) || !afterRows.has(provider));
    if (unavailable.length) throw new Error(`Нельзя сравнить результат: не ответили ${unavailable.map(provider => PROVIDERS[provider] || provider).join(', ')}`);
    const changedModels = requested.filter(provider => beforeRows.get(provider)?.model && afterRows.get(provider)?.model && beforeRows.get(provider).model !== afterRows.get(provider).model);
    if (changedModels.length) throw new Error(`Нельзя сравнить результат: изменилась версия ${changedModels.map(provider => PROVIDERS[provider] || provider).join(', ')}`);
    const providers = requested;
    const verdicts = providers.map(provider => compareSingleCheck(beforeRows.get(provider), afterRows.get(provider)));
    const improved = verdicts.filter(value => value === 'improved').length;
    const declined = verdicts.filter(value => value === 'declined').length;
    return { verdict: improved > declined ? 'improved' : declined > improved ? 'declined' : 'unchanged', providers, unavailable: [] };
}
async function measureTask(id, button) {
    const task = growthTasks.find(item => item.id === id); if (!task || task.status !== 'ready_for_check' || !task.query) return;
    const original = button.textContent; button.disabled = true; button.textContent = 'Проверяем…';
    const errorTarget = $('#briefDialog').open ? $('#growthBriefStatus') : null;
    try {
        const identity = await ensureBrandIdentity(task.brand);
        const providers = Array.isArray(task.providers) && task.providers.length ? task.providers : task.provider === 'all' ? task.baseline?.providers?.length ? task.baseline.providers : requestedProvidersFor({ ...task.baseline, provider: 'all' }) : [task.provider];
        const body = { brand: identity.canonicalName, brand_id: identity.id, query: task.query, force_refresh: true, canonical_id: identity.canonicalId, canonical_name: identity.canonicalName, aliases: identity.aliases, domains: identity.domains };
        if (task.provider === 'all') body.providers = providers; else body.provider = task.provider;
        const raw = await apiRequest(task.provider === 'all' ? '/check-all' : '/check', { method: 'POST', body: JSON.stringify(body) });
        if (!raw.check?.id || !['completed', 'partial'].includes(raw.check.status)) throw new Error('Сервер не подтвердил сохранение контрольной проверки');
        const data = canonicalizeCheckResult(raw, identity);
        const saved = saveCheck(data, task.brand, task.query, task.provider);
        await refreshAccess().catch(() => {});
        const postCheck = snapshotCheck(saved); const comparison = compareChecks(task.baseline, postCheck, providers);
        const changes = { postCheck, verdict: comparison.verdict, comparison, status: 'measured' };
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
        const mentions = hasIdentitySnapshot(item) ? orderedMentionsFor(item).filter(mention => mention.canonical_id !== item.canonicalId) : (item.competitors || []).map(name => ({ name }));
        mentions.forEach(mention => { const name = normalizeBrandName(mention.name); const key = mentionIdentityKey(mention); if (key && key !== activeBrandKey && !inCheck.has(key)) inCheck.set(key, name); });
        inCheck.forEach((name, key) => { if (!rows.has(key)) rows.set(key, { key, mentions: 0, checks: 0, variants: new Map() }); const row = rows.get(key); row.mentions++; row.checks++; const variant = row.variants.get(name) || { count: 0, order: order++ }; variant.count++; row.variants.set(name, variant); });
    });
    return [...rows.values()].map(row => ({ ...row, name: preferredVariant(row.variants) })).sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name, 'ru'));
}

function aiAnswerRows() {
    return history.filter(item => brandKey(item.brand) === activeBrandKey && (!answerCheckId || item.id === answerCheckId) && successfulCheck(item)).flatMap(item => {
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
    }).join('') : '<div class="app-empty ai-answer-empty"><i class="fa-regular fa-message"></i><strong>Пока нет сохранённых ответов</strong><span>Запустите проверку — полные ответы GigaChat, Алисы AI, ChatGPT, Gemini, Perplexity и DeepSeek появятся здесь.</span><button class="btn btn-primary btn-sm" type="button" data-view="prompts">Запустить проверку</button></div>';
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
function freshProjectDraft(identity = activeBrandIdentity()) {
    return identity ? { ...identity, aliases: [...identity.aliases], domains: [...identity.domains] } : null;
}
function projectHasChanges() {
    const identity = activeBrandIdentity();
    if (!identity || !projectDraft || projectDraft.canonicalId !== identity.canonicalId) return false;
    return projectDraft.canonicalName !== identity.canonicalName || JSON.stringify(projectDraft.aliases) !== JSON.stringify(identity.aliases) || JSON.stringify(projectDraft.domains) !== JSON.stringify(identity.domains) || Boolean($('#brandAliasInput')?.value.trim() || $('#brandDomainInput')?.value.trim());
}
function syncProjectSaveState() {
    const button = $('#saveCanonicalBrand'); if (!button) return;
    button.disabled = projectSaving || !capability('manage_existing_brands') || !activeBrandIdentity() || !projectHasChanges();
    button.setAttribute('aria-disabled', String(button.disabled));
    button.textContent = projectSaving ? 'Сохраняем…' : 'Сохранить изменения';
    if ($('#projectLeaveSave')) $('#projectLeaveSave').disabled = projectSaving;
    if ($('#projectLeaveDiscard')) $('#projectLeaveDiscard').disabled = projectSaving;
    if ($('#projectLeaveCancel')) $('#projectLeaveCancel').disabled = projectSaving;
}
function projectStatus(message, success = false) {
    if ($('#projectSaveStatus')) setFormStatus('#projectSaveStatus', message, success);
    if ($('#projectLeaveDialog')?.open && $('#projectLeaveStatus')) $('#projectLeaveStatus').textContent = message;
}
function renderBrandSettings() {
    const identity = activeBrandIdentity(); if (!$('#canonicalBrandName')) return;
    if (!projectDraft || projectDraft.canonicalId !== identity?.canonicalId) {
        projectDraft = freshProjectDraft(identity);
        $('#brandAliasInput').value = ''; $('#brandDomainInput').value = '';
        projectStatus('');
    }
    $('#canonicalBrandName').value = projectDraft?.canonicalName || '';
    const chip = (value, type) => `<span class="brand-chip">${escapeHtml(value)}<button type="button" aria-label="Удалить ${escapeHtml(value)}" data-remove-brand-value="${encodeURIComponent(value)}" data-brand-value-type="${type}">×</button></span>`;
    $('#brandAliasList').innerHTML = projectDraft?.aliases.length ? projectDraft.aliases.map(value => chip(value, 'alias')).join('') : '<span class="brand-settings-empty">Других названий пока нет</span>';
    $('#brandDomainList').innerHTML = projectDraft?.domains.length ? projectDraft.domains.map(value => chip(value, 'domain')).join('') : '<span class="brand-settings-empty">Домены пока не добавлены</span>';
    const suggestions = identity ? normalizedCompetitors().filter(row => aliasSuggestion(row.name)).slice(0, 5) : [];
    $('#brandSuggestions').innerHTML = suggestions.length ? `<strong>Возможные варианты вашего бренда</strong><p>Подтвердите только те названия, которые действительно относятся к одной компании.</p><div class="brand-chip-list">${suggestions.map(row => `<button class="brand-suggestion-chip" type="button" data-stage-alias="${encodeURIComponent(row.name)}">${escapeHtml(row.name)} <i class="fa-solid fa-plus"></i></button>`).join('')}</div>` : '';
    $$('[data-remove-brand-value]').forEach(button => button.addEventListener('click', () => {
        if (!projectDraft || button.disabled) return;
        const field = button.dataset.brandValueType === 'domain' ? 'domains' : 'aliases';
        projectDraft[field] = projectDraft[field].filter(value => value !== decodeURIComponent(button.dataset.removeBrandValue));
        projectStatus('Есть несохранённые изменения'); renderBrandSettings(); applyAccessGating();
    }));
    $$('[data-stage-alias]').forEach(button => button.addEventListener('click', () => {
        if (stageProjectValue(decodeURIComponent(button.dataset.stageAlias), 'alias')) { renderBrandSettings(); applyAccessGating(); }
    }));
    syncProjectSaveState();
}
function stageProjectValue(raw, type) {
    if (!projectDraft || projectSaving || !capability('manage_existing_brands')) return false;
    let value = normalizeBrandName(raw); if (!value) return true;
    if (type === 'domain' && projectIdentityCooldown(activeBrandIdentity())) { projectStatus('Название и домены пока недоступны для изменения.'); return false; }
    if (type === 'domain') {
        value = domainText(value);
        if (!value || !value.includes('.') || /[\s:@]/.test(value)) { projectStatus('Введите домен, например company.ru.'); return false; }
    }
    const conflict = identityFor(value);
    if (conflict && conflict.canonicalId !== projectDraft.canonicalId) { projectStatus('Это название или домен уже относится к другому проекту.'); return false; }
    const field = type === 'domain' ? 'domains' : 'aliases';
    const key = type === 'domain' ? domainText : identityText;
    if (field === 'aliases' && key(value) === key(projectDraft.canonicalName)) return true;
    if (!projectDraft[field].some(item => key(item) === key(value))) {
        if (projectDraft[field].length >= 50) { projectStatus('Можно добавить не более 50 значений.'); return false; }
        projectDraft[field].push(value);
    }
    projectStatus('Есть несохранённые изменения');
    return true;
}
function addIdentityValue(inputSelector, type) {
    const input = $(inputSelector); if (!input || !stageProjectValue(input.value, type)) return;
    input.value = ''; renderBrandSettings(); applyAccessGating();
}
$('#addBrandAlias').addEventListener('click', () => addIdentityValue('#brandAliasInput', 'alias'));
$('#addBrandDomain').addEventListener('click', () => addIdentityValue('#brandDomainInput', 'domain'));
for (const [selector, type] of [['#brandAliasInput', 'alias'], ['#brandDomainInput', 'domain']]) {
    $(selector).addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addIdentityValue(selector, type); } });
    $(selector).addEventListener('input', () => { projectStatus(''); syncProjectSaveState(); });
}
$('#canonicalBrandName').addEventListener('input', event => {
    if (projectDraft) projectDraft.canonicalName = event.target.value;
    projectStatus(''); syncProjectSaveState();
});
async function saveProjectDraft() {
    const identity = activeBrandIdentity();
    if (projectSaving || !identity || !projectDraft || !capability('manage_existing_brands')) return false;
    for (const [selector, type] of [['#brandAliasInput', 'alias'], ['#brandDomainInput', 'domain']]) {
        if (!stageProjectValue($(selector).value, type)) return false;
        $(selector).value = '';
    }
    renderBrandSettings();
    const name = normalizeBrandName(projectDraft.canonicalName);
    if (!name || name.length > 200) { projectStatus('Укажите название проекта длиной до 200 символов.'); return false; }
    const conflict = identityFor(name);
    if (conflict && conflict.canonicalId !== identity.canonicalId) { projectStatus('Это название уже относится к другому проекту.'); return false; }
    const next = { ...projectDraft, canonicalName: name, aliases: [...projectDraft.aliases], domains: [...projectDraft.domains] };
    if (identityText(identity.canonicalName) !== identityText(name)) next.aliases.push(identity.canonicalName);
    next.aliases = [...new Map(next.aliases.map(value => [identityText(value), value])).values()].filter(value => identityText(value) !== identityText(name));
    if (next.aliases.length > 50) { projectStatus('Можно сохранить не более 50 других названий, включая прежнее название проекта.'); return false; }
    projectSaving = true; projectStatus(''); applyAccessGating();
    try {
        await persistBrandIdentity(next);
        Object.assign(identity, next);
        projectDraft = freshProjectDraft(identity);
        history.filter(item => item.brandKey === identity.canonicalId).forEach(item => { item.brand = identity.canonicalName; item.canonicalName = identity.canonicalName; });
        $('#wsBrand').value = identity.canonicalName;
        renderBrandSelector(); renderAllForActiveBrand(); projectStatus('Изменения сохранены.', true);
        return true;
    } catch (error) {
        projectStatus(error.message);
        const message = $('#projectLeaveStatus'); if (message) message.textContent = error.message;
        return false;
    } finally { projectSaving = false; applyAccessGating(); }
}
$('#projectSettingsForm')?.addEventListener('submit', async event => { event.preventDefault(); await saveProjectDraft(); });
function guardProjectNavigation(action) {
    if (bypassProjectGuard) return false;
    if (projectSaving) return true;
    if (!projectHasChanges()) return false;
    pendingProjectNavigation = action;
    if ($('#projectLeaveStatus')) $('#projectLeaveStatus').textContent = '';
    openDashboardDialog('projectLeaveDialog');
    return true;
}
function continueProjectNavigation(discard = false) {
    const action = pendingProjectNavigation; pendingProjectNavigation = null;
    if (discard) { projectDraft = freshProjectDraft(); $('#brandAliasInput').value = ''; $('#brandDomainInput').value = ''; renderBrandSettings(); applyAccessGating(); }
    closeDashboardDialog('projectLeaveDialog');
    if (action) { bypassProjectGuard = true; try { action(); } finally { bypassProjectGuard = false; } }
}
function sourceCategory(domain) { if (/(forbes|rbc|tass|ria|vedomosti|kommersant|lenta|gazeta|news|media)/.test(domain)) return 'СМИ'; if (/(vc\.ru|habr|reddit|forum|otzovik|irecommend)/.test(domain)) return 'Сообщество и отзывы'; if (/(wiki|catalog|yell|2gis|zoon)/.test(domain)) return 'Каталог и справочник'; return 'Профильный сайт'; }
function renderSources() {
    const answers = analyticsHistory().flatMap(answerRowsFor);
    const rows = sourceRows(answers);
    const empty = '<div class="app-empty"><strong>Нет источников</strong><span>Они появятся после первой live-проверки.</span></div>';
    const total = answers.length; const visible = sourceExpanded ? rows : rows.slice(0, 10);
    const markup = visible.length ? visible.map(({ name, count }, index) => rankedRow(name, count, `${count} ответов · ${percentage(count, total)}%`, index, total, sourceCategory(name), imageAvatarMarkup(name, name, 'source'))).join('') : empty;
    $('#sourceList').innerHTML = markup;
    $('#homeSourceList').innerHTML = rows.length ? rows.slice(0, 5).map(({ name, count }, index) => rankedRow(name, count, `${count} ответов`, index, total, sourceCategory(name), imageAvatarMarkup(name, name, 'source'))).join('') : empty;
    setRankingToggle('#sourceToggle', sourceExpanded, rows.length); bindAvatarFallbacks();
}
$$('[data-ranking-toggle]').forEach(button => button.addEventListener('click', () => { if (button.dataset.rankingToggle === 'competitors') { competitorExpanded = !competitorExpanded; renderCompetitors(); } else { sourceExpanded = !sourceExpanded; renderSources(); } }));
const dashboardCharts = {};
function destroyChart(key) { if (dashboardCharts[key]) dashboardCharts[key].destroy(); delete dashboardCharts[key]; }
function percentage(value, total) { return total ? Math.round(value / total * 100) : 0; }
function sourceRows(answers) {
    const counts = new Map();
    answers.forEach(answer => {
        const domains = new Set();
        (answer.sources || []).forEach(source => { try { const url = new URL(typeof source === 'string' ? source : source.url); if (['http:', 'https:'].includes(url.protocol)) domains.add(url.hostname.replace(/^www\./, '')); } catch {} });
        domains.forEach(name => counts.set(name, (counts.get(name) || 0) + 1));
    });
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
function analyticsSnapshot() {
    const records = analyticsRecords(); const rowsHistory = analyticsHistory(); const answers = rowsHistory.flatMap(answerRowsFor); const brands = brandRows(rowsHistory);
    const own = brands.find(row => row.key === activeBrandKey) || { mentions: 0, citations: 0, averagePosition: null };
    const excluded = records.filter(item => ['completed', 'partial'].includes(item.status) && (!hasCurrentAnalysis(item) || item.provider === 'all' && !item.providerResults.some(hasCurrentAnalysis))).length;
    const excludedAnswers = records.filter(item => ['completed', 'partial'].includes(item.status) && hasCurrentAnalysis(item)).flatMap(item => item.providerResults || []).filter(result => selectedProviders.has(result.provider) && !hasCurrentAnalysis(result)).length;
    const errors = records.reduce((total, item) => total + (item.providerErrors || []).filter(error => selectedProviders.has(error.provider)).length, 0);
    return { records, rowsHistory, answers, brands, own, sources: sourceRows(answers), models: [...modelGroups(answers).values()], failed: records.filter(item => item.status === 'failed').length, running: records.filter(item => item.status === 'running').length, partial: records.filter(item => item.status === 'partial').length, excluded, excludedAnswers, errors, bounds: analyticsBounds() };
}
function hasCitationMeasurement(data) { return Boolean(activeBrandIdentity()?.domains?.length || data.answers.some(item => hasIdentitySnapshot(item) && (item.citation_domains?.length || item.brand_cited === true))); }
function metricValues(data) {
    return { sov: data.answers.length && data.brands.some(row => row.voiceWeight) ? `${data.own.sov}%` : '—', visibility: data.answers.length ? `${data.own.visibility}%` : '—', citation: data.answers.length && hasCitationMeasurement(data) ? `${data.own.citationRate}%` : '—', position: data.own.averagePosition ? Number(data.own.averagePosition.toFixed(2)).toString() : '—' };
}
function reportFilters() {
    const bounds = analyticsBounds();
    const identity = activeBrandIdentity();
    if (bounds.error || !identity || !selectedProviders.size) return { error: bounds.error || (!identity ? 'Выберите проект, чтобы увидеть отчёт.' : 'Выберите хотя бы одну AI-модель.') };
    const params = new URLSearchParams({ brand_id: identity.id });
    CHECK_PROVIDERS.filter(provider => selectedProviders.has(provider)).forEach(provider => params.append('providers', provider));
    if (Number.isFinite(bounds.start)) { params.set('start', moscowDay(bounds.start)); params.set('end', moscowDay(bounds.end - 1)); }
    return { params, key: JSON.stringify([params.toString(), identity, historyForActiveBrand()]) };
}
function closeReportMenu(focus = false) {
    $('#reportDownloadMenu').hidden = true;
    $('#reportDownload').setAttribute('aria-expanded', 'false');
    if (focus) $('#reportDownload').focus();
}
function cancelReportRequests() {
    reportState.previewController?.abort(); reportState.downloadController?.abort();
    reportState.previewController = null; reportState.downloadController = null;
    reportState.loading = false; reportState.downloading = false;
    closeReportMenu();
}
function reportPercent(value) { return value === null || value === undefined ? '—' : `${value}%`; }
function renderReportDocument(data) {
    $('#reportBrandName').textContent = data.brand.name;
    $('#reportPeriodLabel').textContent = data.period.label;
    $('#reportProvidersLabel').textContent = `AI-модели: ${data.providers.map(provider => provider.name).join(', ')}`;
    $('#reportGeneratedAt').textContent = `Сформирован ${new Date(data.generated_at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} МСК`;
    const c = data.coverage;
    $('#reportCoverage').textContent = [`Запусков проверок: ${c.records}`, `Получено ответов для расчёта: ${c.answers}`, ...[['Частичных проверок', c.partial], ['Ошибок моделей', c.errors], ['Проверок с ошибкой', c.failed], ['В процессе', c.running], ['Исключено проверок', c.excluded], ['Ответов прежнего анализа', c.excluded_answers]].filter(([, count]) => count).map(([label, count]) => `${label}: ${count}`)].join(' · ');
    $$('[data-report-metric]').forEach(element => { const key = element.dataset.reportMetric; const value = data.metrics[key]; element.textContent = key === 'position' ? value === null ? '—' : Number(value.toFixed(2)).toString() : reportPercent(value); });
    $('#reportVisibilityNote').textContent = `${data.own_mentions} из ${c.answers} ответов`;
    $('#reportCitationNote').textContent = data.citation.measured ? `${data.citation.count} из ${c.answers} ответов` : 'Домены бренда не указаны';
    const empty = (columns, text) => `<tr><td colspan="${columns}">${escapeHtml(text)}</td></tr>`;
    $('#reportModelBody').innerHTML = data.models.map(row => `<tr><th scope="row">${escapeHtml(row.name)}</th><td>${row.answers}</td><td>${row.mentions}</td><td>${reportPercent(row.visibility)}</td></tr>`).join('');
    $('#reportBrandBody').innerHTML = data.brands.length ? data.brands.map(row => `<tr class="${row.own ? 'report-own-brand' : ''}"><th scope="row">${escapeHtml(row.name)}${row.own ? ' · ваш бренд' : ''}</th><td>${reportPercent(row.sov)}</td><td>${reportPercent(row.visibility)}</td><td>${row.position === null ? '—' : Number(row.position.toFixed(2)).toString()}</td></tr>`).join('') : empty(4, 'Нет пригодных ответов для сравнения брендов.');
    $('#reportSourceBody').innerHTML = data.sources.length ? data.sources.map(row => `<tr><th scope="row">${escapeHtml(row.name)}</th><td>${row.answers}</td><td>${reportPercent(row.share)}</td></tr>`).join('') : empty(3, 'В выбранных ответах нет источников.');
    $('#reportMethodology').innerHTML = data.methodology.map(text => `<p>${escapeHtml(text)}</p>`).join('');
}
function renderReport() {
    const filters = reportFilters();
    const blocked = checksLoadState.loading || checksLoadState.error || filters.error;
    if (blocked || reportState.key !== filters.key) {
        cancelReportRequests(); reportState.key = filters.key || ''; reportState.data = null; reportState.error = ''; reportState.notice = '';
    }
    $('#reportRefresh').disabled = checksLoadState.loading || reportState.loading;
    $('#reportDownload').disabled = Boolean(blocked || reportState.loading || reportState.downloading || reportState.error || !reportState.data?.coverage.answers);
    $('#reportDownload').setAttribute('aria-busy', String(reportState.downloading));
    $('#reportDownloadLabel').textContent = reportState.downloading ? 'Готовим отчёт…' : 'Скачать отчёт';
    $('#reportDocument').hidden = Boolean(blocked || reportState.loading || !reportState.data || reportState.error);
    let message = checksLoadState.loading ? 'Обновляем сохранённые проверки…' : checksLoadState.error ? `Не удалось обновить данные: ${checksLoadState.error}. Повторите загрузку кнопкой «Обновить данные».` : filters.error || '';
    if (!blocked) {
        if (!reportState.data && !reportState.loading && !reportState.error && document.body.classList.contains('report-view')) { loadReport(filters); return; }
        const c = reportState.data?.coverage;
        message = reportState.loading ? 'Готовим предпросмотр отчёта…' : reportState.error || reportState.notice || (c && !c.answers ? c.records ? 'В выбранном срезе нет пригодных ответов. Проверьте модели, период и статусы проверок.' : 'За выбранный период нет проверок.' : c && (c.errors || c.failed || c.running || c.partial || c.excluded || c.excluded_answers) ? 'Отчёт сформирован по доступным ответам. Неполные и исключённые данные отмечены в объёме выборки.' : '');
        if (reportState.data) renderReportDocument(reportState.data);
    }
    $('#reportStatus').textContent = message;
}
async function loadReport(filters = reportFilters()) {
    if (filters.error) return;
    reportState.previewController?.abort();
    const controller = new AbortController(); reportState.previewController = controller;
    reportState.key = filters.key; reportState.loading = true; reportState.error = '';
    renderReport();
    try {
        const data = await apiRequest(`/reports/visibility?${filters.params}`, { signal: controller.signal });
        if (controller.signal.aborted || reportState.key !== filters.key) return;
        if (!data?.revision || !data?.coverage || !Array.isArray(data.models) || !Array.isArray(data.methodology)) throw new Error('Сервер вернул некорректный отчёт');
        reportState.data = data;
    } catch (error) {
        if (!controller.signal.aborted && reportState.key === filters.key) reportState.error = `Не удалось подготовить отчёт: ${error.message}. Повторите загрузку кнопкой «Обновить данные».`;
    } finally {
        if (reportState.previewController === controller) { reportState.loading = false; reportState.previewController = null; renderReport(); }
    }
}
async function refreshReport() {
    cancelReportRequests(); reportState.data = null; reportState.error = ''; reportState.notice = '';
    try { await refreshChecks(); } catch { renderReport(); }
}
async function downloadReport(format) {
    if ($('#reportDownload').disabled || !['pdf', 'xlsx'].includes(format)) return;
    closeReportMenu(true);
    const filters = reportFilters(); const data = reportState.data;
    const controller = new AbortController(); reportState.downloadController = controller;
    reportState.downloading = true; reportState.notice = '';
    const params = new URLSearchParams(filters.params); params.set('format', format); params.set('revision', data.revision);
    renderReport();
    try {
        const response = await fetch(`${API_BASE}/reports/visibility/export?${params}`, { credentials: 'include', signal: controller.signal });
        if (response.status === 401) { window.location.replace('index.html?auth=login'); throw new Error('Сессия истекла'); }
        if (response.status === 409) {
            reportState.data = null;
            reportState.notice = 'Данные изменились. Предпросмотр обновлён — скачайте отчёт повторно.';
            await loadReport(filters);
            return;
        }
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(apiErrorMessage(error, response.status)); }
        const expectedType = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        if (!response.headers.get('Content-Type')?.startsWith(expectedType)) throw new Error('Сервер вернул файл в неверном формате');
        const blob = await response.blob();
        if (controller.signal.aborted || reportState.key !== filters.key) return;
        if (!blob.size) throw new Error('Сервер вернул пустой файл');
        const disposition = response.headers.get('Content-Disposition') || '';
        let filename = `Vidno_${data.brand.name}_${moscowDay()}.${format}`;
        const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i); const plain = disposition.match(/filename="([^"]+)"/i);
        if (encoded) { try { filename = decodeURIComponent(encoded[1]); } catch {} } else if (plain) filename = plain[1];
        filename = filename.replace(/[\\/\x00-\x1f]/g, '_');
        const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
        document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        reportState.notice = 'Отчёт подготовлен и передан для скачивания.';
    } catch (error) {
        if (!controller.signal.aborted && reportState.key === filters.key) reportState.notice = `Не удалось скачать отчёт: ${error.message}. Попробуйте ещё раз.`;
    } finally {
        if (reportState.downloadController === controller) { reportState.downloading = false; reportState.downloadController = null; renderReport(); }
    }
}
$('#reportRefresh').addEventListener('click', refreshReport);
$('#reportDownload').addEventListener('click', () => {
    const open = $('#reportDownloadMenu').hidden;
    $('#reportDownloadMenu').hidden = !open; $('#reportDownload').setAttribute('aria-expanded', String(open));
    if (open) $('#reportDownloadMenu [role="menuitem"]').focus();
});
$('#reportDownload').addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && !event.currentTarget.disabled) {
        event.preventDefault(); $('#reportDownloadMenu').hidden = false; event.currentTarget.setAttribute('aria-expanded', 'true');
        const items = $$('#reportDownloadMenu [role="menuitem"]'); items[event.key === 'ArrowUp' ? items.length - 1 : 0].focus();
    }
});
$('#reportDownloadMenu').addEventListener('keydown', event => {
    const items = $$('#reportDownloadMenu [role="menuitem"]'); const index = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeReportMenu(true); }
    if (event.key === 'Tab') closeReportMenu();
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus(); }
});
$$('[data-report-format]').forEach(button => button.addEventListener('click', () => downloadReport(button.dataset.reportFormat)));
document.addEventListener('click', event => { if (!event.target.closest('.report-download')) closeReportMenu(); });
document.addEventListener('focusin', event => { if (!event.target.closest('.report-download')) closeReportMenu(); });
function answerRowsFor(item) {
    const results = selectedResults(item);
    const identity = activeBrandIdentity() || identityFor(item.brand);
    return results.length ? results.map(result => ({ ...item, ...result, brand: item.brand, query: item.query, orderedMentions: result.ordered_mentions || result.orderedMentions || [], cited: resultCitesIdentity(result, identity), sentiments: (result.source_analysis || []).filter(analysis => analysis.mentions_brand).map(analysis => analysis.sentiment).filter(Boolean) })) : [{ ...item, cited: resultCitesIdentity(item, identity) }];
}
function orderedMentionsFor(item) {
    const supplied = Array.isArray(item.orderedMentions) ? item.orderedMentions : Array.isArray(item.ordered_mentions) ? item.ordered_mentions : [];
    if (supplied.length) {
        if (hasIdentitySnapshot(item)) return canonicalizeMentionList(supplied, true);
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
function brandRows(rowsHistory = analyticsHistory()) {
    const answerRows = rowsHistory.flatMap(answerRowsFor);
    const ownName = currentBrand(); const rows = new Map([[activeBrandKey, { key: activeBrandKey, name: ownName, mentions: 0, voiceWeight: 0, positions: [], citations: 0, sentiments: [], variants: new Map([[ownName, { count: 1, order: 0 }]]) }]]); let order = 1;
    answerRows.forEach(item => {
        const own = rows.get(activeBrandKey); if (item.mentioned) own.mentions++; if (item.cited) own.citations++; own.sentiments.push(...(item.sentiments || []));
        orderedMentionsFor(item).forEach(mention => { const key = mentionIdentityKey(mention); if (!rows.has(key)) rows.set(key, { key, name: mention.name, mentions: 0, voiceWeight: 0, positions: [], citations: 0, sentiments: [], variants: new Map() }); const row = rows.get(key); if (key !== activeBrandKey) row.mentions++; row.voiceWeight += 1 / mention.position; row.positions.push(mention.position); const variant = row.variants.get(mention.name) || { count: 0, order: order++ }; variant.count++; row.variants.set(mention.name, variant); });
    });
    const totalWeight = [...rows.values()].reduce((sum, row) => sum + row.voiceWeight, 0);
    return [...rows.values()].map(row => ({ ...row, name: row.key === activeBrandKey ? ownName : preferredVariant(row.variants), sov: percentage(row.voiceWeight, totalWeight), visibility: percentage(row.mentions, answerRows.length), citationRate: percentage(row.citations, answerRows.length), averagePosition: row.positions.length ? row.positions.reduce((sum, value) => sum + value, 0) / row.positions.length : null, answerCount: answerRows.length })).sort((a, b) => b.voiceWeight - a.voiceWeight || b.mentions - a.mentions);
}
function dominantSentiment(values) { const counts = values.reduce((result, value) => ({ ...result, [value]: (result[value] || 0) + 1 }), {}); return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || 'Нет данных'; }
function renderMetricsDashboard() {
    const data = analyticsSnapshot(); const own = data.own; const metrics = metricValues(data);
    $('#metricSov').textContent = metrics.sov; $('#metricSovNote').textContent = data.answers.length ? `${own.mentions} упоминаний среди брендов` : 'Нет пригодных ответов';
    $('#metricVisibility').textContent = metrics.visibility; $('#metricVisibilityNote').textContent = data.answers.length ? `в ${own.mentions} из ${data.answers.length} ответов` : 'Нет пригодных ответов';
    $('#metricCitation').textContent = metrics.citation; $('#metricCitationNote').textContent = !hasCitationMeasurement(data) ? 'Укажите домены бренда' : data.answers.length ? `${own.citations} ответов со ссылкой` : 'Нет пригодных ответов';
    $('#metricPosition').textContent = metrics.position; $('#metricPositionNote').textContent = own.averagePosition ? 'в извлечённых списках брендов' : 'Нет позиций';
    if ($('#homeBrandName')) $('#homeBrandName').textContent = currentBrand() || 'Проект не выбран';
    const countLabel = (value, forms) => `${value} ${forms[value % 100 >= 11 && value % 100 <= 14 ? 2 : value % 10 === 1 ? 0 : value % 10 >= 2 && value % 10 <= 4 ? 1 : 2]}`;
    if ($('#homeCheckCount')) $('#homeCheckCount').textContent = countLabel(data.records.length, ['проверка', 'проверки', 'проверок']);
    if ($('#homeAnswerCount')) $('#homeAnswerCount').textContent = countLabel(data.answers.length, ['ответ', 'ответа', 'ответов']);
    const latest = historyForActiveBrand().filter(successfulCheck).sort((a, b) => (parseDate(b.completedAt)?.getTime() || b.createdAt) - (parseDate(a.completedAt)?.getTime() || a.createdAt))[0];
    const lastTime = $('#lastCheckTime');
    if (lastTime) {
        const stamp = latest && (parseDate(latest.completedAt) || parseDate(latest.createdAt));
        lastTime.textContent = stamp ? stamp.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) + ' МСК' : '—';
        if (stamp) lastTime.dateTime = stamp.toISOString(); else lastTime.removeAttribute('datetime');
    }
    renderLeaderBoard(); renderModelMetrics(); renderDashboardCharts();
}
function renderLeaderBoard() { const rows = brandRows().slice(0, 5); $('#leaderboardBody').innerHTML = analyticsHistory().length ? rows.map((row, index) => `<tr class="${row.key === activeBrandKey ? 'is-current' : ''}"><td>${index + 1}</td><td><span class="identity-name">${companyAvatarMarkup(row.name)}<strong>${escapeHtml(row.name)}</strong></span></td><td>${row.sov}%</td><td>${row.visibility}%</td><td>${row.mentions}</td><td>${row.averagePosition ? Number(row.averagePosition.toFixed(2)).toString() : '—'}</td><td>${row.citationRate}%</td><td>${escapeHtml(dominantSentiment(row.sentiments))}</td></tr>`).join('') : '<tr><td colspan="8" class="ws-empty-row">Запустите первую проверку — рейтинг появится здесь</td></tr>'; bindAvatarFallbacks(); }
function modelGroups(answers = analyticsHistory().flatMap(answerRowsFor)) { const groups = new Map(); answers.forEach(result => { const provider = result.provider || ''; const name = PROVIDERS[provider] || result.model || provider; const key = provider || brandKey(name); if (!groups.has(key)) groups.set(key, { provider, name, total: 0, mentioned: 0 }); const row = groups.get(key); row.total++; if (result.mentioned) row.mentioned++; }); return groups; }
function modelRow(row, index, compact = false) { return `<div class="model-row${row.total < 2 ? ' low-sample' : ''}"><span class="model-rank">${index + 1}</span><div class="model-name">${modelAvatarMarkup(row.provider, row.name)}<div><strong>${escapeHtml(row.name)}</strong><small>${row.total < 2 ? 'Мало данных' : `${row.total} проверок`}</small></div></div><div class="model-score"><strong>${row.value}%</strong><span>${row.mentioned} из ${row.total}</span></div><div class="model-meter"><i style="width:${row.value}%"></i></div>${compact ? '' : `<span class="model-verdict">${row.value >= 60 ? 'Высокая видимость' : row.value >= 30 ? 'Есть потенциал' : 'Требует внимания'}</span>`}</div>`; }
function renderModelMetrics() { const groups = [...modelGroups().values()].map(row => ({ ...row, value: percentage(row.mentioned, row.total) })).sort((a, b) => b.value - a.value || b.total - a.total); const empty = '<div class="app-empty"><strong>Нет данных по моделям</strong><span>Запустите проверки в нужных AI-моделях.</span></div>'; $('#modelMetrics').innerHTML = groups.length ? groups.map((row, index) => modelRow(row, index, true)).join('') : empty; $('#visibilityMetrics').innerHTML = groups.length ? groups.map((row, index) => modelRow(row, index)).join('') : ''; $('#visibilityEmpty').hidden = Boolean(groups.length); const best = groups[0]; $('#visibilityInsight').textContent = best ? `Лидер: ${best.name} · ${best.value}%` : 'Нужны проверки'; }
function renderExclusivity() { const mentioned = activeHistory().filter(item => item.mentioned); const exclusive = mentioned.filter(item => !(item.competitors || []).length).length; const compared = mentioned.length - exclusive; $('#exclusivityMetrics').innerHTML = `<div class="app-data-row"><strong>Эксклюзивное упоминание</strong><span>${percentage(exclusive, mentioned.length)}% · ${exclusive} ответов</span></div><div class="app-data-row"><strong>В сравнении с конкурентами</strong><span>${percentage(compared, mentioned.length)}% · ${compared} ответов</span></div>`; }
function chartTheme() {
    const style = getComputedStyle(document.querySelector('.app-body') || document.documentElement);
    return { accent: style.getPropertyValue('--accent').trim(), accent2: style.getPropertyValue('--accent-2').trim(), ok: style.getPropertyValue('--ok').trim(), warn: style.getPropertyValue('--warn').trim(), night: style.getPropertyValue('--night').trim(), text: style.getPropertyValue('--text').trim(), muted: style.getPropertyValue('--text-soft').trim(), border: style.getPropertyValue('--border').trim(), soft: style.getPropertyValue('--bg-soft').trim(), surface: style.getPropertyValue('--surface').trim() };
}
function chartDate(item, index) {
    if (!item?.createdAt) return `Проверка ${index + 1}`;
    return new Date(item.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
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
function renderDashboardCharts() {
    const rowsHistory = analyticsHistory(); const theme = chartTheme(); const allRows = brandRows(rowsHistory); const own = allRows.find(row => row.key === activeBrandKey) || allRows[0]; const rows = [own, ...allRows.filter(row => row.key !== activeBrandKey).slice(0, 4)].filter(Boolean);
    destroyChart('trend');
    const hasHistory = rowsHistory.length > 0;
    const hasTrend = rowsHistory.length > 1;
    $('#overviewChart').hidden = !hasTrend; $('#overviewEmpty').hidden = hasTrend;
    $('#overviewEmpty').querySelector('[data-empty-chart-action]').hidden = false;
    $('#overviewEmpty').querySelector('strong').textContent = 'Начните отслеживать динамику';
    $('#overviewEmpty').querySelector('p').textContent = 'Запустите первую проверку — здесь появится сравнение вашего бренда с конкурентами.';
    if (!hasHistory) { $('#overviewInsight').textContent = 'Начните с проверки'; return; }
    const trendSeries = sovTimeline(rowsHistory, rows.map(row => row.key));
    const count = rowsHistory.length;
    const checkWord = count % 100 >= 11 && count % 100 <= 14 ? 'проверок' : count % 10 === 1 ? 'проверка' : count % 10 >= 2 && count % 10 <= 4 ? 'проверки' : 'проверок';
    const leader = allRows[0]; $('#overviewInsight').textContent = `Лидер: ${leader?.name || '—'} · ${count} ${checkWord}`;
    if (!hasTrend) {
        $('#overviewEmpty').querySelector('strong').textContent = 'Для динамики нужны две проверки';
        $('#overviewEmpty').querySelector('p').textContent = 'Повторите проверку позже — мы сравним изменения и покажем тренд.';
    } else if (window.Chart) dashboardCharts.trend = new Chart($('#overviewChart'), {
        type: 'line',
        data: { labels: rowsHistory.map(chartDate), datasets: rows.map((row, datasetIndex) => {
            const isOwn = brandKey(row.name) === activeBrandKey;
            const comparisonColor = [theme.accent2, theme.ok, theme.warn, theme.muted][datasetIndex - 1] || theme.muted;
            return { label: row.name, data: trendSeries.get(row.key) || [], borderColor: isOwn ? theme.accent : comparisonColor, backgroundColor: isOwn ? theme.accent : comparisonColor, borderWidth: isOwn ? 3 : 1.5, borderDash: isOwn ? [] : [5, 5], tension: .28, cubicInterpolationMode: 'monotone', fill: false, pointRadius: context => isOwn || context.dataIndex === rowsHistory.length - 1 ? 3 : 0, pointHoverRadius: 6, pointBorderWidth: 2, pointBorderColor: theme.surface, pointBackgroundColor: isOwn ? theme.accent : comparisonColor };
        }) },
        options: { responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'top', align: 'start', labels: { usePointStyle: true, pointStyle: 'line', boxWidth: 22, padding: 18, color: theme.text, font: { size: 10, weight: '600' } } }, tooltip: { backgroundColor: theme.surface, titleColor: theme.text, bodyColor: theme.text, borderColor: theme.border, borderWidth: 1, cornerRadius: 8, padding: 10, displayColors: true, usePointStyle: true, callbacks: { title: contexts => { const index = contexts[0]?.dataIndex || 0; const item = rowsHistory[index]; const date = item?.createdAt ? new Date(item.createdAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Дата неизвестна'; return `Проверка ${index + 1} · ${date}`; }, beforeBody: contexts => { const item = rowsHistory[contexts[0]?.dataIndex || 0]; return PROVIDERS[item?.provider] || item?.model || item?.provider || 'AI-модель'; }, label: context => ` ${context.dataset.label}: ${context.parsed.y}%` } } }, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: theme.muted, maxTicksLimit: 6, font: { size: 10, weight: '600' } } }, y: { min: 0, max: 100, border: { display: false }, ticks: { stepSize: 25, color: theme.muted, callback: value => `${value}%`, font: { size: 10 } }, grid: { color: theme.border, drawTicks: false } } } }
    });
    if (hasTrend && !window.Chart) {
        $('#overviewChart').hidden = true; $('#overviewEmpty').hidden = false;
        $('#overviewEmpty').querySelector('[data-empty-chart-action]').hidden = true;
        $('#overviewEmpty').querySelector('strong').textContent = 'График временно недоступен';
        $('#overviewEmpty').querySelector('p').textContent = 'Не удалось загрузить библиотеку графика. Данные в карточках доступны, попробуйте обновить страницу.';
    }
}
async function refreshChecks(render = true) {
    checksLoadState.loading = true; checksLoadState.error = ''; renderReport();
    try {
        const data = await apiRequest('/checks');
        if (!Array.isArray(data.checks)) throw new Error('История проверок получена в неверном формате');
        history = data.checks.map(normalizeStoredCheck).sort((a, b) => a.createdAt - b.createdAt);
        checksLoadState.updatedAt = Date.now();
    } catch (error) { checksLoadState.error = error.message; throw error; }
    finally { checksLoadState.loading = false; if (render) renderAllForActiveBrand(); else renderReport(); }
}
async function deleteCheck(id) {
    const item = history.find(row => row.id === id); if (!item || !confirm(`Удалить проверку «${item.query}» навсегда?`)) return;
    try {
        await apiRequest(`/checks/${encodeURIComponent(id)}`, { method: 'DELETE' }); history = history.filter(row => row.id !== id);
        if (selectedCheckId === id) { selectedCheckId = null; $('#wsResult').hidden = true; }
        if (answerCheckId === id) answerCheckId = null;
        if (reportCheckId === id) renderReportContext(null);
        renderAllForActiveBrand();
    }
    catch (error) { showError(`Не удалось удалить проверку: ${error.message}`); }
}
async function deleteActiveBrand(confirmed = false) {
    const identity = activeBrandIdentity(); if (!identity || projectDeleting || !capability('manage_existing_brands')) return;
    if (confirmed !== true) { setFormStatus('#projectDeleteStatus', ''); openDashboardDialog('projectDeleteDialog'); return; }
    projectDeleting = true;
    const button = $('#confirmDeleteBrand'); button.disabled = true;
    try {
        await apiRequest(`/brands/${encodeURIComponent(identity.id)}`, { method: 'DELETE' });
        brandIdentities = brandIdentities.filter(item => item.canonicalId !== identity.canonicalId);
        history = history.filter(item => item.brandKey !== identity.canonicalId);
        growthTasks = growthTasks.filter(item => brandKey(item.brand) !== identity.canonicalId && item.brandKey !== identity.canonicalId);
        activeBrandKey = brandIdentities[0]?.canonicalId || '';
        projectDraft = null;
        selectedCheckId = null; answerCheckId = null; $('#wsResult').hidden = true; renderReportContext(null);
        if (activeBrandKey) localStorage.setItem(ACTIVE_BRAND_KEY, activeBrandKey); else localStorage.removeItem(ACTIVE_BRAND_KEY);
        $('#wsBrand').value = currentBrand(); renderBrandSelector(); renderAllForActiveBrand();
        await refreshAccess().catch(() => {});
        closeDashboardDialog('projectDeleteDialog');
    } catch (error) { setFormStatus('#projectDeleteStatus', `Не удалось удалить проект: ${error.message}`); }
    finally { projectDeleting = false; button.disabled = false; }
}
function setFormStatus(selector, message, success = false) { const target = $(selector); target.textContent = message; target.className = `account-form-status${success ? ' success' : message ? ' error' : ''}`; }
async function saveAccount(event) {
    event.preventDefault();
    const form = event.currentTarget; if (accountMutationBusy || !form.reportValidity() || !accountState) return;
    const name = $('#accountName').value.trim();
    const body = {};
    if (name !== accountState.name) body.name = name;
    if (!Object.keys(body).length) return setFormStatus('#accountProfileStatus', 'Нет изменений для сохранения.', true);
    accountMutationBusy = true;
    const button = form.querySelector('[type="submit"]'); button.disabled = true; setFormStatus('#accountProfileStatus', '');
    try {
        const data = await apiRequest('/account', { method: 'PATCH', body: JSON.stringify(body) });
        accountState = normalizeAccount(data.account || data);
        renderAccountProfile();
        setFormStatus('#accountProfileStatus', 'Профиль сохранён.', true);
    } catch (error) { setFormStatus('#accountProfileStatus', error.message); }
    finally { accountMutationBusy = false; button.disabled = false; }
}
async function changeEmail(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (accountMutationBusy || !form.reportValidity() || !accountState) return;
    const email = $('#accountEmailNew').value.trim();
    if (email.toLocaleLowerCase('ru-RU') === String(accountState.email || '').toLocaleLowerCase('ru-RU')) return setFormStatus('#accountEmailStatus', 'Укажите новый email.');
    accountMutationBusy = true;
    const button = form.querySelector('[type="submit"]'); button.disabled = true; setFormStatus('#accountEmailStatus', '');
    try {
        const data = await apiRequest('/account', { method: 'PATCH', body: JSON.stringify({ email, current_password: $('#accountEmailCurrentPassword').value }) });
        accountState = normalizeAccount(data.account || data);
        renderAccountProfile();
        form.reset();
        if (data.reauth_required) { setFormStatus('#accountEmailStatus', 'Email изменён. Выполняется повторный вход…', true); setTimeout(() => window.location.replace('index.html?auth=login'), 500); return; }
        setFormStatus('#accountEmailStatus', 'Email изменён.', true);
    } catch (error) { setFormStatus('#accountEmailStatus', error.message); }
    finally { accountMutationBusy = false; button.disabled = false; }
}
async function changePassword(event) {
    event.preventDefault();
    if (accountMutationBusy) return;
    const form = event.currentTarget; const currentPassword = $('#accountPasswordCurrent').value; const newPassword = $('#accountPasswordNew').value; const confirmation = $('#accountPasswordConfirm').value;
    $('#accountPasswordConfirm').setCustomValidity(newPassword === confirmation ? '' : 'Пароли не совпадают');
    if (!form.reportValidity()) return;
    accountMutationBusy = true;
    const button = form.querySelector('[type="submit"]'); button.disabled = true; setFormStatus('#accountPasswordStatus', '');
    try {
        const data = await apiRequest('/account', { method: 'PATCH', body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) });
        if (data.reauth_required) { setFormStatus('#accountPasswordStatus', 'Пароль изменён. Выполняется повторный вход…', true); setTimeout(() => window.location.replace('index.html?auth=login'), 500); return; }
        form.reset(); setFormStatus('#accountPasswordStatus', 'Пароль изменён.', true);
    } catch (error) { setFormStatus('#accountPasswordStatus', error.message); }
    finally { accountMutationBusy = false; button.disabled = false; }
}
async function deleteAccount(event) {
    event.preventDefault();
    const form = event.currentTarget; if (accountMutationBusy || !form.reportValidity()) return;
    if ($('#deleteAccountConfirmation').value !== 'УДАЛИТЬ') return setFormStatus('#deleteAccountStatus', 'Введите УДАЛИТЬ без кавычек.');
    accountMutationBusy = true;
    const button = $('#deleteAccount'); button.disabled = true; setFormStatus('#deleteAccountStatus', '');
    try { await apiRequest('/account', { method: 'DELETE', body: JSON.stringify({ current_password: $('#deleteAccountPassword').value, confirmation: 'УДАЛИТЬ' }) }); localStorage.removeItem(ACTIVE_BRAND_KEY); window.location.replace('index.html'); }
    catch (error) { setFormStatus('#deleteAccountStatus', error.message); }
    finally { accountMutationBusy = false; button.disabled = false; }
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
    const clientId = String(id);
    selectedAdminClientId = clientId; $('#adminClientEditor').innerHTML = '<div class="admin-loading"><i class="fa-solid fa-circle-notch fa-spin"></i> Загружаем профиль…</div>';
    try {
        const data = await apiRequest(`/admin/clients/${encodeURIComponent(id)}`);
        if (selectedAdminClientId !== clientId) return;
        renderAdminClient(data.account || data.client || data, data.access || data);
        $$('[data-admin-client]').forEach(button => button.classList.toggle('active', button.dataset.adminClient === selectedAdminClientId));
    } catch (error) { if (selectedAdminClientId === clientId) $('#adminClientEditor').innerHTML = `<div class="admin-error">${escapeHtml(error.message)}</div>`; }
}
function nullableLimitValue(quota) { return quota.limit === null ? '' : String(quota.limit); }
function renderAdminClient(accountValue, accessValue) {
    const account = normalizeAdminAccount(accountValue); const access = normalizeAccess(accessValue); const expires = parseDate(access.expiresAt);
    $('#adminClientEditor').innerHTML = `<div class="app-card-head"><div><h2>${escapeHtml(account.name || 'Без имени')}</h2><span>${escapeHtml(account.email)}</span></div><span class="account-role">${account.role === 'admin' ? 'Администратор' : 'Клиент'}</span></div><dl class="account-access-meta admin-client-meta"><div><dt>ID</dt><dd>${escapeHtml(account.id)}</dd></div><div><dt>Регистрация</dt><dd>${formatDate(account.createdAt, '—')}</dd></div><div><dt>Использование</dt><dd>Проверки: ${escapeHtml(quotaText(access.checks))}<br>Бренды: ${escapeHtml(quotaText(access.brands))}</dd></div></dl><form class="admin-access-form" id="adminAccessForm"><label>Статус<select id="adminAccessStatus"><option value="pending">Ожидает</option><option value="active">Активен</option><option value="suspended">Приостановлен</option></select></label><label>Тариф<select id="adminAccessPlan"><option value="basic">Basic</option><option value="pro">Pro</option><option value="business">Business</option><option value="custom">Custom</option></select></label><label>Доступ до<input id="adminAccessExpires" type="date" value="${expires ? expires.toISOString().slice(0, 10) : ''}"><small>Оставьте пустым для бессрочного доступа</small></label><div class="admin-limit"><label>Лимит проверок<input id="adminChecksLimit" type="number" min="0" step="1" value="${nullableLimitValue(access.checks)}"></label><label class="admin-unlimited"><input id="adminChecksUnlimited" type="checkbox"${access.checks.unlimited ? ' checked' : ''}>Безлимит</label></div><div class="admin-limit"><label>Лимит брендов<input id="adminBrandsLimit" type="number" min="0" step="1" value="${nullableLimitValue(access.brands)}"></label><label class="admin-unlimited"><input id="adminBrandsUnlimited" type="checkbox"${access.brands.unlimited ? ' checked' : ''}>Безлимит</label></div><label class="admin-reset"><input id="adminResetUsage" type="checkbox">Сбросить текущее использование квот</label><p class="account-form-status" id="adminAccessStatusMessage" role="status"></p><button class="btn btn-primary" type="submit">Сохранить доступ</button></form>`;
    $('#adminAccessStatus').value = access.administrativeStatus === 'suspended' ? 'suspended' : access.administrativeStatus === 'active' ? 'active' : 'pending'; $('#adminAccessPlan').value = access.plan;
    const syncUnlimited = (checkbox, input) => { $(input).disabled = $(checkbox).checked; $(checkbox).addEventListener('change', () => { $(input).disabled = $(checkbox).checked; if (!$(checkbox).checked && !$(input).value) $(input).value = '0'; }); };
    syncUnlimited('#adminChecksUnlimited', '#adminChecksLimit'); syncUnlimited('#adminBrandsUnlimited', '#adminBrandsLimit');
    $('#adminAccessPlan').addEventListener('change', async event => {
        const form = $('#adminAccessForm'); const clientId = selectedAdminClientId;
        if (!adminTariffs.length || adminTariffSaves.size) await loadAdminTariffs();
        if (form !== $('#adminAccessForm') || clientId !== selectedAdminClientId) return;
        const tariff = adminTariffs.find(item => item.plan === event.target.value);
        if (!tariff) return;
        $('#adminChecksUnlimited').checked = false; $('#adminChecksLimit').disabled = false; $('#adminChecksLimit').value = String(tariff.checks_limit);
        $('#adminBrandsUnlimited').checked = false; $('#adminBrandsLimit').disabled = false; $('#adminBrandsLimit').value = String(tariff.brands_limit);
        setFormStatus('#adminAccessStatusMessage', 'Подставлены квоты тарифа. Проверьте условия и нажмите «Сохранить доступ».', true);
    });
    $('#adminAccessForm').addEventListener('submit', saveAdminAccess);
}
async function saveAdminAccess(event) {
    event.preventDefault(); const form = event.currentTarget; if (!form.reportValidity() || !selectedAdminClientId) return;
    const clientId = selectedAdminClientId;
    const expiresDate = $('#adminAccessExpires').value;
    const body = { status: $('#adminAccessStatus').value, plan: $('#adminAccessPlan').value, expires_at: expiresDate ? `${expiresDate}T23:59:59.999Z` : null, checks_limit: $('#adminChecksUnlimited').checked ? null : Number($('#adminChecksLimit').value), brands_limit: $('#adminBrandsUnlimited').checked ? null : Number($('#adminBrandsLimit').value), reset_usage: $('#adminResetUsage').checked };
    const button = form.querySelector('[type="submit"]'); button.disabled = true; setFormStatus('#adminAccessStatusMessage', '');
    try { const data = await apiRequest(`/admin/clients/${encodeURIComponent(clientId)}/access`, { method: 'PATCH', body: JSON.stringify(body) }); if (clientId !== selectedAdminClientId || form !== $('#adminAccessForm')) return; renderAdminClient(data.account || data.client || data, data.access || data); setFormStatus('#adminAccessStatusMessage', 'Настройки доступа сохранены.', true); await loadAdminClients(adminPage); }
    catch (error) { if (clientId === selectedAdminClientId && form === $('#adminAccessForm')) { setFormStatus('#adminAccessStatusMessage', error.message); button.disabled = false; } }
}
function selectAdminTab(tab) {
    if (accountState?.role !== 'admin') return;
    $$('[data-admin-panel]').forEach(panel => { panel.hidden = panel.dataset.adminPanel !== tab; });
    $$('[data-admin-tab]').forEach(button => {
        const active = button.dataset.adminTab === tab;
        button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1;
    });
    if (tab === 'tariffs') loadAdminTariffs();
    if (tab === 'vouchers') { loadAdminTariffs(); loadVoucherBatches(); }
    if (tab === 'ai-requests') {
        if (!aiRequestQuery) applyAiRequestFilters();
        else loadAiRequests(aiRequestPage);
    }
}
let aiRequestPage = 1;
let aiRequestQuery = null;
let aiRequestLoadId = 0;
const aiRequestOperations = { check: 'Проверка', check_all: 'Все модели', prompt_suggestions: 'Подсказки', brief: 'Бриф' };
const aiRequestStatuses = { success: 'Успешно', http_error: 'Ошибка HTTP', network_error: 'Ошибка сети', provider_error: 'Ошибка провайдера' };
function aiTokenCount(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('ru-RU') : '—';
}
function aiRequestMarkup(item) {
    const field = (label, value) => `<div><dt>${label}</dt><dd>${escapeHtml(value ?? '—')}</dd></div>`;
    const model = item.returned_model || 'Не сообщена';
    const requested = item.requested_model && item.requested_model !== item.returned_model ? `<small>Запрошена: ${escapeHtml(item.requested_model)}</small>` : '';
    const extras = [item.cached_tokens != null ? `Из кэша: ${aiTokenCount(item.cached_tokens)}` : '', item.reasoning_tokens != null ? `Reasoning: ${aiTokenCount(item.reasoning_tokens)}` : ''].filter(Boolean).join(' · ');
    return `<article class="ai-request-row"><dl class="ai-request-grid">${field('Время', formatDateTime(item.started_at))}<div><dt>Пользователь</dt><dd>${escapeHtml(item.user_name || 'Без имени')}<small>${escapeHtml(item.user_email || '')}</small><small>ID: ${escapeHtml(item.user_id)}</small></dd></div><div><dt>Провайдер / модель</dt><dd>${escapeHtml(PROVIDERS[item.provider] || item.provider)}<strong>${escapeHtml(model)}</strong>${requested}</dd></div><div><dt>Операция</dt><dd>${escapeHtml(aiRequestOperations[item.operation] || item.operation)}<small>${escapeHtml(({ generation: 'Генерация', analysis: 'Анализ', suggestions: 'Подсказки' })[item.stage] || item.stage || '—')} · Попытка ${escapeHtml(item.attempt)}</small></dd></div><div><dt>Токены</dt><dd>Вход: ${escapeHtml(aiTokenCount(item.input_tokens))}<small>Выход: ${escapeHtml(aiTokenCount(item.output_tokens))} · Всего: ${escapeHtml(aiTokenCount(item.total_tokens))}</small>${extras ? `<small>${escapeHtml(extras)}</small>` : ''}</dd></div><div><dt>Статус</dt><dd class="ai-request-status${item.status === 'success' ? '' : ' ai-request-failed'}">${escapeHtml(aiRequestStatuses[item.status] || item.status)}<small>${item.http_status != null ? `HTTP ${escapeHtml(item.http_status)} · ` : ''}${escapeHtml(aiTokenCount(item.duration_ms))} мс</small>${item.error_category ? `<small>${escapeHtml(item.error_category)}</small>` : ''}</dd></div></dl><details class="ai-request-details"><summary>Идентификаторы</summary><p>Запрос: ${escapeHtml(item.request_id)} · Запись: ${escapeHtml(item.id)}${item.check_id != null ? ` · Проверка: ${escapeHtml(item.check_id)}` : ''}</p></details></article>`;
}
function applyAiRequestFilters() {
    const form = $('#aiRequestFilters');
    $('#aiRequestTo').setCustomValidity('');
    if (!form.reportValidity()) return;
    const from = new Date($('#aiRequestFrom').value);
    const toValue = $('#aiRequestTo').value;
    const to = toValue ? new Date(toValue) : null;
    if (to && to <= from) {
        $('#aiRequestTo').setCustomValidity('Дата окончания должна быть позже даты начала.');
        $('#aiRequestTo').reportValidity(); return;
    }
    const params = new URLSearchParams({ date_from: from.toISOString() });
    if (to) params.set('date_to', to.toISOString());
    for (const [key, selector] of Object.entries({ user: '#aiRequestUser', provider: '#aiRequestProvider', model: '#aiRequestModel', operation: '#aiRequestOperation', status: '#aiRequestStatus' })) {
        const value = $(selector).value.trim(); if (value) params.set(key, value);
    }
    aiRequestQuery = params.toString();
    loadAiRequests(1);
}
async function loadAiRequests(page = 1) {
    if (accountState?.role !== 'admin' || !aiRequestQuery) return;
    const loadId = ++aiRequestLoadId;
    aiRequestPage = Math.max(1, page);
    const params = new URLSearchParams(aiRequestQuery);
    params.set('page', String(aiRequestPage)); params.set('page_size', '50');
    $('#aiRequestResults').setAttribute('aria-busy', 'true');
    $('#aiRequestList').innerHTML = '<div class="admin-loading" role="status">Загружаем AI-запросы…</div>';
    $('#aiRequestSummary').replaceChildren(); $('#aiRequestPage').textContent = '';
    $('#aiRequestRetry').hidden = true; $('#aiRequestPrev').disabled = true; $('#aiRequestNext').disabled = true;
    try {
        const data = await apiRequest(`/admin/ai-requests?${params}`);
        if (loadId !== aiRequestLoadId) return;
        const summary = data.summary || {};
        $('#aiRequestSummary').innerHTML = [['Попыток', summary.attempts], ['Ошибок', summary.errors], ['Входных токенов', summary.input_tokens], ['Выходных токенов', summary.output_tokens], ['Всего токенов', summary.total_tokens], ['Без полного расхода', summary.missing_usage]].map(([label, value]) => `<div><strong>${escapeHtml(aiTokenCount(value))}</strong><span>${label}</span></div>`).join('');
        const items = Array.isArray(data.items) ? data.items : [];
        $('#aiRequestList').innerHTML = items.length ? items.map(aiRequestMarkup).join('') : '<div class="app-empty"><strong>Обращений не найдено</strong><span>Измените период или фильтры.</span></div>';
        const pages = Math.max(1, Math.ceil(data.total / data.page_size));
        aiRequestPage = data.page;
        $('#aiRequestPage').textContent = `${data.page} из ${pages} · Записей: ${aiTokenCount(data.total)}`;
        $('#aiRequestPrev').disabled = data.page <= 1; $('#aiRequestNext').disabled = data.page >= pages;
    } catch (error) {
        if (loadId !== aiRequestLoadId) return;
        $('#aiRequestList').innerHTML = `<div class="admin-error" role="alert">${escapeHtml(error.message)}</div>`;
        $('#aiRequestRetry').hidden = false;
    } finally {
        if (loadId === aiRequestLoadId) $('#aiRequestResults').setAttribute('aria-busy', 'false');
    }
}
async function loadAdminTariffs() {
    if (accountState?.role !== 'admin') return;
    if (adminTariffsLoad) return adminTariffsLoad;
    if (adminTariffSaves.size) { await Promise.allSettled([...adminTariffSaves]); return loadAdminTariffs(); }
    $('#adminTariffRetry').hidden = true; setFormStatus('#adminTariffStatus', '');
    $('#adminTariffList').innerHTML = '<div class="admin-loading">Загружаем тарифы…</div>';
    adminTariffsLoad = (async () => { try {
        const data = await apiRequest('/admin/tariffs');
        adminTariffs = Array.isArray(data.items) ? data.items : [];
        if (adminTariffs.length !== 3) throw new Error('Не удалось загрузить настройки всех тарифов.');
        $('#adminTariffList').innerHTML = adminTariffs.map(tariff => `<form class="account-form admin-tariff-form" data-tariff="${escapeHtml(tariff.plan)}"><h3>${escapeHtml(planLabel(tariff.plan))}</h3><label>Проверок в месяц<input name="checks_limit" type="number" min="0" max="2147483647" step="1" value="${escapeHtml(tariff.checks_limit)}" required></label><label>Одновременно сохранённых брендов<input name="brands_limit" type="number" min="0" max="2147483647" step="1" value="${escapeHtml(tariff.brands_limit)}" required></label><p class="account-form-status" role="status"></p><button class="btn btn-primary btn-sm" type="submit">Сохранить</button></form>`).join('');
        $$('[data-tariff]').forEach(form => form.addEventListener('submit', saveAdminTariff));
    } catch (error) {
        adminTariffs = []; $('#adminTariffList').innerHTML = '';
        setFormStatus('#adminTariffStatus', error.message); $('#adminTariffRetry').hidden = false;
    } finally { adminTariffsLoad = null; renderVoucherBatchSummary(); }
    return adminTariffs;
    })();
    renderVoucherBatchSummary();
    return adminTariffsLoad;
}
async function saveAdminTariff(event) {
    event.preventDefault(); const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]'); const status = form.querySelector('[role="status"]');
    let request = null;
    button.disabled = true; status.textContent = ''; status.className = 'account-form-status';
    try {
        const body = { checks_limit: Number(form.elements.checks_limit.value), brands_limit: Number(form.elements.brands_limit.value) };
        request = apiRequest(`/admin/tariffs/${encodeURIComponent(form.dataset.tariff)}`, { method: 'PATCH', body: JSON.stringify(body) });
        adminTariffSaves.add(request); renderVoucherBatchSummary();
        const tariff = await request;
        adminTariffs = adminTariffs.map(item => item.plan === tariff.plan ? tariff : item);
        status.textContent = 'Сохранено. Выпущенные ваучеры и аккаунты не изменены.'; status.className = 'account-form-status success';
        renderVoucherBatchSummary();
    } catch (error) { status.textContent = error.message; status.className = 'account-form-status error'; }
    finally { adminTariffSaves.delete(request); button.disabled = false; renderVoucherBatchSummary(); }
}
function renderVoucherBatchSummary() {
    const tariff = adminTariffs.find(item => item.plan === $('#voucherBatchPlan').value);
    $('#voucherBatchSummary').textContent = tariff ? `${planLabel(tariff.plan)}: ${tariff.checks_limit} проверок в месяц, брендов — ${tariff.brands_limit}. Срок начнётся при активации. Условия партии будут зафиксированы при выпуске.` : 'Настройки тарифов недоступны. Откройте «Тарифы» и повторите загрузку.';
    $('#voucherBatchCreate').disabled = voucherBatchCreating || Boolean(adminTariffsLoad) || Boolean(adminTariffSaves.size) || !tariff;
}
async function createVoucherBatch(event) {
    event.preventDefault(); const form = event.currentTarget;
    if (voucherBatchCreating || adminTariffsLoad || adminTariffSaves.size || !form.reportValidity() || !adminTariffs.length) return;
    if ($('#voucherIssuedCodes').value && !confirm('Вы сохранили коды предыдущей партии? Новая партия заменит показанный список.')) return;
    voucherBatchCreating = true; renderVoucherBatchSummary(); setFormStatus('#voucherBatchStatus', '');
    try {
        const body = { plan: $('#voucherBatchPlan').value, quantity: Number($('#voucherBatchQuantity').value), duration_days: Number($('#voucherBatchDuration').value) };
        const data = await apiRequest('/admin/voucher-batches', { method: 'POST', body: JSON.stringify(body) });
        const codes = (data.vouchers || []).map(item => item.code).filter(code => typeof code === 'string' && code);
        if (codes.length !== body.quantity) throw new Error('Полные коды партии не получены. Проверьте список партий перед новым выпуском.');
        $('#voucherIssuedCodes').value = codes.join('\n'); $('#voucherIssued').hidden = false;
        setFormStatus('#voucherCopyStatus', ''); setFormStatus('#voucherBatchStatus', `Партия №${data.batch.id} создана. Сохраните ${codes.length} кодов.`, true);
        selectedVoucherBatchId = String(data.batch.id);
        await loadVoucherBatches(); await loadVoucherBatch(selectedVoucherBatchId);
    } catch (error) {
        const uncertain = !(error instanceof ApiError) || error.status >= 500;
        setFormStatus('#voucherBatchStatus', uncertain ? 'Не удалось получить коды. Партия могла быть создана: обновите список и проверьте её перед новым выпуском.' : error.message);
    } finally { voucherBatchCreating = false; renderVoucherBatchSummary(); }
}
async function copyVoucherCodes() {
    const field = $('#voucherIssuedCodes');
    if (!field.value) return;
    try { await navigator.clipboard.writeText(field.value); setFormStatus('#voucherCopyStatus', 'Коды скопированы.', true); }
    catch { field.focus(); field.select(); setFormStatus('#voucherCopyStatus', 'Коды выделены. Нажмите Ctrl+C, чтобы скопировать их.'); }
}
async function loadVoucherBatches() {
    if (accountState?.role !== 'admin') return;
    const list = $('#voucherBatchList'); const button = $('#voucherRefreshBatches'); button.disabled = true;
    list.innerHTML = '<div class="admin-loading">Загружаем партии…</div>';
    try {
        const data = await apiRequest('/admin/voucher-batches'); const batches = Array.isArray(data.items) ? data.items : [];
        list.innerHTML = batches.length ? batches.map(batch => `<button class="voucher-batch-item${String(batch.id) === selectedVoucherBatchId ? ' active' : ''}" type="button" data-voucher-batch="${escapeHtml(batch.id)}"><span><strong>№${escapeHtml(batch.id)} · ${escapeHtml(planLabel(batch.plan))}</strong><small>${escapeHtml(formatDateTime(batch.created_at))} · ${escapeHtml(batch.duration_days)} дней · ${escapeHtml(batch.checks_limit)} проверок/мес. · ${escapeHtml(batch.brands_limit)} брендов</small></span><span><strong>${escapeHtml(batch.quantity)} кодов</strong><small>Доступны: ${escapeHtml(batch.available_count)} · Использованы: ${escapeHtml(batch.redeemed_count)} · Отозваны: ${escapeHtml(batch.revoked_count)}</small></span></button>`).join('') : '<div class="app-empty"><strong>Пока нет ваучеров</strong><span>Выберите тариф и создайте первую партию.</span></div>';
        $$('[data-voucher-batch]').forEach(item => item.addEventListener('click', () => loadVoucherBatch(item.dataset.voucherBatch)));
    } catch (error) { list.innerHTML = `<div class="admin-error">${escapeHtml(error.message)}. Нажмите «Обновить», чтобы повторить.</div>`; }
    finally { button.disabled = false; }
}
async function loadVoucherBatch(id) {
    selectedVoucherBatchId = String(id); const detail = $('#voucherBatchDetail'); detail.hidden = false;
    detail.innerHTML = '<div class="admin-loading">Загружаем ваучеры…</div>';
    try {
        const data = await apiRequest(`/admin/voucher-batches/${encodeURIComponent(id)}`);
        if (selectedVoucherBatchId !== String(id)) return;
        const labels = { available: 'Доступен', redeemed: 'Использован', revoked: 'Отозван' };
        detail.innerHTML = `<h3>Ваучеры партии №${escapeHtml(data.batch.id)}</h3><p class="voucher-help">Полные коды здесь не отображаются. Отзыв доступен только до активации.</p><div class="voucher-list">${(data.vouchers || []).map(item => `<article class="voucher-row"><code>${escapeHtml(item.code_mask)}</code><div><strong>${escapeHtml(labels[item.status] || item.status)}</strong>${item.redeemed_at ? `<small>${escapeHtml(formatDateTime(item.redeemed_at))}</small>${item.redeemed_by ? `<button class="app-text-action" type="button" data-voucher-recipient="${escapeHtml(item.redeemed_by)}">Пользователь №${escapeHtml(item.redeemed_by)}</button>` : '<small>Аккаунт получателя удалён</small>'}` : item.revoked_at ? `<small>${escapeHtml(formatDateTime(item.revoked_at))}</small>` : ''}</div>${item.status === 'available' ? `<button class="btn btn-ghost btn-sm" type="button" data-revoke-voucher="${escapeHtml(item.id)}">Отозвать</button>` : ''}</article>`).join('')}</div><p class="account-form-status" id="voucherRevokeStatus" role="status"></p>`;
        $$('[data-voucher-batch]').forEach(item => item.classList.toggle('active', item.dataset.voucherBatch === selectedVoucherBatchId));
        $$('[data-revoke-voucher]').forEach(button => button.addEventListener('click', () => revokeVoucher(button.dataset.revokeVoucher, button)));
        $$('[data-voucher-recipient]').forEach(button => button.addEventListener('click', () => { selectAdminTab('clients'); loadAdminClient(button.dataset.voucherRecipient); }));
    } catch (error) { if (selectedVoucherBatchId === String(id)) detail.innerHTML = `<div class="admin-error">${escapeHtml(error.message)}. Выберите партию, чтобы повторить.</div>`; }
}
async function revokeVoucher(id, button) {
    if (!confirm('Отозвать этот ваучер? Активировать его больше не получится.')) return;
    button.disabled = true; const batchId = selectedVoucherBatchId;
    try {
        await apiRequest(`/admin/vouchers/${encodeURIComponent(id)}/revoke`, { method: 'POST' });
        await loadVoucherBatches(); if (selectedVoucherBatchId === batchId) await loadVoucherBatch(batchId);
    } catch (error) { if ($('#voucherRevokeStatus')) setFormStatus('#voucherRevokeStatus', error.message); button.disabled = false; }
}
async function initializeDashboard() {
    if (dashboardInitializing) return;
    dashboardInitializing = true; dashboardReady = false;
    document.body.classList.add('auth-pending');
    $('#dashboardLoadState').hidden = false; $('#dashboardLoadRetry').hidden = true;
    $('#dashboardLoadTitle').textContent = 'Открываем ваш кабинет';
    $('#dashboardLoadMessage').textContent = 'Загружаем настройки и сохранённые проверки…';
    try {
        const session = dashboardSessionAttempted ? loadSession() : window.vidnoSessionPromise;
        dashboardSessionAttempted = true;
        await session;
        const [accountData, accessData] = await Promise.all([apiRequest('/account'), apiRequest('/access')]);
        accountState = normalizeAccount(accountData.account || accountData);
        accessState = normalizeAccess(accessData.access || accessData);
        renderAccountProfile(); renderAccountAccess(); renderAccessBanner(); applyAccessGating();
        const brandData = await apiRequest('/brands');
        brandIdentities = (Array.isArray(brandData.brands) ? brandData.brands : []).map(normalizeBrandRecord).filter(item => item.canonicalId && item.canonicalName);
        activeBrandKey = loadActiveBrandKey();
        const [checkData, taskData, dismissedData] = await Promise.all([apiRequest('/checks'), apiRequest('/growth-tasks'), apiRequest('/dismissed-opportunities')]);
        history = (Array.isArray(checkData.checks) ? checkData.checks : []).map(normalizeStoredCheck).sort((a, b) => a.createdAt - b.createdAt);
        checksLoadState.error = ''; checksLoadState.updatedAt = Date.now();
        growthTasks = (Array.isArray(taskData.tasks) ? taskData.tasks : []).map(normalizeGrowthTask);
        dismissedOpportunities = new Set(Array.isArray(dismissedData.items) ? dismissedData.items : []);
        $('#wsBrand').value = currentBrand(); renderBrandSelector(); renderAllForActiveBrand();
        dashboardReady = true;
        document.body.classList.remove('dashboard-load-error');
        $('#dashboardLoadState').hidden = true;
        const latest = historyForActiveBrand().at(-1);
        if (needsOnboarding() && latest) {
            $('#onboardingQuery').value = latest.query;
            if (successfulCheck(latest)) openSavedCheck(latest.id, true);
            else if (latest.status === 'failed') showCheckError(`Последняя проверка не выполнена: ${latest.error === 'interrupted' ? 'ожидание превысило час' : latest.error || 'ошибка AI'}. Можно повторить запуск.`);
        }
        const running = historyForActiveBrand().find(item => item.status === 'running');
        if (running) { $('#wsQuery').value = running.query; trackRunningCheck(running); }
        renderOnboarding();
        document.body.classList.remove('auth-pending');
        if (needsOnboarding()) $('#onboardingTitle').focus();
    } catch (error) {
        document.body.classList.remove('auth-pending'); document.body.classList.add('dashboard-load-error');
        $('#onboarding').hidden = true;
        $('#dashboardLoadState').hidden = false;
        $('#dashboardLoadTitle').textContent = 'Не удалось загрузить кабинет';
        $('#dashboardLoadMessage').textContent = error.message;
        $('#dashboardLoadRetry').hidden = false;
    } finally { dashboardInitializing = false; }
}
$('#dashboardLoadRetry').addEventListener('click', initializeDashboard);
$('#onboardingCompanyForm').addEventListener('submit', saveOnboardingCompany);
$('#onboardingBrand').addEventListener('input', event => event.target.setCustomValidity(''));
$('#onboardingDomain').addEventListener('input', event => event.target.setCustomValidity(''));
$('#onboardingCheckForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (event.currentTarget.reportValidity() && !$('#onboardingRunCheck').disabled) await runWorkspaceCheck(currentBrand(), $('#onboardingQuery').value);
});
$('#onboardingSuggest').addEventListener('click', suggestOnboardingPrompts);
$('#onboardingRefreshAccess').addEventListener('click', async event => {
    event.currentTarget.disabled = true;
    try { await refreshAccess(); showCheckError(''); }
    catch (error) { showCheckError(`Не удалось проверить доступ: ${error.message}`); }
    finally { $('#onboardingRefreshAccess').disabled = false; }
});
$('#onboardingLogout').addEventListener('click', () => $('#appLogout').click());
$('#onboardingRefreshStatus').addEventListener('click', recoverCheckState);
$('#onboardingRefreshCompany').addEventListener('click', recoverCompanySave);
$('#wsRefreshStatus').addEventListener('click', recoverCheckState);
$('#resultAnswers').addEventListener('click', () => selectView('answers', selectedCheckId));
$('#resultAnalytics').addEventListener('click', () => selectView('home', selectedCheckId));
$('#resultReport').addEventListener('click', () => selectView('reports', selectedCheckId));
$('#reportBackToCheck').addEventListener('click', () => openSavedCheck(reportCheckId));
$('#historyToggle').addEventListener('click', () => { historyExpanded = !historyExpanded; renderHistory(); });
$('#checkDetailsDialog').addEventListener('click', event => {
    if (event.target.closest('[data-check-details-close]')) $('#checkDetailsDialog').close();
    const resultButton = event.target.closest('[data-open-check-result]');
    if (resultButton) { $('#checkDetailsDialog').close(); openSavedCheck(resultButton.dataset.openCheckResult); }
    const repeatButton = event.target.closest('[data-repeat-check]');
    if (repeatButton && !repeatButton.disabled) repeatSavedCheck(repeatButton.dataset.repeatCheck);
});
document.addEventListener('visibilitychange', async () => {
    if (document.hidden || !dashboardReady) return;
    await refreshAccess().catch(() => {});
    if (trackedCheckId || checkOutcomeUnknown) await recoverCheckState();
});
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
{
    const start = new Date(); start.setDate(start.getDate() - 30); start.setSeconds(0, 0);
    const local = new Date(start.getTime() - start.getTimezoneOffset() * 60000);
    $('#aiRequestFrom').value = local.toISOString().slice(0, 16);
}
$('#aiRequestFilters').addEventListener('submit', event => { event.preventDefault(); applyAiRequestFilters(); });
$('#aiRequestTo').addEventListener('input', () => $('#aiRequestTo').setCustomValidity(''));
$('#aiRequestFrom').addEventListener('input', () => $('#aiRequestTo').setCustomValidity(''));
$('#aiRequestRetry').addEventListener('click', () => loadAiRequests(aiRequestPage));
$('#aiRequestPrev').addEventListener('click', () => loadAiRequests(aiRequestPage - 1));
$('#aiRequestNext').addEventListener('click', () => loadAiRequests(aiRequestPage + 1));
$('#voucherActivationForm').addEventListener('submit', redeemVoucher);
$('#voucherRefreshAccess').addEventListener('click', recoverVoucherActivation);
$('#voucherCode').addEventListener('input', () => setFormStatus('#voucherActivationStatus', ''));
$$('[data-admin-tab]').forEach(button => button.addEventListener('click', () => selectAdminTab(button.dataset.adminTab)));
$('.admin-section-tabs').addEventListener('keydown', event => {
    const tabs = $$('[data-admin-tab]'); const index = tabs.indexOf(document.activeElement);
    if (index < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    selectAdminTab(tabs[next].dataset.adminTab); tabs[next].focus();
});
$('#adminTariffRetry').addEventListener('click', loadAdminTariffs);
$('#voucherBatchPlan').addEventListener('change', renderVoucherBatchSummary);
$('#voucherBatchForm').addEventListener('submit', createVoucherBatch);
$('#voucherRefreshBatches').addEventListener('click', loadVoucherBatches);
$('#voucherCopyCodes').addEventListener('click', copyVoucherCodes);
const dashboardDialogOpeners = new Map();
function openDashboardDialog(id) {
    const dialog = document.getElementById(id); if (!dialog || dialog.open) return;
    dashboardDialogOpeners.set(id, document.activeElement);
    dialog.showModal();
    if (id === 'projectLeaveDialog') $('#projectLeaveCancel')?.focus();
}
function closeDashboardDialog(id) {
    const dialog = document.getElementById(id); if (!dialog?.open) return;
    dialog.close();
}
function setProjectPicker(open, focusOption = false) {
    const trigger = $('#projectPickerTrigger'); const menu = $('#projectPickerMenu');
    if (!trigger || !menu) return;
    trigger.setAttribute('aria-expanded', String(open)); menu.hidden = !open;
    if (open) { closeAccountMenu(); if (focusOption) (menu.querySelector('[aria-selected="true"]') || menu.querySelector('[role="option"]'))?.focus(); }
}
function closeMobileNavigation(restoreFocus = false) {
    document.body.classList.remove('mobile-nav-open');
    $('#mobileNavToggle')?.setAttribute('aria-expanded', 'false');
    if ($('#mobileNavBackdrop')) $('#mobileNavBackdrop').hidden = true;
    if (restoreFocus) $('#mobileNavToggle')?.focus();
}
function bindDashboardDesign() {
    $('#projectPickerTrigger')?.addEventListener('click', event => { event.stopPropagation(); setProjectPicker($('#projectPickerMenu').hidden); });
    $('#projectPickerTrigger')?.addEventListener('keydown', event => { if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setProjectPicker(true, true); } });
    $('#projectPickerMenu')?.addEventListener('click', event => {
        event.stopPropagation(); const option = event.target.closest('[data-project-key]');
        if (!option) return; setProjectPicker(false); setActiveBrand(option.dataset.projectKey); $('#projectPickerTrigger').focus();
    });
    $('#projectPickerMenu')?.addEventListener('keydown', event => {
        const items = [...event.currentTarget.querySelectorAll('[role="option"]')]; const index = items.indexOf(document.activeElement);
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && items.length) {
            event.preventDefault(); const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[next].focus();
        }
        if (event.key === 'Tab') setProjectPicker(false);
    });
    $('#accountMenuTrigger').addEventListener('click', () => setProjectPicker(false));
    document.addEventListener('click', event => {
        if (!event.target.closest('.app-project-control')) setProjectPicker(false);
        if (!event.target.closest('[data-metric-help], [role="tooltip"]')) $$('[data-metric-help]').forEach(button => button.setAttribute('aria-expanded', 'false'));
    });
    $$('[data-metric-help]').forEach(button => {
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('focus', () => { delete button.dataset.tooltipDismissed; });
        button.addEventListener('blur', () => { delete button.dataset.tooltipDismissed; });
        button.addEventListener('pointerenter', () => { delete button.dataset.tooltipDismissed; });
        button.addEventListener('click', event => { event.stopPropagation(); delete button.dataset.tooltipDismissed; const next = button.getAttribute('aria-expanded') !== 'true'; $$('[data-metric-help]').forEach(item => item.setAttribute('aria-expanded', 'false')); button.setAttribute('aria-expanded', String(next)); });
    });
    $$('[data-password-toggle]').forEach(button => button.addEventListener('click', () => {
        const input = document.getElementById(button.dataset.passwordToggle); if (!input) return;
        const visible = input.type === 'password'; input.type = visible ? 'text' : 'password'; button.setAttribute('aria-pressed', String(visible)); button.setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
    }));
    $('#mobileNavToggle')?.addEventListener('click', () => {
        const opening = !document.body.classList.contains('mobile-nav-open'); document.body.classList.toggle('mobile-nav-open', opening); $('#mobileNavToggle').setAttribute('aria-expanded', String(opening)); if ($('#mobileNavBackdrop')) $('#mobileNavBackdrop').hidden = !opening;
        if (opening) $('#appSidebar .app-logo')?.focus();
    });
    $('#mobileNavBackdrop')?.addEventListener('click', () => closeMobileNavigation(true));
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            if ($('#projectPickerMenu') && !$('#projectPickerMenu').hidden) { setProjectPicker(false); $('#projectPickerTrigger').focus(); }
            if (document.body.classList.contains('mobile-nav-open') && !document.querySelector('dialog[open]') && $('#accountMenu').hidden) closeMobileNavigation(true);
            $$('[data-metric-help]').forEach(button => { button.setAttribute('aria-expanded', 'false'); button.dataset.tooltipDismissed = 'true'; });
        }
        if (event.key === 'Tab' && document.body.classList.contains('mobile-nav-open') && !document.querySelector('dialog[open]')) {
            const items = [...$('#appSidebar').querySelectorAll('button:not(:disabled),a[href],select')].filter(element => element.getClientRects().length && !element.closest('[hidden]'));
            const first = items[0], last = items.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });
    $$('dialog.account-dialog').forEach(dialog => {
        dialog.addEventListener('click', event => { if (event.target.closest('[data-dialog-close]') && !projectSaving && !accountMutationBusy && !projectDeleting) dialog.close(); });
        dialog.addEventListener('cancel', event => { if (projectSaving || accountMutationBusy || projectDeleting) event.preventDefault(); });
        dialog.addEventListener('close', () => {
            if (dialog.id === 'projectLeaveDialog') pendingProjectNavigation = null;
            if (dialog.id === 'accountDeleteDialog') $('#deleteAccountForm').reset();
            const opener = dashboardDialogOpeners.get(dialog.id); if (opener?.isConnected && opener.getClientRects().length) opener.focus();
        });
    });
    $('#projectLeaveDiscard')?.addEventListener('click', () => continueProjectNavigation(true));
    $('#projectLeaveSave')?.addEventListener('click', async () => { if (await saveProjectDraft()) continueProjectNavigation(); });
    $('#confirmDeleteBrand')?.addEventListener('click', () => deleteActiveBrand(true));
    $('#openDeleteAccount')?.addEventListener('click', () => { $('#deleteAccountForm').reset(); setFormStatus('#deleteAccountStatus', ''); openDashboardDialog('accountDeleteDialog'); });
    document.addEventListener('click', event => {
        if (bypassProjectGuard || !event.target.closest('a[href],#appLogout')) return;
        const target = event.target.closest('a[href],#appLogout');
        if (guardProjectNavigation(() => target.click())) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    window.addEventListener('beforeunload', event => { if (projectHasChanges()) { event.preventDefault(); event.returnValue = ''; } });
}
bindDashboardDesign();
initializeDashboard();
