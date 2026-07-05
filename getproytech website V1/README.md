# ProyTech Website

Premium marketing site + real AI front-desk chatbot ("Ace") for realtors & lenders.
Static `index.html` with one Vercel serverless function for the live Claude-powered chat.

```
proytech-site/
├── index.html        ← the whole site (self-contained)
├── api/
│   └── chat.js        ← serverless function that powers Ace (calls Anthropic)
├── vercel.json        ← minimal config + security headers
├── robots.txt
└── sitemap.xml
```

## Deploy in ~5 minutes

**1. Push to GitHub**
- Create a new repo (e.g. `proytech-site`)
- Upload every file above, keeping the `api/` folder intact

**2. Import into Vercel**
- vercel.com → **Add New → Project** → import the repo
- Framework preset: **Other** (no build step needed) → **Deploy**

**3. Turn Ace on (required for the chatbot)**
- In Vercel → your project → **Settings → Environment Variables**
- Add: `ANTHROPIC_API_KEY` = your Anthropic key (a new/separate key from the CRM is fine)
- **Redeploy** so the new variable takes effect
- ⚠️ This is a **new** Vercel project, so it does NOT share the CRM's env vars — you must add the key here too.

**4. Point the domain**
- Vercel → **Settings → Domains** → add `getproytech.com`
- Update the DNS records at your registrar as Vercel instructs

That's it. The site is live and Ace is answering.

## Notes

- **Ace's model** is set at the top of `api/chat.js` (`MODEL`). Default is Haiku 4.5 (fast + cheap). Swap to `claude-sonnet-5` for richer conversation.
- **Ace's brain** (offers, pricing, tone, rules) lives in `SYSTEM_PROMPT` in `api/chat.js` — edit that to change how Ace talks or what it knows.
- Before deploy, opening `index.html` locally will show the full site, but Ace will say it "can't reach the server" — that's expected until it's live on Vercel with the key set.
- **OG image:** add an `og-image.png` (1200×630) to the repo root for link previews. Referenced in `<head>`.
- All prices shown are the **"starting at"** floors, matching the offering doc.

## To edit later
- Copy: search `index.html` for the headline / section you want.
- Colors: all in the `:root` block at the top of `index.html` (`--cobalt`, `--orange`, etc.).
- Ace: everything in `api/chat.js`.
