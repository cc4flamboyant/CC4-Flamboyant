// Aviso de teste de Menu > Notificações: com o login da pessoa, só para o aparelho dela (a regra do
// banco só deixa ler os próprios aparelhos). Usa os segredos VAPID_PRIVATE_KEY e ENVIO_SECRET,
// gravados aqui pelo workflow funcoes.yml. Os outros avisos saem pelo envio dos lembretes.
import webpush from 'npm:web-push@3.6.7';

const SITE_URL = 'https://DONO.github.io/REPOSITORIO';
const ORIGINS = ['https://DONO.github.io', 'http://localhost:4173'];
// Chave pública (a mesma de js/config.js).
const VAPID_PUBLIC_KEY = 'BJShYv6bENLmIv5Djm9bRmvn_HN5zcuGBC-x9FCIZMa9fNp1_qBeHGZZIa_yGa7teqMd3Du2xDtIPFcs00rNgZw';
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

type Device = { endpoint: string; p256dh: string; auth: string };

const cors = (req: Request) => ({
  'Access-Control-Allow-Origin': ORIGINS.includes(req.headers.get('Origin') ?? '') ? req.headers.get('Origin')! : ORIGINS[0],
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  Vary: 'Origin',
});

Deno.serve(async (req) => {
  const headers = { ...cors(req), 'Content-Type': 'application/json' };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });

  const secret = Deno.env.get('ENVIO_SECRET');
  const privateKey = Deno.env.get('VAPID_PRIVATE_KEY');
  if (!secret || !privateKey) return reply(503, { error: 'Notificações não configuradas.' });
  webpush.setVapidDetails(SITE_URL, VAPID_PUBLIC_KEY, privateKey);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_secret: secret, ...args }),
    });
    // O motivo vem do banco (código e mensagem do erro); não traz senha nem endereço de aparelho.
    if (!res.ok) throw new Error(`${fn}: ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  };

  let body: { test?: boolean; endpoint?: string; church?: string };
  try {
    body = await req.json();
  } catch {
    return reply(400, { error: 'Pedido inválido.' });
  }

  // Envia e conta: entregue ao serviço de push, aparelho que não existe mais (apagado) ou falha.
  const stats = { sent: 0, gone: 0, failed: 0 };
  const send = async (d: Device, payload: Record<string, string>) => {
    try {
      await webpush.sendNotification({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, JSON.stringify(payload), {
        TTL: 24 * 3600,
        urgency: 'high',
      });
      stats.sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        await rpc('forget_push_subscription', { p_endpoint: d.endpoint }).catch(() => {});
        stats.gone++;
      } else {
        stats.failed++;
        console.error('push', status ?? 'sem status', (err as { body?: string }).body ?? (err as Error).message);
      }
    }
  };

  if (body.test) {
    // Aviso de teste: com o login de quem pediu, só para o aparelho informado (e só se for dele).
    const auth = req.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || typeof body.endpoint !== 'string' || !body.endpoint.startsWith('https://')) {
      return reply(400, { error: 'Pedido inválido.' });
    }
    const res = await fetch(
      `${url}/rest/v1/push_subscriptions?select=endpoint,p256dh,auth&endpoint=eq.${encodeURIComponent(body.endpoint)}`,
      { headers: { apikey: anon, Authorization: auth } },
    );
    if (!res.ok) return reply(401, { error: 'Entre na sua conta.' });
    const devices: Device[] = await res.json();
    const church = SLUG.test(body.church ?? '') ? `${SITE_URL}/i/${body.church}/` : `${SITE_URL}/`;
    await Promise.all(
      devices.map((d) =>
        send(d, {
          title: 'Aviso de teste',
          body: 'Se você está vendo isto, as notificações funcionam neste celular.',
          url: `${church}#/notificacoes`,
          tag: 'teste',
          icon: `${church}icon-192.png`,
        }),
      ),
    );
    return reply(200, { ...stats, devices: devices.length });
  }

  return reply(400, { error: 'Pedido inválido.' });
});
