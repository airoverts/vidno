(() => {
    const counterId = 112845645;
    const storageKey = 'vidno_analytics_consent';
    const script = document.currentScript;
    const webvisor = script?.dataset.webvisor === 'true';
    const cookiePolicyUrl = script?.dataset.cookiePolicy || 'legal/cookies.html';
    let choice = null;
    let started = false;

    try {
        const saved = localStorage.getItem(storageKey);
        if (saved === 'granted' || saved === 'denied') choice = saved;
    } catch (_) {
        choice = null;
    }

    function startMetrika() {
        if (started) return;
        started = true;
        ((m, e, t, r, i, k, a) => {
            m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); };
            m[i].l = Date.now();
            for (let j = 0; j < e.scripts.length; j += 1) {
                if (e.scripts[j].src === r) return;
            }
            k = e.createElement(t);
            a = e.getElementsByTagName(t)[0];
            k.async = true;
            k.src = r;
            a.parentNode.insertBefore(k, a);
        })(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
        window.ym(counterId, 'init', {
            ssr: true,
            webvisor,
            clickmap: true,
            ecommerce: 'dataLayer',
            referrer: document.referrer,
            url: location.href,
            accurateTrackBounce: true,
            trackLinks: true,
        });
    }

    if (choice === 'granted') startMetrika();

    function mountControls() {
        const preferences = document.createElement('button');
        preferences.type = 'button';
        preferences.className = 'cookie-preferences';
        preferences.textContent = 'Настройки cookie';
        preferences.setAttribute('aria-label', 'Изменить выбор аналитических cookie');

        const banner = document.createElement('section');
        banner.className = 'cookie-consent';
        banner.setAttribute('role', 'region');
        banner.setAttribute('aria-label', 'Аналитические cookie');
        banner.innerHTML = '<div class="cookie-consent-copy"><strong>Аналитические cookie</strong><p>Яндекс Метрика помогает нам понимать посещаемость и улучшать Vidno. Она загрузится только с вашего согласия. <a href="">Подробнее в политике cookie</a>.</p></div><div class="cookie-consent-actions"><button type="button" class="cookie-consent-allow">Разрешить</button><button type="button" class="cookie-consent-deny">Не разрешать</button><button type="button" class="cookie-consent-close" aria-label="Закрыть настройки cookie">Закрыть</button></div>';
        banner.querySelector('a').href = cookiePolicyUrl;

        function showBanner() {
            banner.hidden = false;
            preferences.hidden = true;
            banner.querySelector('.cookie-consent-close').hidden = choice === null;
        }

        function hideBanner() {
            banner.hidden = true;
            preferences.hidden = false;
        }

        function choose(nextChoice) {
            const previous = choice;
            choice = nextChoice;
            try {
                localStorage.setItem(storageKey, nextChoice);
            } catch (_) {
                choice = nextChoice;
            }
            if (previous === 'granted' && nextChoice === 'denied') {
                location.reload();
                return;
            }
            if (nextChoice === 'granted') startMetrika();
            hideBanner();
        }

        preferences.addEventListener('click', showBanner);
        banner.querySelector('.cookie-consent-allow').addEventListener('click', () => choose('granted'));
        banner.querySelector('.cookie-consent-deny').addEventListener('click', () => choose('denied'));
        banner.querySelector('.cookie-consent-close').addEventListener('click', hideBanner);
        document.body.append(preferences, banner);
        if (choice === null) showBanner();
        else hideBanner();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountControls, { once: true });
    else mountControls();
})();
