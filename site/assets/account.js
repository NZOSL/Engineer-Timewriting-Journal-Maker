// "Change password", available on every signed-in page. The new password is turned into
// a key in this browser and only that key, sealed with the person's own user key, goes
// to GitHub, so nobody else (not even the office) ever sees the password.

import { $, el, toast, changePassword, checkPassword, passwordProblem, normalizePassword } from './app.js';

export function setUpChangePassword(getContext) {
  const button = $('#change-password');
  if (!button) return;
  const dialog = el('dialog', { class: 'dialog dialog-small', 'aria-labelledby': 'cp-title' });
  document.body.append(dialog);
  button.hidden = false;

  button.addEventListener('click', () => {
    const { bundle, profile, session } = getContext();
    const current = el('input', { type: 'password', autocomplete: 'current-password', required: true });
    const fresh = el('input', { type: 'password', autocomplete: 'new-password', required: true });
    const again = el('input', { type: 'password', autocomplete: 'new-password', required: true });
    const show = el('input', { type: 'checkbox' });
    const message = el('p', { class: 'form-message', role: 'alert', hidden: true });
    const submit = el('button', { class: 'btn btn-primary', type: 'submit' }, 'Change password');
    show.addEventListener('change', () => { for (const input of [current, fresh, again]) input.type = show.checked ? 'text' : 'password'; });
    const fail = (text, field) => {
      message.textContent = text;
      message.hidden = false;
      field?.focus();
    };
    const form = el('form', { class: 'dialog-body cp-form', novalidate: true },
      el('p', { class: 'muted' }, 'Choose a password only you know: at least 12 characters (a few words with spaces works well). Capitals, spaces and dashes don’t matter.'),
      el('label', { class: 'field' }, el('span', {}, 'Current password'), current),
      el('label', { class: 'field' }, el('span', {}, 'New password'), fresh),
      el('label', { class: 'field' }, el('span', {}, 'New password again'), again),
      el('label', { class: 'check' }, show, ' Show passwords'),
      message,
      el('div', { class: 'cp-actions' }, el('button', { class: 'btn btn-ghost', type: 'button', onclick: () => dialog.close() }, 'Cancel'), submit));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      message.hidden = true;
      const problem = passwordProblem(fresh.value, session.username);
      if (problem) return fail(problem, fresh);
      if (normalizePassword(fresh.value) !== normalizePassword(again.value)) return fail('The two new passwords don’t match.', again);
      submit.disabled = true;
      submit.textContent = 'Checking…';
      if (!(await checkPassword(session.username, current.value))) {
        submit.disabled = false;
        submit.textContent = 'Change password';
        return fail('Your current password isn’t right.', current);
      }
      submit.textContent = 'Changing… (about a minute)';
      try {
        const done = await changePassword(bundle, profile, session, fresh.value);
        dialog.close();
        toast(done ? 'Your password has been changed. Use the new one next time you sign in.'
          : 'This is taking longer than usual. In a few minutes, sign in with your new password; until it works, your old one still does.',
        { tone: done ? 'ok' : 'warn', duration: 10000 });
      } catch (error) {
        submit.disabled = false;
        submit.textContent = 'Change password';
        fail(error.message);
      }
    });
    dialog.replaceChildren(
      el('div', { class: 'dialog-head' }, el('h2', { id: 'cp-title' }, 'Change your password'),
        el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dialog.close() }, '×')),
      form);
    if (!bundle.saveToken) {
      form.replaceChildren(el('p', {}, 'Changing passwords needs saving to the office, which isn’t switched on yet.'));
    }
    dialog.showModal();
    current.focus();
  });
}
