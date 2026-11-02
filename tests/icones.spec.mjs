// Ícones gerados da logo da igreja, no próprio navegador (Android).
import { test, expect } from '@playwright/test';

test('ícone da barra de notificações: o desenho da logo em branco, com o fundo vazio; foto fica com o padrão', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { makeIconSet } = await import('./js/images.js');
    // Logos de teste: círculo dourado em fundo transparente, o mesmo em fundo branco, e uma "foto"
    // (degradê que ocupa tudo).
    const draw = async (kind) => {
      const c = Object.assign(document.createElement('canvas'), { width: 200, height: 200 });
      const g = c.getContext('2d');
      if (kind === 'foto') {
        const grad = g.createLinearGradient(0, 0, 200, 200);
        grad.addColorStop(0, '#203040');
        grad.addColorStop(1, '#c08040');
        g.fillStyle = grad;
        g.fillRect(0, 0, 200, 200);
        return new Promise((r) => c.toBlob(r, 'image/png'));
      }
      if (kind === 'branco') {
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, 200, 200);
      }
      g.fillStyle = '#b8954a';
      g.beginPath();
      g.arc(100, 100, 60, 0, Math.PI * 2);
      g.fill();
      return new Promise((r) => c.toBlob(r, 'image/png'));
    };
    const pixels = async (blob) => {
      if (!blob) return null;
      const img = await createImageBitmap(blob);
      const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return { size: img.width, center: [...g.getImageData(48, 48, 1, 1).data], corner: [...g.getImageData(10, 10, 1, 1).data] };
    };
    const out = {};
    for (const kind of ['transparente', 'branco', 'foto']) out[kind] = await pixels((await makeIconSet(await draw(kind), '#ffffff'))['badge-96.png']);
    return out;
  });
  for (const kind of ['transparente', 'branco']) {
    expect(result[kind], kind).not.toBeNull();
    expect(result[kind].size).toBe(96);
    expect(result[kind].center, kind).toEqual([255, 255, 255, 255]); // o desenho vira branco
    expect(result[kind].corner[3], kind).toBe(0); // o fundo fica vazio
  }
  expect(result.foto).toBeNull();
});
