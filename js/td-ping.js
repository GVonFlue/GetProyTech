/* /js/td-ping.js — tells the CRM a teardown report was opened, so the
   Teardowns board can show "viewed". Once per page load, fire and forget.
   Sends only the report's slug (hand-built pages, <meta name="td-slug">) or
   its token (/report?t=...). No cookies, no email open tracking, no other data.
   POST https://proytech-crm.vercel.app/api/teardown-view  { slug } | { token } */
(function () {
  'use strict';
  try {
    if (window.__tdPinged) return;
    window.__tdPinged = true;
    var q = new URLSearchParams(location.search), body = null;
    var t = q.get('t') || '';
    var meta = document.querySelector('meta[name="td-slug"]');
    if (/^[A-Za-z0-9_-]{8,128}$/.test(t) && t !== 'mock') body = { token: t };
    else if (meta && /^[a-z0-9]{1,40}$/.test(meta.content || '')) body = { slug: meta.content };
    if (!body) return;
    var url = 'https://proytech-crm.vercel.app/api/teardown-view', data = JSON.stringify(body);
    if (navigator.sendBeacon && navigator.sendBeacon(url, new Blob([data], { type: 'text/plain' }))) return;
    fetch(url, { method: 'POST', body: data, headers: { 'Content-Type': 'text/plain' }, credentials: 'omit', keepalive: true, mode: 'cors' }).catch(function () {});
  } catch (e) { /* a ping that fails changes nothing for the visitor */ }
})();
