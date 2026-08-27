# How the onboarding forms reach the Google Sheet

## The existing mechanism (unchanged)

Every ProyTech onboarding form uses the same three-hop path. There is no Google
Form embed and no Apps Script URL in the front-end code:

```
form page (HTML)  --POST JSON-->  /api/<name>  --POST JSON-->  SHEETS_WEBHOOK_URL  -->  Sheet tab
   (browser)                    (Vercel function)              (Apps Script /exec)
```

1. The page collects answers into a flat JSON object and `fetch()`es its own
   `/api/<name>` endpoint. Nothing about Google appears in the browser.
2. The Vercel function (`api/<name>.js`) reads `SHEETS_WEBHOOK_URL` from the
   environment, stamps a `type` flag and `submitted_at`, and forwards the JSON.
3. The Apps Script web app behind that URL routes on `type` and appends a row.

The webhook URL is deliberately server-side only — it is not in the repo and not
in the page source, so the sheet cannot be written to by anyone who views source.

Existing routes:

| Form page              | Endpoint               | `type`            |
|------------------------|------------------------|-------------------|
| `onboard.html`         | `/api/onboard`         | `onboarding`      |
| `onboard-website.html` | `/api/onboard`         | `onboarding`      |
| `crm-onboard.html`     | `/api/crm-onboard`     | `crm_onboarding`  |
| `landing-onboard.html` | `/api/landing-onboard` | `landing_page`    |

New routes added here:

| Form page                        | Endpoint               | `type`           | Tab              |
|----------------------------------|------------------------|------------------|------------------|
| `onboarding/website-build.html`  | `/api/website-build`   | `website_build`  | `Website Build`  |
| `onboarding/business-suite.html` | `/api/business-suite`  | `business_suite` | `Business Suite` |

Both new functions also send a `tab` field naming the destination tab, so a
router can use that instead of maintaining a `type` map.

> One exception worth knowing about: `onboarding/poppell.html` posts *directly*
> to a different, hard-coded Apps Script URL. It is a one-off client form on its
> own branding and is not part of this pattern. Don't copy it.

## The one step that has to happen in Apps Script

The Vercel side is done and deployed by pushing. The Apps Script does **not**
know about `website_build` or `business_suite` yet. Until it does, submissions
will either land in a default tab or be dropped, depending on how the script is
written.

Open the Sheet → **Extensions → Apps Script**, and add the two new types to
whatever routing table is already there. If it looks like a map, it's two lines:

```js
var TABS = {
  onboarding:      'Onboarding',
  crm_onboarding:  'CRM Onboarding',
  landing_page:    'Landing Page Brief',
  website_build:   'Website Build',      // <-- add
  business_suite:  'Business Suite'      // <-- add
};
```

Then **Deploy → Manage deployments → edit → Deploy** to publish the change.
Editing the code alone does nothing until you redeploy.

## If you'd rather not touch the existing script

This drop-in handles any form, present or future, with no per-form edits: it
uses the `tab` field, creates the tab if it doesn't exist, and writes a header
row from the payload's own keys the first time it sees a new tab. New columns
added to a form later are appended rather than silently dropped.

```js
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var data = JSON.parse(e.postData.contents);
    var name = data.tab || TABS[data.type] || 'Inbox';
    var ss    = SpreadsheetApp.openById('1_kDwgiOMeDHO_tlChhWPETNmURXDdhP3pXYhkmAyMrg');
    var sheet = ss.getSheetByName(name) || ss.insertSheet(name);

    var keys = Object.keys(data);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(keys);
      sheet.getRange(1, 1, 1, keys.length).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }

    var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    keys.forEach(function (k) {                  // append columns we've not seen before
      if (header.indexOf(k) === -1) {
        header.push(k);
        sheet.getRange(1, header.length).setValue(k).setFontWeight('bold');
      }
    });

    sheet.appendRow(header.map(function (h) { return data[h] === undefined ? '' : data[h]; }));
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}
```

`LockService` matters: two forms submitted in the same second can otherwise
append to the same row and one overwrites the other.

## Verifying it works

Send a real submission and watch the tab. If a row appears, you're done. If not,
open **Executions** in the Apps Script editor — a failure there names the cause.
The Vercel function logs (`Deployments → Functions`) show whether the forward
itself succeeded.

## Field values that aren't plain text

Two fields arrive as multi-line strings, one item per line:

- `websites` — `kleenstripe.com — Main site\nkleenstripereviews.com — Reviews site`
- `stages` (Business Suite) — one stage per line, in order
- `team` (Business Suite) — `Name — role — access level`, one person per line

They land in a single cell with line breaks intact, which reads fine in the
Sheet. Multi-select answers arrive comma-separated on one line.
