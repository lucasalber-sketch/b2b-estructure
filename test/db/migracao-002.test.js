// 002_ingestao_e_enriquecimento: origem rfb_lote, domínio com origem/confirmação, cnpj_basico,
// controle de enriquecimento, ingestao_execucoes e gravação em lote.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bancoMigrado, comoApp, inserirCru, gerarCnpj, empresaBase, ORG_A, ORG_B } from './ajuda-db.js';
import { criarRepositorio } from '../../src/db/repositorio.js';

describe('migração 002', () => {
  let db, repo, repoB;
  before(async () => {
    db = await bancoMigrado();
    repo = criarRepositorio(db, { organizationId: ORG_A });
    repoB = criarRepositorio(db, { organizationId: ORG_B });
  });
  after(() => db.fechar());

  test("contato com origem 'rfb_lote' é aceito", async () => {
    const e = await repo.salvarEmpresa(empresaBase(gerarCnpj('810000000001'), {
      cnpj_origem: 'rfb_lote', fonte_descoberta: 'rfb_lote',
      telefone_e164: '6733215555', telefone_origem: 'rfb_lote', email: 'comercial@empresa.com.br', email_origem: 'rfb_lote',
    }));
    assert.equal(e.telefone_origem, 'rfb_lote');
    assert.equal(e.email_origem, 'rfb_lote');
  });

  test('cnpj_basico é gerado a partir do CNPJ', async () => {
    const c = gerarCnpj('820000000001');
    const e = await repo.salvarEmpresa(empresaBase(c));
    assert.equal(e.cnpj_basico, c.slice(0, 8));
  });

  test('domínio exige origem (banco e Zod); confirmado exige domínio', async () => {
    const c = gerarCnpj('830000000001');
    await assert.rejects(comoApp(db, ORG_A, (tx) => inserirCru(tx, ORG_A, c, { dominio: 'x.com.br' })), /empresas_dominio_com_origem/);
    await assert.rejects(comoApp(db, ORG_A, (tx) => inserirCru(tx, ORG_A, c, { dominio_confirmado: true })), /empresas_dominio_confirmado_exige_dominio/);
    await assert.rejects(repo.salvarEmpresa(empresaBase(c, { dominio: 'x.com.br' })), /dominio_origem/);
  });

  test('site_status exige data do enriquecimento', async () => {
    await assert.rejects(
      comoApp(db, ORG_A, (tx) => inserirCru(tx, ORG_A, gerarCnpj('840000000001'), { site_status: 'inacessivel' })),
      /empresas_site_status_com_data/
    );
  });

  test('upsert mantém dominio_confirmado no mesmo domínio e zera quando o domínio muda', async () => {
    const c = gerarCnpj('850000000001');
    await repo.salvarEmpresa(empresaBase(c, { dominio: 'a.com.br', dominio_origem: 'email_rfb' }));
    await db.query(`UPDATE prospeccao.empresas SET dominio_confirmado = true WHERE cnpj = $1`, [c]);
    let e = await repo.salvarEmpresa(empresaBase(c, { dominio: 'a.com.br', dominio_origem: 'email_rfb' }));
    assert.equal(e.dominio_confirmado, true);
    e = await repo.salvarEmpresa(empresaBase(c)); // nova consulta sem domínio: preserva
    assert.equal(e.dominio, 'a.com.br');
    assert.equal(e.dominio_confirmado, true);
    e = await repo.salvarEmpresa(empresaBase(c, { dominio: 'b.com.br', dominio_origem: 'email_rfb' }));
    assert.equal(e.dominio_confirmado, false);
  });

  test('salvarEmpresas: lote grava válidas e relata inválidas e bloqueadas', async () => {
    const bloqueado = gerarCnpj('860000000001');
    await repo.bloquearContato({ cnpj: bloqueado, motivo: 'teste' });
    const boas = Array.from({ length: 7 }, (_, i) => empresaBase(gerarCnpj(`87000000${String(i + 1).padStart(4, '0')}`)));
    const r = await repo.salvarEmpresas([
      ...boas,
      empresaBase(bloqueado),
      empresaBase('00000000000192'),
      empresaBase(gerarCnpj('880000000001'), { porte: 'ME' }),
    ]);
    assert.equal(r.gravadas, 7);
    assert.deepEqual(r.recusadas.map((x) => x.motivo.split(':')[0]).sort(), ['cnpj', 'nao_contatar', 'porte']);
    assert.equal((await repo.listarEmpresas({ limite: 1000 })).filter((e) => e.cnpj.startsWith('87')).length, 7);
  });

  test('salvarEmpresas: falha no banco dentro do lote isola só a linha problemática', async () => {
    // Simula a corrida: o CNPJ entra em nao_contatar (por outra org) depois da checagem prévia.
    // Só o gatilho do banco barra a linha; o lote cai para gravação linha a linha e o resto entra.
    const ok1 = gerarCnpj('890000000001');
    const ruim = gerarCnpj('890000000002');
    const ok2 = gerarCnpj('890000000003');
    const original = repo.cnpjsBloqueados;
    repo.cnpjsBloqueados = async () => new Set(); // pula a checagem prévia para forçar o erro no banco
    await repoB.bloquearContato({ cnpj: ruim, motivo: 'pedido do titular' });
    try {
      const r = await repo.salvarEmpresas([empresaBase(ok1), empresaBase(ruim), empresaBase(ok2)]);
      assert.equal(r.gravadas, 2);
      assert.equal(r.recusadas.length, 1);
      assert.match(r.recusadas[0].motivo, /nao_contatar/);
    } finally {
      repo.cnpjsBloqueados = original;
    }
  });

  test('salvarEmpresas: 1.200 empresas em lotes multi-linha, com CNPJ repetido no mesmo lote', async () => {
    const lista = Array.from({ length: 1200 }, (_, i) => empresaBase(gerarCnpj(`91${String(i).padStart(6, '0')}0001`)));
    const repetido = gerarCnpj('910000050001');
    lista.push(empresaBase(repetido, { razao_social: 'VERSAO FINAL LTDA' }));
    const r = await repo.salvarEmpresas(lista);
    assert.equal(r.gravadas, 1200);
    assert.deepEqual(r.recusadas, []);
    assert.equal((await repo.buscarPorCnpj(repetido)).razao_social, 'VERSAO FINAL LTDA');
    const { rows } = await db.query(`SELECT count(*)::int n FROM prospeccao.empresas WHERE organization_id = $1 AND cnpj LIKE '91%'`, [ORG_A]);
    assert.equal(rows[0].n, 1200);
    // reimportar o mesmo lote é idempotente (upsert)
    assert.equal((await repo.salvarEmpresas(lista)).gravadas, 1200);
  });

  test('ingestao_execucoes: ciclo de vida, checkpoint e isolamento', async () => {
    const id = await repo.iniciarExecucao({ tipo: 'receita', parametros: { mes: '2026-10' } });
    let r = await repo.atualizarExecucao(id, { checkpoint: { arquivo: 'Estabelecimentos3.zip' }, contadores: { lidas: 10 } });
    assert.equal(r.status, 'em_andamento');
    assert.deepEqual(r.checkpoint, { arquivo: 'Estabelecimentos3.zip' });
    r = await repo.atualizarExecucao(id, { status: 'concluida' });
    assert.equal(r.status, 'concluida');
    assert.deepEqual(r.contadores, { lidas: 10 });
    const ultima = await repo.ultimaExecucao('receita');
    assert.equal(ultima.id, id);
    assert.ok(ultima.finalizado_em);
    assert.equal(await repoB.ultimaExecucao('receita'), null);
    await assert.rejects(repoB.atualizarExecucao(id, { status: 'falhou' }), /não encontrada/);
  });
});
