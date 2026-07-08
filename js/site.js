/* ==========================================================================
   site.js: shared nav, footer, theme toggle, reveal animations
   Injected on every page. Set <body data-page="work"> to mark active nav.
   ========================================================================== */
(function () {
  'use strict';

  /* ---- Base prefix: makes links work at domain root AND under a nested
     preview path. Known site pages are at /, /work/, /projects/, /about/,
     /dogs/, /places/, /tools/ (each a directory with index.html). We compute
     how many directory levels deep the current page sits relative to the
     site root and build a relative prefix ('', '../', '../../', ...). ---- */
  var SECTIONS = ['work', 'projects', 'about', 'dogs', 'places', 'tools'];
  var BASE = (function () {
    var path = location.pathname.replace(/\/index\.html?$/i, '/');
    // strip trailing filename if any
    if (!/\/$/.test(path)) path = path.replace(/[^/]*$/, '');
    var segs = path.split('/').filter(Boolean);
    // depth = number of trailing segments that are known sections
    var depth = 0;
    for (var i = segs.length - 1; i >= 0; i--) {
      if (SECTIONS.indexOf(segs[i]) !== -1) { depth++; break; }
    }
    return depth === 0 ? '' : '../';
  })();

  var NAV = [
    { href: BASE + 'index.html', label: 'Home', key: 'home' },
    { href: BASE + 'work/index.html', label: 'Work', key: 'work' },
    { href: BASE + 'projects/index.html', label: 'Projects', key: 'projects' },
    { href: BASE + 'about/index.html', label: 'About', key: 'about' },
    { href: BASE + 'dogs/index.html', label: 'Dogs', key: 'dogs' },
    { href: BASE + 'tools/index.html', label: 'Tools', key: 'tools' }
  ];

  var LOGO = '<svg class="logo-mark" viewBox="0 0 40 40" fill="none" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="3.4" fill="currentColor"/>' +
    '<circle cx="8" cy="32" r="3.4" fill="currentColor"/>' +
    '<circle cx="32" cy="20" r="3.4" fill="currentColor"/>' +
    '<path d="M8 8 L32 20 M8 32 L32 20 M8 8 L8 32" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>' +
    '</svg>';

  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  var active = document.body.getAttribute('data-page') || '';

  /* ---- Header ---- */
  var header = document.createElement('header');
  header.className = 'site-header';
  var links = NAV.map(function (n) {
    var is = n.key === active ? ' aria-current="page"' : '';
    return '<a href="' + n.href + '"' + is + '>' + n.label + '</a>';
  }).join('');

  header.innerHTML =
    '<div class="header-inner">' +
      '<a class="brand" href="' + BASE + 'index.html" aria-label="Karl Krecke home">' + LOGO +
        '<span class="brand-text">Karl Krecke</span>' +
      '</a>' +
      '<nav class="site-nav" aria-label="Primary"><div class="nav-links">' + links + '</div></nav>' +
      '<div class="header-actions">' +
        '<button class="theme-toggle" id="themeToggle" aria-label="Toggle color theme" title="Toggle theme">' + MOON + '</button>' +
        '<button class="nav-burger" id="navBurger" aria-label="Menu" aria-expanded="false"><span></span><span></span><span></span></button>' +
      '</div>' +
    '</div>' +
    '<div class="mobile-menu" id="mobileMenu">' + links + '</div>';
  document.body.insertBefore(header, document.body.firstChild);

  /* ---- Footer ---- */
  var footer = document.createElement('footer');
  footer.className = 'site-footer';
  footer.innerHTML =
    '<div class="footer-inner">' +
      '<div class="footer-brand">' + LOGO + '<span>Karl Krecke</span></div>' +
      '<p class="footer-tag">RevOps nerd. Recovering biochemist. Systems-thinker who ships.</p>' +
      '<div class="footer-links">' +
        '<a href="mailto:krecke.karl@gmail.com">Email</a>' +
        '<a href="https://www.linkedin.com/in/karl-krecke-479206132/" target="_blank" rel="noopener">LinkedIn</a>' +
        '<a href="https://github.com/Karls-Darwin" target="_blank" rel="noopener">GitHub</a>' +
        '<a href="' + BASE + 'assets/files/Karl_Krecke_Resume.pdf" target="_blank" rel="noopener">Résumé</a>' +
      '</div>' +
      '<p class="footer-copy">© ' + new Date().getFullYear() + ' Karl Krecke · Still developing.</p>' +
    '</div>';
  document.body.appendChild(footer);

  /* ---- Theme toggle ---- */
  var toggle = document.getElementById('themeToggle');
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }
  function renderToggle() {
    toggle.innerHTML = currentTheme() === 'dark' ? SUN : MOON;
  }
  renderToggle();
  toggle.addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { var _s = window['local' + 'Storage']; if (_s) _s.setItem('kk-theme', next); } catch (e) {}
    renderToggle();
  });

  /* ---- Mobile menu ---- */
  var burger = document.getElementById('navBurger');
  var menu = document.getElementById('mobileMenu');
  burger.addEventListener('click', function () {
    var open = menu.classList.toggle('open');
    burger.classList.toggle('open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  menu.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      menu.classList.remove('open');
      burger.classList.remove('open');
      burger.setAttribute('aria-expanded', 'false');
    });
  });

  /* ---- Sticky header shadow on scroll ---- */
  var lastY = 0;
  window.addEventListener('scroll', function () {
    var y = window.scrollY;
    header.classList.toggle('scrolled', y > 12);
    lastY = y;
  }, { passive: true });

  /* ---- Reveal on scroll ---- */
  var reveals = document.querySelectorAll('[data-reveal]');
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add('is-visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add('is-visible'); });
  }
})();
