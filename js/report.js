/* /js/report.js — draws a self-serve teardown report on /report?t=<token>.
   The report lives in the CRM (stored on the lead); this page asks for it:
   GET https://proytech-crm.vercel.app/api/teardown-report?t=<token>
     200 { ok, business, domain, builtOn, grade, score, report, code, codeExpires, bookUrl }
     410 expired (after 30 days)      404 unknown
   ?t=mock (or ?mock=1) draws /js/report-mock.json instead, with no network.

   TEXT ONLY. Every string from the report is placed with textContent or as an
   attribute the browser treats as a URL we checked. The report quotes the
   audited site's own words, so nothing in it is ever parsed as HTML. */
(function (root) {
  'use strict';
  var TD = {};
  TD.API = 'https://proytech-crm.vercel.app/api/teardown-report';

  /* ------------------------------------------------------- pure helpers */
  TD.centralDate = function (ms) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  };
  /** The code is good THROUGH codeExpires (Central): expired the day after. */
  TD.codeExpired = function (codeExpires, nowMs) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(codeExpires || '')) ? TD.centralDate(nowMs) > codeExpires : true;
  };
  TD.longDate = function (ymd) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return '';
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])));
  };
  /** Only our own booking page may be linked from the report. */
  TD.safeBook = function (u, slugFallback) {
    var s = String(u || '');
    if (/^https:\/\/(www\.)?getproytech\.com\/book\?src=td-[a-z0-9-]{1,21}$/.test(s)) return s;
    return 'https://www.getproytech.com/book?src=td-report';
  };
  TD.pillClass = function (p) { return p === 'Good' ? 'g' : p === 'Needs work' ? 'w' : p === 'Broken' ? 'x' : 'n'; };
  var STATUS = { pass: 'Pass', partial: 'Partial', miss: 'Miss', na: 'Not checked' };
  var STATUS_CLASS = { pass: 'g', partial: 'w', miss: 'x', na: 'n' };

  /* -------------------------------------------------------------- DOM */
  function el(doc, tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null && text !== '') e.textContent = String(text);
    return e;
  }
  function add(parent, child) { parent.appendChild(child); return child; }
  function str(v, n) { return typeof v === 'string' ? v.slice(0, n || 600) : ''; }

  TD.renderState = function (doc, title, line) {
    var m = doc.getElementById('root');
    while (m.firstChild) m.removeChild(m.firstChild);
    var box = add(m, el(doc, 'div', 'state')), inner = add(box, el(doc, 'div'));
    add(inner, el(doc, 'h1', '', title)).style.fontSize = '32px';
    var p = add(inner, el(doc, 'p', '', line + ' '));
    var a = add(p, el(doc, 'a', '', 'Book a free Nucleus Session'));
    a.href = 'https://www.getproytech.com/book?src=td-report';
  };

  /** Draw the whole report into #root. `nowMs` decides the code card. */
  TD.render = function (doc, d, nowMs) {
    var r = (d && d.report) || {};
    var m = doc.getElementById('root');
    while (m.firstChild) m.removeChild(m.firstChild);
    var business = str(d.business, 120) || str(d.domain, 120) || 'your business';
    var when = TD.longDate(d.builtOn || r.builtOn);
    doc.title = 'Your website report, ' + business + ' | ProyTech';

    add(m, el(doc, 'p', 'label', 'Website report · ' + str(d.domain || r.host, 120) + ' · ' + when));
    add(m, el(doc, 'h1', '', 'Your website report, ' + business));
    add(m, el(doc, 'p', 'lede', 'We went through your homepage the way a new customer on their phone would, and graded it the same way we grade sites by hand.'));

    /* verdict */
    var v = add(m, el(doc, 'div', 'verdict'));
    var g = add(v, el(doc, 'div', 'grade'));
    add(g, el(doc, 'b', '', /^[A-F]$/.test(d.grade || r.grade) ? (d.grade || r.grade) : '–'));
    add(g, el(doc, 'span', '', Number.isFinite(+(d.score != null ? d.score : r.score)) ? (d.score != null ? d.score : r.score) + ' / 100' : 'ProyTech score'));
    var vt = add(v, el(doc, 'div'));
    add(vt, el(doc, 'p', '', (Array.isArray(r.verdict) ? r.verdict : []).map(function (s) { return str(s, 300); }).join(' ')));
    add(vt, el(doc, 'p', 'small', str(r.scoreLabel, 300)));

    /* category tiles */
    var sc = add(m, el(doc, 'div', 'scores'));
    (Array.isArray(r.categories) ? r.categories : []).forEach(function (c) {
      var t = add(sc, el(doc, 'div', 'sc'));
      add(t, el(doc, 'span', '', str(c.name, 60)));
      add(t, el(doc, 'span', 'pill ' + TD.pillClass(c.pill), str(c.pill, 20)));
    });

    /* what's already working */
    var working = Array.isArray(r.working) ? r.working : [];
    if (working.length) {
      var s1 = add(m, el(doc, 'section'));
      add(s1, el(doc, 'h2', '', "What's already working"));
      var w = add(s1, el(doc, 'div', 'working'));
      working.slice(0, 5).forEach(function (x) {
        var d1 = add(w, el(doc, 'div', '', str(x.text, 200)));
        if (x.quote) add(d1, el(doc, 'q', '', str(x.quote, 200)));
      });
    }

    /* the top 3 */
    var top = Array.isArray(r.top) ? r.top : [];
    var s2 = add(m, el(doc, 'section'));
    add(s2, el(doc, 'h2', '', top.length ? 'The ' + (top.length === 1 ? 'problem' : top.length + ' problems') + ' costing you business right now' : 'Nothing on the homepage is costing you business'));
    var tl = add(s2, el(doc, 'div', 'top3'));
    top.slice(0, 3).forEach(function (p, i) {
      var c = add(tl, el(doc, 'div', 'prob')), h = add(c, el(doc, 'div', 'h'));
      add(h, el(doc, 'div', 'num', String(i + 1)));
      var tx = add(h, el(doc, 'div'));
      add(tx, el(doc, 'h3', '', str(p.heading, 160)));
      add(tx, el(doc, 'p', '', str(p.body, 500)));
      var f = add(c, el(doc, 'div', 'fixline'));
      add(f, el(doc, 'b', '', 'The fix: '));
      f.appendChild(doc.createTextNode(str(p.fix, 300)));
    });

    /* speed */
    var s3 = add(m, el(doc, 'section'));
    add(s3, el(doc, 'h2', '', 'Speed and quality'));
    if (r.speed && Number.isFinite(+r.speed.lcpS)) {
      var mt = add(s3, el(doc, 'div', 'metrics'));
      var tile = function (big, small) { var t = add(mt, el(doc, 'div', 'm')); add(t, el(doc, 'b', '', big)); add(t, el(doc, 'span', '', small)); };
      tile(r.speed.lcpS + 's', 'Main content on a phone');
      if (r.speed.weightMb != null) tile(r.speed.weightMb + ' MB', 'Page weight');
      if (r.speed.cls != null) tile(String(r.speed.cls), 'Layout shift (0.1 or less is steady)');
      add(s3, el(doc, 'p', 'why', 'Measured once on ' + when + ' with Google PageSpeed Insights on a simulated phone. A real visit can be faster or slower.'));
    } else add(s3, el(doc, 'p', 'why', 'Speed could not be measured today, so it was left out of the grade.'));

    /* everything we found */
    var s4 = add(m, el(doc, 'section'));
    add(s4, el(doc, 'h2', '', 'Everything we found'));
    var items = Array.isArray(r.items) ? r.items : [];
    (Array.isArray(r.categories) ? r.categories : []).forEach(function (c) {
      var a = add(s4, el(doc, 'div', 'area')), t = add(a, el(doc, 'div', 't'));
      add(t, el(doc, 'h3', '', str(c.name, 60)));
      add(t, el(doc, 'span', 'pill ' + TD.pillClass(c.pill), str(c.pill, 20)));
      var ul = add(a, el(doc, 'ul'));
      items.filter(function (it) { return it.cat === c.id; }).forEach(function (it) {
        var li = add(ul, el(doc, 'li'));
        add(li, el(doc, 'span', 'st pill ' + (STATUS_CLASS[it.status] || 'n'), STATUS[it.status] || 'Not checked'));
        li.appendChild(doc.createTextNode(str(it.name, 120) + (it.evidence ? '. ' + str(it.evidence, 300) : '')));
        if (it.quote) { li.appendChild(doc.createTextNode(' ')); add(li, el(doc, 'span', 'q', '"' + str(it.quote, 200) + '"')); }
        if (it.fix) { var fx = add(li, el(doc, 'span', 'fx')); add(fx, el(doc, 'b', '', 'The fix: ')); fx.appendChild(doc.createTextNode(str(it.fix, 300))); }
      });
    });

    /* how we graded this */
    var s5 = add(m, el(doc, 'section'));
    add(s5, el(doc, 'h2', '', 'How we graded this'));
    var nc = Array.isArray(r.notChecked) ? r.notChecked.map(function (x) { return str(x, 120); }) : [];
    add(s5, el(doc, 'p', '', '10 areas, 100 points, scored only from what anyone can see on your homepage on ' + when + '. Areas we couldn\'t check were left out: ' + (nc.length ? nc.join('; ') : 'none') + '.'));
    if (r.judgment === false) add(s5, el(doc, 'p', 'why', 'Our written review of your copy and layout could not run this time, so those items were left out too.'));
    add(s5, el(doc, 'p', 'why', str(r.scoreLabel, 300)));

    /* the offer, last */
    var o = add(m, el(doc, 'div', 'offer'));
    var ol = add(o, el(doc, 'div'));
    add(ol, el(doc, 'h2', '', "Let's go over it together"));
    add(ol, el(doc, 'p', '', "Book 15 minutes with me and I'll walk you through every finding and how we'd fix it. Useful whether we work together or not."));
    var btn = add(ol, el(doc, 'a', 'btn', 'Book your call'));
    btn.href = TD.safeBook(d.bookUrl);
    var card = add(o, el(doc, 'div', 'code'));
    card.setAttribute('data-code-card', '');
    var code = str(d.code, 40), until = TD.longDate(d.codeExpires);
    if (code && !TD.codeExpired(d.codeExpires, nowMs)) {
      add(card, el(doc, 'div', 'c', code));
      add(card, el(doc, 'p', '', '$500 off our standard website. $1,499 becomes $999, plus $149 a month for hosting and care. Good through ' + until + '.'));
      add(card, el(doc, 'p', '', "Mention it on the call and we'll get started right away."));
    } else {
      add(card, el(doc, 'p', '', code ? 'This code expired on ' + until + ". You can still book a call and we'll go over your report." : "Book a call and we'll go over your report."));
    }

    add(m, el(doc, 'p', 'foot', 'Prepared by ProyTech for ' + business + '. Based on our own review of the homepage of ' + str(d.domain || r.host, 120) + ' on ' + when + ', from the outside. ProyTech Business Solutions LLC, 201 N Water St, Wichita, KS 67202.'));
  };

  /* ------------------------------------------------------------ boot */
  TD.boot = function (win) {
    var doc = win.document, q = new URLSearchParams(win.location.search);
    var t = q.get('t') || '', mock = t === 'mock' || q.get('mock') === '1';
    if (mock) { var f = doc.createElement('div'); f.className = 'mock-flag'; f.textContent = 'Mock report: sample data'; doc.body.appendChild(f); }
    if (!mock && !/^[A-Za-z0-9_-]{8,128}$/.test(t)) { TD.renderState(doc, "We couldn't find that report.", 'Check the link in your email, or'); return; }
    var url = mock ? '/js/report-mock.json' : TD.API + '?t=' + encodeURIComponent(t);
    win.fetch(url, { credentials: 'omit' }).then(function (res) {
      if (res.status === 410) { TD.renderState(doc, 'This report has expired.', 'Reports are kept for 30 days. You can still'); return null; }
      if (!res.ok) { TD.renderState(doc, "We couldn't find that report.", 'Check the link in your email, or'); return null; }
      return res.json();
    }).then(function (d) {
      if (!d) return;
      if (!d.ok || !d.report) { TD.renderState(doc, "We couldn't find that report.", 'Check the link in your email, or'); return; }
      TD.render(doc, d, Date.now());
    }).catch(function () { TD.renderState(doc, "We couldn't load your report right now.", 'Try again in a minute, or'); });
  };

  root.TD = TD;
  if (typeof document !== 'undefined' && document.getElementById('root')) TD.boot(window);
})(typeof window !== 'undefined' ? window : globalThis);
