const jwt = require('jsonwebtoken');
const logger = require('./logger');

// Sem JWT_SECRET não emitimos tokens (o valor padrão antigo era previsível e forjável).
// Degrada com segurança: o painel fica indisponível, mas o bot do WhatsApp segue funcionando.
const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  logger.error('JWT_SECRET não definido — painel de atendimento DESATIVADO até configurar a variável no ambiente.');
}

function gerarToken(agente) {
  if (!SECRET) return null;
  return jwt.sign(
    { id: agente.id, email: agente.email, role: agente.role, nome: agente.nome },
    SECRET,
    { expiresIn: '12h' }
  );
}

function verificarToken(req, res, next) {
  if (!SECRET) return res.status(503).json({ error: 'Servidor sem JWT_SECRET configurado. Contate o administrador.' });
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Não autenticado' });
  try {
    req.agente = jwt.verify(auth.slice(7), SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

function requireAdmin(req, res, next) {
  if (req.agente?.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores' });
  next();
}

module.exports = { gerarToken, verificarToken, requireAdmin };
