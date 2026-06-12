const express = require('express');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const { gerarToken, verificarToken, requireAdmin } = require('./auth');
const { enviarMensagem } = require('./whatsapp');
const { clearSession } = require('./session');
const logger = require('./logger');

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

// ─── Auth ───

// POST /api/auth/login
router.post('/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'Email e senha obrigatórios' });

  const sb = getSupabase();
  const { data: agente } = await sb.from('agents').select('*').eq('email', email.toLowerCase()).eq('ativo', true).single();
  if (!agente) return res.status(401).json({ error: 'Email ou senha incorretos' });

  const ok = await bcrypt.compare(senha, agente.senha_hash);
  if (!ok) return res.status(401).json({ error: 'Email ou senha incorretos' });

  const token = gerarToken(agente);
  logger.info('Agente autenticado', { email: agente.email, nome: agente.nome });
  res.json({ token, agente: { id: agente.id, nome: agente.nome, email: agente.email, role: agente.role } });
});

// GET /api/auth/me
router.get('/auth/me', verificarToken, (req, res) => res.json(req.agente));

// ─── Agentes (admin) ───

// GET /api/agentes
router.get('/agentes', verificarToken, requireAdmin, async (req, res) => {
  const sb = getSupabase();
  const { data } = await sb.from('agents').select('id,nome,email,role,ativo,created_at').order('created_at');
  res.json(data || []);
});

// POST /api/agentes
router.post('/agentes', verificarToken, requireAdmin, async (req, res) => {
  const { nome, email, senha, role = 'agent' } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ error: 'Nome, email e senha obrigatórios' });

  const senha_hash = await bcrypt.hash(senha, 10);
  const sb = getSupabase();
  const { data, error } = await sb.from('agents').insert({ nome, email: email.toLowerCase(), senha_hash, role }).select().single();
  if (error) return res.status(400).json({ error: error.message.includes('unique') ? 'Email já cadastrado' : error.message });

  logger.info('Agente criado', { email, nome });
  res.json({ id: data.id, nome: data.nome, email: data.email, role: data.role, ativo: data.ativo });
});

// PATCH /api/agentes/:id
router.patch('/agentes/:id', verificarToken, requireAdmin, async (req, res) => {
  const { ativo, nome, senha, role } = req.body;
  const update = {};
  if (ativo !== undefined) update.ativo = ativo;
  if (nome) update.nome = nome;
  if (role) update.role = role;
  if (senha) update.senha_hash = await bcrypt.hash(senha, 10);

  const sb = getSupabase();
  const { error } = await sb.from('agents').update(update).eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ ok: true });
});

// DELETE /api/agentes/:id
router.delete('/agentes/:id', verificarToken, requireAdmin, async (req, res) => {
  const sb = getSupabase();
  await sb.from('agents').update({ ativo: false }).eq('id', req.params.id);
  res.json({ ok: true });
});

// ─── Fila de atendimento ───

// GET /api/fila — conversas aguardando atendente
router.get('/fila', verificarToken, async (req, res) => {
  const sb = getSupabase();
  const { data } = await sb
    .from('conversations')
    .select('phone,customer_name,status,assigned_name,human_started_at,updated_at')
    .in('status', ['aguardando', 'em_atendimento'])
    .order('updated_at', { ascending: true });
  res.json(data || []);
});

// POST /api/conversa/:phone/assumir
router.post('/conversa/:phone/assumir', verificarToken, async (req, res) => {
  const { phone } = req.params;
  const sb = getSupabase();

  const { data: conv } = await sb.from('conversations').select('status,assigned_to').eq('phone', phone).single();
  if (conv?.status === 'em_atendimento' && conv.assigned_to !== req.agente.id) {
    return res.status(409).json({ error: 'Conversa já assumida por outro atendente' });
  }

  await sb.from('conversations').update({
    status: 'em_atendimento',
    assigned_to: req.agente.id,
    assigned_name: req.agente.nome,
    human_started_at: new Date().toISOString(),
  }).eq('phone', phone);

  logger.info('Conversa assumida', { phone, agente: req.agente.nome });
  res.json({ ok: true });
});

// GET /api/conversa/:phone/historico
router.get('/conversa/:phone/historico', verificarToken, async (req, res) => {
  const { phone } = req.params;
  const sb = getSupabase();

  const [convRes, msgsRes] = await Promise.all([
    sb.from('conversations').select('*').eq('phone', phone).single(),
    sb.from('human_messages').select('*').eq('phone', phone).order('created_at'),
  ]);

  res.json({
    conversa: convRes.data || null,
    botMessages: convRes.data?.messages || [],
    humanMessages: msgsRes.data || [],
  });
});

// POST /api/conversa/:phone/mensagem — agente envia mensagem ao cliente
router.post('/conversa/:phone/mensagem', verificarToken, async (req, res) => {
  const { phone } = req.params;
  const { texto } = req.body;
  if (!texto?.trim()) return res.status(400).json({ error: 'Texto obrigatório' });

  try {
    await enviarMensagem(phone, texto.trim());

    const sb = getSupabase();
    await sb.from('human_messages').insert({
      phone,
      direction: 'out',
      content: texto.trim(),
      agent_id: req.agente.id,
      agent_name: req.agente.nome,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error('Erro ao enviar mensagem do agente', { error: err.message });
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

// POST /api/conversa/:phone/encerrar
router.post('/conversa/:phone/encerrar', verificarToken, async (req, res) => {
  const { phone } = req.params;
  const sb = getSupabase();

  await sb.from('conversations').update({
    status: 'encerrado',
    human_ended_at: new Date().toISOString(),
  }).eq('phone', phone);

  await clearSession(phone);

  try {
    await enviarMensagem(phone, `✅ Atendimento encerrado!\n\nMuito obrigado pelo contato com o *Empório Villa Borghese*! 😊\n\nFoi um prazer te atender. Se precisar de qualquer coisa é só mandar uma mensagem — estamos sempre por aqui! 🛒`);
  } catch (_) {}

  logger.info('Conversa encerrada pelo agente', { phone, agente: req.agente.nome });
  res.json({ ok: true });
});

// GET /api/historico — conversas encerradas recentes
router.get('/historico', verificarToken, async (req, res) => {
  const sb = getSupabase();
  const { data } = await sb
    .from('conversations')
    .select('phone,customer_name,assigned_name,human_started_at,human_ended_at,updated_at')
    .eq('status', 'encerrado')
    .order('human_ended_at', { ascending: false })
    .limit(50);
  res.json(data || []);
});

module.exports = router;
