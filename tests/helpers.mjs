import { readFileSync } from 'node:fs';

// Lê a URL e a chave pública direto do js/config.js, para os testes usarem o mesmo projeto do site.
const config = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
const pick = (key) => config.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1];

export const SUPABASE_URL = pick('SUPABASE_URL');
export const ANON_KEY = pick('SUPABASE_ANON_KEY');
export const configured = !!ANON_KEY && !ANON_KEY.includes('COLE-AQUI');
export const headers = { apikey: ANON_KEY, 'Content-Type': 'application/json' };

export const rest = (path) => `${SUPABASE_URL}/rest/v1/${path}`;

// Senha das contas de teste: segredo TEST_USERS_PASSWORD no GitHub; no computador,
// o arquivo tests/senha-testes.local criado por scripts/criar-usuarios-de-teste.mjs.
export function testPassword() {
  if (process.env.TEST_USERS_PASSWORD) return process.env.TEST_USERS_PASSWORD;
  try {
    return readFileSync(new URL('./senha-testes.local', import.meta.url), 'utf8').trim();
  } catch {
    return null;
  }
}

export const testEmail = (user) => `${user}@teste.igrejaconecta.invalid`;

// Sessões das contas de teste da rodada (gravadas pelo tests/global-setup.mjs).
export const SESSIONS_FILE = new URL('./sessoes.local', import.meta.url);

const asAccount = (session) => ({
  id: session.user.id,
  session,
  headers: { apikey: ANON_KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
});

// Entra de verdade (usado só pelo global-setup, ou se a sessão guardada faltar ou estiver vencendo).
export async function freshLogin(request, user) {
  const res = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    data: { email: testEmail(user), password: testPassword() },
  });
  if (!res.ok()) throw new Error(`Login de ${user} falhou (${res.status()}): ${await res.text()}. Rode supabase/usuarios-de-teste.local.sql.`);
  return res.json();
}

// Conta de teste logada: cabeçalhos para falar com o banco como ela e a sessão para o navegador.
export async function loginAs(request, user) {
  try {
    const saved = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'))[user];
    if (saved && saved.expires_at * 1000 > Date.now() + 10 * 60 * 1000) return asAccount(saved);
  } catch {}
  return asAccount(await freshLogin(request, user));
}

// As igrejas de teste só podem ter as contas de teste, com os papéis esperados. Se alguém entrar
// nelas com uma conta de verdade (ex.: virar administrador da Teste A), alguns testes deixariam de
// ser barrados e mudariam dados de verdade. Por isso tudo para aqui, antes de mexer em qualquer coisa.
export async function assertCleanTestChurches(request, as) {
  const expected = {
    'adm-a@teste.igrejaconecta.invalid': 'admin',
    'lider-a@teste.igrejaconecta.invalid': 'lider',
    'membro-a@teste.igrejaconecta.invalid': 'membro',
    'adm-b@teste.igrejaconecta.invalid': 'admin',
  };
  const problems = [];
  for (const who of ['lider-a', 'adm-b']) {
    const res = await request.get(rest('members?select=name,email,role,user_id'), { headers: as[who].headers });
    for (const m of await res.json()) {
      if (m.user_id && !(m.email || '').endsWith('@teste.igrejaconecta.invalid')) problems.push(`conta que não é de teste: "${m.name}"`);
      if (expected[m.email] && expected[m.email] !== m.role) problems.push(`"${m.name}" está como ${m.role} (esperado: ${expected[m.email]})`);
    }
  }
  if (problems.length) {
    throw new Error(
      `As igrejas de teste não estão como os testes esperam: ${[...new Set(problems)].join('; ')}. ` +
        'Rode supabase/limpar-igrejas-de-teste.sql no SQL Editor e tente de novo. Para experimentar o app, use a Igreja Exemplo.',
    );
  }
}

// Abre o app já logado com uma conta de teste (a sessão vai onde o supabase-js a guarda).
export async function openLoggedIn(page, session, url) {
  const ref = new URL(SUPABASE_URL).hostname.split('.')[0];
  await watchCsp(page);
  await page.addInitScript(
    ([key, value]) => {
      if (!sessionStorage.getItem('__sessao_de_teste')) {
        localStorage.setItem(key, value);
        sessionStorage.setItem('__sessao_de_teste', '1');
      }
    },
    // A mesma sessão serve a vários testes ao mesmo tempo: o navegador não deve renová-la
    // (renovar invalida a cópia dos outros). Quem confere a validade do token é o banco.
    // Também evita a renovação nos testes que adiantam o relógio do navegador.
    [`sb-${ref}-auth-token`, JSON.stringify({ ...session, expires_at: 4102444800 })],
  );
  await page.goto(url);
}

// Anota o que o navegador bloquear pela regra de segurança das páginas (CSP).
export async function watchCsp(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
}
export const cspViolations = (page) => page.evaluate(() => window.__csp || []);

// Responde a pergunta do app (janela com o nome da igreja, no lugar da do navegador): digita o
// texto, se houver, e toca no botão da ação.
export async function answer(page, text) {
  const dlg = page.locator('dialog.ask');
  await dlg.waitFor();
  if (text != null) await dlg.locator('input').fill(text);
  await dlg.locator('button[value="ok"]').click();
}
