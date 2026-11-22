// Sharing links (/p/<id>, /shop/<seller>) and the admin Social Media section (Phase 1: manual sharing).
// Posts are drafted by the database when a promotion's payment is confirmed. Admins preview, edit,
// approve, copy the caption, download a branded image and share by hand. Manual shares are recorded as
// "Shared manually"; only the future official API publisher can record "Published automatically".
const PLAT = { facebook: 'Facebook', tiktok: 'TikTok', whatsapp: 'WhatsApp' };
const LEAF = ['M24 42V24', 'M24 26C24 16 30.5 9.5 41 9c-.3 10.6-7 16.6-17 17Z', 'M23.6 30C23.4 22 18 16.4 8 16c.2 9.2 6.2 14 15.6 14Z'];
const FILT = { draft: ['draft'], approved: ['approved'], shared: ['shared_manually', 'published'], rejected: ['rejected', 'failed'], ended: ['cancelled'], all: null };

export function createSocial(c) {
  const { S, t, esc, KES, sb, toast, rpc, guarded, VF, mediaUrl, dlgOpen, fT } = c;
  S.so = { posts: [], ch: [], f: 'draft', lang: {}, ed: {}, url: {} };
  S.rid = null;
  const RX = /^\/(p|shop)\/([A-Za-z0-9-]{1,40})\/?$/, rq = new URLSearchParams(location.search).get('r');
  const RT = location.pathname.match(RX) || (rq && ('/' + rq).match(RX)); // ?r= is the share page's fallback link
  if (RT) { S.tab = RT[1] == 'p' ? 'item' : 'shopv'; S.rid = RT[2]; }

  // ------------------------------------------------------------ public sharing
  const base = () => (/shambasoko\.store$/.test(location.hostname) ? 'https://www.shambasoko.store' : location.origin);
  const itemUrl = (id) => base() + '/p/' + id;
  const shopUrl = (owner) => base() + '/shop/' + owner;
  async function copyText(s, okMsg) {
    try { await navigator.clipboard.writeText(s); toast(okMsg || t('shCopied')); return true; } catch (e) { /* clipboard unavailable */ }
    dlgOpen(`<h2>${t('shCopyH')}</h2><textarea class="socopy" readonly rows="4">${esc(s)}</textarea><p class="mut">${t('shLinkN')}</p>`);
    const el = document.querySelector('.socopy'); if (el) { el.focus(); el.select(); }
    return false;
  }
  async function shareLink(title, text, url) {
    if (navigator.share) {
      try { await navigator.share({ title, text, url }); return; } catch (e) { if (e && e.name == 'AbortError') return; }
    }
    copyText(url);
  }
  // Keep the address bar in step with the page, so links can be copied from it too.
  function syncUrl(adm) {
    if (adm) return;
    const want = S.tab == 'item' ? '/p/' + S.rid : S.tab == 'shopv' ? '/shop/' + S.rid : '/';
    if (location.pathname != want && (want != '/' || /^\/(p|shop)\//.test(location.pathname))) history.replaceState(null, '', want);
  }
  const seeMore = () => `<button class="btn out" data-a="home">${t('shMore')}</button>`;
  function itemView() {
    if (!S.loaded) return '<p class="mut">…</p>';
    const p = S.listings.find((x) => String(x.id) == S.rid && !x.hidden);
    if (!p) return `<h2>${t('shItemH')}</h2><div class="card"><p>${t('shGone')}</p></div>${seeMore()}`;
    return `<h2>${esc(p.n)}</h2><div class="grid soone">${c.cardHtml(p)}</div><button class="btn out" data-a="shopv" data-id="${p.owner}">🏪 ${t('shShopAll')}</button>${seeMore()}`;
  }
  function shopView() {
    if (!S.loaded) return '<p class="mut">…</p>';
    const l = S.listings.filter((x) => x.owner == S.rid && !x.hidden);
    if (!l.length) return `<h2>${t('shShopH')}</h2><div class="card"><p>${t('shShopNone')}</p></div>${seeMore()}`;
    return `<h2>🏪 ${esc(l[0].s)}${VF.badge(S.rid)}</h2><p class="mut">📍 ${esc(l[0].y)}</p><button class="btn sun" data-a="shshop" data-id="${esc(S.rid)}">↗ ${t('shShare')}</button><div class="grid" style="margin-top:10px">${l.map(c.cardHtml).join('')}</div>${seeMore()}`;
  }
  const shopButton = () => (S.profile && S.profile.role == 'seller' ? `<button class="btn out" data-a="shshop">↗ ${t('shShop')}</button>` : '');

  // ------------------------------------------------------------ admin data
  async function loadAdmin() {
    if (!S.admin) { S.so.posts = []; S.so.ch = []; return; }
    const [p, ch] = await Promise.all([
      sb.from('social_posts').select('*').order('created_at', { ascending: false }).limit(300),
      sb.from('social_channels').select('platform,status,auto_publish,require_approval,account_name,token_expires_at,connected_at,last_error,updated_at'),
    ]);
    if (!p.error) S.so.posts = p.data; if (!ch.error) S.so.ch = ch.data;
  }
  const chan = (k) => S.so.ch.find((x) => x.platform == k) || { platform: k, status: 'not_connected', require_approval: true };
  const promo = (id) => (S.preq || []).find((r) => r.id == id);
  const lang = (id) => S.so.lang[id] || S.lang;
  const cap = (p, l) => (S.so.ed[p.id] && S.so.ed[p.id][l] != null ? S.so.ed[p.id][l] : l == 'sw' ? p.caption_sw : p.caption_en);

  // ------------------------------------------------------------ branded image (made in the browser)
  const imgCache = new Map();
  function loadImg(src) {
    return new Promise((res) => { if (!src) return res(null); const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  }
  function rr(x, cx, y, w, h, r) { x.beginPath(); x.moveTo(cx + r, y); x.arcTo(cx + w, y, cx + w, y + h, r); x.arcTo(cx + w, y + h, cx, y + h, r); x.arcTo(cx, y + h, cx, y, r); x.arcTo(cx, y, cx + w, y, r); x.closePath(); }
  function wrap(x, s, w, max) {
    const out = []; let line = '';
    for (const word of String(s || '').split(/\s+/)) {
      const tr = line ? line + ' ' + word : word;
      if (x.measureText(tr).width <= w || !line) line = tr; else { out.push(line); line = word; }
      if (out.length == max) break;
    }
    if (line && out.length < max) out.push(line);
    if (out.length == max && x.measureText(out[max - 1]).width > w) { let l = out[max - 1]; while (l.length > 1 && x.measureText(l + '…').width > w) l = l.slice(0, -1); out[max - 1] = l + '…'; }
    return out;
  }
  function leaf(x, cx, y, size, color) {
    x.save(); x.translate(cx, y); x.scale(size / 48, size / 48);
    x.strokeStyle = color; x.lineWidth = 3.4; x.lineCap = 'round'; x.stroke(new Path2D(LEAF[0]));
    x.fillStyle = color; x.fill(new Path2D(LEAF[1])); x.globalAlpha = 0.82; x.fill(new Path2D(LEAF[2])); x.restore();
  }
  async function draw(p, l, tall, withPhoto) {
    const s = p.snapshot || {}, T = (k) => (c.TX[l] || c.TX.en)[k];
    const W = 1080, H = tall ? 1920 : 1080, pad = 64, F = '"Bricolage Grotesque", system-ui, sans-serif';
    try { await document.fonts.load('800 80px "Bricolage Grotesque"'); } catch (e) { /* system font fallback */ }
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const x = cv.getContext('2d');
    x.fillStyle = '#0F5132'; x.fillRect(0, 0, W, H);
    const ph = withPhoto && s.cover ? await loadImg(mediaUrl(s.cover)) : null;
    const pw = W - 2 * pad, phH = tall ? 1000 : 520;
    x.save(); rr(x, pad, pad, pw, phH, 36); x.clip();
    if (ph) { const sc = Math.max(pw / ph.width, phH / ph.height), dw = ph.width * sc, dh = ph.height * sc; x.drawImage(ph, pad + (pw - dw) / 2, pad + (phH - dh) / 2, dw, dh); }
    else { x.fillStyle = '#1B6B44'; x.fillRect(pad, pad, pw, phH); leaf(x, W / 2 - 130, pad + phH / 2 - 130, 260, '#F2B100'); }
    x.restore();
    // label over the photo
    x.font = `700 34px ${F}`; const tag = (T('soImgTag') || {})[s.service] || 'Shamba Soko', tw = x.measureText(tag).width + 48;
    x.fillStyle = '#F2B100'; rr(x, pad + 24, pad + 24, tw, 64, 32); x.fill(); x.fillStyle = '#17241b'; x.textBaseline = 'middle'; x.fillText(tag, pad + 48, pad + 57);
    // text block
    let y = pad + phH + (tall ? 110 : 84); x.textBaseline = 'alphabetic';
    const name = s.service == 'promoted_shop' ? s.seller_name : s.name || s.seller_name;
    x.font = `800 ${tall ? 92 : 72}px ${F}`; x.fillStyle = '#fff';
    for (const ln of wrap(x, name, pw, 2)) { x.fillText(ln, pad, y); y += tall ? 104 : 82; }
    if (s.price && s.service != 'promoted_shop') {
      x.font = `800 ${tall ? 72 : 56}px ${F}`; x.fillStyle = '#F2B100';
      x.fillText(wrap(x, 'KES ' + Number(s.price).toLocaleString('en-KE') + ' / ' + (s.unit || ''), pw, 1)[0], pad, y + 6); y += tall ? 96 : 76;
    }
    x.font = `500 ${tall ? 44 : 36}px system-ui, sans-serif`; x.fillStyle = '#e3f1e8';
    x.fillText(wrap(x, '🏪 ' + (s.seller_name || '') + '   📍 ' + (s.county || 'Kenya'), pw, 1)[0], pad, y); y += tall ? 64 : 52;
    if (s.verified) { x.fillStyle = '#F2B100'; x.font = `700 ${tall ? 40 : 32}px system-ui, sans-serif`; x.fillText('✔ ' + T('soImgVer'), pad, y); y += tall ? 60 : 48; }
    if (tall) {
      x.fillStyle = '#e3f1e8'; x.font = '400 40px system-ui, sans-serif';
      for (const ln of wrap(x, s.body || T('soImgSub'), pw, 3)) { y += 10; x.fillText(ln, pad, y + 30); y += 54; }
    }
    // footer
    const fh = tall ? 170 : 128; x.fillStyle = '#0A3220'; x.fillRect(0, H - fh, W, fh);
    leaf(x, pad, H - fh / 2 - 32, 64, '#F2B100'); x.fillStyle = '#fff'; x.font = `800 44px ${F}`; x.textBaseline = 'middle'; x.fillText('Shamba Soko', pad + 84, H - fh / 2);
    x.font = '500 30px system-ui, sans-serif'; x.fillStyle = '#e3f1e8'; x.textAlign = 'right';
    x.fillText(String(p.link || '').replace(/^https:\/\/(www\.)?/, ''), W - pad, H - fh / 2); x.textAlign = 'left';
    return cv;
  }
  // Supabase photos allow cross-site use; if a browser blocks it, the image is made without the photo.
  async function image(p, l, tall) {
    const key = [p.id, p.updated_at, l, tall ? 't' : 's'].join('|');
    if (imgCache.has(key)) return imgCache.get(key);
    let cv = await draw(p, l, tall, true);
    try { cv.toDataURL(); } catch (e) { cv = await draw(p, l, tall, false); }
    imgCache.set(key, cv); return cv;
  }
  function after() {
    document.querySelectorAll('img[data-so-img]').forEach(async (el) => {
      const p = S.so.posts.find((x) => x.id == el.dataset.soImg); if (!p) return;
      const cv = await image(p, el.dataset.l, p.platform == 'tiktok');
      el.src = cv.toDataURL('image/jpeg', 0.8);
    });
  }

  // ------------------------------------------------------------ admin view
  const stCls = (s) => (s == 'published' || s == 'shared_manually' ? 'completed' : s == 'approved' ? 'confirmed' : s == 'draft' ? 'pending' : 'cancelled');
  function chanRow(k) {
    const ch = chan(k), on = ch.status == 'connected';
    const st = { not_connected: t('soNotConn'), connected: t('soConn'), expired: t('soExpired'), error: t('soError') }[ch.status] || ch.status;
    return `<div class="tr sochan"><div><div class="pn"><span class="sop sop-${k}">${PLAT[k]}</span> <span class="bd ${on ? 'completed' : 'cancelled'}">${esc(st)}</span>${ch.account_name ? ` <span class="mut">${esc(ch.account_name)}</span>` : ''}</div>
<label class="ck"><input type="checkbox" data-a-change="sochan" data-p="${k}" data-k="auto" ${ch.auto_publish ? 'checked' : ''} ${on ? '' : 'disabled'}><span>${t('soAuto')}${on ? '' : ` <span class="mut">(${t('soAutoN')})</span>`}</span></label>
<label class="ck"><input type="checkbox" data-a-change="sochan" data-p="${k}" data-k="appr" ${ch.require_approval ? 'checked' : ''}><span>${t('soAppr')}</span></label>
${on || ch.status != 'not_connected' ? `<button class="chip" data-a="sodisc" data-p="${k}">${t('soDisconnect')}</button>` : `<button class="chip" disabled aria-describedby="soconn-${k}">${t('soConnect')}</button><div class="mut" id="soconn-${k}">${t('soConnectN')}</div>`}</div></div>`;
  }
  function postCard(p) {
    const s = p.snapshot || {}, pr = promo(p.promo_id), l = lang(p.id), ch = chan(p.platform), live = pr && pr.status == 'active';
    const edit = ['draft', 'approved', 'rejected'].includes(p.status), canShare = live && (p.status == 'approved' || (p.status == 'draft' && !ch.require_approval));
    const ed = S.so.ed[p.id] || {};
    let h = `<div class="card so" id="so-${p.id}"><div class="tr" style="padding-top:0"><b><span class="sop sop-${p.platform}">${PLAT[p.platform]}</span></b><span class="bd ${stCls(p.status)}">${t('soSt')[p.status] || p.status}</span></div>
<div class="mut">${t('soPromo')} #${p.promo_id ?? '–'} · ${t('soSvc')[s.service] || ''} · ${esc(s.seller_name || '')}${pr && pr.ends_at ? ` · ${t('soEnds')} ${fT(pr.ends_at)}` : ''}</div>
<div class="chips" role="group" aria-label="${t('soLang')}">${['en', 'sw'].map((x) => `<button class="chip" aria-pressed="${l == x}" data-a="solang" data-id="${p.id}" data-v="${x}">${x == 'en' ? 'English' : 'Kiswahili'}</button>`).join('')}</div>
<div class="sopv sopv-${p.platform}" aria-label="${t('soPreview')}"><img data-so-img="${p.id}" data-l="${l}" alt="${esc(t('soPreview'))}: ${esc(s.name || s.seller_name || '')}"><div class="socap">${esc(cap(p, l))}</div></div>`;
    h += `<div class="soact"><button class="btn out" data-a="socopy" data-id="${p.id}">📋 ${t('soCopy')}</button><button class="btn out" data-a="soimg" data-id="${p.id}">⬇ ${t('soImg')}</button></div><p class="mut">${t('soImgN')}</p>`;
    if (edit) {
      h += `<details class="soed"${S.so.ed[p.id] ? ' open' : ''}><summary>✏️ ${t('soEdit')}</summary><label class="f" for="soen-${p.id}">${t('soCapEn')}</label><textarea id="soen-${p.id}" rows="7" maxlength="2200" data-soed="${p.id}" data-k="en">${esc(ed.en ?? p.caption_en)}</textarea>
<label class="f" for="sosw-${p.id}">${t('soCapSw')}</label><textarea id="sosw-${p.id}" rows="7" maxlength="2200" data-soed="${p.id}" data-k="sw">${esc(ed.sw ?? p.caption_sw)}</textarea>
<button class="btn" data-a="sopost" data-x="save" data-id="${p.id}">${t('soSave')}</button>${p.status != 'approved' ? `<button class="btn out" data-a="sopost" data-x="regenerate" data-id="${p.id}">↻ ${t('soRegen')}</button>` : ''}</details>`;
    }
    if (p.status == 'draft' || p.status == 'approved') h += `<label class="f" for="sonote-${p.id}">${t('soReason')}</label><input type="text" id="sonote-${p.id}" maxlength="300">`;
    if (p.status == 'draft' && live) h += `<button class="btn" data-a="sopost" data-x="approve" data-id="${p.id}">✓ ${t('soApprove')}</button>`;
    if (canShare) {
      h += `<button class="btn sun" data-a="soopen" data-id="${p.id}">↗ ${t('soOpen')[p.platform]}</button>${p.platform == 'tiktok' ? `<p class="mut">${t('soTt')}</p>` : ''}
<label class="f" for="sourl-${p.id}">${t('soUrl')}</label><input type="text" inputmode="url" id="sourl-${p.id}" maxlength="500" placeholder="https://" value="${esc(S.so.url[p.id] || '')}" data-sourl="${p.id}"><button class="btn" data-a="sopost" data-x="mark_shared" data-id="${p.id}">✔ ${t('soDone')}</button>`;
    }
    if (p.status == 'draft' || p.status == 'approved') h += `<button class="btn out" data-a="sopost" data-x="reject" data-id="${p.id}">${t('soReject')}</button>`;
    if (p.status == 'rejected') h += `<button class="btn out" data-a="sopost" data-x="reopen" data-id="${p.id}">${t('soReopen')}</button>`;
    if (p.status == 'shared_manually') {
      h += `<div class="note">✔ ${t('soSharedAt')}: ${fT(p.shared_at)}${p.external_url ? ` · <a href="${esc(p.external_url)}" target="_blank" rel="noopener noreferrer">${t('soViewPost')}</a>` : ''}</div>
<label class="f" for="sourl-${p.id}">${t('soUrl')}</label><input type="text" inputmode="url" id="sourl-${p.id}" maxlength="500" placeholder="https://" value="${esc(S.so.url[p.id] ?? p.external_url ?? '')}" data-sourl="${p.id}"><button class="btn out" data-a="sopost" data-x="set_url" data-id="${p.id}">${t('soSaveUrl')}</button><button class="lk" data-a="sopost" data-x="undo_shared" data-id="${p.id}">${t('soUndo')}</button>`;
    }
    if (p.status == 'published') h += `<div class="note">✔ ${t('soPubAt')}: ${fT(p.published_at)}${p.external_url ? ` · <a href="${esc(p.external_url)}" target="_blank" rel="noopener noreferrer">${t('soViewPost')}</a>` : ''}</div>`;
    if (p.last_error) h += `<div class="warn">${esc(p.last_error)}</div>`;
    h += `<details><summary class="mut">${t('soHist')}</summary>${(p.history || []).map((e) => `<div class="mut">${fT(e.at)} · ${esc(e.s)} · ${esc(e.by)}${e.note ? ' · ' + esc(e.note) : ''}</div>`).join('')}</details></div>`;
    return h;
  }
  function adminSection() {
    if (!S.admin) return '';
    const P = S.so.posts, has = new Set(P.map((p) => p.promo_id));
    const missing = (S.preq || []).filter((r) => r.status == 'active' && new Date(r.ends_at) > new Date() && !has.has(r.id));
    const list = P.filter((p) => !FILT[S.so.f] || FILT[S.so.f].includes(p.status));
    return `<h2 style="margin-top:18px">📣 ${t('soH')}</h2><div class="note">${t('soN')}</div>
<div class="card"><div class="pn">${t('soChannels')}</div>${Object.keys(PLAT).map(chanRow).join('')}</div>
${missing.length ? `<div class="card"><div class="pn">${t('soNoPromo')}</div>${missing.map((r) => `<div class="tr"><div><div>#${r.id} · ${t('soSvc')[r.service] || r.service}</div><div class="mut">${esc(r.seller_name)}${r.title ? ' · ' + esc(r.title) : ''}</div></div><button class="chip" data-a="somake" data-id="${r.id}">${t('soMake')}</button></div>`).join('')}</div>` : ''}
<div class="chips" role="group">${Object.keys(FILT).map((k) => `<button class="chip" aria-pressed="${S.so.f == k}" data-a="sofilt" data-v="${k}">${t('soF')[k]} (${P.filter((p) => !FILT[k] || FILT[k].includes(p.status)).length})</button>`).join('')}</div>
${list.length ? list.map(postCard).join('') : `<p class="mut">${t('soNone')}</p>`}`;
  }

  // ------------------------------------------------------------ actions
  const val = (id) => ((document.getElementById(id) || {}).value || '').trim();
  async function reload() { await loadAdmin(); c.render(); }
  const A = {
    share: (d) => { if (d.id == '-1') return toast(t('pvonly')); const p = S.listings.find((x) => x.id == d.id); if (!p) return; shareLink(p.n, `${p.n}: ${KES(p.p)} / ${p.u} (${p.s}, ${p.y}) on Shamba Soko`, itemUrl(p.id)); },
    shshop: (d) => { const o = d.id || (S.user && S.user.id); if (!o) return; const l = S.listings.find((x) => x.owner == o); const n = (l && l.s) || (S.profile && (S.profile.biz || S.profile.name)) || 'Shamba Soko'; shareLink(n, `${n} on Shamba Soko`, shopUrl(o)); },
    shopv: (d) => { S.rid = d.id; S.tab = 'shopv'; c.render(); scrollTo(0, 0); },
    sofilt: (d) => { S.so.f = d.v; c.render(); },
    solang: (d) => { S.so.lang[d.id] = d.v; c.render(); },
    socopy: (d) => { const p = S.so.posts.find((x) => x.id == d.id); if (p) copyText(cap(p, lang(p.id)), t('soCopied')); },
    soimg: (d) => guarded(async () => {
      const p = S.so.posts.find((x) => x.id == d.id); if (!p) return; const l = lang(p.id);
      const cv = await image(p, l, p.platform == 'tiktok');
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png')); const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `shambasoko-${p.platform}-${p.id}-${l}.png`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }),
    // Opens the platform's own share page in a new tab; the admin finishes the post there by hand.
    soopen: (d) => {
      const p = S.so.posts.find((x) => x.id == d.id); if (!p) return; const text = cap(p, lang(p.id));
      const u = p.platform == 'facebook' ? 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(p.link)
        : p.platform == 'whatsapp' ? 'https://wa.me/?text=' + encodeURIComponent(text) : 'https://www.tiktok.com/upload';
      window.open(u, '_blank', 'noopener');
      if (p.platform != 'whatsapp') copyText(text, t('soCopied'));
    },
    sopost: (d) => guarded(async () => {
      const p = S.so.posts.find((x) => x.id == d.id); if (!p) return; const ed = S.so.ed[p.id] || {};
      const args = { p_id: p.id, p_action: d.x, p_seen: p.updated_at, p_note: val('sonote-' + p.id), p_url: null, p_caption_en: null, p_caption_sw: null };
      if (d.x == 'save') { args.p_caption_en = ed.en ?? p.caption_en; args.p_caption_sw = ed.sw ?? p.caption_sw; }
      if (d.x == 'mark_shared' || d.x == 'set_url') args.p_url = val('sourl-' + p.id) || null;
      const r = await rpc('admin_social_post_action', args);
      if (!r.error) { if (d.x == 'save' || d.x == 'regenerate') delete S.so.ed[p.id]; delete S.so.url[p.id]; toast(t('soOk')); }
      S.busy = false; await reload();
    }),
    somake: (d) => guarded(async () => { const r = await rpc('admin_social_create_for_promo', { p_promo: +d.id }); if (!r.error) toast(t('soOk')); S.busy = false; await reload(); }),
    sodisc: (d) => guarded(async () => { const r = await rpc('admin_social_disconnect', { p_platform: d.p }); if (!r.error) toast(t('soOk')); S.busy = false; await reload(); }),
    sochan: (el) => guarded(async () => {
      const k = el.dataset.p, box = (n) => document.querySelector(`input[data-a-change="sochan"][data-p="${k}"][data-k="${n}"]`);
      const r = await rpc('admin_social_channel_set', { p_platform: k, p_auto: box('auto').checked, p_require_approval: box('appr').checked });
      if (!r.error) toast(t('soOk')); S.busy = false; await reload();
    }),
  };
  ['sofilt', 'solang', 'socopy', 'soimg', 'soopen', 'sopost', 'somake', 'sodisc', 'sochan'].forEach((k) => { const f = A[k]; A[k] = (...a) => (S.admin ? f(...a) : toast(t('noAdmin'))); });
  // Caption and link edits are kept while the page refreshes in the background.
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.soed) { const o = S.so.ed[el.dataset.soed] || (S.so.ed[el.dataset.soed] = {}); o[el.dataset.k] = el.value; }
    if (el.dataset && el.dataset.sourl) S.so.url[el.dataset.sourl] = el.value;
  });

  return { loadAdmin, adminSection, itemView, shopView, shopButton, syncUrl, after, actions: A };
}
