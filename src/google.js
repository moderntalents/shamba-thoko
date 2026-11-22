// Google sign-in / sign-up (Supabase Auth OAuth) alongside phone-number accounts.
// New Google users finish their profile (name, phone, county, role) before using the app.
// Existing phone users can connect Google in Account so either sign-in method opens the same account.
const GLOGO = '<svg viewBox="0 0 48 48" width="20" height="20" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

export function createGoogle(c) {
  const { S, t, esc, sb, toast, rpc, guarded, opts, COUNTIES } = c;
  S.gg = null;
  const redirectTo = () => location.origin + '/';
  const hasGoogle = () => !!(S.user && (S.user.identities || []).some((i) => i.provider == 'google'));
  const needsProfile = () => !!(S.user && !S.profile);

  // Errors sent back by Google / Supabase in the address bar after the redirect.
  function readRedirectError() {
    const q = new URLSearchParams(location.search + '&' + location.hash.slice(1));
    const msg = q.get('error_description') || q.get('error');
    if (!msg) return;
    history.replaceState(null, '', location.pathname);
    setTimeout(() => toast(t('gErr') + ' ' + msg.replace(/\+/g, ' ')), 600);
  }

  const button = (label) => `<button class="gbtn" data-a="google" ${S.busy ? 'disabled' : ''}>${GLOGO}<span>${label || t('gCont')}</span></button><div class="or"><span>${t('gOr')}</span></div>`;

  function completeView() {
    const u = S.user, md = u.user_metadata || {};
    const f = S.gg || (S.gg = { name: (md.full_name || md.name || '').slice(0, 40), phone: '', y: 'Nairobi', role: 'buyer', biz: '' });
    return `<h2>${t('gDoneH')}</h2><div class="card"><div class="gwho">${GLOGO}<div><div class="pn">${esc(md.full_name || md.name || '')}</div><div class="mut">${esc(u.email || '')}</div></div></div><p class="mut">${t('gDoneN')}</p>
<div class="mut" style="margin-bottom:6px">${t('iam')}</div>${['buyer', 'seller', 'rider'].map((r) => `<button class="opt" aria-pressed="${f.role == r}" data-a="grole" data-v="${r}">${t(r == 'buyer' ? 'roleB' : r == 'seller' ? 'roleS' : 'roleR')}</button>`).join('')}
<label class="f" for="gn">${t('fname')}</label><input type="text" id="gn" maxlength="40" autocomplete="name" value="${esc(f.name)}" data-m="gg.name">
${f.role == 'seller' ? `<label class="f" for="gb">${t('biz')}</label><input type="text" id="gb" maxlength="40" autocomplete="organization" value="${esc(f.biz)}" data-m="gg.biz">` : ''}
<label class="f" for="gy">${t('county')}</label><select id="gy" data-m="gg.y">${opts(COUNTIES.slice(1), f.y)}</select>
<label class="f" for="gp">${t('lphone')}</label><input type="tel" id="gp" inputmode="tel" autocomplete="tel" maxlength="16" value="${esc(f.phone)}" data-m="gg.phone"><div class="mut">${t('gPhoneN')}</div>
<button class="btn" data-a="gcomplete" ${S.busy ? 'disabled' : ''}>${t('gFinish')}</button><button class="lk" data-a="logout">${t('gOther')}</button></div>`;
  }

  // Account page: connect Google to an existing (phone) account.
  function linkCard() {
    if (!S.user || !S.profile) return '';
    const g = (S.user.identities || []).find((i) => i.provider == 'google');
    return `<div class="card"><div class="pn">${t('gLinkH')}</div>${g ? `<div class="gwho">${GLOGO}<div><div>${t('gLinked')}</div><div class="mut">${esc((g.identity_data || {}).email || '')}</div></div></div>` : `<p class="mut">${t('gLinkN')}</p><button class="gbtn" data-a="glink">${GLOGO}<span>${t('gLink')}</span></button>`}</div>`;
  }

  const A = {
    google: () => guarded(async () => {
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo(), queryParams: { prompt: 'select_account' } } });
      if (error) { toast(t('gErr') + ' ' + error.message); S.busy = false; c.render(); }
      // On success the browser goes to Google and comes back to this site.
    }),
    glink: () => guarded(async () => {
      const { error } = await sb.auth.linkIdentity({ provider: 'google', options: { redirectTo: redirectTo() } });
      if (error) { toast(t('gErr') + ' ' + error.message); S.busy = false; c.render(); }
    }),
    grole: (d) => { S.gg.role = d.v; c.render(); },
    gcomplete: () => guarded(async () => {
      const f = S.gg, ph = c.normPh(f.phone);
      if (f.name.trim().length < 2) { toast(t('eName')); S.busy = false; return; }
      if (!ph) { toast(t('badph')); S.busy = false; return; }
      if (f.role == 'seller' && f.biz.trim().length < 2) { toast(t('eBiz')); S.busy = false; return; }
      const r = await rpc('complete_my_profile', { p_name: f.name.trim(), p_phone: ph, p_county: f.y, p_role: f.role, p_biz: f.biz.trim() });
      if (!r.error) { S.gg = null; await c.refreshAll(); S.tab = f.role == 'rider' ? 'rides' : f.role == 'seller' ? 'sell' : 'shop'; toast(t('gWelcome')); }
      S.busy = false; c.render(); scrollTo(0, 0);
    }),
  };

  return { readRedirectError, button, completeView, linkCard, needsProfile, hasGoogle, actions: A };
}

export const GGTX = {
  en: {
    gCont: 'Continue with Google', gUp: 'Sign up with Google', gOr: 'or use your phone number', gErr: 'Google sign-in did not work:',
    gDoneH: 'Finish creating your account', gDoneN: 'You signed in with Google. Add your phone number and county so buyers, sellers and riders can reach you.',
    gPhoneN: 'Your phone number is shown to the people you trade with, as with every Shamba Soko account.', gFinish: 'Finish sign-up', gOther: 'Use a different account',
    gWelcome: 'Welcome to Shamba Soko!', gLinkH: 'Google sign-in', gLinkN: 'Connect your Google account to sign in with Google as well as your phone number and password.',
    gLink: 'Connect Google', gLinked: 'Connected: you can sign in with Google', menu: 'Menu', noaccQ: 'New to Shamba Soko?', haveaccQ: 'Already have an account?',
  },
  sw: {
    gCont: 'Endelea na Google', gUp: 'Jisajili na Google', gOr: 'au tumia namba yako ya simu', gErr: 'Kuingia kwa Google hakukufanikiwa:',
    gDoneH: 'Kamilisha akaunti yako', gDoneN: 'Umeingia kwa Google. Weka namba yako ya simu na kaunti ili wanunuzi, wauzaji na waendesha wakufikie.',
    gPhoneN: 'Namba yako ya simu inaonyeshwa kwa watu unaofanya biashara nao, kama kwa kila akaunti ya Shamba Soko.', gFinish: 'Kamilisha usajili', gOther: 'Tumia akaunti nyingine',
    gWelcome: 'Karibu Shamba Soko!', gLinkH: 'Kuingia kwa Google', gLinkN: 'Unganisha akaunti yako ya Google ili uingie kwa Google pamoja na namba yako ya simu na nenosiri.',
    gLink: 'Unganisha Google', gLinked: 'Imeunganishwa: unaweza kuingia kwa Google', menu: 'Menyu', noaccQ: 'Mgeni Shamba Soko?', haveaccQ: 'Una akaunti tayari?',
  },
};
