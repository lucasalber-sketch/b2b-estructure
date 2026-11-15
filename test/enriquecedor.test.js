// Testes do serviço de enriquecimento incremental (geo + domínio/radar de site) sobre PGlite.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { extrairDominioCandidato, enriquecerEmpresas } from '../src/servicos/enriquecedor.js';
import { criarRepositorio } from '../src/db/repositorio.js';
import { bancoMigrado, gerarCnpj, empresaBase, ORG_A } from './db/ajuda-db.js';
import { formatarCnpj } from '../src/conectores/cnpj.js';

const CNPJ_CONFIRMADA = gerarCnpj('750000010001');
const CNPJ_CONTADOR_1 = gerarCnpj('750000020001');
const CNPJ_CONTADOR_2 = gerarCnpj('750000030001');
const CNPJ_GMAIL = gerarCnpj('750000040001');

describe('enriquecedor — unidades e ponta a ponta', () => {
  let db, repo;
  before(async () => {
    db = await bancoMigrado();
    repo = criarRepositorio(db, { organizationId: ORG_A });

    await repo.salvarEmpresas([
      empresaBase(CNPJ_CONFIRMADA, {
        razao_social: 'USINA BIOENERGIA MS SA',
        porte: 'DEMAIS',
        cep: '79002000',
        email: 'ti@usinams.com.br',
        email_origem: 'rfb_lote',
      }),
      empresaBase(CNPJ_CONTADOR_1, {
        razao_social: 'COMERCIO ALFA LTDA',
        cep: '79800000',
        email: 'fiscal@contabilidadems.com.br',
        email_origem: 'rfb_lote',
      }),
      empresaBase(CNPJ_CONTADOR_2, {
        razao_social: 'SERVICOS BETA LTDA',
        cep: '79800000',
        email: 'contato@contabilidadems.com.br',
        email_origem: 'rfb_lote',
      }),
      empresaBase(CNPJ_GMAIL, {
        razao_social: 'TRANSPORTES GAMA LTDA',
        cep: '79600000',
        email: 'transpgama@gmail.com',
        email_origem: 'rfb_lote',
      }),
    ]);
  });
  after(() => db.fechar());

  test('extrairDominioCandidato classifica corporativo, gratuito e ausente', () => {
    assert.deepEqual(
      extrairDominioCandidato({ email: 'Contato@UsinaMS.com.br', email_origem: 'rfb_lote' }),
      { status: 'ok', dominio: 'usinams.com.br', origem: 'email_rfb' }
    );
    assert.deepEqual(
      extrairDominioCandidato({ email: 'empresa@gmail.com', email_origem: 'rfb_lote' }),
      { status: 'dominio_gratuito' }
    );
    assert.deepEqual(extrairDominioCandidato({ email: null }), { status: 'sem_dominio' });
  });

  test('enriquece geo + site, confirma CNPJ no HTML, reutiliza cache de domínio e não reprocessa', async () => {
    const geocodificarFn = async ({ cep }) => ({
      encontrado: true,
      cep,
      lat: -20.4697,
      lon: -54.6201,
      precisao: 'cep_aproximado',
      fonte: 'brasilapi',
    });

    const chamadasSite = [];
    const inspecionarSiteFn = async (dominio) => {
      chamadasSite.push(dominio);
      if (dominio === 'usinams.com.br') {
        return {
          dominio,
          acessivel: true,
          urlFinal: 'https://usinams.com.br/',
          cnpjs: [{ cnpj: CNPJ_CONFIRMADA, formatado: formatarCnpj(CNPJ_CONFIRMADA) }],
          erps: [{ nome: 'totvs', evidencia: 'Portal Cliente TOTVS Protheus' }],
          rh: [{ nome: 'gupy', evidencia: 'usinams.gupy.io/vagas' }],
        };
      }
      // Site do escritório contábil: acessível e até usa um ERP, mas NÃO tem o CNPJ das empresas clientes!
      return {
        dominio,
        acessivel: true,
        urlFinal: 'https://contabilidadems.com.br/',
        cnpjs: [],
        erps: [{ nome: 'alterdata', evidencia: 'Sistema Alterdata Contábil' }],
        rh: [],
      };
    };

    const r1 = await enriquecerEmpresas({
      repo,
      tipo: 'ambos',
      limite: 10,
      geocodificarFn,
      inspecionarSiteFn,
    });

    assert.equal(r1.contadores.selecionadas, 4);
    assert.equal(r1.contadores.geo.com_coordenada, 4);
    // Dois clientes dividem contabilidadems.com.br → só 2 requisições HTTP no total!
    assert.equal(r1.contadores.site.requisicoes_http, 2);
    assert.equal(r1.contadores.site.reuso_cache_dominio, 1);
    assert.deepEqual(r1.contadores.site.por_status, {
      cnpj_confirmado: 1,
      cnpj_nao_encontrado: 2,
      dominio_gratuito: 1,
    });
    assert.equal(r1.contadores.site.sinais_erp, 1);
    assert.equal(r1.contadores.site.sinais_rh, 1);

    // Empresa confirmada tem domínio confirmado, sinais gravados e indício de porte médio/grande
    const usina = await repo.buscarPorCnpj(CNPJ_CONFIRMADA);
    assert.equal(usina.dominio, 'usinams.com.br');
    assert.equal(usina.dominio_confirmado, true);
    assert.equal(usina.site_status, 'cnpj_confirmado');
    assert.equal(usina.indicio_medio_grande, true);
    assert.equal(usina.etapa_funil, 'enriquecido');
    assert.deepEqual(usina.sinais.map((s) => `${s.tipo}:${s.nome}`).sort(), ['erp:totvs', 'rh:gupy']);

    // Empresa com e-mail do contador NÃO herda o sinal 'alterdata' do site do contador
    const clienteContador = await repo.buscarPorCnpj(CNPJ_CONTADOR_1);
    assert.equal(clienteContador.dominio_confirmado, false);
    assert.equal(clienteContador.site_status, 'cnpj_nao_encontrado');
    assert.equal(clienteContador.sinais.length, 0);

    // 2ª rodada: todas já têm geo_enriquecido_em e site_enriquecido_em → zero selecionadas
    const r2 = await enriquecerEmpresas({
      repo,
      tipo: 'ambos',
      limite: 10,
      geocodificarFn,
      inspecionarSiteFn,
    });
    assert.equal(r2.contadores.selecionadas, 0);
  });
});
