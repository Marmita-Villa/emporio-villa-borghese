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

// Retorna sessões de bot inativas (para notificar o cliente com msg_inatividade uma única vez).
// A expiração real da sessão continua a cargo do TTL do Redis; isto só cobre o aviso ao cliente.
async function verificarSessoesExpiradas() {
  const inativos = await db.pegarInativos(Date.now());
  return inativos.map(phone => ({ phone }));
}

module.exports = { getOrCreateSession, addMessageToSession, clearSession, verificarSessoesExpiradas };
