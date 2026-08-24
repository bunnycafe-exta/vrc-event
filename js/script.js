// Intro / welcome splash: logo drops in, winks, then fades out
const introOverlay = document.getElementById('introOverlay');
const heroLogoImg = document.querySelector('.hero-logo-img');

if (introOverlay) {
  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealDelay = prefersReducedMotion ? 0 : 1750;

  document.documentElement.classList.add('intro-locked');

  window.setTimeout(() => {
    introOverlay.classList.add('is-hidden');
    document.documentElement.classList.remove('intro-locked');
    if (heroLogoImg) heroLogoImg.classList.add('is-revealed');
  }, revealDelay);

  introOverlay.addEventListener('transitionend', () => {
    introOverlay.remove();
  });
} else if (heroLogoImg) {
  heroLogoImg.classList.add('is-revealed');
}

// Header: add solid background once the user scrolls past the hero
const header = document.getElementById('siteHeader');

function updateHeaderState() {
  if (window.scrollY > 40) {
    header.classList.add('is-scrolled');
  } else {
    header.classList.remove('is-scrolled');
  }
}
updateHeaderState();
window.addEventListener('scroll', updateHeaderState);

// Mobile navigation toggle
const navToggle = document.getElementById('navToggle');
const siteNav = document.getElementById('siteNav');

function closeNav() {
  siteNav.classList.remove('is-open');
  navToggle.classList.remove('is-active');
  navToggle.setAttribute('aria-expanded', 'false');
}

navToggle.addEventListener('click', () => {
  const isOpen = siteNav.classList.toggle('is-open');
  navToggle.classList.toggle('is-active', isOpen);
  navToggle.setAttribute('aria-expanded', String(isOpen));
});

siteNav.querySelectorAll('.nav-link').forEach((link) => {
  link.addEventListener('click', closeNav);
});
