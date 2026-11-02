// Galeria de fotos nas telas, com contas da igreja Teste A (Android).
// O que o teste cria leva uma marca no nome e é apagado no fim (fotos e álbum).
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const title = `Álbum UI ${Date.now().toString(36)}`;

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['lider-a', 'membro-a']) as[u] = await loginAs(api, u);
});

const album = async () =>
  (await (await api.get(rest(`gallery_albums?select=id,gallery_photos!gallery_photos_album_id_fkey(id,path,mini_path)&title=eq.${encodeURIComponent(title)}`), { headers: as['lider-a'].headers })).json())[0];

test.afterAll(async () => {
  if (!api) return;
  const a = await album().catch(() => null);
  if (a) {
    const prefixes = a.gallery_photos.flatMap((p) => [p.path, p.mini_path]);
    if (prefixes.length) await api.delete(`${SUPABASE_URL}/storage/v1/object/galeria`, { headers: as['lider-a'].headers, data: { prefixes } });
    await api.delete(rest(`gallery_albums?id=eq.${a.id}`), { headers: as['lider-a'].headers });
  }
  await api.dispose();
});

test('a liderança cria o álbum e envia fotos, reduzidas no aparelho', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/menu');
  // Duas imagens de verdade (capturas da tela), com tamanhos diferentes.
  await page.setViewportSize({ width: 1200, height: 900 });
  const shot1 = await page.screenshot();
  await page.setViewportSize({ width: 412, height: 915 });
  const shot2 = await page.screenshot({ fullPage: true });
  await page.getByRole('link', { name: 'Galeria de fotos' }).click();
  // Quem publica cria pelo botão redondo "+".
  await expect(page.locator('.fab')).toHaveAttribute('href', '#/galeria/novo');
  await page.getByRole('link', { name: 'Novo álbum' }).click();
  await page.getByLabel('Título').fill(title);
  await page.getByRole('button', { name: 'Criar álbum' }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.locator('#add-photos').setInputFiles([
    { name: 'culto-1.png', mimeType: 'image/png', buffer: shot1 },
    { name: 'culto-2.png', mimeType: 'image/png', buffer: shot2 },
  ]);
  await expect(page.getByText('2 fotos enviadas.')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.photo-thumb img')).toHaveCount(2);
  // Cada arquivo guardado é leve (o banco recusa acima de 400 KB).
  const a = await album();
  expect(a.gallery_photos).toHaveLength(2);
  for (const p of a.gallery_photos) {
    const res = await api.get(`${SUPABASE_URL}/storage/v1/object/authenticated/galeria/${p.path}`, { headers: as['lider-a'].headers });
    expect(res.ok()).toBe(true);
    expect((await res.body()).length).toBeLessThanOrEqual(300 * 1024);
    const mini = await api.get(`${SUPABASE_URL}/storage/v1/object/authenticated/galeria/${p.mini_path}`, { headers: as['lider-a'].headers });
    expect((await mini.body()).length).toBeLessThan(60 * 1024);
  }
});

test('o membro vê as fotos em tela cheia e pede para tirar uma', async ({ page }) => {
  const a = await album();
  await openLoggedIn(page, as['membro-a'].session, `/i/teste-a/#/galeria/${a.id}`);
  await expect(page.locator('.photo-thumb img')).toHaveCount(2);
  await expect(page.locator('#add-photos')).toHaveCount(0); // só quem publica envia
  await page.locator('.photo-thumb').first().click();
  const img = page.locator('.photo-stage img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  await page.getByRole('link', { name: 'Próxima foto' }).click();
  await expect(page.getByText('2 de 2')).toBeVisible();
  await page.getByRole('button', { name: 'Pedir para tirar esta foto' }).click();
  await answer(page, 'Apareço nela');
  await expect(page.getByText('Pedido enviado. Obrigado por avisar.')).toBeVisible();
  await page.getByRole('button', { name: 'Pedir para tirar esta foto' }).click();
  await answer(page, '');
  await expect(page.getByText('Você já pediu para tirar esta foto.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apagar foto' })).toHaveCount(0);
});

test('a liderança recebe o pedido e apaga a foto', async ({ page }) => {
  const a = await album();
  const notes = await (
    await api.get(rest(`notifications?select=url,body&title=eq.${encodeURIComponent('Pedido para tirar uma foto')}&body=like.*${encodeURIComponent(title)}*`), {
      headers: as['lider-a'].headers,
    })
  ).json();
  expect(notes).toHaveLength(1);
  expect(notes[0].body).toContain('Apareço nela');
  await openLoggedIn(page, as['lider-a'].session, `/i/teste-a/${notes[0].url}`);
  await expect(page.getByText('2 de 2')).toBeVisible();
  await page.getByRole('button', { name: 'Usar como capa' }).click();
  await expect(page.getByText('Capa do álbum trocada.')).toBeVisible();
  await page.getByRole('button', { name: 'Apagar foto' }).click();
  await answer(page);
  await expect(page.getByText('Foto apagada.')).toBeVisible();
  await expect(page.getByText('1 de 1')).toBeVisible();
  expect((await album()).gallery_photos).toHaveLength(1);
  expect(a.gallery_photos).toHaveLength(2);
});

test('a Galeria abre na hora, com as capas, mesmo com o banco demorando', async ({ page }) => {
  const prefetched = page.waitForResponse(/rpc\/gallery_album_list/);
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await prefetched;
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Galeria de fotos' }).click();
  const card = page.locator('.album-card', { hasText: title });
  await expect(card).toContainText('1 foto', { timeout: 1000 });
  await expect(card.locator('img')).toBeVisible({ timeout: 1000 });
  // O membro não publica: sem o botão "+".
  await expect(page.locator('.fab')).toHaveCount(0);
});
