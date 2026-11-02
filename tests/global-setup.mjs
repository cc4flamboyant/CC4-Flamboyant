// Antes de tudo: entra uma vez com cada conta de teste e guarda as sessões (tests/sessoes.local,
// fora do Git). Os testes usam essas sessões em vez de entrar de novo a cada arquivo: assim a
// rodada inteira faz 5 logins, e o Supabase não recusa por excesso de pedidos (erro 429).
import { request } from '@playwright/test';
import { writeFileSync, rmSync } from 'node:fs';
import { configured, testPassword, freshLogin, SESSIONS_FILE } from './helpers.mjs';

export default async function globalSetup() {
  rmSync(SESSIONS_FILE, { force: true });
  if (!configured || !testPassword()) return;
  const api = await request.newContext();
  const sessions = {};
  try {
    for (const u of ['adm-a', 'lider-a', 'membro-a', 'adm-b', 'sem-igreja']) {
      sessions[u] = await freshLogin(api, u).catch(() => null);
    }
  } finally {
    await api.dispose();
  }
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
}
