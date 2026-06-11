// Sessões persistidas no Upstash Redis — sobrevivem a reinicializações do servidor
const db = require('./db');
const logger = require('./logger');

async function getOrCreateSession(phone) {
  return await db.getOrCreateSession(phone);
}

async function addMessageToSession(phone, role, content) {
  const session = await db.getOrCreateSession(phone);
  session.messages.push({ role, content });

  // Mantém apenas as últimas 20 mensagens (10 trocas), sempre em pares user+assistant
  if (session.messages.length > 20) {
    const excesso = session.messages.length - 20;
    session.messages = session.messages.slice(excesso % 2 === 0 ? excesso : excesso + 1);
  }

  await db.saveSession(session);
  return session;
}

async function clearSession(phone) {
  await db.clearSession(phone);
}

// verificarSessoesExpiradas não é mais necessária — o Redis expira automaticamente via TTL
async function verificarSessoesExpiradas() {
  return [];
}

module.exports = { getOrCreateSession, addMessageToSession, clearSession, verificarSessoesExpiradas };
