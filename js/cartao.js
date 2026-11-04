// Cartão de aniversário: a imagem escolhida pelo administrador da instituição de ensino com o título e a mensagem
// escritos por cima. O mesmo desenho serve para a prévia no app (canvas do navegador) e para o
// envio do dia (scripts/enviar-aniversarios.mjs, com @napi-rs/canvas): o que o administrador vê
// na prévia é o que chega no e-mail, na notificação do celular e na central do app.
// Sem nada do navegador aqui (nem document, nem window): roda também no Node.
// (Da skill mensagem-aniversario; veio do Igreja Conecta.)

export const CARD_WIDTH = 1080;
// Cores prontas para o texto (a liderança também escolhe qualquer outra).
export const CARD_SWATCHES = {
  '#ffffff': 'Branco',
  '#1b1e27': 'Preto',
  '#d4af37': 'Dourado',
  '#1e3a8a': 'Azul-marinho',
  '#7f1d1d': 'Vinho',
  '#db2777': 'Rosa',
  '#166534': 'Verde',
};
// Cartões salvos antes da cor livre ("Texto branco" / "Texto escuro").
const LEGACY_COLORS = { claro: '#ffffff', escuro: '#1b1e27' };

// Letras do cartão: arquivos em fonts/cartao/ (licença SIL Open Font License, ver LICENCAS.md
// lá), carregados pelo app (FontFace) e pelo envio do dia (GlobalFonts), com o mesmo nome de
// família: a prévia e o cartão enviado saem com a mesma letra. "padrao" usa as letras do sistema.
// Sem o negrito (700), o título usa o arquivo normal.
export const CARD_FONT_DIR = 'fonts/cartao/';
export const CARD_FONTS = {
  padrao: { label: 'Padrão' },
  montserrat: { label: 'Montserrat (moderna)', family: 'Cartao Montserrat', files: { 400: 'Montserrat-400Regular.ttf', 700: 'Montserrat-700Bold.ttf' } },
  lora: { label: 'Lora (clássica)', family: 'Cartao Lora', files: { 400: 'Lora-400Regular.ttf', 700: 'Lora-700Bold.ttf' } },
  playfair: { label: 'Playfair (elegante)', family: 'Cartao Playfair', files: { 400: 'PlayfairDisplay-400Regular.ttf', 700: 'PlayfairDisplay-700Bold.ttf' } },
  dancing: { label: 'Dancing Script (manuscrita)', family: 'Cartao Dancing', files: { 400: 'DancingScript-400Regular.ttf', 700: 'DancingScript-700Bold.ttf' } },
  caveat: { label: 'Caveat (escrita à mão)', family: 'Cartao Caveat', files: { 400: 'Caveat-400Regular.ttf', 700: 'Caveat-700Bold.ttf' } },
  greatvibes: { label: 'Great Vibes (caligrafia)', family: 'Cartao GreatVibes', files: { 400: 'GreatVibes-400Regular.ttf' } },
  pacifico: { label: 'Pacifico (divertida)', family: 'Cartao Pacifico', files: { 400: 'Pacifico-400Regular.ttf' } },
};
// Onde fica o texto, em % da imagem: x e y são o centro da área do texto; width é a largura da
// área; size é o tamanho das letras (100 = normal). A liderança ajusta arrastando na prévia.
export const CARD_DEFAULTS = { x: 50, y: 50, width: 84, size: 100 };
export const CARD_LIMITS = { width: [30, 100], size: [40, 250] };
// Cartões salvos antes do ajuste livre (só "em cima", "no meio", "embaixo").
export const POSITION_Y = { topo: 25, meio: 50, base: 75 };

// Letras do sistema (como no app) e, no servidor, as do Linux; emojis coloridos no fim.
const FONT =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "DejaVu Sans", sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji"';

// Família e pesos (título, mensagem) da letra escolhida; letra desconhecida vira a padrão.
export function cardFont(key) {
  const f = CARD_FONTS[key];
  if (!f?.family) return { family: FONT, title: 700, body: 400 };
  return { family: `"${f.family}", ${FONT}`, title: f.files[700] ? 700 : 400, body: 400 };
}

// Cor do texto: "#rrggbb" (ou "claro"/"escuro" dos cartões antigos). Inválida vira branco.
export function cardColor(value) {
  const v = LEGACY_COLORS[value] || String(value || '').toLowerCase();
  return /^#[0-9a-f]{6}$/.test(v) ? v : '#ffffff';
}

// Texto claro ganha sombra escura, e texto escuro, sombra clara: lê bem em cima de qualquer foto.
function isLight(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
const num = (v, fallback) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

// Altura do cartão: a da imagem, na largura fixa. Imagem muito comprida ou muito achatada é cortada
// no meio (como "cobrir"), para o texto sempre caber e o e-mail não ficar enorme.
export function cardSize(imgWidth, imgHeight) {
  const ratio = imgWidth > 0 && imgHeight > 0 ? imgHeight / imgWidth : 1;
  const height = Math.round(CARD_WIDTH * Math.min(1.5, Math.max(0.5, ratio)));
  return { width: CARD_WIDTH, height };
}

// Junta as opções salvas (card_x, card_y, card_width, card_size, ou o card_position antigo) com o padrão.
export function cardOptions({ x, y, width, size, position } = {}) {
  return {
    x: clamp(num(x, CARD_DEFAULTS.x), 0, 100),
    y: clamp(num(y, POSITION_Y[position] ?? CARD_DEFAULTS.y), 0, 100),
    width: clamp(num(width, CARD_DEFAULTS.width), ...CARD_LIMITS.width),
    size: clamp(num(size, CARD_DEFAULTS.size), ...CARD_LIMITS.size),
  };
}

// Quebra o texto em linhas que cabem na largura (respeita as quebras de linha da mensagem).
function wrap(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width <= maxWidth || !line) line = test;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  // Tira linhas vazias do começo e do fim (mantém as do meio, que separam parágrafos).
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines;
}

// Desenha o cartão inteiro em ctx (do tamanho de cardSize). img: imagem já carregada.
// title e body já vêm com os campos trocados ({nome}, {idade}...).
// guide: desenha o contorno da área do texto (só na prévia, para arrastar).
// Devolve a área do texto { left, top, width, height }, em pontos do cartão.
export function drawCard(ctx, img, { title, body, color = '#ffffff', font = 'padrao', guide = false, ...place }, width, height) {
  const opt = cardOptions(place);
  const face = cardFont(font);
  const fill = cardColor(color);

  // Fundo: a imagem cobrindo o cartão, cortada no meio se a proporção não bater.
  const iw = img.naturalWidth || img.width || width;
  const ih = img.naturalHeight || img.height || height;
  const scale = Math.max(width / iw, height / ih);
  const sw = width / scale;
  const sh = height / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, 0, 0, width, height);

  const boxWidth = Math.round((width * opt.width) / 100);
  const maxWidth = boxWidth * 0.94; // um respiro dos lados dentro da área
  const maxHeight = height * 0.94;

  // Diminui as letras até o texto caber no cartão.
  let k = opt.size / 100;
  let layout;
  for (let i = 0; i < 16; i++) {
    const titleSize = Math.max(8, Math.round(width * 0.072 * k));
    const bodySize = Math.max(6, Math.round(width * 0.046 * k));
    ctx.font = `${face.title} ${titleSize}px ${face.family}`;
    const titleLines = wrap(ctx, title, maxWidth);
    ctx.font = `${face.body} ${bodySize}px ${face.family}`;
    const bodyLines = wrap(ctx, body, maxWidth);
    const titleLead = titleSize * 1.18;
    const bodyLead = bodySize * 1.4;
    const gap = titleLines.length && bodyLines.length ? bodySize * 0.9 : 0;
    const total = titleLines.length * titleLead + gap + bodyLines.length * bodyLead;
    layout = { titleSize, bodySize, titleLines, bodyLines, titleLead, bodyLead, gap, total };
    if (total <= maxHeight) break;
    k *= 0.88;
  }
  const { titleSize, bodySize, titleLines, bodyLines, titleLead, bodyLead, gap, total } = layout;

  // A área do texto fica com o centro em (x, y), sem sair da imagem.
  const left = clamp((width * opt.x) / 100 - boxWidth / 2, 0, width - boxWidth);
  const top = clamp((height * opt.y) / 100 - total / 2, 0, Math.max(0, height - total));
  const cx = left + boxWidth / 2;

  const light = isLight(fill);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = fill;
  // Sombra suave em volta das letras: lê bem em cima de foto clara ou escura.
  ctx.shadowColor = light ? 'rgba(0, 0, 0, 0.65)' : 'rgba(255, 255, 255, 0.8)';
  ctx.shadowBlur = Math.round(width * 0.014);
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = Math.round(width * 0.002);

  let y = top;
  ctx.font = `${face.title} ${titleSize}px ${face.family}`;
  for (const line of titleLines) {
    ctx.fillText(line, cx, y);
    y += titleLead;
  }
  y += gap;
  ctx.font = `${face.body} ${bodySize}px ${face.family}`;
  for (const line of bodyLines) {
    ctx.fillText(line, cx, y);
    y += bodyLead;
  }
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  const box = { left, top, width: boxWidth, height: total };
  if (guide && ctx.setLineDash) {
    ctx.save();
    ctx.lineWidth = Math.max(2, Math.round(width * 0.003));
    ctx.setLineDash([ctx.lineWidth * 5, ctx.lineWidth * 4]);
    for (const [stroke, offset] of [['rgba(0, 0, 0, 0.55)', 0], ['rgba(255, 255, 255, 0.95)', ctx.lineWidth * 4.5]]) {
      ctx.strokeStyle = stroke;
      ctx.lineDashOffset = offset;
      ctx.strokeRect(left + 1, top - 8, boxWidth - 2, total + 16);
    }
    ctx.restore();
  }
  return box;
}
