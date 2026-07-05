// api/slots.js — returns up to 3 real open times from Calendly (spread across days).
//
// ENV VAR (Vercel → Settings → Environment Variables):
//   CALENDLY_TOKEN = your Calendly Personal Access Token
//
// If the token is missing or anything fails, returns { slots: [] } and the
// widget gracefully falls back to opening the full Calendly page.

const EVENT_SLUG = '30min'; // calendly.com/getproytech/30min

export default async function handler(req, res) {
  const token = process.env.CALENDLY_TOKEN;
  if (!token) return res.status(200).json({ slots: [] });

  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  try {
    // 1) who am I
    const meR = await fetch('https://api.calendly.com/users/me', { headers: H });
    if (!meR.ok) throw new Error('users/me ' + meR.status);
    const me = await meR.json();
    const userUri = me.resource.uri;

    // 2) find the 30min event type
    const etR = await fetch(`https://api.calendly.com/event_types?user=${encodeURIComponent(userUri)}&active=true&count=50`, { headers: H });
    if (!etR.ok) throw new Error('event_types ' + etR.status);
    const et = await etR.json();
    const evt = (et.collection || []).find(e => (e.slug === EVENT_SLUG)) || (et.collection || [])[0];
    if (!evt) throw new Error('no event types');

    // 3) available times: from 2h out to 6 days out (Calendly caps at 7)
    const start = new Date(Date.now() + 2 * 3600 * 1000);
    const end = new Date(Date.now() + 6 * 24 * 3600 * 1000);
    const url = `https://api.calendly.com/event_type_available_times?event_type=${encodeURIComponent(evt.uri)}&start_time=${start.toISOString()}&end_time=${end.toISOString()}`;
    const avR = await fetch(url, { headers: H });
    if (!avR.ok) throw new Error('available_times ' + avR.status);
    const av = await avR.json();
    const all = (av.collection || []).filter(s => s.status === 'available');

    // 4) pick up to 3, preferring distinct days so the options feel spread out
    const byDay = {};
    for (const s of all) {
      const day = s.start_time.slice(0, 10);
      (byDay[day] = byDay[day] || []).push(s);
    }
    const days = Object.keys(byDay).sort();
    const picks = [];
    for (const d of days) {
      if (picks.length >= 3) break;
      picks.push(byDay[d][0]); // first open slot that day
    }
    // if fewer than 3 days had slots, pad from remaining
    if (picks.length < 3) {
      for (const s of all) {
        if (picks.length >= 3) break;
        if (!picks.includes(s)) picks.push(s);
      }
    }

    return res.status(200).json({
      slots: picks.map(s => ({ start_time: s.start_time, url: s.scheduling_url }))
    });
  } catch (err) {
    console.error('slots error:', err.message);
    return res.status(200).json({ slots: [] });
  }
}
