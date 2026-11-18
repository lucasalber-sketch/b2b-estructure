// Adaptador Serverless para deploy na Vercel
import { criarConexao } from '../src/db/conexao.js';
import { criarServidorWeb } from '../src/web/servidor.js';

let appHandler = null;

export default async function handler(req, res) {
  if (!appHandler) {
    const org = process.env.ORGANIZACAO_ID;
    const conexao = await criarConexao();
    const server = criarServidorWeb({ conexao, organizationId: org });
    appHandler = server.listeners('request')[0];
  }
  return appHandler(req, res);
}
