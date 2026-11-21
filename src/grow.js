// "Grow your business": optional paid promotions (Featured product, Sponsored advert, Promoted shop)
// plus the existing Verified Seller blue tick. Rules are enforced in the database; this file is the UI.
const OPEN = ['submitted', 'approved', 'payment_submitted'];

export function createGrow(c) {
  const { S, t, esc, KES, sb, toast, rpc, guarded, VF } = c;
  S.psvc = []; S.promos = []; S.myreq = []; S.preq = []; S.prev = null; S.pfilt = 'submitted';
  S.gf = { featured: { listing: '' }, sponsored: { title: '', body: '', listing: '' }, promoted_shop: { body: '' } };
  S.payf = {};
  const fD = (d) => new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });
  const svc = (k) => S.psvc.find((x) => x.key == k);

  // ------------------------------------------------------------ data
  async function loadPublic() {
    const [s, a] = await Promise.all([sb.from('promo_services').select('*'), sb.rpc('active_promotions')]);
    if (!s.error) S.psvc = s.data;
    if (!a.error) S.promos = a.data;
  }
  async function loadMine() {
    S.myreq = []; if (!S.user || !S.profile || S.profile.role != 'seller') return;
    const { data } = await sb.from('promo_requests').select('*').eq('seller', S.user.id).order('created_at', { ascending: false }).limit(50);
    S.myreq = data || [];
  }
  async function loadAdmin() {
    S.preq = []; S.prev = null; if (!S.admin) return;
    const [r, v] = await Promise.all([sb.from('promo_requests').select('*').order('created_at', { ascending: false }).limit(300), sb.rpc('admin_revenue')]);
    if (!r.error) S.preq = r.data; if (!v.error) S.prev = v.data;
  }

  // ------------------------------------------------------------ public display
  const featuredIds = () => new Set(S.promos.filter((p) => p.service == 'featured').map((p) => p.listing_id));
  const isFeatured = (id) => featuredIds().has(id);
  function shopTop() {
    const ads = S.promos.filter((p) => p.service == 'sponsored').sort(() => Math.random() - 0.5); // every paid advert shows on every visit for its whole campaign; order rotates fairly
    const shops = S.promos.filter((p) => p.service == 'promoted_shop');
    return (ads.length ? ads.map((a) => `<div class="card ad"><div class="adl">${t('gSponsored')}</div><div class="pn">${esc(a.title)}</div><p class="mut" style="margin:2px 0">${esc(a.body)}</p><div class="mut">${esc(a.seller_name)}${VF.badge(a.seller)}</div>${a.listing_id ? `<button class="btn out" data-a="gopen" data-id="${a.listing_id}">${t('gView')}</button>` : `<button class="btn out" data-a="gshop" data-v="${esc(a.seller_name)}">${t('sSee')}</button>`}</div>`).join('') : '')
      + (shops.length ? `<div class="pshops"><div class="mut">${t('gPromotedShops')}</div><div class="chips">${shops.map((s) => `<button class="chip" data-a="gshop" data-v="${esc(s.seller_name)}" title="${esc(s.body)}">🏪 ${esc(s.seller_name)}${VF.badge(s.seller) ? ' ✓' : ''}</button>`).join('')}</div></div>` : '');
  }

  // ------------------------------------------------------------ seller: Grow your business
  const stBadge = (s) => `<span class="bd ${s == 'active' ? 'completed' : OPEN.includes(s) ? 'pending' : 'cancelled'}">${t('gSt')[s] || s}</span>`;
  function payBox(r) {
    const f = S.payf[r.id] || (S.payf[r.id] = { name: S.profile ? S.profile.name : '', code: '' });
    return `<div class="pbox"><div class="pn">${t('vPbTitle')}</div><div class="tr"><span class="mut">${t('vPbBiz')}</span><b class="pbnum">${esc(S.vset.paybill)}</b></div><div class="tr"><span class="mut">${t('vPbAcc')}</span><b id="gacc-${r.id}">${esc(f.name || t('gYourName'))}</b></div><div class="tr"><span class="mut">${t('gAmount')}</span><b>${KES(r.price)}</b></div></div>
<label class="f" for="gpn-${r.id}">${t('gPayer')}</label><input type="text" id="gpn-${r.id}" maxlength="80" value="${esc(f.name)}" data-gpay="${r.id}" data-k="name">
<label class="f" for="gpc-${r.id}">${t('vCode')}</label><input type="text" id="gpc-${r.id}" maxlength="12" autocapitalize="characters" value="${esc(f.code)}" data-gpay="${r.id}" data-k="code">
<button class="btn sun" data-a="gpay" data-id="${r.id}">${t('gSendCode')}</button><div class="note">${t('gPayNote')}</div>`;
  }
  function reqCard(r) {
    return `<div class="card"><div class="tr" style="padding-top:0"><b>${esc(t('gSvc')[r.service])}</b>${stBadge(r.status)}</div><div class="pn">${esc(r.title)}</div>${r.body ? `<div class="mut">${esc(r.body)}</div>` : ''}<div class="mut">${KES(r.price)} · ${r.days} ${t('gDays')} · ${c.fT(r.created_at)}</div>
${r.status == 'active' ? `<div class="note">${t('gActiveUntil')} ${fD(r.ends_at)}</div>` : ''}${r.status == 'submitted' ? `<div class="mut">${t('gWaitApproval')}</div>` : ''}${r.status == 'payment_submitted' ? `<div class="mut">${t('gWaitPayment')} (${esc(r.mpesa_code)})</div>` : ''}
${r.admin_note && r.status != 'active' ? `<div class="note"><b>${t('vAdminNote')}:</b> ${esc(r.admin_note)}</div>` : ''}${r.status == 'approved' ? payBox(r) : ''}${['submitted', 'approved'].includes(r.status) ? `<button class="lk" data-a="gcancel" data-id="${r.id}">${t('gCancel')}</button>` : ''}</div>`;
  }
  function view() {
    if (!S.profile || S.profile.role != 'seller') { S.tab = 'account'; return c.V.account(); }
    const mine = S.listings.filter((p) => p.owner == S.user.id && !p.hidden), lo = (sel) => `<option value="">${t('gChoose')}</option>${mine.map((p) => `<option value="${p.id}" ${String(sel) == String(p.id) ? 'selected' : ''}>${esc(p.n)}</option>`).join('')}`;
    const card = (k, inner) => { const s = svc(k); if (!s || !s.active) return ''; return `<div class="card gsv"><div class="pn">${t('gIcon')[k]} ${esc(t('gSvc')[k])}</div><div class="price">${KES(s.price)} <span class="mut">/ ${s.days} ${t('gDays')}</span></div><p class="mut">${t('gDesc')[k]}</p>${inner}</div>`; };
    const f = S.gf;
    const vs = S.myv ? (S.myv.status == 'approved' && new Date(S.myv.expires_at) > new Date() ? 'approved' : S.myv.status) : 'none';
    return `<h2>📈 ${t('gH')}</h2><p class="mut">${t('gIntro')}</p><div class="note">${t('gHow')}</div>
${card('featured', mine.length ? `<label class="f" for="gfl">${t('gListing')}</label><select id="gfl" data-m="gf.featured.listing">${lo(f.featured.listing)}</select><button class="btn" data-a="greq" data-v="featured">${t('gRequest')}</button>` : `<p class="mut">${t('gNeedListing')}</p>`)}
${card('sponsored', `<label class="f" for="gst">${t('gHeadline')}</label><input type="text" id="gst" maxlength="60" value="${esc(f.sponsored.title)}" data-m="gf.sponsored.title"><label class="f" for="gsb">${t('gAdText')}</label><input type="text" id="gsb" maxlength="200" value="${esc(f.sponsored.body)}" data-m="gf.sponsored.body"><label class="f" for="gsl">${t('gAdListing')}</label><select id="gsl" data-m="gf.sponsored.listing">${lo(f.sponsored.listing)}</select><button class="btn" data-a="greq" data-v="sponsored">${t('gRequest')}</button>`)}
${card('promoted_shop', mine.length ? `<label class="f" for="gpb">${t('gTagline')}</label><input type="text" id="gpb" maxlength="120" value="${esc(f.promoted_shop.body)}" data-m="gf.promoted_shop.body"><button class="btn" data-a="greq" data-v="promoted_shop">${t('gRequest')}</button>` : `<p class="mut">${t('gNeedListing')}</p>`)}
<div class="card gsv"><div class="pn"><span class="vb" aria-hidden="true">✓</span> ${t('vBadge')}</div><div class="price">${KES(S.vset.fee)} <span class="mut">/ ${S.vset.months} ${t('gMonths')}</span></div><p class="mut">${t('gDesc').verified}</p>${vs == 'approved' ? `<div class="note">${t('vSt').approved}</div>` : `<button class="btn" data-a="${vs == 'none' ? 'vstart' : 'tab'}" data-v="${vs == 'none' ? '' : 'account'}">${vs == 'none' ? t('vGet') : t('vStatus') + ': ' + (t('vSt')[vs] || vs)}</button>`}</div>
<h2 style="margin-top:18px">${t('gMine')}</h2>${S.myreq.length ? S.myreq.map(reqCard).join('') : `<p class="mut">${t('gNone')}</p>`}
<button class="btn out" data-a="tab" data-v="account">← ${t('acct')}</button>`;
  }
  const accountButton = () => (S.profile && S.profile.role == 'seller' ? `<button class="btn sun" data-a="tab" data-v="grow">📈 ${t('gH')}</button>` : '');

  // ------------------------------------------------------------ admin
  function adminSection() {
    const L = S.preq, stl = ['submitted', 'approved', 'payment_submitted', 'active', 'expired', 'rejected', 'cancelled', 'ended', 'all'];
    const list = L.filter((r) => S.pfilt == 'all' || r.status == S.pfilt), v = S.prev || { by_service: {} };
    const rev = ['featured', 'sponsored', 'promoted_shop', 'verification'].map((k) => { const x = v.by_service[k] || { count: 0, total: 0, month: 0 }; return `<div class="tr"><span>${k == 'verification' ? t('vBadge') : esc(t('gSvc')[k])} (${x.count})</span><span>${KES(x.month)} <span class="mut">this month</span> · <b>${KES(x.total)}</b></span></div>`; }).join('');
    const total = Object.values(v.by_service).reduce((a, x) => a + (x.total || 0), 0), month = Object.values(v.by_service).reduce((a, x) => a + (x.month || 0), 0);
    return `<h2 style="margin-top:18px">Grow your business</h2>
<div class="card"><div class="pn">Revenue (confirmed payments only)</div>${rev}<div class="tr"><b>Total</b><b>${KES(month)} this month · ${KES(total)} all time</b></div><div class="mut">Waiting for payment confirmation: ${v.awaiting_confirmation || 0} · Active promotions: ${v.active_promotions || 0}</div></div>
<div class="card"><div class="pn">Prices</div>${S.psvc.map((s) => `<div class="row" style="align-items:end"><div><label class="f" for="pp-${s.key}">${esc(t('gSvc')[s.key])} (KSh)</label><input type="number" id="pp-${s.key}" min="1" value="${s.price}"></div><div><label class="f" for="pd-${s.key}">Days</label><input type="number" id="pd-${s.key}" min="1" max="365" value="${s.days}"></div><div><label class="ck"><input type="checkbox" id="pa-${s.key}" ${s.active ? 'checked' : ''}><span>On offer</span></label></div></div><button class="btn out" data-a="gprice" data-v="${s.key}">Save ${esc(t('gSvc')[s.key])}</button>`).join('')}<p class="mut">The Verified Seller fee (${KES(S.vset.fee)}) is set in Seller verification → Settings. Price changes apply to new requests only.</p></div>
<div class="chips" role="group">${stl.map((k) => `<button class="chip" aria-pressed="${S.pfilt == k}" data-a="gfilt" data-v="${k}">${k == 'all' ? 'All' : t('gSt')[k]} (${k == 'all' ? L.length : L.filter((r) => r.status == k).length})</button>`).join('')}</div>
${list.length ? list.map((r) => `<div class="card"><div class="tr" style="padding-top:0"><b>${esc(t('gSvc')[r.service])} #${r.id}</b>${stBadge(r.status)}</div><div class="mut">${esc(r.seller_name)}${VF.badge(r.seller)} · ${c.fT(r.created_at)} · ${KES(r.price)} / ${r.days} days</div><div class="pn">${esc(r.title)}</div>${r.body ? `<div class="mut">${esc(r.body)}</div>` : ''}${r.listing_id ? `<button class="lk" data-a="gopen" data-id="${r.listing_id}">Open the listing</button>` : ''}
${r.mpesa_code ? `<div class="mut">Check your M-Pesa statement: Paybill ${esc(S.vset.paybill)}, account <b>${esc(r.payer_name || '')}</b>, ${KES(r.price)}, code <b>${esc(r.mpesa_code)}</b>. Confirm only if the money was received.</div>` : ''}${r.status == 'active' ? `<div class="mut">Active until ${fD(r.ends_at)}</div>` : ''}${r.admin_note ? `<div class="mut">Last note: ${esc(r.admin_note)}</div>` : ''}${acts(r)}
<details><summary>History</summary>${(r.history || []).map((h) => `<div class="tl">${c.fT(h.at)} · ${esc(h.s)} · ${esc(h.by)}${h.note ? ' · ' + esc(h.note) : ''}</div>`).join('')}</details></div>`).join('') : '<p class="mut">No requests here.</p>'}`;
  }
  function acts(r) {
    const b = (a, l, cls = 'out') => `<button class="btn ${cls}" data-a="gadm" data-x="${a}" data-id="${r.id}">${l}</button>`;
    let h = '';
    if (r.status == 'submitted') h = b('approve', '✓ Approve (seller can then pay)', 'sun') + b('reject', 'Reject');
    else if (r.status == 'approved') h = b('reject', 'Reject');
    else if (r.status == 'payment_submitted') h = b('confirm_payment', '✓ Payment received: start promotion', 'sun') + b('reject_payment', 'Payment not received');
    else if (r.status == 'active') h = b('end', 'End promotion early');
    return h ? `<label class="f" for="gn-${r.id}">Note to seller (needed to reject or end)</label><input type="text" id="gn-${r.id}" maxlength="300">${h}` : '';
  }

  // ------------------------------------------------------------ actions
  const A = {
    greq: (d) => guarded(async () => {
      const k = d.v, f = S.gf[k];
      const args = { p_service: k, p_listing: f.listing ? +f.listing : null, p_title: f.title || '', p_body: f.body || '' };
      if (k == 'featured' && !f.listing) { toast(t('gChoose')); S.busy = false; return; }
      if (!(await rpc('promo_request', args)).error) { S.gf[k] = k == 'featured' ? { listing: '' } : k == 'sponsored' ? { title: '', body: '', listing: '' } : { body: '' }; await loadMine(); toast(t('gSent')); }
      S.busy = false; c.render();
    }),
    gpay: (d) => guarded(async () => {
      const f = S.payf[d.id] || {}; const code = String(f.code || '').trim().toUpperCase(), name = String(f.name || '').trim();
      if (!/^[A-Z0-9]{8,12}$/.test(code)) { toast(t('vCodeBad')); S.busy = false; return; }
      if (name.length < 3) { toast(t('gPayerBad')); S.busy = false; return; }
      if (!(await rpc('promo_submit_payment', { p_id: +d.id, p_code: code, p_payer: name })).error) { delete S.payf[d.id]; await loadMine(); toast(t('vPaySent')); }
      S.busy = false; c.render();
    }),
    gcancel: (d) => guarded(async () => { if (!(await rpc('promo_cancel', { p_id: +d.id })).error) await loadMine(); S.busy = false; c.render(); }),
    gopen: (d) => { const p = S.listings.find((x) => x.id == d.id); if (p) { S.q = p.n; S.cat = 'all'; S.cty = 'All'; S.tab = 'shop'; document.getElementById('dlg').open && document.getElementById('dlg').close(); c.render(); scrollTo(0, 0); } },
    gshop: (d) => { S.q = d.v; S.cat = 'all'; S.cty = 'All'; S.tab = 'shop'; c.render(); scrollTo(0, 0); },
    gfilt: (d) => { S.pfilt = d.v; c.render(); },
    gadm: (d) => guarded(async () => {
      const r = S.preq.find((x) => x.id == d.id); if (!r) return;
      const note = (document.getElementById('gn-' + r.id) || {}).value || '';
      const res = await rpc('admin_promo_action', { p_id: r.id, p_action: d.x, p_note: note.trim(), p_seen: r.updated_at });
      await Promise.all([loadAdmin(), loadPublic()]); S.busy = false; c.render(); if (!res.error) toast(t('o_done'));
    }),
    gprice: (d) => guarded(async () => {
      const k = d.v, p = Math.round(Number(document.getElementById('pp-' + k).value)), n = Math.round(Number(document.getElementById('pd-' + k).value)), a = document.getElementById('pa-' + k).checked;
      if (!(await rpc('admin_set_promo_price', { p_service: k, p_price: p, p_days: n, p_active: a })).error) { await loadPublic(); toast(t('o_done')); }
      S.busy = false; c.render();
    }),
  };
  ['gfilt', 'gadm', 'gprice'].forEach((k) => { const f = A[k]; A[k] = (...a) => (S.admin ? f(...a) : toast(t('noAdmin'))); });
  // Payment form fields update without re-rendering (keeps the keyboard open); the account line follows the payer's name.
  document.addEventListener('input', (e) => {
    const el = e.target; if (!el.dataset || !el.dataset.gpay) return;
    const f = S.payf[el.dataset.gpay] || (S.payf[el.dataset.gpay] = { name: '', code: '' }); f[el.dataset.k] = el.value;
    if (el.dataset.k == 'name') { const x = document.getElementById('gacc-' + el.dataset.gpay); if (x) x.textContent = el.value.trim() || t('gYourName'); }
  });

  return { loadPublic, loadMine, loadAdmin, isFeatured, shopTop, view, accountButton, adminSection, actions: A };
}
