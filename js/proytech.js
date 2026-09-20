/* ==========================================================
   ProyTech site behaviour
   Nav, scroll reveals, count-ups, shared chrome injection.
   No dependencies.
   ========================================================== */
(function(){
  'use strict';

  /* ---------- sticky nav state ---------- */
  var nav = document.querySelector('.nav');
  if (nav){
    var onScroll = function(){ nav.classList.toggle('stuck', window.scrollY > 12); };
    onScroll();
    window.addEventListener('scroll', onScroll, {passive:true});
  }

  /* ---------- mobile menu ---------- */
  var burger = document.querySelector('.burger');
  var links  = document.querySelector('.nav-links');
  if (burger && links){
    burger.addEventListener('click', function(){
      var open = links.classList.toggle('open');
      burger.classList.toggle('open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    links.addEventListener('click', function(e){
      if (e.target.tagName === 'A'){
        links.classList.remove('open');
        burger.classList.remove('open');
      }
    });
  }

  /* ---------- reveal on scroll ---------- */
  var reveal = document.querySelectorAll('.rv');
  if ('IntersectionObserver' in window && reveal.length){
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (en.isIntersecting){ en.target.classList.add('in'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });
    reveal.forEach(function(el){ io.observe(el); });
  } else {
    reveal.forEach(function(el){ el.classList.add('in'); });
  }

  /* ---------- count up ---------- */
  function countUp(el){
    var target = parseFloat(el.dataset.count);
    var prefix = el.dataset.prefix || '';
    var suffix = el.dataset.suffix || '';
    var dur = 1100, t0 = null;
    function frame(t){
      if (!t0) t0 = t;
      var p = Math.min((t - t0) / dur, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      var val = Math.round(target * eased);
      el.textContent = prefix + val.toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  var counters = document.querySelectorAll('[data-count]');
  if ('IntersectionObserver' in window && counters.length){
    var co = new IntersectionObserver(function(entries){
      entries.forEach(function(en){
        if (en.isIntersecting){ countUp(en.target); co.unobserve(en.target); }
      });
    }, { threshold: 0.5 });
    counters.forEach(function(el){ co.observe(el); });
  }

  /* ---------- year ---------- */
  var y = document.querySelectorAll('[data-year]');
  y.forEach(function(el){ el.textContent = new Date().getFullYear(); });
})();
