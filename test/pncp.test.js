// Testes do conector PNCP e da ingestão em lote (100% offline, PGlite em memória).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatarDataPncp,
  diasEntre,
  normalizarContratoPncp,
  consultarContratosPncp,
} from '../src/conectores/pncp.js';
import { ingerirPncp } from '../src/servicos/pncp-ingestao.js';
import { criarRepositorio } from '../src/db/repositorio.js';
import { bancoMigrado, gerarCnpj, empresaBase, ORG_A } from './db/ajuda-db.js';

const ORGAO_MS = gerarCnpj('154122570001');
const FORN_MS_MATRIZ = gerarCnpj('710000010001');
const FORN_MS_FILIAL = gerarCnpj('710000010002'); // mesma raiz 71000001
const FORN_OUTRA_UF = gerarCnpj('720000020001');

function itemPncp({
  controle = '15412257000128-2-000001/2026',
  tipoPessoa = 'PJ',
  niFornecedor = FORN_MS_MATRIZ,
  nomeFornecedor = 'AGROINDUSTRIAL MS LTDA',
  orgaoCnpj = ORGAO_MS,
  orgaoNome = 'ESTADO DE MATO GROSSO DO SUL',
  ufSigla = 'MS',
  objeto = 'Fornecimento de insumos industriais e serviços técnicos',
  valorGlobal = 480000.5,
  dataAssinatura = '2026-10-01',
  dataVigenciaFim = '2027-10-01',
} = {}) {
  return {
    numeroControlePNCP: controle,
    tipoPessoa,
    niFornecedor,
    nomeRazaoSocialFornecedor: nomeFornecedor,
    orgaoEntidade: { cnpj: orgaoCnpj, razaoSocial: orgaoNome },
    unidadeOrgao: { ufSigla, municipioNome: 'Campo Grande' },
    objetoContrato: objeto,
    valorGlobal,
    dataAssinatura,
    dataVigenciaFim,
    anoContrato: 2026,
    sequencialContrato: 1,
  };
}

describe('conector PNCP — unidades', () => {
  test('formatarDataPncp e diasEntre', () => {
    assert.equal(formatarDataPncp('2026-10-05'), '20261005');
    assert.throws(() => formatarDataPncp('2026-02-30'), /Data inexistente/);
    assert.throws(() => formatarDataPncp('05/10/2026'), /Data inválida/);
    assert.deepEqual(diasEntre('2026-10-01', '2026-10-03'), ['2026-10-01', '2026-10-02', '2026-10-03']);
    assert.throws(() => diasEntre('2026-10-05', '2026-10-01'), /Período inválido/);
  });

  test('normalizarContratoPncp aceita PJ e descarta PF ou CNPJ inválido (LGPD)', () => {
    const ok = normalizarContratoPncp(itemPncp());
    assert.equal(ok.cnpj_fornecedor, FORN_MS_MATRIZ);
    assert.equal(ok.cnpj_basico, '71000001');
    assert.equal(ok.uf_orgao, 'MS');
    assert.equal(ok.valor_global, 480000.5);
    assert.match(ok.url_fonte, /^https:\/\/pncp\.gov\.br\/app\/contratos\//);

    // Fornecedor pessoa física → descartado (LGPD)
    assert.equal(normalizarContratoPncp(itemPncp({ tipoPessoa: 'PF', niFornecedor: '12345678901' })), null);
    // CNPJ com DV inválido → descartado
    assert.equal(normalizarContratoPncp(itemPncp({ niFornecedor: '00000000000192' })), null);
  });

  test('consultarContratosPncp pagina e filtra por UF e raiz de fornecedor', async () => {
    const paginas = [
      {
        status: 200,
        json: async () => ({
          totalPaginas: 2,
          totalRegistros: 3,
          data: [
            itemPncp({ controle: 'C-1', niFornecedor: FORN_MS_MATRIZ, ufSigla: 'MS' }),
            itemPncp({ controle: 'C-PF', tipoPessoa: 'PF', niFornecedor: '11122233344' }),
          ],
        }),
      },
      {
        status: 200,
        json: async () => ({
          totalPaginas: 2,
          totalRegistros: 3,
          data: [itemPncp({ controle: 'C-2', niFornecedor: FORN_OUTRA_UF, ufSigla: 'SP' })],
        }),
      },
    ];
    let idx = 0;
    const requisitarFn = async () => paginas[idx++];

    const r = await consultarContratosPncp({
      dataInicial: '2026-10-01',
      dataFinal: '2026-10-01',
      ufOrgao: 'MS',
      cnpjFornecedor: '71000001',
      requisitarFn,
    });
    assert.equal(r.paginasLidas, 2);
    assert.equal(r.descartadosPfOuInvalido, 1);
    assert.equal(r.totalFiltrados, 1);
    assert.equal(r.contratos[0].numero_controle_pncp, 'C-1');
  });
});

describe('ingestão PNCP ponta a ponta (PGlite)', () => {
  let db, repo;
  before(async () => {
    db = await bancoMigrado();
    repo = criarRepositorio(db, { organizationId: ORG_A });
    await repo.salvarEmpresa(empresaBase(FORN_MS_MATRIZ, { razao_social: 'AGROINDUSTRIAL MS LTDA' }));
  });
  after(() => db.fechar());

  test('casa contrato da matriz e da filial com a matriz de MS e retoma pelo checkpoint', async () => {
    const porDia = {
      '2026-10-01': [
        itemPncp({ controle: 'CTRL-MATRIZ-1', niFornecedor: FORN_MS_MATRIZ, valorGlobal: 100000 }),
        itemPncp({ controle: 'CTRL-OUTRA-1', niFornecedor: FORN_OUTRA_UF, valorGlobal: 50000 }),
      ],
      '2026-10-02': [
        // Filial (0002) da mesma empresa de MS: deve ligar à matriz via cnpj_basico!
        itemPncp({ controle: 'CTRL-FILIAL-2', niFornecedor: FORN_MS_FILIAL, valorGlobal: 250000 }),
      ],
    };

    const buscarPagina = async ({ dataInicial }) => ({
      data: porDia[dataInicial] ?? [],
      totalPaginas: 1,
      totalRegistros: (porDia[dataInicial] ?? []).length,
      paginaAtual: 1,
    });

    const r = await ingerirPncp({
      desde: '2026-10-01',
      ate: '2026-10-02',
      simular: false,
      repo,
      buscarPagina,
    });

    assert.equal(r.contadores.dias_processados, 2);
    assert.equal(r.contadores.casados_empresa_ms, 2);
    assert.equal(r.contadores.gravados, 2);
    assert.equal(r.contadores.valor_total_casados, 350000);

    const emp = await repo.buscarPorCnpj(FORN_MS_MATRIZ);
    assert.equal(emp.contratos_pncp, 2);
  });
});
