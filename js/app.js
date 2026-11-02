import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { CONFIG } from './config.js';
import {
  esc, slugify, isValidSlug, churchSlugFromPath, churchRestUrl, inkOn, readableOnWhite, darkPalette, normalizeHex, normalizePhone, fmtPhone,
  ROLES, isLeaderRole, FEATURES, cardTokenFrom, fold, fmtDate, EMAIL_RE, parseMembersCsv, MEMBERS_CSV_TEMPLATE,
  renderMessage, firstName, joinNames, MESSAGE_FIELDS, SPECIAL_FIELDS, yearsText, MESSAGE_EMOJIS, icsForEvent, googleCalendarUrl, REMIND_OPTIONS,
} from './util.js';
import { resizeImage, resizeLogo, makeIconSet, resizeForGallery } from './images.js';
import { maybeSuggestInstall, installState, installNow, iconReady, ICON_PREPARING } from './install.js';
import { pushSupport, pushActive, enablePush, disablePush, syncPush, movePushToPage } from './push.js';
import { PIX_TYPES, guessPixType, normalizePixKey, formatPixKey, parseAmount, pixPayload, qrSvg, qrImage } from './pix.js';
import { placeBlock, mountPlaceMaps, pinField, bindPinField, pinValues } from './map.js';

const $view = document.getElementById('view');
const configured = !CONFIG.SUPABASE_ANON_KEY.includes('COLE-AQUI');
const sb = configured
  ? createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
      auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true },
    })
  : null;

// Página atual (a raiz do site ou .../i/<igreja>/), para onde o login volta.
const PAGE_URL = location.origin + location.pathname.replace(/index\.html$/, '');
// Raiz do site: em .../i/<igreja>/ o <base> aponta para ela.
const ROOT_URL = new URL('./', document.baseURI).href;
const SLUG = churchSlugFromPath(location.pathname);
const churchUrl = (slug) => `${ROOT_URL}i/${slug}/`;

const state = {
  user: null,
  platformAdmin: false,
  memberships: [], // { id, role, consent_at, church: {...} } de todas as igrejas da pessoa
  church: null, // igreja desta página
};

// Cadastro da pessoa na igreja desta página (pode estar esperando o aceite).
const myMember = () => state.memberships.find((m) => m.church.id === state.church?.id) ?? null;
const isActiveMember = () => !!myMember()?.consent_at;
const myRole = () => (isActiveMember() ? myMember().role : null);
const featureOn = (key) => !!state.church?.features?.[key];
// Alfinete da igreja no mapa: ponto de partida para marcar eventos e células.
const churchPin = () => (state.church?.lat != null ? { lat: state.church.lat, lng: state.church.lng } : null);
// Pastor (administrador) e líderes: leem os pedidos de oração privados e moderam o mural.
// Datas comemoradas: aniversário (funcionalidade "aniversarios") e casamento e batismo ("datas_especiais").
const MESSAGE_KINDS = {
  aniversario: { feature: 'aniversarios', menu: 'Mensagem de aniversário', emoji: '🎂', label: 'Aniversário' },
};
const messageKindsOn = () => Object.keys(MESSAGE_KINDS).filter((k) => featureOn(MESSAGE_KINDS[k].feature));
const datesOn = () => featureOn('aniversarios');
// Atalhos do administrador para as mensagens das datas ligadas.
const messageLinks = () =>
  messageKindsOn()
    .map((k) => `<a class="menu-row" href="#/config/${k}">${icon.cake}<span>${MESSAGE_KINDS[k].menu}</span>${icon.chevron}</a>`)
    .join('');
// Tela do Pix: funcionalidade ligada e chave Pix preenchida.
const offerReady = () => featureOn('pix') && !!state.church?.pix_key;

// ---------------------------------------------------------------------
// Telas que abrem na hora: guarda (na memória e no aparelho) o que veio do banco da última
// vez, desenha com isso e confere com o banco em seguida. Vale só para a conta e a igreja
// atuais, e é apagado ao sair da conta. As permissões continuam no banco.
// ---------------------------------------------------------------------
const SCREEN_PREFIX = 'tela:';
const screenMem = new Map();
const screenLoading = new Map();
// Telas com dados sensíveis de outras pessoas: guardadas só na memória, nunca gravadas no aparelho.
const PRIVATE_SCREENS = /^(sala:|salas$|criancas$)/;
const screenKey = (name) => `${SCREEN_PREFIX}${state.user?.id}:${state.church?.id}:${name}`;

function screenCached(name) {
  const key = screenKey(name);
  if (screenMem.has(key)) return screenMem.get(key);
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved) screenMem.set(key, saved);
    return saved;
  } catch {
    return null;
  }
}

// Busca no banco (uma busca por vez para cada tela) e guarda.
function screenFetch(name, fetcher) {
  const key = screenKey(name);
  if (!screenLoading.has(key)) {
    const p = fetcher()
      .then((data) => {
        screenMem.set(key, data);
        // Pedidos de oração da moderação (inclui os privados): só na memória, nunca gravados no aparelho.
        if (!PRIVATE_SCREENS.test(name)) {
          try {
            localStorage.setItem(key, JSON.stringify(data));
          } catch {}
        }
        return data;
      })
      .finally(() => screenLoading.delete(key));
    screenLoading.set(key, p);
  }
  return screenLoading.get(key);
}

// Desenha na hora com o guardado e de novo se o banco trouxer algo diferente.
// Sem internet, fica com o guardado; sem nada guardado, o erro aparece como sempre.
async function screenShow(ctx, name, fetcher, draw) {
  const cached = screenCached(name);
  // Como estava ao abrir: a própria tela pode mudar o guardado (ex.: "Li", "Amém") enquanto o banco responde.
  const opened = JSON.stringify(cached);
  if (cached) draw(cached);
  let data;
  try {
    data = await screenFetch(name, fetcher);
  } catch (err) {
    if (cached) return;
    throw err;
  }
  if (!ctx.alive() || JSON.stringify(data) === opened) return;
  const typing = document.activeElement;
  if (cached && $view.contains(typing) && /^(INPUT|TEXTAREA|SELECT)$/.test(typing.tagName)) return;
  draw(data);
}

// Fotos dos membros já conhecidas (links ainda válidos), sem esperar a rede.
function knownPhotos(paths) {
  const now = Date.now();
  const out = {};
  for (const p of paths) {
    const hit = photoLinks.get(p);
    if (hit && hit.until > now) out[p] = hit.url;
  }
  return out;
}

// Como screenShow, para telas com fotos: desenha na hora com as fotos já conhecidas
// (as outras com as iniciais) e de novo quando os links das que faltam chegam.
// photosOf devolve os caminhos das fotos (os nulos são ignorados).
async function screenShowWithPhotos(ctx, name, fetcher, photosOf, draw) {
  const minisOf = (data) => photosOf(data).filter(Boolean).map(miniOf);
  await screenShow(ctx, name, fetcher, (data) => draw(data, knownPhotos(minisOf(data))));
  const data = screenCached(name);
  if (!data || !ctx.alive()) return;
  const paths = minisOf(data);
  if (paths.every((p) => knownPhotos([p])[p])) return;
  const minis = await signedPhotos(paths).catch(() => ({}));
  if (ctx.alive()) draw(data, minis);
}

// Formulários: abrem na hora com o guardado (cached) e conferem com o banco em segundo plano.
// Se o banco trouxer outra versão antes de a pessoa mexer no formulário, guarda (remember) e
// abre a tela de novo com ela; depois que a pessoa começou a mexer, não troca nada.
function formFresh(ctx, cached, fetcher, remember) {
  let touched = false;
  $view.addEventListener('input', () => (touched = true), { once: true });
  fetcher()
    .then((fresh) => {
      if (!ctx.alive() || touched || JSON.stringify(fresh) === JSON.stringify(cached)) return;
      remember(fresh);
      render();
    })
    .catch(() => {});
}

// Item para editar: o que já está guardado de uma lista (abre na hora, conferindo com o banco
// em segundo plano) ou, se não houver, o banco.
async function editItem(ctx, cachedItem, fetcher, remember) {
  if (!cachedItem) return fetcher();
  formFresh(ctx, cachedItem, fetcher, remember);
  return cachedItem;
}

// Foto grande do formulário: aparece na hora a que já está guardada (ou a miniatura); a de
// tamanho cheio entra quando o link chegar, se a pessoa não tiver escolhido outra.
function photoNow(path) {
  if (!path) return null;
  const known = knownPhotos([path, miniOf(path)]);
  return known[path] || known[miniOf(path)] || null;
}
function photoLater(ctx, form, name, path) {
  if (!path || knownPhotos([path])[path]) return;
  signedPhotos([path])
    .then((links) => {
      const box = document.getElementById('photo-preview');
      if (!ctx.alive() || !box || !links[path] || form.photo?.files?.length || form.dataset.photoRemoved) return;
      box.innerHTML = avatar(name, links[path], 'big');
    })
    .catch(() => {});
}

// Depois de criar, editar ou apagar: a próxima abertura espera o banco.
function screenForget(name) {
  const key = screenKey(name);
  screenMem.delete(key);
  screenLoading.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {}
}

// Depois de uma mudança feita na própria tela: guarda a versão nova, sem esperar o banco.
function screenUpdate(name, data) {
  const key = screenKey(name);
  screenMem.set(key, data);
  if (PRIVATE_SCREENS.test(name)) return;
  try {
    localStorage.setItem(key, JSON.stringify(data));
  } catch {}
}

// No Início, já busca em segundo plano as telas mais usadas.
function prefetchScreens() {
  if (!isActiveMember()) return;
  const run = () => {
    if (featureOn('agenda')) {
      screenFetch('agenda', loadAgenda).catch(() => {});
      screenFetch('eventos', loadEventDetails).catch(() => {});
    }
    if (featureOn('avisos')) screenFetch('avisos', loadAnnouncements).catch(() => {});
    if (featureOn('salas')) screenFetch('filhos', loadMyKids).catch(() => {});
    if (featureOn('galeria')) {
      // E as capas dos álbuns, para a Galeria abrir com as imagens.
      screenFetch('galeria', loadAlbums)
        .then((all) => galleryUrls(all.map((a) => a.cover_mini).filter(Boolean)))
        .catch(() => {});
    }
    const me = myMember();
    screenFetch('perfil', () => loadProfile(me.id))
      .then((m) => m.photo_path && signedPhotos([m.photo_path]))
      .catch(() => {});
    screenFetch('notificacoes:todas', async () => {
      const { data, error } = await sb
        .from('notifications')
        .select('id, kind, title, body, url, read_at, created_at')
        .eq('church_id', state.church.id)
        .order('created_at', { ascending: false })
        .range(0, NOTIF_PAGE);
      if (error) throw error;
      return data;
    }).catch(() => {});
    if (datesOn()) {
      const now = new Date();
      const [y, m] = [now.getFullYear(), now.getMonth() + 1];
      screenFetch(`mes:${y}-${m}`, () => fetchBirthdays(isoLocal(new Date(y, m - 1, 1)), isoLocal(new Date(y, m, 0)))).catch(() => {});
    }
  };
  'requestIdleCallback' in window ? requestIdleCallback(run, { timeout: 1500 }) : setTimeout(run, 300);
}

// ---------------------------------------------------------------------
// Utilidades da tela
// ---------------------------------------------------------------------
let toastTimer;
// action (opcional): { label, run } vira um botão no aviso, como "Desfazer".
function toast(msg, kind = '', action = null) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.onclick = () => {
      el.hidden = true;
      action.run();
    };
    el.append(' ', btn);
  }
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), kind === 'error' ? 6000 : action ? 6000 : 3500);
}

// Pergunta numa janela do app, com o nome da igreja no topo (a janela do navegador, confirm/prompt,
// mostraria o endereço do site). Devolve true/false; com `input`, o texto digitado (ou null se cancelou).
// O botão da ação diz o que faz ("Apagar", "Excluir"…, tirado da própria pergunta) e fica vermelho
// quando apaga ou tira algo. Esc e "Cancelar" desistem; Enter confirma.
const ASK_DANGER = ['Apagar', 'Excluir', 'Tirar', 'Desligar', 'Sair', 'Desativar', 'Bloquear', 'Denunciar'];
function ask(message, { ok, danger, input, value = '', placeholder = '', readonly = false } = {}) {
  const verb = message.match(/^[A-ZÀ-Ú][a-zà-ú]+/)?.[0];
  const label = ok || (verb && /r$/.test(verb) ? verb : 'Confirmar');
  const red = danger ?? ASK_DANGER.includes(label.split(' ')[0]);
  const dlg = document.createElement('dialog');
  dlg.className = 'ask';
  dlg.innerHTML = `
    <form method="dialog">
      <h2></h2>
      <p class="pre"></p>
      ${input ? `<input name="answer" type="${input === 'email' ? 'email' : 'text'}" maxlength="500" autocomplete="off">` : ''}
      <div class="actions-row">
        <button type="button" class="btn" value="cancel">${readonly ? 'Fechar' : 'Cancelar'}</button>
        ${readonly ? '' : `<button class="btn ${red ? 'danger' : 'primary'}" value="ok"></button>`}
      </div>
    </form>`;
  dlg.querySelector('h2').textContent = state.church?.name || 'CC4';
  dlg.querySelector('p').textContent = message;
  const field = dlg.querySelector('input');
  if (field) {
    Object.assign(field, { value, placeholder, readOnly: readonly });
    field.setAttribute('aria-label', message);
  }
  const okBtn = dlg.querySelector('[value="ok"]');
  if (okBtn) okBtn.textContent = label;
  document.body.append(dlg);
  return new Promise((resolve) => {
    dlg.querySelector('[value="cancel"]').onclick = () => dlg.close('cancel');
    dlg.addEventListener('close', () => {
      const yes = dlg.returnValue === 'ok';
      dlg.remove();
      resolve(input ? (yes ? field.value : null) : yes);
    });
    dlg.showModal();
    (field && !readonly ? field : okBtn || field)?.focus();
    if (readonly) field?.select();
  });
}

// Botão redondo com "+" no canto inferior direito, para criar algo na tela (conversa, evento, aviso).
const fab = (href, label) => `<a class="fab" href="${href}" aria-label="${esc(label)}" title="${esc(label)}">${icon.plus}</a>`;
// Mais de uma forma de criar na mesma tela: o "+" abre um menu com as opções ([href, texto]).
const fabMenu = (label, items) => `
  <details class="fab-menu">
    <summary class="fab" aria-label="${esc(label)}" title="${esc(label)}">${icon.plus}</summary>
    <div class="fab-options">${items.map(([href, text]) => `<a class="btn" href="${href}">${esc(text)}</a>`).join('')}</div>
  </details>`;

// Folha para imprimir ou salvar PDF (skill folha-para-imprimir): logo e nome da igreja no topo;
// assinaturas e rodapé só aparecem no papel.
const sheetHead = (title, accent, sub = '') => `
  <header class="sheet-head">
    ${state.church.logo_url ? `<img class="sheet-logo" src="${esc(state.church.logo_url)}" alt="" width="56" height="56">` : ''}
    <div>
      <p class="sheet-church">${esc(state.church.name)}</p>
      <h1>${esc(title)} <span>${esc(accent)}</span></h1>
      ${sub ? `<p class="sheet-sub">${esc(sub)}</p>` : ''}
    </div>
  </header>`;
const sheetSigns = (roles) =>
  `<div class="sheet-signs">${roles.map((r) => `<div><span class="sheet-line"></span>${esc(r)}<small>Data: ____/____/________</small></div>`).join('')}</div>`;
const sheetFoot = () => `<footer class="sheet-foot">Gerado pelo app da ${esc(state.church.name)} em ${esc(new Date().toLocaleDateString('pt-BR'))}.</footer>`;
// O título da página vira o nome do PDF salvo.
function printAs(fileTitle) {
  const title = document.title;
  document.title = fileTitle;
  window.addEventListener('afterprint', () => (document.title = title), { once: true });
  window.print();
}
// Prévia na tela: a folha como vai sair no papel e, embaixo, o botão de imprimir.
function drawSheet({ back, backText, title, accent, sub, body, signs, file }) {
  $view.innerHTML = `
    <div class="page sheet-page">
      <a href="${back}" class="back no-print">← ${esc(backText)}</a>
      <article class="sheet">
        ${sheetHead(title, accent, sub)}
        ${body}
        <div class="sheet-end">${signs ? sheetSigns(signs) : ''}${sheetFoot()}</div>
      </article>
      <div class="sheet-actions no-print">
        <button type="button" class="btn primary big" id="print">${icon.print} Imprimir ou salvar PDF</button>
        <p class="hint">Sai numa folha A4. No celular, escolha <strong>Salvar como PDF</strong> para mandar no grupo da igreja.</p>
      </div>
    </div>`;
  document.getElementById('print').onclick = () => printAs(file);
}

const navigate = (path) => {
  if (location.hash === `#${path}`) render();
  else location.hash = path;
};

function requireLogin(next) {
  if (state.user) return true;
  sessionStorage.setItem('next', next);
  navigate('/entrar');
  return false;
}

// Mensagens do banco em português; o resto vira uma frase genérica.
function errorText(err) {
  const msg = err?.message || String(err);
  if (/rate limit|too many|only request this after/i.test(msg))
    return 'Muitos pedidos de link de acesso em pouco tempo. Espere alguns minutos e tente de novo (ou entre com o Google).';
  if (/provider is not enabled/i.test(msg)) return 'O login com Google ainda não está ligado. Use o link pelo e-mail.';
  if (/duplicate key.*slug/i.test(msg)) return 'Já existe uma igreja com esse endereço.';
  if (/duplicate key.*email/i.test(msg)) return 'Esse e-mail já está no cadastro desta igreja.';
  if (/ministries_visitors_idx/i.test(msg)) return 'Outro ministério já recebe os avisos de visitantes. Desmarque nele primeiro.';
  if (/ministries_kids_idx/i.test(msg)) return 'Outro ministério já faz o check-in das crianças. Desmarque nele primeiro.';
  if (/ministries_attendance_idx/i.test(msg)) return 'Outro ministério já marca a presença nos cultos. Desmarque nele primeiro.';
  if (/ministries_gallery_idx/i.test(msg)) return 'Outro ministério já publica na galeria. Desmarque nele primeiro.';
  if (/fin_categories_name_idx/i.test(msg)) return 'Já existe uma categoria com esse nome.';
  if (/exceeded the maximum allowed size|Payload too large/i.test(msg)) return 'A foto ficou grande demais mesmo reduzida. Tente outra foto.';
  if (/row-level security|permission denied/i.test(msg)) return 'Você não tem permissão para isso.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Sem conexão. Confira sua internet e tente de novo.';
  return msg;
}

const icon = {
  home: '<svg viewBox="0 0 24 24"><path d="M3 11 12 4l9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>',
  church: '<svg viewBox="0 0 24 24"><path d="M12 2v5M9.5 4.5h5M5 21V11l7-4 7 4v10z"/><path d="M10 21v-4a2 2 0 0 1 4 0v4"/></svg>',
  cake: '<svg viewBox="0 0 24 24"><path d="M4 21h16v-7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2z"/><path d="M4 16c2 1.3 4 1.3 5.3 0 1.4 1.3 3.4 1.3 5.4 0 1.3 1.3 3.3 1.3 5.3 0M12 12V8M12 5.5c-.8-.8-.8-1.9 0-3 .8 1.1.8 2.2 0 3"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  megaphone: '<svg viewBox="0 0 24 24"><path d="M3 10v4h3l7 4V6L6 10z"/><path d="M16.5 9a4 4 0 0 1 0 6"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  swap: '<svg viewBox="0 0 24 24"><path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3 4.5 6v6c0 4.4 3.2 7.8 7.5 9 4.3-1.2 7.5-4.6 7.5-9V6z"/></svg>',
  logout: '<svg viewBox="0 0 24 24"><path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10"/></svg>',
  pin: '<svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
  users: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.3a6.5 6.5 0 0 1 3.5 5.7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
  qr: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2M20 14v.01M14 20h.01M17 17v3h3M20 17v.01"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
  help: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.1-2.4 3.6M12 17h.01"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></svg>',
  print: '<svg viewBox="0 0 24 24"><path d="M7 9V3.5h10V9M7 17H4.5V9h15v8H17"/><path d="M7 14h10v6.5H7z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.2a4.3 4.3 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20z"/></svg>',
  pix: '<svg viewBox="0 0 24 24"><path d="M12 3.5 20.5 12 12 20.5 3.5 12z"/><path d="M8 12h8"/></svg>',
  clipboard: '<svg viewBox="0 0 24 24"><path d="M9 4.5H6.5a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V5.5a1 1 0 0 0-1-1H15"/><rect x="9" y="3" width="6" height="3" rx="1"/><path d="M9 11h6M9 15h4"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m21 16-5-5-8 8.5"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 20h16M7 16.5V11M12 16.5V6M17 16.5v-8"/></svg>',
  idcard: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2.2"/><path d="M5.8 16.5a3.4 3.4 0 0 1 6.4 0M14.5 10h4M14.5 13.5h3"/></svg>',
  presenca: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M15.5 12.5l2.5 2.5 4.5-5"/></svg>',
  child: '<svg viewBox="0 0 24 24"><circle cx="12" cy="6" r="3"/><path d="M12 9v6M8 11.5l4-1 4 1M9.5 21l2.5-6 2.5 6"/></svg>',
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5.5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/></svg>',
  wallet: '<svg viewBox="0 0 24 24"><path d="M4 7.5a2 2 0 0 1 2-2h12v3"/><rect x="4" y="8.5" width="16" height="11" rx="2"/><path d="M15.5 14h.01"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="m4 12 16-7.5-6 15-2.5-6z"/><path d="m11.5 13.5 8.5-9"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
  book: '<svg viewBox="0 0 24 24"><path d="M5 19.5V5a2 2 0 0 1 2-2h12v15H7a2 2 0 0 0-2 2 2 2 0 0 0 2 2h12v-4"/><path d="M12 6.5v6M9.5 8.8h5"/></svg>',
};

const SOCIAL = [
  ['instagram', 'Instagram', 'https://instagram.com/suaigreja'],
  ['youtube', 'YouTube', 'https://youtube.com/@suaigreja'],
  ['facebook', 'Facebook', 'https://facebook.com/suaigreja'],
  ['site', 'Site', 'https://suaigreja.com.br'],
];

// ---------------------------------------------------------------------
// Tema claro ou escuro: escolhido no botão do topo e guardado só neste aparelho (js/tema.js
// aplica antes de a página aparecer). Sem escolha, segue o tema do celular.
// ---------------------------------------------------------------------
const THEME_KEY = 'tema';
const THEME_CHURCH_KEY = 'tema-igreja:'; // + endereço da página: cores do escuro com a cor principal (js/tema.js)
const systemDark = matchMedia('(prefers-color-scheme: dark)');
const currentTheme = () => document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light');
const themeChosen = () => {
  try {
    return !!localStorage.getItem(THEME_KEY);
  } catch {
    return false;
  }
};

// t: 'light', 'dark' ou null (voltar a seguir o celular).
function setTheme(t) {
  try {
    if (t) localStorage.setItem(THEME_KEY, t === 'dark' ? 'escuro' : 'claro');
    else localStorage.removeItem(THEME_KEY);
  } catch {}
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  updateThemeButton();
  applyBranding(); // botões claros ou na cor principal, conforme o tema
}

function updateThemeButton() {
  const btn = document.getElementById('theme-btn');
  if (!btn) return;
  const dark = currentTheme() === 'dark';
  const label = dark ? 'Usar tema claro' : 'Usar tema escuro';
  btn.innerHTML = dark ? icon.sun : icon.moon;
  btn.setAttribute('aria-label', label);
  btn.title = label;
}
document.getElementById('theme-btn')?.addEventListener('click', () => setTheme(currentTheme() === 'dark' ? 'light' : 'dark'));
systemDark.addEventListener?.('change', () => {
  updateThemeButton();
  applyBranding();
});
updateThemeButton();

// ---------------------------------------------------------------------
// Aparência da igreja (cor, nome, logo)
// ---------------------------------------------------------------------
const DEFAULT_COLOR = '#3b5bdb';

function applyBranding() {
  const c = state.church;
  const color = c?.primary_color || DEFAULT_COLOR;
  const root = document.documentElement.style;
  // Tema escuro com o fundo na cor principal (Configurar > Aparência): o fundo vai em --church-dark
  // (css/style.css) e os botões, o "+" e os links usam a cor clareada, para não sumirem no fundo.
  const principal = c?.dark_theme === 'principal';
  const dark = darkPalette(color);
  const accent = principal && currentTheme() === 'dark';
  if (principal) document.documentElement.dataset.darkTheme = 'principal';
  else delete document.documentElement.dataset.darkTheme;
  root.setProperty('--church', color);
  root.setProperty('--church-ink', inkOn(color));
  root.setProperty('--church-dark', dark.bg);
  root.setProperty('--brand', accent ? dark.accent : color);
  root.setProperty('--brand-ink', accent ? dark.accentInk : inkOn(color));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', accent ? dark.bg : color);
  // O js/tema.js aplica estas cores na próxima abertura antes de a página aparecer (sem piscar o preto).
  try {
    const key = THEME_CHURCH_KEY + location.pathname;
    if (principal) localStorage.setItem(key, JSON.stringify(dark));
    else if (c) localStorage.removeItem(key);
  } catch {}
  document.getElementById('app-name').textContent = c ? c.name : CONFIG.APP_NAME;
  document.getElementById('brand-logo').src = c?.logo_url || 'icons/icon-192.png';
  document.title = c ? c.name : CONFIG.APP_NAME;
}

function renderTabbar(path) {
  const bar = document.getElementById('tabbar');
  if (!state.church || !isActiveMember()) {
    bar.hidden = true;
    document.body.classList.remove('has-tabbar');
    return;
  }
  const tabs = [
    ['/', icon.home, 'Início'],
    ...(featureOn('agenda') ? [['/calendario', icon.calendar, 'Agenda']] : []),
    ...(featureOn('avisos') ? [['/avisos', icon.megaphone, 'Avisos']] : []),
    ...(isLeaderRole(myRole()) ? [['/membros', icon.users, 'Membros']] : []),
    ['/menu', icon.menu, 'Menu'],
  ];
  const section = tabs.find(([href]) => href !== '/' && (path.startsWith(href) || (href === '/calendario' && path.startsWith('/agenda'))));
  // A central de notificações abre pelo sininho do topo: nenhuma aba fica marcada.
  const active = ['/', ''].includes(path) ? '/' : section ? section[0] : path === '/notificacoes' ? null : '/menu';
  bar.innerHTML = tabs
    .map(([href, ic, label]) => `<a href="#${href}" class="${href === active ? 'active' : ''}">${ic}${label}</a>`)
    .join('');
  bar.hidden = false;
  document.body.classList.add('has-tabbar');
}

function renderAccountLink() {
  const a = document.getElementById('account-link');
  if (state.user) {
    a.textContent = state.church ? 'Menu' : 'Conta';
    a.href = state.church ? '#/menu' : '#/conta';
    a.hidden = !!state.church && isActiveMember();
  } else {
    a.textContent = 'Entrar';
    a.href = '#/entrar';
    a.hidden = false;
  }
  document.getElementById('notif-link').hidden = !(state.church && isActiveMember());
}

// Número no sininho: notificações não lidas desta igreja.
async function refreshUnread() {
  const badge = document.getElementById('notif-badge');
  if (!state.church || !isActiveMember()) return (badge.hidden = true);
  const { count } = await sb
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('church_id', state.church.id)
    .is('read_at', null);
  badge.textContent = count > 9 ? '9+' : String(count || '');
  badge.hidden = !count;
}

// ---------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------
async function loadMemberships() {
  if (!state.user) {
    state.memberships = [];
    state.platformAdmin = false;
    return;
  }
  // Primeiro liga a conta aos cadastros com o mesmo e-mail (convites novos).
  await sb.rpc('link_my_account');
  const [mem, pa] = await Promise.all([
    sb
      .from('members')
      .select('id, role, consent_at, name, gallery_team, tutor_rooms:kids_rooms(id), church:churches(id, slug, name, logo_url, primary_color)')
      .eq('user_id', state.user.id)
      .eq('status', 'ativo'),
    sb.rpc('is_platform_admin'),
  ]);
  if (mem.error) throw mem.error;
  state.memberships = (mem.data || []).filter((m) => m.church).sort((a, b) => a.church.name.localeCompare(b.church.name));
  state.platformAdmin = !!pa.data;
}

// Pergunta ao Supabase (endereço público) se o login com Google está ligado; guarda a resposta.
let googleCheck;
function googleEnabled() {
  googleCheck ??= fetch(`${CONFIG.SUPABASE_URL}/auth/v1/settings`, { headers: { apikey: CONFIG.SUPABASE_ANON_KEY } })
    .then((r) => (r.ok ? r.json() : {}))
    .then((s) => !!s.external?.google)
    .catch(() => false);
  return googleCheck;
}

async function setUser(user) {
  state.user = user;
  await loadMemberships();
  renderAccountLink();
  // Aparelho que já aceitou notificações: garante que a inscrição está nesta conta.
  if (user)
    movePushToPage(sb, ROOT_URL, CONFIG.VAPID_PUBLIC_KEY)
      .catch(() => {})
      .then(() => syncPush(sb))
      .catch(() => {});
}

// ---------------------------------------------------------------------
// Roteador
// ---------------------------------------------------------------------
const rootRoutes = [
  [/^\/$/, viewRootHome],
  [/^\/entrar$/, viewLogin],
  [/^\/conta$/, viewAccount],
  [/^\/plataforma$/, viewPlatform],
  [/^\/meus-dados$/, viewMyData],
];

const churchRoutes = [
  [/^\/$/, viewChurchHome],
  [/^\/entrar$/, viewLogin],
  [/^\/menu$/, viewMenu],
  [/^\/perfil$/, viewProfile],
  [/^\/config$/, viewSettings],
  [/^\/membros$/, viewMembers],
  [/^\/membros\/novo$/, viewMemberForm],
  [/^\/membros\/importar$/, viewImport],
  [/^\/membros\/([0-9a-f-]{36})$/, viewMemberForm],
  [/^\/privacidade$/, viewChurchPrivacy],
  [/^\/meus-dados$/, viewMyData],
  [/^\/ajuda$/, viewHelp],
  [/^\/aniversariantes$/, viewBirthdays],
  [/^\/aniversariantes\/imprimir$/, viewBirthdaysSheet],
  [/^\/config\/(aniversario)$/, viewMessageSettings],
  [/^\/notificacoes$/, viewNotifications],
  [/^\/agenda$/, viewAgenda],
  [/^\/calendario$/, viewCalendar],
  [/^\/calendario\/(\d{4}-\d{2})$/, viewCalendar],
  [/^\/calendario\/dia\/(\d{4}-\d{2}-\d{2})$/, viewCalendarDay],
  [/^\/agenda\/novo$/, viewEventForm],
  [/^\/agenda\/([0-9a-f-]{36})$/, viewEvent],
  [/^\/agenda\/([0-9a-f-]{36})\/editar$/, viewEventForm],
  [/^\/avisos$/, viewAnnouncements],
  [/^\/avisos\/novo$/, viewAnnouncementForm],
  [/^\/avisos\/([0-9a-f-]{36})\/editar$/, viewAnnouncementForm],
  [/^\/pix$/, viewOffer],
  [/^\/ofertar$/, viewOffer],
  [/^\/filhos$/, viewMyKids],
  [/^\/filhos\/novo$/, viewChildForm],
  [/^\/filhos\/([0-9a-f-]{36})$/, viewChildForm],
  [/^\/filhos\/sala\/([0-9a-f-]{36})$/, viewParentRoom],
  [/^\/salas$/, viewRooms],
  [/^\/salas\/nova$/, viewRoomForm],
  [/^\/salas\/criancas$/, viewAllKids],
  [/^\/salas\/crianca\/nova$/, viewChildForm],
  [/^\/salas\/crianca\/([0-9a-f-]{36})$/, viewChildForm],
  [/^\/salas\/([0-9a-f-]{36})$/, viewRoom],
  [/^\/salas\/([0-9a-f-]{36})\/editar$/, viewRoomForm],
  [/^\/salas\/([0-9a-f-]{36})\/aviso$/, viewRoomNotice],
  [/^\/galeria$/, viewGallery],
  [/^\/galeria\/novo$/, viewAlbumForm],
  [/^\/galeria\/([0-9a-f-]{36})$/, viewAlbum],
  [/^\/galeria\/([0-9a-f-]{36})\/editar$/, viewAlbumForm],
  [/^\/galeria\/([0-9a-f-]{36})\/foto\/([0-9a-f-]{36})$/, viewGalleryPhoto],
  [/^\/carteirinha$/, viewCard],
  [/^\/carteirinha\/verificar\/([0-9a-f-]{36})$/, viewCardVerify],
];

let renderId = 0;
async function render() {
  const id = ++renderId;
  const raw = location.hash.slice(1) || '/';
  const [path, qs] = raw.split('?');
  const ctx = { params: new URLSearchParams(qs || ''), path, alive: () => id === renderId };
  renderTabbar(path);
  document.getElementById('notif-link').classList.toggle('active', path === '/notificacoes');
  if (path !== '/notificacoes') refreshUnread().catch(() => {});
  const routes = state.church ? churchRoutes : rootRoutes;
  for (const [re, view] of routes) {
    const m = path.match(re);
    if (!m) continue;
    window.scrollTo(0, 0);
    try {
      await view(ctx, ...m.slice(1));
      if (ctx.alive()) mountPlaceMaps($view).catch(() => {});
    } catch (e) {
      if (!ctx.alive()) return;
      console.error(e);
      $view.innerHTML = `
        <div class="empty">
          <h2>Algo deu errado</h2>
          <p>${esc(errorText(e))}</p>
          <button class="btn primary" id="retry">Tentar de novo</button>
        </div>`;
      document.getElementById('retry').onclick = render;
    }
    return;
  }
  $view.innerHTML = `<div class="empty"><h2>Página não encontrada</h2><a class="btn" href="#/">Voltar ao início</a></div>`;
}

// ---------------------------------------------------------------------
// Login (Google ou link mágico no e-mail)
// ---------------------------------------------------------------------
async function viewLogin(ctx) {
  if (state.user) {
    const next = sessionStorage.getItem('next') || '/';
    sessionStorage.removeItem('next');
    return navigate(next);
  }
  $view.innerHTML = `
    <div class="auth">
      <h1>Entrar</h1>
      <p class="hint">Use o mesmo e-mail que você deu à secretaria da sua igreja. Assim o app encontra o seu cadastro.</p>
      <button class="btn google big" id="google" hidden>
        <svg viewBox="0 0 24 24" class="g"><path fill="#4285F4" d="M22.5 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.5c2.1-1.9 3.3-4.7 3.3-8z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.5-2.7c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2.1v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.7 14.1a6.6 6.6 0 0 1 0-4.2V7.1H2.1a11 11 0 0 0 0 9.8z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.1-3.1A11 11 0 0 0 2.1 7.1l3.6 2.8C6.6 7.3 9.1 5.4 12 5.4z"/></svg>
        Entrar com Google
      </button>
      <div class="or" id="google-or" hidden><span>ou</span></div>
      <form id="email-form">
        <label>Seu e-mail<input type="email" name="email" required autocomplete="email" placeholder="voce@exemplo.com"></label>
        <button class="btn primary big">Receber link de acesso</button>
      </form>
      <p class="legal">Ao entrar, você concorda com os <a href="termos.html">Termos de uso</a> e a <a href="privacidade.html">Política de Privacidade</a>.</p>
    </div>`;

  // O botão do Google só aparece quando o login com Google está ligado no Supabase.
  googleEnabled().then((on) => {
    if (!on || !ctx.alive()) return;
    document.getElementById('google').hidden = false;
    document.getElementById('google-or').hidden = false;
  });
  document.getElementById('google').onclick = async () => {
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: PAGE_URL } });
    if (error) toast(errorText(error), 'error');
  };
  document.getElementById('email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = e.target.email.value.trim();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: PAGE_URL } });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    e.target.innerHTML = `<div class="notice"><strong>Confira seu e-mail.</strong><p>Enviamos um link de acesso para ${esc(email)}. Abra-o neste mesmo aparelho e navegador.</p></div>`;
  });
}

async function signOut() {
  clearBootCache();
  await sb.auth.signOut({ scope: 'local' });
  await setUser(null);
  navigate('/');
  render();
}

// ---------------------------------------------------------------------
// Raiz do site: escolher a igreja
// ---------------------------------------------------------------------
function churchRow(c, extra = '') {
  return `
    <a class="church-row" href="${esc(churchUrl(c.slug))}">
      <img src="${esc(c.logo_url || 'icons/icon-192.png')}" alt="" width="44" height="44" style="--c:${esc(c.primary_color || DEFAULT_COLOR)}">
      <span><strong>${esc(c.name)}</strong>${extra}</span>
      ${icon.chevron}
    </a>`;
}

async function viewRootHome() {
  if (!state.user) {
    $view.innerHTML = `
      <section class="hero">
        <img src="icons/icon-192.png" alt="" width="72" height="72">
        <h1>${esc(CONFIG.APP_NAME)}</h1>
        <p>Agenda, avisos e aniversariantes da sua igreja, no celular.</p>
        <a class="btn primary big" href="#/entrar">Entrar</a>
        <p class="hint">Sua igreja ainda não usa? Fale com a liderança dela.</p>
      </section>`;
    return;
  }
  const list = state.memberships;
  // Uma igreja só: vai direto para ela.
  if (list.length === 1 && !state.platformAdmin) {
    location.replace(churchUrl(list[0].church.slug));
    return;
  }
  $view.innerHTML = `
    <div class="page">
      <h1>Suas igrejas</h1>
      ${
        list.length
          ? `<div class="list">${list.map((m) => churchRow(m.church, `<small>${m.consent_at ? esc(ROLES[m.role]) : 'Convite para aceitar'}</small>`)).join('')}</div>`
          : `<div class="notice"><strong>Ainda não encontramos seu cadastro.</strong>
               <p>O e-mail ${esc(state.user.email)} não está no cadastro de nenhuma igreja. Peça à secretaria da sua igreja para cadastrar você com este e-mail e entre de novo.</p></div>`
      }
      ${state.platformAdmin ? `<a class="btn" href="#/plataforma">${icon.shield} Administração da plataforma</a>` : ''}
    </div>`;
}

async function viewAccount() {
  if (!requireLogin('/conta')) return;
  $view.innerHTML = `
    <div class="page">
      <h1>Sua conta</h1>
      <p class="hint">${esc(state.user.email)}</p>
      <div class="list">
        <a class="menu-row" href="#/">${icon.church}<span>Suas igrejas</span>${icon.chevron}</a>
        ${state.platformAdmin ? `<a class="menu-row" href="#/plataforma">${icon.shield}<span>Administração da plataforma</span>${icon.chevron}</a>` : ''}
        <a class="menu-row" href="#/meus-dados">${icon.user}<span>Meus dados</span>${icon.chevron}</a>
        <a class="menu-row" href="privacidade.html">${icon.shield}<span>Política de privacidade</span>${icon.chevron}</a>
        <a class="menu-row" href="termos.html">${icon.shield}<span>Termos de uso</span>${icon.chevron}</a>
        <button class="menu-row" id="logout">${icon.logout}<span>Sair</span></button>
      </div>
    </div>`;
  document.getElementById('logout').onclick = signOut;
}

// ---------------------------------------------------------------------
// Administração da plataforma: criar igrejas e definir o administrador de cada uma
// ---------------------------------------------------------------------
async function viewPlatform(ctx) {
  if (!requireLogin('/plataforma')) return;
  if (!state.platformAdmin) {
    $view.innerHTML = `<div class="empty"><h2>Área restrita</h2><p>Só o administrador da plataforma acessa esta página.</p><a class="btn" href="#/">Voltar</a></div>`;
    return;
  }
  const { data: churches, error } = await sb.from('churches').select('id, slug, name, logo_url, primary_color, active, created_at').order('name');
  if (error) throw error;
  if (!ctx.alive()) return;

  $view.innerHTML = `
    <div class="page">
      <h1>Plataforma</h1>
      <h2>Igrejas (${churches.length})</h2>
      <div class="list">
        ${churches
          .map(
            (c) => `
          <div class="platform-church ${c.active ? '' : 'inactive'}" data-id="${c.id}">
            ${churchRow(c, `<small>/i/${esc(c.slug)}/${c.active ? '' : ' · desativada'}</small>`)}
            <div class="row-actions">
              <button class="btn small" data-admin>Definir administrador</button>
              <button class="btn small ${c.active ? 'danger-outline' : ''}" data-active="${c.active ? 'false' : 'true'}">${c.active ? 'Desativar' : 'Reativar'}</button>
            </div>
          </div>`,
          )
          .join('')}
      </div>

      <form id="new-church" class="form card">
        <h2>Nova igreja</h2>
        <label>Nome da igreja<input name="name" required maxlength="80" placeholder="Igreja Batista Central"></label>
        <label>Endereço no app
          <span class="prefix-input"><span>/i/</span><input name="slug" required maxlength="40" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="batista-central"></span>
          <small class="hint">Letras minúsculas, números e hífens. Não dá para mudar depois.</small>
        </label>
        <label>E-mail do administrador da igreja<input name="email" type="email" required placeholder="pastor@exemplo.com"></label>
        <label>Nome do administrador<input name="admin_name" maxlength="120"></label>
        <button class="btn primary">Criar igreja</button>
        <p class="hint">O administrador entra no app com esse e-mail, aceita o convite e configura a igreja. O ícone próprio da igreja aparece na próxima publicação do site.</p>
      </form>
    </div>`;

  const form = document.getElementById('new-church');
  let slugTouched = false;
  form.slug.addEventListener('input', () => (slugTouched = true));
  form.name.addEventListener('input', () => {
    if (!slugTouched) form.slug.value = slugify(form.name.value);
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const slug = form.slug.value.trim();
    if (!isValidSlug(slug)) return toast('Endereço inválido: use de 3 a 40 letras minúsculas, números e hífens.', 'error');
    const btn = form.querySelector('button');
    btn.disabled = true;
    const { error } = await sb.rpc('create_church', {
      p_slug: slug,
      p_name: form.name.value.trim(),
      p_admin_email: form.email.value.trim(),
      p_admin_name: form.admin_name.value.trim() || null,
    });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    toast('Igreja criada.');
    await loadMemberships();
    render();
  });

  $view.querySelectorAll('.platform-church').forEach((row) => {
    const id = row.dataset.id;
    row.querySelector('[data-admin]').onclick = async () => {
      const email = await ask('E-mail do administrador desta igreja:', { input: 'email', ok: 'Salvar', placeholder: 'nome@exemplo.com' });
      if (!email) return;
      const { error } = await sb.rpc('set_church_admin', { p_church: id, p_email: email.trim(), p_name: null });
      if (error) return toast(errorText(error), 'error');
      toast(`Pronto. ${email.trim()} já pode entrar e aceitar o convite.`);
      await loadMemberships();
    };
    row.querySelector('[data-active]').onclick = async (e) => {
      const active = e.currentTarget.dataset.active === 'true';
      if (!active && !await ask('Desativar esta igreja? Ninguém mais acessa o app dela até você reativar.')) return;
      const { error } = await sb.rpc('set_church_active', { p_church: id, p_active: active });
      if (error) return toast(errorText(error), 'error');
      render();
    };
  });
}

// ---------------------------------------------------------------------
// Página da igreja
// ---------------------------------------------------------------------
// Só links https:// viram botão (um "javascript:" gravado direto no banco não roda; o banco também barra).
const safeLink = (v) => typeof v === 'string' && /^https:\/\/[^\s"<>'`]+$/i.test(v);

function socialLinks(c) {
  const links = SOCIAL.filter(([k]) => safeLink(c.social?.[k])).map(
    ([k, label]) => `<a class="chip" href="${esc(c.social[k])}" target="_blank" rel="noopener">${icon.link}${label}</a>`,
  );
  return links.length ? `<div class="chips">${links.join('')}</div>` : '';
}

function aboutCard(c) {
  if (!c.about_text && !c.address && !Object.keys(c.social || {}).length) return '';
  return `
    <section class="card">
      <h2>Sobre a igreja</h2>
      ${c.about_text ? `<p class="pre">${esc(c.about_text)}</p>` : ''}
      ${c.address ? `<p class="meta">${icon.pin}${esc(c.address)}${c.city ? ` · ${esc(c.city)}` : ''}</p>` : ''}
      ${placeBlock({ lat: c.lat, lng: c.lng, address: [c.address, c.city].filter(Boolean).join(', ') })}
      ${socialLinks(c)}
    </section>`;
}

// Convite: a secretaria cadastrou a pessoa; ela aceita participar pelo app (LGPD).
function viewInvite(m) {
  const c = state.church;
  $view.innerHTML = `
    <div class="page">
      <h1>Bem-vindo, ${esc(m.name.split(' ')[0])}!</h1>
      <div class="card">
        <p><strong>${esc(c.name)}</strong> cadastrou você no app da igreja.</p>
        <p>Para participar, a igreja guarda o seu nome, e-mail e, se você informou, telefone, data de nascimento e foto. Isso serve para os avisos, a agenda e as mensagens de aniversário.</p>
        <ul class="bullets">
          <li>As datas e o telefone ficam visíveis só para a liderança, a não ser que você autorize no seu cadastro.</li>
          <li>Você pode ver, corrigir, exportar e excluir os seus dados quando quiser.</li>
        </ul>
        <p class="hint">Leia a <a href="privacidade.html" target="_blank">Política de Privacidade</a>, os <a href="termos.html" target="_blank">Termos de uso</a>${c.privacy_text ? ` e o <a href="#/privacidade">complemento da igreja</a>` : ''}.</p>
        <button class="btn primary big" id="accept">Aceito participar</button>
        <button class="btn link" id="decline">Não sou desta igreja</button>
      </div>
    </div>`;
  document.getElementById('accept').onclick = async () => {
    const { error } = await sb.rpc('respond_to_church', { p_church: c.id, p_accept: true });
    if (error) return toast(errorText(error), 'error');
    await loadMemberships();
    renderAccountLink();
    render();
    maybeSuggestInstall(c);
  };
  document.getElementById('decline').onclick = async () => {
    if (!await ask(`Tirar o seu e-mail do cadastro de ${c.name}?`)) return;
    const { error } = await sb.rpc('respond_to_church', { p_church: c.id, p_accept: false });
    if (error) return toast(errorText(error), 'error');
    toast('Pronto. Seu e-mail saiu do cadastro desta igreja.');
    await loadMemberships();
    location.href = ROOT_URL;
  };
}

async function viewChurchHome() {
  const c = state.church;
  const m = myMember();
  if (m && !m.consent_at) return viewInvite(m);

  const head = `
    <section class="church-hero">
      <img src="${esc(c.logo_url || 'icons/icon-192.png')}" alt="" width="84" height="84">
      <h1>${esc(c.name)}</h1>
      ${c.welcome_text ? `<p>${esc(c.welcome_text)}</p>` : ''}
    </section>`;

  if (!state.user) {
    $view.innerHTML = `
      <div class="page">
        ${head}
        <a class="btn primary big" href="#/entrar">Entrar</a>
        <p class="hint center">Entre com o e-mail que você deu à secretaria da igreja.</p>
        ${offerReady() ? `<a class="btn" href="#/pix">${icon.pix} Pix da igreja</a>` : ''}
        
        ${aboutCard(c)}
      </div>`;
    return;
  }
  if (!m) {
    $view.innerHTML = `
      <div class="page">
        ${head}
        <div class="notice"><strong>Você ainda não está no cadastro desta igreja.</strong>
          <p>O e-mail ${esc(state.user.email)} não foi encontrado. Peça à secretaria para cadastrar você com este e-mail e entre de novo.</p></div>
        <button class="btn" id="logout">Entrar com outro e-mail</button>
        ${aboutCard(c)}
      </div>`;
    document.getElementById('logout').onclick = signOut;
    return;
  }

  const shortcuts = [
    ['agenda', icon.calendar, 'Agenda', '#/calendario'],
    ['avisos', icon.megaphone, 'Avisos', '#/avisos'],
    ['aniversarios', icon.cake, 'Aniversários', '#/aniversariantes'],
    ['salas', icon.child, 'Meus filhos', '#/filhos'],
    ['salas_tutor', icon.users, 'Salas', '#/salas'],
    ['carteirinha', icon.idcard, 'Carteirinha', '#/carteirinha'],
    ['galeria', icon.image, 'Galeria', '#/galeria'],
    ['pix', icon.pix, 'Pix', '#/pix'],
  ].filter(([k]) => (k === 'pix' ? offerReady() : k === 'aniversarios' ? datesOn() : k === 'salas_tutor' ? roomsTeam() : featureOn(k)));
  $view.innerHTML = `
    <div class="page">
      ${head}
      ${
        shortcuts.length
          ? `<div class="shortcuts">${shortcuts
              .map(([, ic, label, href]) =>
                href
                  ? `<a class="shortcut" href="${href}">${ic}<span>${label}</span></a>`
                  : `<div class="shortcut soon">${ic}<span>${label}</span><small>Em breve</small></div>`,
              )
              .join('')}</div>`
          : ''
      }
      <div class="carousel" id="home-carousel" hidden>
        <div class="carousel-track">
          <div class="slide" id="home-kids"></div>
          <div class="slide" id="home-notices"></div>
          <div class="slide" id="home-events"></div>
          <div class="slide" id="week-birthdays"></div>
        </div>
        <div class="carousel-dots"></div>
      </div>
      <div id="push-invite"></div>
      ${aboutCard(c)}
    </div>`;
  const slot = (id) => document.getElementById(id);
  const box = slot('home-carousel');
  const changed = () => setupCarousel(box);
  if (featureOn('salas')) homeKidsCard(slot('home-kids'), changed).catch(() => {});
  if (featureOn('avisos')) homeNoticesCard(slot('home-notices'), changed).catch(() => {});
  if (featureOn('agenda')) homeEventsCard(slot('home-events'), changed).catch(() => {});
  if (datesOn()) weekBirthdaysCard(slot('week-birthdays'), changed).catch(() => {});
  pushInvite(document.getElementById('push-invite')).catch(() => {});
  maybeSuggestInstall(c);
  prefetchMembers();
  prefetchScreens();
}

// Carrossel do Início: só os cartões com conteúdo; desliza para o lado e as bolinhas
// mostram (e levam a) cada cartão. Não passa sozinho. Pode ser chamado de novo quando um
// cartão muda (primeiro com o guardado no aparelho, depois com o que veio do banco).
function setupCarousel(box) {
  if (!box?.isConnected) return;
  const track = box.querySelector('.carousel-track');
  const all = [...track.querySelectorAll('.slide')];
  all.forEach((sl) => (sl.hidden = !sl.children.length));
  const slides = all.filter((sl) => !sl.hidden);
  box.hidden = !slides.length;
  const dots = box.querySelector('.carousel-dots');
  dots.hidden = slides.length < 2;
  if (slides.length < 2) return;
  const titleOf = (sl) => sl.querySelector('h2')?.textContent.trim() || 'Cartão';
  const step = () => slides[1].offsetLeft - slides[0].offsetLeft;
  const current = () => Math.min(slides.length - 1, Math.round(track.scrollLeft / step()));
  const at = current();
  dots.innerHTML = slides
    .map((sl, i) => `<button type="button" aria-label="${esc(titleOf(sl))}" ${i === at ? 'aria-current="true"' : ''}></button>`)
    .join('');
  const buttons = [...dots.children];
  buttons.forEach((b, i) => (b.onclick = () => track.scrollTo({ left: i * step(), behavior: 'smooth' })));
  track.onscroll = () => {
    const i = current();
    buttons.forEach((b, j) => (j === i ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
  };
}

async function viewMenu() {
  if (!requireLogin('/menu')) return;
  const m = myMember();
  if (!m?.consent_at) return navigate('/');
  const admin = m.role === 'admin';
  $view.innerHTML = `
    <div class="page">
      <h1>Menu</h1>
      <p class="hint">${esc(state.user.email)} · ${esc(ROLES[m.role])}</p>
      <div class="list">
        <a class="menu-row" href="#/perfil">${icon.user}<span>Meu cadastro</span>${icon.chevron}</a>
        ${isLeaderRole(m.role) ? `<a class="menu-row" href="#/membros">${icon.users}<span>Membros</span>${icon.chevron}</a>` : ''}
        ${admin ? `<a class="menu-row" href="#/config">${icon.gear}<span>Configurar a igreja</span>${icon.chevron}</a>` : ''}
        ${state.memberships.length > 1 || state.platformAdmin ? `<a class="menu-row" href="${esc(ROOT_URL)}">${icon.swap}<span>Trocar de igreja</span>${icon.chevron}</a>` : ''}
        ${featureOn('agenda') ? `<a class="menu-row" href="#/calendario">${icon.calendar}<span>Calendário</span>${icon.chevron}</a>` : ''}
        ${datesOn() ? `<a class="menu-row" href="#/aniversariantes">${icon.cake}<span>Aniversariantes do mês</span>${icon.chevron}</a>` : ''}
        ${featureOn('salas') ? `<a class="menu-row" href="#/filhos">${icon.child}<span>Meus filhos</span>${icon.chevron}</a>` : ''}
        ${roomsTeam() ? `<a class="menu-row" href="#/salas">${icon.users}<span>${isLeaderRole(m.role) ? 'Salas das crianças' : 'Minhas salas'}</span>${icon.chevron}</a>` : ''}
        ${featureOn('galeria') ? `<a class="menu-row" href="#/galeria">${icon.image}<span>Galeria de fotos</span>${icon.chevron}</a>` : ''}
        ${featureOn('carteirinha') ? `<a class="menu-row" href="#/carteirinha">${icon.idcard}<span>Minha carteirinha</span>${icon.chevron}</a>` : ''}
        ${offerReady() ? `<a class="menu-row" href="#/pix">${icon.pix}<span>Pix</span>${icon.chevron}</a>` : ''}
        <a class="menu-row" href="#/notificacoes">${icon.bell}<span>Notificações</span>${icon.chevron}</a>
        ${admin ? messageLinks() : ''}
        <a class="menu-row" href="#/meus-dados">${icon.user}<span>Meus dados: baixar ou excluir</span>${icon.chevron}</a>
        ${themeChosen() ? `<button class="menu-row" id="theme-auto">${currentTheme() === 'dark' ? icon.moon : icon.sun}<span>Tema: seguir o celular</span></button>` : ''}
        <a class="menu-row" href="#/ajuda">${icon.help}<span>Ajuda: como funciona</span>${icon.chevron}</a>
        <a class="menu-row" href="#/privacidade">${icon.shield}<span>Privacidade e termos</span>${icon.chevron}</a>
        <button class="menu-row" id="logout">${icon.logout}<span>Sair</span></button>
      </div>
    </div>`;
  document.getElementById('logout').onclick = signOut;
  document.getElementById('theme-auto')?.addEventListener('click', () => {
    setTheme(null);
    toast('Pronto: o tema volta a seguir o do celular.');
    render();
  });
}

async function viewChurchPrivacy() {
  const c = state.church;
  $view.innerHTML = `
    <div class="page">
      <h1>Privacidade</h1>
      <p>O app segue a <a href="privacidade.html">Política de Privacidade</a> e os <a href="termos.html">Termos de uso</a> do ${esc(CONFIG.APP_NAME)}.</p>
      ${c.privacy_text ? `<section class="card"><h2>Complemento de ${esc(c.name)}</h2><p class="pre">${esc(c.privacy_text)}</p></section>` : ''}
      ${c.privacy_email ? `<p>Pedidos sobre os seus dados nesta igreja: <a href="mailto:${esc(c.privacy_email)}">${esc(c.privacy_email)}</a>.</p>` : ''}
      ${state.user ? `<a class="btn" href="#/meus-dados">${icon.user} Baixar ou excluir os meus dados</a>` : ''}
    </div>`;
}

// ---------------------------------------------------------------------
// Meus dados (LGPD): baixar, sair desta igreja, excluir a conta
// ---------------------------------------------------------------------
async function viewMyData() {
  if (!requireLogin('/meus-dados')) return;
  const here = state.church ? myMember() : null;
  $view.innerHTML = `
    <div class="page">
      <h1>Meus dados</h1>
      <p class="hint">${esc(state.user.email)}</p>

      <section class="card">
        <h2>${icon.upload} Baixar meus dados</h2>
        <p>Um arquivo com tudo o que o app guarda sobre você: os seus cadastros em cada igreja, as suas células e presenças, os seus ministérios e escalas, as suas inscrições em eventos, os seus filhos e as entradas deles no infantil, as suas presenças nos cultos, os dados da carteirinha, os álbuns que publicou e os pedidos para tirar fotos, as suas conversas do chat, os seus pedidos de oração, os seus planos de leitura, as notificações, as mensagens enviadas, os aparelhos com notificação e o que você publicou.</p>
        <button class="btn" id="export">Baixar arquivo</button>
        <p class="hint">Para corrigir algum dado, use "Meu cadastro" ou fale com a secretaria da igreja.</p>
      </section>

      ${
        here
          ? `<section class="card">
              <h2>Sair da ${esc(state.church.name)}</h2>
              <p>O seu cadastro, a sua foto, os seus pedidos de oração e os seus planos de leitura nesta igreja são apagados, e você deixa de receber as mensagens dela. A sua conta e as outras igrejas continuam.</p>
              <button class="btn danger-outline" id="leave">Sair desta igreja</button>
            </section>`
          : ''
      }

      <section class="card danger-zone">
        <h2>Excluir minha conta</h2>
        <p>Apaga a sua conta e os seus cadastros em <strong>todas</strong> as igrejas, com fotos, pedidos de oração, notificações e aparelhos. Não dá para desfazer. Os eventos e avisos que você publicou continuam na igreja, sem o seu nome.</p>
        <label>Para confirmar, digite EXCLUIR<input id="confirm-delete" autocomplete="off" autocapitalize="characters"></label>
        <button class="btn danger-outline" id="delete" disabled>Excluir minha conta para sempre</button>
      </section>
    </div>`;

  // O botão fica numa variável: depois do "await", e.currentTarget já é null.
  const exportBtn = document.getElementById('export');
  exportBtn.onclick = async () => {
    exportBtn.disabled = true;
    const { data, error } = await sb.rpc('export_my_data');
    exportBtn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `meus-dados-${isoLocal(new Date())}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Arquivo baixado.');
  };

  const leaveBtn = document.getElementById('leave');
  leaveBtn?.addEventListener('click', async () => {
    if (!await ask(`Sair da ${state.church.name}? O seu cadastro nesta igreja será apagado.`)) return;
    leaveBtn.disabled = true;
    try {
      if (here.consent_at) await removeMemberPhotos(state.church.id, here.id);
      const { error } = await sb.rpc('leave_church', { p_church: state.church.id });
      if (error) throw error;
      await disablePushIfNoChurches();
      toast(`Você saiu da ${state.church.name}.`);
      location.href = ROOT_URL;
    } catch (err) {
      toast(errorText(err), 'error');
      leaveBtn.disabled = false;
    }
  });

  const confirmInput = document.getElementById('confirm-delete');
  const del = document.getElementById('delete');
  confirmInput.addEventListener('input', () => (del.disabled = confirmInput.value.trim().toUpperCase() !== 'EXCLUIR'));
  del.onclick = async () => {
    del.disabled = true;
    del.textContent = 'Excluindo…';
    try {
      for (const m of state.memberships.filter((x) => x.consent_at)) await removeMemberPhotos(m.church.id, m.id);
      await disablePush(sb).catch(() => {});
      const { error } = await sb.rpc('delete_my_account');
      if (error) throw error;
      clearBootCache();
      await sb.auth.signOut({ scope: 'local' });
      await ask('Sua conta foi excluída.', { readonly: true });
      location.href = ROOT_URL;
    } catch (err) {
      toast(errorText(err), 'error');
      del.disabled = false;
      del.textContent = 'Excluir minha conta para sempre';
    }
  };
}

// ---------------------------------------------------------------------
// Ajuda: como funciona e como configurar, conforme o papel de quem lê
// ---------------------------------------------------------------------
// Cada tópico: [título, texto em HTML]. Os textos não têm dados de ninguém, só explicações.
function helpTopics() {
  const c = state.church;
  const features = (k) => featureOn(k);
  const everyone = [
    [
      'Instalar o app no celular',
      `<p>Com o app na tela inicial, ele abre com um toque, com o nome e a logo da ${esc(c.name)}.</p>
       <ul class="bullets">
         <li><strong>Android (Chrome):</strong> toque nos três pontinhos ⋮ e em <em>Instalar app</em> ou <em>Adicionar à tela inicial</em>.</li>
         <li><strong>iPhone (Safari):</strong> toque em Compartilhar (o quadrado com a seta) e em <em>Adicionar à Tela de Início</em>.</li>
       </ul>
       <p>Depois, abra sempre pelo ícone.</p>
       <p>Se a igreja trocou o ícone depois que você instalou: no <strong>iPhone</strong>, o ícone não muda sozinho; apague o app da tela inicial e instale de novo. No <strong>Android</strong>, ele costuma se atualizar sozinho em alguns dias, ou na hora se você desinstalar e instalar de novo.</p>
       <div id="help-install"></div>`,
    ],
    [
      'Entrar no app',
      `<p>Use <strong>o mesmo e-mail que você deu à secretaria</strong>. É por ele que o app encontra o seu cadastro.</p>
       <ul class="bullets">
         <li><strong>Entrar com Google:</strong> o jeito mais rápido, se o seu e-mail for do Gmail.</li>
         <li><strong>Link pelo e-mail:</strong> você recebe um link; abra no mesmo aparelho e navegador em que pediu.</li>
       </ul>
       <p>Na primeira vez, aparece um convite: toque em <em>Aceito participar</em>. Se não for da igreja, toque em <em>Não sou desta igreja</em> e o seu e-mail sai do cadastro.</p>`,
    ],
    [
      'Notificações no celular',
      `<p>Em <a href="#/notificacoes">Menu &gt; Notificações</a>, toque em <em>Ativar neste aparelho</em>. Você recebe:</p>
       <ul class="bullets">
         ${features('aniversarios') ? '<li>a mensagem da igreja no dia do seu aniversário, às 7h;</li>' : ''}
         
         ${features('agenda') ? '<li>os lembretes dos eventos da agenda;</li>' : ''}
         ${features('avisos') ? '<li>os avisos que a liderança mandar com notificação (chegam em até uns 15 minutos);</li>' : ''}
         
       </ul>
       <p><strong>No iPhone</strong>, as notificações só funcionam com o app instalado na tela inicial. O sininho no topo guarda tudo, mesmo sem ativar no celular.</p>
       <p>Bloqueou sem querer? Libere as notificações deste site nas configurações do navegador e ative de novo.</p>`,
    ],
    ...(features('agenda')
      ? [[
          'Agenda',
          `<p>A aba <a href="#/calendario">Agenda</a> mostra os cultos e eventos em três vistas: <strong>Lista</strong> (os próximos 3 meses), <strong>Mês</strong> (o calendário do mês, com os aniversariantes 🎂) e <strong>Dia</strong> (os horários do dia). Toque num evento para ver os detalhes, o mapa do local e a rota pelo Google Maps ou pelo Waze.</p>
           <p><strong>Adicionar à agenda</strong> baixa um arquivo: abra-o para salvar na agenda do celular. Cultos que se repetem entram na agenda toda semana. Se preferir, use o botão <em>Google Agenda</em>.</p>${
             features('inscricoes')
               ? `<p><strong>Inscrições:</strong> nos eventos com inscrição (retiros, cursos), toque em <em>Quero me inscrever</em>. A confirmação chega no app e por e-mail. Se as vagas acabaram, você pode entrar na <strong>lista de espera</strong>: quando alguém cancelar, a vaga é sua automaticamente e você recebe um aviso. Se não puder ir, cancele pelo app para liberar a vaga. Ninguém vê quem mais se inscreveu.</p>`
               : ''
           }`,
        ]]
      : []),
    ...(features('avisos')
      ? [['Avisos', '<p>A aba <a href="#/avisos">Avisos</a> traz os recados da igreja. Os mais importantes ficam fixados no topo, e alguns somem depois de uma data.</p>']]
      : []),
    ...(datesOn()
      ? [[
          'Aniversariantes',
          `<p>Em <a href="#/aniversariantes">Menu &gt; Aniversariantes do mês</a> você vê quem faz aniversário, mês a mês, e pode imprimir a lista.</p>
           <p>As suas datas só aparecem para os outros membros se você autorizar em <em>Meu cadastro</em>, e só o dia e o mês, nunca o ano. A liderança sempre vê.</p>`,
        ]]
      : []),
    ...(features('galeria')
      ? [[
          'Galeria de fotos',
          `<p>Em <a href="#/galeria">Menu &gt; Galeria de fotos</a> ficam os álbuns da igreja. Toque numa foto para ver em tela cheia, passar para o lado, baixar ou compartilhar. Só quem é da igreja vê as fotos.</p>
           <p>Se você aparece numa foto e prefere que ela saia, toque em <em>Pedir para tirar esta foto</em>: quem publica a galeria recebe o pedido.</p>${
             galleryTeam()
               ? `<p><strong>Se você publica na galeria:</strong> toque no botão <strong>+</strong>, embaixo à direita, para criar o álbum e, dentro dele, em <em>Adicionar fotos</em> (dá para escolher várias de uma vez). O app reduz cada foto no celular antes de enviar, para gastar pouco espaço. A igreja pode ter até ${GALLERY_LIMIT} fotos: apague álbuns antigos quando chegar perto. Evite fotos de crianças em que elas apareçam de perto sem a autorização dos pais.</p>`
               : ''
           }`,
        ]]
      : []),
    ...(features('salas')
      ? [[
          'Meus filhos e as salas',
          `<p>Em <a href="#/filhos">Menu &gt; Meus filhos</a>, toque no botão <strong>+</strong>, embaixo à direita, e cadastre os seus filhos com a data de nascimento e, se houver, as alergias e os cuidados. Só você, o tutor da sala e a liderança veem.</p>
           <p>A liderança coloca cada criança numa sala. Tocando na sala, você vê o tutor, os avisos que ele mandou e as aulas: as anotações do dia e se o seu filho estava. Os avisos da sala também chegam na central de notificações e no celular.</p>${
             roomsTeam() && !isLeaderRole(myRole())
               ? '<p><strong>Se você é tutor:</strong> em <a href="#/salas">Menu &gt; Minhas salas</a>, abra a sala, escolha o dia da aula e marque quem veio. Escreva as <em>Anotações da aula</em> (os pais leem) e use <em>Avisar os pais</em> para mandar um recado (até 10 por dia). O WhatsApp de cada responsável fica ao lado do nome.</p>'
               : ''
           }`,
        ]]
      : []),
    ...(features('carteirinha')
      ? [[
          'Carteirinha digital',
          '<p>Em <a href="#/carteirinha">Menu &gt; Minha carteirinha</a> está a sua carteirinha de membro, com o QR Code. Ela abre mesmo sem internet. Toque em <em>Salvar imagem</em> para guardar na galeria do celular.</p><p>Quem apontar a câmera para o QR Code vê se você é membro ativo, com o nome, o papel e "membro desde" (sem foto, telefone ou e-mail). Se alguém copiou a sua carteirinha, toque em <em>Gerar novo QR Code</em>: o anterior deixa de valer.</p>',
        ]]
      : []),
    ...(offerReady()
      ? [[
          'Pix',
          `<p>Em <a href="#/pix">Pix</a>, aponte a câmera do app do seu banco para o QR Code, ou toque em <em>Copiar código Pix</em> e cole em <em>Pix &gt; Copia e cola</em>. Se quiser, digite o valor antes: ele já vem preenchido no banco.</p>
           <p>O dinheiro vai direto para a conta da igreja. O app não recebe, não processa e não guarda nada sobre a sua oferta. Confira o nome do recebedor no banco antes de confirmar.</p>`,
        ]]
      : []),
    [
      'Meu cadastro e privacidade',
      `<p>Em <a href="#/perfil">Menu &gt; Meu cadastro</a> você corrige o nome, o telefone, a data de nascimento e a foto, e escolhe se os outros membros veem essas datas e o seu telefone. Para trocar o e-mail, fale com a secretaria.</p>
       <p>Em <a href="#/meus-dados">Menu &gt; Meus dados</a> você baixa tudo o que o app guarda sobre você, sai desta igreja ou exclui a sua conta.</p>`,
    ],
    [
      'Participo de mais de uma igreja',
      '<p>Cada igreja tem o seu endereço e o seu ícone no celular. Para ir de uma para outra, use <em>Menu &gt; Trocar de igreja</em>.</p>',
    ],
    [
      'Problemas comuns',
      `<ul class="bullets">
         <li><strong>O link de acesso não chegou:</strong> olhe a caixa de spam. Se pedir muitas vezes, o envio espera alguns minutos. Se o seu e-mail for do Gmail, prefira <em>Entrar com Google</em>.</li>
         <li><strong>"Ainda não encontramos seu cadastro":</strong> você entrou com um e-mail diferente do que a secretaria tem. Peça para conferir.</li>
         <li><strong>O app parece desatualizado:</strong> feche e abra de novo.</li>
         <li><strong>A notificação não chega:</strong> confira em <em>Menu &gt; Notificações</em> se está ativada neste aparelho e, no iPhone, se você abriu pelo ícone da tela inicial.</li>
       </ul>`,
    ],
  ];

  const leaders = [
    [
      'O que cada papel faz',
      `<table class="help-table">
         <tr><th>Administrador</th><td>Tudo da liderança, mais: configura a igreja, define os papéis, desliga contas e escreve a mensagem de aniversário.</td></tr>
         <tr><th>Secretaria</th><td>Cadastra, edita, inativa e exclui membros; publica eventos e avisos.</td></tr>
         <tr><th>Líder</th><td>Cadastra, edita e inativa membros (não exclui); publica eventos e avisos.</td></tr>
         <tr><th>Membro</th><td>Vê a agenda, os avisos e os aniversariantes que autorizaram; edita os próprios dados.</td></tr>
       </table>
       <p>Administrador, secretaria e líderes formam a liderança: veem o cadastro completo de todos e recebem o resumo dos aniversariantes. Use esse acesso só para cuidar da igreja.</p>`,
    ],
    [
      'Cadastrar membros',
      `<p>Na aba <a href="#/membros">Membros</a>, toque no botão <strong>+</strong>, embaixo à direita, e em <em>Novo membro</em>. Só o nome é obrigatório, mas <strong>sem e-mail a pessoa não consegue entrar no app</strong>. Marque que a pessoa concordou em ter os dados no app.</p>
       <p>A etiqueta de cada pessoa mostra a situação:</p>
       <ul class="bullets">
         <li><strong>Ainda não entrou:</strong> tem e-mail, mas ainda não abriu o app. Mande o endereço do app para ela.</li>
         <li><strong>Convite pendente:</strong> já entrou, falta tocar em <em>Aceito participar</em>.</li>
         <li><strong>No app:</strong> tudo certo.</li>
         <li><strong>Sem e-mail:</strong> não entra no app, mas aparece na lista de membros e nos aniversariantes.</li>
       </ul>
       <p>Quem saiu da igreja pode ficar <em>Inativo</em>: some das listas e não acessa o app, mas o cadastro fica guardado. Para inativar, arraste a pessoa para a esquerda na lista (ou mude a <em>Situação</em> no cadastro dela); em <em>Inativos</em>, o mesmo gesto reativa.</p>`,
    ],
    [
      'Importar uma planilha de membros',
      `<p>Em <a href="#/membros/importar">Membros &gt; + &gt; Importar planilha</a>, toque em <em>Baixar modelo</em> e preencha no Excel ou no Google Planilhas, com as colunas <strong>nome</strong>, <strong>email</strong>, <strong>telefone</strong> e <strong>nascimento</strong> (datas como 15/03/1980).</p>
       <p>Salve como <strong>CSV</strong> e escolha o arquivo. O app mostra uma prévia antes de gravar: as linhas com erro são explicadas, e quem já tem o e-mail cadastrado é pulado.</p>`,
    ],
    ...(features('agenda')
      ? [[
          'Criar eventos e cultos',
          `<p>Na <a href="#/calendario">Agenda</a>, toque no dia do calendário e no botão <strong>+</strong>, embaixo à direita (ou no <strong>+</strong> da lista). Para os cultos fixos, marque <strong>Repetir toda semana</strong> (e, se quiser, até quando).</p>
           <p>Em <strong>Marcar no mapa</strong>, busque o endereço ou toque no ponto exato: quem abrir o evento vê o mapa e tem os botões de rota pelo Google Maps e pelo Waze. O mesmo vale para o endereço da igreja.</p>
           
           <p>Escolha o <strong>lembrete</strong>: os membros com notificação ativada recebem 1 hora, 2 horas, 3 horas ou 1 dia antes. Editar ou excluir um evento que se repete vale para todas as semanas.</p>`,
        ]]
      : []),
    ...(features('salas')
      ? [[
          'Salas das crianças',
          `<p>Em <a href="#/salas">Menu &gt; Salas das crianças</a>, toque no <strong>+</strong> para criar a sala (ex.: Maternal, Kids) e escolha o <strong>tutor</strong>: um membro da igreja que usa o app. Ele passa a ver a sala em <em>Minhas salas</em>.</p>
           <p>Em <em>Todas as crianças</em>, toque na criança e escolha a sala. Os pais cadastram os filhos em <em>Meus filhos</em>; quem não usa o app pode ser cadastrado aqui, com o nome e o WhatsApp do responsável.</p>
           <p>Na sala, a liderança e o tutor marcam a presença de cada aula, escrevem as anotações do dia (os pais leem) e mandam avisos para os pais. Presenças, anotações e avisos são apagados depois de 12 meses.</p>`,
        ]]
      : []),
    ...(features('avisos')
      ? [[
          'Publicar avisos',
          `<p>Em <a href="#/avisos">Avisos</a>, toque no botão <strong>+</strong>, embaixo à direita. Você pode <strong>fixar no topo</strong> e escolher <strong>até quando</strong> ele aparece (depois some para os membros, mas a liderança continua vendo).</p>
           <p>Marque <strong>Mandar notificação para os membros</strong> só nos avisos importantes. Isso só pode ser escolhido ao publicar.</p>`,
        ]]
      : []),
  ];

  const admins = [
    [
      'Configurar a igreja',
      `<p>Em <a href="#/config">Menu &gt; Configurar a igreja</a>:</p>
       <ul class="bullets">
         <li><strong>Aparência:</strong> nome, nome curto (o que aparece embaixo do ícone), logo e cores. Logo em PNG com fundo transparente fica melhor; escolha o fundo do ícone. Se a cor for clara demais, o app avisa.</li>
         <li><strong>Textos e redes sociais:</strong> boas-vindas, sobre a igreja, endereço e links.</li>
         <li><strong>Pix:</strong> o tipo e a chave Pix da igreja e o nome do recebedor. Prefira o CNPJ ou uma chave aleatória: a chave fica visível para qualquer pessoa.</li>
         <li><strong>Funcionalidades:</strong> ligue ou desligue os aniversários, a agenda e o calendário, os avisos, Meus filhos e as salas das crianças, a carteirinha digital, a galeria de fotos e o Pix.</li>
         <li><strong>Privacidade:</strong> o e-mail para pedidos sobre dados pessoais e, se quiser, um complemento da política.</li>
       </ul>
       <p>O nome e o ícone do app instalado mudam em até 15 minutos, quando o site é publicado de novo sozinho. Até lá, o botão de instalar avisa que o ícone está sendo preparado. Quem já instalou pode precisar reinstalar para ver o ícone novo.</p>`,
    ],
    ...(features('aniversarios')
      ? [[
          'Mensagem de aniversário',
          `<p>Em <a href="#/config/aniversario">Menu &gt; Mensagem de aniversário</a>, escreva o título e o texto. Toque nos campos para colocar no texto: <code>{nome}</code>, <code>{primeiro_nome}</code>, <code>{igreja}</code> e <code>{idade}</code>. A prévia mostra como fica. Para alegrar, toque nos emojis embaixo (🎂 🎉 🙏…) ou use os do teclado do celular.</p>
           <p>A mensagem sai às 7h (horário de Brasília). Quem nasceu em 29/02 recebe em 28/02 nos anos que não são bissextos. Você pode pôr uma imagem e ligar o <strong>resumo para a liderança</strong> (aniversariantes do dia e, às segundas, os da semana).</p>
           <p>Ela vai por notificação no celular (para quem ativou), fica na central do app e vai por e-mail para quem tem e-mail no cadastro.</p>`,
        ]]
      : []),
    [
      'Papéis, contas e exclusões',
      `<ul class="bullets">
         <li>Para mudar o papel de alguém, abra a ficha em <em>Membros</em> e escolha o papel. A igreja precisa ter sempre pelo menos um administrador.</li>
         <li>Se a pessoa errada entrou com um e-mail, use <em>Desligar a conta do app</em> na ficha. Depois você pode corrigir o e-mail.</li>
         <li><em>Excluir cadastro</em> apaga os dados e a foto de vez (administrador e secretaria).</li>
       </ul>`,
    ],
    [
      'Divulgar o app para a igreja',
      `<p>Mande este endereço pelo WhatsApp ou mostre no telão. Cada pessoa entra com o e-mail que a secretaria cadastrou.</p>
       <div class="copy-row"><code id="app-url">${esc(PAGE_URL)}</code><button class="btn small" id="copy-url" type="button">Copiar</button></div>`,
    ],
  ];

  const role = myRole();
  return [
    { title: 'Para todos', items: everyone },
    ...(isLeaderRole(role) ? [{ title: 'Para a liderança', items: leaders }] : []),
    ...(role === 'admin' ? [{ title: 'Para o administrador', items: admins }] : []),
  ];
}

async function viewHelp() {
  if (!requireLogin('/ajuda')) return;
  if (!isActiveMember()) return navigate('/');
  const groups = helpTopics();
  $view.innerHTML = `
    <div class="page help-page">
      <h1>Ajuda</h1>
      <p class="hint">Como usar o app da ${esc(state.church.name)}. Toque num assunto para abrir.</p>
      ${groups
        .map(
          (g) => `
        <h2>${g.title}</h2>
        ${g.items.map(([title, body]) => `<details class="help-item"><summary>${esc(title)}</summary><div class="help-body">${body}</div></details>`).join('')}`,
        )
        .join('')}
      ${state.platformAdmin ? `<p class="hint">Administrador da plataforma: novas igrejas são criadas em <a href="${esc(ROOT_URL)}#/plataforma">Plataforma</a>.</p>` : ''}
      <p class="hint">Ainda com dúvida? Fale com a secretaria da igreja.</p>
    </div>`;

  const installBox = document.getElementById('help-install');
  const st = installState();
  installBox.innerHTML =
    st === 'instalado'
      ? '<p class="ok">✓ Você já está usando o app instalado.</p>'
      : !iconReady(state.church)
        ? `<p class="notice">${ICON_PREPARING}</p>`
        : st === 'android' || st === 'iphone'
        ? '<button class="btn primary small" id="install-now" type="button">Instalar agora</button>'
        : '';
  document.getElementById('install-now')?.addEventListener('click', async () => {
    if (await installNow()) toast('App instalado.');
  });
  document.getElementById('copy-url')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(PAGE_URL);
      toast('Endereço copiado.');
    } catch {
      toast('Não foi possível copiar. Selecione o endereço e copie.', 'error');
    }
  });
}

// Sem nenhuma igreja, este aparelho não tem por que continuar recebendo notificações.
async function disablePushIfNoChurches() {
  await loadMemberships();
  if (!state.memberships.length) await disablePush(sb).catch(() => {});
}

// Datas de casamento e batismo (com a funcionalidade "datas_especiais" ligada).
function specialDateFields(m) {
  if (!featureOn('datas_especiais')) return '';
  return `
      <label>Data de casamento<input name="wedding_date" type="date" min="1900-01-01" value="${esc(m.wedding_date || '')}"></label>
      <label>Data de batismo<input name="baptism_date" type="date" min="1900-01-01" value="${esc(m.baptism_date || '')}"></label>`;
}

function specialDatesPatch(form, withConsent = false) {
  if (!form.wedding_date) return {};
  return {
    wedding_date: form.wedding_date.value || null,
    baptism_date: form.baptism_date.value || null,
    ...(withConsent ? { show_wedding: form.show_wedding.checked, show_baptism: form.show_baptism.checked } : {}),
  };
}

// ---------------------------------------------------------------------
// Meu cadastro: o membro edita os próprios dados e as autorizações
// ---------------------------------------------------------------------
async function loadProfile(id) {
  const { data, error } = await sb.from('members').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

async function viewProfile(ctx) {
  if (!requireLogin('/perfil')) return;
  const me = myMember();
  if (!me?.consent_at) return navigate('/');
  const cached = screenCached('perfil');
  const m = cached && cached.id === me.id ? cached : await screenFetch('perfil', () => loadProfile(me.id));
  if (!ctx.alive()) return;
  if (m === cached) formFresh(ctx, cached, () => screenFetch('perfil', () => loadProfile(me.id)), () => {});
  const photoUrl = photoNow(m.photo_path);
  $view.innerHTML = `
    <form id="profile" class="form page">
      <h1>Meu cadastro</h1>
      <p class="hint">${esc(m.email || state.user.email)} · ${esc(ROLES[m.role])}</p>
      ${photoField(m.name, photoUrl)}
      <label>Nome<input name="name" required minlength="2" maxlength="120" value="${esc(m.name)}"></label>
      <label>Telefone com DDD<input name="phone" type="tel" inputmode="tel" placeholder="(61) 99999-9999" value="${esc(fmtPhone(m.phone))}"></label>
      <label>Data de nascimento<input name="birth_date" type="date" min="1900-01-01" value="${esc(m.birth_date || '')}"></label>
      ${specialDateFields(m)}
      <fieldset class="card">
        <legend>O que os outros membros veem</legend>
        <p class="hint">A liderança da igreja sempre vê os seus dados. Os outros membros veem só o seu nome, a não ser que você autorize:</p>
        <label class="check"><input type="checkbox" name="show_birthday" ${m.show_birthday ? 'checked' : ''}> Meu aniversário (dia e mês, nunca o ano)</label>
        ${
          featureOn('datas_especiais')
            ? `<label class="check"><input type="checkbox" name="show_wedding" ${m.show_wedding ? 'checked' : ''}> Meu aniversário de casamento (dia e mês)</label>
               <label class="check"><input type="checkbox" name="show_baptism" ${m.show_baptism ? 'checked' : ''}> Meu aniversário de batismo (dia e mês)</label>`
            : ''
        }
        <label class="check"><input type="checkbox" name="show_phone" ${m.show_phone ? 'checked' : ''}> Meu telefone</label>
      </fieldset>
      ${
        featureOn('chat')
          ? `<label class="check"><input type="checkbox" name="chat_enabled" ${m.chat_enabled !== false ? 'checked' : ''}> Receber mensagens pelo chat
              <small class="hint">Desligado, ninguém começa conversa nova com você nem escreve nas antigas. Você continua vendo e respondendo as conversas que já tem.</small></label>`
          : ''
      }
      <button class="btn primary big">Salvar</button>
      <p class="hint">Para trocar o e-mail, fale com a secretaria da igreja.</p>
    </form>`;
  const form = document.getElementById('profile');
  photoLater(ctx, form, m.name, m.photo_path);
  const photo = bindPhotoField(form, m.name);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const phoneRaw = form.phone.value.trim();
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) return toast('Telefone inválido. Use o DDD e o número, como (61) 99999-9999.', 'error');
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    try {
      const patch = {
        name: form.name.value.trim(),
        phone,
        birth_date: form.birth_date.value || null,
        show_birthday: form.show_birthday.checked,
        show_phone: form.show_phone.checked,
        ...(form.chat_enabled ? { chat_enabled: form.chat_enabled.checked } : {}),
        ...specialDatesPatch(form, true),
      };
      if (photo.file) patch.photo_path = await uploadMemberPhoto(m.church_id, m.id, photo.file);
      else if (photo.removed && m.photo_path) {
        await removeMemberPhotos(m.church_id, m.id);
        patch.photo_path = null;
      }
      const { error: err } = await sb.from('members').update(patch).eq('id', m.id);
      if (err) throw err;
      forgetMembers();
      screenForget('perfil');
      m.photo_path = patch.photo_path === undefined ? m.photo_path : patch.photo_path;
      photo.reset();
      toast('Cadastro salvo.');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------
// Fotos dos membros: pasta privada <igreja>/<membro>/ com foto.* (1080 px) e mini.* (400 px).
// A tela usa links temporários (1 hora), porque a pasta não é pública.
// ---------------------------------------------------------------------
const miniOf = (path) => path.replace(/\/foto\.(\w+)$/, '/mini.$1');

// Links das fotos (válidos por 1 hora) guardados em memória por 50 minutos: o mesmo link
// deixa o navegador reaproveitar a foto já baixada, em vez de baixar tudo de novo.
const photoLinks = new Map(); // caminho -> { url, until }

async function signedPhotos(paths) {
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const p of paths) {
    const hit = photoLinks.get(p);
    if (hit && hit.until > now) out[p] = hit.url;
    else missing.push(p);
  }
  if (!missing.length) return out;
  const { data, error } = await sb.storage.from('membros').createSignedUrls(missing, 3600);
  if (error) return out;
  for (const d of data) {
    if (!d.signedUrl) continue;
    photoLinks.set(d.path, { url: d.signedUrl, until: now + 50 * 60 * 1000 });
    out[d.path] = d.signedUrl;
  }
  return out;
}

// Lista de membros da última abertura da tela, em memória (some ao fechar o app).
// Mostra na hora ao voltar para a lista; o banco confirma em seguida.
const membersCache = new Map(); // igreja -> membros
const forgetMembers = () => {
  membersCache.delete(state.church?.id);
  membersLoading.delete(state.church?.id);
};

// Uma busca por vez: quem chega enquanto ela está a caminho aproveita a mesma resposta.
const membersLoading = new Map(); // igreja -> busca em andamento
function fetchMembers(churchId) {
  if (!membersLoading.has(churchId)) {
    const p = (async () => {
      const { data, error } = await sb.from('members').select(MEMBER_COLUMNS).eq('church_id', churchId).order('name');
      if (error) throw error;
      if (membersLoading.get(churchId) === p) membersCache.set(churchId, data); // não foi descartada por uma mudança
      return data;
    })().finally(() => {
      if (membersLoading.get(churchId) === p) membersLoading.delete(churchId);
    });
    membersLoading.set(churchId, p);
  }
  return membersLoading.get(churchId);
}

// No Início, a liderança já busca a lista em segundo plano: a tela Membros abre na hora.
function prefetchMembers() {
  const id = state.church?.id;
  if (!id || !isLeaderRole(myRole()) || membersCache.has(id)) return;
  setTimeout(
    () =>
      fetchMembers(id)
        .then((ms) => signedPhotos(ms.filter((m) => m.photo_path).map((m) => miniOf(m.photo_path))))
        .catch(() => {}),
    300,
  );
}

async function removeMemberPhotos(churchId, memberId) {
  const bucket = sb.storage.from('membros');
  const dir = `${churchId}/${memberId}`;
  for (const p of photoLinks.keys()) if (p.startsWith(`${dir}/`)) photoLinks.delete(p);
  const { data } = await bucket.list(dir);
  if (data?.length) {
    const { error } = await bucket.remove(data.map((f) => `${dir}/${f.name}`));
    if (error) throw error;
  }
}

async function uploadMemberPhoto(churchId, memberId, file) {
  const [big, small] = await Promise.all([resizeImage(file, 1080, 0.8), resizeImage(file, 400, 0.75)]);
  const ext = big.type === 'image/webp' ? 'webp' : 'jpg';
  await removeMemberPhotos(churchId, memberId);
  const bucket = sb.storage.from('membros');
  const dir = `${churchId}/${memberId}`;
  for (const [name, blob] of [['foto', big], ['mini', small]]) {
    const { error } = await bucket.upload(`${dir}/${name}.${ext}`, blob, { contentType: blob.type, cacheControl: '300', upsert: true });
    if (error) throw error;
  }
  return `${dir}/foto.${ext}`;
}

const initials = (name) =>
  esc(
    String(name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );

const avatar = (name, url, size = '') =>
  `<span class="avatar ${size}">${url ? `<img src="${esc(url)}" alt="">` : `<b class="initials">${initials(name)}</b>`}</span>`;

// Cor: o quadradinho que abre a paleta e, ao lado, o código (ex.: #2c3666) para digitar ou colar.
const colorField = (label, name, value) => `
  <label>${label}
    <span class="color-pick">
      <input type="color" name="${name}" value="${esc(value)}">
      <input type="text" class="color-code" data-for="${name}" value="${esc(value)}" maxlength="7" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Código da cor (${label.toLowerCase()})">
    </span>
  </label>`;

// Liga cada código à sua cor, nos dois sentidos. O código vale quando é uma cor completa
// ("2c3666", "#2C3666" ou "#abc"); ao sair do campo com um código incompleto, volta o da cor.
function bindColorFields(form) {
  for (const code of form.querySelectorAll('.color-code')) {
    const color = form[code.dataset.for];
    color.addEventListener('input', () => {
      if (document.activeElement !== code) code.value = color.value; // não reescreve no meio da digitação
    });
    code.addEventListener('input', () => {
      const hex = normalizeHex(code.value);
      code.classList.toggle('invalid', !hex && code.value.trim() !== '');
      if (!hex || hex === color.value) return;
      color.value = hex;
      color.dispatchEvent(new Event('input')); // prévia do ícone e avisos de cor
    });
    code.addEventListener('blur', () => {
      code.value = color.value;
      code.classList.remove('invalid');
    });
  }
}

function photoField(name, url) {
  return `
    <div class="photo-field">
      <span id="photo-preview">${avatar(name, url, 'big')}</span>
      <div>
        <label class="btn small">${url ? 'Trocar a foto' : 'Escolher foto'}<input type="file" name="photo" accept="image/*" hidden></label>
        <button type="button" class="btn link small" id="photo-remove" ${url ? '' : 'hidden'}>Remover foto</button>
        <p class="hint">Opcional. A foto é reduzida no celular antes do envio.</p>
      </div>
    </div>`;
}

// Liga o campo de foto: guarda o arquivo escolhido ou o pedido de remoção, e mostra a prévia.
function bindPhotoField(form, name) {
  const state = { file: null, removed: false, reset() {
    this.file = null;
    this.removed = false;
  } };
  const preview = form.querySelector('#photo-preview');
  const removeBtn = form.querySelector('#photo-remove');
  form.photo.addEventListener('change', () => {
    const file = form.photo.files[0];
    if (!file) return;
    state.file = file;
    state.removed = false;
    preview.innerHTML = avatar(name, URL.createObjectURL(file), 'big');
    removeBtn.hidden = false;
  });
  removeBtn.onclick = () => {
    state.file = null;
    state.removed = true;
    form.dataset.photoRemoved = '1';
    form.photo.value = '';
    preview.innerHTML = avatar(name, null, 'big');
    removeBtn.hidden = true;
  };
  return state;
}

// ---------------------------------------------------------------------
// Membros (liderança): lista, ficha, importação por planilha
// ---------------------------------------------------------------------
function requireLeader(next) {
  if (!requireLogin(next)) return false;
  if (isLeaderRole(myRole())) return true;
  $view.innerHTML = `<div class="empty"><h2>Só para a liderança</h2><p>A lista de membros fica com a secretaria, os líderes e o administrador da igreja.</p><a class="btn" href="#/">Voltar</a></div>`;
  return false;
}

// Situação da conta no app: o que a secretaria precisa saber para ajudar a pessoa a entrar.
function accountStatus(m) {
  if (m.consent_at) return { cls: 'ok', label: 'No app' };
  if (m.user_id) return { cls: 'wait', label: 'Convite pendente' };
  if (m.email) return { cls: '', label: 'Ainda não entrou' };
  return { cls: '', label: 'Sem e-mail' };
}

const MEMBER_COLUMNS = 'id, church_id, name, email, phone, birth_date, role, status, gallery_publisher, user_id, consent_at, photo_path, show_birthday, show_phone, wedding_date, baptism_date, show_wedding, show_baptism, member_since';

async function viewMembers(ctx) {
  if (!requireLeader('/membros')) return;
  const churchId = state.church.id;
  let members = membersCache.get(churchId);
  const fresh = fetchMembers(churchId);
  if (!members) {
    $view.innerHTML = '<div class="page"><h1>Membros</h1><div class="loading">Carregando…</div></div>';
    members = await fresh;
  } else {
    fresh.catch(() => {}); // a lista guardada já está na tela; a nova chega em seguida
  }
  if (!ctx.alive()) return;
  // As fotos chegam depois da lista: até lá, as iniciais.
  let minis = {};
  const loadPhotos = async () => {
    minis = await signedPhotos(members.filter((m) => m.photo_path).map((m) => miniOf(m.photo_path)));
    if (ctx.alive()) draw();
  };

  const filter = ctx.params.get('ver') || 'ativo';
  $view.innerHTML = `
    <div class="page">
      <h1>Membros</h1>
      <label class="search">${icon.search}<input type="search" id="q" placeholder="Buscar por nome, e-mail ou telefone" aria-label="Buscar membros"></label>
      <div class="chips filters">
        ${[['ativo', 'Ativos'], ['inativo', 'Inativos'], ['todos', 'Todos']]
          .map(([k, label]) => `<a class="chip ${filter === k ? 'active' : ''}" href="#/membros?ver=${k}">${label}</a>`)
          .join('')}
      </div>
      <p class="hint" id="count"></p>
      <p class="hint swipe-hint" id="swipe-hint">Arraste um membro para a esquerda para ${
        { ativo: 'inativar', inativo: 'reativar' }[filter] || 'inativar ou reativar'
      }.</p>
      <div class="list" id="members"></div>
      ${fabMenu('Adicionar membros', [['#/membros/novo', 'Novo membro'], ['#/membros/importar', 'Importar planilha']])}
    </div>`;

  const list = document.getElementById('members');
  const q = document.getElementById('q');
  const draw = () => {
    const term = fold(q.value);
    const digits = q.value.replace(/\D/g, '');
    const rows = members.filter(
      (m) =>
        (filter === 'todos' || m.status === filter) &&
        (!term || fold(m.name).includes(term) || fold(m.email).includes(term) || (digits.length >= 3 && (m.phone || '').includes(digits))),
    );
    const total = members.filter((m) => filter === 'todos' || m.status === filter).length;
    document.getElementById('count').textContent =
      rows.length === total ? `${total} ${total === 1 ? 'pessoa' : 'pessoas'}` : `${rows.length} de ${total}`;
    document.getElementById('swipe-hint').hidden = !rows.length;
    list.innerHTML = rows.length
      ? rows
          .map((m) => {
            const st = accountStatus(m);
            const off = m.status === 'inativo';
            // O próprio cadastro não arrasta: inativar a si mesmo tira o acesso.
            const me = m.user_id === state.user.id;
            const row = `
          <a class="member-row ${off ? 'inactive' : ''} ${me ? '' : 'swipe-row'}" href="#/membros/${m.id}" draggable="false">
            ${avatar(m.name, m.photo_path && minis[miniOf(m.photo_path)])}
            <span><strong>${esc(m.name)}</strong><small>${esc(m.email || fmtPhone(m.phone) || '')}</small></span>
            <span class="tags">
              ${m.role !== 'membro' ? `<span class="tag role">${esc(ROLES[m.role])}</span>` : ''}
              <span class="tag ${st.cls}">${st.label}</span>
            </span>
          </a>`;
            return me
              ? row
              : `<div class="swipe" data-id="${m.id}"><span class="swipe-bg ${off ? 'ok' : ''}" aria-hidden="true">${off ? 'Reativar' : 'Inativar'}</span>${row}</div>`;
          })
          .join('')
      : `<div class="empty"><p>${members.length ? 'Ninguém encontrado.' : 'Nenhum membro cadastrado ainda.'}</p></div>`;
  };
  q.addEventListener('input', draw);

  // Arrastar para a esquerda inativa (ou reativa quem está inativo), com "Desfazer" no aviso.
  // Quem pode mudar a situação, e a proteção do último admin, ficam no banco.
  const setStatus = async (m, status) => {
    const { data, error } = await sb.from('members').update({ status }).eq('id', m.id).select('id');
    if (error) throw error;
    if (!data.length) throw new Error('Você não tem permissão para mudar este cadastro.');
    m.status = status;
    membersCache.set(churchId, members);
    if (ctx.alive()) draw();
  };
  swipeLeft(list, async (wrap) => {
    const m = members.find((x) => x.id === wrap.dataset.id);
    const was = m.status;
    try {
      await setStatus(m, was === 'ativo' ? 'inativo' : 'ativo');
    } catch (err) {
      toast(errorText(err), 'error');
      return false;
    }
    toast(was === 'ativo' ? `${m.name} foi para Inativos.` : `${m.name} voltou para Ativos.`, '', {
      label: 'Desfazer',
      run: () => setStatus(m, was).catch((err) => toast(errorText(err), 'error')),
    });
    return true;
  });
  draw();
  loadPhotos().catch(() => {});

  // Lista guardada na tela: confere com o banco e redesenha se mudou.
  const latest = await fresh.catch(() => null);
  if (latest && ctx.alive() && JSON.stringify(latest) !== JSON.stringify(members)) {
    members = latest;
    draw();
    loadPhotos().catch(() => {});
  }
}

async function viewMemberForm(ctx, id) {
  if (!requireLeader(id ? `/membros/${id}` : '/membros/novo')) return;
  const isNew = !id;
  let m = { name: '', email: '', phone: '', birth_date: '', role: 'membro', status: 'ativo' };
  let photoUrl = null;
  if (!isNew) {
    const data = await editItem(
      ctx,
      membersCache.get(state.church.id)?.find((x) => x.id === id),
      async () => {
        const { data: row, error } = await sb.from('members').select(MEMBER_COLUMNS).eq('id', id).maybeSingle();
        if (error) throw error;
        return row;
      },
      () => forgetMembers(),
    );
    if (!data) {
      $view.innerHTML = `<div class="empty"><h2>Cadastro não encontrado</h2><a class="btn" href="#/membros">Voltar aos membros</a></div>`;
      return;
    }
    m = data;
    photoUrl = photoNow(m.photo_path);
  }
  if (!ctx.alive()) return;

  const role = myRole();
  const admin = role === 'admin';
  const canDelete = !isNew && ['admin', 'secretaria'].includes(role) && m.user_id !== state.user.id;
  const linked = !!m.user_id;
  const st = isNew ? null : accountStatus(m);

  $view.innerHTML = `
    <form id="member" class="form page">
      <a href="#/membros" class="back">← Membros</a>
      <h1>${isNew ? 'Novo membro' : esc(m.name)}</h1>
      ${st ? `<p><span class="tag ${st.cls}">${st.label}</span></p>` : ''}
      ${photoField(m.name, photoUrl)}
      <label>Nome<input name="name" required minlength="2" maxlength="120" value="${esc(m.name)}"></label>
      <label>E-mail
        <input name="email" type="email" maxlength="160" value="${esc(m.email || '')}" ${linked ? 'disabled' : ''}>
        <small class="hint">${
          linked
            ? 'A pessoa já entrou no app com este e-mail. Para trocar, o administrador desliga a conta primeiro.'
            : 'Com o e-mail, a pessoa entra no app e a conta é ligada a este cadastro.'
        }</small>
      </label>
      <label>Telefone com DDD<input name="phone" type="tel" inputmode="tel" placeholder="(61) 99999-9999" value="${esc(fmtPhone(m.phone))}"></label>
      <label>Data de nascimento<input name="birth_date" type="date" min="1900-01-01" value="${esc(m.birth_date || '')}"></label>
      ${specialDateFields(m)}
      ${featureOn('carteirinha') ? `<label>Membro desde (opcional)<input name="member_since" type="date" min="1900-01-02" value="${esc(m.member_since || '')}"><small class="hint">Aparece na carteirinha digital.</small></label>` : ''}
      <label>Papel na igreja
        <select name="role" ${admin ? '' : 'disabled'}>
          ${Object.entries(ROLES).map(([k, label]) => `<option value="${k}" ${m.role === k ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
        ${admin ? '' : '<small class="hint">Só o administrador muda o papel.</small>'}
      </label>
      ${
        admin && featureOn('galeria')
          ? `<label class="check"><input type="checkbox" name="gallery_publisher" ${m.gallery_publisher ? 'checked' : ''}> Publica na galeria
              <small class="hint">Cria álbuns e envia fotos na Galeria, como a liderança.</small></label>`
          : ''
      }
      ${
        isNew
          ? `<label class="check"><input type="checkbox" name="consent" required> A pessoa concordou em ter estes dados no app da igreja.</label>`
          : `<label>Situação
              <select name="status">
                <option value="ativo" ${m.status === 'ativo' ? 'selected' : ''}>Ativo</option>
                <option value="inativo" ${m.status === 'inativo' ? 'selected' : ''}>Inativo (não acessa o app)</option>
              </select>
            </label>
            <p class="hint">Autorizações do membro: aniversário ${m.show_birthday ? 'visível' : 'oculto'} e telefone ${m.show_phone ? 'visível' : 'oculto'} para os outros membros.</p>`
      }
      <button class="btn primary big">${isNew ? 'Cadastrar' : 'Salvar'}</button>
      ${admin && linked ? '<button type="button" class="btn" id="unlink">Desligar a conta do app</button>' : ''}
      ${canDelete ? '<button type="button" class="btn danger-outline" id="delete">Excluir cadastro</button>' : ''}
    </form>`;

  const form = document.getElementById('member');
  if (!isNew) photoLater(ctx, form, m.name, m.photo_path);
  const photo = bindPhotoField(form, m.name);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = linked ? m.email : form.email.value.trim().toLowerCase() || null;
    if (email && !EMAIL_RE.test(email)) return toast('E-mail inválido.', 'error');
    const phoneRaw = form.phone.value.trim();
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) return toast('Telefone inválido. Use o DDD e o número, como (61) 99999-9999.', 'error');

    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const memberId = isNew ? crypto.randomUUID() : m.id;
    let uploaded = false;
    try {
      const row = { name: form.name.value.trim(), phone, birth_date: form.birth_date.value || null, ...specialDatesPatch(form) };
      if (!linked) row.email = email;
      if (admin) row.role = form.role.value;
      if (form.member_since) row.member_since = form.member_since.value || null;
      if (!isNew) row.status = form.status.value;
      if (photo.file) {
        row.photo_path = await uploadMemberPhoto(state.church.id, memberId, photo.file);
        uploaded = true;
      } else if (photo.removed && m.photo_path) {
        await removeMemberPhotos(state.church.id, memberId);
        row.photo_path = null;
      }
      const { error } = isNew
        ? await sb.from('members').insert({ ...row, id: memberId, church_id: state.church.id })
        : await sb.from('members').update(row).eq('id', m.id);
      if (error) throw error;
      // Publica na galeria: só o administrador marca (no banco, por gallery_set_publisher).
      if (form.gallery_publisher && form.gallery_publisher.checked !== !!m.gallery_publisher) {
        const { error: err } = await sb.rpc('gallery_set_publisher', { p_member: memberId, p_on: form.gallery_publisher.checked });
        if (err) throw err;
      }
      forgetMembers();
      toast(isNew ? 'Membro cadastrado.' : 'Cadastro salvo.');
      // Mudou o próprio papel ou a própria situação: recarrega o que a pessoa pode ver.
      if (m.user_id === state.user.id) await loadMemberships();
      navigate('/membros');
    } catch (err) {
      if (isNew && uploaded) await removeMemberPhotos(state.church.id, memberId).catch(() => {});
      toast(errorText(err), 'error');
      btn.disabled = false;
    }
  });

  document.getElementById('unlink')?.addEventListener('click', async () => {
    if (!await ask(`Desligar a conta de ${m.name} do app? O cadastro continua, mas a pessoa perde o acesso até entrar de novo e aceitar o convite.`)) return;
    const { error } = await sb.rpc('unlink_member_account', { p_member: m.id });
    if (error) return toast(errorText(error), 'error');
    forgetMembers();
    toast('Conta desligada.');
    render();
  });

  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask(`Excluir o cadastro de ${m.name}? Os dados e a foto são apagados e não dá para desfazer.`)) return;
    try {
      await removeMemberPhotos(state.church.id, m.id);
      const { data, error } = await sb.from('members').delete().eq('id', m.id).select('id');
      if (error) throw error;
      if (!data.length) throw new Error('Você não tem permissão para excluir este cadastro.');
      forgetMembers();
      toast('Cadastro excluído.');
      navigate('/membros');
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
}

// Planilhas do Excel em português costumam vir em Windows-1252; as do Google, em UTF-8.
async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob(['﻿' + text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Linhas → CSV com ";" (Excel em português). Texto que começa com = + - @ ganha um apóstrofo,
// para o Excel não tratar como fórmula.
const csvText = (rows) =>
  rows
    .map((line) =>
      line
        .map((v) => {
          const s = String(v ?? '');
          return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replaceAll('"', '""')}"`;
        })
        .join(';'),
    )
    .join('\r\n');

const IMPORT_MAX = 1000;

async function viewImport(ctx) {
  if (!requireLeader('/membros/importar')) return;
  // A lista de membros já está na memória quando se vem da tela Membros: abre na hora.
  const existing = membersCache.get(state.church.id) ?? (await fetchMembers(state.church.id));
  if (!ctx.alive()) return;
  const emails = new Set(existing.map((r) => r.email).filter(Boolean));
  const room = (state.church.max_members ?? IMPORT_MAX) - existing.length;

  $view.innerHTML = `
    <div class="page">
      <a href="#/membros" class="back">← Membros</a>
      <h1>Importar planilha</h1>
      <div class="card">
        <p>Use uma planilha com as colunas <strong>nome</strong>, <strong>email</strong>, <strong>telefone</strong> e <strong>nascimento</strong> na primeira linha. Só o nome é obrigatório.</p>
        <p class="hint">No Excel ou no Google Planilhas, salve como <strong>CSV</strong>. Datas como 15/03/1980. Quem já tem o e-mail cadastrado é pulado.</p>
        <div class="actions-row">
          <button class="btn small" id="template">Baixar modelo</button>
          <label class="btn primary small">Escolher arquivo CSV<input type="file" id="file" accept=".csv,text/csv,text/plain" hidden></label>
        </div>
      </div>
      <div id="preview"></div>
    </div>`;

  document.getElementById('template').onclick = () => downloadFile('modelo-membros.csv', MEMBERS_CSV_TEMPLATE, 'text/csv;charset=utf-8');

  document.getElementById('file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const box = document.getElementById('preview');
    const { rows, error: parseError } = parseMembersCsv(await readTextFile(file), emails);
    if (parseError) {
      box.innerHTML = `<div class="notice warn-box">${esc(parseError)}</div>`;
      return;
    }
    const ok = rows.filter((r) => !r.errors.length && !r.skip);
    const bad = rows.filter((r) => r.errors.length);
    const skipped = rows.filter((r) => !r.errors.length && r.skip);
    const special = rows.some((r) => r.wedding_date || r.baptism_date);
    const tooMany = ok.length > Math.min(room, IMPORT_MAX);

    box.innerHTML = `
      <div class="card">
        <h2>${ok.length} ${ok.length === 1 ? 'pessoa pronta' : 'pessoas prontas'} para importar</h2>
        ${skipped.length ? `<p class="hint">${skipped.length} pulada(s): já cadastrada(s) ou com e-mail repetido.</p>` : ''}
        ${bad.length ? `<p class="hint warn">${bad.length} linha(s) com erro não serão importadas. Corrija na planilha e importe de novo, se quiser.</p>` : ''}
        ${tooMany ? `<p class="hint warn">A igreja pode cadastrar mais ${Math.max(room, 0)} pessoa(s) no plano atual (e até ${IMPORT_MAX} por planilha).</p>` : ''}
        <div class="table-wrap">
          <table class="preview-table">
            <thead><tr><th>Linha</th><th>Situação</th><th>Nome</th><th>E-mail</th><th>Telefone</th><th>Nascimento</th>${special ? '<th>Casamento</th><th>Batismo</th>' : ''}</tr></thead>
            <tbody>
              ${rows
                .slice(0, 300)
                .map(
                  (r) => `
                <tr class="${r.errors.length ? 'bad' : r.skip ? 'skip' : ''}">
                  <td>${r.line}</td><td>${esc(r.errors.join(', ') || r.skip || 'ok')}</td>
                  <td>${esc(r.name)}</td><td>${esc(r.email || '')}</td>
                  <td>${esc(fmtPhone(r.phone))}</td><td>${esc(fmtDate(r.birth_date))}</td>
                  ${special ? `<td>${esc(fmtDate(r.wedding_date))}</td><td>${esc(fmtDate(r.baptism_date))}</td>` : ''}
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
          ${rows.length > 300 ? `<p class="hint">Mostrando as primeiras 300 linhas.</p>` : ''}
        </div>
        ${
          ok.length && !tooMany
            ? `<form id="do-import" class="form">
                <label class="check"><input type="checkbox" name="consent" required> As pessoas da planilha concordaram em ter os dados no app da igreja.</label>
                <button class="btn primary big">Importar ${ok.length} ${ok.length === 1 ? 'pessoa' : 'pessoas'}</button>
              </form>`
            : ''
        }
      </div>`;

    document.getElementById('do-import')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = ev.target.querySelector('button');
      btn.disabled = true;
      let done = 0;
      try {
        for (let i = 0; i < ok.length; i += 100) {
          const batch = ok.slice(i, i + 100).map((r) => ({
            church_id: state.church.id,
            name: r.name,
            email: r.email,
            phone: r.phone,
            birth_date: r.birth_date,
            ...(r.wedding_date ? { wedding_date: r.wedding_date } : {}),
            ...(r.baptism_date ? { baptism_date: r.baptism_date } : {}),
          }));
          const { error: err } = await sb.from('members').insert(batch);
          if (err) throw err;
          forgetMembers();
          done += batch.length;
          btn.textContent = `Importando… ${done} de ${ok.length}`;
        }
        toast(`${done} ${done === 1 ? 'pessoa importada' : 'pessoas importadas'}.`);
        navigate('/membros');
      } catch (err) {
        // Não oferece "tentar de novo" com a mesma lista: quem já entrou seria cadastrado duas vezes.
        ev.target.outerHTML = `<div class="notice"><strong>A importação parou${done ? ` depois de ${done} pessoa(s)` : ''}.</strong>
          <p>${esc(errorText(err))}</p><p>Confira a lista de membros antes de importar o restante.</p>
          <a class="btn" href="#/membros">Ver membros</a></div>`;
      }
    });
  });
}

// ---------------------------------------------------------------------
// Configurar a igreja (só o administrador): aparência, textos, funcionalidades, privacidade
// ---------------------------------------------------------------------
async function viewSettings(ctx) {
  if (!requireLogin('/config')) return;
  if (myRole() !== 'admin') {
    $view.innerHTML = `<div class="empty"><h2>Só para o administrador</h2><p>Peça ao administrador da igreja para mudar a configuração.</p><a class="btn" href="#/">Voltar</a></div>`;
    return;
  }
  const c = state.church;
  formFresh(
    ctx,
    c,
    async () => {
      const { data, error } = await sb.from('churches').select('*').eq('id', c.id).single();
      if (error) throw error;
      return data;
    },
    (fresh) => {
      state.church = fresh;
      saveBootCache();
    },
  );
  const social = c.social || {};

  $view.innerHTML = `
    <form id="settings" class="form page">
      <h1>Configurar a igreja</h1>
      ${messageLinks()}

      <fieldset class="card">
        <legend>Aparência</legend>
        <label>Nome da igreja<input name="name" required minlength="2" maxlength="80" value="${esc(c.name)}"></label>
        <label>Nome curto (embaixo do ícone no celular)<input name="short_name" maxlength="20" value="${esc(c.short_name || '')}" placeholder="${esc(c.name.slice(0, 20))}"></label>
        <p class="hint">É o nome que aparece embaixo do ícone do app instalado. Deixe em branco para usar o começo do nome da igreja.</p>
        <div class="logo-picker">
          <div class="icon-with-name">
            <div class="icon-preview" id="icon-preview" style="background:${esc(c.icon_background)}">
              <img id="logo-preview" src="${esc(c.logo_url || 'icons/icon-192.png')}" alt="">
            </div>
            <span id="icon-name" aria-label="Nome embaixo do ícone">${esc(c.short_name || c.name.slice(0, 20))}</span>
          </div>
          <div>
            <label class="btn small">Trocar a logo<input type="file" name="logo" accept="image/png,image/jpeg,image/webp" hidden></label>
            <p class="hint">PNG com fundo transparente fica melhor. É assim que o ícone aparece no celular.</p>
          </div>
        </div>
        <div class="colors">
          ${colorField('Cor principal', 'primary_color', c.primary_color)}
          ${colorField('Fundo do ícone', 'icon_background', c.icon_background)}
        </div>
        <p class="hint warn" id="color-warn" hidden>Essa cor é clara demais para botões e links sobre fundo branco. Prefira uma cor mais escura.</p>
        <fieldset>
          <legend>Fundo do app no tema escuro</legend>
          <label class="check"><input type="radio" name="dark_theme" value="preto" ${c.dark_theme !== 'principal' ? 'checked' : ''}> Preto</label>
          <label class="check"><input type="radio" name="dark_theme" value="principal" ${c.dark_theme === 'principal' ? 'checked' : ''}> Cor principal da igreja
            <small class="hint">Os cartões ficam um pouco mais claros e os botões e o + usam a cor principal clareada, para não sumirem no fundo. Cor clara demais é escurecida no fundo, para os textos ficarem legíveis.</small></label>
        </fieldset>
      </fieldset>

      <fieldset class="card">
        <legend>Textos</legend>
        <label>Mensagem de boas-vindas<textarea name="welcome_text" rows="2" maxlength="500">${esc(c.welcome_text || '')}</textarea></label>
        <label>Sobre a igreja<textarea name="about_text" rows="4" maxlength="2000" placeholder="Horários dos cultos, história, pastores…">${esc(c.about_text || '')}</textarea></label>
        <label>Endereço<input name="address" maxlength="200" value="${esc(c.address || '')}"></label>
        <label>Cidade<input name="city" maxlength="80" value="${esc(c.city || '')}"></label>
        ${pinField(c)}
        <small class="hint">Com o alfinete no mapa, a página da igreja mostra o mapa e a rota pelo Google Maps e pelo Waze.</small>
      </fieldset>

      <fieldset class="card">
        <legend>Redes sociais</legend>
        ${SOCIAL.map(([k, label, ph]) => `<label>${label}<input name="social_${k}" type="url" maxlength="300" placeholder="${ph}" value="${esc(social[k] || '')}"></label>`).join('')}
      </fieldset>

      <fieldset class="card">
        <legend>${icon.pix} Pix</legend>
        <p class="hint">Com a funcionalidade ligada, a tela <em>Pix</em> mostra o QR Code e a chave da igreja. O dinheiro vai direto para a conta da igreja: o app não recebe nem registra pagamentos.</p>
        <div class="pix-row">
          <label>Tipo de chave
            <select name="pix_type">
              ${Object.entries(PIX_TYPES).map(([k, v]) => `<option value="${k}" ${k === (c.pix_key ? guessPixType(c.pix_key) : 'cpf') ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>
          <label>Chave Pix<input name="pix_key" maxlength="120" autocomplete="off" value="${esc(c.pix_key ? formatPixKey(c.pix_key) : '')}"></label>
        </div>
        <label>Nome do recebedor (como aparece no banco)<input name="pix_name" maxlength="25" value="${esc(c.pix_name || '')}" placeholder="${esc(c.name.slice(0, 25))}"></label>
        <p class="hint">A chave fica visível para qualquer pessoa que abrir a página da igreja, mesmo sem entrar. Prefira o CNPJ ou uma chave aleatória da conta da igreja.</p>
        <div class="notice warn-box" id="pix-cpf-warning" hidden><p>Se a chave for um <strong>CPF</strong>, ele fica público. Use o CPF de uma pessoa só se ela concordar.</p></div>
      </fieldset>

      <fieldset class="card">
        <legend>Funcionalidades</legend>
        ${FEATURES.map(
          (f) => `
          <label class="check ${f.soon ? 'disabled' : ''}">
            <input type="checkbox" name="feature_${f.key}" ${c.features?.[f.key] ? 'checked' : ''} ${f.soon ? 'disabled' : ''}>
            ${esc(f.label)}${f.soon ? ` <small>(em breve)</small>` : ''}
          </label>`,
        ).join('')}
      </fieldset>

      <fieldset class="card">
        <legend>Privacidade</legend>
        <label>E-mail para pedidos sobre dados pessoais<input name="privacy_email" type="email" maxlength="160" value="${esc(c.privacy_email || '')}"></label>
        <label>Complemento da política de privacidade (opcional)<textarea name="privacy_text" rows="4" maxlength="8000" placeholder="Quem cuida dos dados na igreja, por quanto tempo eles ficam guardados…">${esc(c.privacy_text || '')}</textarea></label>
      </fieldset>

      <button class="btn primary big">Salvar</button>
      <p class="hint">O nome e o ícone do app instalado na tela inicial mudam em até 15 minutos. Quem já instalou pode precisar reinstalar para ver o ícone novo.</p>
    </form>`;

  const form = document.getElementById('settings');
  bindPinField(form, { address: () => [form.address.value.trim(), form.city.value.trim()].filter(Boolean).join(', ') });
  let logoFile = null;
  bindColorFields(form);
  const colorWarn = () => (document.getElementById('color-warn').hidden = readableOnWhite(form.primary_color.value));
  colorWarn();
  form.primary_color.addEventListener('input', colorWarn);
  form.icon_background.addEventListener('input', () => (document.getElementById('icon-preview').style.background = form.icon_background.value));
  // Nome embaixo do ícone no celular: o nome curto, ou o começo do nome da igreja.
  const iconName = () => {
    const name = form.name.value.trim();
    document.getElementById('icon-name').textContent = form.short_name.value.trim() || name.slice(0, 20);
    form.short_name.placeholder = name.slice(0, 20);
  };
  form.name.addEventListener('input', iconName);
  form.short_name.addEventListener('input', iconName);
  const cpfWarn = () => {
    const key = form.pix_key.value.trim();
    document.getElementById('pix-cpf-warning').hidden = !(form.pix_type.value === 'cpf' && key.replace(/\D/g, '').length === 11);
  };
  cpfWarn();
  form.pix_type.addEventListener('change', cpfWarn);
  form.pix_key.addEventListener('input', cpfWarn);
  form.logo.addEventListener('change', () => {
    logoFile = form.logo.files[0] || null;
    if (logoFile) document.getElementById('logo-preview').src = URL.createObjectURL(logoFile);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    try {
      const newSocial = {};
      for (const [k] of SOCIAL) {
        const v = form[`social_${k}`].value.trim();
        if (v && !/^https:\/\//i.test(v)) throw new Error('Os links das redes sociais precisam começar com https://');
        if (v) newSocial[k] = v;
      }
      const features = { ...(c.features || {}) };
      for (const f of FEATURES) if (!f.soon) features[f.key] = form[`feature_${f.key}`].checked;
      const pixRaw = form.pix_key.value.trim();
      const pix_key = pixRaw ? normalizePixKey(form.pix_type.value, pixRaw) : null;
      if (pixRaw && !pix_key) throw new Error(`Chave Pix inválida para o tipo "${PIX_TYPES[form.pix_type.value]}".`);
      if (features.pix && !pix_key) throw new Error('Para ligar o Pix, preencha a chave Pix da igreja.');

      const patch = {
        name: form.name.value.trim(),
        short_name: form.short_name.value.trim() || null,
        primary_color: form.primary_color.value.toLowerCase(),
        icon_background: form.icon_background.value.toLowerCase(),
        dark_theme: form.dark_theme.value,
        welcome_text: form.welcome_text.value.trim() || null,
        about_text: form.about_text.value.trim() || null,
        address: form.address.value.trim() || null,
        city: form.city.value.trim() || null,
        ...pinValues(form),
        social: newSocial,
        pix_key,
        pix_name: pix_key ? form.pix_name.value.trim() || null : null,
        features,
        privacy_email: form.privacy_email.value.trim() || null,
        privacy_text: form.privacy_text.value.trim() || null,
      };

      // Logo nova ou fundo do ícone diferente: gera os ícones do app de novo. Igreja que ainda não
      // tem o ícone da barra de notificações (criado depois): gera a partir da logo que já existe e
      // grava a logo de novo, para o site ser publicado com o ícone novo.
      let source = logoFile;
      let refresh = false;
      if (!source && c.logo_url) {
        const iconsUrl = `${CONFIG.SUPABASE_URL}/storage/v1/object/public/igrejas/${c.id}/icons/badge-96.png`;
        const needsBadge = await fetch(iconsUrl, { method: 'HEAD', cache: 'no-store' })
          .then((r) => !r.ok)
          .catch(() => false);
        if (patch.icon_background !== c.icon_background || needsBadge) {
          const res = await fetch(c.logo_url);
          if (res.ok) {
            source = await res.blob();
            refresh = needsBadge;
          }
        }
      }
      if (source) {
        const bucket = sb.storage.from('igrejas');
        if (logoFile || refresh) {
          const logo = await resizeLogo(source);
          const ext = logo.type === 'image/png' ? 'png' : 'webp';
          const path = `${c.id}/logo-${Date.now()}.${ext}`;
          const up = await bucket.upload(path, logo, { contentType: logo.type, cacheControl: '31536000' });
          if (up.error) throw up.error;
          patch.logo_url = bucket.getPublicUrl(path).data.publicUrl;
        }
        const icons = await makeIconSet(source, patch.icon_background);
        // Logo que não vira um desenho (ex.: foto): o ícone da barra de notificações fica o padrão do app.
        if (!icons['badge-96.png']) {
          const res = await fetch('icons/badge-96.png');
          if (res.ok) icons['badge-96.png'] = await res.blob();
        }
        for (const [name, blob] of Object.entries(icons)) {
          const up = await bucket.upload(`${c.id}/icons/${name}`, blob, { contentType: 'image/png', cacheControl: '300', upsert: true });
          if (up.error) throw up.error;
        }
      }

      const { data: saved, error: err } = await sb.from('churches').update(patch).eq('id', c.id).select().single();
      if (err) throw err;

      // A logo antiga não é mais usada.
      const oldPath = c.logo_url?.split('/object/public/igrejas/')[1];
      if ((logoFile || refresh) && oldPath) await sb.storage.from('igrejas').remove([decodeURIComponent(oldPath)]);

      state.church = saved;
      saveBootCache();
      applyBranding();
      toast(
        saved.branding_version > c.branding_version
          ? 'Pronto! Em até 15 minutos o app passa a instalar com o ícone novo.'
          : 'Configuração salva.',
      );
      render();
    } catch (err) {
      toast(errorText(err), 'error');
      btn.disabled = false;
      btn.textContent = 'Salvar';
    }
  });
}

// ---------------------------------------------------------------------
// Pix: QR Code e chave Pix da igreja. Aberta a todos, como a chave
// na tabela de igrejas. O app não recebe nem registra pagamentos.
// ---------------------------------------------------------------------
async function viewOffer() {
  const c = state.church;
  if (!offerReady()) {
    $view.innerHTML = `<div class="empty"><h2>Pix</h2><p>A igreja ainda não informou uma chave Pix.</p><a class="btn" href="#/">Voltar</a></div>`;
    return;
  }
  const receiver = c.pix_name || c.name;
  $view.innerHTML = `
    <div class="page offer">
      <h1>Pix</h1>
      <p>Aponte a câmera do app do seu banco para o QR Code ou copie o código e cole em <strong>Pix &gt; Copia e cola</strong>.</p>
      <label>Valor (opcional)<input id="offer-amount" inputmode="decimal" autocomplete="off" placeholder="R$ 0,00"></label>
      <p class="hint warn" id="offer-amount-error" hidden>Valor inválido. Use, por exemplo, 50 ou 50,00.</p>
      <div class="qr" id="offer-qr">Gerando QR Code…</div>
      <button class="btn primary big" id="copy-code" type="button">Copiar código Pix (copia e cola)</button>
      <section class="card">
        <h2>Chave Pix</h2>
        <p class="key"><strong>${esc(formatPixKey(c.pix_key))}</strong></p>
        <button class="btn small" id="copy-key" type="button">Copiar chave</button>
        <p class="hint">Recebedor: <strong>${esc(receiver)}</strong>. Confira o nome no app do banco antes de confirmar.</p>
      </section>
      <p class="hint">O dinheiro vai direto para a conta da igreja. O app não recebe, não processa e não registra nenhum pagamento.</p>
    </div>`;

  let code = '';
  let drawId = 0;
  const draw = async () => {
    const amount = parseAmount(document.getElementById('offer-amount').value);
    document.getElementById('offer-amount-error').hidden = amount !== null;
    if (amount === null) return;
    const id = ++drawId;
    code = pixPayload({ key: c.pix_key, name: receiver, city: c.city || undefined, amount });
    const box = document.getElementById('offer-qr');
    try {
      const svg = await qrSvg(code);
      if (id === drawId && box) box.innerHTML = svg;
    } catch (err) {
      if (box) box.textContent = err.message;
    }
  };
  const copy = async (text, done) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch {
      await ask('O celular não deixou copiar sozinho. Toque e segure no texto abaixo para copiar:', { input: 'text', value: text, readonly: true });
    }
  };
  document.getElementById('offer-amount').addEventListener('input', draw);
  document.getElementById('copy-code').onclick = () => {
    if (parseAmount(document.getElementById('offer-amount').value) === null) return toast('Confira o valor.', 'error');
    copy(code, 'Código Pix copiado! Cole no app do seu banco, em Pix > Copia e cola.');
  };
  document.getElementById('copy-key').onclick = () => copy(c.pix_key, 'Chave Pix copiada.');
  await draw();
}

// ---------------------------------------------------------------------
// Agenda (cultos e eventos) e mural de avisos
// ---------------------------------------------------------------------
const fmtHour = (d) => `${d.getHours()}h${d.getMinutes() ? String(d.getMinutes()).padStart(2, '0') : ''}`;
const fmtDayShort = (d) => d.toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '');

function fmtEventWhen(ev) {
  const s = new Date(ev.starts_at);
  const e = ev.ends_at ? new Date(ev.ends_at) : null;
  const label = dayLabel(isoLocal(s));
  const day = ['Hoje', 'Amanhã'].includes(label) ? label : fmtDayShort(s);
  if (!e) return `${day} · ${fmtHour(s)}`;
  return isoLocal(e) === isoLocal(s) ? `${day} · ${fmtHour(s)}–${fmtHour(e)}` : `${day} · ${fmtHour(s)} até ${fmtDayShort(e)} ${fmtHour(e)}`;
}

async function fetchEvents(from, to) {
  const { data, error } = await sb.rpc('events_between', { p_church: state.church.id, p_from: from.toISOString(), p_to: to.toISOString() });
  if (error) throw error;
  return data;
}

function eventCard(ev) {
  return `
    <a class="event-card" href="#/agenda/${ev.event_id}?em=${encodeURIComponent(ev.starts_at)}">
      <span class="event-time">${esc(fmtHour(new Date(ev.starts_at)))}</span>
      <span><strong>${esc(ev.title)}</strong>
        ${ev.location ? `<small>${icon.pin}${esc(ev.location)}</small>` : ''}
        ${ev.repeat_weekly ? '<small>Toda semana</small>' : ''}</span>
      ${icon.chevron}
    </a>`;
}

function requireMemberFeature(next, key) {
  if (!requireLogin(next)) return false;
  if (!isActiveMember()) {
    navigate('/');
    return false;
  }
  if (featureOn(key)) return true;
  $view.innerHTML = `<div class="empty"><h2>Desligado nesta igreja</h2><a class="btn" href="#/">Voltar</a></div>`;
  return false;
}

// Cartões do Início: usam os mesmos dados guardados da Agenda e dos Avisos (assim as duas
// telas também abrem na hora). Desenham com o guardado e de novo com o que vier do banco.
async function homeCard(el, name, fetcher, html, changed) {
  if (!isActiveMember()) return;
  let last = null;
  const draw = (data) => {
    const out = html(data);
    if (!el.isConnected || out === last) return;
    last = out;
    el.innerHTML = out;
    changed();
  };
  const cached = screenCached(name);
  if (cached) draw(cached);
  draw(await screenFetch(name, fetcher));
}

function homeEventsCard(el, changed) {
  return homeCard(el, 'agenda', loadAgenda, (all) => {
    const now = Date.now();
    const until = addDays(new Date(), 8).getTime();
    const rows = all
      .filter((ev) => {
        const start = new Date(ev.starts_at).getTime();
        return start < until && new Date(ev.ends_at || start + 2 * 3600e3).getTime() > now;
      })
      .slice(0, 3);
    if (!rows.length) return '';
    return `
    <section class="card">
      <h2>${icon.calendar} Próximos eventos</h2>
      <div class="list">${rows
        .map(
          (ev) => `
        <a class="event-card" href="#/agenda/${ev.event_id}?em=${encodeURIComponent(ev.starts_at)}">
          <span><strong>${esc(ev.title)}</strong><small>${esc(fmtEventWhen(ev))}</small></span>${icon.chevron}
        </a>`,
        )
        .join('')}</div>
      <a href="#/agenda">Ver a agenda</a>
    </section>`;
  }, changed);
}

function homeNoticesCard(el, changed) {
  return homeCard(el, 'avisos', loadAnnouncements, (all) => {
    const today = isoLocal(new Date());
    const rows = all.filter((a) => !a.visible_until || a.visible_until >= today).slice(0, 2);
    if (!rows.length) return '';
    return `
    <section class="card">
      <h2>${icon.megaphone} Avisos</h2>
      ${rows
        .map(
          (a) => `
        <article class="notice-mini">
          <strong>${a.pinned ? '<span class="tag role">Fixado</span> ' : ''}${esc(a.title)}</strong>
          <p class="pre clamp">${esc(a.body)}</p>
        </article>`,
        )
        .join('')}
      <a href="#/avisos">Ver todos os avisos</a>
    </section>`;
  }, changed);
}

const agendaStart = () => {
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  return from;
};
const loadAgenda = () => fetchEvents(agendaStart(), addDays(agendaStart(), 90));

async function viewAgenda(ctx) {
  if (!requireMemberFeature('/agenda', 'agenda')) return;
  await screenShow(ctx, 'agenda', loadAgenda, (all) => drawAgenda(all));
}

function drawAgenda(all) {
  // O guardado pode ser de outro dia: tira o que já terminou.
  const now = Date.now();
  const rows = all.filter((ev) => new Date(ev.ends_at || new Date(ev.starts_at).getTime() + 2 * 3600e3).getTime() > now);
  const byDay = new Map();
  for (const ev of rows) {
    const day = isoLocal(new Date(ev.starts_at));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(ev);
  }
  $view.innerHTML = `
    <div class="page">
      ${agendaSwitch('lista')}
      <h1>Agenda</h1>
      ${
        rows.length
          ? [...byDay]
              .map(([day, list]) => {
                const label = dayLabel(day);
                const long = parseIso(day).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
                return `
            <section class="agenda-day">
              <h2>${['Hoje', 'Amanhã'].includes(label) ? `${label}, ${long.split(',')[0]}` : long.charAt(0).toUpperCase() + long.slice(1)}</h2>
              <div class="list">${list.map(eventCard).join('')}</div>
            </section>`;
              })
              .join('')
          : `<div class="empty"><p>Nenhum evento nos próximos 3 meses.</p></div>`
      }
      ${isLeaderRole(myRole()) ? fab('#/agenda/novo', 'Novo evento') : ''}
    </div>`;
}

// ---------------------------------------------------------------------
// Calendário: a mesma agenda da igreja vista por mês ou por dia (como o Google Agenda).
// A liderança adiciona eventos tocando no dia; os aniversariantes (quem autorizou) aparecem com 🎂.
// ---------------------------------------------------------------------
const WEEK_INITIALS = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
const ymOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthTitle = (d) => {
  const s = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};

// Lista · Mês · Dia: as três vistas da agenda.
function agendaSwitch(active, day = isoLocal(new Date())) {
  const items = [
    ['lista', '#/agenda', 'Lista'],
    ['mes', `#/calendario/${day.slice(0, 7)}`, 'Mês'],
    ['dia', `#/calendario/dia/${day}`, 'Dia'],
  ];
  return `<nav class="view-switch" aria-label="Vista da agenda">${items
    .map(([k, href, label]) => `<a href="${href}" ${k === active ? 'aria-current="page"' : ''}>${label}</a>`)
    .join('')}</nav>`;
}

// Eventos (e aniversários) de um intervalo de dias [from, to].
async function loadCalendar(fromIso, toIso) {
  const from = parseIso(fromIso);
  const to = addDays(parseIso(toIso), 1);
  const [events, birthdays] = await Promise.all([
    fetchEvents(from, to),
    datesOn() ? fetchBirthdays(fromIso, toIso).catch(() => []) : Promise.resolve([]),
  ]);
  return { events, birthdays: birthdays.filter((b) => b.kind === 'aniversario') };
}
const eventsOn = (events, iso) => events.filter((ev) => isoLocal(new Date(ev.starts_at)) === iso);
const birthdaysOn = (birthdays, iso) => birthdays.filter((b) => b.on_date === iso);

// Grade do mês: começa no domingo da primeira semana e termina no sábado da última.
function monthGrid(first) {
  const start = addDays(first, -first.getDay());
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  const end = addDays(last, 6 - last.getDay());
  const days = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return { start, end, days };
}

async function viewCalendar(ctx, ym) {
  if (!requireMemberFeature(ym ? `/calendario/${ym}` : '/calendario', 'agenda')) return;
  const first = ym ? new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  if (Number.isNaN(first.getTime())) return navigate('/calendario');
  const { start, end } = monthGrid(first);
  await screenShow(ctx, `cal:${ymOf(first)}`, () => loadCalendar(isoLocal(start), isoLocal(end)), (d) => drawCalendar(first, d));
}

function drawCalendar(first, { events, birthdays }) {
  const { days } = monthGrid(first);
  const today = isoLocal(new Date());
  const prev = ymOf(new Date(first.getFullYear(), first.getMonth() - 1, 1));
  const next = ymOf(new Date(first.getFullYear(), first.getMonth() + 1, 1));
  const focus = ymOf(new Date()) === ymOf(first) ? today : isoLocal(first);
  $view.innerHTML = `
    <div class="page calendar">
      ${agendaSwitch('mes', focus)}
      <div class="cal-head">
        <a class="btn small" href="#/calendario/${prev}" aria-label="Mês anterior">‹</a>
        <h1>${esc(monthTitle(first))}</h1>
        <a class="btn small" href="#/calendario/${next}" aria-label="Próximo mês">›</a>
      </div>
      ${ymOf(new Date()) === ymOf(first) ? '' : '<p class="center"><a href="#/calendario">Voltar para hoje</a></p>'}
      <div class="cal-grid" role="grid">
        ${WEEK_INITIALS.map((w) => `<div class="cal-wd" role="columnheader">${w}</div>`).join('')}
        ${days
          .map((d) => {
            const iso = isoLocal(d);
            const evs = eventsOn(events, iso);
            const bds = birthdaysOn(birthdays, iso);
            const out = d.getMonth() !== first.getMonth();
            const label = `${d.getDate()} de ${d.toLocaleDateString('pt-BR', { month: 'long' })}: ${evs.length ? `${evs.length} evento${evs.length > 1 ? 's' : ''}` : 'sem eventos'}${bds.length ? `, ${bds.length} aniversário${bds.length > 1 ? 's' : ''}` : ''}`;
            return `
          <a class="cal-day${out ? ' out' : ''}${iso === today ? ' today' : ''}" href="#/calendario/dia/${iso}" role="gridcell" aria-label="${esc(label)}">
            <span class="cal-num">${d.getDate()}${bds.length ? ' <span aria-hidden="true">🎂</span>' : ''}</span>
            ${evs
              .slice(0, 2)
              .map((ev) => `<span class="cal-ev">${esc(ev.title)}</span>`)
              .join('')}
            ${evs.length > 2 ? `<span class="cal-more">+${evs.length - 2}</span>` : ''}
          </a>`;
          })
          .join('')}
      </div>
      ${isLeaderRole(myRole()) ? fab(`#/agenda/novo?data=${focus}`, 'Novo evento') : ''}
    </div>`;
}

async function viewCalendarDay(ctx, iso) {
  if (!requireMemberFeature(`/calendario/dia/${iso}`, 'agenda')) return;
  if (Number.isNaN(parseIso(iso).getTime())) return navigate('/calendario');
  await screenShow(ctx, `caldia:${iso}`, () => loadCalendar(iso, iso), (d) => drawCalendarDay(iso, d));
}

function drawCalendarDay(iso, { events, birthdays }) {
  const d = parseIso(iso);
  const evs = eventsOn(events, iso).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const bds = birthdaysOn(birthdays, iso);
  const label = dayLabel(iso);
  const long = d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const title = ['Hoje', 'Amanhã'].includes(label) ? `${label}, ${long.split(',')[0]}` : long.charAt(0).toUpperCase() + long.slice(1);
  $view.innerHTML = `
    <div class="page calendar">
      ${agendaSwitch('dia', iso)}
      <div class="cal-head">
        <a class="btn small" href="#/calendario/dia/${isoLocal(addDays(d, -1))}" aria-label="Dia anterior">‹</a>
        <h1>${esc(title)}</h1>
        <a class="btn small" href="#/calendario/dia/${isoLocal(addDays(d, 1))}" aria-label="Próximo dia">›</a>
      </div>
      ${iso === isoLocal(new Date()) ? '' : `<p class="center"><a href="#/calendario/dia/${isoLocal(new Date())}">Voltar para hoje</a></p>`}
      ${
        bds.length
          ? `<section class="card"><h2>${icon.cake} Aniversário</h2><p>${esc(joinNames(bds.map((b) => b.name)))}</p></section>`
          : ''
      }
      ${
        evs.length
          ? `<div class="day-timeline">${evs
              .map((ev) => {
                const s = new Date(ev.starts_at);
                const e = ev.ends_at ? new Date(ev.ends_at) : null;
                return `
          <a class="day-slot" href="#/agenda/${ev.event_id}?em=${encodeURIComponent(ev.starts_at)}">
            <span class="day-hour">${esc(fmtHour(s))}${e ? `<small>${esc(isoLocal(e) === iso ? fmtHour(e) : 'até ' + fmtDayShort(e))}</small>` : ''}</span>
            <span class="day-ev"><strong>${esc(ev.title)}</strong>
              ${ev.location ? `<small>${icon.pin}${esc(ev.location)}</small>` : ''}
              ${ev.repeat_weekly ? '<small>Toda semana</small>' : ''}</span>
          </a>`;
              })
              .join('')}</div>`
          : `<div class="empty"><p>Nenhum evento neste dia.</p>${isLeaderRole(myRole()) ? '<p class="hint">Toque no <strong>+</strong> para adicionar.</p>' : ''}</div>`
      }
      <p class="center"><a href="#/calendario/${iso.slice(0, 7)}">Ver o mês</a></p>
      ${isLeaderRole(myRole()) ? fab(`#/agenda/novo?data=${iso}`, 'Novo evento neste dia') : ''}
    </div>`;
}

function downloadIcs(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/calendar;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Detalhes dos eventos que ainda vão acontecer (os semanais, sempre): guardados juntos, para
// a tela do evento abrir na hora a partir da agenda.
async function loadEventDetails() {
  const since = new Date(Date.now() - 2 * 864e5).toISOString();
  const { data, error } = await sb
    .from('events')
    .select('*')
    .eq('church_id', state.church.id)
    .or(`repeat_weekly.eq.true,starts_at.gte.${since}`)
    .order('starts_at')
    .limit(300);
  if (error) throw error;
  return data;
}

async function viewEvent(ctx, id) {
  if (!requireMemberFeature(`/agenda/${id}`, 'agenda')) return;
  const cached = screenCached('eventos')?.find((e) => e.id === id) ?? null;
  if (cached) drawEvent(ctx, cached);
  let ev;
  try {
    ev = (await screenFetch('eventos', loadEventDetails)).find((e) => e.id === id) ?? null;
    if (!ev) {
      // Evento antigo (ex.: aberto por uma notificação): busca só ele.
      const { data, error } = await sb.from('events').select('*').eq('id', id).maybeSingle();
      if (error) throw error;
      ev = data;
    }
  } catch (err) {
    if (cached) return;
    throw err;
  }
  if (ctx.alive() && JSON.stringify(ev) !== JSON.stringify(cached)) drawEvent(ctx, ev);
}

function drawEvent(ctx, ev) {
  if (!ev) {
    $view.innerHTML = `<div class="empty"><h2>Evento não encontrado</h2><a class="btn" href="#/agenda">Voltar à agenda</a></div>`;
    return;
  }
  // Ocorrência escolhida na agenda (eventos semanais): mesma duração, outra data.
  const em = new Date(ctx.params.get('em') || ev.starts_at);
  const start = Number.isNaN(em.getTime()) ? new Date(ev.starts_at) : em;
  const dur = ev.ends_at ? new Date(ev.ends_at) - new Date(ev.starts_at) : null;
  const occ = { ...ev, starts_at: start.toISOString(), ends_at: dur ? new Date(start.getTime() + dur).toISOString() : null };
  const leader = isLeaderRole(myRole());
  const remind = REMIND_OPTIONS.find(([m]) => m === ev.remind_minutes)?.[1];
  const calOpts = { church: state.church.name, url: `${PAGE_URL}#/agenda/${ev.id}` };

  $view.innerHTML = `
    <div class="page">
      <a href="#/agenda" class="back">← Agenda</a>
      <h1>${esc(ev.title)}</h1>
      <p class="meta">${icon.clock}${esc(fmtEventWhen(occ))}</p>
      ${ev.location ? `<p class="meta">${icon.pin}${esc(ev.location)}</p>` : ''}
      ${placeBlock({ lat: ev.lat, lng: ev.lng, address: ev.location })}
      ${ev.repeat_weekly ? `<p class="hint">Repete toda semana${ev.repeat_until ? ` até ${esc(fmtDate(ev.repeat_until))}` : ''}.</p>` : ''}
      ${ev.description ? `<div class="card"><p class="pre">${esc(ev.description)}</p></div>` : ''}
      ${ev.remind_minutes ? `<p class="hint">${icon.bell} Lembrete por notificação ${esc(remind.toLowerCase())}.</p>` : ''}
      <div class="actions-row">
        <button class="btn primary" id="ics">${icon.calendar} Adicionar à agenda</button>
        <a class="btn" href="${esc(googleCalendarUrl(ev, calOpts))}" target="_blank" rel="noopener">Google Agenda</a>
      </div>
      ${ev.repeat_weekly ? '<p class="hint">Na sua agenda, entra a série inteira (toda semana).</p>' : ''}
      ${
        leader
          ? `<div class="actions-row">
              <a class="btn" href="#/agenda/${ev.id}/editar">Editar</a>
              <button class="btn danger-outline" id="delete">Excluir</button>
            </div>`
          : ''
      }
    </div>`;

  document.getElementById('ics').onclick = () => {
    downloadIcs(`evento-${isoLocal(new Date(ev.starts_at))}.ics`, icsForEvent(ev, calOpts));
    toast('Abra o arquivo baixado para salvar na agenda do celular.');
  };
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask(ev.repeat_weekly ? `Excluir "${ev.title}" e todas as repetições?` : `Excluir "${ev.title}"?`)) return;
    const { data, error: err } = await sb.from('events').delete().eq('id', ev.id).select('id');
    if (err || !data.length) return toast(err ? errorText(err) : 'Você não tem permissão para excluir.', 'error');
    screenForget('agenda');
    screenForget('eventos');
    toast('Evento excluído.');
    navigate('/agenda');
  });
}

const timeValue = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// Campo de horário com duas listas (hora e minutos), no lugar do campo de hora do navegador: a janela de
// horas do Android corta o botão "Definir" com letra grande, e as listas se ajustam a qualquer tela.
// O valor ("19:30" ou "") fica num campo escondido com o mesmo nome, para o formulário ler igual.
const pad2 = (n) => String(n).padStart(2, '0');
function timeField(name, label, value = '', { required = false } = {}) {
  const [h, m] = value ? value.slice(0, 5).split(':') : ['', ''];
  const minutes = Array.from({ length: 12 }, (_, i) => pad2(i * 5));
  if (m && !minutes.includes(m)) minutes.push(m), minutes.sort();
  return `
    <div class="time-field" role="group" aria-labelledby="time-${name}">
      <span class="field-label" id="time-${name}">${esc(label)}</span>
      <div class="time-pick">
        <select data-time="${name}" data-part="h" aria-label="${esc(label)}: hora" ${required ? 'required' : ''}>
          <option value="">--</option>
          ${Array.from({ length: 24 }, (_, i) => pad2(i)).map((x) => `<option value="${x}" ${x === h ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
        <span aria-hidden="true">:</span>
        <select data-time="${name}" data-part="m" aria-label="${esc(label)}: minutos">
          ${minutes.map((x) => `<option value="${x}" ${x === (m || '00') ? 'selected' : ''}>${x}</option>`).join('')}
        </select>
      </div>
      <input type="hidden" name="${name}" value="${h ? `${h}:${m || '00'}` : ''}">
    </div>`;
}
function bindTimeFields(form) {
  form.querySelectorAll('select[data-time]').forEach((sel) => {
    sel.addEventListener('change', () => {
      const name = sel.dataset.time;
      const h = form.querySelector(`select[data-time="${name}"][data-part="h"]`).value;
      const m = form.querySelector(`select[data-time="${name}"][data-part="m"]`).value;
      form[name].value = h ? `${h}:${m}` : '';
    });
  });
}

async function viewEventForm(ctx, id) {
  if (!requireMemberFeature(id ? `/agenda/${id}/editar` : '/agenda/novo', 'agenda')) return;
  if (!isLeaderRole(myRole())) return navigate('/agenda');
  let ev = { title: '', description: '', location: '', starts_at: null, ends_at: null, repeat_weekly: false, repeat_until: null, remind_minutes: 120 };
  if (id) {
    const data = await editItem(
      ctx,
      screenCached('eventos')?.find((e) => e.id === id),
      async () => {
        const { data: row, error } = await sb.from('events').select('*').eq('id', id).maybeSingle();
        if (error) throw error;
        return row;
      },
      () => screenForget('eventos'),
    );
    if (!data) return navigate('/agenda');
    ev = data;
  }
  if (!ctx.alive()) return;
  const s = ev.starts_at ? new Date(ev.starts_at) : null;
  const e = ev.ends_at ? new Date(ev.ends_at) : null;

  $view.innerHTML = `
    <form id="event" class="form page">
      <a href="${id ? `#/agenda/${id}` : '#/agenda'}" class="back">← ${id ? 'Evento' : 'Agenda'}</a>
      <h1>${id ? 'Editar evento' : 'Novo evento'}</h1>
      <label>Título<input name="title" required minlength="3" maxlength="120" value="${esc(ev.title)}" placeholder="Culto de domingo"></label>
      <label>Data<input name="date" type="date" required value="${s ? isoLocal(s) : /^\d{4}-\d{2}-\d{2}$/.test(ctx.params.get('data') || '') ? ctx.params.get('data') : ''}"></label>
      <div class="colors">
        ${timeField('start', 'Começa', s ? timeValue(s) : '', { required: true })}
        ${timeField('end', 'Termina (opcional)', e ? timeValue(e) : '')}
      </div>
      <label>Local (opcional)<input name="location" maxlength="200" value="${esc(ev.location || '')}" placeholder="Templo principal"></label>
      ${pinField(ev)}
      <label>Descrição (opcional)<textarea name="description" rows="4" maxlength="2000">${esc(ev.description || '')}</textarea></label>
      <label class="check"><input type="checkbox" name="repeat_weekly" ${ev.repeat_weekly ? 'checked' : ''}> Repetir toda semana</label>
      <label id="until-box" ${ev.repeat_weekly ? '' : 'hidden'}>Repetir até (opcional)<input name="repeat_until" type="date" value="${esc(ev.repeat_until || '')}"></label>
      <label>Lembrete por notificação
        <select name="remind_minutes">${REMIND_OPTIONS.map(([m, label]) => `<option value="${m}" ${ev.remind_minutes === m ? 'selected' : ''}>${label}</option>`).join('')}</select>
      </label>
      ${id && ev.repeat_weekly ? '<p class="hint">As mudanças valem para todas as repetições.</p>' : ''}
      <button class="btn primary big">${id ? 'Salvar' : 'Criar evento'}</button>
    </form>`;

  const form = document.getElementById('event');
  bindTimeFields(form);
  bindPinField(form, { address: () => form.location.value.trim(), near: churchPin() });
  form.repeat_weekly.addEventListener('change', () => {
    document.getElementById('until-box').hidden = !form.repeat_weekly.checked;
  });
  form.addEventListener('submit', async (evt) => {
    evt.preventDefault();
    const start = new Date(`${form.date.value}T${form.start.value}`);
    let end = form.end.value ? new Date(`${form.date.value}T${form.end.value}`) : null;
    if (end && end <= start) end = new Date(end.getTime() + 864e5); // termina depois da meia-noite
    const weekly = form.repeat_weekly.checked;
    const until = weekly ? form.repeat_until.value || null : null;
    if (until && until < form.date.value) return toast('"Repetir até" precisa ser depois da data do evento.', 'error');
    const row = {
      title: form.title.value.trim(),
      description: form.description.value.trim() || null,
      location: form.location.value.trim() || null,
      ...pinValues(form),
      starts_at: start.toISOString(),
      ends_at: end ? end.toISOString() : null,
      repeat_weekly: weekly,
      repeat_until: until,
      remind_minutes: Number(form.remind_minutes.value),
    };
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = id
      ? await sb.from('events').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id).select('id').single()
      : await sb.from('events').insert({ ...row, church_id: state.church.id }).select('id').single();
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    screenForget('agenda');
    screenForget('eventos');
    screenForget('inscricoes');
    toast(id ? 'Evento salvo.' : 'Evento criado.');
    navigate(`/agenda/${data.id}`);
  });
}

async function loadAnnouncements() {
  const { data, error } = await sb
    .from('announcements')
    .select('id, title, body, pinned, visible_until, push, created_at')
    .eq('church_id', state.church.id)
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data;
}

async function viewAnnouncements(ctx) {
  if (!requireMemberFeature('/avisos', 'avisos')) return;
  await screenShow(ctx, 'avisos', loadAnnouncements, drawAnnouncements);
}

function drawAnnouncements(all) {
  const leader = isLeaderRole(myRole());
  const today = isoLocal(new Date());
  // O guardado pode ser de outro dia: para os membros, some o que venceu.
  const rows = leader ? all : all.filter((a) => !a.visible_until || a.visible_until >= today);
  $view.innerHTML = `
    <div class="page">
      <h1>Avisos</h1>
      ${
        rows.length
          ? rows
              .map((a) => {
                const expired = a.visible_until && a.visible_until < today;
                return `
            <article class="card announcement ${expired ? 'expired' : ''}">
              <div class="tags-row">
                ${a.pinned ? '<span class="tag role">Fixado</span>' : ''}
                ${expired ? '<span class="tag">Vencido (só a liderança vê)</span>' : a.visible_until && leader ? `<span class="tag">Até ${esc(fmtDate(a.visible_until))}</span>` : ''}
              </div>
              <h2>${esc(a.title)}</h2>
              <p class="pre">${esc(a.body)}</p>
              <p class="hint">${esc(new Date(a.created_at).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' }))}</p>
              ${leader ? `<div class="actions-row"><a class="btn small" href="#/avisos/${a.id}/editar">Editar</a><button class="btn small danger-outline" data-delete="${a.id}">Excluir</button></div>` : ''}
            </article>`;
              })
              .join('')
          : `<div class="empty"><p>Nenhum aviso por enquanto.</p></div>`
      }
      ${leader ? fab('#/avisos/novo', 'Novo aviso') : ''}
    </div>`;
  $view.querySelectorAll('[data-delete]').forEach((b) => {
    b.onclick = async () => {
      if (!await ask('Excluir este aviso?')) return;
      const { data, error: err } = await sb.from('announcements').delete().eq('id', b.dataset.delete).select('id');
      if (err || !data.length) return toast(err ? errorText(err) : 'Você não tem permissão para excluir.', 'error');
      screenForget('avisos');
      toast('Aviso excluído.');
      render();
    };
  });
}

async function viewAnnouncementForm(ctx, id) {
  if (!requireMemberFeature(id ? `/avisos/${id}/editar` : '/avisos/novo', 'avisos')) return;
  if (!isLeaderRole(myRole())) return navigate('/avisos');
  let a = { title: '', body: '', pinned: false, visible_until: null };
  if (id) {
    const data = await editItem(
      ctx,
      screenCached('avisos')?.find((x) => x.id === id),
      async () => {
        const { data: row, error } = await sb
          .from('announcements')
          .select('id, title, body, pinned, visible_until, push, created_at')
          .eq('id', id)
          .maybeSingle();
        if (error) throw error;
        return row;
      },
      () => screenForget('avisos'),
    );
    if (!data) return navigate('/avisos');
    a = data;
  }
  if (!ctx.alive()) return;
  $view.innerHTML = `
    <form id="notice" class="form page">
      <a href="#/avisos" class="back">← Avisos</a>
      <h1>${id ? 'Editar aviso' : 'Novo aviso'}</h1>
      <label>Título<input name="title" required minlength="3" maxlength="120" value="${esc(a.title)}"></label>
      <label>Aviso<textarea name="body" required rows="6" maxlength="4000">${esc(a.body)}</textarea></label>
      <label class="check"><input type="checkbox" name="pinned" ${a.pinned ? 'checked' : ''}> Fixar no topo</label>
      <label>Mostrar até (opcional)<input name="visible_until" type="date" value="${esc(a.visible_until || '')}">
        <small class="hint">Depois dessa data, o aviso some para os membros (a liderança continua vendo).</small></label>
      ${
        id
          ? ''
          : `<label class="check"><input type="checkbox" name="push"> Mandar notificação para os membros</label>
             <p class="hint">Chega em até uns 15 minutos para quem ativou as notificações, e fica na central de notificações de todos.</p>`
      }
      <button class="btn primary big">${id ? 'Salvar' : 'Publicar aviso'}</button>
    </form>`;
  const form = document.getElementById('notice');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {
      title: form.title.value.trim(),
      body: form.body.value.trim(),
      pinned: form.pinned.checked,
      visible_until: form.visible_until.value || null,
    };
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { error } = id
      ? await sb.from('announcements').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id)
      : await sb.from('announcements').insert({ ...row, church_id: state.church.id, push: form.push.checked });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    screenForget('avisos');
    toast(id ? 'Aviso salvo.' : 'Aviso publicado.');
    navigate('/avisos');
  });
}

// ---------------------------------------------------------------------
// Meus filhos e salas das crianças (supabase/012). O responsável cadastra os filhos; a liderança
// cria as salas, escolhe o tutor e coloca as crianças; o tutor marca a presença, escreve as
// anotações da aula e avisa os pais. As regras ficam no banco.
// ---------------------------------------------------------------------
// Vê a tela Salas: a liderança e quem é tutor de alguma sala.
const roomsTeam = () => featureOn('salas') && isActiveMember() && (isLeaderRole(myRole()) || !!myMember().tutor_rooms?.length);
const waUrl = (phone) => (/^55\d{10,11}$/.test(phone || '') ? `https://wa.me/${phone}` : null);

function ageOf(birth) {
  if (!birth) return null;
  const b = parseIso(birth);
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  if (now.getMonth() < b.getMonth() || (now.getMonth() === b.getMonth() && now.getDate() < b.getDate())) age--;
  return age;
}
const ageText = (birth) => {
  const a = ageOf(birth);
  return a == null ? '' : a < 1 ? 'menos de 1 ano' : a === 1 ? '1 ano' : `${a} anos`;
};
const fmtDayLong = (iso) => {
  const s = parseIso(iso).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const fmtWhen = (iso) => new Date(iso).toLocaleString('pt-BR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

async function loadRoomsList() {
  const { data, error } = await sb.rpc('rooms_list', { p_church: state.church.id });
  if (error) throw error;
  return data;
}

// Os filhos da pessoa, a sala de cada um e o último aviso das salas (últimos 7 dias).
async function loadMyKids() {
  const [kids, rooms] = await Promise.all([
    sb.from('children').select('id, name, birth_date, care_notes').eq('guardian_member_id', myMember().id).order('name'),
    loadRoomsList(),
  ]);
  if (kids.error) throw kids.error;
  const mine = rooms.filter((r) => r.my_children?.length);
  let notices = [];
  if (mine.length) {
    const since = addDays(new Date(), -7).toISOString();
    const { data, error } = await sb
      .from('room_messages')
      .select('id, room_id, title, body, created_at')
      .in('room_id', mine.map((r) => r.id))
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) throw error;
    notices = data;
  }
  return { kids: kids.data, rooms: mine, notices };
}
const roomOfKid = (rooms, kidId) => rooms.find((r) => r.my_children?.includes(kidId)) ?? null;

function homeKidsCard(el, changed) {
  return homeCard(el, 'filhos', loadMyKids, ({ rooms, notices }) => {
    if (!notices.length) return '';
    const n = notices[0];
    const room = rooms.find((r) => r.id === n.room_id);
    return `
    <section class="card">
      <h2>${icon.child} Aviso da sala${room ? ` ${esc(room.name)}` : ''}</h2>
      <article class="notice-mini">
        <strong>${esc(n.title)}</strong>
        ${n.body ? `<p class="pre clamp">${esc(n.body)}</p>` : ''}
        <small class="hint">${esc(fmtWhen(n.created_at))}</small>
      </article>
      <a href="#/filhos/sala/${n.room_id}">Ver a sala</a>
    </section>`;
  }, changed);
}

async function viewMyKids(ctx) {
  if (!requireMemberFeature('/filhos', 'salas')) return;
  await screenShow(ctx, 'filhos', loadMyKids, drawMyKids);
}

function drawMyKids({ kids, rooms }) {
  $view.innerHTML = `
    <div class="page">
      <h1>Meus filhos</h1>
      <p class="hint">Cadastre os seus filhos. A liderança coloca cada um numa sala, e aqui você vê a sala, o tutor, as presenças e os avisos.</p>
      ${
        kids.length
          ? kids
              .map((k) => {
                const r = roomOfKid(rooms, k.id);
                return `
          <section class="card kid-card">
            <h2>${esc(k.name)}</h2>
            <p class="hint">${esc([ageText(k.birth_date), k.care_notes ? `⚠️ ${k.care_notes}` : ''].filter(Boolean).join(' · '))}</p>
            ${
              r
                ? `<a class="event-card" href="#/filhos/sala/${r.id}">
                    <span><strong>Sala ${esc(r.name)}</strong><small>${r.tutor_name ? `Tutor: ${esc(r.tutor_name)}` : 'Sem tutor no momento'}</small></span>${icon.chevron}
                  </a>`
                : '<p class="hint">Ainda sem sala. A liderança escolhe a sala.</p>'
            }
            <a class="btn small" href="#/filhos/${k.id}">Editar</a>
          </section>`;
              })
              .join('')
          : '<div class="empty"><p>Nenhum filho cadastrado. Toque no <strong>+</strong> para cadastrar.</p></div>'
      }
      ${fab('#/filhos/novo', 'Cadastrar filho')}
    </div>`;
}

// A sala vista pelos pais: tutor, avisos e as aulas (anotações e se o filho estava).
async function loadParentRoom(id) {
  const rooms = await loadRoomsList();
  const room = rooms.find((r) => r.id === id) ?? null;
  if (!room) return { room: null };
  const [msgs, sessions] = await Promise.all([
    sb.from('room_messages').select('id, title, body, created_at').eq('room_id', id).order('created_at', { ascending: false }).limit(20),
    sb.from('room_sessions').select('id, session_date, notes').eq('room_id', id).order('session_date', { ascending: false }).limit(20),
  ]);
  if (msgs.error) throw msgs.error;
  if (sessions.error) throw sessions.error;
  let present = [];
  if (sessions.data.length && room.my_children?.length) {
    const { data, error } = await sb
      .from('room_attendance')
      .select('session_id, child_id')
      .in('session_id', sessions.data.map((s) => s.id))
      .in('child_id', room.my_children);
    if (error) throw error;
    present = data;
  }
  const { data: kids } = await sb.from('children').select('id, name').in('id', room.my_children || []);
  return { room, messages: msgs.data, sessions: sessions.data, present, kids: kids || [] };
}

async function viewParentRoom(ctx, id) {
  if (!requireMemberFeature(`/filhos/sala/${id}`, 'salas')) return;
  await screenShow(ctx, `salapais:${id}`, () => loadParentRoom(id), drawParentRoom);
}

function drawParentRoom({ room, messages = [], sessions = [], present = [], kids = [] }) {
  if (!room) {
    $view.innerHTML = `<div class="empty"><h2>Sala não encontrada</h2><a class="btn" href="#/filhos">Voltar</a></div>`;
    return;
  }
  const names = (sessionId) =>
    kids.filter((k) => present.some((p) => p.session_id === sessionId && p.child_id === k.id)).map((k) => firstName(k.name));
  $view.innerHTML = `
    <div class="page">
      <a href="#/filhos" class="back">← Meus filhos</a>
      <h1>Sala ${esc(room.name)}</h1>
      <p class="hint">${room.tutor_name ? `Tutor: ${esc(room.tutor_name)}` : 'Sem tutor no momento'}${room.description ? ` · ${esc(room.description)}` : ''}</p>
      <section class="card">
        <h2>${icon.megaphone} Avisos</h2>
        ${
          messages.length
            ? messages
                .map(
                  (m) => `
          <article class="notice-mini">
            <strong>${esc(m.title)}</strong>
            ${m.body ? `<p class="pre">${esc(m.body)}</p>` : ''}
            <small class="hint">${esc(fmtWhen(m.created_at))}</small>
          </article>`,
                )
                .join('')
            : '<p class="hint">Nenhum aviso ainda.</p>'
        }
      </section>
      <section class="card">
        <h2>${icon.calendar} Aulas</h2>
        ${
          sessions.length
            ? sessions
                .map((s) => {
                  const here = names(s.id);
                  return `
          <article class="notice-mini">
            <strong>${esc(fmtDayLong(s.session_date))}</strong>
            <small class="hint">${here.length ? `Presente: ${esc(joinNames(here))}` : 'Não veio'}</small>
            ${s.notes ? `<p class="pre">${esc(s.notes)}</p>` : ''}
          </article>`;
                })
                .join('')
            : '<p class="hint">Nenhuma aula registrada ainda.</p>'
        }
      </section>
    </div>`;
}

// Cadastro da criança: pelo responsável (/filhos) ou pela liderança (/salas/crianca).
async function viewChildForm(ctx, id) {
  const team = ctx.path.startsWith('/salas');
  const back = team ? '/salas/criancas' : '/filhos';
  if (!requireMemberFeature(ctx.path, 'salas')) return;
  if (team && !isLeaderRole(myRole())) return navigate('/filhos');
  let c = { name: '', birth_date: null, care_notes: '', guardian_member_id: null, guardian_name: '', guardian_phone: '', room_id: null };
  if (id) {
    const data = await editItem(
      ctx,
      null,
      async () => {
        const { data: row, error } = await sb
          .from('children')
          .select('id, name, birth_date, care_notes, guardian_member_id, guardian_name, guardian_phone, room:room_children(room_id)')
          .eq('id', id)
          .maybeSingle();
        if (error) throw error;
        return row && { ...row, room_id: row.room?.room_id ?? null };
      },
      () => (screenForget('filhos'), screenForget('criancas')),
    );
    if (!data) return navigate(back);
    c = { ...c, ...data };
  }
  const rooms = team ? screenCached('salas') || [] : [];
  if (!ctx.alive()) return;
  const desk = team && !c.guardian_member_id && (!id || c.guardian_name);
  $view.innerHTML = `
    <form id="child" class="form page">
      <a href="#${back}" class="back">← ${team ? 'Crianças' : 'Meus filhos'}</a>
      <h1>${id ? 'Editar criança' : team ? 'Cadastrar criança' : 'Cadastrar filho'}</h1>
      <label>Nome da criança<input name="name" required minlength="2" maxlength="120" value="${esc(c.name)}" autocomplete="off"></label>
      <label>Data de nascimento<input name="birth_date" type="date" value="${esc(c.birth_date || '')}" max="${isoLocal(new Date())}"></label>
      <label>Alergias e cuidados (opcional)<textarea name="care_notes" rows="2" maxlength="300" placeholder="Ex.: alergia a amendoim; usa bombinha">${esc(c.care_notes || '')}</textarea>
        <small class="hint">Aparece com ⚠️ para o tutor da sala.</small></label>
      ${
        desk
          ? `<label>Nome do responsável<input name="guardian_name" required minlength="2" maxlength="120" value="${esc(c.guardian_name || '')}"></label>
             <label>WhatsApp do responsável<input name="guardian_phone" type="tel" inputmode="tel" value="${c.guardian_phone ? esc(fmtPhone(c.guardian_phone)) : ''}" placeholder="(61) 99999-0000"></label>`
          : team && id
            ? '<p class="hint">O responsável usa o app: só ele muda os dados de contato.</p>'
            : ''
      }
      ${
        team
          ? `<label>Sala
              <select name="room_id">
                <option value="">Sem sala</option>
                ${rooms.map((r) => `<option value="${r.id}" ${r.id === c.room_id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
              </select>
            </label>`
          : ''
      }
      ${
        id
          ? ''
          : `<label class="check"><input type="checkbox" name="consent" required> ${
              team ? 'O responsável autorizou a igreja a guardar estes dados.' : 'Autorizo a igreja a guardar estes dados do meu filho para as salas das crianças.'
            }
            <small class="hint">Só o responsável, o tutor da sala e a liderança veem. As presenças e as anotações são apagadas em 12 meses.</small></label>`
      }
      <button class="btn primary big">${id ? 'Salvar' : 'Cadastrar'}</button>
      ${id ? '<button class="btn danger-outline" type="button" id="delete">Excluir cadastro da criança</button>' : ''}
    </form>`;
  const form = document.getElementById('child');
  if (team)
    screenFetch('salas', loadRoomsList)
      .then((list) => {
        if (!form.isConnected) return;
        const cur = form.room_id.value || c.room_id;
        form.room_id.innerHTML =
          '<option value="">Sem sala</option>' + list.map((r) => `<option value="${r.id}" ${r.id === cur ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
      })
      .catch(() => {});
  const forget = () => {
    screenForget('filhos');
    screenForget('criancas');
    screenForget('salas');
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = {
      name: form.name.value.trim(),
      birth_date: form.birth_date.value || null,
      care_notes: form.care_notes.value.trim() || null,
    };
    if (desk) {
      const phone = form.guardian_phone.value.trim() ? normalizePhone(form.guardian_phone.value) : null;
      if (form.guardian_phone.value.trim() && !phone) return toast('WhatsApp inválido. Use DDD + número.', 'error');
      Object.assign(row, { guardian_name: form.guardian_name.value.trim(), guardian_phone: phone });
    }
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = id
      ? await sb.from('children').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id).select('id').single()
      : await sb
          .from('children')
          .insert({ ...row, church_id: state.church.id, ...(team ? {} : { guardian_member_id: myMember().id }) })
          .select('id')
          .single();
    if (!error && team && (form.room_id.value || null) !== c.room_id) {
      const { error: err } = await sb.rpc('room_assign', { p_child: data.id, p_room: form.room_id.value || null });
      if (err) {
        btn.disabled = false;
        return toast(errorText(err), 'error');
      }
    }
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    forget();
    toast(id ? 'Salvo.' : 'Criança cadastrada.');
    navigate(back);
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask(`Excluir o cadastro de ${c.name}? As presenças também são apagadas.`, { danger: true, ok: 'Excluir' })) return;
    const { data, error } = await sb.from('children').delete().eq('id', id).select('id');
    if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para excluir.', 'error');
    forget();
    toast('Cadastro excluído.');
    navigate(back);
  });
}

function requireRoomsTeam(next) {
  if (!requireMemberFeature(next, 'salas')) return false;
  if (roomsTeam()) return true;
  navigate('/filhos');
  return false;
}

// Salas: a liderança vê todas; o tutor, as dele.
async function viewRooms(ctx) {
  if (!requireRoomsTeam('/salas')) return;
  await screenShow(ctx, 'salas', loadRoomsList, drawRooms);
}

function drawRooms(rooms) {
  const leader = isLeaderRole(myRole());
  const list = leader ? rooms : rooms.filter((r) => r.is_tutor);
  $view.innerHTML = `
    <div class="page">
      <h1>${leader ? 'Salas das crianças' : 'Minhas salas'}</h1>
      ${leader ? `<a class="btn" href="#/salas/criancas">${icon.child} Todas as crianças</a>` : ''}
      ${
        list.length
          ? `<div class="list">${list
              .map(
                (r) => `
          <a class="event-card" href="#/salas/${r.id}">
            <span><strong>${esc(r.name)}</strong>
              <small>${r.kids === 1 ? '1 criança' : `${r.kids} crianças`} · ${r.tutor_name ? `Tutor: ${esc(r.tutor_name)}` : 'Sem tutor'}</small></span>${icon.chevron}
          </a>`,
              )
              .join('')}</div>`
          : `<div class="empty"><p>${leader ? 'Nenhuma sala ainda. Toque no <strong>+</strong> para criar.' : 'Você não é tutor de nenhuma sala.'}</p></div>`
      }
      ${leader ? fab('#/salas/nova', 'Nova sala') : ''}
    </div>`;
}

// Criar ou editar a sala (liderança): nome, descrição e o tutor.
async function viewRoomForm(ctx, id) {
  if (!requireMemberFeature(ctx.path, 'salas')) return;
  if (!isLeaderRole(myRole())) return navigate('/salas');
  const blank = { name: '', description: '', tutor_member_id: null };
  const tutorOptions = (members, current) =>
    '<option value="">Sem tutor</option>' +
    members
      .filter((m) => m.status === 'ativo')
      .map((m) => `<option value="${m.id}" ${m.id === current ? 'selected' : ''}>${esc(m.name)}${m.user_id ? '' : ' (sem app)'}</option>`)
      .join('');
  let form = null;
  const draw = (r, members) => {
    $view.innerHTML = `
    <form id="room" class="form page">
      <a href="#${id ? `/salas/${id}` : '/salas'}" class="back">← ${id ? esc(r.name) : 'Salas'}</a>
      <h1>${id ? 'Editar sala' : 'Nova sala'}</h1>
      <label>Nome da sala<input name="name" required minlength="2" maxlength="40" value="${esc(r.name)}" placeholder="Ex.: Maternal, Kids, Juniores"></label>
      <label>Descrição (opcional)<input name="description" maxlength="200" value="${esc(r.description || '')}" placeholder="Ex.: de 3 a 5 anos, sala 2"></label>
      <label>Tutor
        <select name="tutor">${tutorOptions(members, r.tutor_member_id)}</select>
        <small class="hint">O tutor vê as crianças da sala, marca a presença, escreve as anotações da aula e avisa os pais. Ele precisa usar o app.</small>
      </label>
      <button class="btn primary big">${id ? 'Salvar' : 'Criar sala'}</button>
      ${id ? '<button class="btn danger-outline" type="button" id="delete">Apagar sala</button>' : ''}
    </form>`;
    form = document.getElementById('room');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const row = { name: form.name.value.trim(), description: form.description.value.trim() || null, tutor_member_id: form.tutor.value || null };
      const btn = form.querySelector('button.primary');
      btn.disabled = true;
      const { data, error } = id
        ? await sb.from('kids_rooms').update(row).eq('id', id).select('id').single()
        : await sb.from('kids_rooms').insert({ ...row, church_id: state.church.id }).select('id').single();
      btn.disabled = false;
      if (error) return toast(/duplicate|unique/i.test(error.message) ? 'Já existe uma sala com esse nome.' : errorText(error), 'error');
      screenForget('salas');
      // O tutor mudou: a própria pessoa pode ter virado (ou deixado de ser) tutor.
      await loadMemberships();
      toast(id ? 'Sala salva.' : 'Sala criada.');
      navigate(`/salas/${data.id}`);
    });
    document.getElementById('delete')?.addEventListener('click', async () => {
      if (!await ask(`Apagar a sala ${r.name}? As crianças ficam sem sala, e as presenças e anotações da sala são apagadas.`, { danger: true, ok: 'Apagar' })) return;
      const { data, error } = await sb.from('kids_rooms').delete().eq('id', id).select('id');
      if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para apagar.', 'error');
      screenForget('salas');
      await loadMemberships();
      toast('Sala apagada.');
      navigate('/salas');
    });
  };
  // Desenha na hora com o guardado (salas e membros) e completa com o banco.
  const cachedRoom = id ? screenCached('salas')?.find((x) => x.id === id) : blank;
  if (cachedRoom) draw(cachedRoom, membersCache.get(state.church.id) || []);
  const [rooms, members] = await Promise.all([screenFetch('salas', loadRoomsList), fetchMembers(state.church.id)]);
  if (!ctx.alive()) return;
  const r = id ? rooms.find((x) => x.id === id) : blank;
  if (!r) return navigate('/salas');
  if (!form?.isConnected) return draw(r, members);
  // Já na tela: só completa a lista de tutores, sem apagar o que a pessoa digitou.
  const chosen = form.tutor.value || r.tutor_member_id;
  form.tutor.innerHTML = tutorOptions(members, chosen);
}

// A sala para o tutor e a liderança: presença do dia, anotações, contato dos pais e avisos.
async function loadRoom(id, day) {
  const [rooms, roster, session, msgs] = await Promise.all([
    loadRoomsList(),
    sb.rpc('room_roster', { p_room: id, p_day: day }),
    sb.from('room_sessions').select('id, notes').eq('room_id', id).eq('session_date', day).maybeSingle(),
    sb.from('room_messages').select('id, title, body, created_at').eq('room_id', id).order('created_at', { ascending: false }).limit(5),
  ]);
  if (roster.error) throw roster.error;
  if (session.error) throw session.error;
  if (msgs.error) throw msgs.error;
  return { room: rooms.find((r) => r.id === id) ?? null, kids: roster.data, notes: session.data?.notes ?? '', messages: msgs.data, day };
}

async function viewRoom(ctx, id) {
  if (!requireRoomsTeam(`/salas/${id}`)) return;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(ctx.params.get('dia') || '') ? ctx.params.get('dia') : isoLocal(new Date());
  await screenShow(ctx, `sala:${id}:${day}`, () => loadRoom(id, day), (d) => drawRoom(ctx, id, d));
}

function drawRoom(ctx, id, { room, kids, notes, messages, day }) {
  if (!room) {
    $view.innerHTML = `<div class="empty"><h2>Sala não encontrada</h2><a class="btn" href="#/salas">Voltar</a></div>`;
    return;
  }
  const leader = isLeaderRole(myRole());
  const here = kids.filter((k) => k.present).length;
  $view.innerHTML = `
    <div class="page">
      <a href="#/salas" class="back">← Salas</a>
      <h1>Sala ${esc(room.name)}</h1>
      <p class="hint">${room.tutor_name ? `Tutor: ${esc(room.tutor_name)}` : 'Sem tutor'}${room.description ? ` · ${esc(room.description)}` : ''}</p>
      <div class="actions-row">
        <a class="btn" href="#/salas/${id}/aviso">${icon.megaphone} Avisar os pais</a>
        ${leader ? `<a class="btn" href="#/salas/${id}/editar">${icon.gear} Editar sala</a>` : ''}
      </div>

      <section class="card">
        <h2>${icon.clipboard} Presença</h2>
        <label>Dia da aula<input type="date" id="room-day" value="${esc(day)}" max="${isoLocal(addDays(new Date(), 1))}"></label>
        <p class="hint" id="room-count">${here} de ${kids.length} presente${kids.length === 1 ? '' : 's'}</p>
        ${
          kids.length
            ? `<div class="list">${kids
                .map((k) => {
                  const wa = waUrl(k.phone);
                  return `
            <div class="kid-row">
              <label class="check kid-present"><input type="checkbox" data-kid="${k.id}" ${k.present ? 'checked' : ''}>
                <span><strong>${esc(k.name)}</strong>
                  <small>${esc([ageText(k.birth_date), k.care_notes ? `⚠️ ${k.care_notes}` : ''].filter(Boolean).join(' · '))}</small>
                  <small>Responsável: ${esc(k.guardian || '—')}${k.has_app ? '' : ' (sem app)'}</small></span>
              </label>
              ${wa ? `<a class="btn small" href="${esc(wa)}" target="_blank" rel="noopener" aria-label="WhatsApp de ${esc(k.guardian || 'responsável')}">WhatsApp</a>` : ''}
            </div>`;
                })
                .join('')}</div>`
            : `<p class="hint">Nenhuma criança nesta sala.${leader ? ' Coloque as crianças pela tela <a href="#/salas/criancas">Todas as crianças</a>.' : ' A liderança coloca as crianças na sala.'}</p>`
        }
      </section>

      <form class="card form" id="room-notes">
        <h2>${icon.file} Anotações da aula</h2>
        <label>O que aconteceu na aula (os pais leem)
          <textarea name="notes" rows="4" maxlength="2000" placeholder="Ex.: hoje aprendemos a história de Davi; tragam lápis de cor no domingo">${esc(notes || '')}</textarea></label>
        <button class="btn primary">Salvar anotações</button>
      </form>

      <section class="card">
        <h2>${icon.megaphone} Últimos avisos</h2>
        ${
          messages.length
            ? messages
                .map(
                  (m) => `
          <article class="notice-mini"><strong>${esc(m.title)}</strong>${m.body ? `<p class="pre clamp">${esc(m.body)}</p>` : ''}
            <small class="hint">${esc(fmtWhen(m.created_at))}</small></article>`,
                )
                .join('')
            : '<p class="hint">Nenhum aviso enviado.</p>'
        }
      </section>
    </div>`;

  document.getElementById('room-day').addEventListener('change', (e) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) navigate(`/salas/${id}?dia=${e.target.value}`);
  });
  $view.querySelectorAll('[data-kid]').forEach((box) =>
    box.addEventListener('change', async () => {
      box.disabled = true;
      const { error } = await sb.rpc('room_mark', { p_room: id, p_day: day, p_child: box.dataset.kid, p_present: box.checked });
      box.disabled = false;
      if (error) {
        box.checked = !box.checked;
        return toast(errorText(error), 'error');
      }
      const kid = kids.find((k) => k.id === box.dataset.kid);
      if (kid) kid.present = box.checked;
      screenForget(`sala:${id}:${day}`);
      const n = kids.filter((k) => k.present).length;
      document.getElementById('room-count').textContent = `${n} de ${kids.length} presente${kids.length === 1 ? '' : 's'}`;
    }),
  );
  const form = document.getElementById('room-notes');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    const { error } = await sb.rpc('room_session_save', { p_room: id, p_day: day, p_notes: form.notes.value.trim() });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    screenForget(`sala:${id}:${day}`);
    toast('Anotações salvas.');
  });
}

// Aviso para os pais da sala (vai para a central e por push).
async function viewRoomNotice(ctx, id) {
  if (!requireRoomsTeam(`/salas/${id}/aviso`)) return;
  const nameOf = (list) => list?.find((r) => r.id === id)?.name;
  const known = nameOf(screenCached('salas'));
  $view.innerHTML = `
    <form id="notice" class="form page">
      <a href="#/salas/${id}" class="back" id="notice-back">← ${known ? `Sala ${esc(known)}` : 'Sala'}</a>
      <h1>Avisar os pais</h1>
      <p class="hint">Vai para os pais das crianças da sala que usam o app, na central de notificações e no celular de quem ativou. Na tela de bloqueio aparece só o título.</p>
      <label>Título<input name="title" required minlength="2" maxlength="80" placeholder="Ex.: Domingo tem passeio"></label>
      <label>Mensagem (opcional)<textarea name="body" rows="5" maxlength="1000"></textarea></label>
      <button class="btn primary big">${icon.send} Enviar aviso</button>
    </form>`;
  const form = document.getElementById('notice');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button');
    btn.disabled = true;
    const { data, error } = await sb.rpc('room_notify', { p_room: id, p_title: form.title.value.trim(), p_body: form.body.value.trim() });
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    screenForget(`sala:${id}:${isoLocal(new Date())}`);
    toast(data ? `Aviso enviado para ${data === 1 ? '1 pessoa' : `${data} pessoas`}.` : 'Aviso guardado na sala. Nenhum responsável desta sala usa o app ainda.');
    navigate(`/salas/${id}`);
  });
  if (!known) {
    const name = nameOf(await screenFetch('salas', loadRoomsList).catch(() => []));
    const back = document.getElementById('notice-back');
    if (name && back && ctx.alive()) back.textContent = `← Sala ${name}`;
  }
}

// Todas as crianças (liderança): sala de cada uma, busca e cadastro.
async function loadAllKids() {
  const [kids, rooms] = await Promise.all([
    sb
      .from('children')
      .select('id, name, birth_date, care_notes, guardian_member_id, guardian_name, room:room_children(room_id)')
      .eq('church_id', state.church.id)
      .order('name'),
    loadRoomsList(),
  ]);
  if (kids.error) throw kids.error;
  return { kids: kids.data.map((k) => ({ ...k, room_id: k.room?.room_id ?? null })), rooms };
}

async function viewAllKids(ctx) {
  if (!requireMemberFeature('/salas/criancas', 'salas')) return;
  if (!isLeaderRole(myRole())) return navigate('/salas');
  await screenShow(ctx, 'criancas', loadAllKids, (d) => drawAllKids(ctx, d));
}

function drawAllKids(ctx, { kids, rooms }) {
  const roomName = (id) => rooms.find((r) => r.id === id)?.name;
  const term = fold(ctx.params.get('busca') || '');
  const list = term ? kids.filter((k) => fold(k.name).includes(term)) : kids;
  const noRoom = kids.filter((k) => !k.room_id).length;
  $view.innerHTML = `
    <div class="page">
      <a href="#/salas" class="back">← Salas</a>
      <h1>Crianças</h1>
      <p class="hint">${kids.length === 1 ? '1 criança' : `${kids.length} crianças`}${noRoom ? ` · ${noRoom} sem sala` : ''}. Toque numa criança para escolher a sala.</p>
      <form id="kid-search"><label class="search">${icon.search}<input type="search" name="busca" placeholder="Buscar pelo nome" aria-label="Buscar criança pelo nome" value="${esc(ctx.params.get('busca') || '')}"></label></form>
      ${
        list.length
          ? `<div class="list">${list
              .map(
                (k) => `
          <a class="event-card" href="#/salas/crianca/${k.id}">
            <span><strong>${esc(k.name)}</strong>
              <small>${esc([ageText(k.birth_date), k.room_id ? `Sala ${roomName(k.room_id) || ''}` : 'Sem sala'].filter(Boolean).join(' · '))}</small></span>${icon.chevron}
          </a>`,
              )
              .join('')}</div>`
          : '<div class="empty"><p>Nenhuma criança encontrada. Os pais cadastram os filhos em Meus filhos; a liderança também cadastra no <strong>+</strong>.</p></div>'
      }
      ${fab('#/salas/crianca/nova', 'Cadastrar criança')}
    </div>`;
  document.getElementById('kid-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = e.target.busca.value.trim();
    navigate(v ? `/salas/criancas?busca=${encodeURIComponent(v)}` : '/salas/criancas');
  });
}

// ---------------------------------------------------------------------
// Carteirinha digital: o próprio cadastro (guardado no aparelho) com o QR Code de conferência
// ---------------------------------------------------------------------
const cardUrl = (token) => `${PAGE_URL}#/carteirinha/verificar/${token}`;
const fmtLongDate = (iso) => parseIso(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
const cardLines = (m) =>
  [
    m.member_since ? ['Membro desde', fmtLongDate(m.member_since)] : null,
    m.baptism_date ? ['Batismo', fmtLongDate(m.baptism_date)] : null,
  ].filter(Boolean);

async function viewCard(ctx) {
  if (!requireMemberFeature('/carteirinha', 'carteirinha')) return;
  const me = myMember();
  // Mesmo guardado do "Meu cadastro": abre na hora, até sem internet.
  await screenShowWithPhotos(
    ctx,
    'perfil',
    () => loadProfile(me.id),
    (m) => [m.photo_path],
    (m, photos) => drawCard(ctx, m, photos),
  );
}

function drawCard(ctx, m, photos) {
  const c = state.church;
  const photo = m.photo_path && photos[miniOf(m.photo_path)];
  $view.innerHTML = `
    <div class="page">
      <h1>Minha carteirinha</h1>
      <div class="member-card" style="--card: ${esc(c.primary_color || DEFAULT_COLOR)}; --card-ink: ${esc(inkOn(c.primary_color || DEFAULT_COLOR))}">
        <div class="member-card-head">
          <img src="${esc(c.logo_url || 'icons/icon-192.png')}" alt="" width="40" height="40">
          <span>${esc(c.name)}</span>
        </div>
        <div class="member-card-body">
          ${avatar(m.name, photo, 'big')}
          <div>
            <p class="member-card-name">${esc(m.name)}</p>
            <p class="member-card-role">${esc(ROLES[m.role])}</p>
            ${cardLines(m).map(([k, v]) => `<p><small>${esc(k)}</small> ${esc(v)}</p>`).join('')}
          </div>
        </div>
        <div class="member-card-qr" id="card-qr" aria-label="QR Code para conferir a carteirinha"></div>
        <p class="member-card-foot">Aponte a câmera para conferir</p>
      </div>
      <div class="actions-row">
        <button class="btn primary" id="card-save">${icon.upload} Salvar imagem</button>
        <button class="btn" id="card-rotate">Gerar novo QR Code</button>
      </div>
      <p class="hint">Quem ler o QR Code vê se você é membro ativo da igreja, com o nome, o papel e "membro desde". A foto, o telefone e o e-mail não aparecem. Se alguém copiou a sua carteirinha, gere um novo QR Code: o anterior deixa de valer.</p>
      ${m.member_since ? '' : '<p class="hint">"Membro desde" é preenchido pela secretaria ou pela liderança.</p>'}
    </div>`;
  qrSvg(cardUrl(m.card_token))
    .then((svg) => {
      const box = document.getElementById('card-qr');
      if (box && ctx.alive()) box.innerHTML = svg;
    })
    .catch(() => {});

  const saveBtn = document.getElementById('card-save');
  saveBtn.onclick = async () => {
    saveBtn.disabled = true;
    try {
      const blob = await cardImage(m, photo);
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: `carteirinha-${slugify(firstName(m.name))}.png` });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('Imagem salva.');
    } catch {
      toast('Não foi possível gerar a imagem.', 'error');
    } finally {
      saveBtn.disabled = false;
    }
  };
  document.getElementById('card-rotate').onclick = async () => {
    if (!await ask('Gerar um novo QR Code? O anterior (e as imagens salvas com ele) deixa de valer.')) return;
    const { data: token, error } = await sb.rpc('rotate_card_token', { p_church: c.id });
    if (error) return toast(errorText(error), 'error');
    Object.assign(m, { card_token: token, card_token_at: new Date().toISOString() });
    screenUpdate('perfil', m);
    toast('Novo QR Code gerado.');
    drawCard(ctx, m, photos);
  };
}

// Carteirinha como imagem (PNG), desenhada no aparelho.
async function cardImage(m, photoUrl) {
  const c = state.church;
  const color = c.primary_color || DEFAULT_COLOR;
  const ink = inkOn(color);
  const W = 1000;
  const H = 1400;
  const cv = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = cv.getContext('2d');
  const load = (src) =>
    new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
    });
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.fillStyle = color;
  g.fillRect(0, 0, W, 300);
  const [logo, photo, qr] = await Promise.all([load(c.logo_url || 'icons/icon-192.png'), load(photoUrl), qrImage(cardUrl(m.card_token), 14)]);
  if (logo) g.drawImage(logo, 60, 60, 120, 120);
  g.fillStyle = ink;
  g.font = 'bold 52px system-ui, sans-serif';
  g.fillText(c.name.slice(0, 26), 210, 140);
  g.font = '32px system-ui, sans-serif';
  g.fillText('Carteirinha de membro', 210, 195);
  // Foto (ou as iniciais) num círculo
  g.save();
  g.beginPath();
  g.arc(W / 2, 400, 150, 0, Math.PI * 2);
  g.closePath();
  g.fillStyle = '#e9ecf5';
  g.fill();
  g.clip();
  if (photo) g.drawImage(photo, W / 2 - 150, 250, 300, 300);
  else {
    g.fillStyle = '#5f6475';
    g.font = 'bold 110px system-ui, sans-serif';
    g.textAlign = 'center';
    g.fillText(initials(m.name), W / 2, 440);
  }
  g.restore();
  g.textAlign = 'center';
  g.fillStyle = '#1b1e27';
  g.font = 'bold 56px system-ui, sans-serif';
  g.fillText(m.name.slice(0, 32), W / 2, 640);
  g.fillStyle = '#5f6475';
  g.font = '38px system-ui, sans-serif';
  g.fillText(ROLES[m.role], W / 2, 700);
  let y = 770;
  for (const [k, v] of cardLines(m)) {
    g.fillText(`${k}: ${v}`, W / 2, y);
    y += 52;
  }
  g.drawImage(qr, W / 2 - 220, 880, 440, 440);
  g.font = '28px system-ui, sans-serif';
  g.fillText('Aponte a câmera para conferir', W / 2, 1360);
  return new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error('imagem'))), 'image/png'));
}

// Conferência pública (sem login): o banco responde só pelo código exato da carteirinha.
async function viewCardVerify(ctx, token) {
  $view.innerHTML = '<div class="page card-verify"><p class="hint center">Conferindo a carteirinha…</p></div>';
  const { data, error } = await sb.rpc('verify_member_card', { p_token: token });
  if (!ctx.alive()) return;
  if (error) throw error;
  const r = data?.[0];
  const now = new Date().toLocaleString('pt-BR', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  $view.innerHTML = `
    <div class="page card-verify">
      ${
        !r
          ? `<div class="verify-result bad"><p class="verify-icon">❌</p><h1>Carteirinha não reconhecida</h1>
               <p>O QR Code pode ter sido trocado por um novo, ou a igreja não usa mais a carteirinha digital.</p></div>`
          : `<div class="verify-result ${r.active ? 'ok' : 'warn'}">
               <img src="${esc(r.logo_url || 'icons/icon-192.png')}" alt="" width="64" height="64">
               <p class="verify-icon">${r.active ? '✅' : '⚠️'}</p>
               <h1>${r.active ? 'Membro ativo' : 'Este cadastro não está ativo'}</h1>
               <p class="verify-church">${esc(r.church_name)}</p>
               <p class="member-card-name">${esc(r.name)}</p>
               <p>${esc(ROLES[r.role] || '')}</p>
               ${r.member_since ? `<p>Membro desde ${esc(fmtLongDate(r.member_since))}</p>` : ''}
             </div>`
      }
      <p class="hint center">Conferido em ${esc(now)} pelo ${esc(CONFIG.APP_NAME)}.</p>
    </div>`;
}

// ---------------------------------------------------------------------
// Galeria de fotos: álbuns só para os membros; publicam a liderança e o ministério marcado
// ---------------------------------------------------------------------
const GALLERY_LIMIT = 300; // o banco confere (gallery_limit)
const galleryTeam = () => featureOn('galeria') && (isLeaderRole(myRole()) || (isActiveMember() && !!myMember().gallery_team));

// Links das pastas privadas (fotos da galeria, PDFs das ATAs), válidos por 1 hora e guardados
// em memória por 50 minutos.
const galleryLinks = new Map();
async function galleryUrls(paths, bucket = 'galeria') {
  const now = Date.now();
  const out = {};
  const missing = [];
  for (const p of paths) {
    const hit = galleryLinks.get(`${bucket}:${p}`);
    if (hit && hit.until > now) out[p] = hit.url;
    else missing.push(p);
  }
  for (let i = 0; i < missing.length; i += 100) {
    const { data, error } = await sb.storage.from(bucket).createSignedUrls(missing.slice(i, i + 100), 3600);
    if (error) continue;
    for (const d of data) {
      if (!d.signedUrl) continue;
      galleryLinks.set(`${bucket}:${d.path}`, { url: d.signedUrl, until: now + 50 * 60 * 1000 });
      out[d.path] = d.signedUrl;
    }
  }
  return out;
}
const knownGallery = (paths, bucket = 'galeria') => {
  const now = Date.now();
  return Object.fromEntries(paths.map((p) => [p, galleryLinks.get(`${bucket}:${p}`)]).filter(([, h]) => h && h.until > now).map(([p, h]) => [p, h.url]));
};

// Desenha na hora com os links já conhecidos e de novo quando os que faltam chegam.
async function showWithGalleryLinks(ctx, name, fetcher, pathsOf, draw, bucket = 'galeria') {
  await screenShow(ctx, name, fetcher, (data) => draw(data, knownGallery(pathsOf(data), bucket)));
  const data = screenCached(name);
  if (!data || !ctx.alive()) return;
  const paths = pathsOf(data);
  if (paths.every((p) => knownGallery([p], bucket)[p])) return;
  const urls = await galleryUrls(paths, bucket).catch(() => ({}));
  if (ctx.alive()) draw(data, urls);
}

const thumb = (url, alt = '') => (url ? `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy">` : '<span class="thumb-wait" aria-hidden="true"></span>');

async function loadAlbums() {
  const { data, error } = await sb.rpc('gallery_album_list', { p_church: state.church.id });
  if (error) throw error;
  return data;
}

async function viewGallery(ctx) {
  if (!requireMemberFeature('/galeria', 'galeria')) return;
  await showWithGalleryLinks(ctx, 'galeria', loadAlbums, (all) => all.map((a) => a.cover_mini).filter(Boolean), drawGallery);
}

function drawGallery(albums, urls) {
  const team = galleryTeam();
  const used = albums.reduce((n, a) => n + a.photos, 0);
  $view.innerHTML = `
    <div class="page">
      <h1>Galeria</h1>
      ${
        team
          ? `<p class="hint ${used >= GALLERY_LIMIT * 0.9 ? 'warn' : ''}">${used} de ${GALLERY_LIMIT} fotos usadas${used >= GALLERY_LIMIT * 0.9 ? '. Apague álbuns antigos para liberar espaço.' : '.'}</p>`
          : ''
      }
      ${
        albums.length
          ? `<div class="album-grid">${albums
              .map(
                (a) => `
          <a class="album-card" href="#/galeria/${a.id}">
            <span class="album-cover">${thumb(a.cover_mini && urls[a.cover_mini], a.title)}</span>
            <strong>${esc(a.title)}</strong>
            <small>${esc(fmtDate(a.album_date))} · ${a.photos} ${a.photos === 1 ? 'foto' : 'fotos'}</small>
          </a>`,
              )
              .join('')}</div>`
          : `<div class="empty"><p>Nenhum álbum ainda.${team ? ' Toque no <strong>+</strong> para criar o primeiro.' : ''}</p></div>`
      }
      <p class="hint">As fotos são vistas só por quem é da igreja. Se você aparece numa foto e prefere que ela saia, abra a foto e toque em <em>Pedir para tirar esta foto</em>.</p>
      ${team ? fab('#/galeria/novo', 'Novo álbum') : ''}
    </div>`;
}

async function loadAlbum(id) {
  const [albumRes, photosRes] = await Promise.all([
    sb.from('gallery_albums').select('id, title, album_date, description, cover_photo_id').eq('id', id).maybeSingle(),
    sb.from('gallery_photos').select('id, path, mini_path').eq('album_id', id).order('created_at'),
  ]);
  if (albumRes.error) throw albumRes.error;
  if (photosRes.error) throw photosRes.error;
  return { album: albumRes.data, photos: photosRes.data };
}
const forgetAlbum = (id) => {
  screenForget('galeria');
  screenForget(`album:${id}`);
};

async function viewAlbum(ctx, id) {
  if (!requireMemberFeature(`/galeria/${id}`, 'galeria')) return;
  await showWithGalleryLinks(ctx, `album:${id}`, () => loadAlbum(id), (d) => d.photos.map((p) => p.mini_path), (d, urls) => drawAlbum(ctx, id, d, urls));
}

function drawAlbum(ctx, id, { album, photos }, urls) {
  if (!album) {
    $view.innerHTML = `<div class="empty"><h2>Álbum não encontrado</h2><a class="btn" href="#/galeria">Voltar</a></div>`;
    return;
  }
  const team = galleryTeam();
  $view.innerHTML = `
    <div class="page">
      <a href="#/galeria" class="back">← Galeria</a>
      <h1>${esc(album.title)}</h1>
      <p class="hint">${esc(fmtDate(album.album_date))} · ${photos.length} ${photos.length === 1 ? 'foto' : 'fotos'}</p>
      ${album.description ? `<p class="pre">${esc(album.description)}</p>` : ''}
      ${
        team
          ? `<div class="actions-row">
              <label class="btn primary">${icon.upload} Adicionar fotos<input type="file" id="add-photos" accept="image/*" multiple hidden></label>
              <a class="btn" href="#/galeria/${id}/editar">Editar álbum</a>
            </div>
            <p class="hint" id="upload-status" aria-live="polite"></p>`
          : ''
      }
      ${
        photos.length
          ? `<div class="photo-grid">${photos
              .map((p, i) => `<a class="photo-thumb" href="#/galeria/${id}/foto/${p.id}" aria-label="Foto ${i + 1} de ${photos.length}">${thumb(urls[p.mini_path])}</a>`)
              .join('')}</div>`
          : `<div class="empty"><p>Nenhuma foto neste álbum.</p></div>`
      }
    </div>`;

  document.getElementById('add-photos')?.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const status = document.getElementById('upload-status');
    const input = e.target;
    input.disabled = true;
    let sent = 0;
    let stop = null;
    for (const [i, file] of files.entries()) {
      if (status) status.textContent = `Reduzindo e enviando ${i + 1} de ${files.length}…`;
      try {
        await uploadGalleryPhoto(id, file);
        sent++;
      } catch (err) {
        stop = errorText(err);
        if (/limite/.test(stop)) break;
      }
    }
    forgetAlbum(id);
    if (stop) toast(sent ? `${sent} ${sent === 1 ? 'foto enviada' : 'fotos enviadas'}. ${stop}` : stop, 'error');
    else toast(`${sent} ${sent === 1 ? 'foto enviada' : 'fotos enviadas'}.`);
    if (ctx.alive()) render();
  });
}

// Reduz no aparelho, registra no banco (que confere o limite) e envia a foto e a miniatura.
async function uploadGalleryPhoto(albumId, file) {
  const { big, mini, ext } = await resizeForGallery(file);
  const { data, error } = await sb.rpc('gallery_add_photo', { p_album: albumId, p_ext: ext });
  if (error) throw error;
  const [row] = data;
  const bucket = sb.storage.from('galeria');
  try {
    for (const [path, blob] of [[row.path, big], [row.mini_path, mini]]) {
      const { error: err } = await bucket.upload(path, blob, { contentType: blob.type, cacheControl: '3600' });
      if (err) throw err;
    }
  } catch (err) {
    await bucket.remove([row.path, row.mini_path]).catch(() => {});
    await sb.from('gallery_photos').delete().eq('id', row.photo_id);
    throw err;
  }
}

async function removeGalleryFiles(photos) {
  const paths = photos.flatMap((p) => [p.path, p.mini_path]);
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await sb.storage.from('galeria').remove(paths.slice(i, i + 100));
    if (error) throw error;
  }
}

// Foto em tela cheia: passar para o lado, baixar, compartilhar, pedir para tirar.
async function viewGalleryPhoto(ctx, albumId, photoId) {
  if (!requireMemberFeature(`/galeria/${albumId}/foto/${photoId}`, 'galeria')) return;
  await showWithGalleryLinks(
    ctx,
    `album:${albumId}`,
    () => loadAlbum(albumId),
    (d) => {
      const p = d.photos.find((x) => x.id === photoId);
      return p ? [p.path, p.mini_path] : [];
    },
    (d, urls) => drawGalleryPhoto(ctx, albumId, photoId, d, urls),
  );
}

function drawGalleryPhoto(ctx, albumId, photoId, { album, photos }, urls) {
  const i = photos.findIndex((p) => p.id === photoId);
  if (!album || i < 0) {
    $view.innerHTML = `<div class="empty"><h2>Foto não encontrada</h2><p>Ela pode ter sido apagada.</p><a class="btn" href="#/galeria/${albumId}">Voltar ao álbum</a></div>`;
    return;
  }
  const p = photos[i];
  const prev = photos[i - 1];
  const next = photos[i + 1];
  const team = galleryTeam();
  const src = urls[p.path] || urls[p.mini_path];
  $view.innerHTML = `
    <div class="page photo-view">
      <a href="#/galeria/${albumId}" class="back">← ${esc(album.title)}</a>
      <div class="photo-stage" id="stage">
        ${src ? `<img src="${esc(src)}" alt="Foto ${i + 1} de ${photos.length}">` : '<span class="thumb-wait big" aria-hidden="true"></span>'}
        ${prev ? `<a class="photo-nav prev" href="#/galeria/${albumId}/foto/${prev.id}" aria-label="Foto anterior">‹</a>` : ''}
        ${next ? `<a class="photo-nav next" href="#/galeria/${albumId}/foto/${next.id}" aria-label="Próxima foto">›</a>` : ''}
      </div>
      <p class="hint center">${i + 1} de ${photos.length}</p>
      <div class="actions-row">
        <button class="btn" id="share">Compartilhar</button>
        <button class="btn" id="download">${icon.upload} Baixar</button>
      </div>
      ${
        team
          ? `<div class="actions-row">
              ${album.cover_photo_id === p.id ? '<span class="tag ok">Capa do álbum</span>' : '<button class="btn small" id="cover">Usar como capa</button>'}
              <button class="btn small danger-outline" id="delete">Apagar foto</button>
            </div>`
          : ''
      }
      <button class="btn link" id="takedown">Pedir para tirar esta foto</button>
    </div>`;

  // Arrastar para o lado troca de foto.
  const stage = document.getElementById('stage');
  let startX = null;
  stage.addEventListener('touchstart', (e) => (startX = e.touches[0].clientX), { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (startX == null) return;
    const dx = e.changedTouches[0].clientX - startX;
    startX = null;
    const to = dx < -50 ? next : dx > 50 ? prev : null;
    if (to) navigate(`/galeria/${albumId}/foto/${to.id}`);
  });

  const fileOf = async () => {
    const url = (await galleryUrls([p.path]))[p.path];
    if (!url) throw new Error('Sem conexão. Tente de novo.');
    const blob = await (await fetch(url)).blob();
    const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
    return new File([blob], `${slugify(album.title)}-${i + 1}.${ext}`, { type: blob.type });
  };
  document.getElementById('download').onclick = async () => {
    try {
      const file = await fileOf();
      const url = URL.createObjectURL(file);
      const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  };
  document.getElementById('share').onclick = async () => {
    try {
      const file = await fileOf();
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: album.title });
      else document.getElementById('download').click();
    } catch (err) {
      if (err?.name !== 'AbortError') toast(errorText(err), 'error');
    }
  };
  document.getElementById('takedown').onclick = async () => {
    const reason = await ask('Pedir para tirar esta foto: quem publica a galeria recebe o pedido. Quer dizer o motivo? (opcional)', {
      input: 'text',
      ok: 'Enviar pedido',
      placeholder: 'Motivo (opcional)',
    });
    if (reason === null) return;
    const { data, error } = await sb.rpc('gallery_request_removal', { p_photo: p.id, p_reason: reason.trim().slice(0, 300) });
    if (error) return toast(errorText(error), 'error');
    toast(data ? 'Pedido enviado. Obrigado por avisar.' : 'Você já pediu para tirar esta foto.');
  };
  document.getElementById('cover')?.addEventListener('click', async () => {
    const { data, error } = await sb.from('gallery_albums').update({ cover_photo_id: p.id }).eq('id', albumId).select('id');
    if (error || !data.length) return toast(error ? errorText(error) : 'Você não tem permissão para isso.', 'error');
    forgetAlbum(albumId);
    toast('Capa do álbum trocada.');
    render();
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask('Apagar esta foto? Não dá para desfazer.')) return;
    try {
      await removeGalleryFiles([p]);
      const { data, error } = await sb.from('gallery_photos').delete().eq('id', p.id).select('id');
      if (error || !data.length) throw error || new Error('Você não tem permissão para isso.');
    } catch (err) {
      return toast(errorText(err), 'error');
    }
    forgetAlbum(albumId);
    toast('Foto apagada.');
    navigate(next ? `/galeria/${albumId}/foto/${next.id}` : prev ? `/galeria/${albumId}/foto/${prev.id}` : `/galeria/${albumId}`);
  });
}

async function viewAlbumForm(ctx, id) {
  if (!requireMemberFeature(id ? `/galeria/${id}/editar` : '/galeria/novo', 'galeria')) return;
  if (!galleryTeam()) return navigate('/galeria');
  let a = { title: '', album_date: isoLocal(new Date()), description: '' };
  let photos = [];
  if (id) {
    const data = await editItem(ctx, screenCached(`album:${id}`), () => loadAlbum(id), () => forgetAlbum(id));
    if (!data?.album) return navigate('/galeria');
    a = data.album;
    photos = data.photos;
  }
  if (!ctx.alive()) return;
  $view.innerHTML = `
    <form id="album" class="form page">
      <a href="${id ? `#/galeria/${id}` : '#/galeria'}" class="back">← ${id ? esc(a.title) : 'Galeria'}</a>
      <h1>${id ? 'Editar álbum' : 'Novo álbum'}</h1>
      <label>Título<input name="title" required minlength="2" maxlength="80" value="${esc(a.title)}" placeholder="Batismo de outubro"></label>
      <label>Data<input name="album_date" type="date" required value="${esc(a.album_date)}"></label>
      <label>Descrição (opcional)<textarea name="description" rows="3" maxlength="500">${esc(a.description || '')}</textarea></label>
      ${id ? '' : '<p class="hint">Depois de criar, abra o álbum e toque em <em>Adicionar fotos</em>. As fotos são reduzidas no celular antes do envio, para gastar pouco espaço.</p>'}
      <button class="btn primary big">${id ? 'Salvar' : 'Criar álbum'}</button>
      ${id ? `<button class="btn danger-outline" type="button" id="delete">Apagar o álbum e as ${photos.length} fotos</button>` : ''}
    </form>`;
  const form = document.getElementById('album');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const row = { title: form.title.value.trim(), album_date: form.album_date.value, description: form.description.value.trim() || null };
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    const { data, error } = id
      ? await sb.from('gallery_albums').update(row).eq('id', id).select('id').single()
      : await sb.from('gallery_albums').insert({ ...row, church_id: state.church.id }).select('id').single();
    btn.disabled = false;
    if (error) return toast(errorText(error), 'error');
    forgetAlbum(data.id);
    toast(id ? 'Álbum salvo.' : 'Álbum criado. Agora adicione as fotos.');
    navigate(`/galeria/${data.id}`);
  });
  document.getElementById('delete')?.addEventListener('click', async () => {
    if (!await ask(`Apagar o álbum "${a.title}" e as ${photos.length} fotos? Não dá para desfazer.`)) return;
    try {
      await removeGalleryFiles(photos);
      const { data, error } = await sb.from('gallery_albums').delete().eq('id', id).select('id');
      if (error || !data.length) throw error || new Error('Você não tem permissão para isso.');
    } catch (err) {
      return toast(errorText(err), 'error');
    }
    forgetAlbum(id);
    toast('Álbum apagado.');
    navigate('/galeria');
  });
}

// ---------------------------------------------------------------------
// Arrastar para a esquerda (.swipe > .swipe-row): passando de 35% da largura, onSwipe(wrap) age
// (apaga, inativa…; devolve true, e com false a linha volta ao lugar). Se não sobrou nenhuma
// linha, chama onEmpty. A rolagem vertical continua normal.
function swipeLeft(list, onSwipe, onEmpty) {
  let row = null;
  let startX = 0;
  let startY = 0;
  let dx = 0;
  let dragging = false;
  list.addEventListener('pointerdown', (e) => {
    row = e.button === 0 ? e.target.closest('.swipe-row') : null;
    startX = e.clientX;
    startY = e.clientY;
    dx = 0;
    dragging = false;
  });
  list.addEventListener('pointermove', (e) => {
    if (!row) return;
    const x = e.clientX - startX;
    const y = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(y) > 10 && Math.abs(y) > Math.abs(x)) return void (row = null); // está rolando a lista
      if (x > -10) return;
      dragging = true;
      row.setPointerCapture(e.pointerId);
      row.classList.add('dragging');
    }
    dx = Math.min(0, x);
    row.style.transform = `translateX(${dx}px)`;
  });
  const end = async () => {
    if (!row) return;
    const r = row;
    row = null;
    r.classList.remove('dragging');
    if (!dragging) return;
    setTimeout(() => (dragging = false)); // depois do clique que o soltar dispara
    if (-dx < r.offsetWidth * 0.35) return void (r.style.transform = '');
    const wrap = r.closest('.swipe');
    r.style.transform = 'translateX(-100%)';
    wrap.classList.add('removing');
    if (await onSwipe(wrap)) {
      wrap.hidden = true;
      if (!list.querySelector('.swipe:not([hidden])')) onEmpty?.();
    } else {
      wrap.classList.remove('removing');
      r.style.transform = '';
    }
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
  // Soltar depois de arrastar não abre o item.
  list.addEventListener('click', (e) => dragging && e.preventDefault(), true);
}

// ---------------------------------------------------------------------
// Aniversários: cartão da semana, aniversariantes do mês, mensagem da igreja, notificações
// ---------------------------------------------------------------------
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const parseIso = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

// "faz 30 anos", "💍 Casamento · 10 anos", "🕊️ Batismo" (os anos só para a liderança).
function celebrationNote(r, sep = '') {
  if (r.kind === 'aniversario') return r.years ? `${sep}faz ${r.years} anos` : '';
  const k = MESSAGE_KINDS[r.kind];
  return `${sep}${k.emoji} ${k.label}${r.years ? ` · ${yearsText(r.years)}` : ''}`;
}

function dayLabel(iso) {
  const today = new Date();
  if (iso === isoLocal(today)) return 'Hoje';
  if (iso === isoLocal(addDays(today, 1))) return 'Amanhã';
  return parseIso(iso).toLocaleDateString('pt-BR', { weekday: 'short', day: 'numeric', month: 'numeric' }).replace('.', '');
}

// A regra de quem aparece fica no banco: liderança vê todos (com a idade e os anos); membros, só quem autorizou.
// Cada linha tem o tipo: aniversario, casamento ou batismo.
async function fetchBirthdays(from, to) {
  const { data, error } = await sb.rpc('celebrations_between', { p_church: state.church.id, p_from: from, p_to: to });
  if (error) throw error;
  return data;
}

function weekBirthdaysCard(el, changed) {
  const today = new Date();
  const todayIso = isoLocal(today);
  // Guarda junto o dia: o guardado de outro dia não vale.
  const load = async () => ({ day: todayIso, rows: await fetchBirthdays(todayIso, isoLocal(addDays(today, 6))) });
  const html = (data, minis = {}) => {
    const rows = data.day === todayIso ? data.rows : [];
    if (!rows.length) return '';
    const anyToday = rows.some((r) => r.on_date === todayIso);
    return `
    <section class="card birthday-card">
      <h2>${icon.cake} ${anyToday ? 'Aniversariantes de hoje e da semana' : 'Aniversariantes da semana'}</h2>
      <ul class="bday-list">
        ${rows
          .slice(0, 8)
          .map(
            (r) => `
          <li class="${r.on_date === todayIso ? 'today' : ''}">
            ${avatar(r.name, r.photo_path && minis[miniOf(r.photo_path)])}
            <span><strong>${esc(r.name)}</strong><small>${esc(dayLabel(r.on_date))}${celebrationNote(r, ' · ')}</small></span>
          </li>`,
          )
          .join('')}
      </ul>
      <a href="#/aniversariantes">Ver os aniversariantes do mês</a>
    </section>`;
  };
  // As fotos chegam depois (links temporários): primeiro com as iniciais, depois com as fotos.
  return homeCard(el, 'semana', load, html, changed).then(async () => {
    const data = screenCached('semana');
    const rows = data?.day === todayIso ? data.rows : [];
    if (!rows.some((r) => r.photo_path)) return;
    const minis = await signedPhotos(rows.filter((r) => r.photo_path).map((r) => miniOf(r.photo_path))).catch(() => ({}));
    const out = html(data, minis);
    if (el.isConnected && out) {
      el.innerHTML = out;
      changed();
    }
  });
}

// Mês pedido (?mes=AAAA-MM, ou o atual) e a busca das datas dele.
function birthdayMonth(ctx) {
  const now = new Date();
  const [y, m] = (ctx.params.get('mes') || '').match(/^\d{4}-\d{2}$/)
    ? ctx.params.get('mes').split('-').map(Number)
    : [now.getFullYear(), now.getMonth() + 1];
  const load = () => fetchBirthdays(isoLocal(new Date(y, m - 1, 1)), isoLocal(new Date(y, m, 0)));
  return { y, m, key: `${y}-${String(m).padStart(2, '0')}`, load };
}

async function viewBirthdays(ctx) {
  if (!requireLogin('/aniversariantes')) return;
  if (!isActiveMember()) return navigate('/');
  const { y, m, load } = birthdayMonth(ctx);
  await screenShowWithPhotos(ctx, `mes:${y}-${m}`, load, (rows) => rows.map((r) => r.photo_path), (rows, minis) => drawBirthdays(rows, minis, y, m));
}

// Folha do mês para imprimir (mural da igreja): só nomes, sem fotos; mesmo guardado da lista.
async function viewBirthdaysSheet(ctx) {
  if (!requireLogin('/aniversariantes')) return;
  if (!isActiveMember()) return navigate('/');
  const { y, m, key, load } = birthdayMonth(ctx);
  await screenShow(ctx, `mes:${y}-${m}`, load, (rows) => {
    const byDay = new Map();
    for (const r of rows) {
      if (!byDay.has(r.on_date)) byDay.set(r.on_date, []);
      byDay.get(r.on_date).push(r);
    }
    drawSheet({
      back: `#/aniversariantes?mes=${key}`,
      backText: 'Aniversariantes',
      title: 'Aniversariantes de',
      accent: `${MONTHS[m - 1]} de ${y}`,
      body: rows.length
        ? `<div class="sheet-bdays">${[...byDay]
            .map(
              ([iso, list]) => `
          <div class="sheet-bday">
            <span class="sheet-bday-date"><strong>${parseIso(iso).getDate()}</strong><small>${parseIso(iso).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</small></span>
            <ul>${list.map((r) => `<li><strong>${esc(r.name)}</strong>${celebrationNote(r) ? `<small>${celebrationNote(r)}</small>` : ''}</li>`).join('')}</ul>
          </div>`,
            )
            .join('')}</div>`
        : `<p class="hint">Nenhum aniversariante em ${MONTHS[m - 1]}.</p>`,
      file: `Aniversariantes - ${state.church.name} - ${MONTHS[m - 1]} de ${y}`,
    });
  });
}

function drawBirthdays(rows, minis, y, m) {
  const now = new Date();
  const month = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const leader = isLeaderRole(myRole());
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.on_date)) byDay.set(r.on_date, []);
    byDay.get(r.on_date).push(r);
  }
  const todayIso = isoLocal(now);

  $view.innerHTML = `
    <div class="page birthdays-page">
      <div class="month-nav">
        <a class="btn small" href="#/aniversariantes?mes=${month(new Date(y, m - 2, 1))}" aria-label="Mês anterior">‹</a>
        <h1>Aniversariantes de ${MONTHS[m - 1]}</h1>
        <a class="btn small" href="#/aniversariantes?mes=${month(new Date(y, m, 1))}" aria-label="Próximo mês">›</a>
      </div>
      <p class="hint">${
        leader
          ? `${rows.length} ${rows.length === 1 ? 'data' : 'datas'}. Como liderança, você vê todos os membros ativos.`
          : `Aparecem só os membros que autorizaram mostrar o aniversário.`
      }</p>
      ${
        rows.length
          ? `<div class="bday-month">${[...byDay]
              .map(
                ([iso, list]) => `
            <section class="bday-day ${iso === todayIso ? 'today' : ''}">
              <div class="bday-date"><strong>${parseIso(iso).getDate()}</strong><small>${parseIso(iso).toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')}</small></div>
              <ul class="bday-list">
                ${list
                  .map(
                    (r) => `
                  <li>${avatar(r.name, r.photo_path && minis[miniOf(r.photo_path)])}
                    <span><strong>${esc(r.name)}</strong>${celebrationNote(r) ? `<small>${celebrationNote(r)}</small>` : ''}</span></li>`,
                  )
                  .join('')}
              </ul>
            </section>`,
              )
              .join('')}</div>`
          : `<div class="empty"><p>Nenhum aniversariante em ${MONTHS[m - 1]}.</p></div>`
      }
      <a class="fab" id="print" href="#/aniversariantes/imprimir?mes=${month(new Date(y, m - 1, 1))}" aria-label="Imprimir ou salvar PDF" title="Imprimir ou salvar PDF">${icon.print}</a>
    </div>`;
}

// Grupos da central: cada um com ícone, cor (css .k-<grupo>) e os tipos que reúne.
const NOTIF_GROUPS = {
  avisos: { label: 'Avisos', icon: 'megaphone', kinds: ['aviso'], on: () => featureOn('avisos') },
  agenda: { label: 'Agenda', icon: 'calendar', kinds: ['evento'], on: () => featureOn('agenda') },
  salas: { label: 'Salas', icon: 'child', kinds: ['sala'], on: () => featureOn('salas') },
  galeria: { label: 'Galeria', icon: 'image', kinds: ['galeria'], on: () => galleryTeam() },
  datas: { label: 'Aniversários', icon: 'cake', kinds: ['aniversario', 'resumo_lideres'], on: () => datesOn() },
};
const notifGroup = (kind) => Object.keys(NOTIF_GROUPS).find((g) => NOTIF_GROUPS[g].kinds.includes(kind)) || 'sistema';
const NOTIF_PAGE = 30;

// Hora curta à direita: hoje, a hora; ontem; nesta semana, o dia; antes, a data.
function notifTime(iso) {
  const d = new Date(iso);
  const days = Math.round((parseIso(isoLocal(new Date())) - parseIso(isoLocal(d))) / 864e5);
  if (days === 0) return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  if (days === 1) return 'ontem';
  if (days < 7) return d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

function notifDayGroup(iso) {
  const days = Math.round((parseIso(isoLocal(new Date())) - parseIso(isoLocal(new Date(iso)))) / 864e5);
  return days === 0 ? 'Hoje' : days === 1 ? 'Ontem' : days < 7 ? 'Esta semana' : 'Mais antigas';
}

function notifList(items) {
  let html = '';
  let day = null;
  for (const n of items) {
    const g = notifDayGroup(n.created_at);
    if (g !== day) {
      html += `${day ? '</div>' : ''}<h2 class="notif-day">${g}</h2><div class="notif-list">`;
      day = g;
    }
    const group = notifGroup(n.kind);
    html += `
      <a class="notif-row ${n.unread ? 'unread' : ''}" href="${esc(n.url && n.url.startsWith('#/') ? n.url : '#/')}">
        <span class="notif-icon k-${group}">${icon[NOTIF_GROUPS[group]?.icon] || icon.bell}</span>
        <span class="notif-text">
          <span class="notif-head"><strong>${esc(n.title)}</strong><time datetime="${esc(n.created_at)}">${esc(notifTime(n.created_at))}</time></span>
          ${n.body ? `<small>${esc(n.body)}</small>` : ''}
        </span>
        ${n.unread ? '<span class="notif-dot" aria-label="Não lida"></span>' : ''}
      </a>`;
  }
  return html + (day ? '</div>' : '');
}

// Central de notificações desta igreja: por dia, com filtro por tipo e, no topo ou no fim,
// as notificações no celular.
async function viewNotifications(ctx) {
  if (!requireLogin('/notificacoes')) return;
  if (!isActiveMember()) return navigate('/');
  const groups = Object.keys(NOTIF_GROUPS).filter((g) => NOTIF_GROUPS[g].on());
  const filter = groups.includes(ctx.params.get('ver')) ? ctx.params.get('ver') : null;
  const openedAt = new Date().toISOString();
  const fetchPage = (from) => {
    let q = sb
      .from('notifications')
      .select('id, kind, title, body, url, read_at, created_at')
      .eq('church_id', state.church.id)
      .order('created_at', { ascending: false })
      .range(from, from + NOTIF_PAGE); // um a mais: diz se ainda há outra página
    if (filter) q = q.in('kind', NOTIF_GROUPS[filter].kinds);
    return q;
  };
  // Primeiro a página com o guardado (já visto na última visita: sem destaque); depois o banco.
  const name = `notificacoes:${filter || 'todas'}`;
  const mark = (rows, seen = false) => rows.map((n) => ({ ...n, unread: !seen && !n.read_at }));
  const cached = screenCached(name);
  let items = cached ? mark(cached.slice(0, NOTIF_PAGE), true) : null;
  let more = !!cached && cached.length > NOTIF_PAGE;

  $view.innerHTML = `
    <div class="page notif-page">
      <div class="notif-title">
        <h1>Notificações</h1>
        <button class="btn small" id="clear" hidden>Apagar as lidas</button>
      </div>
      <div id="push-offer"></div>
      ${groups.length > 1 ? '<nav class="chips filters" id="notif-filters" aria-label="Filtrar notificações"></nav>' : ''}
      <div id="notif-items"></div>
      <button class="btn" id="more" hidden>Ver mais</button>
      <p class="hint center notif-push" id="push-line"></p>
    </div>`;

  // Filtros numa linha só: só os grupos que têm notificação (mais "Todas" e o escolhido), com o
  // número de não lidas. Vêm de um resumo guardado (abre na hora) e conferido com o banco.
  const filtersBox = document.getElementById('notif-filters');
  const drawFilters = (rows) => {
    if (!filtersBox) return;
    const stat = {};
    for (const n of rows || []) {
      const g = notifGroup(n.kind);
      stat[g] ??= { total: 0, unread: 0 };
      stat[g].total++;
      // Lida agora, ao abrir a central (read_at = openedAt): ainda conta como nova nesta visita.
      if (!n.read_at || n.read_at >= openedAt) stat[g].unread++;
    }
    const shown = groups.filter((g) => g === filter || !rows || stat[g]?.total);
    const chip = (href, label, active, count) =>
      `<a class="chip ${active ? 'active' : ''}" href="${href}" ${active ? 'aria-current="page"' : ''}>${label}${
        count ? `<span class="chip-count" aria-label="${count} não lidas">${count > 9 ? '9+' : count}</span>` : ''
      }</a>`;
    filtersBox.hidden = !filter && shown.length < 2;
    filtersBox.innerHTML =
      chip('#/notificacoes', 'Todas', !filter, 0) +
      shown.map((g) => chip(`#/notificacoes?ver=${g}`, NOTIF_GROUPS[g].label, filter === g, stat[g]?.unread || 0)).join('');
    filtersBox.querySelector('.active')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  };
  if (filtersBox) {
    const summaryName = 'notificacoes:resumo';
    const loadSummary = async () => {
      const { data, error } = await sb.from('notifications').select('kind, read_at').eq('church_id', state.church.id).limit(1000);
      if (error) throw error;
      return data;
    };
    drawFilters(screenCached(summaryName));
    screenFetch(summaryName, loadSummary)
      .then((rows) => ctx.alive() && drawFilters(rows))
      .catch(() => {});
  }

  const box = document.getElementById('notif-items');
  const moreBtn = document.getElementById('more');
  const clearBtn = document.getElementById('clear');
  const draw = () => {
    box.innerHTML = !items
      ? '<p class="hint center">Carregando…</p>'
      : items.length
        ? notifList(items)
        : `<div class="empty notif-empty">${icon.bell}
          <h2>Tudo em dia!</h2>
          <p>${filter ? `Nenhuma notificação de ${NOTIF_GROUPS[filter].label.toLowerCase()}.` : 'Avisos, lembretes da agenda e as mensagens da igreja aparecem aqui.'}</p>
        </div>`;
    moreBtn.hidden = !more;
    clearBtn.hidden = !items?.some((n) => !n.unread);
  };
  draw();

  // Notificações no celular: chegam à parte (perguntar ao aparelho pode demorar um pouco).
  const togglePush = async (btn, on) => {
    btn.disabled = true;
    try {
      if (on) {
        const res = await enablePush(sb, CONFIG.VAPID_PUBLIC_KEY);
        toast(res === 'ativo' ? 'Pronto! As notificações estão ativadas.' : 'Sem permissão para notificações.', res === 'ativo' ? '' : 'error');
      } else {
        await disablePush(sb);
        toast('Notificações desativadas neste aparelho.');
      }
    } catch (err) {
      toast(errorText(err), 'error');
    }
    render();
  };
  pushActive().then((active) => {
    if (!ctx.alive()) return;
    const support = pushSupport();
    const blocked = support === 'ok' && Notification.permission === 'denied';
    document.getElementById('push-offer').innerHTML =
      support === 'ok' && !blocked && !active
        ? `<div class="notice push-invite">${icon.bell}
            <span><strong>Receba no celular</strong><small>Avisos e lembretes da igreja, mesmo com o app fechado.</small></span>
            <button class="btn primary small" id="push-on">Ativar</button>
          </div>`
        : support === 'ios-instalar'
          ? `<div class="notice push-invite">${icon.bell}
              <span><strong>Quer receber no iPhone?</strong><small>Instale o app: Compartilhar → "Adicionar à Tela de Início". Depois abra pelo ícone.</small></span>
            </div>`
          : '';
    document.getElementById('push-line').innerHTML = active
      ? `${icon.bell} Ativadas neste aparelho · <button class="link-btn" id="push-test">Enviar aviso de teste</button> · <button class="link-btn" id="push-off">Desativar</button>`
      : blocked
        ? 'As notificações estão bloqueadas para este site. Libere nas configurações do navegador para receber no celular.'
        : support === 'ok' || support === 'ios-instalar'
          ? ''
          : 'Este navegador não recebe notificações no celular. Use o Chrome (Android) ou o app instalado (iPhone).';
    document.getElementById('push-on')?.addEventListener('click', (e) => togglePush(e.currentTarget, true));
    document.getElementById('push-off')?.addEventListener('click', (e) => togglePush(e.currentTarget, false));
    document.getElementById('push-test')?.addEventListener('click', (e) => sendTestPush(e.currentTarget));
  });

  let data;
  try {
    data = await screenFetch(name, async () => {
      const { data: rows, error } = await fetchPage(0);
      if (error) throw error;
      return rows;
    });
  } catch (err) {
    if (cached) return;
    throw err;
  }
  if (!ctx.alive()) return;
  // Quem chegou sem ler continua destacado nesta visita, mesmo depois de marcado como lido.
  items = mark(data.slice(0, NOTIF_PAGE));
  more = data.length > NOTIF_PAGE;
  draw();

  // Abrir a central zera o sininho (as não lidas desta visita continuam destacadas).
  if (items.some((n) => n.unread)) {
    sb.from('notifications')
      .update({ read_at: openedAt })
      .eq('church_id', state.church.id)
      .is('read_at', null)
      .then(() => refreshUnread())
      .catch(() => {});
  }

  moreBtn.onclick = async () => {
    moreBtn.disabled = true;
    const { data: next, error: err } = await fetchPage(items.length);
    moreBtn.disabled = false;
    if (err) return toast(errorText(err), 'error');
    if (!ctx.alive()) return;
    items = items.concat(mark(next.slice(0, NOTIF_PAGE)));
    more = next.length > NOTIF_PAGE;
    draw();
  };

  // Apaga as que já estavam lidas antes desta visita (as novas de agora ficam).
  clearBtn.onclick = async () => {
    if (!await ask('Apagar as notificações que você já tinha lido?')) return;
    let q = sb.from('notifications').delete().eq('church_id', state.church.id).lt('read_at', openedAt);
    if (filter) q = q.in('kind', NOTIF_GROUPS[filter].kinds);
    const { error: err } = await q;
    if (err) return toast(errorText(err), 'error');
    for (const g of [null, ...groups]) screenForget(`notificacoes:${g || 'todas'}`);
    toast('Notificações lidas apagadas.');
    render();
  };
}

// Convite discreto na página inicial para ativar as notificações (some por 30 dias ao fechar).
// Aviso de teste para este aparelho (pela mesma função que manda os avisos do chat): mostra
// se o aviso sai daqui e se o celular deixa aparecer.
async function sendTestPush(btn) {
  btn.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    const { data } = await sb.auth.getSession();
    if (!subscription || !data.session) throw new Error('Ative as notificações neste aparelho primeiro.');
    const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/enviar-push`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ test: true, endpoint: subscription.endpoint, church: state.church?.slug }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'Não foi possível enviar o teste.');
    if (out.sent) {
      toast('Aviso de teste enviado. Se não aparecer em 1 minuto, o celular está bloqueando as notificações do app: confira as configurações de notificação.');
    } else if (out.gone || !out.devices) {
      toast('Este aparelho não está mais inscrito. Toque em Desativar e ative as notificações de novo.', 'error');
    } else {
      toast('O serviço de notificações recusou o envio. Desative e ative as notificações de novo.', 'error');
    }
  } catch (err) {
    toast(errorText(err), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function pushInvite(el, { title = 'Receba as mensagens da igreja no celular', note = 'Como a mensagem no dia do seu aniversário.' } = {}) {
  if (!el || !isActiveMember() || pushSupport() !== 'ok' || Notification.permission !== 'default' || (await pushActive())) return;
  try {
    if (Date.now() - Number(localStorage.getItem('push-invite-dismissed') || 0) < 30 * 864e5) return;
  } catch {}
  if (!el.isConnected) return;
  el.innerHTML = `
    <div class="notice push-invite">
      ${icon.bell}
      <span><strong>${esc(title)}</strong><small>${esc(note)}</small></span>
      <button class="btn primary small" id="push-yes">Ativar</button>
      <button class="close" aria-label="Agora não" id="push-no">&times;</button>
    </div>`;
  document.getElementById('push-no').onclick = () => {
    try {
      localStorage.setItem('push-invite-dismissed', String(Date.now()));
    } catch {}
    el.innerHTML = '';
  };
  document.getElementById('push-yes').onclick = async () => {
    try {
      const res = await enablePush(sb, CONFIG.VAPID_PUBLIC_KEY);
      toast(res === 'ativo' ? 'Pronto! As notificações estão ativadas.' : 'Sem permissão para notificações.', res === 'ativo' ? '' : 'error');
    } catch (err) {
      toast(errorText(err), 'error');
    }
    el.innerHTML = '';
  };
}

// Textos da tela de cada mensagem.
const MESSAGE_SCREEN = {
  aniversario: {
    intro: 'Vai às 7h (horário de Brasília) para quem faz aniversário. Quem nasceu em 29/02 recebe em 28/02 nos anos que não são bissextos.',
    send: 'Enviar a mensagem de aniversário',
    fields: MESSAGE_FIELDS,
    fieldsHint: '{idade} é a idade que a pessoa completa.',
    sample: (age) => `se fizesse ${age} anos hoje`,
    age: 30,
  },
  casamento: {
    intro: 'Vai às 7h (horário de Brasília) no aniversário de casamento, para quem tem a data de casamento no cadastro. Cada cônjuge recebe a sua mensagem.',
    send: 'Enviar a mensagem de aniversário de casamento',
    fields: SPECIAL_FIELDS,
    fieldsHint: '{anos} vira "1 ano", "10 anos"…: quanto tempo de casamento a pessoa completa.',
    sample: (n) => `se completasse ${yearsText(n)} de casamento hoje`,
    age: 10,
  },
  batismo: {
    intro: 'Vai às 7h (horário de Brasília) no aniversário de batismo, para quem tem a data de batismo no cadastro.',
    send: 'Enviar a mensagem de aniversário de batismo',
    fields: SPECIAL_FIELDS,
    fieldsHint: '{anos} vira "1 ano", "10 anos"…: quanto tempo de batismo a pessoa completa.',
    sample: (n) => `se completasse ${yearsText(n)} de batismo hoje`,
    age: 5,
  },
};

async function viewMessageSettings(ctx, kind) {
  if (!requireLogin(`/config/${kind}`)) return;
  if (myRole() !== 'admin') {
    $view.innerHTML = `<div class="empty"><h2>Só para o administrador</h2><a class="btn" href="#/">Voltar</a></div>`;
    return;
  }
  const info = MESSAGE_KINDS[kind];
  const screen = MESSAGE_SCREEN[kind];
  if (!featureOn(info.feature)) {
    $view.innerHTML = `<div class="empty"><h2>${esc(info.menu)}</h2><p>Ligue a funcionalidade em Configurar a igreja.</p><a class="btn" href="#/config">Configurar a igreja</a></div>`;
    return;
  }
  const loadTemplates = async () => {
    const { data: rows, error } = await sb.from('message_templates').select('*').eq('church_id', state.church.id).in('kind', [kind, 'resumo_lideres']);
    if (error) throw error;
    return rows;
  };
  const cachedTemplates = screenCached(`modelo:${kind}`);
  const data = await editItem(ctx, cachedTemplates, () => screenFetch(`modelo:${kind}`, loadTemplates), () => {});
  if (!ctx.alive()) return;
  const t = data.find((r) => r.kind === kind);
  const summary = data.find((r) => r.kind === 'resumo_lideres');
  if (!t || !summary) throw new Error('Os modelos de mensagem não foram encontrados. Rode o supabase/008_datas_especiais.sql.');
  const sample = { name: myMember()?.name || 'Maria da Silva', church: state.church.name, age: screen.age };

  $view.innerHTML = `
    <form id="bday" class="form page">
      <a href="#/menu" class="back">← Menu</a>
      <h1>${esc(info.menu)}</h1>
      <p class="hint">${esc(screen.intro)}</p>
      <label class="check"><input type="checkbox" name="enabled" ${t.enabled ? 'checked' : ''}> ${esc(screen.send)}</label>

      <fieldset class="card">
        <legend>Texto</legend>
        <label>Título<input name="title" required maxlength="120" value="${esc(t.title)}"></label>
        <label>Mensagem<textarea name="body" required rows="5" maxlength="1000">${esc(t.body)}</textarea></label>
        <div class="chips" aria-label="Campos para a mensagem">
          ${screen.fields.map((f) => `<button type="button" class="chip" data-field="${f}">{${f}}</button>`).join('')}
        </div>
        <p class="hint">Toque num campo para colocá-lo no texto. ${esc(screen.fieldsHint)}</p>
        <div class="chips emojis" aria-label="Emojis para a mensagem">
          ${MESSAGE_EMOJIS.map((em) => `<button type="button" class="chip" data-insert="${em}" aria-label="Colocar ${em}">${em}</button>`).join('')}
        </div>
        <p class="hint">Toque num emoji para colocá-lo onde está o cursor, no título ou na mensagem. Pelo teclado do celular dá para pôr qualquer outro.</p>
      </fieldset>

      <fieldset class="card">
        <legend>Imagem (opcional)</legend>
        <div class="bday-image" id="image-box">${t.image_url ? `<img src="${esc(t.image_url)}" alt="">` : '<p class="hint">Sem imagem.</p>'}</div>
        <div class="actions-row">
          <label class="btn small">${t.image_url ? 'Trocar a imagem' : 'Escolher imagem'}<input type="file" name="image" accept="image/*" hidden></label>
          <button type="button" class="btn link small" id="image-remove" ${t.image_url ? '' : 'hidden'}>Remover imagem</button>
        </div>
      </fieldset>

      <fieldset class="card">
        <legend>Como enviar</legend>
        <label class="check"><input type="checkbox" name="send_push" ${t.send_push ? 'checked' : ''}> Notificação no celular (para quem ativou)</label>
        <label class="check"><input type="checkbox" name="send_email" ${t.send_email ? 'checked' : ''}> E-mail</label>
        <p class="hint">O e-mail vai para quem tem e-mail no cadastro, mesmo sem ter entrado no app.</p>
      </fieldset>

      <fieldset class="card">
        <legend>Liderança</legend>
        <label class="check"><input type="checkbox" name="summary" ${summary.enabled ? 'checked' : ''}> Resumo para a liderança às 7h: as datas do dia (aniversários) e, às segundas, as da semana</label>
        <p class="hint">O resumo é um só para todas as datas: ligar ou desligar aqui vale também nas outras mensagens.</p>
      </fieldset>

      <section class="card preview">
        <h2>Prévia</h2>
        <div class="push-preview">
          <img src="${esc(state.church.logo_url || 'icons/icon-192.png')}" alt="" width="36" height="36">
          <div><strong id="pv-title"></strong><p id="pv-body"></p></div>
        </div>
        <p class="hint">Assim chega para ${esc(sample.name.split(' ')[0])}, ${esc(screen.sample(sample.age))}.</p>
      </section>

      <button class="btn primary big">Salvar</button>
    </form>`;

  const form = document.getElementById('bday');
  let imageFile = null;
  let removeImage = false;
  let lastField = form.body;
  const preview = () => {
    document.getElementById('pv-title').textContent = renderMessage(form.title.value, sample);
    document.getElementById('pv-body').textContent = renderMessage(form.body.value, sample);
  };
  preview();
  form.title.addEventListener('input', preview);
  form.body.addEventListener('input', preview);
  form.title.addEventListener('focus', () => (lastField = form.title));
  form.body.addEventListener('focus', () => (lastField = form.body));
  form.querySelectorAll('[data-field], [data-insert]').forEach((b) => {
    b.onclick = () => {
      const el = lastField;
      const text = b.dataset.insert ?? `{${b.dataset.field}}`;
      const [s, e] = [el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length];
      el.value = el.value.slice(0, s) + text + el.value.slice(e);
      el.focus();
      el.setSelectionRange(s + text.length, s + text.length);
      preview();
    };
  });
  form.image.addEventListener('change', () => {
    imageFile = form.image.files[0] || null;
    if (!imageFile) return;
    removeImage = false;
    document.getElementById('image-box').innerHTML = `<img src="${URL.createObjectURL(imageFile)}" alt="">`;
    document.getElementById('image-remove').hidden = false;
  });
  document.getElementById('image-remove').onclick = () => {
    imageFile = null;
    removeImage = true;
    form.image.value = '';
    document.getElementById('image-box').innerHTML = '<p class="hint">Sem imagem.</p>';
    document.getElementById('image-remove').hidden = true;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button.primary');
    btn.disabled = true;
    try {
      const bucket = sb.storage.from('igrejas');
      const patch = {
        enabled: form.enabled.checked,
        title: form.title.value.trim(),
        body: form.body.value.trim(),
        send_push: form.send_push.checked,
        send_email: form.send_email.checked,
        updated_at: new Date().toISOString(),
      };
      if (imageFile) {
        const img = await resizeImage(imageFile, 1080, 0.82);
        const path = `${state.church.id}/${kind}/imagem-${Date.now()}.${img.type === 'image/webp' ? 'webp' : 'jpg'}`;
        const up = await bucket.upload(path, img, { contentType: img.type, cacheControl: '31536000' });
        if (up.error) throw up.error;
        patch.image_url = bucket.getPublicUrl(path).data.publicUrl;
      } else if (removeImage) patch.image_url = null;

      const save = (kind, p) => sb.from('message_templates').update(p).eq('church_id', state.church.id).eq('kind', kind).select('kind');
      const [a, b] = await Promise.all([save(kind, patch), save('resumo_lideres', { enabled: form.summary.checked, updated_at: patch.updated_at })]);
      for (const r of [a, b]) {
        if (r.error) throw r.error;
        if (!r.data.length) throw new Error('Você não tem permissão para mudar a mensagem.');
      }
      // A imagem antiga não é mais usada.
      const oldPath = (imageFile || removeImage) && t.image_url?.split('/object/public/igrejas/')[1];
      if (oldPath) await bucket.remove([decodeURIComponent(oldPath)]);
      for (const k of Object.keys(MESSAGE_KINDS)) screenForget(`modelo:${k}`);
      toast('Mensagem salva.');
      render();
    } catch (err) {
      toast(errorText(err), 'error');
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------
async function loadChurch() {
  // Pedido simples, igual ao preload da página: chega junto com o código do app em vez de depois dele.
  // Igreja desativada (só o administrador da plataforma vê) ou falha: busca pelo cliente, com a sessão.
  try {
    const res = await fetch(churchRestUrl(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, SLUG));
    const [church] = res.ok ? await res.json() : [];
    if (church) return church;
  } catch {}
  const { data, error } = await sb.from('churches').select('*').eq('slug', SLUG).maybeSingle();
  if (error) throw error;
  return data;
}

// Abertura rápida: guarda no aparelho a igreja e os cadastros da última abertura. Na próxima,
// a tela aparece na hora com eles, e o banco confirma em segundo plano (se algo mudou, redesenha).
// Só vale para a mesma conta que está logada neste aparelho; as permissões continuam no banco.
const BOOT_KEY = 'abertura-rapida';
const AUTH_KEY = `sb-${new URL(CONFIG.SUPABASE_URL).hostname.split('.')[0]}-auth-token`;
const bootSnapshot = () =>
  JSON.stringify({ church: state.church, user: state.user?.id ?? null, memberships: state.memberships, platformAdmin: state.platformAdmin });

function saveBootCache() {
  if (!SLUG || !state.church) return;
  try {
    localStorage.setItem(BOOT_KEY, JSON.stringify({ slug: SLUG, snapshot: bootSnapshot() }));
  } catch {}
}

function clearBootCache() {
  try {
    localStorage.removeItem(BOOT_KEY);
    for (const k of Object.keys(localStorage)) if (k.startsWith(SCREEN_PREFIX)) localStorage.removeItem(k);
  } catch {}
  screenMem.clear();
}

// Desenha a tela com o que ficou guardado. Devolve o retrato usado, ou null se não deu.
function quickStart() {
  if (!SLUG || location.search || sessionStorage.getItem('next')) return null;
  try {
    const saved = JSON.parse(localStorage.getItem(BOOT_KEY) || 'null');
    const sessionUser = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null')?.user ?? null;
    if (!saved || saved.slug !== SLUG) return null;
    const snap = JSON.parse(saved.snapshot);
    if (snap.user !== (sessionUser?.id ?? null) || !snap.church) return null;
    state.church = snap.church;
    state.user = sessionUser;
    state.memberships = snap.memberships || [];
    state.platformAdmin = !!snap.platformAdmin;
  } catch {
    return null;
  }
  applyBranding();
  renderAccountLink();
  window.addEventListener('hashchange', render);
  render();
  return bootSnapshot();
}

async function boot() {
  if (!configured) {
    $view.innerHTML = `
      <div class="empty">
        <h2>Falta configurar o Supabase</h2>
        <p>Edite <code>js/config.js</code> com a chave pública do projeto e rode <code>supabase/001_base.sql</code> no SQL Editor. Veja o README.</p>
      </div>`;
    return;
  }

  const quick = (quickStarted = quickStart());
  const authError = new URLSearchParams(location.search).get('error_description');
  const [{ data }, church] = await Promise.all([sb.auth.getSession(), SLUG ? loadChurch() : null]);
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
  if (authError) toast(authError, 'error');

  if (SLUG && !church) {
    clearBootCache();
    state.church = null;
    renderTabbar('/');
    applyBranding();
    $view.innerHTML = `<div class="empty"><h2>Igreja não encontrada</h2><p>Confira o endereço com a liderança da sua igreja.</p><a class="btn" href="${esc(ROOT_URL)}">Ir para o início</a></div>`;
    return;
  }
  state.church = church;
  applyBranding();
  await setUser(data.session?.user ?? null);

  sb.auth.onAuthStateChange((event, session) => {
    if (!['SIGNED_IN', 'SIGNED_OUT'].includes(event)) return;
    if ((session?.user?.id ?? null) === (state.user?.id ?? null)) return;
    // Evita chamar o Supabase dentro do callback de autenticação.
    setTimeout(async () => {
      await setUser(session?.user ?? null);
      saveBootCache();
      render();
    }, 0);
  });

  const next = sessionStorage.getItem('next');
  if (data.session && next && ['', '#/', '#/entrar'].includes(location.hash)) {
    sessionStorage.removeItem('next');
    history.replaceState(null, '', location.pathname + '#' + next);
  }

  saveBootCache();
  prefetchScreens(); // quem abriu direto em outra tela também ganha a Agenda e os Avisos prontos
  if (!quick) {
    window.addEventListener('hashchange', render);
    render();
  } else if (bootSnapshot() !== quick) {
    render(); // a igreja ou os cadastros mudaram desde a última abertura
  }
}

// Nas páginas das igrejas o <base> aponta para a raiz do site, e o navegador resolveria
// href="#/..." contra ela (saindo da igreja). Os links internos trocam só o "#" da página atual.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  location.hash = a.getAttribute('href').slice(1);
});

// O menu do botão "+" fecha ao tocar fora dele.
document.addEventListener('click', (e) => {
  const open = document.querySelector('.fab-menu[open]');
  if (open && !open.contains(e.target)) open.open = false;
});

// Cada igreja tem o seu service worker, com o mesmo endereço do app instalado dela (i/<igreja>/):
// assim o Android mostra os avisos pelo app da igreja, como no Desapega. Com o da raiz do site,
// o aviso ia para o Chrome e sumia em silêncio quando o Chrome não tinha permissão no celular.
const SW_SCOPE = SLUG ? PAGE_URL.replace(/\/?$/, '/') : ROOT_URL;
if ('serviceWorker' in navigator) navigator.serviceWorker.register(new URL('sw.js', ROOT_URL).href, { scope: SW_SCOPE }).catch(() => {});
let quickStarted = null;
boot().catch((e) => {
  console.error(e);
  // Já está na tela com o que ficou guardado (ex.: sem internet): só avisa.
  if (quickStarted) return toast(errorText(e), 'error');
  $view.innerHTML = `<div class="empty"><h2>Não foi possível abrir o app</h2><p>${esc(errorText(e))}</p><button class="btn primary" id="reload">Tentar de novo</button></div>`;
  // Sem onclick no HTML: a regra de segurança (CSP) não deixa rodar código escrito na página.
  document.getElementById('reload').onclick = () => location.reload();
});
