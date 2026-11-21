// Riders: rider dashboard, per-listing delivery options, rider requests on orders and admin rider management.
// All rules (who may request, which status changes are allowed, when phones are shared) are enforced in the database.
const OPEN = ['requested', 'accepted', 'collected', 'in_transit'];
const VEH = ['motorbike', 'bicycle', 'tuktuk', 'car', 'pickup', 'truck', 'other'];

export function createRiders(c) {
  const { S, t, esc, sb, toast, rpc, guarded, VF, opts, COUNTIES, dlgOpen } = c;
  S.rider = null; S.dels = []; S.radm = []; S.rf = null; S.dch = {}; S.rq = null;
  const isRider = () => !!(S.profile && S.profile.role == 'rider');
  const tel = (p) => (p ? '0' + String(p).slice(3) : '');

  // ------------------------------------------------------------ data
  async function loadMine() {
    S.dels = []; S.rider = null;
    if (!S.user) return;
    const [d, r] = await Promise.all([
      sb.from('deliveries').select('*').order('created_at', { ascending: false }).limit(300),
      isRider() ? sb.from('riders').select('*').eq('id', S.user.id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    if (!d.error) S.dels = d.data || [];
    S.rider = r.data || null;
    if (S.rider && !S.rf) S.rf = { v: S.rider.vehicle, d: S.rider.vehicle_details, b: S.rider.base_location, a: [...S.rider.areas] };
  }
  async function loadAdmin() {
    S.radm = []; if (!S.admin) return;
    const { data } = await sb.from('riders').select('*').order('updated_at', { ascending: false }).limit(500);
    S.radm = data || [];
  }

  // ------------------------------------------------------------ delivery card (rider, order parties, admin)
  const stBd = (s) => `<span class="bd ${s == 'delivered' ? 'completed' : OPEN.includes(s) ? (s == 'requested' ? 'pending' : 'confirmed') : 'cancelled'}">${t('dSt')[s]}</span>`;
  function delCard(d, v) {
    const me = S.user && S.user.id, b = (a, cls = 'out') => `<button class="btn ${cls}" data-a="dact" data-x="${a}" data-id="${d.id}">${t('dAct')[a]}</button>`;
    let acts = '';
    if (v == 'r' && d.rider == me) {
      if (d.status == 'requested') acts = b('accept', 'sun') + b('decline');
      else if (d.status == 'accepted') acts = b('collect', 'sun') + b('in_transit') + b('cancel');
      else if (d.status == 'collected') acts = b('in_transit', 'sun') + b('deliver');
      else if (d.status == 'in_transit') acts = b('deliver', 'sun');
    } else if (v == 'p') {
      const req = d.requested_by == 'buyer' ? d.buyer : d.seller;
      if (req == me && ['requested', 'accepted'].includes(d.status)) acts = b('cancel');
    } else if (v == 'a' && OPEN.includes(d.status)) {
      acts = `<label class="f" for="dn-${d.id}">Reason (needed to cancel)</label><input type="text" id="dn-${d.id}" maxlength="200"><button class="btn out" data-a="dact" data-x="cancel" data-id="${d.id}">Cancel delivery</button>`;
    }
    const contacts = ['accepted', 'collected', 'in_transit', 'delivered'].includes(d.status) || v == 'a' ? `<button class="btn out" data-a="dcon" data-id="${d.id}">${t('dContacts')}</button>` : '';
    return `<div class="card dl"><div class="tr" style="padding-top:0"><b>🛵 ${esc(d.order_id)}</b>${stBd(d.status)}</div>
<div class="mut">${t('dRider')}: <b>${esc(d.rider_name)}</b>${VF.badge(d.rider)} · ${t('dBy')}: ${t('dRole')[d.requested_by]}</div>
${v != 'p' ? `<div class="mut">📍 ${t('dPick')}: ${esc(d.pickup)} → ${t('dDrop')}: ${esc(d.dropoff)}</div><div class="mut">${t('dItems')}: ${esc(d.items)}</div>` : ''}${d.note ? `<div class="mut">“${esc(d.note)}”</div>` : ''}
${contacts}${acts}<details><summary>${t('o_hist')}</summary>${(d.history || []).map((h) => `<div class="tl">${c.fT(h.at)} · ${t('dSt')[h.s] || h.s} · ${t('dRole')[h.by] || h.by}${h.note ? ' · ' + esc(h.note) : ''}</div>`).join('')}</details></div>`;
  }

  // ------------------------------------------------------------ order card block (buyer / seller views)
  function orderBlock(o, v) {
    if (!['seller_rider', 'buyer_rider'].includes(o.dm) || v == 'a') return '';
    const resp = o.dm == 'seller_rider' ? 's' : 'b', mine = S.dels.filter((d) => d.order_id == o.id), open = mine.some((d) => OPEN.includes(d.status));
    let h = mine.map((d) => delCard(d, 'p')).join('');
    if (v == resp) {
      if (!open && ['confirmed', 'dispatched'].includes(o.st)) h += `<button class="btn sun" data-a="rreq" data-id="${esc(o.id)}">🛵 ${mine.length ? t('dAgain') : t('dReq')}</button>`;
      else if (o.st == 'placed') h += `<div class="mut">${t('dAfterConfirm')}</div>`;
    } else if (!mine.length && !['declined', 'cancelled'].includes(o.st)) h += `<div class="mut">${t('dWaitOther')[resp == 's' ? 'seller' : 'buyer']}</div>`;
    return h;
  }
  const orderLine = (o) => (['seller_rider', 'buyer_rider'].includes(o.dm) ? `<div class="mut"><b>${t('dArranged')[o.dm]}</b></div><div class="mut">${t('dFeeAgree')}</div>` : null);

  // ------------------------------------------------------------ rider dashboard
  function dash() {
    if (!isRider()) { S.tab = 'account'; return c.V.account(); }
    const r = S.rider || {}, f = S.rf || { v: 'motorbike', d: '', b: '', a: [S.profile.county] }, mine = S.dels.filter((d) => d.rider == S.user.id);
    const openD = mine.filter((d) => OPEN.includes(d.status)), past = mine.filter((d) => !OPEN.includes(d.status));
    return `<h2>🛵 ${t('rDash')}</h2>${r.suspended ? `<div class="warn">⚠ ${t('rSuspended')}${r.admin_note ? ' (' + esc(r.admin_note) + ')' : ''}</div>` : ''}
<div class="card"><div class="pn">${esc(S.profile.name)}${VF.badge(S.user.id)}</div><div class="mut">📞 ${tel(S.profile.phone)} · 📍 ${esc(S.profile.county)}</div>
<div class="note">${r.available && !r.suspended ? t('rAvailOn') : t('rAvailOff')}</div>${r.suspended ? '' : `<button class="btn ${r.available ? 'out' : 'sun'}" data-a="ravail" data-v="${r.available ? 0 : 1}">${r.available ? t('rGoOff') : t('rGoOn')}</button>`}</div>
<h2 style="margin-top:18px">${t('rMyDel')}</h2>${openD.length ? openD.map((d) => delCard(d, 'r')).join('') : `<p class="mut">${t('rNoDel')}</p>`}
<div class="card"><div class="pn">${t('rProfile')}</div><label class="f" for="rv">${t('rVehicle')}</label><select id="rv" data-m="rf.v">${VEH.map((k) => `<option value="${k}" ${f.v == k ? 'selected' : ''}>${t('rVehicles')[k]}</option>`).join('')}</select>
<label class="f" for="rd">${t('rDetails')}</label><input type="text" id="rd" maxlength="80" value="${esc(f.d)}" data-m="rf.d">
<label class="f" for="rb">${t('rBase')}</label><input type="text" id="rb" maxlength="120" value="${esc(f.b)}" data-m="rf.b">
<div class="f">${t('rAreas')}</div><div class="chips wrap" role="group">${COUNTIES.slice(1).map((k) => `<button class="chip" aria-pressed="${f.a.includes(k)}" data-a="rarea" data-v="${esc(k)}">${esc(k)}</button>`).join('')}</div>
<button class="btn" data-a="rsave">${t('rSave')}</button><div class="note">${t('rFree')}</div></div>
${VF.accountCard()}
${past.length ? `<details class="card"><summary>${t('o_hist')} (${past.length})</summary>${past.map((d) => delCard(d, 'r')).join('')}</details>` : ''}`;
  }
  const accountCard = () => (isRider() ? `<button class="btn sun" data-a="tab" data-v="rides">${t('rOpenDash')}</button>` : '');

  // ------------------------------------------------------------ listing options (sell form and My listings)
  const sellCard = (f) => `<div class="card"><div class="pn">🛵 ${t('dOpts')}</div><p class="mut">${t('dOptsN')}</p><label class="ck"><input type="checkbox" data-m="f.sr" ${f.sr !== false ? 'checked' : ''}><span>${t('dSeller')}</span></label><label class="ck"><input type="checkbox" data-m="f.br" ${f.br !== false ? 'checked' : ''}><span>${t('dBuyer')}</span></label></div>`;
  const listingChips = (p) => `<div class="chips" role="group" aria-label="${t('dEdit')}"><button class="chip" aria-pressed="${p.sr}" data-a="ldel" data-id="${p.id}" data-v="sr">${t('dShort').seller}</button><button class="chip" aria-pressed="${p.br}" data-a="ldel" data-id="${p.id}" data-v="br">${t('dShort').buyer}</button></div>`;
  const listingTag = (p) => [p.sr && t('dShort').seller, p.br && t('dShort').buyer].filter(Boolean).join(' · ');

  // ------------------------------------------------------------ cart: who arranges the rider, per seller
  function allowed(items) { return { seller: items.every(([p]) => p.sr), buyer: items.every(([p]) => p.br) }; }
  function cartChoice(sid, items) {
    const a = allowed(items);
    if (!a.seller && !a.buyer) { delete S.dch[sid]; return `<div class="warn">⚠ ${t('dMix')}</div>`; }
    if (!a[S.dch[sid]]) S.dch[sid] = a.seller ? 'seller' : 'buyer';
    const o = (k) => `<button class="opt" aria-pressed="${S.dch[sid] == k}" data-a="dch" data-id="${sid}" data-v="${k}"><b>${k == 'seller' ? t('dPickS') : t('dPickB')}</b><div class="mut">${k == 'seller' ? t('dPickSN') : t('dPickBN')}</div></button>`;
    return `<div class="mut" style="margin:6px 0 2px"><b>${t('dHow')}</b></div>${a.seller ? o('seller') : ''}${a.buyer ? o('buyer') : ''}`;
  }
  const cartReady = (g) => Object.keys(g).every((sid) => S.dch[sid] && allowed(g[sid])[S.dch[sid]]);

  // ------------------------------------------------------------ request dialog
  async function openRequest() {
    const q = S.rq, { data, error } = await sb.rpc('available_riders', { p_county: q.county || null });
    if (error) { toast(c.errMsg(error)); return; }
    dlgOpen(`<h2>🛵 ${t('dReqH')}</h2><p class="mut">${t('dReqN')}</p><label class="f" for="rqc">${t('dFilter')}</label><select id="rqc" data-a-change="rcty"><option value="">${t('dAllC')}</option>${opts(COUNTIES.slice(1), q.county)}</select>
<label class="f" for="rqn">${t('dNote')}</label><input type="text" id="rqn" maxlength="200" value="${esc(q.note || '')}">
${(data || []).length ? data.map((r) => `<div class="card"><div class="pn">${esc(r.name)}${r.verified ? `<span class="vb" aria-label="${t('vBadge')}">✓</span>` : ''}</div><div class="mut">${t('rVehicles')[r.vehicle] || esc(r.vehicle)}${r.vehicle_details ? ' · ' + esc(r.vehicle_details) : ''}</div><div class="mut">📍 ${esc(r.county)}${r.base_location ? ' · ' + esc(r.base_location) : ''}</div><div class="mut">${esc((r.areas || []).join(', '))}</div><button class="btn sun" data-a="rpick" data-id="${r.id}">${t('dSend')}</button></div>`).join('') : `<p class="mut">${t('dNone')}</p>`}`);
  }

  // ------------------------------------------------------------ admin
  function adminSection() {
    const acc = (id) => S.accounts.find((a) => a.id == id) || {}, cnt = (id) => S.dels.filter((d) => d.rider == id).length;
    const openD = S.dels.filter((d) => OPEN.includes(d.status)), recent = S.dels.filter((d) => !OPEN.includes(d.status)).slice(0, 20);
    return `<h2 style="margin-top:18px">Riders (${S.radm.length})</h2>
${S.radm.length ? S.radm.map((r) => { const a = acc(r.id); return `<div class="card"><div class="pn">${esc(a.name || 'Rider')}${VF.badge(r.id)} ${r.suspended ? '<span class="bd cancelled">Suspended</span>' : r.available ? '<span class="bd completed">Available</span>' : '<span class="bd">Not available</span>'}</div><div class="mut">📞 ${tel(a.phone)} · 📍 ${esc(a.county || '')} · ${t('rVehicles')[r.vehicle]}${r.vehicle_details ? ' · ' + esc(r.vehicle_details) : ''}</div><div class="mut">Areas: ${esc(r.areas.join(', '))}${r.base_location ? ' · Waits at ' + esc(r.base_location) : ''}</div><div class="mut">Deliveries: ${cnt(r.id)} · Verified: ${VF.badge(r.id) ? 'yes' : 'no (optional, via Seller verification below)'}</div>${r.admin_note ? `<div class="mut">Note: ${esc(r.admin_note)}</div>` : ''}<label class="f" for="rn-${r.id}">Note (needed to suspend)</label><input type="text" id="rn-${r.id}" maxlength="200"><button class="btn out" data-a="radm" data-x="${r.suspended ? 'reinstate' : 'suspend'}" data-id="${r.id}">${r.suspended ? 'Reinstate rider' : 'Suspend rider'}</button></div>`; }).join('') : '<p class="mut">No riders yet.</p>'}
<h2 style="margin-top:18px">Deliveries in progress (${openD.length})</h2>${openD.length ? openD.map((d) => delCard(d, 'a')).join('') : '<p class="mut">None.</p>'}
${recent.length ? `<details class="card"><summary>Recent finished deliveries (${recent.length})</summary>${recent.map((d) => delCard(d, 'a')).join('')}</details>` : ''}`;
  }

  // ------------------------------------------------------------ actions
  const reload = async () => { await Promise.all([loadMine(), loadAdmin()]); };
  const A = {
    ravail: (d) => guarded(async () => { if (!(await rpc('rider_set_available', { p_available: d.v == '1' })).error) await loadMine(); S.busy = false; c.render(); }),
    rarea: (d) => { const a = S.rf.a, i = a.indexOf(d.v); if (i >= 0) a.splice(i, 1); else if (a.length < 10) a.push(d.v); c.render(); },
    rsave: () => guarded(async () => {
      const f = S.rf; if (!f.a.length) { toast(t('rNeedArea')); return; }
      if (!(await rpc('rider_save_profile', { p_vehicle: f.v, p_details: f.d.trim(), p_location: f.b.trim(), p_areas: f.a, p_available: !!(S.rider && S.rider.available) })).error) { await loadMine(); toast(t('rSaved')); }
      S.busy = false; c.render();
    }),
    dch: (d) => { S.dch[d.id] = d.v; c.render(); },
    ldel: (d) => guarded(async () => {
      const p = S.listings.find((x) => x.id == d.id); if (!p) return;
      const sr = d.v == 'sr' ? !p.sr : p.sr, br = d.v == 'br' ? !p.br : p.br;
      if (!sr && !br) { toast(t('dNeed')); return; }
      if (!(await rpc('set_listing_delivery', { p_id: p.id, p_seller: sr, p_buyer: br })).error) { p.sr = sr; p.br = br; toast(t('dSaved')); }
      S.busy = false; c.render();
    }),
    rreq: async (d) => { S.rq = { order: d.id, county: '', note: '' }; await openRequest(); },
    rcty: async (el) => { const n = document.getElementById('rqn'); S.rq.note = n ? n.value : ''; S.rq.county = el.value; await openRequest(); },
    rpick: (d) => guarded(async () => {
      const n = (document.getElementById('rqn') || {}).value || '';
      const r = await rpc('delivery_request', { p_order: S.rq.order, p_rider: d.id, p_note: n.trim() });
      if (!r.error) { document.getElementById('dlg').close(); await loadMine(); toast(t('dSent')); }
      S.busy = false; c.render();
    }),
    dact: (d) => guarded(async () => {
      const note = (document.getElementById('dn-' + d.id) || {}).value || '';
      if (!(await rpc('delivery_action', { p_id: +d.id, p_action: d.x, p_note: note.trim() })).error) { await reload(); toast(t('o_done')); }
      S.busy = false; c.render();
    }),
    dcon: async (d) => {
      const { data, error } = await sb.rpc('delivery_contacts', { p_id: +d.id });
      if (error) { toast(c.errMsg(error)); return; }
      dlgOpen(`<h2>${t('dContactsH')}</h2>${(data || []).map((x) => `<div class="card"><div class="pn">${t('dRole')[x.role]}: ${esc(x.name)}</div><a class="btn" style="text-decoration:none;text-align:center" href="tel:+${esc(x.phone)}">📞 ${t('dCall')} ${tel(x.phone)}</a></div>`).join('')}<div class="note">${t('o_pn')}</div>`);
    },
    radm: (d) => guarded(async () => {
      if (!S.admin) { toast(t('noAdmin')); return; }
      const note = (document.getElementById('rn-' + d.id) || {}).value || '';
      if (!(await rpc('admin_rider_action', { p_rider: d.id, p_action: d.x, p_note: note.trim() })).error) { await reload(); toast(t('o_done')); }
      S.busy = false; c.render();
    }),
  };

  return { loadMine, loadAdmin, dash, accountCard, orderBlock, orderLine, sellCard, listingChips, listingTag, cartChoice, cartReady, adminSection, actions: A, isRider };
}
