# 🛒 Bot de Delivery WhatsApp com IA

Bot de atendimento automático para mercearia via WhatsApp, com IA que consulta estoque em tempo real e gera pedidos no sistema interno.

---

## Como funciona

```
Cliente manda mensagem
       ↓
WhatsApp Cloud API (Meta)
       ↓
Nosso servidor (webhook)
       ↓
IA (Claude) — consulta estoque, monta carrinho
       ↓
Cliente confirma o pedido
       ↓
API do seu sistema — pedido criado automaticamente
       ↓
Equipe inicia separação normalmente
```

---

## Pré-requisitos

- **Node.js 18+** instalado — [nodejs.org](https://nodejs.org)
- **Conta Meta for Developers** — [developers.facebook.com](https://developers.facebook.com)
- **Chave API Anthropic** — [console.anthropic.com](https://console.anthropic.com)
- **URL pública** para o webhook (use [ngrok](https://ngrok.com) para testes locais)

---

## Instalação passo a passo

### 1. Instale as dependências
```bash
npm install
```

### 2. Configure as variáveis de ambiente
```bash
cp .env.example .env
```
Abra o arquivo `.env` e preencha todos os campos (instruções dentro do arquivo).

### 3. Configure o WhatsApp Business (Meta)

1. Acesse [developers.facebook.com](https://developers.facebook.com) e crie um App
2. Adicione o produto **WhatsApp** ao seu app
3. Copie o **Phone Number ID** e o **Token de acesso temporário**
4. Em **Webhooks**, configure:
   - URL: `https://seudominio.com/webhook`
   - Token de verificação: o mesmo que você colocou em `WHATSAPP_VERIFY_TOKEN`
   - Assine o evento: `messages`

### 4. Configure sua API interna

No arquivo `src/sistemaApi.js`, as rotas esperadas são:

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/produtos/buscar?q=termo` | Busca produtos |
| GET | `/produtos/:id/estoque` | Verifica estoque |
| POST | `/pedidos` | Cria pedido |

Se as rotas do seu sistema forem diferentes, edite o arquivo `src/sistemaApi.js`.

### 5. Inicie o bot
```bash
# Produção
npm start

# Desenvolvimento (reinicia ao salvar)
npm run dev
```

---

## Estrutura de arquivos

```
whatsapp-delivery-bot/
├── src/
│   ├── server.js      → servidor Express + webhook
│   ├── whatsapp.js    → envio de mensagens
│   ├── ia.js          → integração com Claude IA
│   ├── sistemaApi.js  → integração com seu sistema
│   └── session.js     → gerencia sessão por cliente
├── .env.example       → modelo de configuração
├── package.json
└── README.md
```

---

## Formato esperado da API do seu sistema

### GET /produtos/buscar?q=arroz
```json
[
  {
    "id": "123",
    "nome": "Arroz Tio João 5kg",
    "preco": 28.90,
    "estoque": 15,
    "categoria": "grãos"
  }
]
```

### GET /produtos/:id/estoque
```json
{
  "disponivel": true,
  "quantidade": 15
}
```

### POST /pedidos (payload enviado pelo bot)
```json
{
  "cliente": {
    "telefone": "5513999999999",
    "nome": "João Silva",
    "endereco": "Rua das Flores, 123"
  },
  "itens": [
    {
      "produto_id": "123",
      "nome": "Arroz Tio João 5kg",
      "quantidade": 2,
      "preco_unitario": 28.90
    }
  ],
  "total": 57.80,
  "forma_pagamento": "pix",
  "observacoes": "",
  "canal": "whatsapp",
  "criado_em": "2024-01-15T14:30:00.000Z"
}
```

### Resposta esperada do POST /pedidos
```json
{
  "id": "PED-001",
  "status": "recebido",
  "previsao_entrega": "40-60 minutos"
}
```

---

## Testando localmente com ngrok

```bash
# Instale o ngrok: https://ngrok.com
ngrok http 3000

# Copie a URL gerada (ex: https://abc123.ngrok.io)
# Configure no painel da Meta: https://abc123.ngrok.io/webhook
```

---

## Personalizando a IA

Para mudar o comportamento da atendente, edite a função `getSystemPrompt()` em `src/ia.js`.

Você pode:
- Mudar o nome da atendente (atualmente "Mari")
- Ajustar o tom de comunicação
- Adicionar horário de funcionamento
- Incluir promoções ou políticas da loja

---

## Dúvidas frequentes

**O bot funciona com número pessoal do WhatsApp?**
Não. Precisa de um número no WhatsApp Business API (Meta). Números pessoais violam os termos de uso.

**Tem custo?**
- Meta: gratuito para as primeiras 1.000 conversas/mês iniciadas por empresa. Conversas iniciadas pelo cliente são gratuitas por 24h.
- Anthropic: cobrança por tokens usados. Muito barato para atendimento — em torno de R$ 0,01 a R$ 0,05 por conversa completa.

**E se o sistema ficar fora do ar?**
O bot responde ao cliente que está com dificuldade técnica e tenta novamente automaticamente.
