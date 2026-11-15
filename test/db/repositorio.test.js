import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bancoMigrado, comoApp, gerarCnpj, empresaBase, ORG_A, ORG_B } from './ajuda-db.js';
import { criarRepositorio, empresaDeConsulta } from '../../src/db/repositorio.js';
import { normalizarBrasilApi } from '../../src/conectores/cnpj.js';
import { fixture } from '../helpers.js';

const consultaBB = () => ({
  encontrado: true,
  ...normalizarBrasilApi(fixture('brasilapi-cnpj-bb.json')),
  consultadoEm: '2026-11-15T12:00:00.000Z',
  avisos: [],
});

describe('empresaDeConsulta (saída da Etapa 1 → linha do banco)', () => {
  test('Banco do Brasil (DEMAIS, economia mista) é aceito com origem carimbada', () => {
    const r = empresaDeConsulta(consultaBB());
    assert.equal(r.aceita, true);
    const e = r.empresa;
    assert.equal(e.cnpj, '00000000000191');
    assert.equal(e.cnpj_origem, 'brasilapi');
    assert.equal(e.fonte_descoberta, 'mcp_consulta');
    assert.equal(e.natureza_juridica_codigo, '2038');
    assert.equal(e.porte, 'DEMAIS');
    assert.equal(e.telefone_e164, '+556134939002');
    assert.equal(e.telefone_origem, 'brasilapi');
    assert.equal(e.cnae_principal, '6422100');
    assert.equal(e.data_abertura, '1966-08-01');
  });

  test('Decisão C: MEI, Empresário Individual, porte ME e natureza não empresarial são descartados', () => {
    const base = consultaBB();
    assert.deepEqual(empresaDeConsulta({ ...base, mei: true }), { aceita: false, motivo: 'descartada_mei' });
    assert.deepEqual(empresaDeConsulta({ ...base, naturezaJuridica: { codigo: '2135' } }), { aceita: false, motivo: 'descartada_empresario_individual' });
    assert.deepEqual(empresaDeConsulta({ ...base, naturezaJuridica: { codigo: '3999' } }), { aceita: false, motivo: 'descartada_natureza_nao_empresarial' });
    assert.deepEqual(empresaDeConsulta({ ...base, porte: 'ME' }), { aceita: false, motivo: 'descartada_porte' });
    assert.deepEqual(empresaDeConsulta({ encontrado: false }), { aceita: false, motivo: 'cnpj_nao_encontrado' });
  });

  test('sem telefone na fonte → NULL + NAO_VERIFICADO (nada é inventado)', () => {
    const e = empresaDeConsulta({ ...consultaBB(), telefone: null, email: null }).empresa;
    assert.equal(e.telefone_e164, null);
    assert.equal(e.telefone_origem, 'NAO_VERIFICADO');
    assert.equal(e.email_origem, 'NAO_VERIFICADO');
  });
});

describe('repositório', () => {
  let db, repo, repoB;
  before(async () => {
    db = await bancoMigrado();
    repo = criarRepositorio(db, { organizationId: ORG_A });
    repoB = criarRepositorio(db, { organizationId: ORG_B });
  });
  after(() => db.fechar());

  test('importarConsulta grava e buscarPorCnpj devolve com tipos corretos', async () => {
    const r = await repo.importarConsulta(consultaBB());
    assert.equal(r.importada, true);
    const e = await repo.buscarPorCnpj('00.000.000/0001-91');
    assert.equal(e.razao_social, 'BANCO DO BRASIL SA');
    assert.equal(typeof e.capital_social, 'number');
    assert.equal(e.organization_id, ORG_A);
    assert.equal(e.etapa_funil, 'candidato');
    assert.equal(e.geo_precisao, 'NAO_VERIFICADO');
    assert.equal(e.indicio_medio_grande, false);
    const h = await repo.historico('00000000000191');
    assert.deepEqual(h.map((x) => [x.etapa_anterior, x.etapa, x.motivo, x.ator]), [[null, 'candidato', 'importacao', 'sistema']]);
  });

  test('importarConsulta de MEI não grava nada', async () => {
    const r = await repo.importarConsulta({ ...consultaBB(), cnpj: gerarCnpj('123123123001'), mei: true });
    assert.deepEqual(r, { importada: false, motivo: 'descartada_mei' });
    assert.equal(await repo.buscarPorCnpj(gerarCnpj('123123123001')), null);
  });

  test('Zod recusa entrada inválida antes do banco', async () => {
    await assert.rejects(repo.salvarEmpresa(empresaBase('00000000000192')), /CNPJ inválido/);
    await assert.rejects(repo.salvarEmpresa(empresaBase(gerarCnpj('555666777001'), { telefone_e164: '67 3321-0000' })), /telefone presente exige origem/);
    await assert.rejects(repo.salvarEmpresa(empresaBase(gerarCnpj('555666777001'), { porte: 'ME' })), /porte fora do escopo/);
    await assert.rejects(repo.salvarEmpresa(empresaBase(gerarCnpj('555666777001'), { razao_social: 'FULANO 12345678900' })), /contém CPF/);
    await assert.rejects(repo.salvarEmpresa(empresaBase(gerarCnpj('555666777001'), { socio_nome: 'X' })), /Unrecognized key|unrecognized/i);
  });

  test('upsert atualiza dados e preserva coordenada/etapa quando a nova consulta não as traz', async () => {
    const c = gerarCnpj('202020200001');
    await repo.salvarEmpresa(empresaBase(c, { lat: -20.46, lon: -54.62, geo_fonte: 'nominatim', geo_precisao: 'rua', dominio: 'teste.com.br', dominio_origem: 'manual' }));
    await repo.moverFunil({ cnpj: c, etapa: 'qualificado', motivo: 'tem ERP', ator: 'usuario' });
    const e = await repo.salvarEmpresa(empresaBase(c, { situacao: 'ATIVA', telefone_e164: '(67) 3321-0000', telefone_origem: 'cnpjws' }));
    assert.equal(e.situacao, 'ATIVA');
    assert.equal(e.telefone_e164, '+556733210000');
    assert.equal(e.lat, -20.46);
    assert.equal(e.geo_precisao, 'rua');
    assert.equal(e.dominio, 'teste.com.br');
    assert.equal(e.etapa_funil, 'qualificado');
    const h = await repo.historico(c);
    assert.deepEqual(h.map((x) => [x.etapa_anterior, x.etapa, x.motivo, x.ator]), [
      [null, 'candidato', 'importacao', 'sistema'],
      ['candidato', 'qualificado', 'tem ERP', 'usuario'],
    ]);
  });

  test('sinais do radar de site: só CONFIRMADO com evidência; RH confirmado vira indício de porte', async () => {
    const c = gerarCnpj('303030300001');
    await repo.salvarEmpresa(empresaBase(c));
    const gravados = await repo.registrarSinaisSite(c, {
      acessivel: true,
      urlFinal: 'https://teste.com.br/',
      erps: [{ nome: 'totvs', evidencia: '...powered by TOTVS Protheus...' }],
      rh: [{ nome: 'gupy', evidencia: 'href="https://teste.gupy.io"' }],
    });
    assert.equal(gravados.length, 2);
    assert.ok(gravados.every((s) => s.status === 'CONFIRMADO' && s.evidencia));
    const e = await repo.buscarPorCnpj(c);
    assert.equal(e.indicio_medio_grande, true);
    assert.deepEqual(e.sinais.map((s) => s.nome), ['totvs', 'gupy']);
    await assert.rejects(repo.registrarSinal({ cnpj: c, tipo: 'erp', nome: 'sap', status: 'CONFIRMADO' }), /exige evidência/);
    assert.deepEqual(await repo.registrarSinaisSite(c, { acessivel: false }), []);
  });

  test('contrato PNCP exige empresa cadastrada e é idempotente pelo número de controle', async () => {
    const c = gerarCnpj('404040400001');
    const orgao = gerarCnpj('035015090001');
    const contrato = {
      cnpj_fornecedor: c,
      numero_controle_pncp: `${orgao}-2-000123/2026`,
      orgao_cnpj: orgao,
      orgao_nome: 'MUNICIPIO TESTE',
      valor_global: 125000.5,
      data_assinatura: '2026-03-10',
      url_fonte: 'https://pncp.gov.br/app/contratos/03501509000171/2026/123',
    };
    await assert.rejects(repo.registrarContratoPncp(contrato), /não cadastrada/);
    await repo.salvarEmpresa(empresaBase(c));
    const r1 = await repo.registrarContratoPncp(contrato);
    const r2 = await repo.registrarContratoPncp({ ...contrato, valor_global: 130000 });
    assert.equal(r1.id, r2.id);
    assert.equal(r2.valor_global, 130000);
    assert.equal((await repo.buscarPorCnpj(c)).contratos_pncp, 1);
  });

  test('listarEmpresas filtra por município, CNAE e etapa', async () => {
    const c = gerarCnpj('505050500001');
    await repo.salvarEmpresa(empresaBase(c, { codigo_ibge: '5003702', cnae_principal: '1011201', cnaes_secundarios: ['4639701'] }));
    assert.deepEqual((await repo.listarEmpresas({ codigo_ibge: '5003702' })).map((e) => e.cnpj), [c]);
    assert.deepEqual((await repo.listarEmpresas({ cnae: '4639701' })).map((e) => e.cnpj), [c]);
    assert.ok((await repo.listarEmpresas({ etapa: 'qualificado' })).every((e) => e.etapa_funil === 'qualificado'));
  });
});

describe('nao_contatar (global, permanente)', () => {
  let db, repoA, repoB;
  const CNPJ_X = gerarCnpj('606060600001');
  const CNPJ_Y = gerarCnpj('707070700001');
  before(async () => {
    db = await bancoMigrado();
    repoA = criarRepositorio(db, { organizationId: ORG_A });
    repoB = criarRepositorio(db, { organizationId: ORG_B });
  });
  after(() => db.fechar());

  test('bloquear CNPJ saneia a empresa da organização e registra no funil', async () => {
    await repoA.salvarEmpresa(empresaBase(CNPJ_X, { telefone_e164: '6733334444', telefone_origem: 'brasilapi', email: 'a@x.com.br', email_origem: 'brasilapi' }));
    await repoB.salvarEmpresa(empresaBase(CNPJ_X));
    const r = await repoA.bloquearContato({ cnpj: CNPJ_X, motivo: 'titular pediu exclusão' });
    assert.equal(r.empresas_saneadas, 1);
    const { rows } = await db.query(
      'SELECT telefone_e164, telefone_origem, email, etapa_funil FROM prospeccao.empresas WHERE cnpj = $1 AND organization_id = $2',
      [CNPJ_X, ORG_A]
    );
    assert.deepEqual(rows[0], { telefone_e164: null, telefone_origem: 'BLOQUEADO_LGPD', email: null, etapa_funil: 'bloqueado_lgpd' });
    const h = await repoA.historico(CNPJ_X);
    assert.equal(h.at(-1).etapa, 'bloqueado_lgpd');
    assert.match(h.at(-1).motivo, /nao_contatar/);
  });

  test('o bloqueio é global: a outra organização deixa de ver e não consegue reimportar', async () => {
    assert.equal(await repoB.buscarPorCnpj(CNPJ_X), null);
    assert.deepEqual(await repoB.estaBloqueado({ cnpj: CNPJ_X }), { bloqueado: true, por: ['cnpj'] });
    const novaOrg = criarRepositorio(db, { organizationId: '00000000-0000-4000-8000-0000000000cc' });
    await assert.rejects(novaOrg.salvarEmpresa(empresaBase(CNPJ_X)), /nao_contatar.*importação recusada/);
  });

  test('telefone bloqueado é gravado como NULL / BLOQUEADO_LGPD em qualquer organização', async () => {
    await repoA.bloquearContato({ telefone: '(67) 99999-1111', motivo: 'pedido por telefone' });
    const e = await repoB.salvarEmpresa(empresaBase(CNPJ_Y, { telefone_e164: '67999991111', telefone_origem: 'site' }));
    assert.equal(e.telefone_e164, null);
    assert.equal(e.telefone_origem, 'BLOQUEADO_LGPD');
    assert.deepEqual(await repoB.estaBloqueado({ telefone: '+5567999991111' }), { bloqueado: true, por: ['telefone'] });
  });

  test('ninguém altera nem apaga a lista (app sem privilégio; dono barrado por gatilho)', async () => {
    await assert.rejects(comoApp(db, ORG_A, (tx) => tx.query('DELETE FROM prospeccao.nao_contatar')), /permission denied/);
    await assert.rejects(comoApp(db, ORG_A, (tx) => tx.query(`UPDATE prospeccao.nao_contatar SET motivo = 'x'`)), /permission denied/);
    await assert.rejects(db.query('DELETE FROM prospeccao.nao_contatar'), /somente-inserção/);
    await assert.rejects(db.query('TRUNCATE prospeccao.nao_contatar'), /somente-inserção/);
    const { rows } = await db.query('SELECT count(*)::int n FROM prospeccao.nao_contatar');
    assert.equal(rows[0].n, 2);
  });

  test('bloquear de novo é idempotente e aceita alvo novo junto de alvo já bloqueado', async () => {
    await repoA.bloquearContato({ cnpj: CNPJ_X, telefone: '6732221111', motivo: 'reforço' });
    const { rows } = await db.query('SELECT count(*)::int n FROM prospeccao.nao_contatar');
    assert.equal(rows[0].n, 3);
  });

  test('exige ao menos um alvo', async () => {
    await assert.rejects(repoA.bloquearContato({ motivo: 'x' }), /informe cnpj e\/ou telefone/);
  });
});
