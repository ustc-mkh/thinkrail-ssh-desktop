let trust = false;
window.authentication.getPrompt().then(prompt => {
  document.getElementById('prompt').textContent = prompt;
  trust = /yes\/no|fingerprint.*\?/i.test(prompt);
  document.getElementById('answer').hidden = trust;
  if (trust) document.getElementById('submit').textContent = '信任并继续';
  else document.getElementById('answer').focus();
});
document.getElementById('auth-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = document.getElementById('answer');
  const answer = trust ? 'yes' : input.value;
  input.value = '';
  void window.authentication.answer(answer);
});
document.getElementById('cancel').addEventListener('click', () => void window.authentication.answer(null));
document.addEventListener('keydown', event => { if (event.key === 'Escape') void window.authentication.answer(null); });
