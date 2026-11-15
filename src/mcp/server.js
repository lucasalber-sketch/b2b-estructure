#!/usr/bin/env node
// Servidor MCP "mcp-dados-brasil" (stdio). stdout é exclusivo do protocolo → logs vão para stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { listarMunicipios, listarSecoesCnae, listarClassesCnae } from '../conectores/ibge.js';
import { consultarCnpj } from '../conectores/cnpj.js';
import { geocodificar } from '../conectores/geo.js';
import { inspecionarSite } from '../conectores/site-radar.js';
import { consultarContratosPncp } from '../conectores/pncp.js';
import { criarConexao, bancoConfigurado } from '../db/conexao.js';
import { diagnosticar } from '../db/status.js';

const log = (...a) => console.error('[mcp-dados-brasil]', ...a);

/** Envolve um handler: sucesso → JSON em texto; erro → isError sem derrubar o servidor. */
const ferramenta = (fn) => async (args) => {
  try {
    const dados = await fn(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(dados, null, 2) }],
      structuredContent: { resultado: dados },
    };
  } catch (e) {
    log('erro:', e.message);
    return { isError: true, content: [{ type: 'text', text: `Erro: ${e.message}` }] };
  }
};

export function criarServidor() {
  const server = new McpServer({ name: 'mcp-dados-brasil', version: '0.1.0' });
  const saida = { resultado: z.any() };

  server.registerTool(
    'ibge_municipios_cnaes',
    {
      title: 'IBGE: municípios por UF e CNAE',
      description:
        'Consulta a API oficial do IBGE. tipo="municipios" lista os municípios da UF (padrão MS = 79). ' +
        'tipo="cnae" lista as 21 seções CNAE; com "secao" (A..U) lista as classes daquela seção.',
      inputSchema: {
        tipo: z.enum(['municipios', 'cnae']).default('municipios'),
        uf: z.string().length(2).default('MS').describe('Sigla da UF (para tipo=municipios)'),
        secao: z.string().regex(/^[A-Ua-u]$/).optional().describe('Seção CNAE A..U (para tipo=cnae)'),
      },
      outputSchema: saida,
    },
    ferramenta(({ tipo = 'municipios', uf = 'MS', secao }) => {
      if (tipo === 'municipios') return listarMunicipios(uf);
      return secao ? listarClassesCnae(secao) : listarSecoesCnae();
    })
  );

  server.registerTool(
    'consultar_cnpj_real',
    {
      title: 'Consultar CNPJ (BrasilAPI → CNPJ.ws)',
      description:
        'Valida (numérico ou alfanumérico) e consulta um CNPJ em tempo real na BrasilAPI com fallback para Publica CNPJ.ws. ' +
        'Retorna razão social, fantasia, matriz/filial, situação, abertura, porte, natureza jurídica, capital, CNAEs, endereço, ' +
        'IE (quando disponível) e telefone/e-mail apenas para PJ empresarial de porte DEMAIS/EPP, nunca MEI/Empresário Individual (LGPD). ' +
        'Cache local de 7 dias.',
      inputSchema: {
        cnpj: z.string().min(14).max(20).describe('CNPJ com ou sem máscara'),
        incluir_ie: z.boolean().default(true).describe('Busca Inscrição Estadual no CNPJ.ws (limite 3 consultas/min)'),
        ignorar_cache: z.boolean().default(false),
      },
      outputSchema: saida,
    },
    ferramenta(({ cnpj, incluir_ie = true, ignorar_cache = false }) =>
      consultarCnpj(cnpj, { incluirIE: incluir_ie, ignorarCache: ignorar_cache })
    )
  );

  server.registerTool(
    'geocodificar_cep',
    {
      title: 'Geocodificar CEP/endereço',
      description:
        'Converte CEP (BrasilAPI CEP v2) ou endereço livre (Nominatim/OSM) em latitude/longitude. ' +
        'As coordenadas da BrasilAPI costumam ser o centro do município (precisao="cep_aproximado"); ' +
        'use precisao_rua=true para tentar o ponto da rua via Nominatim.',
      inputSchema: {
        cep: z.string().optional().describe('CEP com ou sem hífen'),
        endereco: z.string().optional().describe('Endereço livre, usado quando não há CEP'),
        precisao_rua: z.boolean().default(false),
      },
      outputSchema: saida,
    },
    ferramenta(({ cep, endereco, precisao_rua = false }) => geocodificar({ cep, endereco, precisaoRua: precisao_rua }))
  );

  server.registerTool(
    'inspecionar_site_erp',
    {
      title: 'Radar de site: CNPJ, ERP e RH',
      description:
        'Baixa o HTML público da home de um domínio (timeout 5s, sem executar JS) e extrai: CNPJs válidos, ' +
        'assinaturas de ERP (totvs, protheus, sankhya, sap, senior, linx, omie, bling, alterdata) e portais de RH ' +
        '(gupy, solides, vagas.com, inhire, kenoby, trabalhe conosco). Cada sinal vem com o trecho de evidência.',
      inputSchema: {
        dominio: z.string().min(3).describe('Domínio ou URL, ex.: empresa.com.br'),
      },
      outputSchema: saida,
    },
    ferramenta(({ dominio }) => inspecionarSite(dominio))
  );

  server.registerTool(
    'consultar_pncp_contratos',
    {
      title: 'PNCP: contratos públicos (PJ)',
      description:
        'Consulta a API oficial do PNCP (/api/consulta/v1/contratos) num intervalo de publicação (AAAA-MM-DD), ' +
        'filtrando apenas fornecedores PJ (LGPD) e opcionalmente por UF do órgão, CNPJ do órgão ou CNPJ/raiz do fornecedor.',
      inputSchema: {
        data_inicial: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data inicial AAAA-MM-DD'),
        data_final: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Data final AAAA-MM-DD'),
        uf_orgao: z.string().length(2).optional().describe('Filtro opcional pela UF da unidade do órgão (ex.: MS)'),
        cnpj_orgao: z.string().optional().describe('Filtro opcional pelo CNPJ do órgão contratante'),
        cnpj_fornecedor: z.string().optional().describe('Filtro opcional pelo CNPJ (14 posições) ou raiz (8 posições) do fornecedor'),
        max_paginas: z.number().int().min(1).max(20).default(5).describe('Máximo de páginas de 500 itens a varrer'),
      },
      outputSchema: saida,
    },
    ferramenta(({ data_inicial, data_final, uf_orgao, cnpj_orgao, cnpj_fornecedor, max_paginas = 5 }) =>
      consultarContratosPncp({
        dataInicial: data_inicial,
        dataFinal: data_final,
        ufOrgao: uf_orgao,
        cnpjOrgao: cnpj_orgao,
        cnpjFornecedor: cnpj_fornecedor,
        maxPaginas: max_paginas,
      })
    )
  );

  // Banco: conexão criada só quando db_status é chamado; sem DATABASE_URL o servidor segue funcionando.
  let conexao = null;
  server.registerTool(
    'db_status',
    {
      title: 'Banco (Supabase): saúde e migrações',
      description:
        'Verifica a conexão com o banco PostgreSQL/Supabase (schema prospeccao): versão, latência, ' +
        'migrações aplicadas e pendentes e quantidade de linhas por tabela. Não expõe credenciais.',
      inputSchema: {},
      outputSchema: saida,
    },
    ferramenta(async () => {
      if (!bancoConfigurado() && process.env.DB_MEMORIA !== '1') {
        return { configurado: false, mensagem: 'DATABASE_URL não configurada no ambiente do servidor MCP (.env)' };
      }
      conexao ??= await criarConexao();
      return diagnosticar(conexao);
    })
  );

  const fecharOriginal = server.close.bind(server);
  server.close = async () => {
    await conexao?.fechar().catch(() => {});
    conexao = null;
    return fecharOriginal();
  };

  return server;
}

const executadoDireto =
  process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase();
if (executadoDireto) {
  const server = criarServidor();
  await server.connect(new StdioServerTransport());
  log('servidor pronto (stdio) com 5 ferramentas');
}
