'use strict';

const backToTopButton = document.querySelector('[data-back-to-top]');

if (backToTopButton) {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const updateBackToTop = () => backToTopButton.classList.toggle('is-visible', window.scrollY > 400);

    window.addEventListener('scroll', updateBackToTop, { passive: true });
    backToTopButton.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    });
    updateBackToTop();
}
