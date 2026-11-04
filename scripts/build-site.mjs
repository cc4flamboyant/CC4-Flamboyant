// Monta a pasta _site para o GitHub Pages e gera uma pasta por igreja em i/<slug>/,
// com manifest, ícones e título próprios: assim o app instalado na tela inicial
// aparece com o nome e a logo da igreja.
// O código do app vai num arquivo só e compactado (com o cliente do Supabase dentro): o celular
// baixa um arquivo do próprio site em vez de 15, de dois servidores, um pedindo o outro.
// Uso: SITE_URL=https://usuario.github.io/repositorio/ node scripts/build-site.mjs
//      node scripts/build-site.mjs --sem-igrejas   (só o app, para os testes)
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { SUPABASE_URL, SUPABASE_ANON_KEY, supabaseConfigured, fetchPublicChurches } from './igrejas-publicas.mjs';
import { inkOn, churchRestUrl } from '../js/util.js';

const OUT = '_site';
const STATIC = ['index.html', '404.html', 'privacidade.html', 'termos.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons', 'fonts'];
const ICONS = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'badge-96.png'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const p of STATIC) cpSync(p, `${OUT}/${p}`, { recursive: true });
writeFileSync(`${OUT}/.nojekyll`, '');

// O service worker guarda os arquivos do app no aparelho por versão. Um código tirado do conteúdo
// deles entra no nome do cache: mudou o código, os celulares baixam a versão nova sozinhos.
const appFiles = ['index.html', 'manifest.webmanifest', 'sw.js', 'css/style.css', ...readdirSync('js').map((f) => `js/${f}`)];
const hash = createHash('sha256');
for (const f of appFiles) hash.update(readFileSync(f));
const sw = readFileSync(`${OUT}/sw.js`, 'utf8');
const stamped = sw.replace(/const CACHE = '([^']+)';/, (_, name) => `const CACHE = '${name}-${hash.digest('hex').slice(0, 10)}';`);
if (stamped === sw) throw new Error('sw.js sem a linha "const CACHE = ...".');

// Código do app num arquivo só. No código-fonte o cliente do Supabase vem do jsDelivr (o app roda
// sem build); aqui entra o pacote do npm da mesma versão.
const SUPABASE_CDN = /^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@([\d.]+)\/\+esm$/;
const supabaseVersion = createRequire(import.meta.url)('@supabase/supabase-js/package.json').version;
const { metafile } = await build({
  entryPoints: ['js/app.js'],
  outfile: `${OUT}/js/app.js`,
  allowOverwrite: true,
  bundle: true,
  minify: true,
  format: 'esm',
  sourcemap: true, // só o navegador com as ferramentas de desenvolvedor abertas baixa (para ler erros)
  metafile: true,
  logLevel: 'warning',
  plugins: [
    {
      name: 'supabase-do-npm',
      setup(b) {
        b.onResolve({ filter: SUPABASE_CDN }, async (args) => {
          const wanted = args.path.match(SUPABASE_CDN)[1];
          if (wanted !== supabaseVersion) {
            throw new Error(`js/app.js usa supabase-js@${wanted}, mas o package.json tem ${supabaseVersion}: deixe os dois iguais.`);
          }
          return b.resolve('@supabase/supabase-js', { kind: 'import-statement', resolveDir: process.cwd() });
        });
      },
    },
  ],
});
await build({ entryPoints: ['css/style.css'], outfile: `${OUT}/css/style.css`, allowOverwrite: true, minify: true, logLevel: 'warning' });
// Os módulos que entraram no arquivo único saem da lista do service worker e dos "modulepreload"
// da página (os arquivos continuam publicados, mas ninguém os baixa). tema.js fica (roda antes, fora do app).
const bundled = Object.keys(metafile.inputs).filter((f) => /^js\/[^/]+\.js$/.test(f) && f !== 'js/app.js');
let swOut = stamped;
for (const f of bundled) {
  swOut = swOut.replace(`  '${f}',\n`, '');
}
writeFileSync(`${OUT}/sw.js`, swOut);
const shell = readFileSync('index.html', 'utf8')
  .replace(/ *<link rel="modulepreload" href="[^"]+">\n/g, '')
  .replace(/ *<link rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net" crossorigin>\n/, ''); // o mapa só busca o Leaflet quando abre
writeFileSync(`${OUT}/index.html`, shell);
console.log(`js/app.js: ${bundled.length + 1} módulos e o supabase-js ${supabaseVersion} num arquivo só.`);

if (process.argv.includes('--sem-igrejas')) process.exit(0);
if (!supabaseConfigured) {
  console.log('Supabase ainda não configurado em js/config.js; pulando as pastas das igrejas.');
  process.exit(0);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

let churches;
try {
  churches = await fetchPublicChurches();
} catch (err) {
  console.error(err.message);
  process.exit(0); // publica o site mesmo assim (as igrejas abrem pelo 404.html, sem ícone próprio)
}
// O que foi publicado: scripts/igrejas-mudaram.mjs compara com o banco para saber se precisa publicar de novo.
writeFileSync(`${OUT}/igrejas.json`, JSON.stringify(churches));

for (const c of churches) {
  const dir = `${OUT}/i/${c.slug}`;
  mkdirSync(dir, { recursive: true });
  const v = c.branding_version;

  // Ícones gerados pelo admin em Configurar a igreja; sem eles, os padrão do app.
  let own = 0;
  for (const name of ICONS) {
    // ?v= passa por cima do cache do Storage, que ainda pode ter o ícone anterior.
    const r = await fetch(`${SUPABASE_URL}/storage/v1/object/public/igrejas/${c.id}/icons/${name}?v=${v}`);
    if (r.ok) {
      writeFileSync(`${dir}/${name}`, Buffer.from(await r.arrayBuffer()));
      own++;
    } else {
      cpSync(`icons/${name}`, `${dir}/${name}`);
    }
  }

  const short = c.short_name || c.name.slice(0, 20);
  writeFileSync(
    `${dir}/manifest.webmanifest`,
    JSON.stringify(
      {
        id: './', // relativo ao manifest: cada igreja é um app instalado separado
        name: c.name,
        short_name: short,
        description: c.welcome_text || `App da ${c.name}`,
        lang: 'pt-BR',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#f5f6fa',
        theme_color: c.primary_color,
        icons: [
          { src: `icon-192.png?v=${v}`, sizes: '192x192', type: 'image/png' },
          { src: `icon-512.png?v=${v}`, sizes: '512x512', type: 'image/png' },
          { src: `icon-maskable-512.png?v=${v}`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      null,
      2,
    ),
  );

  // Mesmo app da raiz; o <base> faz os arquivos (css, js) virem de lá.
  // icone-versao: o app compara com a igreja para não oferecer instalar com o ícone antigo (js/install.js).
  const page = shell
    .replace('<!-- igreja -->', `<base href="../../">\n  <meta name="icone-versao" content="${v}">`)
    // Os dados da igreja começam a vir junto com o HTML; o app usa esta resposta (loadChurch em js/app.js).
    .replace(
      '</head>',
      `  <link rel="preload" as="fetch" crossorigin href="${esc(churchRestUrl(SUPABASE_URL, SUPABASE_ANON_KEY, c.slug))}">\n</head>`,
    )
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(c.name)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*"/, `$1${esc(c.welcome_text || `App da ${c.name}`)}"`)
    .replace(/(<meta name="theme-color" content=")[^"]*"/, `$1${esc(c.primary_color)}"`)
    .replace('href="manifest.webmanifest"', `href="i/${c.slug}/manifest.webmanifest?v=${v}"`)
    .replace('href="icons/icon-192.png"', `href="i/${c.slug}/icon-192.png?v=${v}"`)
    .replace('href="icons/apple-touch-icon.png"', `href="i/${c.slug}/apple-touch-icon.png?v=${v}"`)
    .replace(/(<meta name="apple-mobile-web-app-title" content=")[^"]*"/, `$1${esc(short)}"`)
    // Logo, nome e cor da igreja já no HTML: o app abre sem mostrar antes o ícone azul padrão.
    .replace('id="brand-logo" src="icons/icon-192.png"', `id="brand-logo" src="${esc(c.logo_url || `i/${c.slug}/icon-192.png?v=${v}`)}"`)
    .replace('<span id="app-name">CC4</span>', `<span id="app-name">${esc(c.name)}</span>`)
    .replace('</head>', `  <style>:root { --brand: ${c.primary_color}; --brand-ink: ${inkOn(c.primary_color)}; }</style>\n</head>`);
  writeFileSync(`${dir}/index.html`, page);
  console.log(`i/${c.slug}/ ${own >= 4 ? 'com ícones da igreja' : 'com ícones padrão'}`);
}
console.log(`Geradas ${churches.length} pastas de igrejas.`);
