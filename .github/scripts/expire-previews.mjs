// Deletes previews/*.html whose <meta name="preview-expires"> date has passed
// (end of that day, Central time), plus that business's images in
// images/previews/ once no page for it is left. Run nightly by
// .github/workflows/expire-previews.yml. Dry run: node .github/scripts/expire-previews.mjs --dry
import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DRY = process.argv.includes('--dry');
const dir = 'previews';
const now = new Date();
const removed = [];

for (const f of readdirSync(dir)) {
  if (!f.endsWith('.html') || f === 'index.html') continue;
  const html = readFileSync(join(dir, f), 'utf8');
  const m = html.match(/name="preview-expires"\s+content="(\d{4}-\d{2}-\d{2})"/);
  if (!m) continue; // no expiry date = keep (never guess)
  const end = new Date(m[1] + 'T23:59:59-06:00');
  if (now > end) {
    removed.push(f);
    if (!DRY) rmSync(join(dir, f));
  }
}

// images/previews/<slug>-*.jpg go once neither <slug>.html nor <slug>-report.html is left
const imgDir = 'images/previews';
if (existsSync(imgDir)) {
  const slugs = new Set(removed.map(f => f.replace(/(-report)?\.html$/, '')));
  for (const slug of slugs) {
    const stillThere = existsSync(join(dir, slug + '.html')) || existsSync(join(dir, slug + '-report.html'));
    if (stillThere) continue;
    for (const img of readdirSync(imgDir)) {
      if (img.startsWith(slug + '-') || img.startsWith(slug + '.')) {
        removed.push(join(imgDir, img));
        if (!DRY) rmSync(join(imgDir, img));
      }
    }
  }
}

console.log((DRY ? 'Would remove ' : 'Removed ') + removed.length + ' file(s)');
for (const r of removed) console.log('  ' + r);
