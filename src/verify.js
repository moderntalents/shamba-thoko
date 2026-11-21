// Optional Verified Seller feature: application form with live camera photos, seller status,
// admin review, and the blue tick. All rules are enforced in the database; this file is the UI.
const VBUCKET = 'verification-photos';
export const SLOTS = ['face_front', 'face_side', 'products', 'with_products'];
const SLOT_CAM = { face_front: 'user', face_side: 'user', products: 'environment', with_products: 'environment' };
const VST = ['pending', 'info_requested', 'approved', 'rejected', 'suspended', 'revoked'];

export function createVerify(c) {
  const { S, t, esc, KES, sb, toast, dlgOpen, rpc, guarded, errMsg, opts, COUNTIES, showPh, rid } = c;
  const fD = (d) => new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmt = (s, d) => s.replace('{d}', d).replace('{f}', KES(S.vset.fee));
  S.verified = new Map(); S.vset = { fee: 500, months: 12, info: '' }; S.myv = null; S.vapps = []; S.vfilt = 'pending'; S.vurls = {};
  const blankVf = () => ({ legal: '', phone: '', idType: 'national_id', idNo: '', biz: '', y: 'Kiambu', loc: '', prod: '', ph: {}, pay: 'mpesa', code: '', consent: false });
  S.vf = blankVf();

  // ------------------------------------------------------------ data
  async function loadVerified() {
    const [v, st] = await Promise.all([sb.rpc('verified_sellers'), sb.from('app_settings').select('key,value')]);
    if (!v.error) S.verified = new Map(v.data.map((r) => [r.seller, r.expires_at]));
    if (!st.error) for (const r of st.data) {
      if (r.key == 'verification_fee') S.vset.fee = Number(r.value);
      if (r.key == 'verification_months') S.vset.months = Number(r.value);
      if (r.key == 'verification_payment_info') S.vset.info = String(r.value);
    }
  }
  async function loadMine() {
    S.myv = null; if (!S.user || !S.profile || S.profile.role != 'seller') return;
    const { data } = await sb.from('seller_verifications').select('*').eq('seller', S.user.id).order('created_at', { ascending: false }).limit(1);
    S.myv = data && data[0] ? data[0] : null;
  }
  async function loadApps() {
    S.vapps = []; if (!S.admin) return;
    const { data, error } = await sb.from('seller_verifications').select('*').order('created_at', { ascending: false }).limit(300);
    if (!error) S.vapps = data;
  }
  async function signed(paths) {
    const need = paths.filter((p) => p && !S.vurls[p]); if (!need.length) return;
    const { data } = await sb.storage.from(VBUCKET).createSignedUrls(need, 3600);
    (data || []).forEach((r) => { if (r.signedUrl) S.vurls[r.path] = r.signedUrl; });
  }
  const effSt = (v) => (!v ? 'none' : v.status == 'approved' && v.expires_at && new Date(v.expires_at) < new Date() ? 'expired' : v.status);

  // ------------------------------------------------------------ badge
  const badge = (uid) => (uid && S.verified.has(uid) ? ` <button class="vb" data-a="vinfo" data-id="${esc(uid)}" aria-label="${t('vBadge')}" title="${t('vBadge')}">✓</button>` : '');

  // ------------------------------------------------------------ camera (live capture only, no gallery)
  let stream = null, cam = { slot: null, facing: 'user' };
  const stopCam = () => { if (stream) stream.getTracks().forEach((x) => x.stop()); stream = null; };
  async function startCam() {
    stopCam(); const v = document.getElementById('vcam'), e = document.getElementById('vcamerr'); if (!v) return;
    e.textContent = '';
    if (!window.isSecureContext) { e.textContent = t('vCamHttps'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { e.textContent = t('vCamNone'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: cam.facing }, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
      if (!document.getElementById('vcam')) { stopCam(); return; }
      v.srcObject = stream; await v.play().catch(() => {});
      document.getElementById('vcapbtn').disabled = false;
    } catch (err) {
      e.textContent = err && err.name == 'NotAllowedError' ? t('vCamDenied') : err && (err.name == 'NotFoundError' || err.name == 'OverconstrainedError') ? t('vCamNone') : t('vCamErr');
    }
  }
  function capture() {
    const v = document.getElementById('vcam'); if (!v || !stream || !v.videoWidth) return;
    const s = Math.min(1, 1280 / Math.max(v.videoWidth, v.videoHeight)), cv = document.createElement('canvas');
    cv.width = Math.round(v.videoWidth * s); cv.height = Math.round(v.videoHeight * s);
    cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height);
    cv.toBlob((b) => {
      if (!b) return toast(t('vCamErr'));
      const old = S.vf.ph[cam.slot]; if (old) URL.revokeObjectURL(old.u);
      S.vf.ph[cam.slot] = { b, u: URL.createObjectURL(b), at: Date.now() };
      stopCam(); document.getElementById('dlg').close(); c.render();
    }, 'image/jpeg', 0.85);
  }
  document.getElementById('dlg').addEventListener('close', stopCam);

  // ------------------------------------------------------------ views
  function payBlock(withChoice) {
    const f = S.vf;
    return `<div class="card"><div class="pn">💳 ${t('vPay')}</div><div class="tr"><span class="mut">${t('vPayFee')}</span><b>${KES(S.vset.fee)}</b></div>${S.vset.info ? `<p class="mut">${esc(S.vset.info)}</p>` : ''}${withChoice ? `<div class="mut" style="margin:6px 0">${t('vPayHow')}</div>${['mpesa', 'manual', 'later'].map((k) => `<button class="opt" aria-pressed="${f.pay == k}" data-a="vpay" data-v="${k}">${t(k == 'mpesa' ? 'vPayMpesa' : k == 'manual' ? 'vPayManual' : 'vPayLater')}</button>`).join('')}` : ''}${f.pay == 'mpesa' ? `<label class="f" for="vcode">${t('vCode')}</label><input type="text" id="vcode" maxlength="12" autocapitalize="characters" value="${esc(f.code)}" data-m="vf.code">` : ''}<div class="note">${t('vPayNote')}</div></div>`;
  }
  function form() {
    const f = S.vf, upd = S.myv && S.myv.status == 'info_requested';
    return `<h2>✓ ${t('vH')}</h2><p class="mut">${t('vIntro')}</p>${upd && S.myv.admin_note ? `<div class="note"><b>${t('vAdminNote')}:</b> ${esc(S.myv.admin_note)}</div>` : ''}
<div class="card"><label class="f" for="vl">${t('vLegal')}</label><input type="text" id="vl" maxlength="80" autocomplete="name" value="${esc(f.legal)}" data-m="vf.legal">
<label class="f" for="vp">${t('vPhone')}</label><input type="tel" id="vp" inputmode="tel" maxlength="16" value="${esc(f.phone)}" data-m="vf.phone">
<div class="row"><div><label class="f" for="vit">${t('vIdType')}</label><select id="vit" data-m="vf.idType">${Object.entries(t('vIdTypes')).map(([k, l]) => `<option value="${k}" ${f.idType == k ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div><label class="f" for="vin">${t('vIdNo')}</label><input type="text" id="vin" maxlength="12" autocomplete="off" value="${esc(f.idNo)}" data-m="vf.idNo"></div></div>
<label class="f" for="vb">${t('vBiz')}</label><input type="text" id="vb" maxlength="80" value="${esc(f.biz)}" data-m="vf.biz">
<label class="f" for="vy">${t('county')}</label><select id="vy" data-m="vf.y">${opts(COUNTIES.slice(1), f.y)}</select>
<label class="f" for="vlo">${t('vLoc')}</label><input type="text" id="vlo" maxlength="120" value="${esc(f.loc)}" data-m="vf.loc">
<label class="f" for="vpr">${t('vProd')}</label><input type="text" id="vpr" maxlength="200" value="${esc(f.prod)}" data-m="vf.prod"></div>
<div class="card"><div class="pn">📷 ${t('vPhotos')}</div><p class="mut">${t('vPhotosN')}</p><div class="vgrid">${SLOTS.map((k, i) => { const p = f.ph[k]; return `<div class="vslot">${p ? `<img src="${p.u}" alt="${esc(t('vSlots')[k])}">` : `<div class="vph" aria-hidden="true">${i < 2 ? '🙂' : i == 2 ? '🧺' : '🧑‍🌾'}</div>`}<div class="mut">${i + 1}. ${t('vSlots')[k]}</div><button class="btn ${p ? 'out' : ''}" data-a="vcam" data-v="${k}">📷 ${p ? t('vRetake') : t('vTake')}</button></div>`; }).join('')}</div></div>
${upd && S.myv.payment_status == 'confirmed' ? '' : payBlock(true)}
<label class="ck"><input type="checkbox" data-m="vf.consent" ${f.consent ? 'checked' : ''}><span>${t('vConsent')}</span></label>
<button class="btn sun" data-a="vsubmit" ${S.busy ? 'disabled' : ''}>${S.busy ? '…' : upd ? t('vResubmit') : t('vSubmit')}</button>
<button class="btn out" data-a="tab" data-v="account">← ${t('acct')}</button>`;
  }
  const canApply = () => { const s = effSt(S.myv); return s == 'none' || s == 'rejected' || s == 'revoked' || s == 'expired' || (s == 'approved' && new Date(S.myv.expires_at) - Date.now() < 30 * 864e5); };
  function view() {
    if (!S.profile || S.profile.role != 'seller') { S.tab = 'account'; return c.V.account(); }
    const s = effSt(S.myv);
    if (s == 'info_requested' || canApply()) return form();
    return `<h2>✓ ${t('vH')}</h2>${accountCard()}<button class="btn out" data-a="tab" data-v="account">← ${t('acct')}</button>`;
  }
  // Seller dashboard card in Account.
  function accountCard() {
    const v = S.myv, s = effSt(v);
    if (s == 'none') return `<div class="card"><div class="pn">✓ ${t('vGet')}</div><p class="mut">${fmt(t('vGetN'))}</p><button class="btn sun" data-a="vstart">✓ ${t('vGet')} · ${KES(S.vset.fee)}</button></div>`;
    const expSoon = s == 'approved' && new Date(v.expires_at) - Date.now() < 30 * 864e5;
    return `<div class="card"><div class="pn">${t('vStatus')}: <span class="bd ${s == 'approved' ? 'completed' : s == 'pending' || s == 'info_requested' ? 'pending' : 'cancelled'}">${t('vSt')[s]}</span>${s == 'approved' ? badge(S.user.id) : ''}</div>
${v.expires_at && (s == 'approved' || s == 'expired' || s == 'suspended') ? `<div class="mut">${fmt(t('vValid'), fD(v.expires_at))}</div>` : ''}
${s == 'pending' || s == 'info_requested' ? `<div class="mut">${t('vPayFee')}: ${KES(v.fee)} · ${t('vPaySt')[v.payment_status]}</div>` : ''}
${v.admin_note && s != 'approved' ? `<div class="note"><b>${t('vAdminNote')}:</b> ${esc(v.admin_note)}</div>` : ''}
${s == 'suspended' ? `<p class="mut">${t('vSuspN')}</p>` : ''}
${s == 'pending' && v.payment_status != 'confirmed' && v.payment_status != 'submitted' ? payBlock(false) + `<button class="btn" data-a="vaddpay">${t('vAddPay')}</button>` : ''}
${s == 'info_requested' ? `<button class="btn sun" data-a="vstart">${t('vUpdate')}</button>` : ''}
${s == 'rejected' || s == 'revoked' || s == 'expired' || expSoon ? `<p class="mut">${t('vRenewN')}</p><button class="btn sun" data-a="vstart">✓ ${s == 'rejected' ? t('vGet') : t('vRenew')} · ${KES(S.vset.fee)}</button>` : ''}</div>`;
  }
  // Admin dashboard section.
  function adminSection() {
    const L = S.vapps, cnt = (k) => L.filter((v) => effSt(v) == k).length;
    const list = L.filter((v) => S.vfilt == 'all' || effSt(v) == S.vfilt);
    const sellerName = (v) => { const a = S.accounts.find((x) => x.id == v.seller); return a ? a.name : ''; };
    return `<h2 style="margin-top:18px">Seller verification</h2>
<div class="card"><div class="pn">Settings</div><div class="row"><div><label class="f" for="vsfee">Fee (KSh)</label><input type="number" id="vsfee" min="0" max="100000" value="${S.vset.fee}"></div><div><label class="f" for="vsmon">Valid for (months)</label><input type="number" id="vsmon" min="1" max="36" value="${S.vset.months}"></div></div><label class="f" for="vsinfo">Payment instructions shown to sellers</label><input type="text" id="vsinfo" maxlength="500" value="${esc(S.vset.info)}"><button class="btn out" data-a="vsettings">Save settings</button></div>
<div class="chips" role="group">${['pending', 'info_requested', 'approved', 'expired', 'suspended', 'rejected', 'revoked', 'all'].map((k) => `<button class="chip" aria-pressed="${S.vfilt == k}" data-a="vfilt" data-v="${k}">${k == 'all' ? 'All' : t('vSt')[k]} (${k == 'all' ? L.length : cnt(k)})</button>`).join('')}</div>
${list.length ? list.map((v) => { const s = effSt(v); return `<div class="card"><div class="tr" style="padding-top:0"><b>${esc(v.legal_name)}</b><span class="bd ${s == 'approved' ? 'completed' : s == 'pending' || s == 'info_requested' ? 'pending' : 'cancelled'}">${t('vSt')[s]}</span></div>
<div class="mut">Account: ${esc(sellerName(v))} · Applied ${c.fT(v.created_at)}</div>
<div class="mut">📞 ${showPh(v.phone)} · ${t('vIdTypes')[v.id_type]} <b>${esc(v.id_number)}</b></div>
<div class="mut">🏪 ${esc(v.business_name)} · 📍 ${esc(v.location)}, ${esc(v.county)}</div>
<div class="mut">🧺 ${esc(v.products)}</div>
<div class="mut">Consent given ${c.fT(v.consent_at)}</div>
<div class="vgrid">${SLOTS.map((k) => { const u = S.vurls[v.photos[k]]; return `<div class="vslot">${u ? `<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="${esc(t('vSlots')[k])}"></a>` : `<button class="btn out" data-a="vphotos" data-id="${v.id}">Show photos</button>`}<div class="mut">${t('vSlots')[k]}</div></div>`; }).join('')}</div>
<div class="note">💳 ${KES(v.fee)} · <b>${t('vPaySt')[v.payment_status]}</b>${v.payment_method ? ' · ' + (v.payment_method == 'mpesa' ? 'M-Pesa' : 'Manual') : ''}${v.mpesa_code ? ' · code <b>' + esc(v.mpesa_code) + '</b>' : ''}${v.payment_confirmed_at ? ' · confirmed ' + c.fT(v.payment_confirmed_at) : ''}</div>
${v.expires_at ? `<div class="mut">Approved ${v.approved_at ? c.fT(v.approved_at) : ''} · Expires ${fD(v.expires_at)}</div>` : ''}
${v.admin_note ? `<div class="mut">Last note: ${esc(v.admin_note)}</div>` : ''}
${adminActs(v, s)}
<details><summary>History</summary>${(v.history || []).map((h) => `<div class="tl">${c.fT(h.at)} · ${esc(h.s)} · ${esc(h.by)}${h.note ? ' · ' + esc(h.note) : ''}</div>`).join('')}</details></div>`; }).join('') : '<p class="mut">No applications here.</p>'}`;
  }
  function adminActs(v, s) {
    const b = (a, l, cls = 'out') => `<button class="btn ${cls}" data-a="vadm" data-x="${a}" data-id="${v.id}">${l}</button>`;
    let h = '';
    if (s == 'pending' || s == 'info_requested') {
      if (v.payment_status != 'confirmed') h += b('confirm_payment', 'Confirm payment received', '') + b('reject_payment', 'Payment not received');
      if (s == 'pending') h += b('approve', v.payment_status == 'confirmed' ? '✓ Approve and give blue tick' : 'Approve (confirm payment first)', 'sun');
      h += b('request_info', 'Request more information') + b('reject', 'Reject application');
    } else if (s == 'approved') h += b('suspend', 'Suspend') + b('revoke', 'Revoke');
    else if (s == 'suspended') h += b('reinstate', 'Reinstate', '') + b('revoke', 'Revoke');
    return h ? `<label class="f" for="vn-${v.id}">Note to seller (needed for reject, request info, suspend, revoke)</label><input type="text" id="vn-${v.id}" maxlength="300">${h}` : '';
  }

  // ------------------------------------------------------------ actions
  const fillFromProfile = () => {
    const m = S.profile, prev = S.myv, f = blankVf();
    f.phone = showPh(m.phone); f.biz = m.biz || ''; f.y = m.county; f.legal = m.name;
    if (prev) { f.legal = prev.legal_name; f.phone = showPh(prev.phone); f.idType = prev.id_type; f.idNo = prev.id_number; f.biz = prev.business_name; f.y = prev.county; f.loc = prev.location; f.prod = prev.products; }
    return f;
  };
  async function uploadPhotos() {
    const uid = S.user.id, out = {}, done = [];
    try {
      for (const k of SLOTS) {
        const path = `${uid}/${k}-${rid()}.jpg`;
        const { error } = await sb.storage.from(VBUCKET).upload(path, S.vf.ph[k].b, { contentType: 'image/jpeg', upsert: false });
        if (error) throw error; out[k] = path; done.push(path);
      }
    } catch (e) { if (done.length) await sb.storage.from(VBUCKET).remove(done); throw e; }
    return { out, done };
  }
  const A = {
    vinfo: (d) => { const exp = S.verified.get(d.id); dlgOpen(`<h2><span class="vb" aria-hidden="true">✓</span> ${t('vBadgeH')}</h2><p>${fmt(t('vBadgeP'), exp ? fD(exp) : '')}</p><div class="note">${t('vBadgeN')}</div>`); },
    vstart: () => { S.vf = fillFromProfile(); S.tab = 'verify'; c.render(); scrollTo(0, 0); },
    vpay: (d) => { S.vf.pay = d.v; c.render(); },
    vcam: (d) => {
      cam = { slot: d.v, facing: SLOT_CAM[d.v] };
      dlgOpen(`<h2>📷 ${t('vSlots')[d.v]}</h2><video id="vcam" class="vcam ${cam.facing == 'user' ? 'mirror' : ''}" autoplay playsinline muted></video><p class="err" id="vcamerr" role="alert"></p><button class="btn sun" id="vcapbtn" data-a="vcapture" disabled>📸 ${t('vCapture')}</button><button class="btn out" data-a="vswitch">🔄 ${t('vSwitch')}</button>`);
      startCam();
    },
    vswitch: () => { cam.facing = cam.facing == 'user' ? 'environment' : 'user'; const v = document.getElementById('vcam'); if (v) v.classList.toggle('mirror', cam.facing == 'user'); startCam(); },
    vcapture: () => capture(),
    vsubmit: () => guarded(async () => {
      const f = S.vf, upd = S.myv && S.myv.status == 'info_requested';
      if ([f.legal, f.phone, f.biz, f.loc, f.prod].some((x) => !String(x).trim()) || f.legal.trim().length < 3 || f.loc.trim().length < 3 || f.prod.trim().length < 3) return toast(t('vNeed'));
      if (!c.normPh(f.phone)) return toast(t('badph'));
      if (!/^[A-Za-z0-9]{5,12}$/.test(f.idNo.trim())) return toast(t('vBadId'));
      if (SLOTS.some((k) => !f.ph[k])) return toast(t('vNeedPh'));
      const needPay = !(upd && S.myv.payment_status == 'confirmed');
      if (needPay && f.pay == 'mpesa' && !/^[A-Z0-9]{8,12}$/.test(f.code.trim().toUpperCase())) return toast(t('vCodeBad'));
      if (!f.consent) return toast(t('vNeedConsent'));
      c.render();
      let up;
      try { up = await uploadPhotos(); } catch (e) { toast(errMsg(e)); S.busy = false; c.render(); return; }
      const p = { legal_name: f.legal.trim(), phone: c.normPh(f.phone), id_type: f.idType, id_number: f.idNo.trim(), business_name: f.biz.trim(), county: f.y, location: f.loc.trim(), products: f.prod.trim(), photos: up.out, consent: true };
      if (needPay && f.pay != 'later') { p.payment_method = f.pay; if (f.pay == 'mpesa') p.mpesa_code = f.code.trim().toUpperCase(); }
      const r = upd ? await rpc('update_verification', { p_id: S.myv.id, p }) : await rpc('submit_verification', { p });
      if (r.error) { await sb.storage.from(VBUCKET).remove(up.done); S.busy = false; c.render(); return; }
      Object.values(f.ph).forEach((x) => URL.revokeObjectURL(x.u)); S.vf = blankVf();
      await loadMine(); toast(t('vSent')); S.busy = false; S.tab = 'account'; c.render(); scrollTo(0, 0);
    }),
    vaddpay: () => guarded(async () => {
      const f = S.vf; if (f.pay == 'mpesa' && !/^[A-Z0-9]{8,12}$/.test(f.code.trim().toUpperCase())) return toast(t('vCodeBad'));
      const p = { payment_method: f.pay == 'later' ? 'manual' : f.pay }; if (f.pay == 'mpesa') p.mpesa_code = f.code.trim().toUpperCase();
      if (!(await rpc('update_verification', { p_id: S.myv.id, p })).error) { await loadMine(); toast(t('vPaySent')); S.busy = false; c.render(); }
    }),
    vfilt: (d) => { S.vfilt = d.v; c.render(); },
    vphotos: () => guarded(async () => { await signed(S.vapps.flatMap((v) => SLOTS.map((k) => v.photos[k]))); S.busy = false; c.render(); }),
    vadm: (d) => guarded(async () => {
      const note = (document.getElementById('vn-' + d.id) || {}).value || '';
      if (!(await rpc('admin_verification_action', { p_id: +d.id, p_action: d.x, p_note: note.trim() })).error) { await Promise.all([loadApps(), loadVerified()]); toast(t('o_done')); S.busy = false; c.render(); }
    }),
    vsettings: () => guarded(async () => {
      const fee = Math.round(Number(document.getElementById('vsfee').value)), mon = Math.round(Number(document.getElementById('vsmon').value)), info = document.getElementById('vsinfo').value.trim();
      if (!(await rpc('admin_set_verification_settings', { p_fee: fee, p_months: mon, p_payment_info: info })).error) { await loadVerified(); toast(t('o_done')); S.busy = false; c.render(); }
    }),
  };
  // Admin-only actions are also blocked here (and always by the database).
  ['vfilt', 'vphotos', 'vadm', 'vsettings'].forEach((k) => { const f = A[k]; A[k] = (...a) => (S.admin ? f(...a) : toast(t('noAdmin'))); });

  return { loadVerified, loadMine, loadApps, badge, view, accountCard, adminSection, actions: A, stopCam };
}
