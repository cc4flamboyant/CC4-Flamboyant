// Imagens reduzidas no aparelho antes do envio, e os ícones do app gerados a partir da logo.

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Não foi possível abrir esta imagem. Tente uma foto em JPG ou PNG.'));
    img.src = URL.createObjectURL(file);
  });
}

const encode = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// WebP quando o navegador sabe gerar; senão (Safari antigo), JPG.
export async function resizeImage(file, max = 1080, quality = 0.8) {
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  const webp = await encode(canvas, 'image/webp', quality);
  return webp && webp.type === 'image/webp' ? webp : encode(canvas, 'image/jpeg', quality);
}

// Logo com transparência continua PNG (a WebP do Safari antigo viraria JPG com fundo preto).
export async function resizeLogo(file, max = 512) {
  const img = await loadImage(file);
  const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  const webp = await encode(canvas, 'image/webp', 0.9);
  return webp && webp.type === 'image/webp' ? webp : encode(canvas, 'image/png');
}

// Ícone quadrado: fundo da cor escolhida e a logo centralizada ocupando "fill" do lado.
async function square(img, size, background, fill) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);
  const box = size * fill;
  const scale = Math.min(box / img.naturalWidth, box / img.naturalHeight);
  const w = img.naturalWidth * scale;
  const h = img.naturalHeight * scale;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
  return encode(canvas, 'image/png');
}

// Os quatro arquivos que a publicação do site copia para i/<igreja>/.
// O do iPhone (180x180) não pode ter transparência: o fundo é sempre pintado.
export async function makeIconSet(file, background) {
  const img = await loadImage(file);
  try {
    const icons = {
      'icon-192.png': await square(img, 192, background, 0.84),
      'icon-512.png': await square(img, 512, background, 0.84),
      'icon-maskable-512.png': await square(img, 512, background, 0.6),
      'apple-touch-icon.png': await square(img, 180, background, 0.76),
    };
    const badge = await notificationBadge(img);
    if (badge) icons['badge-96.png'] = badge;
    return icons;
  } finally {
    URL.revokeObjectURL(img.src);
  }
}

// Ícone pequeno da barra de notificações (ao lado do relógio, no Android): o sistema usa só o
// contorno, de uma cor. Vem da logo, com o desenho em branco e o fundo vazio:
// - logo com fundo transparente: o que é transparente fica vazio;
// - logo com fundo de uma cor (ex.: desenho dourado em fundo branco): a cor dos cantos é o fundo.
// Se não der um desenho reconhecível (ex.: uma foto), fica o ícone padrão (null).
async function notificationBadge(img) {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const box = size * 0.86;
  const scale = Math.min(box / img.naturalWidth, box / img.naturalHeight);
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const x0 = Math.round((size - w) / 2);
  const y0 = Math.round((size - h) / 2);
  ctx.drawImage(img, x0, y0, w, h);
  const data = ctx.getImageData(0, 0, size, size);
  const px = data.data;
  const at = (x, y) => (y * size + x) * 4;
  const corners = [at(x0, y0), at(x0 + w - 1, y0), at(x0, y0 + h - 1), at(x0 + w - 1, y0 + h - 1)];
  const transparent = corners.some((i) => px[i + 3] < 96);
  // Fundo de uma cor: a média dos quatro cantos (que precisam ser parecidos entre si).
  const bg = [0, 1, 2].map((k) => corners.reduce((s, i) => s + px[i + k], 0) / 4);
  const uniform = corners.every((i) => Math.hypot(px[i] - bg[0], px[i + 1] - bg[1], px[i + 2] - bg[2]) < 40);
  if (!transparent && !uniform) return null;
  // A cor que mais aparece também é fundo (ex.: logo num quadrado branco sobre fundo preto).
  let main = null;
  if (!transparent) {
    const bins = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const key = ((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4);
      const b = bins.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      b.n++;
      b.r += px[i];
      b.g += px[i + 1];
      b.b += px[i + 2];
      bins.set(key, b);
    }
    const top = [...bins.values()].sort((a, b) => b.n - a.n)[0];
    if (top.n > size * size * 0.3) main = [top.r / top.n, top.g / top.n, top.b / top.n];
  }
  const near = (i, c) => Math.hypot(px[i] - c[0], px[i + 1] - c[1], px[i + 2] - c[2]) < 70;
  // Quadrado de outra cor sobre o fundo dos cantos: a borda entre os dois (mistura das cores)
  // encosta no fundo dos cantos; o desenho da logo, que fica dentro do quadrado, não.
  const twoBackgrounds = main && Math.hypot(main[0] - bg[0], main[1] - bg[1], main[2] - bg[2]) > 70;
  const touchesCorner = (i) => {
    const p = i / 4;
    const x = p % size;
    const y = (p - x) / size;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < size && ny < size && near(at(nx, ny), bg)) return true;
      }
    }
    return false;
  };
  const isBackground = (i) =>
    px[i + 3] < 96 || (!transparent && (near(i, bg) || (main && near(i, main)) || (twoBackgrounds && touchesCorner(i))));
  // Primeiro decide (lendo as cores originais), depois pinta.
  const on = new Uint8Array(size * size);
  let drawn = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (!isBackground(i)) {
      on[i / 4] = 1;
      drawn++;
    }
  }
  for (let i = 0; i < px.length; i += 4) {
    px[i] = px[i + 1] = px[i + 2] = 255;
    px[i + 3] = on[i / 4] ? 255 : 0;
  }
  // Quase nada desenhado, ou quase tudo (foto, fundo de várias cores): fica o padrão.
  if (drawn < w * h * 0.02 || drawn > w * h * 0.85) return null;
  ctx.putImageData(data, 0, 0);
  return encode(canvas, 'image/png');
}

// Galeria: foto grande leve (até ~300 KB; o banco recusa acima de 400 KB) e miniatura para a grade.
// Se a foto ficar pesada, reduz o tamanho e a qualidade até caber.
export async function resizeForGallery(file) {
  let big;
  for (const [max, quality] of [[1600, 0.72], [1280, 0.65], [1024, 0.6], [800, 0.55]]) {
    big = await resizeImage(file, max, quality);
    if (big.size <= 300 * 1024) break;
  }
  const mini = await resizeImage(file, 360, 0.6);
  return { big, mini, ext: big.type === 'image/webp' ? 'webp' : 'jpg' };
}
