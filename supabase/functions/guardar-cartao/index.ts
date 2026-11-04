// Guarda o cartão de aniversário gerado pelo envio das 7h (scripts/enviar-aniversarios.mjs) na
// pasta pública igrejas/cartoes/<instituição>/, com um nome sorteado. A chave de serviço do
// Supabase fica só aqui dentro; quem chama prova quem é com o segredo ENVIO_SECRET (gravado
// pelo workflow funcoes.yml). Apaga os cartões da instituição com mais de 40 dias.
// (Da skill mensagem-aniversario; veio do Igreja Conecta.)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 3 * 1024 * 1024;
const KEEP_DAYS = 40;
const BUCKET = 'igrejas'; // o mesmo de save_celebration_card (031)

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Compara sem revelar, pelo tempo, quantas letras acertou.
function sameSecret(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return reply(405, { error: 'Use POST.' });
  const secret = Deno.env.get('ENVIO_SECRET');
  if (!secret) return reply(503, { error: 'Envio não configurado.' });
  if (!sameSecret(req.headers.get('x-envio-secret') ?? '', secret)) return reply(401, { error: 'Sem permissão.' });

  const church = new URL(req.url).searchParams.get('igreja') ?? '';
  if (!UUID.test(church)) return reply(400, { error: 'Instituição inválida.' });

  const bytes = new Uint8Array(await req.arrayBuffer());
  // Só JPEG (começa com FF D8 FF), até 3 MB.
  if (bytes.length < 100 || bytes.length > MAX_BYTES || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return reply(400, { error: 'Imagem inválida.' });
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const auth = { Authorization: `Bearer ${key}`, apikey: key };
  const folder = `cartoes/${church}`;
  const path = `${folder}/${crypto.randomUUID()}.jpg`; // ninguém adivinha o endereço

  const up = await fetch(`${url}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=31536000', 'x-upsert': 'false' },
    body: bytes,
  });
  if (!up.ok) return reply(502, { error: 'Não deu para guardar o cartão.' });

  // Limpeza dos cartões antigos desta instituição (se falhar, não atrapalha).
  try {
    const list = await fetch(`${url}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: folder, limit: 200, sortBy: { column: 'created_at', order: 'asc' } }),
    });
    const files: { name: string; created_at?: string }[] = list.ok ? await list.json() : [];
    const limit = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
    const old = files.filter((f) => f.created_at && Date.parse(f.created_at) < limit).map((f) => `${folder}/${f.name}`);
    if (old.length) {
      await fetch(`${url}/storage/v1/object/${BUCKET}`, {
        method: 'DELETE',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefixes: old }),
      });
    }
  } catch (_) {
    // segue
  }

  return reply(200, { url: `${url}/storage/v1/object/public/${BUCKET}/${path}` });
});
