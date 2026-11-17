/* AI SDR visitor script: reports page views on this site, company level only.
   No cookies, no storage, nothing about the person. Skipped when the browser
   sends Global Privacy Control or Do Not Track. */
(function () {
  var s = document.currentScript;
  var key = s && s.getAttribute('data-site');
  if (!key || !/^site_[0-9a-f]{32}$/.test(key) || !navigator.sendBeacon) return;
  if (navigator.globalPrivacyControl === true || navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
  var url = s.src.replace(/\/v\.js(\?.*)?$/, '') + '/api/visit/' + key;
  var last = '';
  function send() {
    var p = location.pathname;
    if (p === last) return;
    last = p;
    var ref = '';
    try { ref = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) {}
    navigator.sendBeacon(url, new Blob([JSON.stringify({ p: p, r: ref })], { type: 'text/plain' }));
  }
  send();
  // Single-page sites change pages without a reload
  var push = history.pushState;
  history.pushState = function () { var r = push.apply(this, arguments); setTimeout(send, 0); return r; };
  window.addEventListener('popstate', send);
})();
