// Filtros das notificações numa linha só (Android, celular pequeno).
import { test, expect } from '@playwright/test';
import { configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test('os filtros ficam numa linha só, deslizam para o lado e mostram só os grupos com notificação', async ({ page, playwright }) => {
  test.skip(!configured || !testPassword(), 'Sem as contas de teste');
  const api = await playwright.request.newContext();
  const lider = await loginAs(api, 'lider-a');
  await api.dispose();
  await page.setViewportSize({ width: 360, height: 760 });
  // Uma notificação de cada grupo (a central de verdade depende do que os outros testes criaram).
  const now = Date.now();
  const rows = ['aviso', 'evento', 'sala', 'galeria', 'aniversario'].map((kind, i) => ({
    id: i + 1, kind, title: `Notificação ${kind}`, body: 'Texto', url: '#/', read_at: null, created_at: new Date(now - (i + 1) * 60e3).toISOString(),
  }));
  await page.route('**/rest/v1/notifications?*', (route) => {
    if (route.request().method() !== 'GET') return route.fulfill({ status: 204 });
    const kinds = new URL(route.request().url()).searchParams.get('kind')?.match(/in\.\((.*)\)/)?.[1].split(',');
    return route.fulfill({ json: kinds ? rows.filter((r) => kinds.includes(r.kind)) : rows });
  });
  await openLoggedIn(page, lider.session, '/i/teste-a/#/notificacoes');
  const nav = page.getByRole('navigation', { name: 'Filtrar notificações' });
  await expect(nav.getByRole('link', { name: 'Todas' })).toHaveAttribute('aria-current', 'page');
  // Uma linha: a faixa tem a altura de uma pílula, e o que não cabe fica para o lado.
  const box = await nav.boundingBox();
  expect(box.height).toBeLessThan(60);
  expect(await nav.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // Só os grupos que têm notificação aparecem; tocar num filtro mostra só aquele grupo.
  const links = nav.getByRole('link');
  expect(await links.count()).toBeGreaterThan(1);
  const group = links.nth(1);
  await group.click();
  await expect(group).toHaveAttribute('aria-current', 'page');
});
