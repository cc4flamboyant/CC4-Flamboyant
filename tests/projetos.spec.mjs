// Projetos das salas nas telas, com contas da Teste A (Android).
// A sala, a criança e o projeto do teste levam uma marca no nome e são apagados no fim.
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const ids = {};
const tag = `ProjUI ${Date.now().toString(36)}`;
const title = `${tag} Feira de ciências`;
const returning = (h) => ({ ...h, Prefer: 'return=representation' });

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['adm-a', 'lider-a', 'membro-a']) as[u] = await loginAs(api, u);
  const [{ id: church }] = await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: as['adm-a'].headers })).json();
  const [{ id: membro }] = await (await api.get(rest(`members?select=id&church_id=eq.${church}&user_id=eq.${as['membro-a'].id}`), { headers: as['adm-a'].headers })).json();
  ids.room = (await (await api.post(rest('kids_rooms'), { headers: returning(as['adm-a'].headers), data: { church_id: church, name: tag } })).json())[0].id;
  const kid = await api.post(rest('children'), { headers: returning(as['membro-a'].headers), data: { church_id: church, name: `${tag} Filho`, birth_date: '2019-04-02', guardian_member_id: membro } });
  ids.kid = (await kid.json())[0].id;
  await api.post(rest('rpc/room_assign'), { headers: as['adm-a'].headers, data: { p_child: ids.kid, p_room: ids.room } });
});

test.afterAll(async () => {
  if (!api) return;
  const files = await (await api.get(rest(`project_files?select=path,room_projects!inner(room_id)&room_projects.room_id=eq.${ids.room}`), { headers: as['adm-a'].headers })).json();
  if (Array.isArray(files) && files.length) await api.delete(`${SUPABASE_URL}/storage/v1/object/projetos`, { headers: as['adm-a'].headers, data: { prefixes: files.map((f) => f.path) } });
  if (ids.room) await api.delete(rest(`kids_rooms?id=eq.${ids.room}`), { headers: as['adm-a'].headers });
  if (ids.kid) await api.delete(rest(`children?id=eq.${ids.kid}`), { headers: as['membro-a'].headers });
  await api.dispose();
});

test('a liderança cria o projeto da sala, com etapa e arquivo', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: 'Projetos das salas' }).click();
  await expect(page.getByRole('heading', { name: 'Projetos', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Novo projeto' }).click();
  await page.getByLabel('Sala').selectOption({ label: tag });
  await page.getByLabel('Título').fill(title);
  await page.getByLabel('Descrição (opcional)').fill('Cada criança traz uma experiência. Veja www.exemplo.com.br');
  await page.getByRole('button', { name: 'Criar projeto' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await expect(page.getByRole('link', { name: 'www.exemplo.com.br' })).toBeVisible();

  await page.getByLabel('Nova etapa').fill('Escolher a experiência');
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  const step = page.locator('.steps li').filter({ hasText: 'Escolher a experiência' });
  await expect(step).toBeVisible();
  await step.getByRole('checkbox').check();
  await expect(page.getByText('1 de 1 feitas')).toBeVisible();

  await page.locator('#project-files').setInputFiles({ name: 'roteiro.txt', mimeType: 'text/plain', buffer: Buffer.from('Roteiro da feira') });
  await expect(page.getByText('1 arquivo enviado.')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.project-file a.msg-doc')).toContainText('roteiro.txt');
});

test('o responsável da sala vê o projeto e comenta; abre na hora', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.getByRole('link', { name: 'Projetos' }).first().click();
  const card = page.locator('.project-card').filter({ hasText: title });
  await expect(card).toBeVisible({ timeout: 1000 });
  await expect(card).toContainText('1 de 1 etapas feitas');
  await page.unroute('**/rest/v1/**');
  await card.click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  // O pai não edita: sem botões de editar, de etapa nem de arquivo.
  await expect(page.getByRole('link', { name: 'Editar projeto' })).toHaveCount(0);
  await expect(page.getByLabel('Nova etapa')).toHaveCount(0);
  await expect(page.locator('.steps li')).toContainText('Escolher a experiência');
  await page.getByLabel('Escreva um comentário').fill('Vamos levar um vulcão!');
  await page.getByRole('button', { name: 'Comentar' }).click();
  await expect(page.locator('.comment').filter({ hasText: 'Vamos levar um vulcão!' })).toBeVisible();
  // Apaga o próprio comentário.
  await page.locator('.comment').filter({ hasText: 'Vamos levar um vulcão!' }).getByRole('button', { name: 'Apagar comentário' }).click();
  await answer(page);
  await expect(page.locator('.comment')).toHaveCount(0);
});

test('a entrega do projeto aparece na Agenda (lista, mês e dia) e abre o projeto', async ({ page }) => {
  // Daqui a 3 dias, no fuso dos testes.
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const due = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 3);
  const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
  const [{ id: church }] = await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: as['adm-a'].headers })).json();
  const delivery = `${tag} Maquete`;
  const res = await api.post(rest('room_projects'), {
    headers: returning(as['lider-a'].headers),
    data: { church_id: church, room_id: ids.room, title: delivery, due_on: iso },
  });
  expect(res.ok()).toBeTruthy();

  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/agenda');
  const card = page.locator('.event-card.delivery').filter({ hasText: delivery });
  await expect(card).toBeVisible();
  await expect(card).toContainText(`Entrega do projeto · ${tag}`);

  await page.goto(`/i/teste-a/#/calendario/${iso.slice(0, 7)}`);
  await expect(page.locator(`.cal-day[href="#/calendario/dia/${iso}"] .cal-ev.delivery`)).toContainText(delivery);

  await page.goto(`/i/teste-a/#/calendario/dia/${iso}`);
  await page.locator('.day-deliveries .event-card').filter({ hasText: delivery }).click();
  await expect(page.getByRole('heading', { name: delivery })).toBeVisible();
});

test('a liderança troca o projeto de sala ao editar; o pai da sala nova passa a ver', async ({ page }) => {
  const [{ id: church }] = await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: as['adm-a'].headers })).json();
  const otherName = `${tag} Outra`.slice(0, 40);
  const [other] = await (await api.post(rest('kids_rooms'), { headers: returning(as['adm-a'].headers), data: { church_id: church, name: otherName } })).json();
  try {
    const moving = `${tag} Mudando`;
    const [proj] = await (await api.post(rest('room_projects'), { headers: returning(as['lider-a'].headers), data: { church_id: church, room_id: other.id, title: moving } })).json();
    const parentSees = async () =>
      (await (await api.get(rest(`room_projects?select=id&id=eq.${proj.id}`), { headers: as['membro-a'].headers })).json()).length;
    expect(await parentSees()).toBe(0);

    await openLoggedIn(page, as['lider-a'].session, `/i/teste-a/#/projetos/${proj.id}/editar`);
    const sala = page.getByLabel('Sala');
    await expect(sala).toHaveValue(other.id);
    await sala.selectOption({ label: tag });
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.getByText('Projeto salvo. Os pais da sala nova foram avisados.')).toBeVisible();
    await expect(page.getByRole('heading', { name: moving })).toBeVisible();
    expect(await parentSees()).toBe(1);
  } finally {
    await api.delete(rest(`kids_rooms?id=eq.${other.id}`), { headers: as['adm-a'].headers });
  }
});
