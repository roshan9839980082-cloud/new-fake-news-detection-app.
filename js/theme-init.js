(() => {
  const saved = localStorage.getItem('ng_theme');
  const theme = saved === 'dark' || saved === 'light' ? saved : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
