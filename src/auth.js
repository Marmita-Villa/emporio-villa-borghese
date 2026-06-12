const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET || 'villa-borghese-2024';

function gerarToken(agente) {
  return jwt.sign(
    { id: agente.id, email: agente.email, role: agente.role, nome: agente.nome },
    SECRET,
    { expiresIn: '12h' }
  );
}

function verificarToken(req, res, next) {
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
