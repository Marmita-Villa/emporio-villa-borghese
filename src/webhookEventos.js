/**
 * webhookEventos.js — Recebe eventos da nova API e notifica o cliente no WhatsApp
 *
 * Endpoint: POST /webhook/eventos
 * Autenticação: HMAC-SHA256 via header X-Webhook-Secret
 *
 * Eventos suportados:
 *   - pedido.status_mudou
 *   - pedido.itens_indisponiveis
 *   - pedido.pix_gerado
 *   - pedido.pagamento_confirmado
 *   - pedido.pagamento_falhou
 */

const express = require('express');
const crypto = require('crypto');
const { enviarMensagem } = require('./whatsapp');
const logger = require('./logger');

const router = express.Router();

const WEBHOOK_SECRET = process.env.WEBHOOK_EVENTOS_SECRET || '';

function validarAssinatura(req) {
  if (!WEBHOOK_SECRET) return true; // sem secret configurado, aceita tudo (remover em produção)
  const assinatura = req.headers['x-webhook-signature'] || req.headers['x-webhook-secret'] || '';
  // HMAC sobre os bytes originais (req.rawBody capturado no server.js). JSON.stringify(req.body)
  // não bate byte-a-byte com o payload assinado e faria assinaturas válidas falharem.
  const corpo = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const esperado = crypto.createHmac('sha256', WEBHOOK_SECRET).update(corpo).digest('hex');
  const a = Buffer.from(assinatura);
  const b = Buffer.from(esperado);
  if (a.length !== b.length) return false; // timingSafeEqual estoura se os tamanhos diferem
  return crypto.timingSafeEqual(a, b);
}

// ─── Mensagens por evento ───

function mensagemStatusMudou(evento) {
  const { numero_pedido, status, previsao_entrega } = evento;
  const statusMap = {
    em_preparo:      `🍳 Seu pedido *#${numero_pedido}* já está sendo preparado!`,
    saiu_entrega:    `🛵 Seu pedido *#${numero_pedido}* saiu para entrega! Previsão: ${previsao_entrega || '30-45 min'}.`,
    entregue:        `✅ Pedido *#${numero_pedido}* entregue! Obrigado por comprar no Villa Borghese. 😊`,
    cancelado:       `❌ Seu pedido *#${numero_pedido}* foi cancelado. Qualquer dúvida, é só chamar!`,
  };
  return statusMap[status] || `📦 Pedido *#${numero_pedido}*: status atualizado para *${status}*.`;
}

function mensagemItensIndisponiveis(evento) {
  const { numero_pedido, itens } = evento;
  const lista = itens.map(i => {
    const sug = i.sugestoes?.length ? ` (sugestão: ${i.sugestoes[0].nome})` : '';
    return `• ${i.nome}${sug}`;
  }).join('\n');
  return `⚠️ Alguns itens do pedido *#${numero_pedido}* estão indisponíveis:\n${lista}\n\nDeseja substituir ou remover esses itens?`;
}

function mensagemPixGerado(evento) {
  const { numero_pedido, qr_code_texto, qr_code_url, expira_em } = evento;
  let msg = `💳 *PIX gerado para o pedido #${numero_pedido}*\n\n`;
  if (qr_code_texto) msg += `*Copia e cola:*\n\`${qr_code_texto}\`\n\n`;
  if (expira_em)     msg += `⏰ Expira em: ${expira_em}`;
  if (qr_code_url)   msg += `\n\nQR Code: ${qr_code_url}`;
  return msg;
}

function mensagemPagamentoConfirmado(evento) {
  const { numero_pedido, valor } = evento;
  const valor_fmt = valor ? ` de R$ ${Number(valor).toFixed(2)}` : '';
  return `✅ Pagamento${valor_fmt} confirmado para o pedido *#${numero_pedido}*! Já estamos preparando tudo. 😊`;
}

function mensagemPagamentoFalhou(evento) {
  const { numero_pedido, fallback_pagamento } = evento;
  let msg = `❌ Não conseguimos confirmar o pagamento do pedido *#${numero_pedido}*.`;
  if (fallback_pagamento) msg += `\n\nVocê pode pagar com *${fallback_pagamento}* na entrega.`;
  else msg += '\n\nPor favor, tente novamente ou escolha outra forma de pagamento.';
  return msg;
}

// ─── Endpoint principal ───

// express.json() global (com captura de rawBody) já roda no server.js antes deste handler
router.post('/eventos', (req, res) => {
  if (!validarAssinatura(req)) {
    logger.warn('Webhook evento: assinatura inválida');
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  const { tipo, telefone, ...evento } = req.body;

  if (!tipo || !telefone) {
    return res.status(400).json({ error: 'Campos obrigatórios: tipo, telefone' });
  }

  logger.info('Webhook evento recebido', { tipo, telefone, pedido: evento.numero_pedido });

  let mensagem;
  try {
    switch (tipo) {
      case 'pedido.status_mudou':         mensagem = mensagemStatusMudou(evento); break;
      case 'pedido.itens_indisponiveis':  mensagem = mensagemItensIndisponiveis(evento); break;
      case 'pedido.pix_gerado':           mensagem = mensagemPixGerado(evento); break;
      case 'pedido.pagamento_confirmado': mensagem = mensagemPagamentoConfirmado(evento); break;
      case 'pedido.pagamento_falhou':     mensagem = mensagemPagamentoFalhou(evento); break;
      default:
        logger.warn('Webhook evento: tipo desconhecido', { tipo });
        return res.status(400).json({ error: `Tipo de evento desconhecido: ${tipo}` });
    }
  } catch (err) {
    logger.error('Erro ao montar mensagem do evento', { tipo, error: err.message });
    return res.status(500).json({ error: 'Erro interno' });
  }

  // Envia mensagem ao cliente no WhatsApp (fire-and-forget)
  enviarMensagem(telefone, mensagem).catch(err =>
    logger.error('Erro ao enviar mensagem do evento', { telefone, error: err.message })
  );

  res.json({ ok: true, tipo, telefone });
});

module.exports = router;
