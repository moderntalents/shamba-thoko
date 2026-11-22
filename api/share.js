// Share previews for /p/<id> and /shop/<seller>. Social apps (WhatsApp, Facebook, TikTok) do not run the
// app's JavaScript, so this adds the product's title, description and photo as Open Graph tags to the
// normal page. Only public data is read (with the public key, so hidden listings stay hidden); no phone numbers.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SB = process.env.VITE_SUPABASE_URL || 'https://nskbksmguplcdchbbxje.supabase.co';
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_stVo5g5OaNn4MvqP9t5aww_SHzrvw0t';
const SITE = 'https://www.shambasoko.store';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const media = (p) => `${SB}/storage/v1/object/public/listing-media/${String(p).split('/').map(encodeURIComponent).join('/')}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function rows(q) {
  const r = await fetch(`${SB}/rest/v1/listings?${q}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  return r.ok ? r.json() : [];
}
const cover = (l) => (l && (l.cover || (l.photos && l.photos[0] && l.photos[0].path))) || null;

export async function meta(type, id) {
  const sel = 'select=id,owner,name,price,unit,county,seller_name,cover,photos';
  if (type == 'p' && /^\d{1,12}$/.test(id)) {
    const [l] = await rows(`${sel}&id=eq.${id}&limit=1`);
    if (l) {
      const c = cover(l);
      return { url: `${SITE}/p/${l.id}`, title: `${l.name}: KES ${Number(l.price).toLocaleString('en-KE')} / ${l.unit} | Shamba Soko`,
        desc: `${l.name} from ${l.seller_name}, ${l.county}. Order on Shamba Soko, Kenya's farm marketplace.`, image: c ? media(c) : null };
    }
  } else if (type == 'shop' && UUID.test(id)) {
    const l = await rows(`${sel}&owner=eq.${id}&order=created_at.desc&limit=12`);
    if (l.length) {
      const c = cover(l.find(cover));
      return { url: `${SITE}/shop/${id}`, title: `${l[0].seller_name} | Shamba Soko`,
        desc: `${l[0].seller_name} in ${l[0].county}: ${l.slice(0, 4).map((x) => x.name).join(', ')}. Shop on Shamba Soko.`, image: c ? media(c) : null };
    }
  }
  return { url: SITE, title: 'Shamba Soko – Farm Marketplace', desc: 'Buy and sell farm produce, seedlings and farm inputs in Kenya.', image: null };
}

export function inject(html, m) {
  const img = m.image || `${SITE}/icon-512.png`;
  const tags = `<meta property="og:type" content="website"><meta property="og:site_name" content="Shamba Soko"><meta property="og:url" content="${esc(m.url)}">`
    + `<meta property="og:title" content="${esc(m.title)}"><meta property="og:description" content="${esc(m.desc)}"><meta property="og:image" content="${esc(img)}">`
    + `<meta name="twitter:card" content="${m.image ? 'summary_large_image' : 'summary'}"><link rel="canonical" href="${esc(m.url)}">`;
  return html.replace(/<title>[^<]*<\/title>/, `<title>${esc(m.title)}</title>`)
    .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${esc(m.desc)}">`)
    .replace('</head>', tags + '</head>');
}

export default async function handler(req, res) {
  const type = req.query.type == 'shop' ? 'shop' : 'p', id = String(req.query.id || '');
  let m; try { m = await meta(type, id); } catch (e) { m = await meta('', ''); }
  let html = null;
  try { html = await readFile(join(process.cwd(), 'dist', 'index.html'), 'utf8'); } catch (e) { /* not bundled: fetch it */ }
  try {
    if (!html) { const r = await fetch(`https://${req.headers.host}/index.html`); if (r.ok) html = await r.text(); }
    if (!html || !html.includes('id="view"')) throw new Error('app page not available');
  } catch (e) { // fallback: preview tags and a link into the app
    html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shamba Soko</title><meta name="description" content=""><meta http-equiv="refresh" content="0;url=/?r=${encodeURIComponent(type + '/' + id)}"></head><body><a href="/">Shamba Soko</a></body></html>`;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300, stale-while-revalidate=600');
  res.status(200).send(inject(html, m));
}
