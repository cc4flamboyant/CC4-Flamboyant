// Envia as mensagens do dia (aniversário, casamento e batismo, por push e e-mail) e o resumo para a liderança.
// Roda no GitHub Actions (.github/workflows/aniversarios.yml) às 7h de Brasília. Precisa de:
//   ENVIO_SECRET e VAPID_PRIVATE_KEY (segredos do GitHub) e SITE_URL.
// E-mail: Gmail ou Resend (scripts/email.mjs). Sem nenhum dos dois, só push.
// Com EMAIL_TEST=1, só manda um e-mail de teste para o próprio Gmail e para.
import { readFileSync } from 'node:fs';
import webpush from 'web-push';
import { emailOn, gmailOn, gmailUser, deliverEmail, closeEmail } from './email.mjs';
import { renderMessage, joinNames, firstName, yearsText, esc } from '../js/util.js';

const config = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
const pick = (key) => config.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1];
const SUPABASE_URL = pick('SUPABASE_URL');
const ANON_KEY = pick('SUPABASE_ANON_KEY');
const VAPID_PUBLIC_KEY = pick('VAPID_PUBLIC_KEY');

const { ENVIO_SECRET, VAPID_PRIVATE_KEY, EMAIL_TEST } = process.env;
const SITE_URL = (process.env.SITE_URL || 'https://cc4flamboyant.github.io/CC4-Flamboyant').replace(/\/$/, '');
if (!ENVIO_SECRET || !VAPID_PRIVATE_KEY) throw new Error('Faltam os segredos ENVIO_SECRET e VAPID_PRIVATE_KEY.');

if (EMAIL_TEST === '1') {
  if (!gmailOn) throw new Error('Para o teste, crie a variável GMAIL_USER e o segredo GMAIL_APP_PASSWORD.');
  const fail = await deliverEmail({
    fromName: 'CC4',
    to: gmailUser,
    subject: 'Teste do CC4',
    html: '<p>Se você recebeu este e-mail, o envio de aniversários por e-mail está funcionando.</p>',
    text: 'Se você recebeu este e-mail, o envio de aniversários por e-mail está funcionando.',
  });
  if (fail) throw new Error(`O e-mail de teste não saiu. ${fail}`);
  console.log('E-mail de teste enviado para o próprio Gmail. Confira a caixa de entrada (e o spam).');
  process.exit(0);
}

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

const churchUrl = (slug, hash = '') => `${SITE_URL}/i/${slug}/${hash}`;
const stats = { push: 0, email: 0, gone: 0, failed: 0 };

async function push(sub, msg) {
  try {
    await webpush.sendNotification(sub, JSON.stringify(msg), { TTL: 12 * 3600, urgency: 'normal' });
    stats.push++;
    return true;
  } catch (err) {
    if (err.statusCode === 404 || err.statusCode === 410) {
      await rpc('forget_push_subscription', { p_endpoint: sub.endpoint });
      stats.gone++;
    } else {
      stats.failed++;
      console.error(`Falha no push (${err.statusCode ?? 'sem status'}): ${err.body || err.message}`);
    }
    return false;
  }
}

const subOf = (r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } });

// Agrupa por registro de envio: uma pessoa pode ter vários aparelhos.
function byLog(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.log_id)) map.set(r.log_id, { ...r, subs: [] });
    map.get(r.log_id).subs.push(subOf(r));
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------
// 1. Mensagem na central de notificações do app (quem tem conta, mesmo sem push)
// ---------------------------------------------------------------------
const inApp = await rpc('deliver_birthday_notifications');

// ---------------------------------------------------------------------
// 2. Push de aniversário
// ---------------------------------------------------------------------
for (const r of byLog(await rpc('claim_birthday_push'))) {
  const data = { name: r.name, church: r.church_name, age: r.age };
  const msg = {
    title: renderMessage(r.title, data),
    body: renderMessage(r.body, data),
    url: churchUrl(r.church_slug, '#/'),
    tag: `${r.kind}-${r.log_id}`,
    icon: churchUrl(r.church_slug, 'icon-192.png'),
    image: r.image_url || undefined,
  };
  const results = await Promise.all(r.subs.map((s) => push(s, msg)));
  if (!results.some(Boolean)) await rpc('mark_message_failed', { p_log_id: r.log_id });
}

// ---------------------------------------------------------------------
// 3. E-mail de aniversário (só com provedor configurado), dentro do limite diário
// ---------------------------------------------------------------------
function emailHtml(r, title, body) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f5f6fa;font-family:Arial,sans-serif;color:#1b1e27">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <div style="background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e2e4ec">
      ${r.image_url ? `<img src="${esc(r.image_url)}" alt="" style="display:block;width:100%;height:auto">` : ''}
      <div style="padding:24px">
        <h1 style="font-size:22px;margin:0 0 12px">${esc(title)}</h1>
        <p style="font-size:16px;line-height:1.5;margin:0;white-space:pre-line">${esc(body)}</p>
      </div>
    </div>
    <p style="font-size:12px;color:#5f6475;text-align:center;margin-top:16px">
      Você recebe esta mensagem porque está no cadastro da ${esc(r.church_name)}.
      <a href="${esc(churchUrl(r.church_slug))}" style="color:#5f6475">Abrir o app da igreja</a>
    </p>
  </div></body></html>`;
}

async function sendEmail(r) {
  const data = { name: r.name, church: r.church_name, age: r.age };
  const title = renderMessage(r.title, data);
  const body = renderMessage(r.body, data);
  const fail = await deliverEmail({
    fromName: r.church_name,
    to: r.email,
    subject: title,
    html: emailHtml(r, title, body),
    text: `${title}\n\n${body}\n\n${r.church_name}`,
  });
  if (!fail) {
    stats.email++;
    return;
  }
  stats.failed++;
  // Sem o endereço da pessoa: o registro do GitHub é público.
  console.error(`Falha no e-mail (${fail.replaceAll(r.email, '<destinatário>')})`);
  await rpc('mark_message_failed', { p_log_id: r.log_id });
}

let backlog = 0;
if (emailOn) {
  for (const r of await rpc('claim_birthday_email')) await sendEmail(r);
  backlog = await rpc('birthday_email_backlog');
} else {
  console.log('E-mail desligado (faltam GMAIL_USER e GMAIL_APP_PASSWORD): só push.');
}
closeEmail();

// ---------------------------------------------------------------------
// 4. Resumo para a liderança
// ---------------------------------------------------------------------
const KIND_LABEL = { aniversario: 'aniversário', casamento: 'casamento', batismo: 'batismo' };
const weekday = (iso) =>
  new Date(`${iso}T12:00:00-03:00`).toLocaleDateString('pt-BR', { weekday: 'short', timeZone: 'America/Sao_Paulo' }).replace('.', '');

for (const r of byLog(await rpc('claim_leader_summaries'))) {
  const today = r.today_names || [];
  const special = r.today_special || [];
  const week = r.week || [];
  const onlyBirthdays = !special.length && week.every((w) => w.kind === 'aniversario');
  const parts = [];
  if (today.length) parts.push(`${onlyBirthdays ? 'Hoje' : 'Aniversário hoje'}: ${joinNames(today)}.`);
  for (const kind of ['casamento', 'batismo']) {
    const list = special.filter((x) => x.kind === kind);
    if (list.length) parts.push(`${kind === 'casamento' ? 'Casamento' : 'Batismo'} hoje: ${list.map((x) => `${firstName(x.name)} (${yearsText(x.years)})`).join(', ')}.`);
  }
  const weekItem = (w) => `${firstName(w.name)} (${w.kind === 'aniversario' ? '' : `${KIND_LABEL[w.kind]}, `}${weekday(w.date)})`;
  if (week.length) parts.push(`Nesta semana: ${week.map(weekItem).join(', ')}.`);
  const anyToday = today.length || special.length;
  const what = onlyBirthdays ? 'Aniversariantes' : 'Datas especiais';
  const msg = {
    title: anyToday ? `${what} de hoje na ${r.church_name}` : `${what} da semana na ${r.church_name}`,
    body: parts.join(' '),
    url: churchUrl(r.church_slug, '#/aniversariantes'),
    tag: `resumo-${r.church_slug}`,
    icon: churchUrl(r.church_slug, 'icon-192.png'),
  };
  const results = await Promise.all(r.subs.map((s) => push(s, msg)));
  if (!results.some(Boolean)) await rpc('mark_message_failed', { p_log_id: r.log_id });
}

// ---------------------------------------------------------------------
// 5. Aviso ao administrador da plataforma quando o limite de e-mails segurou envios
// ---------------------------------------------------------------------
if (backlog > 0) {
  const msg = {
    title: 'Limite diário de e-mails atingido',
    body: `${backlog} mensagem(ns) de aniversário, casamento ou batismo ficaram para amanhã. O push saiu normalmente.`,
    url: `${SITE_URL}/#/plataforma`,
    tag: 'limite-email',
  };
  for (const t of await rpc('platform_push_targets')) await push(subOf(t), msg);
}

await rpc('clean_message_log');
await rpc('clean_notifications');
// Aulas, presenças e avisos das salas saem depois de 12 meses (LGPD).
await rpc('clean_kids');

// Só números: nada de nome ou endereço de aparelho no registro público do GitHub.
console.log(`Aniversários e datas especiais: ${inApp} na central do app, ${stats.push} push, ${stats.email} e-mail(s), ${backlog} e-mail(s) para amanhã, ${stats.gone} aparelho(s) removido(s), ${stats.failed} falha(s).`);
if (stats.failed && !stats.push && !stats.email) process.exit(1);
