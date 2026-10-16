(() => {
    window.VIDNO_DARK_THEME_ENABLED = false;
    document.documentElement.dataset.themeSwitching = window.VIDNO_DARK_THEME_ENABLED ? 'enabled' : 'disabled';
    let theme = 'light';
    if (window.VIDNO_DARK_THEME_ENABLED) {
        try { theme = localStorage.getItem('vidno-theme') === 'dark' ? 'dark' : 'light'; }
        catch (_) { theme = 'light'; }
    }
    document.documentElement.dataset.theme = theme;
})();
