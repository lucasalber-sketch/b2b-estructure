// Isolamento por organization_id garantido pelo RLS (FORCE) do banco.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bancoMigrado, comoApp, inserirCru, gerarCnpj, ORG_A, ORG_B } from './ajuda-db.js';
import { criarRepositorio } from '../../src/db/repositorio.js';

const CA = gerarCnpj('100200300001');
const CB = gerarCnpj('400500600001');

describe('isolamento entre organizações (RLS)', () => {
  let db;
  before(async () => {
    db = await bancoMigrado();
    await comoApp(db, ORG_A, (tx) => inserirCru(tx, ORG_A, CA));
    await comoApp(db, ORG_B, (tx) => inserirCru(tx, ORG_B, CB));
  });
  after(() => db.fechar());

  test('cada organização só enxerga as próprias empresas', async () => {
    const a = await comoApp(db, ORG_A, (tx) => tx.query('SELECT cnpj FROM prospeccao.empresas'));
    const b = await comoApp(db, ORG_B, (tx) => tx.query('SELECT cnpj FROM prospeccao.empresas'));
    assert.deepEqual(a.rows.map((r) => r.cnpj), [CA]);
    assert.deepEqual(b.rows.map((r) => r.cnpj), [CB]);
  });

  test('sem app.organization_id o papel do app não vê nada', async () => {
    const r = await comoApp(db, null, (tx) => tx.query('SELECT count(*)::int n FROM prospeccao.empresas'));
    assert.equal(r.rows[0].n, 0);
    const h = await comoApp(db, null, (tx) => tx.query('SELECT count(*)::int n FROM prospeccao.funil_historico'));
    assert.equal(h.rows[0].n, 0);
  });

  test('não é possível gravar linha em nome de outra organização', async () => {
    await assert.rejects(
      comoApp(db, ORG_A, (tx) => inserirCru(tx, ORG_B, gerarCnpj('999888770001'))),
      /row-level security/
    );
  });

  test('UPDATE na outra organização não afeta nenhuma linha', async () => {
    const r = await comoApp(db, ORG_A, (tx) =>
      tx.query(`UPDATE prospeccao.empresas SET situacao = 'HACK' WHERE cnpj = $1`, [CB])
    );
    assert.equal(r.affectedRows ?? r.rowCount, 0);
    const { rows } = await db.query('SELECT situacao FROM prospeccao.empresas WHERE cnpj = $1', [CB]);
    assert.equal(rows[0].situacao, null);
  });

  test('o repositório herda o isolamento', async () => {
    const repoA = criarRepositorio(db, { organizationId: ORG_A });
    assert.equal(await repoA.buscarPorCnpj(CB), null);
    assert.deepEqual((await repoA.listarEmpresas()).map((e) => e.cnpj), [CA]);
    await assert.rejects(repoA.moverFunil({ cnpj: CB, etapa: 'qualificado', motivo: 'x' }), /não cadastrada/);
  });

  test('organization_id inválido é recusado antes de tocar o banco', () => {
    assert.throws(() => criarRepositorio(db, { organizationId: 'org-1' }), /UUID/);
  });
});
