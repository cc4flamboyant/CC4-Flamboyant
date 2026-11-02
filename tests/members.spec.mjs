// Telas de membros com a líder da igreja Teste A logada: lista, busca, cadastro, edição e planilha.
// Tudo o que o teste cria começa com "UI Teste" e é apagado no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
let lider;
let admin;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
const NAME = `UI Teste ${stamp}`;
const EMAIL = `ui-${stamp}@teste.igrejaconecta.invalid`;

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  lider = await loginAs(api, 'lider-a');
  admin = await loginAs(api, 'adm-a');
});

test.afterAll(async () => {
  if (!api) return;
  await api.delete(rest(`members?name=like.UI Teste ${stamp}*`), { headers: admin.headers });
  await api.dispose();
});

test('a líder vê e busca os membros da igreja', async ({ page }) => {
  await openLoggedIn(page, lider.session, '/i/teste-a/#/membros');
  await expect(page.getByRole('heading', { name: 'Membros' })).toBeVisible();
  await expect(page.locator('.member-row', { hasText: 'Fulano da A' })).toBeVisible();
  await expect(page.locator('.member-row', { hasText: 'Fulano da B' })).toHaveCount(0);
  await page.getByLabel('Buscar membros').fill('fulano');
  await expect(page.locator('.member-row')).toHaveCount(1);
  // O botão redondo "+" abre o menu com as duas formas de adicionar; tocar fora fecha.
  const fabBtn = page.getByLabel('Adicionar membros');
  const novo = page.getByRole('link', { name: 'Novo membro' });
  await expect(novo).toBeHidden();
  await fabBtn.click();
  await expect(page.getByRole('link', { name: 'Importar planilha' })).toBeVisible();
  await page.getByRole('heading', { name: 'Membros' }).click();
  await expect(novo).toBeHidden();
  await fabBtn.click();
  await page.getByRole('link', { name: 'Importar planilha' }).click();
  await expect(page.getByRole('heading', { name: 'Importar planilha' })).toBeVisible();
  await page.goBack();
  await fabBtn.click();
  await novo.click();
  await expect(page.getByRole('heading', { name: 'Novo membro' })).toBeVisible();
});

test('a líder cadastra e edita um membro, mas não muda o papel nem exclui', async ({ page }) => {
  await openLoggedIn(page, lider.session, '/i/teste-a/#/membros/novo');
  await page.getByLabel('Nome', { exact: true }).fill(NAME);
  await page.getByLabel('E-mail').fill(EMAIL);
  await page.getByLabel('Telefone com DDD').fill('(61) 98888-7777');
  await page.getByLabel('Data de nascimento').fill('1990-05-10');
  await expect(page.getByLabel('Papel na igreja')).toBeDisabled();
  await page.getByLabel('A pessoa concordou').check();
  await page.getByRole('button', { name: 'Cadastrar' }).click();

  const row = page.locator('.member-row', { hasText: NAME });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Ainda não entrou');

  await row.click();
  await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Excluir cadastro' })).toHaveCount(0);
  await page.getByLabel('Telefone com DDD').fill('(61) 97777-6666');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.locator('.member-row', { hasText: NAME })).toBeVisible();

  const [saved] = await (await api.get(rest(`members?select=phone,birth_date,role&email=eq.${EMAIL}`), { headers: admin.headers })).json();
  expect(saved).toEqual({ phone: '5561977776666', birth_date: '1990-05-10', role: 'membro' });
});

test('arrastar um membro para a esquerda inativa, com Desfazer; em Inativos, reativa', async ({ page }) => {
  const status = async () => (await (await api.get(rest(`members?select=status&email=eq.${EMAIL}`), { headers: admin.headers })).json())[0].status;
  const drag = async (wrap, fraction) => {
    const box = await wrap.locator('.member-row').boundingBox();
    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + box.width * 0.9, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * (0.9 - fraction), y, { steps: 12 });
    await page.mouse.up();
  };

  await openLoggedIn(page, lider.session, '/i/teste-a/#/membros');
  await expect(page.getByText('Arraste um membro para a esquerda para inativar.')).toBeVisible();
  // O próprio cadastro não arrasta.
  await expect(page.locator('.member-row', { hasText: 'Líder da A' })).toBeVisible();
  await expect(page.locator('.swipe', { hasText: 'Líder da A' })).toHaveCount(0);

  await page.getByLabel('Buscar membros').fill(NAME);
  const wrap = page.locator('.swipe', { hasText: NAME });
  await expect(wrap).toContainText('Inativar');
  // Arrasto curto: a linha volta ao lugar e nada muda.
  await drag(wrap, 0.15);
  await expect(wrap).toBeVisible();
  await expect(page).toHaveURL(/#\/membros$/); // soltar depois de arrastar não abre o cadastro
  expect(await status()).toBe('ativo');

  // Arrasto longo: inativa, com Desfazer.
  await drag(wrap, 0.7);
  await expect(page.locator('#toast')).toContainText(`${NAME} foi para Inativos.`);
  await expect(wrap).toHaveCount(0);
  expect(await status()).toBe('inativo');
  await page.getByRole('button', { name: 'Desfazer' }).click();
  await expect(wrap).toBeVisible();
  await expect.poll(status).toBe('ativo');

  await drag(wrap, 0.7);
  await expect(wrap).toHaveCount(0);
  await expect.poll(status).toBe('inativo');

  // Em Inativos, o mesmo gesto reativa.
  await page.getByRole('link', { name: 'Inativos' }).click();
  await expect(page.getByText('Arraste um membro para a esquerda para reativar.')).toBeVisible();
  await page.getByLabel('Buscar membros').fill(NAME);
  await expect(wrap).toContainText('Reativar');
  await drag(wrap, 0.7);
  await expect(page.locator('#toast')).toContainText(`${NAME} voltou para Ativos.`);
  await expect(wrap).toHaveCount(0);
  await expect.poll(status).toBe('ativo');
});

test('a líder importa uma planilha: pula o e-mail repetido e mostra os erros', async ({ page }) => {
  const csv = [
    'nome;email;telefone;nascimento',
    `${NAME} planilha;planilha-${stamp}@teste.igrejaconecta.invalid;(61) 96666-5555;01/02/1985`,
    `${NAME} repetido;${EMAIL};;`,
    `X;;;31/02/1990`,
  ].join('\r\n');
  await openLoggedIn(page, lider.session, '/i/teste-a/#/membros/importar');
  await page.locator('#file').setInputFiles({ name: 'membros.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') });
  await expect(page.getByRole('heading', { name: '1 pessoa pronta para importar' })).toBeVisible();
  await expect(page.locator('tr.skip')).toContainText('já cadastrado');
  await expect(page.locator('tr.bad')).toContainText('data de nascimento inválida');
  await page.getByLabel('As pessoas da planilha concordaram').check();
  await page.getByRole('button', { name: 'Importar 1 pessoa' }).click();
  await expect(page.locator('.member-row', { hasText: `${NAME} planilha` })).toBeVisible();

  const rows = await (await api.get(rest(`members?select=name,birth_date&name=like.UI Teste ${stamp}*&order=name`), { headers: admin.headers })).json();
  expect(rows.map((r) => r.name)).toEqual([NAME, `${NAME} planilha`]);
});

test('sem foto, as iniciais ficam no meio da bolinha', async ({ page }) => {
  await openLoggedIn(page, lider.session, '/i/teste-a/#/membros');
  const ball = page.locator('.member-row', { hasText: 'Fulano da A' }).locator('.avatar');
  await expect(ball.locator('.initials')).toHaveText('FD');
  const b = await ball.boundingBox();
  // A caixa das iniciais vai do topo das maiúsculas até a linha de base: o meio dela é o das letras.
  const t = await ball.locator('.initials').boundingBox();
  expect(b.width).toBeCloseTo(b.height, 0);
  expect(Math.abs(t.y + t.height / 2 - (b.y + b.height / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(t.x + t.width / 2 - (b.x + b.width / 2))).toBeLessThanOrEqual(1);
});
