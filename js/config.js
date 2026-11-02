// Dados do projeto Supabase (Project Settings > API Keys).
// A chave "publishable"/"anon" é pública por natureza: a segurança vem das regras RLS (supabase/001_base.sql).
export const CONFIG = {
  SUPABASE_URL: 'https://gtwavjxnzrggegtsajyu.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_L5M8NltxPFmPN_q-BRF96w_Z0AD3r6X',
  APP_NAME: 'CC4',
  // Chave pública das notificações (a privada fica só no segredo VAPID_PRIVATE_KEY do GitHub).
  VAPID_PUBLIC_KEY: 'BJShYv6bENLmIv5Djm9bRmvn_HN5zcuGBC-x9FCIZMa9fNp1_qBeHGZZIa_yGa7teqMd3Du2xDtIPFcs00rNgZw',
};
