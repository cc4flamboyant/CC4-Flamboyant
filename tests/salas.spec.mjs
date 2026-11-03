// Meus filhos, salas das crianças e calendário nas telas, com contas da igreja Teste A (Android).
// O que o teste cria leva uma marca no nome e é apagado no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const tag = `UI ${Date.now().toString(36)}`;
const ids = {};
const returning = (h) => ({ ...h, Prefer: 'return=representation' });
// Hoje e amanhã no horário de Brasília (o mesmo do navegador nos testes).
const dayBr = (ms = 0) => new Date(Date.now() + ms).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['adm-a', 'lider-a', 'membro-a']) as[u] = await loginAs(api, u);
  const [church] = await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: as['lider-a'].headers })).json();
  ids.church = church.id;
  const [me] = await (await api.get(rest(`members?select=id&church_id=eq.${church.id}&user_id=eq.${as['membro-a'].id}`), { headers: as['membro-a'].headers })).json();
  ids.member = me.id;
});

test.afterAll(async () => {
  if (!api) return;
  await api.delete(rest(`kids_rooms?name=like.${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  await api.delete(rest(`children?name=like.${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  await api.delete(rest(`events?title=like.*${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  await api.dispose();
});

test('o responsável cadastra o filho em Meus filhos', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/filhos');
  await expect(page.getByRole('heading', { name: 'Meus filhos' })).toBeVisible();
  await page.getByRole('link', { name: 'Cadastrar filho' }).click();
  await page.getByLabel('Nome da criança').fill(`${tag} Ana`);
  await page.getByLabel('Data de nascimento').fill('2019-04-02');
  await page.getByLabel('Alergias e cuidados (opcional)').fill('Alergia a amendoim');
  await page.getByLabel(/Autorizo a instituição de ensino/).check();
  await page.getByRole('button', { name: 'Cadastrar' }).click();
  const card = page.locator('.kid-card', { hasText: `${tag} Ana` });
  await expect(card).toContainText('Alergia a amendoim');
  await expect(card).toContainText('Ainda sem sala');
});

test('a liderança cria a sala com o tutor e coloca a criança', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/salas');
  await expect(page.getByRole('heading', { name: 'Salas das crianças' })).toBeVisible();
  await page.getByRole('link', { name: 'Nova sala' }).click();
  await page.getByLabel('Nome da sala').fill(`${tag} Kids`);
  await page.getByLabel('Tutor').selectOption({ label: 'Membro da A' });
  await page.getByRole('button', { name: 'Criar sala' }).click();
  await expect(page.getByRole('heading', { name: `Sala ${tag} Kids` })).toBeVisible();
  await expect(page.locator('.page')).toContainText('Tutor: Membro da A');
  // Botões no modelo da agenda: ações da sala e, para a liderança, Gerenciar sala.
  await expect(page.locator('.room-actions .save-tile').first()).toContainText('Avisar os pais');
  await expect(page.getByRole('heading', { name: 'Gerenciar sala' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Editar sala/ })).toBeVisible();
  ids.room = page.url().match(/salas\/([0-9a-f-]{36})/)[1];

  await page.goto('/i/teste-a/#/salas/criancas');
  await page.getByRole('link', { name: new RegExp(`${tag} Ana`) }).click();
  await page.getByRole('combobox', { name: /^Sala/ }).selectOption({ label: `${tag} Kids` });
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.locator('.page')).toContainText(`Sala ${tag} Kids`);
});

test('o tutor marca a presença, escreve as anotações e avisa os pais; os pais veem', async ({ page }) => {
  // A conta do membro é o tutor e também o responsável.
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/salas');
  await expect(page.getByRole('heading', { name: 'Minhas salas' })).toBeVisible();
  await page.getByRole('link', { name: new RegExp(`${tag} Kids`) }).click();
  // O tutor usa a sala, mas não a gerencia (editar é da liderança).
  await expect(page.locator('.room-actions .save-tile').first()).toContainText('Avisar os pais');
  await expect(page.getByRole('heading', { name: 'Gerenciar sala' })).toHaveCount(0);
  const row = page.locator('.kid-row', { hasText: `${tag} Ana` });
  await expect(row).toContainText('⚠️ Alergia a amendoim');
  await row.getByRole('checkbox').check();
  await expect(page.locator('#room-count')).toHaveText('1 de 1 presente');
  await page.getByLabel(/O que aconteceu na aula/).fill('Hoje aprendemos sobre Davi');
  await page.getByRole('button', { name: 'Salvar anotações' }).click();
  await expect(page.locator('#toast')).toHaveText('Anotações salvas.');
  await page.getByRole('link', { name: 'Avisar os pais' }).click();
  await page.getByLabel('Título').fill(`${tag} passeio`);
  await page.getByLabel('Mensagem (opcional)').fill('Domingo tem passeio');
  await page.getByRole('button', { name: 'Enviar aviso' }).click();
  await expect(page.locator('#toast')).toContainText('Aviso');

  await page.goto(`/i/teste-a/#/filhos/sala/${ids.room}`);
  await expect(page.locator('.page')).toContainText('Domingo tem passeio');
  await expect(page.locator('.page')).toContainText('Hoje aprendemos sobre Davi');
  await expect(page.locator('.page')).toContainText(`Presente: ${tag.split(' ')[0]}`);
});

test('o membro sem sala não vê a tela Salas', async ({ page }) => {
  await api.patch(rest(`kids_rooms?id=eq.${ids.room}`), { headers: returning(as['lider-a'].headers), data: { tutor_member_id: null } });
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/menu');
  await expect(page.getByRole('link', { name: 'Meus filhos' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Minhas salas' })).toHaveCount(0);
});

test('calendário: o mês mostra o evento; o dia mostra os horários; a líder cria evento no dia', async ({ page }) => {
  const day = dayBr(864e5);
  await openLoggedIn(page, as['lider-a'].session, `/i/teste-a/#/calendario/dia/${day}`);
  await expect(page.getByRole('navigation', { name: 'Vista da agenda' }).getByRole('link', { name: 'Dia' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('link', { name: 'Novo evento neste dia' }).click();
  await expect(page.getByLabel('Data')).toHaveValue(day);
  await page.getByLabel('Título').fill(`Ensaio ${tag}`);
  await page.getByLabel('Começa: hora').selectOption('20');
  await page.getByRole('button', { name: 'Criar evento' }).click();
  await expect(page.getByRole('heading', { name: `Ensaio ${tag}` })).toBeVisible();

  await page.goto(`/i/teste-a/#/calendario/dia/${day}`);
  const slot = page.locator('.day-slot', { hasText: `Ensaio ${tag}` });
  await expect(slot).toContainText('20h');
  await page.goto(`/i/teste-a/#/calendario/${day.slice(0, 7)}`);
  const cell = page.locator(`a.cal-day[href="#/calendario/dia/${day}"]`);
  // A célula mostra até dois títulos e "+N" (outros testes também criam eventos neste dia).
  await expect(cell).toHaveAttribute('aria-label', /evento/);
  // A grade cabe na tela do celular, sem rolar para o lado.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await cell.click();
  await expect(page).toHaveURL(new RegExp(`calendario/dia/${day}`));
  await expect(page.locator('.day-slot', { hasText: `Ensaio ${tag}` })).toBeVisible();
});

test('a aba Agenda abre o calendário e a lista continua a um toque', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await page.locator('#tabbar').getByRole('link', { name: 'Agenda' }).click();
  await expect(page).toHaveURL(/#\/calendario$/);
  await expect(page.locator('.cal-grid')).toBeVisible();
  await page.getByRole('navigation', { name: 'Vista da agenda' }).getByRole('link', { name: 'Lista' }).click();
  await expect(page.getByRole('heading', { name: 'Agenda' })).toBeVisible();
  await expect(page.locator('#tabbar').getByRole('link', { name: 'Agenda' })).toHaveClass(/active/);
  // O membro não vê o botão de novo evento.
  await page.goto('/i/teste-a/#/calendario');
  await expect(page.getByRole('link', { name: 'Novo evento' })).toHaveCount(0);
});
