// Varredura automática de segurança do CC4 (parte da skill teste-vulnerabilidade).
// Só lê: não grava nada no banco nem no site. Rode na raiz do projeto:
//   node .claude/skills/teste-vulnerabilidade/varredura.mjs [--sem-historico] [--sem-site] [--sem-banco]
//
// 1. Segredos nos arquivos do Git, em todo o histórico do Git e no site publicado
// 2. O que um visitante anônimo (só com a chave pública) consegue ler no banco e nos arquivos
// 3. Regras da página (CSP) e scripts de fora com versão fixa
//
// Nada encontrado é mostrado por inteiro: segredos aparecem cortados (primeiros caracteres + …).
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const SITE = 'https://DONO.github.io/REPOSITORIO/';
const config = readFileSync('js/config.js', 'utf8');
const SUPABASE_URL = config.match(/SUPABASE_URL:\s*'([^']+)'/)?.[1];
const ANON_KEY = config.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/)?.[1];
const VAPID_PUBLIC = config.match(/VAPID_PUBLIC_KEY:\s*'([^']+)'/)?.[1];

const findings = [];
const add = (level, where, what) => findings.push({ level, where, what });
const cut = (s) => `${String(s).slice(0, 8)}…`;

// ---------------------------------------------------------------------
// 1. Segredos
// ---------------------------------------------------------------------
const decodeJwt = (t) => {
  try {
    return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
};
// Cada regra: nível, nome e expressão. A chave pública (sb_publishable_), a URL do Supabase e a
// chave VAPID pública podem estar no app; o resto, não.
const RULES = [
  ['CRÍTICO', 'chave secreta do Supabase (sb_secret_)', /sb_secret_[A-Za-z0-9_-]{10,}/g],
  ['CRÍTICO', 'chave privada (PEM)', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['CRÍTICO', 'token do GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['CRÍTICO', 'chave da AWS', /\bAKIA[0-9A-Z]{16}\b/g],
  ['CRÍTICO', 'chave do Resend/e-mail', /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{8,}\b/g],
  ['CRÍTICO', 'chave privada VAPID', /VAPID_PRIVATE[A-Z_]*\s*[:=]\s*['"`][A-Za-z0-9_-]{30,}['"`]/g],
  ['ALTO', 'senha escrita no código', /\b(?:password|senha|passwd)\s*[:=]\s*['"`][^'"`\s$]{6,}['"`]/gi],
  ['ALTO', 'connection string do Postgres com senha', /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]{4,}@/g],
];
const JWT = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
// Arquivos que mostram de propósito exemplos dos padrões acima (esta skill).
const IGNORE_FILES = [/^\.claude\/skills\/teste-vulnerabilidade\//];

function scanText(text, where) {
  for (const [level, name, re] of RULES) {
    for (const m of text.matchAll(re)) add(level, where, `${name}: ${cut(m[0])}`);
  }
  for (const m of text.matchAll(JWT)) {
    const role = decodeJwt(m[0])?.role;
    if (role === 'anon') add('INFO', where, `JWT com papel anon (chave pública antiga): ${cut(m[0])}`);
    else add('CRÍTICO', where, `JWT com papel "${role ?? '?'}" (service_role ou token de alguém): ${cut(m[0])}`);
  }
}

// O app (o que vai para o navegador): também não pode citar service_role nem guardar dados pessoais.
const FRONT = /^(js\/|css\/|[^/]+\.html$|sw\.js$|manifest[^/]*\.json$|i\/)/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_OK = /@(example\.(com|org)|exemplo\.|teste\.|igreja\.com$|b\.com$)/i;
function scanFront(text, where) {
  if (/service_role|SERVICE_ROLE/.test(text)) add('ALTO', where, 'cita "service_role" no código do app');
  if (/\beval\s*\(|new Function\s*\(/.test(text)) add('MÉDIO', where, 'usa eval/new Function');
  for (const m of text.matchAll(EMAIL)) {
    if (!EMAIL_OK.test(m[0])) add('MÉDIO', where, `e-mail no código do app (dado pessoal?): ${cut(m[0])}`);
  }
}

console.log('1/3 Segredos nos arquivos do Git…');
const tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const f of tracked) {
  if (/\.local(\.sql)?$|\.env$|\.pem$|\.key$/.test(f)) add('CRÍTICO', f, 'arquivo que deveria ficar fora do Git está versionado');
  if (IGNORE_FILES.some((re) => re.test(f)) || !existsSync(f)) continue;
  if (/\.(png|jpe?g|gif|webp|ico|pdf|woff2?|zip)$/i.test(f)) continue;
  const text = readFileSync(f, 'utf8');
  scanText(text, f);
  if (FRONT.test(f)) scanFront(text, f);
}
if (existsSync('chat-prompt.md') && tracked.includes('chat-prompt.md')) add('MÉDIO', 'chat-prompt.md', 'arquivo do usuário versionado sem pedido');

if (!args.has('--sem-historico')) {
  console.log('   …e em todo o histórico do Git (commits antigos também ficam públicos)');
  const log = execSync('git log -p --all --no-color --format="@@commit %h"', { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
  let commit = '?';
  let file = '?';
  for (const line of log.split('\n')) {
    if (line.startsWith('@@commit ')) commit = line.slice(9);
    else if (line.startsWith('+++ b/')) file = line.slice(6);
    else if (line.startsWith('+') && !IGNORE_FILES.some((re) => re.test(file))) {
      const before = findings.length;
      scanText(line, `histórico ${commit} ${file}`);
      // No histórico, só o que é grave (o resto já aparece nos arquivos atuais).
      findings.splice(before, findings.length - before, ...findings.slice(before).filter((x) => x.level === 'CRÍTICO'));
    }
  }
}

if (!args.has('--sem-site')) {
  console.log('   …e no site publicado');
  const paths = tracked.filter((f) => /^(js\/.*\.js|css\/.*\.css|[^/]+\.html|sw\.js|manifest[^/]*\.json)$/.test(f));
  for (const p of paths) {
    const res = await fetch(SITE + p).catch(() => null);
    if (!res?.ok) continue;
    const text = await res.text();
    scanText(text, `site ${p}`);
    scanFront(text, `site ${p}`);
  }
  // Arquivos que nunca podem estar publicados.
  for (const p of ['tests/senha-testes.local', 'tests/sessoes.local', 'tests/envio-segredo.local', 'tests/vapid-privada.local', 'supabase/usuarios-de-teste.local.sql', '.env', '.git/config']) {
    const res = await fetch(SITE + p).catch(() => null);
    if (res?.ok) add('CRÍTICO', `site ${p}`, 'arquivo secreto está publicado no site');
  }
}

// ---------------------------------------------------------------------
// 2. O que o visitante anônimo enxerga no banco
// ---------------------------------------------------------------------
if (!args.has('--sem-banco')) {
  console.log('2/3 Banco como visitante anônimo (só a chave pública)…');
  const headers = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` };
  const sql = readdirSync('supabase')
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()
    .map((f) => readFileSync(`supabase/${f}`, 'utf8'))
    .join('\n');
  const names = (re) => [...new Set([...sql.matchAll(re)].map((m) => m[1]))];
  const tables = names(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi);
  const views = names(/create\s+(?:or\s+replace\s+)?view\s+public\.(\w+)/gi);
  // Leitura pública de propósito (perfil da igreja: nome, cores, Pix etc.). Conferir as colunas.
  const PUBLIC_OK = new Set(['churches']);
  for (const t of [...tables, ...views]) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*&limit=3`, { headers });
    if (!res.ok) continue; // negado: certo
    const rows = await res.json().catch(() => []);
    if (!Array.isArray(rows) || !rows.length) continue; // liberado, mas o RLS não devolve nada: certo
    const cols = Object.keys(rows[0]).join(', ');
    if (PUBLIC_OK.has(t)) add('INFO', `tabela ${t}`, `leitura pública de propósito; confira se as colunas podem ser públicas: ${cols}`);
    else add('ALTO', `tabela ${t}`, `o visitante anônimo lê linhas (colunas: ${cols})`);
  }
  // Gravar: não é testado aqui (seria gravar no banco de verdade). As permissões de gravar ficam
  // com as consultas do SKILL.md (role_table_grants e pg_policies), que só leem.
  // Arquivos: só o bucket "igrejas" (logos) é público.
  const PUBLIC_BUCKETS = new Set(['igrejas']);
  const buckets = names(/insert\s+into\s+storage\.buckets[^;]*?values\s*\(\s*'([\w-]+)'/gi);
  for (const b of buckets) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${b}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 5 }),
    });
    const list = res.ok ? await res.json().catch(() => []) : [];
    if (Array.isArray(list) && list.length && !PUBLIC_BUCKETS.has(b)) add('ALTO', `arquivos ${b}`, `o visitante anônimo lista ${list.length}+ arquivos de um bucket privado`);
  }
  // A estrutura do banco não pode ser listada com a chave pública.
  const openapi = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers });
  if (openapi.ok) add('MÉDIO', 'API', 'a chave pública lista a estrutura do banco (OpenAPI)');
}

// ---------------------------------------------------------------------
// 3. Regras da página
// ---------------------------------------------------------------------
console.log('3/3 Regras da página (CSP) e scripts de fora…');
for (const page of ['index.html', '404.html', 'privacidade.html']) {
  if (!existsSync(page)) continue;
  const html = readFileSync(page, 'utf8');
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
  if (!csp) {
    add(page === 'privacidade.html' ? 'BAIXO' : 'ALTO', page, 'página sem regra de segurança (CSP)');
    continue;
  }
  const script = csp.match(/script-src([^;]*)/)?.[1] ?? '';
  if (/'unsafe-inline'/.test(script)) add('ALTO', page, "CSP permite script inline ('unsafe-inline')");
  if (/'unsafe-eval'/.test(script)) add('ALTO', page, "CSP permite eval ('unsafe-eval')");
  if (/(^|\s)(https:|\*|http:)(\s|$)/.test(script)) add('ALTO', page, 'CSP aceita script de qualquer site');
  if (!/object-src\s+'none'/.test(csp)) add('BAIXO', page, "CSP sem object-src 'none'");
  if (!/base-uri/.test(csp)) add('BAIXO', page, 'CSP sem base-uri');
}
for (const f of tracked.filter((x) => FRONT.test(x) && existsSync(x) && /\.(js|html)$/.test(x))) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/https:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|cdnjs\.cloudflare\.com\/ajax\/libs)\/([^'"`\s)]+)/g)) {
    // Pacote sem versão fixa (ex.: pacote@latest ou sem @): pode mudar sem aviso.
    const pkg = m[1];
    const versioned = /@\d+\.\d+\.\d+/.test(pkg) || /^[^/]+\/\d+\.\d+\.\d+\//.test(pkg);
    if (!versioned) add('MÉDIO', f, `script de fora sem versão fixa: ${m[0].slice(0, 90)}`);
  }
}
if (VAPID_PUBLIC && VAPID_PUBLIC.length < 80) add('BAIXO', 'js/config.js', 'chave VAPID pública com tamanho estranho (é a pública mesmo?)');

// ---------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------
const ORDER = ['CRÍTICO', 'ALTO', 'MÉDIO', 'BAIXO', 'INFO'];
findings.sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level));
const seen = new Set();
console.log('\n=== Resultado da varredura ===');
for (const f of findings) {
  const key = `${f.level}|${f.where}|${f.what}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.log(`[${f.level}] ${f.where} — ${f.what}`);
}
const count = (l) => findings.filter((f) => f.level === l).length;
console.log(`\nCRÍTICO ${count('CRÍTICO')} · ALTO ${count('ALTO')} · MÉDIO ${count('MÉDIO')} · BAIXO ${count('BAIXO')} · INFO ${count('INFO')}`);
process.exit(count('CRÍTICO') + count('ALTO') ? 1 : 0);
