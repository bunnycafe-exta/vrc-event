// Sound consent gate: shown first. The click satisfies browsers' user-gesture
// requirement for audio autoplay, then hands off to the welcome splash.
const consentOverlay = document.getElementById('consentOverlay');
const consentEnter = document.getElementById('consentEnter');

// Intro / welcome splash: logo drops in, bounces, then dives into its own eye
const introOverlay = document.getElementById('introOverlay');
const heroLogoImg = document.querySelector('.hero-logo-img');
const introLogoWrap = document.querySelector('.intro-logo-wrap');
const introLogoBounce = document.querySelector('.intro-logo-bounce');

function startWelcomeSequence() {
  if (!introOverlay) {
    if (heroLogoImg) heroLogoImg.classList.add('is-revealed');
    return;
  }

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealDelay = prefersReducedMotion ? 0 : 1750;

  if (!prefersReducedMotion) {
    if (introLogoBounce) introLogoBounce.classList.add('is-animating');
    if (introLogoWrap) introLogoWrap.classList.add('is-animating');
  }

  window.setTimeout(() => {
    introOverlay.classList.add('is-hidden');
    document.documentElement.classList.remove('intro-locked');
    if (heroLogoImg) heroLogoImg.classList.add('is-revealed');
  }, revealDelay);

  introOverlay.addEventListener('transitionend', () => {
    introOverlay.remove();
  });
}

// Background music: fade in gently once allowed to start, toggle button, remembers mute choice
const bgmAudio = document.getElementById('bgmAudio');
const bgmToggle = document.getElementById('bgmToggle');
let userMuted = true;
let playBgm = () => {};
let pauseBgm = () => {};

if (bgmAudio && bgmToggle) {
  const MUTE_STORAGE_KEY = 'exta-bgm-muted';
  const TARGET_VOLUME = 0.3;
  const FADE_STEP = 0.02;
  const FADE_INTERVAL_MS = 120;

  userMuted = localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  let fadeTimer = null;
  bgmAudio.volume = 0;

  function setToggleState(isPlaying) {
    bgmToggle.classList.toggle('is-playing', isPlaying);
    bgmToggle.setAttribute('aria-pressed', String(isPlaying));
    bgmToggle.setAttribute('aria-label', isPlaying ? 'BGMを停止' : 'BGMを再生');
  }

  function fadeIn() {
    window.clearInterval(fadeTimer);
    bgmAudio.volume = 0;
    fadeTimer = window.setInterval(() => {
      const next = bgmAudio.volume + FADE_STEP;
      if (next >= TARGET_VOLUME) {
        bgmAudio.volume = TARGET_VOLUME;
        window.clearInterval(fadeTimer);
      } else {
        bgmAudio.volume = next;
      }
    }, FADE_INTERVAL_MS);
  }

  playBgm = () => {
    bgmAudio.play().then(() => {
      fadeIn();
      setToggleState(true);
    }).catch(() => {
      setToggleState(false);
    });
  };

  pauseBgm = () => {
    window.clearInterval(fadeTimer);
    bgmAudio.pause();
    setToggleState(false);
  };

  bgmToggle.addEventListener('click', () => {
    if (bgmAudio.paused) {
      userMuted = false;
      localStorage.setItem(MUTE_STORAGE_KEY, '0');
      playBgm();
    } else {
      userMuted = true;
      localStorage.setItem(MUTE_STORAGE_KEY, '1');
      pauseBgm();
    }
  });
}

// Wire up the consent gate: locks scroll immediately, and only proceeds
// (starting the welcome splash + BGM) once the visitor taps "はじめる".
if (consentOverlay && consentEnter) {
  document.documentElement.classList.add('intro-locked');

  consentEnter.addEventListener('click', () => {
    consentOverlay.classList.add('is-hidden');
    if (!userMuted) playBgm();
    startWelcomeSequence();
  }, { once: true });

  consentOverlay.addEventListener('transitionend', () => {
    consentOverlay.remove();
  });
} else {
  document.documentElement.classList.add('intro-locked');
  if (!userMuted) playBgm();
  startWelcomeSequence();
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
