// Servidor estático para os testes, com o mesmo comportamento do GitHub Pages:
// caminho terminado em "/" serve index.html e arquivo inexistente serve 404.html com status 404.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

// SITE_DIR=_site: serve a pasta publicada (código num arquivo só), como no GitHub Pages.
const root = resolve(process.env.SITE_DIR || '.');
const port = Number(process.argv[2] || 4173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

// Só nos testes: POST /__teste/sw-versao "publica" uma versão nova do app (o sw.js passa a vir
// diferente), para testar a atualização sozinha do app aberto.
let swVersion = 0;

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (req.method === 'POST' && path === '/__teste/sw-versao') {
    swVersion++;
    res.writeHead(204).end();
    return;
  }
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  if (!file.startsWith(root + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(301, { Location: `${path}/` }).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    const body = await readFile(file);
    res.end(swVersion && path.endsWith('/sw.js') ? Buffer.concat([body, Buffer.from(`\n// versão de teste ${swVersion}\n`)]) : body);
  } catch {
    res.writeHead(404, { 'Content-Type': TYPES['.html'] });
    res.end(await readFile(join(root, '404.html')));
  }
}).listen(port, () => console.log(`Servindo ${root} em http://localhost:${port}/`));
