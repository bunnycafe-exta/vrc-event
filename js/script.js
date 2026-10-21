// Sound consent gate: shown first. The click satisfies browsers' user-gesture
// requirement for audio autoplay, then hands off to the welcome splash.
const consentOverlay = document.getElementById('consentOverlay');
const consentEnterSound = document.getElementById('consentEnterSound');
const consentEnterSilent = document.getElementById('consentEnterSilent');
const MUTE_STORAGE_KEY = 'exta-bgm-muted';
const CONSENT_DATE_KEY = 'exta-consent-date';

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hasChosenToday() {
  try { return localStorage.getItem(CONSENT_DATE_KEY) === todayKey(); } catch (e) { return false; }
}

// Intro / welcome splash: logo drops in, bounces, then dives into its own eye
const introOverlay = document.getElementById('introOverlay');
const heroLogoImg = document.querySelector('.hero-logo-img');
const introLogoBounce = document.querySelector('.intro-logo-bounce');

function startWelcomeSequence() {
  if (!introOverlay) {
    if (heroLogoImg) heroLogoImg.classList.add('is-revealed');
    return;
  }

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const revealDelay = prefersReducedMotion ? 0 : 1500;

  if (!prefersReducedMotion) {
    if (introLogoBounce) introLogoBounce.classList.add('is-animating');
  }

  window.setTimeout(() => {
    introOverlay.classList.add('is-hidden');
    document.documentElement.classList.remove('intro-locked');
    if (heroLogoImg) heroLogoImg.classList.add('is-revealed');
  }, revealDelay);

  introOverlay.addEventListener('transitionend', (e) => {
    if (e.target === introOverlay) introOverlay.remove();
  });
}

// Background music: fade in gently once allowed to start, toggle button, remembers mute choice
const bgmAudio = document.getElementById('bgmAudio');
const bgmToggle = document.getElementById('bgmToggle');
let userMuted = true;
let playBgm = () => {};
let playBgmWhenAllowed = () => {};
let pauseBgm = () => {};

if (bgmAudio && bgmToggle) {
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

  // Used when the visitor already chose today and no click has happened yet:
  // browsers may block autoplay, so retry on the first real interaction.
  playBgmWhenAllowed = () => {
    bgmAudio.play().then(() => {
      fadeIn();
      setToggleState(true);
    }).catch(() => {
      setToggleState(false);
      const events = ['click', 'keydown', 'touchend'];
      const resume = (e) => {
        if (e.target.closest && e.target.closest('#bgmToggle')) return;
        events.forEach((name) => window.removeEventListener(name, resume));
        if (!userMuted && bgmAudio.paused) playBgm();
      };
      events.forEach((name) => window.addEventListener(name, resume));
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
// (starting the welcome splash, with or without BGM) once the visitor picks one.
// The choice is remembered for the rest of the day, so it is only asked once per day per device.
if (consentOverlay && consentEnterSound && consentEnterSilent && !hasChosenToday()) {
  document.documentElement.classList.add('intro-locked');

  const proceed = (withSound) => {
    consentOverlay.classList.add('is-hidden');
    userMuted = !withSound;
    try {
      localStorage.setItem(MUTE_STORAGE_KEY, withSound ? '0' : '1');
      localStorage.setItem(CONSENT_DATE_KEY, todayKey());
    } catch (e) { /* storage unavailable: asked again next visit */ }
    if (withSound) playBgm();
    startWelcomeSequence();
    window.setTimeout(() => consentOverlay.remove(), 500);
  };

  consentEnterSound.addEventListener('click', () => proceed(true), { once: true });
  consentEnterSilent.addEventListener('click', () => proceed(false), { once: true });

  consentOverlay.addEventListener('transitionend', (e) => {
    if (e.target === consentOverlay) consentOverlay.remove();
  });
} else {
  if (consentOverlay) consentOverlay.remove();
  document.documentElement.classList.add('intro-locked');
  if (!userMuted) playBgmWhenAllowed();
  startWelcomeSequence();
}

// Menu reveal: hidden behind a button until the visitor asks to see it
const menuRevealBtn = document.getElementById('menuRevealBtn');
const menuRevealPanel = document.getElementById('menuRevealPanel');

if (menuRevealBtn && menuRevealPanel) {
  menuRevealBtn.addEventListener('click', () => {
    const isVisible = menuRevealPanel.classList.toggle('is-visible');
    menuRevealBtn.setAttribute('aria-expanded', String(isVisible));
    menuRevealBtn.textContent = isVisible ? 'メニューを閉じる' : 'メニューを表示する';
  });
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

// Cast / owner profile popup: tapping the round icon opens the profile next to the photo
(function setupProfiles() {
  const profiles = window.EXTA_PROFILES || {};
  const modal = document.getElementById('profileModal');
  if (!modal) return;
  const photo = document.getElementById('profilePhoto');
  const roleEl = document.getElementById('profileRole');
  const nameEl = document.getElementById('profileName');
  const avatarEl = document.getElementById('profileAvatar');
  const messageBlock = document.getElementById('profileMessageBlock');
  let lastTrigger = null;

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // 「｜」は改行してよい位置。<wbr>に置き換えて、文節の途中では改行されないようにする
  function appendPhrases(parent, line) {
    line.split('｜').forEach((part, i) => {
      if (i) parent.append(document.createElement('wbr'));
      parent.append(document.createTextNode(part));
    });
  }

  // パチンコ風の演出（effect: 'pachinko'）: フラッシュ・震え・虹色の文字・光線・飛び散るハート
  let fxTimer = null;
  const HEART_COLORS = ['#ff4d8d', '#ffd23b', '#ff7a3b', '#ffffff', '#ff3b3b'];

  function spawnHearts(row, count) {
    for (let i = 0; i < count; i++) {
      const heart = make('span', 'fx-heart', Math.random() < 0.5 ? '♡' : '♥');
      const angle = Math.random() * Math.PI * 2;
      const dist = 90 + Math.random() * 150;
      heart.style.setProperty('--dx', `${Math.round(Math.cos(angle) * dist)}px`);
      heart.style.setProperty('--dy', `${Math.round(Math.sin(angle) * dist * 0.8 - 20)}px`);
      heart.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 120)}deg`);
      heart.style.setProperty('--dur', `${(0.9 + Math.random() * 0.7).toFixed(2)}s`);
      heart.style.color = HEART_COLORS[Math.floor(Math.random() * HEART_COLORS.length)];
      heart.style.fontSize = `${(1 + Math.random() * 1.1).toFixed(2)}rem`;
      heart.addEventListener('animationend', () => heart.remove());
      window.setTimeout(() => heart.remove(), 2400); // アニメーションが止まっていても、残らないようにする
      row.append(heart);
    }
  }

  function stopPachinko() {
    window.clearInterval(fxTimer);
    fxTimer = null;
    modal.classList.remove('fx-pachinko');
    modal.querySelectorAll('.fx-heart').forEach((node) => node.remove());
  }

  function startPachinko() {
    const row = messageBlock.querySelector('.profile-row.is-large');
    if (!row) return;
    modal.classList.remove('fx-pachinko');
    void modal.offsetWidth; // 開くたびに、最初から演出をやり直す
    modal.classList.add('fx-pachinko');
    window.setTimeout(() => spawnHearts(row, 22), 250);
    fxTimer = window.setInterval(() => spawnHearts(row, 8), 1500);
  }

  function open(cardName, roleText, trigger) {
    const p = profiles[cardName];
    if (!p) return;
    stopPachinko();
    lastTrigger = trigger;
    // 写真がない人は、写真の枠なしで、文章だけを表示する
    modal.classList.toggle('is-textonly', !p.photo);
    if (p.photo) {
      photo.src = p.photo;
      photo.alt = `${cardName}のプロフィール写真`;
    } else {
      photo.removeAttribute('src');
      photo.alt = '';
    }
    roleEl.textContent = roleText;
    nameEl.textContent = p.name || '';
    avatarEl.textContent = p.avatar || '';

    messageBlock.replaceChildren();
    const lines = p.message || [];
    if (p.heading === '代表挨拶') {
      messageBlock.append(make('h3', 'profile-heading', p.heading));
      const body = make('div', 'profile-message');
      lines.forEach((line) => { const para = make('p'); appendPhrases(para, line); body.append(para); });
      messageBlock.append(body);
    } else {
      const row = make('div', 'profile-row' + (p.large ? ' is-large' : ''));
      const text = make('dd', '');
      lines.forEach((line, i) => { if (i) text.append(document.createElement('br')); appendPhrases(text, line); });
      row.append(make('dt', '', `${p.heading || 'ひとこと'}：`), text);
      const list = make('dl', 'profile-fields');
      list.append(row);
      messageBlock.append(list);
    }

    modal.hidden = false;
    document.documentElement.classList.add('profile-open');
    modal.querySelector('.profile-card').scrollTop = 0;
    modal.querySelector('.profile-close').focus();
    if (p.effect === 'pachinko' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) startPachinko();
  }

  function close() {
    if (modal.hidden) return;
    stopPachinko();
    modal.hidden = true;
    document.documentElement.classList.remove('profile-open');
    if (lastTrigger) lastTrigger.focus();
  }

  modal.addEventListener('click', (e) => { if (e.target.closest('[data-profile-close]')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  document.querySelectorAll('.cast-card').forEach((card) => {
    const nameNode = card.querySelector('.cast-name');
    const icon = card.querySelector('.cast-photo');
    if (!nameNode || !icon || !profiles[nameNode.textContent.trim()]) return; // no photo / profile yet: leave as is
    const cardName = nameNode.textContent.trim();
    const roleText = (card.querySelector('.cast-role') || {}).textContent || '';
    icon.classList.add('is-clickable');
    icon.setAttribute('role', 'button');
    icon.setAttribute('tabindex', '0');
    icon.setAttribute('aria-label', `${cardName}のプロフィールを見る`);
    icon.addEventListener('click', () => open(cardName, roleText, icon));
    icon.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(cardName, roleText, icon); }
    });
    const hint = make('button', 'profile-hint', 'PROFILE ›');
    hint.type = 'button';
    hint.addEventListener('click', () => open(cardName, roleText, hint));
    nameNode.after(hint);
  });
})();

// Mascot (ロパンくん): fade in when scrolled into view, hop and pop hearts when tapped
(function setupMascot() {
  const section = document.getElementById('mascot');
  const stage = document.getElementById('mascotStage');
  if (!section || !stage) return;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!reduceMotion && 'IntersectionObserver' in window) {
    section.classList.add('reveal-ready');
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        section.classList.add('is-in');
        observer.disconnect();
      }
    }, { threshold: 0.15 });
    observer.observe(section);
  }

  const POPS = ['♡', '♥', '✦', '♡', '✦'];
  const COLORS = ['#ff7aa8', '#ffd23b', '#ffffff', '#ff9fbd', '#f6e2b2'];

  function pop(count) {
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('span');
      piece.className = 'mascot-pop';
      piece.textContent = POPS[Math.floor(Math.random() * POPS.length)];
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.6;
      const distance = 90 + Math.random() * 130;
      piece.style.setProperty('--dx', `${Math.round(Math.cos(angle) * distance)}px`);
      piece.style.setProperty('--dy', `${Math.round(Math.sin(angle) * distance)}px`);
      piece.style.setProperty('--rot', `${Math.round((Math.random() - 0.5) * 140)}deg`);
      piece.style.setProperty('--dur', `${(0.8 + Math.random() * 0.6).toFixed(2)}s`);
      piece.style.color = COLORS[Math.floor(Math.random() * COLORS.length)];
      piece.style.fontSize = `${(1 + Math.random() * 1.1).toFixed(2)}rem`;
      piece.addEventListener('animationend', () => piece.remove());
      window.setTimeout(() => piece.remove(), 2200);
      stage.append(piece);
    }
  }

  let hopTimer = null;
  stage.addEventListener('click', () => {
    if (!reduceMotion) {
      stage.classList.remove('is-hop');
      void stage.offsetWidth; // 連続でタップしても、毎回、最初から跳ねる
      stage.classList.add('is-hop');
      window.clearTimeout(hopTimer);
      hopTimer = window.setTimeout(() => stage.classList.remove('is-hop'), 800);
    }
    pop(reduceMotion ? 0 : 12);
  });
})();

// 画像の保存を、ひと手間かかるようにする（右クリックのメニューと、ドラッグでの持ち出しを止める）。
// 画面に表示されている画像を完全に守ることはできないので、あくまで簡易的な対策。
(function protectImages() {
  document.addEventListener('contextmenu', (e) => {
    if (e.target.closest('img, .hero-slideshow, .interior-bg, .interior-photo, .mascot-stage, .profile-photo')) {
      e.preventDefault();
    }
  });
  document.addEventListener('dragstart', (e) => {
    if (e.target.tagName === 'IMG') e.preventDefault();
  });
})();

// 管理画面で設定した「次回営業日」を読み込んで、トップ・来店予約・店舗情報に表示する。
// 未設定のとき、または日付が過ぎたときは、「Coming Soon」と表示する。
// 通信がうまくいかなかったときは、まちがった案内をしないよう、何も表示しない
(function setupNextOpen() {
  const url = window.EXTA_API_URL;
  const targets = Array.from(document.querySelectorAll('[data-next-open]'));
  if (!url || !targets.length) return;

  const show = (text) => {
    targets.forEach((node) => {
      node.textContent = text;
      const box = node.closest('[data-next-open-box]');
      if (box) {
        box.hidden = false;
        box.classList.remove('is-pending');
      }
    });
  };

  fetch(url, { cache: 'no-store' })
    .then((res) => res.json())
    .then((data) => {
      if (!data || !data.ok) return;
      const n = data.next;
      if (!n || !/^\d{4}-\d{2}-\d{2}$/.test(n.date) || !/^\d{2}:\d{2}$/.test(n.startTime) || !/^\d{2}:\d{2}$/.test(n.endTime)) {
        show('Coming Soon');
        return;
      }
      const [y, m, d] = n.date.split('-').map(Number);
      const dow = '日月火水木金土'.charAt(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
      show(`${m}月${d}日（${dow}） ${n.startTime}〜${n.endTime}`);
    })
    .catch(() => { /* 表示しないだけ */ });
})();
