const { createClient } = require('@supabase/supabase-js');
const logger = require('./logger');

// Cache em memória com TTL de 2 minutos
let cache = {};
let cacheAt = 0;
const TTL = 2 * 60 * 1000;

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
}

// Valores padrão caso a tabela ainda não exista
const DEFAULTS = {
  msg_menu: `Olá! 👋 Bem-vindo ao *Villa Borghese Empório*!\n\nComo prefere ser atendido?\n\n1️⃣ *Maithe* — Atendente virtual por IA (disponível agora)\n2️⃣ *Atendente humano* — Um de nossa equipe vai te chamar\n\nDigite *1* ou *2*`,
  msg_boas_vindas_maithe: `Oi! Sou a *Maithe*, atendente por IA do *Empório Villa Borghese* 🤖😊\n\nMe diz seu *nome*, *CPF* ou *telefone* que eu te encontro aqui no sistema e já começamos!`,
  msg_boas_vindas_humano: `Olá! Seja bem-vindo ao delivery do *Empório Villa Borghese*! 😊\n\nEstamos com mais um canal de atendimento para realizar suas compras, através do nosso site www.emporiovillaborghese.com.br`,
  msg_formulario_humano: `Para prosseguir seu atendimento por WhatsApp, preencha os campos abaixo e aguarde que um de nossos colaboradores irá lhe atender:\n\n*Nome Completo:*\n*CPF:*\n*Telefone:*\n*Endereço (Rua, Número, Bairro, Cidade/UF, CEP):*\n*Forma de pagamento:*\n*Pedido:*\n\n*Observações:*\n- Especificar a quantidade, marca e produto;\n- Antes de enviar o seu pedido, verifique se todos os itens estão de acordo com a sua preferência;\nVocê aceita marcas similares? ( ) sim ou ( ) não.\nAgradecemos seu contato! 😊`,
  msg_encerramento: `✅ Atendimento encerrado!\n\nMuito obrigado pelo contato com o *Empório Villa Borghese*! 😊\n\nFoi um prazer te atender. Se precisar de qualquer coisa é só mandar uma mensagem — estamos sempre por aqui! 🛒`,
  msg_inatividade: `👋 Sua conversa foi encerrada por inatividade.\n\nSe precisar de algo é só mandar uma mensagem! 😊`,
};

async function carregarConfig() {
  try {
    const sb = getSupabase();
    const { data } = await sb.from('bot_config').select('chave,valor');
    if (data?.length) {
      cache = {};
      for (const row of data) cache[row.chave] = row.valor;
      cacheAt = Date.now();
    }
  } catch (err) {
    logger.error('Erro ao carregar bot_config', { error: err.message });
  }
}

async function getMsg(chave) {
  if (Date.now() - cacheAt > TTL) await carregarConfig();
  return cache[chave] ?? DEFAULTS[chave] ?? '';
}

async function getAllConfig() {
  if (Date.now() - cacheAt > TTL) await carregarConfig();
  const result = { ...DEFAULTS };
  for (const [k, v] of Object.entries(cache)) result[k] = v;
  return result;
}

async function setConfig(chave, valor) {
  const sb = getSupabase();
  await sb.from('bot_config').upsert({ chave, valor, updated_at: new Date().toISOString() }, { onConflict: 'chave' });
  cache[chave] = valor; // atualiza cache imediatamente
}

// Invalida cache para forçar releitura
function invalidarCache() { cacheAt = 0; }

module.exports = { getMsg, getAllConfig, setConfig, invalidarCache };
