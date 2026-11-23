// api/_crawl.js — THE CRAWL'S RULES: which pages of a site the teardown reads,
// and what plain code learns from them, its robots.txt, its sitemap, its
// llms.txt and its public email records. Pure: no network, no clock, no
// environment. The fetching lives in ./_audit-net.js (crawlSite).
// Underscore prefix: not a route.
//
//   linksOf(html, url, host)      internal links on a page: path, label, in the menu?
//   pickPages(links, sitemap, n)  the pages worth reading, contact and services first
//   parseRobots / parseSitemap    what robots.txt and sitemap.xml say
//   detectStack(htmls, headers)   the platform and the tools a site runs on
//   pageExtras(html, headers)     per-page numbers the homepage rules don't cover
//   siteFactsOf(...)              everything above -> SITE FACTS (numbers only)
//
// SITE FACTS ARE NUMBERS. Like the homepage facts (./_rubric.js ruleFacts) they
// are sealed into the visitor's token, so no path, title or word of the audited
// site is in them. Tools and the platform are indexes into OUR tables below.

import { bodyOf, textOf, pairs, openTags, decode, normalize, titleOf, wordCount } from './_html.js';

export const PAGE_LIMIT = 8;          // the homepage plus 7
export const LINK_CHECKS = 8;         // extra menu links asked "are you there?"

/* ------------------------------------------------------------- the host */

/** The registrable part of a host name, near enough for "is this link on the
 *  same site": the last two labels, or three for co.uk-style endings. */
export function baseOf(host) {
  const l = String(host || '').toLowerCase().replace(/\.$/, '').split('.');
  if (l.length > 2 && l[l.length - 1].length === 2 && ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu'].includes(l[l.length - 2])) return l.slice(-3).join('.');
  return l.slice(-2).join('.');
}

/* ------------------------------------------------------------ the links */

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|mp4|mov|webm|mp3|wav|docx?|xlsx?|pptx?|css|js|mjs|xml|txt|json|ics|vcf)$/i;
const SKIP_PATH = /(^|\/)(wp-admin|wp-login\.php|wp-json|wp-content|cart|checkout|my-account|account|login|log-in|signin|sign-in|signup|register|feed|rss|tag|tags|author|search|cdn-cgi|xmlrpc\.php|cgi-bin|privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|cookie-policy|cookies|legal|accessibility|sitemap|disclaimer)(\/|$)/i;
const SKIP_DEEP = /^\/(blog|news|posts?|articles?|insights|resources|events?|press|stories|category|categories|products?|shop|store|listings?|property|properties)\/.+/i;
const DATED = /\/(19|20)\d{2}\/\d{1,2}(\/|$)/;
const HOME_PATH = /^\/(home|index\.(html?|php|aspx?))$/i;

export const cleanPath = p => { let s = String(p || '/').replace(/\/{2,}/g, '/'); if (s.length > 1) s = s.replace(/\/+$/, ''); return s.slice(0, 200) || '/'; };
const skipped = path => path === '/' || HOME_PATH.test(path) || SKIP_EXT.test(path) || SKIP_PATH.test(path) || SKIP_DEEP.test(path) || DATED.test(path) || path.length > 160;

/** Internal links on a page, one per path: { url, path, label, nav }. "nav" is
 *  a link inside the page's <nav> or <header>. Only http(s) on the same site;
 *  files, admin pages, policies, blog posts and dated archives are left out. */
export function linksOf(rawHtml, pageUrl, host) {
  const body = bodyOf(rawHtml);
  const navHtml = [...pairs(body, 'nav'), ...pairs(body, 'header')].map(p => p.inner).join(' ');
  const navHrefs = new Set(pairs(navHtml, 'a').map(a => (a.a.href || '').trim()));
  const out = new Map(), base = baseOf(host);
  let pagePort = ''; try { pagePort = new URL(pageUrl).port; } catch { /* keep '' */ }
  for (const a of pairs(body, 'a')) {
    const href = (a.a.href || '').trim();
    if (!href || /^(#|mailto:|tel:|sms:|javascript:|data:|callto:)/i.test(href)) continue;
    let u; try { u = new URL(href, pageUrl); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    /* only the usual web ports, or the page's own (every fetch re-checks the port anyway) */
    if (u.username || u.password || (u.port && u.port !== pagePort && !['80', '443'].includes(u.port))) continue;
    const h = u.hostname.toLowerCase().replace(/\.$/, '');
    if (baseOf(h) !== base) continue;
    const path = cleanPath(u.pathname);
    if (skipped(path)) continue;
    const key = (h.replace(/^www\./, '') + path).toLowerCase();
    const label = textOf(a.inner).replace(/\s+/g, ' ').trim().slice(0, 80);
    const nav = navHrefs.has(href);
    const prev = out.get(key);
    if (!prev) out.set(key, { url: `${u.protocol}//${h}${u.port ? ':' + u.port : ''}${path}`, path, label, nav });
    else { prev.nav = prev.nav || nav; if (!prev.label) prev.label = label; }
  }
  return [...out.values()];
}

/* The kinds of page a buyer looks for, in the order they matter. */
export const KINDS = [
  { kind: 'contact', w: 10, re: /contact|get-in-touch|reach-us|request|quote|estimate|book|schedul|appointment|consult/i },
  /* areas before services, so /service-areas is an area page */
  { kind: 'areas', w: 6, re: /service-areas?|areas?-(we-)?serve|locations?|cities|near-me|(^|\/)areas?(\/|$)|counties/i },
  { kind: 'services', w: 9, re: /service|what-we-do|solutions|offerings|repair|install|replac|clean|remodel|roof|plumb|hvac|heating|cooling|furnace|electric|landscap|lawn|mow|paint|concrete|asphalt|pav|fenc|gutter|siding|window|floor|pest|tree|pressure-wash|detail|insurance|loans?|mortgage|refinanc|buyers?|sellers?|home-value|treatment|therapy|dental|legal|tax|bookkeep|catering/i },
  { kind: 'about', w: 8, re: /about|our-story|team|who-we-are|meet|staff|company/i },
  { kind: 'reviews', w: 7, re: /review|testimonial|what-people-say|happy-customers|clients-say/i },
  { kind: 'faq', w: 6, re: /faq|questions/i },
  { kind: 'pricing', w: 6, re: /pric|cost|rates|financ|packages|plans/i },
  { kind: 'work', w: 5, re: /gallery|portfolio|our-work|projects|case-stud|before-after|showcase/i },
];
export const kindOf = (path, label = '') => { const s = `${path} ${String(label).toLowerCase().replace(/\s+/g, '-')}`; const k = KINDS.find(k => k.re.test(s)); return k ? k.kind : 'other'; };
const CAP = { services: 3, areas: 2 };

/** The pages worth reading, at most `n`: every kind a buyer looks for once
 *  (services up to three times, areas twice), menu links first, then the best
 *  of the rest. Also counts what the site HAS, from every link and sitemap
 *  entry, not only the pages read. */
export function pickPages(links, sitemapUrls, host, n = PAGE_LIMIT - 1) {
  const all = new Map(), base = baseOf(host);
  for (const l of links || []) all.set(l.path.toLowerCase(), { ...l, sm: false });
  for (const s of sitemapUrls || []) {
    let u; try { u = new URL(s); } catch { continue; }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || baseOf(u.hostname) !== base) continue;
    const path = cleanPath(u.pathname);
    if (skipped(path)) continue;
    const key = path.toLowerCase();
    if (all.has(key)) all.get(key).sm = true;
    else all.set(key, { url: `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? ':' + u.port : ''}${path}`, path, label: '', nav: false, sm: true });
  }
  const cands = [...all.values()].map(c => {
    const kind = kindOf(c.path, c.label), k = KINDS.find(x => x.kind === kind);
    const depth = c.path.split('/').filter(Boolean).length;
    return { ...c, kind, score: (k ? k.w : 1) + (c.nav ? 3 : 0) + (c.sm ? 0.5 : 0) - (depth - 1) * 1.5 };
  }).sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  const picked = [], used = {};
  for (const c of cands) {
    if (picked.length >= n) break;
    if (c.kind === 'other') continue;
    if ((used[c.kind] || 0) >= (CAP[c.kind] || 1)) continue;
    used[c.kind] = (used[c.kind] || 0) + 1; picked.push(c);
  }
  for (const c of cands) { if (picked.length >= n) break; if (!picked.includes(c)) picked.push(c); }
  const has = kind => cands.filter(c => c.kind === kind).length;
  return {
    picked: picked.map(({ url, path, label, kind }) => ({ url, path, label, kind })),
    found: cands.length,
    counts: { services: has('services'), about: has('about'), contact: has('contact'), areas: has('areas'), faq: has('faq'), reviews: has('reviews'), work: has('work'), pricing: has('pricing') },
  };
}

/* ------------------------------------------------------ robots, sitemap */

/** The AI crawlers we report on, by the name each company publishes. */
export const AI_BOTS = [
  { ua: 'gptbot', name: 'GPTBot (OpenAI)' },
  { ua: 'oai-searchbot', name: 'OAI-SearchBot (OpenAI search)' },
  { ua: 'claudebot', name: 'ClaudeBot (Anthropic)' },
  { ua: 'perplexitybot', name: 'PerplexityBot (Perplexity)' },
  { ua: 'google-extended', name: 'Google-Extended (Google Gemini)' },
];

/** A body that is really an HTML page (a site that answers every address with
 *  its homepage) is not a robots.txt, llms.txt or sitemap. */
export const looksLikeHtml = body => /^\s*(<!doctype html|<html\b|<head\b|<body\b)/i.test(String(body || '')) || /<html[\s>]/i.test(String(body || '').slice(0, 2000));

/** robots.txt -> { blockAll, aiBlocked (bitmask over AI_BOTS), sitemaps }.
 *  "Blocked" means a "Disallow: /" in the group that applies to that crawler
 *  (its own group, or "*" when it has none) with no "Allow: /" beside it. */
export function parseRobots(text) {
  const groups = [], sitemaps = [];
  let cur = null, agentLine = false;
  for (const raw of String(text || '').split(/\r?\n/).slice(0, 2000)) {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'sitemap') { if (sitemaps.length < 5) sitemaps.push(v); continue; }
    if (k === 'user-agent') {
      if (!cur || !agentLine) { cur = { agents: [], dis: [], allow: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); agentLine = true; continue;
    }
    agentLine = false;
    if (!cur) continue;
    if (k === 'disallow') cur.dis.push(v); else if (k === 'allow') cur.allow.push(v);
  }
  const star = groups.find(g => g.agents.includes('*'));
  const blocks = g => !!g && g.dis.includes('/') && !g.allow.some(a => a === '/' || a === '/*' || a === '/$');
  const groupFor = ua => groups.find(g => g.agents.includes(ua)) || star;
  let aiBlocked = 0;
  AI_BOTS.forEach((b, i) => { if (blocks(groupFor(b.ua))) aiBlocked |= (1 << i); });
  return { blockAll: blocks(star) ? 1 : 0, aiBlocked, sitemaps };
}
export const aiBlockedNames = mask => AI_BOTS.filter((b, i) => mask & (1 << i)).map(b => b.name);

/** sitemap.xml -> { index, locs } or null when it is not a sitemap. */
export function parseSitemap(xml) {
  const s = String(xml || '');
  if (!/<(urlset|sitemapindex)\b/i.test(s)) return null;
  const locs = [...s.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/gi)].slice(0, 5000).map(m => decode(m[1]).trim()).filter(Boolean);
  return { index: /<sitemapindex\b/i.test(s), locs };
}

/* -------------------------------------------------------------- the stack */

/* What a site is built on. Matched against the raw HTML of every page read,
   scripts included, plus a few response headers. First match wins. */
export const PLATFORMS = [
  { name: 'Not identified', re: /$^/ },
  { name: 'Wix', re: /static\.wixstatic\.com|wix\.com\/|X-Wix-|wix-bolt|_wixCssImports/i },
  { name: 'Squarespace', re: /static1\.squarespace\.com|squarespace-cdn|Squarespace\b/ },
  { name: 'GoDaddy Website Builder', re: /img1\.wsimg\.com|websites\.godaddy|godaddy\.com\/websites|content="Starfield Technologies/i },
  { name: 'Shopify', re: /cdn\.shopify\.com|Shopify\.theme|x-shopify-/i },
  { name: 'Webflow', re: /data-wf-page|data-wf-site|webflow\.(com|io)\/|assets-global\.website-files\.com/i },
  { name: 'Duda', re: /irp\.cdn-website\.com|multiscreensite|dmcdn|dudaone/i },
  { name: 'Weebly', re: /weebly\.com|editmysite\.com/i },
  { name: 'Framer', re: /framerusercontent\.com|framer\.website|data-framer-/i },
  { name: 'GoHighLevel site builder', re: /data-page-id="[^"]+"[^>]*data-funnel|stcdn\.leadconnectorhq\.com|assets\.cdn\.filesafe\.space/i },
  { name: 'Hostinger Website Builder', re: /zyrosite|hostinger\.(com|site)\/builder|userapp\.zyrosite/i },
  { name: 'Google Sites', re: /sites\.google\.com\/|gstatic\.com\/atari/i },
  { name: 'Carrd', re: /carrd\.co/i },
  { name: 'WordPress', re: /\/wp-content\/|\/wp-includes\/|content="WordPress/i },
  { name: 'Joomla', re: /\/media\/jui\/|content="Joomla/i },
  { name: 'Drupal', re: /Drupal\.settings|drupal\.js|\/sites\/default\/files\//i },
  { name: 'A custom site (Next.js)', re: /__NEXT_DATA__|\/_next\/static\//i },
  { name: 'A custom site (React)', re: /data-reactroot|id="root"><\/div>\s*<script/i },
];

/* kind: booking | chat | crm | forms | analytics | pixel | calltrack | reviews */
export const TOOLS = [
  { name: 'GoHighLevel', kind: 'crm', re: /leadconnectorhq\.com|msgsndr\.com|gohighlevel|link\.msgsndr|api\.leadconnectorhq/i },
  { name: 'GoHighLevel web chat', kind: 'chat', re: /widgets\.leadconnectorhq\.com\/(chat-widget|loader\.js)|data-widget-id="[0-9a-f]{20,}"/i },
  { name: 'GoHighLevel booking calendar', kind: 'booking', re: /leadconnectorhq\.com\/widget\/(booking|bookings|group)|msgsndr\.com\/widget\/booking/i },
  { name: 'HubSpot', kind: 'crm', re: /js\.hs-scripts\.com|js\.hsforms\.net|hs-analytics\.net|hbspt\.forms/i },
  { name: 'HubSpot chat', kind: 'chat', re: /js\.usemessages\.com/i },
  { name: 'Salesforce', kind: 'crm', re: /pardot\.com|\.force\.com\/|salesforce\.com\/servlet/i },
  { name: 'Zoho', kind: 'crm', re: /zohopublic|salesiq\.zoho|crm\.zoho|zcampaigns/i },
  { name: 'Keap', kind: 'crm', re: /infusionsoft|keap\.app|keap-forms/i },
  { name: 'ActiveCampaign', kind: 'crm', re: /activehosted\.com|trackcmp\.net/i },
  { name: 'Mailchimp', kind: 'crm', re: /list-manage\.com|chimpstatic\.com/i },
  { name: 'Follow Up Boss', kind: 'crm', re: /followupboss/i },
  { name: 'kvCORE', kind: 'crm', re: /kvcore/i },
  { name: 'Jobber', kind: 'booking', re: /getjobber\.com|clienthub\.getjobber|jobber\.com\/(client|work_request)/i },
  { name: 'Housecall Pro', kind: 'booking', re: /housecallpro\.com/i },
  { name: 'ServiceTitan', kind: 'booking', re: /servicetitan\.(com|io)/i },
  { name: 'Calendly', kind: 'booking', re: /calendly\.com/i },
  { name: 'Acuity Scheduling', kind: 'booking', re: /acuityscheduling\.com|as\.me\//i },
  { name: 'Square Appointments', kind: 'booking', re: /squareup\.com\/appointments|square\.site\/book|app\.squareup\.com\/appointments/i },
  { name: 'Setmore', kind: 'booking', re: /setmore\.com/i },
  { name: 'Vagaro', kind: 'booking', re: /vagaro\.com/i },
  { name: 'Booksy', kind: 'booking', re: /booksy\.com/i },
  { name: 'Mindbody', kind: 'booking', re: /healcode\.com|mindbodyonline/i },
  { name: 'Cal.com', kind: 'booking', re: /app\.cal\.com|cal\.com\/embed/i },
  { name: 'Intercom', kind: 'chat', re: /widget\.intercom\.io|intercomcdn\.com/i },
  { name: 'Drift', kind: 'chat', re: /js\.driftt\.com/i },
  { name: 'Tidio', kind: 'chat', re: /code\.tidio\.co/i },
  { name: 'LiveChat', kind: 'chat', re: /cdn\.livechatinc\.com/i },
  { name: 'tawk.to', kind: 'chat', re: /embed\.tawk\.to/i },
  { name: 'Zendesk chat', kind: 'chat', re: /static\.zdassets\.com/i },
  { name: 'Podium', kind: 'chat', re: /podium\.com\/(widget|webchat)|connect\.podium\.com/i },
  { name: 'Birdeye', kind: 'reviews', re: /birdeye\.com/i },
  { name: 'Crisp', kind: 'chat', re: /client\.crisp\.chat/i },
  { name: 'Facebook Messenger chat', kind: 'chat', re: /customerchat|fb-customerchat/i },
  { name: 'Jotform', kind: 'forms', re: /jotform\.(com|us)/i },
  { name: 'Typeform', kind: 'forms', re: /typeform\.com/i },
  { name: 'Google Forms', kind: 'forms', re: /docs\.google\.com\/forms/i },
  { name: 'Gravity Forms', kind: 'forms', re: /gform_wrapper|gravityforms/i },
  { name: 'Contact Form 7', kind: 'forms', re: /wpcf7/i },
  { name: 'WPForms', kind: 'forms', re: /wpforms/i },
  { name: 'Elementor forms', kind: 'forms', re: /elementor-form/i },
  { name: 'Google Analytics', kind: 'analytics', re: /googletagmanager\.com\/gtag\/js\?id=G-|google-analytics\.com|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i },
  { name: 'Google Tag Manager', kind: 'analytics', re: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/i },
  { name: 'Microsoft Clarity', kind: 'analytics', re: /clarity\.ms/i },
  { name: 'Hotjar', kind: 'analytics', re: /static\.hotjar\.com/i },
  { name: 'Plausible', kind: 'analytics', re: /plausible\.io/i },
  { name: 'Meta pixel', kind: 'pixel', re: /connect\.facebook\.net\/[^"']*fbevents\.js|fbq\(\s*['"]init/i },
  { name: 'Google Ads tag', kind: 'pixel', re: /googleadservices\.com|['"]AW-\d{6,}/i },
  { name: 'TikTok pixel', kind: 'pixel', re: /analytics\.tiktok\.com/i },
  { name: 'LinkedIn Insight tag', kind: 'pixel', re: /snap\.licdn\.com/i },
  { name: 'CallRail', kind: 'calltrack', re: /callrail\.com|cdn\.callrail/i },
  { name: 'CallTrackingMetrics', kind: 'calltrack', re: /tctm\.co|calltrackingmetrics/i },
  { name: 'WhatConverts', kind: 'calltrack', re: /whatconverts/i },
  { name: 'Elfsight reviews', kind: 'reviews', re: /elfsight/i },
  { name: 'Trustindex reviews', kind: 'reviews', re: /trustindex\.io/i },
  { name: 'NiceJob', kind: 'reviews', re: /nicejob/i },
];
export const toolsOfKind = (tools, ...kinds) => (tools || []).filter(i => TOOLS[i] && kinds.includes(TOOLS[i].kind));

/** The platform (an index into PLATFORMS) and the tools (indexes into TOOLS). */
export function detectStack(htmls, headersList = []) {
  const hdr = (headersList || []).map(h => Object.entries(h || {}).map(([k, v]) => `${k}: ${v}`).join('\n')).join('\n');
  const hay = (htmls || []).join('\n') + '\n' + hdr;
  let platform = PLATFORMS.findIndex((p, i) => i > 0 && p.re.test(hay));
  if (platform < 0) platform = 0;
  const tools = TOOLS.map((t, i) => (t.re.test(hay) ? i : -1)).filter(i => i >= 0);
  /* the GoHighLevel chat and calendar imply GoHighLevel; list it once as the CRM */
  if (tools.some(i => /^GoHighLevel /.test(TOOLS[i].name)) && !tools.includes(0)) tools.unshift(0);
  return { platform, tools };
}

/* -------------------------------------------------------------- email DNS */

export const MX_PROVIDERS = ['None found', 'Google Workspace', 'Microsoft 365', 'GoDaddy email', 'Zoho Mail', 'Proton Mail', 'Yahoo', 'Another email provider'];
export function mxProvider(exchanges) {
  const list = (exchanges || []).map(x => String(x && x.exchange != null ? x.exchange : x).toLowerCase()).filter(Boolean);
  if (!list.length) return 0;
  const s = list.join(' ');
  if (/google\.com|googlemail\.com/.test(s)) return 1;
  if (/outlook\.com|protection\.outlook|office365/.test(s)) return 2;
  if (/secureserver\.net/.test(s)) return 3;
  if (/zoho\./.test(s)) return 4;
  if (/protonmail/.test(s)) return 5;
  if (/yahoodns|yahoo\./.test(s)) return 6;
  return 7;
}
const flatTxt = recs => (recs || []).map(r => (Array.isArray(r) ? r.join('') : String(r || '')));
export const spfOf = recs => (flatTxt(recs).some(t => /^v=spf1\b/i.test(t.trim())) ? 1 : 0);
/** 0 none, 1 a DMARC record that only watches (p=none), 2 one that acts. */
export function dmarcOf(recs) {
  const d = flatTxt(recs).find(t => /^v=DMARC1\b/i.test(t.trim()));
  if (!d) return 0;
  const p = /;\s*p\s*=\s*(\w+)/i.exec(d);
  return p && /^(quarantine|reject)$/i.test(p[1]) ? 2 : 1;
}

/* ----------------------------------------------------------- per page */

const PHONE = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?([2-9]\d{2})[\s.-]?(\d{4})\b/g;
const LOCAL_TYPE = /"@type"\s*:\s*\[?\s*"(LocalBusiness|[A-Za-z]*(Business|Contractor|Store|Service|Restaurant|Agent|Agency|Office|Clinic|Dentist|Physician|Attorney|Plumber|Electrician|Locksmith|Roofer|MovingCompany|AutoRepair|AutoDealer|HVACBusiness|HousePainter|GeneralContractor|RoofingContractor|Bakery|BarOrPub|CafeOrCoffeeShop|BeautySalon|HairSalon|DaySpa|LodgingBusiness|Hotel|Notary|Bank|InsuranceAgency|RealEstateAgent|AccountingService|LegalService|ChildCare|Pharmacy|Organization))"/;
const CONTACT_HREF = /(contact|quote|estimate|book|schedul|appointment|consult|calendly|acuityscheduling|leadconnectorhq\.com\/widget)/i;
const SKIP_INPUT = /^(hidden|submit|button|image|reset|checkbox|radio)$/i;

/** Numbers about one page that the homepage rules don't cover, plus two
 *  in-memory helpers (phones, titleKey) that never leave the crawl. */
export function pageExtras(rawHtml, headers = {}) {
  const raw = String(rawHtml || ''), body = bodyOf(raw), text = textOf(body);
  const metas = openTags(raw, 'meta').map(m => m.a);
  const robotsMeta = metas.filter(m => /^(robots|googlebot)$/i.test(m.name || '')).map(m => m.content || '').join(' ');
  const noindex = /noindex/i.test(robotsMeta) || /noindex/i.test(String((headers || {})['x-robots-tag'] || ''));
  let formFields = 0;
  for (const f of pairs(body, 'form')) {
    const fields = openTags(f.inner, 'input').filter(i => !SKIP_INPUT.test(i.a.type || 'text')).length + openTags(f.inner, 'select').length + openTags(f.inner, 'textarea').length;
    const lead = /<textarea\b/i.test(f.inner) || /type\s*=\s*["']?(email|tel)\b/i.test(f.inner) || /name\s*=\s*["']?[^"'>\s]*(phone|message)/i.test(f.inner);
    if (lead && fields >= 2) formFields = Math.max(formFields, fields);
  }
  const ld = [...raw.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const schemaFull = ld.some(j => LOCAL_TYPE.test(j) && /"telephone"\s*:/.test(j) && /"address"\s*:/.test(j)) ? 1 : 0;
  const faq = /frequently asked|\bfaqs?\b|common questions/i.test(text) || ld.some(j => /"FAQPage"/.test(j)) ? 1 : 0;
  const hrefs = pairs(body, 'a').map(a => (a.a.href || '').trim());
  const contactLink = hrefs.some(h => CONTACT_HREF.test(h)) || openTags(body, 'iframe').some(i => CONTACT_HREF.test(i.a.src || '')) ? 1 : 0;
  const phones = new Set();
  for (const m of (text + ' ' + hrefs.filter(h => /^tel:/i.test(h)).join(' ')).matchAll(PHONE)) phones.add(m[1] + m[2] + m[3]);
  return { words: wordCount(text), noindex: noindex ? 1 : 0, formFields, schemaFull, faq, contactLink, phones, titleKey: normalize(titleOf(raw)) };
}

/* ---------------------------------------------------------- site facts */

export const SITE_KEYS = ['pagesFound', 'pagesChecked', 'linksTested', 'brokenLinks', 'dupTitles', 'noDesc', 'badH1', 'thinPages', 'thinBase', 'noindexPages', 'homeNoindex', 'jsPages',
  'ctaPages', 'reachPages', 'formFields', 'phonesAll', 'reviewsAny', 'faqAny', 'servicePages', 'aboutPage', 'contactPage', 'areaPages', 'workPage',
  'robotsFound', 'robotsBlockAll', 'aiBlocked', 'sitemapFound', 'sitemapUrls', 'llms', 'schemaFull', 'platform', 'mx', 'spf', 'dmarc'];

/** Everything the crawl learned -> site facts, numbers only.
 *  pages: [{ kind, f (homepage-style facts from ./_rubric.js ruleFacts), x (pageExtras) }], the homepage first. */
export function siteFactsOf({ pages = [], found = 0, counts = {}, links = { tested: 0, broken: 0 }, robots = null, sitemap = null, llms = 0, dns = {}, stack = { platform: 0 } }) {
  const ok = pages.filter(p => p && p.f && p.x);
  const titles = {}; for (const p of ok) if (p.x.titleKey) titles[p.x.titleKey] = (titles[p.x.titleKey] || 0) + 1;
  const thin = ok.filter(p => p.kind !== 'contact' && !p.f.js);
  const phones = new Set(); for (const p of ok) for (const n of p.x.phones || []) phones.add(n);
  const form = (ok[0] && ok[0].x.formFields) || (ok.find(p => p.kind === 'contact' && p.x.formFields) || {}).x?.formFields || (ok.find(p => p.x.formFields) || {}).x?.formFields || 0;
  const cap = (n, max = 9999) => Math.max(0, Math.min(max, Math.round(Number(n) || 0)));
  return {
    pagesFound: cap(found, 999), pagesChecked: ok.length, linksTested: cap(links.tested, 99), brokenLinks: cap(links.broken, 99),
    dupTitles: ok.filter(p => p.x.titleKey && titles[p.x.titleKey] > 1).length,
    noDesc: ok.filter(p => !p.f.descLen).length,
    badH1: ok.filter(p => !p.f.js && p.f.h1Count !== 1).length,
    thinPages: thin.filter(p => p.x.words < 300).length, thinBase: thin.length,
    noindexPages: ok.filter(p => p.x.noindex).length, homeNoindex: ok[0] && ok[0].x.noindex ? 1 : 0,
    jsPages: ok.filter(p => p.f.js).length,
    ctaPages: ok.filter(p => p.f.cta).length,
    reachPages: ok.filter(p => p.f.tel || p.f.form || p.f.booking || p.x.contactLink).length,
    formFields: cap(form, 99), phonesAll: cap(phones.size, 99),
    reviewsAny: ok.some(p => p.f.reviews) || counts.reviews ? 1 : 0,
    faqAny: ok.some(p => p.x.faq) || counts.faq ? 1 : 0,
    servicePages: cap(counts.services, 99), aboutPage: counts.about ? 1 : 0, contactPage: counts.contact ? 1 : 0, areaPages: cap(counts.areas, 99), workPage: counts.work ? 1 : 0,
    robotsFound: robots ? 1 : 0, robotsBlockAll: robots ? robots.blockAll : 0, aiBlocked: robots ? robots.aiBlocked : 0,
    sitemapFound: sitemap ? 1 : 0, sitemapUrls: sitemap ? cap(sitemap.urls, 9999) : 0, llms: llms ? 1 : 0,
    schemaFull: ok.some(p => p.x.schemaFull) ? 1 : 0,
    platform: cap(stack.platform, PLATFORMS.length - 1), mx: cap(dns.mx, MX_PROVIDERS.length - 1), spf: dns.spf ? 1 : 0, dmarc: cap(dns.dmarc, 2),
  };
}

/** Site facts from a sealed token, re-checked: known keys, small whole numbers. */
export function cleanSite(s) {
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const k of SITE_KEYS) { const v = typeof s[k] === 'boolean' ? Number(s[k]) : s[k]; out[k] = Number.isFinite(v) && v >= 0 && v < 1e5 ? Math.round(v) : 0; }
  out.platform = Math.min(out.platform, PLATFORMS.length - 1); out.mx = Math.min(out.mx, MX_PROVIDERS.length - 1); out.dmarc = Math.min(out.dmarc, 2); out.aiBlocked &= (1 << AI_BOTS.length) - 1;
  return out;
}
export const cleanTools = t => (Array.isArray(t) ? [...new Set(t.filter(i => Number.isInteger(i) && i >= 0 && i < TOOLS.length))].slice(0, 40) : []);

/** The stack in words, from our tables only: what the report and the scan show. */
export function stackOf(site, tools) {
  const t = cleanTools(tools);
  return { platform: PLATFORMS[(site && site.platform) || 0].name, tools: t.map(i => ({ name: TOOLS[i].name, kind: TOOLS[i].kind })), email: MX_PROVIDERS[(site && site.mx) || 0] };
}
