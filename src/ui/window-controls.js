const controls = window.windowControls;
if (controls) {
  const apply = state => {
    document.documentElement.classList.toggle('is-maximized', state.maximized);
    document.documentElement.classList.toggle('window-inactive', !state.focused);
    const maximize = document.querySelector('[data-window-action="maximize"]');
    if (maximize) {
      const label = state.maximized ? '还原窗口' : '最大化';
      maximize.setAttribute('aria-label', label);
      maximize.title = label;
    }
  };
  controls.onState(apply);
  void controls.getState().then(apply);
  for (const button of document.querySelectorAll('[data-window-action]')) {
    button.addEventListener('click', () => {
      // A successful close can destroy the renderer before the IPC reply arrives.
      void controls.control(button.dataset.windowAction).catch(() => {});
    });
  }
}
