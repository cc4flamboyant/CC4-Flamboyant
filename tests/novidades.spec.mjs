// Logo do Início, pedidos de oração, salas (semana e ordem) e chat (grupo no Início e ordem),
// com contas da Teste A (Android). O que o teste cria leva uma marca no nome e é apagado no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const ids = {};
const tag = `Nov ${Date.now().toString(36)}`;
const returning = (h) => ({ ...h, Prefer: 'return=representation' });

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['adm-a', 'lider-a', 'membro-a']) as[u] = await loginAs(api, u);
  [{ id: ids.church }] = await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: as['adm-a'].headers })).json();
});

test.afterAll(async () => {
  if (!api) return;
  await api.delete(rest(`prayer_requests?body=like.*${encodeURIComponent(tag)}*`), { headers: as['adm-a'].headers });
  for (const r of [ids.r1, ids.r2].filter(Boolean)) await api.delete(rest(`kids_rooms?id=eq.${r}`), { headers: as['adm-a'].headers });
  for (const g of [ids.g1, ids.g2].filter(Boolean)) await api.delete(rest(`chat_groups?id=eq.${g}`), { headers: as['lider-a'].headers });
  await api.dispose();
});

// Arrasta o item pela alça até o lugar do outro.
async function dragOnto(page, grip, target) {
  const a = await grip.boundingBox();
  const b = await target.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, b.y + b.height / 2 + (b.y > a.y ? 10 : -10), { steps: 12 });
  await page.mouse.up();
}

test('Início: a logo grande abre em tela cheia, com Voltar', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await page.getByRole('button', { name: 'Ver a logo' }).click();
  const viewer = page.getByRole('dialog', { name: 'Igreja Teste A' });
  await expect(viewer.locator('#viewer-img')).toBeVisible();
  await viewer.getByRole('button', { name: 'Voltar' }).click();
  await expect(viewer).toHaveCount(0);
  // O atalho de Oração está no Início.
  await expect(page.locator('#home-shortcuts').getByRole('link', { name: 'Oração' })).toBeVisible();
});

test('oração: o membro pede para todos; a direção aprova; vai para o mural com "Vou orar"', async ({ page, browser }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/oracao');
  await expect(page.getByRole('heading', { name: 'Pedidos de oração' })).toBeVisible();
  await page.getByRole('link', { name: 'Fazer um pedido' }).click();
  await page.getByLabel('Seu pedido').fill(`${tag} pela prova de matemática`);
  await page.getByLabel(/Para todos orarem junto/).check();
  await page.getByLabel(/Não mostrar meu nome/).check();
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(page.getByText('Pedido enviado. Ele vai para o mural depois da aprovação.')).toBeVisible();
  const mine = page.locator('article.prayer', { hasText: tag });
  await expect(mine).toContainText('Aguardando aprovação');

  // A líder aprova na moderação.
  const leader = await (await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' })).newPage();
  await openLoggedIn(leader, as['lider-a'].session, '/i/teste-a/#/oracao/moderar');
  const card = leader.locator('article.prayer', { hasText: tag });
  await expect(card).toContainText('Anônimo para os membros');
  await card.getByRole('button', { name: 'Aprovar' }).click();
  await expect(leader.getByText('Pedido aprovado: já está no mural.')).toBeVisible();
  await leader.context().close();

  // No mural, com "Vou orar".
  await page.goto('/i/teste-a/#/oracao');
  const onWall = page.locator('article.prayer', { hasText: tag });
  await expect(onWall).toBeVisible();
  await onWall.getByRole('button', { name: /Vou orar/ }).click();
  await expect(onWall.getByRole('button', { name: /Estou orando · 1/ })).toBeVisible();
});

test('salas: a semana aparece no cartão; a liderança muda a ordem arrastando', async ({ page }) => {
  const room = async (name) =>
    (await (await api.post(rest('kids_rooms'), { headers: returning(as['adm-a'].headers), data: { church_id: ids.church, name } })).json())[0].id;
  ids.r1 = await room(`${tag} Alfa`.slice(0, 40));
  ids.r2 = await room(`${tag} Beta`.slice(0, 40));
  await openLoggedIn(page, as['lider-a'].session, `/i/teste-a/#/salas/${ids.r1}/editar`);
  await page.getByLabel('Semana').selectOption({ label: 'Semana 7' });
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Sala salva.')).toBeVisible();
  await page.goto('/i/teste-a/#/salas');
  const alfa = page.locator('.sort-row', { hasText: `${tag} Alfa` });
  const beta = page.locator('.sort-row', { hasText: `${tag} Beta` });
  await expect(alfa.locator('.week-tag')).toHaveText('Semana 7');
  // Beta para cima de Alfa.
  const order = () => page.locator('#rooms-list .sort-row').evaluateAll((rows, t) => rows.map((r) => r.textContent).filter((x) => x.includes(t)).map((x) => (x.includes('Alfa') ? 'Alfa' : 'Beta')), tag);
  const before = await order();
  await dragOnto(page, (before[0] === 'Alfa' ? beta : alfa).getByRole('button', { name: /Mudar a ordem/ }), before[0] === 'Alfa' ? alfa : beta);
  const after = await order();
  expect(after).toEqual([...before].reverse());
  // Ficou gravado: recarregando, a mesma ordem.
  await page.waitForResponse((r) => r.url().includes('rpc/rooms_reorder')).catch(() => {});
  await page.reload();
  await expect.poll(order).toEqual(after);
});

test('chat: o grupo vai para o Início pelo Editar grupo; a lista muda de ordem arrastando', async ({ page }) => {
  const [{ id: membro }] = await (await api.get(rest(`members?select=id&church_id=eq.${ids.church}&user_id=eq.${as['membro-a'].id}`), { headers: as['adm-a'].headers })).json();
  const group = async (name) =>
    (await api.post(rest('rpc/chat_create_group'), { headers: as['lider-a'].headers, data: { p_church: ids.church, p_name: name, p_description: null, p_locked: false, p_members: [membro] } })).json();
  ids.g1 = await group(`${tag} Um`);
  ids.g2 = await group(`${tag} Dois`);
  // A líder (administradora do grupo) liga "Mostrar no Início".
  await openLoggedIn(page, as['lider-a'].session, `/i/teste-a/#/chat/${ids.g1}/info`);
  await page.getByLabel(/Mostrar no Início/).check();
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Grupo salvo.')).toBeVisible();
  // O membro vê o atalho no Início e muda a ordem da própria lista.
  const ctx = await page.context().browser().newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' });
  const member = await ctx.newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/');
  const tile = member.locator('#home-shortcuts [data-chat-tile]', { hasText: `${tag} Um` });
  await expect(tile).toBeVisible();
  await tile.click();
  await expect(member.locator('#chat-name')).toHaveText(`${tag} Um`);
  await member.goto('/i/teste-a/#/chat');
  const names = () => member.locator('#chat-list .sort-row').evaluateAll((rows, t) => rows.map((r) => r.textContent).filter((x) => x.includes(t)).map((x) => (x.includes(`${t} Um`) ? 'Um' : 'Dois')), tag);
  await expect.poll(names).toHaveLength(2);
  const before = await names();
  const first = member.locator('#chat-list .sort-row', { hasText: `${tag} ${before[0]}` });
  const second = member.locator('#chat-list .sort-row', { hasText: `${tag} ${before[1]}` });
  await Promise.all([
    member.waitForResponse((r) => r.url().includes('rpc/chat_reorder')),
    dragOnto(member, second.getByRole('button', { name: /Mudar a ordem/ }), first),
  ]);
  const after = await names();
  expect(after).toEqual([...before].reverse());
  await member.reload();
  await expect.poll(names).toEqual(after);
  await ctx.close();
});
