// Armazena sessão de cada cliente em memória
// Em produção, use Redis para persistir entre reinicializações
const sessions = new Map();

const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutos de inatividade encerra a sessão

function getSession(phone) {
  const session = sessions.get(phone);
  if (!session) return null;

  // Encerra sessão se ficou mais de 15 min inativo
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

// Retorna sessões expiradas e as remove — chamado pelo monitor em server.js
function verificarSessoesExpiradas() {
  const expiradas = [];
  const agora = Date.now();

  for (const [phone, session] of sessions.entries()) {
    if (agora - session.lastActivity > SESSION_TIMEOUT_MS) {
      // Só notifica sessões reais que já interagiram (ignora teste_local e menu inicial)
      if (phone !== 'teste_local' && session.step !== 'menu') {
        expiradas.push({ phone, step: session.step });
      }
      sessions.delete(phone);
    }
  }

  return expiradas;
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

module.exports = { getOrCreateSession, addMessageToSession, clearSession, verificarSessoesExpiradas };
