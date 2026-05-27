// Armazena sessão de cada cliente em memória
// Em produção, use Redis para persistir entre reinicializações
const sessions = new Map();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos de inatividade encerra sessão

function getSession(phone) {
  const session = sessions.get(phone);
  if (!session) return null;

  // Encerra sessão se ficou mais de 30 min inativo
  if (Date.now() - session.lastActivity > SESSION_TIMEOUT_MS) {
    sessions.delete(phone);
    return null;
  }

  session.lastActivity = Date.now();
  return session;
}

function createSession(phone) {
  const session = {
    phone,
    messages: [],       // histórico da conversa para a IA
    cart: [],           // carrinho atual do cliente
    step: 'menu',       // etapa atual: menu | aguardando_escolha | ai | humano | done
    lastActivity: Date.now(),
    customerName: null,
  };
  sessions.set(phone, session);
  return session;
}

function getOrCreateSession(phone) {
  return getSession(phone) || createSession(phone);
}

function clearSession(phone) {
  sessions.delete(phone);
}

function addMessageToSession(phone, role, content) {
  const session = getOrCreateSession(phone);
  session.messages.push({ role, content });

  // Mantém apenas as últimas 20 mensagens para não estourar o contexto
  if (session.messages.length > 20) {
    session.messages = session.messages.slice(-20);
  }
  return session;
}

module.exports = { getOrCreateSession, addMessageToSession, clearSession };
