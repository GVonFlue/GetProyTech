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
  var KIND = { home: 'Homepage', contact: 'Contact', services: 'Service', about: 'About', reviews: 'Reviews', faq: 'FAQ', pricing: 'Pricing', areas: 'Area', work: 'Our work', other: 'Page' };
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
    var v2 = r.v === 2;
    var nPages = r.checked && r.checked.pages > 0 ? r.checked.pages : 1;
    add(m, el(doc, 'p', 'lede', v2 ? 'We read ' + (nPages === 1 ? 'your homepage' : nPages + ' pages of your site') + ' the way a new customer on their phone would, and graded it the same way we grade sites by hand: 12 areas, from the first five seconds to what runs behind the scenes.' : 'We went through your homepage the way a new customer on their phone would, and graded it the same way we grade sites by hand.'));

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
        if (x.quote) { var wq = add(d1, el(doc, 'div', 'wq')); if (x.page && x.page !== '/') add(wq, el(doc, 'span', 'on', str(x.page, 120))); add(wq, el(doc, 'q', '', str(x.quote, 200))); }
      });
    }

    /* how a first-time visitor moves through the site (v2) */
    var journey = Array.isArray(r.journey) ? r.journey : [];
    if (journey.length) {
      var sj = add(m, el(doc, 'section'));
      add(sj, el(doc, 'h2', '', 'How a first-time visitor moves through your site'));
      var jl = add(sj, el(doc, 'ol', 'journey'));
      journey.slice(0, 5).forEach(function (x) {
        var li = add(jl, el(doc, 'li'));
        add(li, el(doc, 'p', '', str(x.text, 220)));
        if (x.quote) { var jq = add(li, el(doc, 'div', 'jq')); if (x.page) add(jq, el(doc, 'span', 'on', x.page === '/' ? 'Homepage' : str(x.page, 120))); add(jq, el(doc, 'q', '', str(x.quote, 200))); }
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

    /* what we looked at (v2): the pages read and what the site runs on */
    var pages = Array.isArray(r.pages) ? r.pages : [];
    if (pages.length || r.stack) {
      var sl = add(m, el(doc, 'section'));
      add(sl, el(doc, 'h2', '', 'What we looked at'));
      var lk = add(sl, el(doc, 'div', 'looked'));
      if (pages.length) {
        var b1 = add(lk, el(doc, 'div', 'box'));
        add(b1, el(doc, 'h3', '', 'The pages we read'));
        var pl = add(b1, el(doc, 'ul', 'plist'));
        pages.slice(0, 8).forEach(function (p) {
          var li = add(pl, el(doc, 'li'));
          add(li, el(doc, 'span', 'p', p.path === '/' ? 'Homepage' : str(p.path, 120)));
          add(li, el(doc, 'span', 'k', (KIND[p.kind] || 'Page') + (p.words ? ' · ' + p.words + ' words' : '')));
        });
        if (r.checked && r.checked.found > pages.length) add(b1, el(doc, 'p', 'why', 'We found ' + r.checked.found + ' pages linked from your homepage and sitemap, and read the ones a buyer is most likely to visit.'));
        else if (pages.length === 1) add(b1, el(doc, 'p', 'why', 'Your site is a single page, so this is everything a visitor can see.'));
      }
      if (r.stack) {
        var b2 = add(lk, el(doc, 'div', 'box'));
        add(b2, el(doc, 'h3', '', 'What your site runs on'));
        add(b2, el(doc, 'p', '', 'Built on: ' + str(r.stack.platform, 60)));
        var tl2 = Array.isArray(r.stack.tools) ? r.stack.tools : [];
        if (tl2.length) { var tw = add(b2, el(doc, 'div', 'tools')); tl2.slice(0, 16).forEach(function (t) { add(tw, el(doc, 'span', '', str(t.name, 60))); }); }
        else add(b2, el(doc, 'p', 'why', 'We did not spot a CRM, booking tool, chat or analytics tag.'));
        add(b2, el(doc, 'p', 'why', 'Email: ' + str(r.stack.email, 60) + '. This is what anyone can see from outside; we never log in.'));
      }
    }

    /* speed */
    var s3 = add(m, el(doc, 'section'));
    add(s3, el(doc, 'h2', '', 'Speed and quality'));
    /* +null is 0, so a missing number must be ruled out before it is coerced */
    var num = function (v) { return v != null && v !== '' && Number.isFinite(+v); };
    if (r.speed && num(r.speed.lcpS)) {
      var mt = add(s3, el(doc, 'div', 'metrics'));
      var tile = function (big, small) { var t = add(mt, el(doc, 'div', 'm')); add(t, el(doc, 'b', '', big)); add(t, el(doc, 'span', '', small)); };
      tile(r.speed.lcpS + 's', 'Main content on a phone');
      if (r.speed.weightMb != null) tile(r.speed.weightMb + ' MB', 'Page weight');
      if (r.speed.cls != null) tile(String(r.speed.cls), 'Layout shift (0.1 or less is steady)');
      add(s3, el(doc, 'p', 'why', 'Measured once on ' + when + ' with Google PageSpeed Insights on a simulated phone. A real visit can be faster or slower.'));
    } else if (r.speed && num(r.speed.weightMb)) {
      /* a hand-built report can measure page weight without Google's speed test */
      var mw = add(s3, el(doc, 'div', 'metrics')), tw = add(mw, el(doc, 'div', 'm'));
      add(tw, el(doc, 'b', '', r.speed.weightMb + ' MB')); add(tw, el(doc, 'span', '', 'Downloaded before anyone scrolls'));
      if (num(r.speed.fullMb)) { var tf = add(mw, el(doc, 'div', 'm')); add(tf, el(doc, 'b', '', r.speed.fullMb + ' MB')); add(tf, el(doc, 'span', '', 'The whole page, scrolled to the bottom')); }
      add(s3, el(doc, 'p', 'why', 'Page weight measured in Chrome on ' + when + '. Google\'s phone speed test could not run that day, so load time was left out of the grade.'));
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
        if (it.quote) { li.appendChild(doc.createTextNode(' ')); if (it.page) add(li, el(doc, 'span', 'on', it.page === '/' ? 'Homepage' : str(it.page, 120))); add(li, el(doc, 'span', 'q', '"' + str(it.quote, 200) + '"')); }
        if (it.fix) { var fx = add(li, el(doc, 'span', 'fx')); add(fx, el(doc, 'b', '', 'The fix: ')); fx.appendChild(doc.createTextNode(str(it.fix, 300))); }
      });
    });

    /* how we graded this */
    var s5 = add(m, el(doc, 'section'));
    add(s5, el(doc, 'h2', '', 'How we graded this'));
    var nc = Array.isArray(r.notChecked) ? r.notChecked.map(function (x) { return str(x, 120); }) : [];
    if (v2) add(s5, el(doc, 'p', '', str(r.rule, 700).replace(/^How we graded this: /, '') + ' Checked on ' + when + '. Left out today: ' + (nc.length ? nc.join('; ') : 'nothing') + '.'));
    else add(s5, el(doc, 'p', '', '10 areas, 100 points, scored only from what anyone can see on your homepage on ' + when + '. Areas we couldn\'t check were left out: ' + (nc.length ? nc.join('; ') : 'none') + '.'));
    if (r.judgment === false) add(s5, el(doc, 'p', 'why', 'Our written review of your copy and layout could not run this time, so those items were left out too.'));
    add(s5, el(doc, 'p', 'why', str(r.scoreLabel, 300)));

    /* the offer, last */
    var o = add(m, el(doc, 'div', 'offer'));
    var ol = add(o, el(doc, 'div'));
    add(ol, el(doc, 'h2', '', "Let's go over it together"));
    add(ol, el(doc, 'p', '', v2 ? "Book 15 minutes with me and I'll walk you through the fix for every item on this list, in the order that brings in the most calls first. Useful whether we work together or not." : "Book 15 minutes with me and I'll walk you through every finding and how we'd fix it. Useful whether we work together or not."));
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

    add(m, el(doc, 'p', 'foot', 'Prepared by ProyTech for ' + business + '. Based on our own review of ' + (v2 ? (nPages === 1 ? 'the homepage of ' : nPages + ' pages of ') : 'the homepage of ') + str(d.domain || r.host, 120) + ' on ' + when + ', from the outside. ProyTech Business Solutions LLC, 201 N Water St, Wichita, KS 67202.'));
  };

  /* ------------------------------------------------------------ boot */
  TD.boot = function (win) {
    var doc = win.document, q = new URLSearchParams(win.location.search);
    /* A hand-built report (previews/<slug>-report.html) carries its own data in
       <script type="application/json" id="td-data">, drawn the same text-only
       way, and stops drawing after its <meta name="preview-expires"> day. */
    var inline = doc.getElementById('td-data');
    if (inline) {
      var exp = doc.querySelector('meta[name="preview-expires"]');
      if (!exp || !/^\d{4}-\d{2}-\d{2}$/.test(exp.content || '') || TD.centralDate(Date.now()) > exp.content) { TD.renderState(doc, 'This report has expired.', 'Reports are kept for 30 days. You can still'); return; }
      var d0 = null; try { d0 = JSON.parse(inline.textContent); } catch (e) { d0 = null; }
      if (!d0 || !d0.report) { TD.renderState(doc, "We couldn't load your report right now.", 'Try again in a minute, or'); return; }
      TD.render(doc, d0, Date.now());
      return;
    }
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
