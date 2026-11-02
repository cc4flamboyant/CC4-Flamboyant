// Pix "copia e cola" (BR Code estático, padrão EMV do Banco Central).
// Gerado no aparelho: o dinheiro vai direto de quem oferta para a conta da igreja.
// O app não recebe, não processa e não registra nenhum pagamento.

export const PIX_TYPES = {
  celular: 'Celular',
  cpf: 'CPF ou CNPJ',
  email: 'E-mail',
  aleatoria: 'Chave aleatória',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function guessPixType(key) {
  if (!key) return 'celular';
  if (key.startsWith('+')) return 'celular';
  if (key.includes('@')) return 'email';
  if (UUID.test(key)) return 'aleatoria';
  return 'cpf';
}

// Devolve a chave no formato que o Pix espera, ou null se for inválida.
export function normalizePixKey(type, raw) {
  const v = String(raw ?? '').trim();
  const digits = v.replace(/\D/g, '');
  switch (type) {
    case 'celular': {
      const d = digits.length === 12 || digits.length === 13 ? digits.replace(/^55/, '') : digits;
      return /^\d{10,11}$/.test(d) ? `+55${d}` : null;
    }
    case 'cpf':
      return digits.length === 11 || digits.length === 14 ? digits : null;
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 77 ? v.toLowerCase() : null;
    case 'aleatoria':
      return UUID.test(v) ? v.toLowerCase() : null;
    default:
      return null;
  }
}

// Valor digitado ("50", "50,00", "1.234,56", "R$ 10") em número; null se inválido.
export function parseAmount(raw) {
  const v = String(raw ?? '').replace(/R\$|\s/g, '');
  if (!v) return 0;
  if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(v)) return null;
  // Vírgula é o decimal; sem vírgula, "1.234" é milhar e "10.5" é decimal.
  const thousands = v.includes(',') || /^\d{1,3}(\.\d{3})+$/.test(v);
  const n = Number(thousands ? v.replace(/\./g, '').replace(',', '.') : v);
  return n > 0 && n < 1e9 ? Math.round(n * 100) / 100 : null;
}

export function formatPixKey(key) {
  const type = guessPixType(key);
  if (type === 'celular') {
    const m = key.match(/^\+55(\d{2})(\d{4,5})(\d{4})$/);
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : key;
  }
  return key;
}

// Nome e cidade no BR Code: sem acentos, só caracteres simples.
const ascii = (s, max) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 .,-]/g, '')
    .trim()
    .slice(0, max);

const field = (id, value) => id + String(value.length).padStart(2, '0') + value;

export function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    crc &= 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function pixPayload({ key, name, city = 'BRASILIA', amount, txid = '***' }) {
  let p =
    field('00', '01') +
    field('26', field('00', 'br.gov.bcb.pix') + field('01', key)) +
    field('52', '0000') +
    field('53', '986') +
    (amount > 0 ? field('54', Number(amount).toFixed(2)) : '') +
    field('58', 'BR') +
    field('59', ascii(name, 25) || 'IGREJA') +
    field('60', ascii(city, 15) || 'BRASILIA') +
    field('62', field('05', txid)) +
    '6304';
  return p + crc16(p);
}

let qrLib;
function loadQrLib() {
  qrLib ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
    s.onload = () => resolve(window.qrcode);
    s.onerror = () => reject(new Error('Não foi possível gerar o QR Code.'));
    document.head.appendChild(s);
  });
  return qrLib;
}

// QR como imagem (para desenhar em canvas, ex.: cartaz para WhatsApp).
export async function qrImage(text, cellSize = 12) {
  const qrcode = await loadQrLib();
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const img = new Image();
  img.src = qr.createDataURL(cellSize, cellSize * 2);
  await img.decode();
  return img;
}

export async function qrSvg(text) {
  const qrcode = await loadQrLib();
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
}
