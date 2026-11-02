// Tema escolhido neste aparelho (claro ou escuro), aplicado antes de a página aparecer, para
// não piscar. Sem escolha, o app segue o tema do celular. A troca fica no botão do topo (js/app.js).
// Igreja com o fundo do tema escuro na cor principal: as cores guardadas na última abertura
// (js/app.js, applyBranding) também entram antes, para não piscar o fundo preto.
(function () {
  try {
    var root = document.documentElement;
    var t = localStorage.getItem('tema');
    if (t === 'claro' || t === 'escuro') root.setAttribute('data-theme', t === 'escuro' ? 'dark' : 'light');
    var c = JSON.parse(localStorage.getItem('tema-igreja:' + location.pathname) || 'null');
    if (c && c.bg) {
      root.setAttribute('data-dark-theme', 'principal');
      root.style.setProperty('--church-dark', c.bg);
      if (t === 'escuro' || (t !== 'claro' && matchMedia('(prefers-color-scheme: dark)').matches)) {
        root.style.setProperty('--brand', c.accent);
        root.style.setProperty('--brand-ink', c.accentInk);
      }
    }
  } catch (e) {}
  // Sem zoom: o Safari do iPhone ignora o "user-scalable=no" da página, então o gesto de pinça é
  // barrado aqui. O mapa (Leaflet) usa os próprios toques e continua aproximando.
  document.addEventListener('gesturestart', function (e) {
    e.preventDefault();
  });
})();
