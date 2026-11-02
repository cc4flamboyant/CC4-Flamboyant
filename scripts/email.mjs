// Envio de e-mail, usado pelos aniversários e pelas confirmações de inscrição.
// Sai por um Gmail (variável GMAIL_USER + segredo GMAIL_APP_PASSWORD) ou, com domínio próprio,
// pelo Resend (segredo RESEND_API_KEY + variável EMAIL_FROM). Sem nenhum dos dois, fica desligado.
import nodemailer from 'nodemailer';

const { RESEND_API_KEY, EMAIL_FROM, GMAIL_USER } = process.env;
// A senha de app do Google aparece em grupos de 4 letras; os espaços não fazem parte dela.
const GMAIL_APP_PASSWORD = (process.env.GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');

export const gmailOn = !!(GMAIL_USER && GMAIL_APP_PASSWORD);
export const emailOn = gmailOn || !!(RESEND_API_KEY && EMAIL_FROM);
export const gmailUser = GMAIL_USER;
const gmail = gmailOn
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } })
  : null;

// Gmail ou Resend. Devolve null se deu certo, ou o motivo da falha.
export async function deliverEmail({ fromName, to, subject, html, text }) {
  if (gmail) {
    try {
      await gmail.sendMail({ from: { name: fromName, address: GMAIL_USER }, to, subject, html, text });
      return null;
    } catch (err) {
      return `Gmail: ${err.responseCode ?? ''} ${err.message}`.slice(0, 200);
    }
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: `${fromName} <${EMAIL_FROM}>`, to: [to], subject, html, text }),
  });
  return res.ok ? null : `Resend ${res.status}: ${(await res.text()).slice(0, 200)}`;
}

export const closeEmail = () => gmail?.close();
