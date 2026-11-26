// "Download the Android app" option: a menu link for everyone on the website, and a small
// dismissible banner for visitors using Android phones. Hidden inside the Shamba Soko app itself.
export const APK_URL = '/download/ShambaSoko.apk';
export const ATX = {
  en: { appDl: '📲 Download Android app', appBanner: 'Get the Shamba Soko app for Android', appGet: 'Download', appClose: 'Close',
    appHelp: 'After downloading, open the file and tap Install. If your phone asks, allow installs from this source.' },
  sw: { appDl: '📲 Pakua programu ya Android', appBanner: 'Pata programu ya Shamba Soko kwa Android', appGet: 'Pakua', appClose: 'Funga',
    appHelp: 'Baada ya kupakua, fungua faili na ubonyeze Sakinisha. Simu ikiuliza, ruhusu usakinishaji kutoka chanzo hiki.' },
};
const inApp = /ShambaSokoApp/.test(navigator.userAgent);
const android = /Android/i.test(navigator.userAgent);
const KEY = 'ss-app-banner-closed';
const closed = () => { try { return localStorage.getItem(KEY) == '1'; } catch (e) { return false; } };

// Called on every render with the translator, so the texts follow the chosen language.
export function appDownload(t, $) {
  const link = $('#mapp');
  if (link) { link.hidden = inApp; link.textContent = t('appDl'); link.title = t('appHelp'); }
  const bar = $('#appbar');
  if (!bar) return;
  if (inApp || !android || closed()) { bar.hidden = true; return; }
  bar.hidden = false;
  bar.querySelector('.ab-t').textContent = t('appBanner');
  const g = bar.querySelector('.ab-g'); g.textContent = t('appGet'); g.title = t('appHelp');
  const x = bar.querySelector('.ab-x'); x.setAttribute('aria-label', t('appClose'));
  x.onclick = () => { try { localStorage.setItem(KEY, '1'); } catch (e) {} bar.hidden = true; };
}
