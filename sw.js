// Service worker: deixa o app abrir rápido e funcionar com internet ruim.
// Arquivos do app (SHELL): saem do aparelho na hora. Cada versão publicada tem um cache próprio,
// baixado inteiro quando este arquivo muda, então nunca se misturam arquivos de versões diferentes.
// Páginas das instituições de ensino e ícones: do aparelho na hora, atualizados em segundo plano para a próxima vez.
// Dados do Supabase: sempre da rede. Fotos das pastas privadas (chat, galeria, projetos…): guardadas
// no aparelho pelo caminho do arquivo (o link assinado muda a cada vez), para aparecerem na hora.
// Esse cache (FOTOS) passa de uma versão para outra e é apagado ao sair da conta (js/app.js).
// O build (scripts/build-site.mjs) acrescenta ao nome do cache um código do conteúdo do app:
// qualquer mudança de código gera uma versão nova sozinha.
const CACHE = 'cc4-v41';
const ANDROID = /android/i.test(self.navigator.userAgent);
const FOTOS = 'cc4-fotos';
const FOTOS_MAX = 400; // as mais antigas saem
const SIGNED_IMAGE = /^\/storage\/v1\/object\/sign\//;
// Service worker de uma instituição de ensino (escopo i/<igreja>/, o mesmo do app instalado) ou da raiz do site.
const CHURCH_SCOPE = /\/i\/[a-z0-9-]+\/$/.test(new URL(self.registration.scope).pathname);
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/config.js',
  'js/util.js',
  'js/images.js',
  'js/install.js',
  'js/push.js',
  'js/pix.js',
  'js/map.js',
  'js/tema.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
];
const SHELL_URLS = new Set(SHELL.map((u) => new URL(u, self.location).href));

self.addEventListener('install', (e) => {
  // cache: 'reload' pula o cache do navegador: a versão nova vem inteira do servidor.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== FOTOS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Foto de pasta privada do Supabase: do aparelho, se já veio uma vez.
  if (req.destination === 'image' && url.hostname.endsWith('.supabase.co') && SIGNED_IMAGE.test(url.pathname)) {
    e.respondWith(cachedPhoto(req, url));
    return;
  }
  const sameOrigin = url.origin === location.origin;
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (!sameOrigin && !cdn) return;
  // O ícone da tela de início do iPhone vem direto da rede (o Safari falha às vezes quando passa pelo service worker).
  if (url.pathname.endsWith('/apple-touch-icon.png')) return;

  if (cdn) {
    // Bibliotecas com versão fixa: cache primeiro.
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })),
    );
    return;
  }

  // Arquivo do app desta versão: direto do aparelho.
  if (SHELL_URLS.has(url.href.split('#')[0])) {
    e.respondWith(caches.match(url.href.split('#')[0], { cacheName: CACHE }).then((hit) => hit || fetch(req)));
    return;
  }

  // Resto (página da instituição de ensino, manifest, ícones): mostra o que tem e busca a versão nova para a próxima vez.
  const fresh = fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req.url, copy));
    }
    return res;
  });
  e.respondWith(
    caches.match(req.url, { ignoreVary: true }).then((hit) => {
      if (hit) {
        e.waitUntil(fresh.catch(() => {}));
        return hit;
      }
      return fresh.catch(() => caches.match('./'));
    }),
  );
});

// A chave é o endereço sem o token: o mesmo arquivo com um link novo continua vindo do aparelho.
async function cachedPhoto(req, url) {
  const key = url.origin + url.pathname;
  const cache = await caches.open(FOTOS);
  const hit = await cache.match(key);
  if (hit) return hit;
  // cors: guarda a resposta de verdade (a "opaca" ocupa muito espaço no aparelho).
  const res = await fetch(url.href, { mode: 'cors', credentials: 'omit' }).catch(() => null);
  if (!res) return fetch(req);
  if (res.ok) {
    await cache.put(key, res.clone());
    cache.keys().then((keys) => keys.length > FOTOS_MAX && Promise.all(keys.slice(0, keys.length - FOTOS_MAX).map((k) => cache.delete(k))));
  }
  return res;
}

// Avisos no celular: aniversários, resumos e central (GitHub Actions) e mensagens do chat
// (Edge Function enviar-push). Como no Desapega: avisa as janelas abertas, não mostra o aviso
// de uma conversa que a pessoa já está vendo e toca de novo a cada mensagem da mesma conversa.
self.addEventListener('push', (e) => {
  let msg = {};
  try {
    msg = e.data ? e.data.json() : {};
  } catch {}
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // App aberto: atualiza o sininho e o chat.
      wins.forEach((w) => w.postMessage({ type: 'push', url: msg.url || '' }));
      const viewing = msg.url && wins.some((w) => w.focused && w.visibilityState === 'visible' && w.url === msg.url);
      if (viewing) return;
      return self.registration.showNotification(msg.title || 'CC4', {
        body: msg.body || '',
        // No Android o ícone grande aparece à direita: sem imagem, o Chrome desenha uma bola com a letra
        // do site ("I"); uma imagem transparente não mostra nada (como no Desapega). O ícone da instituição de ensino já aparece à esquerda.
        icon: ANDROID ? 'icons/vazio.png' : msg.icon || 'icons/icon-192.png',
        // Ícone da barra de notificações (ao lado do relógio): o da instituição de ensino, gerado da logo e publicado
        // em i/<igreja>/; na raiz do site, o padrão.
        badge: CHURCH_SCOPE ? new URL('badge-96.png', self.registration.scope).href : 'icons/badge-96.png',
        image: msg.image,
        tag: msg.tag,
        renotify: !!msg.tag, // mensagem nova da mesma conversa toca de novo
        data: { url: msg.url || './' },
      });
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  const page = url.split('#')[0];
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Já aberto na mesma igreja: usa a janela; senão abre uma nova.
      const win = wins.find((w) => w.url.split('#')[0] === page);
      if (win) return win.focus().then(() => win.navigate(url)).catch(() => self.clients.openWindow(url));
      return self.clients.openWindow(url);
    }),
  );
});
