// Lembretes dos eventos da agenda, notificações dos avisos novos e os avisos da central que
// também vão por push (avisos das salas, pedidos para tirar fotos da galeria).
// Roda no GitHub Actions a cada 10 minutos (.github/workflows/lembretes.yml). Precisa de:
//   ENVIO_SECRET e VAPID_PRIVATE_KEY (segredos do GitHub) e SITE_URL.
// As notificações da central do app são gravadas pelo próprio banco ao separar os envios.
import { readFileSync } from 'node:fs';
import webpush from 'web-push';

const config = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
const pick = (key) => config.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1];
const SUPABASE_URL = pick('SUPABASE_URL');
const ANON_KEY = pick('SUPABASE_ANON_KEY');
const VAPID_PUBLIC_KEY = pick('VAPID_PUBLIC_KEY');

// trim(): o segredo colado no GitHub pode vir com uma quebra de linha no fim.
const ENVIO_SECRET = process.env.ENVIO_SECRET?.trim();
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim();
const SITE_URL = (process.env.SITE_URL || 'https://cc4flamboyant.github.io/CC4-Flamboyant').replace(/\/$/, '');
if (!ENVIO_SECRET || !VAPID_PRIVATE_KEY) throw new Error('Faltam os segredos ENVIO_SECRET e VAPID_PRIVATE_KEY.');

webpush.setVapidDetails(SITE_URL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

async function rpc(fn, body = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_secret: ENVIO_SECRET, ...body }),
  });
  if (!res.ok) throw new Error(`${fn}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const churchUrl = (slug, path = '') => `${SITE_URL}/i/${slug}/${path}`;
const stats = { push: 0, gone: 0, failed: 0 };

async function push(r, msg) {
  try {
    await webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, JSON.stringify(msg), {
      TTL: 3 * 3600,
      urgency: 'high',
    });
    stats.push++;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await rpc('forget_push_subscription', { p_endpoint: r.endpoint });
      stats.gone++;
    } else {
      stats.failed++;
      console.error(`Falha no push (${err.statusCode ?? 'sem status'}): ${err.body || err.message}`);
    }
  }
}

// Hora no horário de Brasília: "19h30", "8h".
const hour = (iso) => {
  const t = new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const [h, m] = t.split(':');
  return `${Number(h)}h${m === '00' ? '' : m}`;
};
const when = (iso) => {
  const day = (d) => new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const today = day(Date.now());
  const tomorrow = day(Date.now() + 864e5);
  const d = day(iso);
  return d === today ? `Hoje às ${hour(iso)}` : d === tomorrow ? `Amanhã às ${hour(iso)}` : `${d.slice(0, 5)} às ${hour(iso)}`;
};

// Lembretes da agenda
const reminders = await rpc('claim_event_reminders');
await Promise.all(
  reminders.map((r) =>
    push(r, {
      title: r.title,
      body: `${when(r.occurrence)}${r.location ? ` · ${r.location}` : ''}`,
      url: churchUrl(r.church_slug, `#/agenda/${r.event_id}`),
      tag: `evento-${r.event_id}`,
      icon: churchUrl(r.church_slug, 'icon-192.png'),
    }),
  ),
);

// Avisos novos com notificação
const notices = await rpc('claim_announcement_push');
await Promise.all(
  notices.map((r) =>
    push(r, {
      title: `${r.church_name}: ${r.title}`,
      body: r.body,
      url: churchUrl(r.church_slug, '#/avisos'),
      tag: `aviso-${r.announcement_id}`,
      icon: churchUrl(r.church_slug, 'icon-192.png'),
    }),
  ),
);

// Avisos da central que também vão por push (ex.: aviso da sala para os pais)
const central = await rpc('claim_notification_push');
await Promise.all(
  central.map((r) =>
    push(r, {
      title: `${r.church_name}: ${r.title}`,
      body: r.body || '',
      url: churchUrl(r.church_slug, r.url?.startsWith('#/') ? r.url : ''),
      tag: `${r.kind}-${r.notification_id}`,
      icon: churchUrl(r.church_slug, 'icon-192.png'),
    }),
  ),
);

// Só números: nada de nome ou endereço de aparelho no registro público do GitHub.
const count = (rows, key) => new Set(rows.map((r) => r[key])).size;
console.log(
  `Lembretes: ${count(reminders, 'event_id')} evento(s); avisos: ${count(notices, 'announcement_id')}; ` +
    `central: ${count(central, 'notification_id')}; ` +
    `${stats.push} push, ${stats.gone} aparelho(s) removido(s), ${stats.failed} falha(s).`,
);
if (stats.failed && !stats.push) process.exit(1);
