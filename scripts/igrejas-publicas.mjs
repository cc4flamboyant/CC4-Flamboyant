// Igrejas que ganham pasta própria em i/<slug>/ (ativas e que não são de teste), com tudo
// o que a pasta usa. Mudou alguma coisa aqui, a pasta precisa ser gerada de novo.
import { readFileSync } from 'node:fs';

const config = readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
const pick = (key) => config.match(new RegExp(`${key}:\\s*'([^']+)'`))?.[1];
export const SUPABASE_URL = pick('SUPABASE_URL');
export const SUPABASE_ANON_KEY = pick('SUPABASE_ANON_KEY');
export const supabaseConfigured = !!SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes('COLE-AQUI');

export async function fetchPublicChurches() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/churches?select=id,slug,name,short_name,primary_color,welcome_text,logo_url,branding_version&active=eq.true&is_test=eq.false&order=slug`,
    { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } },
  );
  if (!res.ok) throw new Error(`Falha ao ler as igrejas do Supabase: ${res.status} ${await res.text()}`);
  return res.json();
}
