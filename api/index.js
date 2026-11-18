// Adaptador Serverless para deploy na Vercel
import { criarConexao, mascararSegredos } from '../src/db/conexao.js';
import { criarServidorWeb } from '../src/web/servidor.js';

let appHandler = null;
let inicializacaoPromessa = null;

async function inicializar() {
  const org = process.env.ORGANIZACAO_ID;
  if (!org) {
    throw new Error('ORGANIZACAO_ID não configurada no ambiente da Vercel.');
  }
  if (!process.env.DATABASE_URL && process.env.DB_MEMORIA !== '1') {
    throw new Error('DATABASE_URL não configurada no ambiente da Vercel.');
  }

  const conexao = await criarConexao();
  const server = criarServidorWeb({ conexao, organizationId: org });
  return server.listeners('request')[0];
}

export default async function handler(req, res) {
  try {
    if (!appHandler) {
      if (!inicializacaoPromessa) {
        inicializacaoPromessa = inicializar();
      }
      appHandler = await inicializacaoPromessa;
    }
    return appHandler(req, res);
  } catch (erro) {
    inicializacaoPromessa = null; // Permite retentar na próxima requisição
    console.error('[vercel-api] Falha na inicialização:', mascararSegredos(erro.message));
    res.writeHead(500, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(
      JSON.stringify({
        erro: 'Erro de inicialização no servidor.',
        detalhe: mascararSegredos(erro.message),
        dica: 'Verifique se as variáveis DATABASE_URL e ORGANIZACAO_ID estão preenchidas nas configurações da Vercel.',
      })
    );
  }
}
