// Roda a cada 10 minutos no GitHub Actions (deploy.yml): compara as igrejas publicadas no site
// (igrejas.json, gerado por build-site.mjs) com as do banco. Se um administrador trocou nome,
// ícone ou cor, ou se apareceu uma igreja nova, responde changed=true e o site é publicado de novo.
import { appendFileSync } from 'node:fs';
import { fetchPublicChurches } from './igrejas-publicas.mjs';

const SITE_URL = (process.env.SITE_URL || 'https://DONO.github.io/REPOSITORIO').replace(/\/$/, '');

function answer(changed, why) {
  console.log(why);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

let current;
try {
  current = await fetchPublicChurches();
} catch (err) {
  // Sem o banco não dá para gerar as pastas; tenta de novo na próxima rodada.
  answer(false, err.message);
  process.exit(0);
}

const res = await fetch(`${SITE_URL}/igrejas.json?t=${Date.now()}`, { cache: 'no-store' });
const published = res.ok ? await res.json() : null;
if (JSON.stringify(published) === JSON.stringify(current)) answer(false, 'Nenhuma igreja mudou.');
else answer(true, 'Igrejas mudaram: publicando o site de novo.');
