// Where Microsoft sends the sign-in pop-up back to (the app registration's redirect URI). It
// hands the one-time code to the Admin page that opened the pop-up, then closes. The code is no
// use on its own: only that Admin page holds the secret it has to be paired with.

const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
history.replaceState(null, '', location.pathname);
const reply = {
  type: 'etjm-microsoft',
  state: params.get('state'),
  code: params.get('code'),
  error: params.get('error'),
  description: params.get('error_description'),
};
let sent = false;
if (reply.state) {
  try {
    const channel = new BroadcastChannel('etjm-microsoft');
    channel.postMessage(reply);
    channel.close();
    sent = true;
  } catch { /* an older browser: the message below still works */ }
  try {
    if (window.opener) {
      window.opener.postMessage(reply, location.origin);
      sent = true;
    }
  } catch { /* the Admin page has gone */ }
}
document.getElementById('message').textContent = sent
  ? 'Done. You can close this window if it doesn’t close itself.'
  : 'Nothing to finish here. Sign in from the Admin page.';
if (sent) setTimeout(() => window.close(), 300);
