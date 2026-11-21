import './style.css';
import { TX } from './tx.js';
import { VTX } from './tx-verify.js';
import { GTX } from './tx-grow.js';
import { createGrow } from './grow.js';
import { RTX } from './tx-riders.js';
import { createRiders } from './riders.js';
import { createVerify } from './verify.js';
Object.assign(TX.en, VTX.en); Object.assign(TX.sw, VTX.sw);
for (const l of ['en', 'sw']) { const { nkg, ...g } = GTX[l]; Object.assign(TX[l], g); TX[l].nk = { ...TX[l].nk, ...nkg }; }
for (const l of ['en', 'sw']) { const { nkr, ...r } = RTX[l]; Object.assign(TX[l], r); TX[l].nk = { ...TX[l].nk, ...nkr }; }
import { CATS, COUNTIES, TABS, EMO, PRICES, DOC, DEL, LEGAL } from './data.js';
import { sb, BUCKET, mediaUrl, phoneEmail } from './supabase.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KES = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE');

// ------------------------------------------------------------------ state
const S = {
  lang: 'en', tab: 'shop', cat: 'all', q: '', cty: 'All', cart: {}, crop: 'Tomato', sym: null, dm: 'boda', addr: '', phone: '', agree: false,
  f: { n: '', c: 'produce', y: 'Kirinyaga', p: '', u: '', ok: false, file: null, fileObj: null, imgs: [], cv: '' },
  am: 'login', after: null, spw: false, of: 'all', pend: null, gal: null,
  user: null, profile: null, admin: false,
  listings: [], orders: [], reports: [], accounts: [], loaded: false, busy: false,
};
const t = (k) => TX[S.lang][k] ?? TX.en[k] ?? k;
try {
  const d = JSON.parse(localStorage.getItem('ss-app') || '{}');
  if (d.lang) S.lang = d.lang;
  if (d.cart && typeof d.cart === 'object') S.cart = d.cart;
} catch (e) { /* storage unavailable */ }
const save = () => { try { localStorage.setItem('ss-app', JSON.stringify({ lang: S.lang, cart: S.cart })); } catch (e) { /* ignore */ } };

const blankAf = (y) => ({ name: '', biz: '', phone: '', pw: '', pw2: '', role: 'buyer', y: y || 'Kiambu' });
S.af = blankAf();
const me = () => S.profile;
const isSeller = () => !!(S.profile && S.profile.role === 'seller');
const isAdmin = () => S.admin;
const normPh = (v) => { const x = String(v).replace(/[\s-]/g, ''); return /^(\+?254|0)[71]\d{8}$/.test(x) ? '254' + x.slice(-9) : ''; };
const showPh = (p) => (p ? '0' + p.slice(3) : '');
const maskPh = (p) => (p ? '0' + p.slice(3, 6) + ' ••• ' + p.slice(-3) : '');

function toast(m) { const e = $('#toast'); e.textContent = m; e.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => e.classList.remove('on'), 2800); }
const errMsg = (e) => {
  const m = String((e && (e.message || e.error_description)) || '');
  if (/fetch|network/i.test(m)) return t('eErr');
  if (/already registered|already exists|duplicate/i.test(m)) return t('eTaken');
  if (/Invalid login/i.test(m)) return t('eBad');
  if (/rate limit|too many/i.test(m)) return t('eLock');
  if (/no_tick/.test(m)) return t('eTick');
  return m || t('eErr');
};

// ------------------------------------------------------------------ data
const toListing = (r) => ({
  id: r.id, n: r.name, c: r.category, p: r.price, u: r.unit, s: r.seller_name, y: r.county, e: EMO[r.category], chem: r.chem, sr: r.seller_rider !== false, br: r.buyer_rider !== false,
  owner: r.owner, hidden: r.hidden, mine: 1, cv: r.cover || '', vu: r.video ? mediaUrl(r.video) : '', video: r.video,
  ph: (r.photos || []).map((x) => ({ id: x.path, u: mediaUrl(x.path), k: x.k })),
});
const toOrder = (r) => ({
  id: r.id, b: r.buyer, bn: r.buyer_name, bp: r.buyer_phone, sl: r.seller, sn: r.seller_name, items: r.items, sub: r.sub, fee: r.fee,
  dm: r.dm, t: r.total, a: r.address, st: r.status, ct: r.confirmed_total, cd: r.confirm_details || '', log: r.log || [], disp: r.disputes || [],
});

async function loadListings() {
  const { data, error } = await sb.from('listings').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) { toast(errMsg(error)); return; }
  S.listings = data.map(toListing);
  S.loaded = true;
  // Drop cart items that are gone.
  let changed = false;
  for (const id of Object.keys(S.cart)) if (!S.listings.some((p) => p.id == id && !p.hidden)) { delete S.cart[id]; changed = true; }
  if (changed) save();
}
async function loadOrders() {
  if (!S.user) { S.orders = []; return; }
  const { data, error } = await sb.from('orders').select('*').order('created_at', { ascending: false }).limit(300);
  if (!error) S.orders = data.map(toOrder);
}
async function loadAdmin() {
  VF.loadApps();
  if (!isAdmin()) { S.reports = []; S.accounts = []; return; }
  const [r, a] = await Promise.all([
    sb.from('reports').select('*').order('created_at', { ascending: false }).limit(200),
    sb.from('profiles').select('*').order('created_at', { ascending: false }).limit(500),
  ]);
  if (!r.error) S.reports = r.data;
  if (!a.error) S.accounts = a.data;
}
async function loadProfile() {
  const { data: { session } } = await sb.auth.getSession();
  S.user = session ? session.user : null;
  if (!S.user) { S.profile = null; S.admin = false; return; }
  const [p, a] = await Promise.all([
    sb.from('profiles').select('*').eq('id', S.user.id).maybeSingle(),
    sb.from('admins').select('user_id').eq('user_id', S.user.id).maybeSingle(),
  ]);
  S.profile = p.data || null;
  S.admin = !!a.data;
}
async function refreshAll() { await loadProfile(); await Promise.all([loadListings(), loadOrders(), loadAdmin(), VF.loadVerified(), VF.loadMine(), GR.loadPublic(), GR.loadMine(), GR.loadAdmin(), RD.loadMine(), RD.loadAdmin()]); }

// ------------------------------------------------------------------ helpers
const all = () => S.listings.filter((p) => !p.hidden);
const cnt = () => Object.values(S.cart).reduce((a, b) => a + b, 0);
function calc() {
  const it = Object.keys(S.cart).map((id) => [all().find((p) => p.id == id), S.cart[id]]).filter((x) => x[0]);
  const g = {}; it.forEach((x) => (g[x[0].owner] = g[x[0].owner] || []).push(x));
  const sub = it.reduce((a, x) => a + x[0].p * x[1], 0), fee = 0; // no delivery fee: buyer and seller agree who pays the rider
  return { it, g, sub, fee };
}
const pendN = () => { const m = me(); return m ? S.orders.filter((o) => o.sl == m.id && o.st == 'placed').length : 0; };
const rideN = () => (S.user ? S.dels.filter((d) => d.rider == S.user.id && d.status == 'requested').length : 0);
const navTabs = () => (isSeller() ? [...TABS.slice(0, 4), ['orders', '📋']] : RD.isRider() ? [...TABS.slice(0, 3), ['rides', '🛵']] : TABS);

function chrome() {
  document.documentElement.lang = S.lang == 'sw' ? 'sw' : 'en';
  $('#tag').textContent = t('tag'); $('#inf').textContent = t('info');
  const l = $('#lg'); l.textContent = t('lg'); l.setAttribute('aria-label', t('lgl')); $('#cl').textContent = t('cl');
  const m = me(), b = $('#ac'), pn = pendN();
  $('header').classList.toggle('li', !!m);
  const vn = VF.unread();
  // Logged out: a clear "Log in / Sign up" button. Logged in: the existing account button.
  b.classList.toggle('lo', !m);
  b.textContent = m ? '👤 ' + m.name.split(' ')[0] + (pn ? ' · ' + pn : '') + (vn ? ' 🔔' + vn : '') : t('lsu');
  b.setAttribute('aria-label', m ? t('acct') + ': ' + m.name : t('lsu'));
  b.toggleAttribute('aria-current', S.tab == 'account');
  $('#nav').innerHTML = navTabs().map(([k, i]) => `<button data-a="tab" data-v="${k}" ${k == S.tab ? 'aria-current="page"' : ''}><span aria-hidden="true">${i}</span>${t(k)}${k == 'cart' && cnt() ? `<b aria-label="${cnt()}">${cnt()}</b>` : k == 'orders' && pendN() ? `<b aria-label="${pendN()}">${pendN()}</b>` : k == 'rides' && rideN() ? `<b aria-label="${rideN()}">${rideN()}</b>` : ''}</button>`).join('');
}
function render() {
  if (S.tab == 'admin' && !isAdmin()) S.tab = 'shop';
  if (S.tab == 'orders' && !isSeller()) S.tab = 'shop';
  if ((S.tab == 'verify' && !isSeller() && !RD.isRider()) || (S.tab == 'grow' && !isSeller()) || (S.tab == 'rides' && !RD.isRider())) S.tab = 'account';
  if (S.tab != 'verify') VF.stopCam();
  chrome();
  $('#view').innerHTML = V[S.tab]();
  if (S.tab == 'shop') fill();
}
const needLogin = (after, msg) => { S.after = after; S.am = 'login'; S.tab = 'account'; render(); scrollTo(0, 0); toast(t(msg || 'needLogin')); };

// ------------------------------------------------------------------ media helpers
const MAXN = 6, MAXB = 8 * 1048576;
async function sniff(f) {
  const x = Array.from(new Uint8Array(await f.slice(0, 12).arrayBuffer()), (v) => v.toString(16).padStart(2, '0')).join('');
  return x.startsWith('ffd8ff') || x.startsWith('89504e47') || (x.slice(0, 8) == '52494646' && x.slice(16, 24) == '57454250');
}
// Re-encode to JPEG: shrinks the photo and removes location (EXIF) data.
async function shrink(f) {
  let bm; try { bm = await createImageBitmap(f, { imageOrientation: 'from-image' }); } catch (e) { bm = await createImageBitmap(f); }
  if (bm.width < 200 || bm.height < 200 || bm.width * bm.height > 50e6) throw 0;
  const s = Math.min(1, 1280 / Math.max(bm.width, bm.height)), c = document.createElement('canvas');
  c.width = Math.round(bm.width * s); c.height = Math.round(bm.height * s);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bm, 0, 0, c.width, c.height); bm.close && bm.close();
  return new Promise((r, j) => c.toBlob((b) => (b ? r(b) : j(0)), 'image/jpeg', 0.82));
}
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (v) => v.toString(16).padStart(2, '0')).join('');
const VIDEO_EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

const ptg = () => t('su');
const mediaOf = (p) => {
  const l = p.prev || p.ph || []; if (!l.length) return `<div class="em" aria-hidden="true">${p.e}</div>`;
  const c = l.find((x) => x.id == p.cv) || l[0];
  return `<button class="cvb" data-a="photos" data-id="${p.id}" aria-label="${esc(p.n)}: ${l.length} photo${l.length > 1 ? 's' : ''}"><img src="${esc(c.u)}" loading="lazy" alt="${esc(p.n)}, ${ptg(p)}"><span class="tag">${ptg(p)}</span>${l.length > 1 ? `<span class="cnt">📷 ${l.length}</span>` : ''}</button>`;
};
const cardHtml = (p) => `<div class="card${GR.isFeatured(p.id) ? ' feat' : ''}">${GR.isFeatured(p.id) ? `<div class="ftag">${t('gFeatured')}</div>` : ''}${mediaOf(p)}<div class="pn">${esc(p.n)}</div><div class="mut"><button class="lk sl" data-a="sinfo" data-id="${p.id}">${esc(p.s)}</button>${VF.badge(p.owner)}</div><div class="mut">📍 ${esc(p.y)}</div><div class="mut">${p.owner && S.user && p.owner == S.user.id ? t('yours') : t('dlist')}</div>${p.chem ? `<div class="warn">⚠ ${t('chem')}</div>` : ''}<div class="price">${KES(p.p)} <span class="mut">/ ${esc(p.u)}</span></div>${p.vu ? `<button class="btn out" data-a="video" data-id="${p.id}">▶ ${t('vid')}</button>` : ''}<button class="btn" data-a="add" data-id="${p.id}">${t('add')}</button><button class="btn out" data-a="contact" data-id="${p.id}">📞 ${t('contact')}</button>${VF.waBtn(p.owner, p.n)}<button class="lk" data-a="report" data-id="${p.id}">${t('rep')}</button></div>`;
const gal = (p, i) => {
  const l = p.prev || p.ph, c = l[i], pt = t('pts');
  return `<div class="gv"><h2>${esc(p.n)}</h2><img class="main" src="${esc(c.u)}" alt="${esc(p.n)}, photo ${i + 1} of ${l.length}, ${ptg(p)}"><div class="mut" style="margin:6px 0"><b>${ptg(p)}</b> · ${pt[c.k] || ''} · ${i + 1}/${l.length}</div><div class="th">${l.map((x, j) => `<button data-a="gal" data-i="${j}" aria-current="${j == i}" aria-label="Photo ${j + 1}"><img src="${esc(x.u)}" alt="" style="width:100%;height:100%;object-fit:cover"></button>`).join('')}</div><div class="note">${t('unv')}</div>${p.prev ? '' : `<label class="f" for="rr">${t('rwhy')}</label><select id="rr">${t('rs').map((x, j) => `<option value="${j}">${x}</option>`).join('')}</select><button class="btn out" data-a="rphoto" data-i="${i}">${t('rph')}</button>`}</div>`;
};
const draft = () => { const f = S.f; return { id: -1, n: f.n.trim() || t('iname'), c: f.c, p: Number(f.p) || 0, u: f.u.trim() || 'unit', s: (me() && (me().biz || me().name)) || 'You', owner: S.user && S.user.id, y: f.y, e: EMO[f.c], mine: 1, chem: f.c == 'input', vu: f.file || '', cv: f.cv, prev: f.imgs.map((i) => ({ id: i.id, u: i.u, k: i.k })) }; };
const photoCard = () => { const f = S.f, pt = t('pts'); return `<div class="card"><div class="pn">📷 ${t('phH')}</div><p class="mut">${t('phN')}</p><input type="file" id="spi" accept="image/jpeg,image/png,image/webp" multiple data-a-change="imgs" aria-label="${t('phH')}" ${f.imgs.length >= MAXN ? 'disabled' : ''}><p class="mut">${t('phS')}</p>${f.imgs.length ? `<div class="pg">${f.imgs.map((i, n) => `<div class="pi"><div class="pw"><img src="${i.u}" alt="Photo ${n + 1} preview"><span class="tag">${t('su')}</span></div><button class="chip" aria-pressed="${f.cv == i.id}" data-a="cover" data-id="${i.id}">${f.cv == i.id ? '★ ' + t('cover') : t('mkcover')}</button><select data-a-change="ptype" data-id="${i.id}" aria-label="Photo type">${Object.keys(pt).map((k) => `<option value="${k}" ${i.k == k ? 'selected' : ''}>${pt[k]}</option>`).join('')}</select><button class="lk" data-a="prm" data-id="${i.id}">${t('prm')}</button></div>`).join('')}</div>` : ''}</div>`; };

function fill() {
  const q = S.q.toLowerCase();
  const l = all().filter((p) => (S.cat == 'all' || p.c == S.cat) && (S.cty == 'All' || p.y == S.cty) && (!q || (p.n + ' ' + p.s).toLowerCase().includes(q)));
  l.sort((a, b) => GR.isFeatured(b.id) - GR.isFeatured(a.id)); // paid, approved Featured products first (stable sort keeps the rest in order)
  const top = $('#ptop'); if (top) top.innerHTML = q || S.cat != 'all' || S.cty != 'All' ? '' : GR.shopTop();
  $('#list').innerHTML = !S.loaded ? `<p class="mut">…</p>` : l.length ? l.map(cardHtml).join('') : `<p class="mut">${t('none')}</p>`;
}
const opts = (a, sel, fn) => a.map((x) => `<option value="${esc(x)}" ${x == sel ? 'selected' : ''}>${fn ? fn(x) : esc(x)}</option>`).join('');

// ------------------------------------------------------------------ orders
const fT = (at) => new Date(at).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' });
const STI = { placed: 0, confirmed: 1, dispatched: 2, received: 3 };
const stL = (o) => { const x = t('sts'), d = o.dm == 'self'; return ({ placed: x.placed, confirmed: x.confirmed, dispatched: d ? x.dispS : x.dispD, received: d ? x.recS : x.recD, declined: x.declined, cancelled: x.cancelled })[o.st] || o.st; };
const canSell = (o) => !!S.user && o.sl == S.user.id, canBuy = (o) => !!S.user && o.b == S.user.id;
const lnk = 'display:flex;align-items:center;justify-content:center;text-decoration:none';
const callB = (ph, waNum) => `<a class="btn out" style="${lnk}" href="tel:+${ph}">📞 ${t('call')} ${showPh(ph)}</a>${waNum ? `<a class="btn out wa" style="${lnk}" href="https://wa.me/${waNum}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}`;
const SG = (o) => ({ placed: 'pending', confirmed: 'confirmed', dispatched: 'confirmed', received: 'completed', declined: 'cancelled', cancelled: 'cancelled' })[o.st] || 'pending';
const OF = ['all', 'pending', 'confirmed', 'completed', 'cancelled'];
const fOrders = (l) => l.filter((o) => S.of == 'all' || SG(o) == S.of);
const ofChips = (l) => `<div class="chips" role="group">${OF.map((k) => `<button class="chip" aria-pressed="${S.of == k}" data-a="ofilt" data-v="${k}">${k == 'all' ? t('all') : t('sg')[k]} (${k == 'all' ? l.length : l.filter((o) => SG(o) == k).length})</button>`).join('')}</div>`;
const sActs = (o) => {
  if (!canSell(o)) return '';
  if (o.st == 'placed') return `<label class="f" for="ot-${o.id}">${t('o_tot')}</label><input type="number" id="ot-${o.id}" min="1" max="10000000" inputmode="numeric" value="${o.t}"><label class="f" for="od-${o.id}">${t('o_dt')}</label><input type="text" id="od-${o.id}" maxlength="200"><p class="mut">${t('o_hint')}</p><button class="btn" data-a="oact" data-x="confirm" data-id="${o.id}">${t('o_cf')}</button><button class="btn out" data-a="oact" data-x="decline" data-id="${o.id}">${t('o_dc')}</button>`;
  if (o.st == 'confirmed') return `<button class="btn" data-a="oact" data-x="dispatch" data-id="${o.id}">${o.dm == 'self' ? t('o_rd') : t('o_dp')}</button><button class="btn" data-a="oact" data-x="complete" data-id="${o.id}">${t('o_mc')}</button><button class="btn out" data-a="oact" data-x="decline" data-id="${o.id}">${t('o_cn')}</button>`;
  if (o.st == 'dispatched') return `<button class="btn" data-a="oact" data-x="complete" data-id="${o.id}">${t('o_mc')}</button>`;
  return '';
};
const bActs = (o) => {
  if (!canBuy(o)) return '';
  if (o.st == 'placed' || o.st == 'confirmed') return `<button class="btn out" data-a="oact" data-x="cancel" data-id="${o.id}">${t('o_cn')}</button>`;
  if (o.st == 'dispatched') return `<button class="btn" data-a="oact" data-x="receive" data-id="${o.id}">${o.dm == 'self' ? t('o_cl') : t('o_rv')}</button>`;
  return '';
};
const orderCard = (o, v) => {
  const idx = STI[o.st], lg = o.log || [], last = lg[lg.length - 1], g = SG(o);
  const lines = (o.items || []).map((i) => `<div class="mut">• ${esc(i.n)} × ${i.q}${i.p ? ' · ' + KES(i.p) + '/' + esc(i.u || '') : ''}</div>`).join('');
  const bu = `${t('o_buyer')}: <b>${esc(o.bn)}</b>${o.bp ? ' · 📞 ' + showPh(o.bp) : ''}`;
  const who = v == 's' ? bu : v == 'a' ? `${bu}<br>${t('o_seller')}: <b>${esc(o.sn)}</b>${VF.badge(o.sl)}` : `${t('o_seller')}: ${esc(o.sn)}${VF.badge(o.sl)}`;
  let ct = '';
  if ((v == 's' || v == 'a') && o.bp) ct = callB(o.bp, o.bp);
  else if (v == 'b' && o.ct && g != 'cancelled') ct = `<button class="btn out" data-a="ocontact" data-id="${o.id}">📞 ${t('contact')}</button>`;
  const adm = v == 'a' ? `<label class="f" for="as-${o.id}">${t('o_as')}</label><select id="as-${o.id}">${OF.slice(1).map((k) => `<option value="${k}" ${g == k ? 'selected' : ''}>${t('sg')[k]}</option>`).join('')}</select><button class="btn out" data-a="oadm" data-id="${o.id}">${t('o_au')}</button>` : '';
  return `<div class="card"><div class="tr" style="padding-top:0"><b>${esc(o.id)}</b><span>${KES(o.ct || o.t)}</span></div><div><span class="bd ${g}">${t('sg')[g]}</span><span class="pn">${stL(o)}</span></div><div class="mut">${who}</div>${lines}${RD.orderLine(o) ? `<div class="mut">${t('o_sub')} ${KES(o.sub || 0)}</div>${RD.orderLine(o)}${o.a ? `<div class="mut">📍 ${esc(o.a)}</div>` : ''}` : `<div class="mut">${t('o_sub')} ${KES(o.sub || 0)} · ${t('dlv')} ${KES(o.fee || 0)}</div><div class="mut">${DEL[o.dm] ? DEL[o.dm][0] : ''}${o.a ? ' · 📍 ' + esc(o.a) : ''}</div>`}${lg[0] ? `<div class="mut">${t('o_date')}: ${fT(lg[0].at)}</div>` : ''}${idx != null ? `<div class="steps" aria-hidden="true">${[0, 1, 2, 3].map((i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}</div>` : ''}${last && last !== lg[0] ? `<div class="mut">↻ ${fT(last.at)}</div>` : ''}${o.ct ? `<div class="mut">${t('o_conf')}: ${KES(o.ct)}${o.ct != o.t ? ` (${t('o_est')}: ${KES(o.t)})` : ''}</div><div class="mut">${t('o_det')}: ${esc(o.cd)}</div>` : ''}${ct}${o.ct && idx >= 1 ? `<div class="note">${t('o_pn')}</div>` : ''}${v == 's' ? sActs(o) : v == 'b' ? bActs(o) : adm}${RD.orderBlock(o, v)}${v == 'a' ? '' : `<button class="lk" data-a="odlg" data-id="${o.id}" data-r="${v}">${(o.disp || []).some((d) => d.by == v) ? t('o_dop') : t('o_rep')}</button>`}<details><summary>${t('o_hist')}</summary>${lg.map((e) => `<div class="tl">${fT(e.at)} · ${t('evt')[e.s == 'received' && e.by == 's' ? 'recS2' : e.s] || e.s} · ${t('o_by')[e.by]}${e.t ? ' · ' + KES(e.t) : ''}${e.to ? ' → ' + t('sg')[SG({ st: e.to })] : ''}</div>`).join('')}</details></div>`;
};

// ------------------------------------------------------------------ views
function sellGate() {
  const m = me(); if (m && m.role == 'seller') return '';
  if (m && m.role == 'rider') return `<h2>${t('sellH')}</h2><div class="card gate"><div class="em" aria-hidden="true">🛵</div><p>${t('rFree')}</p><button class="btn" data-a="tab" data-v="rides">${t('rOpenDash')}</button></div>`;
  if (!m) return `<h2>${t('sellH')}</h2><div class="card gate"><div class="em" aria-hidden="true">🔒</div><p>${t('gateS')}</p><button class="btn" data-a="goauth" data-v="login" data-n="sell">${t('login')}</button><button class="btn out" data-a="goauth" data-v="signup" data-n="sell" data-r="seller">${t('signup')}</button></div>`;
  return `<h2>${t('sellH')}</h2><div class="card gate"><div class="em" aria-hidden="true">🧺</div><p>${t('gateB')}</p><button class="btn" data-a="acct">${t('become')}</button></div>`;
}
const V = {
  shop: () => `<input type="search" placeholder="${t('search')}" value="${esc(S.q)}" data-m="q" data-r="fill" aria-label="${t('search')}"><select data-m="cty" data-r="fill" aria-label="${t('county')}">${opts(COUNTIES, S.cty, (c) => (c == 'All' ? t('all') : esc(c)))}</select><div class="chips" role="group">${CATS.map((c) => `<button class="chip" aria-pressed="${c == S.cat}" data-a="cat" data-v="${c}">${t(c)}</button>`).join('')}</div><div id="ptop"></div><div class="grid" id="list"></div>`,
  prices: () => `<h2>${t('pricesH')}</h2><div class="card">${PRICES.map((r) => `<div class="tr"><div><div class="pn">${r[0]}</div><div class="mut">${r[1]}</div></div><div style="text-align:right"><div class="pn">${KES(r[2])}</div><div class="${r[3] >= 0 ? 'up' : 'dn'}">${r[3] > 0 ? '▲' : r[3] < 0 ? '▼' : '●'} ${Math.abs(r[3])}%</div></div></div>`).join('')}</div><div class="note">${t('pricesN')}</div>`,
  doctor: () => { const d = DOC[S.crop]; return `<h2>${t('docH')}</h2><p class="mut">${t('docP')}</p><div class="chips" role="group">${Object.keys(DOC).map((k) => `<button class="chip" aria-pressed="${k == S.crop}" data-a="crop" data-v="${esc(k)}">${k}</button>`).join('')}</div>${d.map((s, i) => `<button class="opt" aria-pressed="${S.sym === i}" data-a="sym" data-v="${i}">${s[0]}</button>`).join('')}${S.sym !== null ? `<div class="card"><div class="pn">${d[S.sym][1]}</div><p>${d[S.sym][2]}</p><button class="btn" data-a="find">${t('find')}</button></div>` : ''}<div class="note" role="note">⚠ ${t('docS')}</div>`; },
  sell: () => { const g = sellGate(); if (g) return g; const f = S.f; return `<h2>${t('sellH')}</h2><label class="f" for="sn">${t('iname')}</label><input type="text" id="sn" maxlength="40" value="${esc(f.n)}" data-m="f.n"><div class="row"><div><label class="f" for="sc">${t('category')}</label><select id="sc" data-m="f.c" data-r="render">${opts(CATS.slice(1), f.c, (c) => t(c))}</select></div><div><label class="f" for="sy">${t('county')}</label><select id="sy" data-m="f.y">${opts(COUNTIES.slice(1), f.y)}</select></div></div><div class="row"><div><label class="f" for="sp">${t('price')}</label><input type="number" id="sp" inputmode="numeric" min="1" max="1000000" value="${esc(f.p)}" data-m="f.p"></div><div><label class="f" for="su">${t('unit')}</label><input type="text" id="su" maxlength="15" value="${esc(f.u)}" data-m="f.u"></div></div>${f.c == 'input' ? `<label class="ck"><input type="checkbox" data-m="f.ok" ${f.ok ? 'checked' : ''}><span>${t('agro')}</span></label>` : ''}${photoCard()}<div class="card"><label class="f" for="sv">🎥 ${t('vh')}</label><input type="file" id="sv" accept="video/mp4,video/webm,video/quicktime" data-a-change="pv"><video id="vp" controls playsinline ${f.file ? `src="${f.file}"` : ''} style="width:100%;border-radius:10px;display:${f.file ? 'block' : 'none'}"></video></div>${RD.sellCard(f)}<button class="btn out" data-a="preview">${t('prev')}</button><button class="btn sun" data-a="list" ${S.busy ? 'disabled' : ''}>${S.busy ? '…' : t('publish')}</button><div class="note">${t('sellN')}</div>`; },
  cart: () => {
    if (me() && !S.phone) S.phone = showPh(me().phone);
    const c = calc(); let h = `<h2>${t('cart')}</h2>`;
    if (!c.it.length) h += `<p class="mut">${t('empty')}</p>`;
    else {
      h += Object.keys(c.g).map((s) => `<div class="card"><div class="pn">${esc(c.g[s][0][0].s)}${VF.badge(s)}</div>${c.g[s].map(([p, n]) => `<div class="tr"><div><div class="pn"><span aria-hidden="true">${p.e}</span> ${esc(p.n)}</div><div class="mut">${KES(p.p)} / ${esc(p.u)}</div></div><div class="qty"><button data-a="chg" data-id="${p.id}" data-d="-1" aria-label="−">−</button><span>${n}</span><button data-a="chg" data-id="${p.id}" data-d="1" aria-label="+">+</button></div></div>`).join('')}${RD.cartChoice(s, c.g[s])}</div>`).join('') +
        `<div class="card"><div class="tr"><b>${t('tot')}</b><b>${KES(c.sub)}</b></div><div class="mut">${t('dFeeN')}</div></div><p class="mut">${t('sepR')}</p>
 <label class="f" for="ad">${t('dAddr')}</label><input type="text" id="ad" maxlength="120" autocomplete="street-address" value="${esc(S.addr)}" data-m="addr"><label class="f" for="ph">${t('phone')}</label><input type="tel" id="ph" inputmode="tel" autocomplete="tel" maxlength="16" value="${esc(S.phone)}" data-m="phone"><label class="ck"><input type="checkbox" data-m="agree" ${S.agree ? 'checked' : ''}><span>${t('agree')} <button class="lk" data-a="info" style="display:inline">${t('info')}</button></span></label>${me() ? '' : `<p class="mut">🔒 ${t('payLogin')}</p>`}${RD.isRider() ? `<p class="mut">${t('rNoOrder')}</p>` : ''}<button class="btn" data-a="pay" ${S.busy || !RD.cartReady(c.g) ? 'disabled' : ''}>${t('pay')} · ${KES(c.sub)}</button><div class="note">${t('escrow')}</div><div class="note">${t('o_dev')}</div>`;
    }
    const mo = S.orders.filter((o) => S.user && o.b == S.user.id);
    if (mo.length) h += `<h2 style="margin-top:18px">${t('ord')}</h2>` + mo.map((o) => orderCard(o, 'b')).join('');
    return h;
  },
  orders: () => { const m = me(), mine = S.orders.filter((o) => o.sl == m.id), l = fOrders(mine); return `<h2>📋 ${t('orders')}</h2><div class="note">${t('o_dn2')}</div>${ofChips(mine)}${l.length ? l.map((o) => orderCard(o, 's')).join('') : `<p class="mut">${mine.length ? t('o_none2') : t('o_none')}</p>`}`; },
  admin: () => {
    const L = S.listings, gm = S.orders.filter((o) => o.st != 'declined' && o.st != 'cancelled').reduce((a, o) => a + (o.ct || o.t), 0);
    const st = [['Live listings', L.filter((p) => !p.hidden).length], ['Hidden listings', L.filter((p) => p.hidden).length], ['Agrochemical listings', L.filter((p) => p.chem && !p.hidden).length], ['Orders', S.orders.length], ['Order value (not payments)', KES(gm)], ['Open reports', S.reports.length], ['Accounts', S.accounts.length], ['Seller accounts', S.accounts.filter((a) => a.role == 'seller').length]];
    return `<h2>Admin dashboard</h2><div class="grid">${st.map((s) => `<div class="card"><div class="mut">${s[0]}</div><div class="price" style="font-size:22px">${s[1]}</div></div>`).join('')}</div>
<h2 style="margin-top:18px">Reports</h2>${S.reports.length ? S.reports.map((r) => `<div class="card"><div class="pn">${esc(r.name)}</div><div class="mut">${r.kind} report${r.why ? ' · ' + esc(r.why) : ''} · ${fT(r.created_at)}</div>${r.kind == 'photo' ? `<img src="${esc(mediaUrl(r.photo))}" alt="Reported photo" class="thm"><button class="btn" data-a="rph" data-id="${r.id}">Remove photo</button>` : ''}${r.kind != 'order' ? `<button class="btn" data-a="rhide" data-id="${r.id}">Hide listing</button>` : ''}<button class="btn out" data-a="rdis" data-id="${r.id}">Dismiss</button></div>`).join('') : '<p class="mut">No open reports.</p>'}
<h2 style="margin-top:18px">All listings</h2><div class="card">${L.length ? L.map((p) => `<div class="tr"><div><div class="pn"><span aria-hidden="true">${p.e}</span> ${esc(p.n)}</div><div class="mut">${esc(p.s)} · ${esc(p.y)} · ${KES(p.p)}${p.chem ? ' · ⚠ agrochemical' : ''}${p.ph.length ? ' · 📷 ' + p.ph.length : ''}${p.hidden ? ' · hidden' : ''}</div></div><button class="chip" data-a="${p.hidden ? 'unhide' : 'hide'}" data-id="${p.id}">${p.hidden ? 'Unhide' : 'Hide'}</button></div>`).join('') : '<p class="mut">No listings yet.</p>'}</div>
<h2 style="margin-top:18px">Accounts</h2>${S.accounts.length ? `<div class="card">${S.accounts.map((a) => `<div class="tr"><div><div class="pn">${esc(a.name)} <span class="badge">${a.role}</span></div><div class="mut">${maskPh(a.phone)} · ${esc(a.county)}${a.biz ? ' · ' + esc(a.biz) : ''}</div></div></div>`).join('')}</div>` : '<p class="mut">No accounts yet.</p>'}
${VF.adminSection()}${GR.adminSection()}${RD.adminSection()}
<h2 style="margin-top:18px">Orders (${S.orders.length})</h2>${ofChips(S.orders)}${(() => { const l = fOrders(S.orders); return l.length ? l.map((o) => orderCard(o, 'a')).join('') : `<p class="mut">${t('o_none2')}</p>`; })()}
<button class="btn out" data-a="tab" data-v="shop">← Back to shop</button>`;
  },
  account: () => {
    const m = me(), f = S.af;
    if (!m) {
      const su = S.am == 'signup', pt = S.spw ? 'text' : 'password';
      return `<h2>${su ? t('signup') : t('login')}</h2><div class="card" id="authf">${su ? `<div class="mut" style="margin-bottom:6px">${t('iam')}</div>${['buyer', 'seller', 'rider'].map((r) => `<button class="opt" aria-pressed="${f.role == r}" data-a="role" data-v="${r}">${t(r == 'buyer' ? 'roleB' : r == 'seller' ? 'roleS' : 'roleR')}</button>`).join('')}<label class="f" for="an">${t('fname')}</label><input type="text" id="an" maxlength="40" autocomplete="name" value="${esc(f.name)}" data-m="af.name">${f.role == 'seller' ? `<label class="f" for="ab">${t('biz')}</label><input type="text" id="ab" maxlength="40" autocomplete="organization" value="${esc(f.biz)}" data-m="af.biz">` : ''}<label class="f" for="ay">${t('county')}</label><select id="ay" data-m="af.y">${opts(COUNTIES.slice(1), f.y)}</select>` : ''}<label class="f" for="ap">${t('lphone')}</label><input type="tel" id="ap" inputmode="tel" autocomplete="tel" maxlength="16" value="${esc(f.phone)}" data-m="af.phone"><label class="f" for="aw">${su ? t('pw') : t('pwl')}</label><input type="${pt}" id="aw" maxlength="64" autocomplete="${su ? 'new-password' : 'current-password'}" value="${esc(f.pw)}" data-m="af.pw">${su ? `<label class="f" for="aw2">${t('pw2')}</label><input type="${pt}" id="aw2" maxlength="64" autocomplete="new-password" value="${esc(f.pw2)}" data-m="af.pw2">` : ''}<label class="ck"><input type="checkbox" data-a-change="spw" ${S.spw ? 'checked' : ''}><span>${t('show')}</span></label><p class="err" id="aerr" role="alert"></p><button class="btn" data-a="auth" ${S.busy ? 'disabled' : ''}>${S.busy ? '…' : su ? t('signup') : t('login')}</button><button class="lk" data-a="goauth" data-v="${su ? 'login' : 'signup'}">${su ? t('haveacc') : t('noacc')}</button>${su ? '' : `<br><button class="lk" data-a="forgot">${t('forgot')}</button>`}</div><div class="note">${t('accN')}</div>`;
    }
    const mine = S.listings.filter((p) => p.owner == m.id), so = S.orders.filter((o) => o.sl == m.id), bo = S.orders.filter((o) => o.b == m.id);
    return `<h2>${t('acct')}</h2><div class="card"><div class="pn">${esc(m.name)}${VF.badge(m.id)} <span class="badge">${t(m.role)}</span>${isAdmin() ? ` <span class="badge">${t('admin')}</span>` : ''}</div>${m.biz ? `<div class="mut">🏪 ${esc(m.biz)}</div>` : ''}<div class="mut">📞 ${showPh(m.phone)}</div><div class="mut">📍 ${esc(m.county)}</div><div class="mut">${t('since')} ${new Date(m.created_at).toLocaleDateString('en-KE')}</div></div>${isAdmin() ? `<button class="btn sun" data-a="admin">🛡️ ${t('adminD')}</button>` : ''}` +
      (m.role == 'rider' ? `${VF.notesCard()}${RD.accountCard()}` : m.role == 'buyer' ? `${VF.notesCard()}<div class="card"><div class="pn">${t('become')}</div><p class="mut">${t('becomeN')}</p><label class="f" for="ab">${t('biz')}</label><input type="text" id="ab" maxlength="40" autocomplete="organization" value="${esc(f.biz)}" data-m="af.biz"><button class="btn sun" data-a="become">${t('become')}</button></div>` :
        `${VF.notesCard()}${GR.accountButton()}${VF.accountCard()}${VF.waCard()}<h2 style="margin-top:18px">${t('myl')}</h2><div class="card">${mine.length ? mine.map((p) => `<div class="tr"><div><div class="pn"><span aria-hidden="true">${p.e}</span> ${esc(p.n)}</div><div class="mut">${KES(p.p)} / ${esc(p.u)}${p.hidden ? ' · ' + t('hid') : ''}</div>${RD.listingChips(p)}</div><button class="chip" data-a="rml" data-id="${p.id}">${t('prm')}</button></div>`).join('') : `<p class="mut">${t('nol')}</p>`}<button class="btn" data-a="tab" data-v="sell">➕ ${t('sellH')}</button></div><h2 style="margin-top:18px">${t('soldH')}</h2><button class="btn out" data-a="tab" data-v="orders">📋 ${t('orders')} (${so.length})</button>`) +
      `<h2 style="margin-top:18px">${t('ord')}</h2>${bo.length ? `<button class="btn out" data-a="tab" data-v="cart">${t('ord')} (${bo.length}) →</button>` : `<p class="mut">${t('noord')}</p>`}<button class="btn out" data-a="logout" style="margin-top:14px">${t('logout')}</button><button class="lk" data-a="delacc">${t('del')}</button><div class="note">${t('accN')}</div>`;
  },
};

const fTx = (at) => fT(at);
const dlgOpen = (h) => { $('#dc').innerHTML = h; if (!$('#dlg').open) $('#dlg').showModal(); };
const findL = (id) => S.listings.find((x) => x.id == id);
const ofind = (id) => S.orders.find((o) => o.id == id);

async function afterSignIn() {
  await refreshAll();
  const a = me(); if (!a) return;
  S.of = 'all'; S.af = blankAf(a.county); S.spw = false; S.phone = showPh(a.phone); S.f.y = a.county;
  toast(t('welcome') + a.name.split(' ')[0]);
  S.tab = S.after || 'shop'; S.after = null;
  if (S.pend) { const pp = findL(S.pend); if (pp && !isSeller() && pp.owner != a.id) { S.cart[S.pend] = Math.min(99, (S.cart[S.pend] || 0) + 1); save(); } S.pend = null; }
  render(); scrollTo(0, 0);
}
async function rpc(fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) { toast(errMsg(error)); return { error }; }
  return { data };
}
async function guarded(fn) { if (S.busy) return; S.busy = true; try { await fn(); } catch (e) { toast(errMsg(e)); } finally { S.busy = false; } }

// ------------------------------------------------------------------ verification (optional blue tick)
const VF = createVerify({ S, t, esc, KES, sb, toast, dlgOpen, rpc, guarded, errMsg, opts, COUNTIES, showPh, rid, normPh, V, fT: fTx, render: () => render() });

// ------------------------------------------------------------------ actions
const A = {
  tab: (d) => { S.pend = null; if (d.v == 'cart' && !me()) return needLogin('cart'); if (d.v == 'orders') S.of = 'all'; S.tab = d.v; render(); scrollTo(0, 0); if (['cart', 'orders', 'admin', 'account', 'grow', 'rides'].includes(d.v)) reloadOrders(); },
  cat: (d) => { S.cat = d.v; render(); },
  add: (d) => {
    const pp = findL(d.id); if (!pp || pp.hidden) return toast(t('pvonly'));
    if (S.user && pp.owner == S.user.id) return toast(t('own'));
    if (!me()) { S.pend = pp.id; return needLogin('shop'); }
    if (isSeller()) return toast(t('o_sno'));
    S.cart[pp.id] = Math.min(99, (S.cart[pp.id] || 0) + 1); toast(t('added')); save(); chrome();
  },
  chg: (d) => { const n = (S.cart[d.id] || 0) + +d.d; if (n <= 0) delete S.cart[d.id]; else S.cart[d.id] = Math.min(99, n); save(); render(); },
  dm: (d) => { S.dm = d.v; render(); },
  crop: (d) => { S.crop = d.v; S.sym = null; render(); },
  sym: (d) => { S.sym = +d.v; render(); },
  find: () => { const s = DOC[S.crop][S.sym]; S.cat = s[3]; S.q = s[4]; S.cty = 'All'; S.tab = 'shop'; render(); scrollTo(0, 0); },
  lang: () => { S.lang = S.lang == 'en' ? 'sw' : 'en'; save(); render(); },
  info: () => dlgOpen(LEGAL),
  close: () => $('#dlg').close(),
  report: (d) => guarded(async () => {
    if (d.id == '-1') return toast(t('pvonly'));
    if (!me()) return needLogin('shop', 'needLoginR');
    const r = await rpc('report_listing', { p_listing: +d.id, p_why: '' }); if (!r.error) toast(t('reped'));
  }),
  admin: () => { S.tab = 'admin'; render(); scrollTo(0, 0); reloadOrders(); },
  rdis: (d) => guarded(async () => { if (!(await rpc('admin_dismiss_report', { p_report: +d.id })).error) { await loadAdmin(); render(); } }),
  rhide: (d) => guarded(async () => { const r = S.reports.find((x) => x.id == d.id); if (!r) return; if ((await rpc('admin_set_hidden', { p_listing: +r.ref, p_hidden: true })).error) return; await rpc('admin_dismiss_report', { p_report: r.id }); await Promise.all([loadListings(), loadAdmin()]); render(); }),
  hide: (d) => guarded(async () => { if (!(await rpc('admin_set_hidden', { p_listing: +d.id, p_hidden: true })).error) { await loadListings(); render(); } }),
  unhide: (d) => guarded(async () => { if (!(await rpc('admin_set_hidden', { p_listing: +d.id, p_hidden: false })).error) { await loadListings(); render(); } }),
  rph: (d) => guarded(async () => { const r = await rpc('admin_remove_photo', { p_report: +d.id }); if (r.error) return; if (r.data) await sb.storage.from(BUCKET).remove([r.data]); await Promise.all([loadListings(), loadAdmin()]); render(); }),
  video: (d) => { const p = +d.id == -1 ? draft() : findL(d.id); if (p && p.vu) dlgOpen(`<h2>${esc(p.n)}</h2><video src="${esc(p.vu)}" controls playsinline></video>${p.id == -1 ? '' : `<button class="btn" data-a="add" data-id="${p.id}">${t('add')}</button>`}`); },
  pv: (el) => {
    const f = el.files[0], v = $('#vp'); if (S.f.file) URL.revokeObjectURL(S.f.file); S.f.file = null; S.f.fileObj = null; v.style.display = 'none';
    if (!f) return; if (!VIDEO_EXT[f.type] || f.size > 20 * 1048576) { el.value = ''; toast(t('bv')); return; }
    S.f.file = URL.createObjectURL(f); S.f.fileObj = f; v.src = S.f.file; v.style.display = 'block';
  },
  list: () => guarded(async () => {
    if (!me()) return needLogin('sell'); if (!isSeller()) return toast(t('needSeller'));
    const f = S.f, n = f.n.trim(), p = Number(f.p), u = f.u.trim() || 'unit';
    if (n.length < 2 || n.length > 40) return toast(t('bn')); if (!(p >= 1 && p <= 1000000)) return toast(t('bp')); if (f.c == 'input' && !f.ok) return toast(t('ba'));
    if (f.sr === false && f.br === false) return toast(t('dNeed'));
    render();
    const uid = S.user.id, uploaded = [];
    const up = async (path, blob, type) => { const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: type, upsert: false }); if (error) throw error; uploaded.push(path); };
    try {
      const photos = [];
      for (const i of f.imgs) { const path = `${uid}/${rid()}.jpg`; await up(path, i.b, 'image/jpeg'); photos.push({ path, k: i.k, local: i.id }); }
      let video = null;
      if (f.fileObj) { video = `${uid}/${rid()}.${VIDEO_EXT[f.fileObj.type]}`; await up(video, f.fileObj, f.fileObj.type); }
      const cover = (photos.find((x) => x.local == f.cv) || photos[0] || {}).path || null;
      const { error } = await sb.from('listings').insert({ owner: uid, seller_name: '-', name: n, category: f.c, price: Math.round(p), unit: u, county: f.y, photos: photos.map(({ path, k }) => ({ path, k })), cover, video, seller_rider: f.sr !== false, buyer_rider: f.br !== false });
      if (error) throw error;
    } catch (e) {
      if (uploaded.length) await sb.storage.from(BUCKET).remove(uploaded);
      toast(errMsg(e)); S.busy = false; render(); return;
    }
    f.imgs.forEach((i) => URL.revokeObjectURL(i.u)); if (f.file) URL.revokeObjectURL(f.file);
    S.f = { n: '', c: 'produce', y: f.y, p: '', u: '', ok: false, file: null, fileObj: null, imgs: [], cv: '' };
    S.cat = 'all'; S.q = ''; S.cty = 'All'; S.tab = 'shop';
    await loadListings(); toast(t('listed')); S.busy = false; render(); scrollTo(0, 0);
  }),
  pay: () => guarded(async () => {
    if (!me()) return needLogin('cart');
    const c = calc(), ph = normPh(S.phone); if (!c.it.length) return;
    if (!ph) return toast(t('badph')); if (S.addr.trim().length < 5) return toast(t('badaddr')); if (!RD.cartReady(c.g)) return toast(t('dChoose')); if (!S.agree) return toast(t('badag'));
    const r = await rpc('place_orders_v2', { p_items: c.it.map(([p, q]) => ({ id: p.id, q })), p_delivery: Object.fromEntries(Object.keys(c.g).map((sid) => [sid, S.dch[sid]])), p_address: S.addr.trim(), p_phone: ph });
    if (r.error) { await loadListings(); render(); return; }
    S.cart = {}; save(); await loadOrders(); toast(t('placed')); S.busy = false; render();
  }),
  imgs: async (el) => {
    const fs = [...el.files]; el.value = ''; let bad = 0;
    for (const f of fs) {
      if (S.f.imgs.length >= MAXN) { toast(t('pmax')); break; }
      if (f.size > MAXB) { bad++; continue; }
      try { if (!(await sniff(f))) { bad++; continue; } const b = await shrink(f), id = 'ph' + rid(); S.f.imgs.push({ id, b, u: URL.createObjectURL(b), k: 'product' }); if (!S.f.cv) S.f.cv = id; } catch (e) { bad++; }
    }
    if (bad) toast(t('pbad')); render();
  },
  cover: (d) => { S.f.cv = d.id; render(); },
  ptype: (el) => { const i = S.f.imgs.find((x) => x.id == el.dataset.id); if (i) i.k = el.value; },
  prm: (d) => { const i = S.f.imgs.find((x) => x.id == d.id); if (i) URL.revokeObjectURL(i.u); S.f.imgs = S.f.imgs.filter((x) => x.id != d.id); if (S.f.cv == d.id) S.f.cv = S.f.imgs[0] ? S.f.imgs[0].id : ''; render(); },
  preview: () => dlgOpen(`<h2>${t('pvh')}</h2><div class="grid" style="grid-template-columns:1fr">${cardHtml(draft())}</div><p class="mut">${t('pvn')}</p>`),
  photos: (d) => { const p = +d.id == -1 ? draft() : findL(d.id); if (!p || !(p.prev || p.ph || []).length) return; S.gal = { id: +d.id, i: 0 }; dlgOpen(gal(p, 0)); },
  gal: (d) => { const p = S.gal.id == -1 ? draft() : findL(S.gal.id); if (p) { S.gal.i = +d.i; $('#dc').innerHTML = gal(p, +d.i); } },
  rphoto: (d) => guarded(async () => {
    const p = findL(S.gal.id), c = p && p.ph && p.ph[+d.i]; if (!c) return;
    if (!me()) { $('#dlg').close(); return needLogin('shop', 'needLoginR'); }
    const r = await rpc('report_listing', { p_listing: p.id, p_why: TX.en.rs[+$('#rr').value], p_photo: c.id });
    if (!r.error) { $('#dlg').close(); toast(t('reped')); }
  }),
  ofilt: (d) => { S.of = d.v; render(); },
  oact: (d) => guarded(async () => {
    const o = ofind(d.id); if (!o) return; const args = { p_id: o.id, p_action: d.x };
    if (d.x == 'confirm') {
      const tt = Math.round(Number($('#ot-' + o.id).value)), det = $('#od-' + o.id).value.trim();
      if (!(tt >= 1 && tt <= 10000000)) return toast(t('o_etot')); if (det.length < 5) return toast(t('o_edet'));
      args.p_total = tt; args.p_details = det;
    }
    if (!(await rpc('order_action', args)).error) { await loadOrders(); toast(t('o_done')); S.busy = false; render(); }
  }),
  oadm: (d) => guarded(async () => {
    if (!isAdmin()) return toast(t('noAdmin'));
    const m = { pending: 'placed', confirmed: 'confirmed', completed: 'received', cancelled: 'cancelled' }[$('#as-' + d.id).value];
    if (!(await rpc('admin_set_order_status', { p_id: d.id, p_status: m })).error) { await loadOrders(); toast(t('o_done')); S.busy = false; render(); }
  }),
  odlg: (d) => { const o = ofind(d.id), v = d.r; if (!o || (v == 'b' ? !canBuy(o) : !canSell(o))) return; dlgOpen(`<h2>${t('o_dh')}</h2><div class="mut">${esc(o.id)}</div><label class="f" for="dr">${t('o_dw')}</label><select id="dr">${t(v == 'b' ? 'o_rb' : 'o_rs').map((x, i) => `<option value="${i}">${x}</option>`).join('')}</select><label class="f" for="dn">${t('o_dn')}</label><input type="text" id="dn" maxlength="200"><button class="btn" data-a="odsub" data-id="${esc(o.id)}" data-r="${v}">${t('o_ds')}</button>`); },
  odsub: (d) => guarded(async () => {
    const v = d.r, why = TX.en[v == 'b' ? 'o_rb' : 'o_rs'][+$('#dr').value] || 'Other', note = $('#dn').value.trim().slice(0, 200);
    if (!(await rpc('order_dispute', { p_id: d.id, p_why: why, p_note: note })).error) { $('#dlg').close(); toast(t('o_dsent')); await loadOrders(); S.busy = false; render(); }
  }),
  ocontact: (d) => guarded(async () => {
    const o = ofind(d.id); if (!o) return;
    const it = (o.items || [])[0]; const r = it ? await sb.rpc('seller_contact', { p_listing: it.id }) : { data: null };
    dlgOpen(`<h2>${t('ctH')}</h2><div class="pn">${esc(o.sn)}</div>${r.data ? callB(r.data.phone) : `<p class="mut">${t('o_nocontact')}</p>`}${VF.waBtn(o.sl)}<div class="note">${t('ctTip')}</div>`);
  }),
  sinfo: (d) => { const p = findL(d.id); if (!p) return; const n = all().filter((x) => x.owner == p.owner).length; dlgOpen(`<h2>${esc(p.s)}${VF.badge(p.owner)}</h2><div class="mut">📍 ${esc(p.y)} · ${n} ${t(n == 1 ? 'sListing' : 'sListings')}</div>${VF.badge(p.owner) ? `<p class="mut">${t('vBadge')}</p>` : ''}<button class="btn" data-a="contact" data-id="${p.id}">📞 ${t('contact')}</button>${VF.waBtn(p.owner, p.n, '')}<button class="btn out" data-a="sshop" data-id="${p.id}">${t('sSee')}</button>`); },
  sshop: (d) => { const p = findL(d.id); if (!p) return; $('#dlg').close(); S.q = p.s; S.cat = 'all'; S.cty = 'All'; S.tab = 'shop'; render(); scrollTo(0, 0); },
  acct: () => { S.tab = 'account'; if (!me()) S.am = 'login'; render(); scrollTo(0, 0); },
  goauth: (d) => { S.am = d.v; if (d.n) S.after = d.n; if (d.r) S.af.role = d.r; S.tab = 'account'; render(); scrollTo(0, 0); },
  role: (d) => { S.af.role = d.v; render(); },
  spw: (el) => { S.spw = el.checked; render(); },
  forgot: () => dlgOpen(`<h2>${t('forgot')}</h2><p>${t('forgotN')}</p>`),
  auth: async () => {
    if (S.busy) return;
    const f = S.af, su = S.am == 'signup', er = (m) => { const e = $('#aerr'); if (e) e.textContent = m; toast(m); };
    const ph = normPh(f.phone);
    if (su) {
      const n = f.name.trim().replace(/\s+/g, ' '), b = f.biz.trim();
      if (n.length < 2 || n.length > 40) return er(t('eName'));
      if (f.role == 'seller' && b.length < 2) return er(t('eBiz'));
      if (!ph) return er(t('badph'));
      if (f.pw.length < 8) return er(t('ePw'));
      if (f.pw !== f.pw2) return er(t('ePw2'));
      S.busy = true; render();
      const { data, error } = await sb.auth.signUp({ email: phoneEmail(ph), password: f.pw, options: { data: { name: n, role: f.role, biz: f.role == 'seller' ? b : '', phone: ph, county: f.y } } });
      S.busy = false;
      if (error || !data.session) { render(); return er(error ? errMsg(error) : t('eErr')); }
    } else {
      if (!ph || !f.pw) return er(t('eBad'));
      S.busy = true; render();
      const { error } = await sb.auth.signInWithPassword({ email: phoneEmail(ph), password: f.pw });
      S.busy = false;
      if (error) { render(); return er(errMsg(error)); }
    }
    await afterSignIn();
  },
  logout: async () => { await sb.auth.signOut(); S.user = null; S.profile = null; S.admin = false; S.orders = []; S.phone = ''; S.am = 'login'; S.af = blankAf(); S.tab = 'shop'; toast(t('bye')); render(); scrollTo(0, 0); },
  become: () => guarded(async () => {
    const b = S.af.biz.trim(); if (!me()) return needLogin('account'); if (b.length < 2) return toast(t('eBiz'));
    if ((await rpc('become_seller', { p_biz: b })).error) return;
    S.af.biz = ''; await loadProfile(); S.cart = {}; save(); toast(t('nowSeller')); S.busy = false; render();
  }),
  rml: (d) => guarded(async () => {
    const p = findL(d.id); if (!p || !S.user || p.owner != S.user.id) return;
    const { error } = await sb.from('listings').delete().eq('id', p.id); if (error) return toast(errMsg(error));
    const files = [...p.ph.map((x) => x.id), p.video].filter(Boolean); if (files.length) await sb.storage.from(BUCKET).remove(files);
    delete S.cart[p.id]; save(); await loadListings(); S.busy = false; render();
  }),
  delacc: () => dlgOpen(`<h2>${t('del')}</h2><p>${t('delq')}</p><button class="btn" style="background:var(--red)" data-a="delok">${t('del')}</button>`),
  delok: () => guarded(async () => {
    if (!S.user) return;
    const mine = S.listings.filter((p) => p.owner == S.user.id), files = mine.flatMap((p) => [...p.ph.map((x) => x.id), p.video]).filter(Boolean);
    if (files.length) await sb.storage.from(BUCKET).remove(files);
    // Verification records and photos are kept for their retention period and deleted automatically afterwards.
    if ((await rpc('withdraw_my_verifications', {})).error) return;
    if ((await rpc('delete_my_account', {})).error) return;
    await sb.auth.signOut().catch(() => {});
    S.user = null; S.profile = null; S.admin = false; S.orders = []; S.cart = {}; save(); S.phone = '';
    $('#dlg').close(); S.tab = 'shop'; await loadListings(); toast(t('deleted')); S.busy = false; render(); scrollTo(0, 0);
  }),
  contact: (d) => guarded(async () => {
    const p = findL(d.id); if (!p) return;
    if (!me()) return needLogin('shop', 'needLoginC');
    if (p.owner == S.user.id) return toast(t('own'));
    const r = await sb.rpc('seller_contact', { p_listing: p.id }); const c = r.data;
    dlgOpen(`<h2>${t('ctH')}</h2><div class="pn">${esc(p.s)}${VF.badge(p.owner)}</div><div class="mut">${esc(p.n)} · 📍 ${esc(p.y)}</div>${c ? `<a class="btn" style="${lnk}" href="tel:+${c.phone}">📞 ${t('call')} ${showPh(c.phone)}</a>` : `<p class="mut">${t('ctNone')}</p>`}${VF.waBtn(p.owner, p.n, '')}<div class="note">${t('ctTip')}</div>`);
  }),
};
V.verify = () => VF.view();
Object.assign(A, VF.actions);
// ------------------------------------------------------------------ grow your business (optional paid promotions)
const GR = createGrow({ S, t, esc, KES, sb, toast, rpc, guarded, VF, V, fT: fTx, render: () => render() });
V.grow = () => GR.view();
Object.assign(A, GR.actions);
// ------------------------------------------------------------------ riders and deliveries
const RD = createRiders({ S, t, esc, KES, sb, toast, rpc, guarded, errMsg, VF, V, opts, COUNTIES, dlgOpen, fT: fTx, render: () => render() });
V.rides = () => RD.dash();
Object.assign(A, RD.actions);
['admin', 'rdis', 'rhide', 'hide', 'unhide', 'rph'].forEach((k) => { const f = A[k]; A[k] = (...a) => (isAdmin() ? f(...a) : toast(t('noAdmin'))); });

async function reloadOrders() {
  const a = document.activeElement;
  await Promise.all([loadOrders(), loadAdmin(), VF.loadMine(), GR.loadMine(), GR.loadAdmin(), RD.loadMine(), RD.loadAdmin()]);
  if (['orders', 'account', 'cart', 'admin', 'grow', 'rides'].includes(S.tab) && !(a && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) && !$('#dlg').open) render(); else chrome();
}

document.addEventListener('keydown', (e) => { const el = e.target; if (e.key == 'Enter' && el.tagName == 'INPUT' && el.type != 'checkbox' && el.closest('#authf')) { e.preventDefault(); A.auth(); } });
document.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b && A[b.dataset.a]) A[b.dataset.a](b.dataset); if (e.target == $('#dlg')) $('#dlg').close(); });
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.aChange) { A[el.dataset.aChange](el); return; }
  if (!el.dataset.m) return;
  const k = el.dataset.m.split('.'), o = k.slice(0, -1).reduce((x, y) => x[y], S); o[k[k.length - 1]] = el.type == 'checkbox' ? el.checked : el.value;
  if (el.dataset.r == 'fill') fill(); else if (el.dataset.r == 'render') render();
  else if (el.dataset.r == 'vacc') { const x = $('#vpbacc'); if (x) x.textContent = el.value.trim() || S.vset.accRule; } // M-Pesa account = seller's full name
});
$('#dlg').addEventListener('close', () => { const v = $('#dc video'); if (v) v.pause(); });

// Live order updates for buyers and sellers.
let channel = null;
function subscribe() {
  if (channel) { sb.removeChannel(channel); channel = null; }
  if (!S.user) return;
  channel = sb.channel('orders-' + S.user.id).on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => reloadOrders()).on('postgres_changes', { event: '*', schema: 'public', table: 'deliveries' }, () => reloadOrders()).subscribe();
}
sb.auth.onAuthStateChange((ev) => { if (ev == 'SIGNED_IN' || ev == 'SIGNED_OUT') setTimeout(subscribe, 0); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { Promise.all([loadListings(), VF.loadVerified(), GR.loadPublic()]).then(() => { if (S.tab == 'shop') fill(); }); if (S.user) reloadOrders(); } });

render();
refreshAll().then(() => { if (S.profile) { S.phone = showPh(S.profile.phone); S.f.y = S.profile.county; } subscribe(); render(); });
