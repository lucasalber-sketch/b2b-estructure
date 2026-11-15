import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { criarConexao } from '../../src/db/conexao.js';
import { aplicarMigracoes, statusMigracoes, DIR_MIGRACOES } from '../../src/db/migracoes.js';
import { diagnosticar, TABELAS } from '../../src/db/status.js';

const TODAS = ['001_inicial.sql', '002_ingestao_e_enriquecimento.sql'];

describe('migrações', () => {
  test('aplica 001 uma vez; a 2ª execução não faz nada', async () => {
    const db = await criarConexao({ memoria: true });
    try {
      assert.deepEqual((await statusMigracoes(db)).pendentes, TODAS);
      assert.deepEqual((await aplicarMigracoes(db)).aplicadas, TODAS);
      assert.deepEqual((await aplicarMigracoes(db)).aplicadas, []);
      const s = await statusMigracoes(db);
      assert.deepEqual(s.pendentes, []);
      assert.equal(s.aplicadas[0].nome, '001_inicial.sql');
    } finally {
      await db.fechar();
    }
  });

  test('--dry-run não grava nada', async () => {
    const db = await criarConexao({ memoria: true });
    try {
      const r = await aplicarMigracoes(db, { simular: true });
      assert.deepEqual(r.simuladas, TODAS);
      assert.deepEqual((await statusMigracoes(db)).pendentes, TODAS);
    } finally {
      await db.fechar();
    }
  });

  test('migração editada depois de aplicada → erro', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'migracoes-'));
    const db = await criarConexao({ memoria: true });
    try {
      copyFileSync(path.join(DIR_MIGRACOES, '001_inicial.sql'), path.join(dir, '001_inicial.sql'));
      await aplicarMigracoes(db, { dir });
      writeFileSync(path.join(dir, '001_inicial.sql'), '-- alterada\nSELECT 1;');
      await assert.rejects(() => aplicarMigracoes(db, { dir }), /alterada depois de aplicada/);
      await assert.rejects(() => statusMigracoes(db, { dir }), /sha256 diverge/);
    } finally {
      await db.fechar();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migração com erro é revertida por inteiro', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'migracoes-'));
    const db = await criarConexao({ memoria: true });
    try {
      writeFileSync(path.join(dir, '001_quebrada.sql'), 'CREATE TABLE prospeccao.parcial (x int);\nSELECT * FROM nao_existe;');
      await assert.rejects(() => aplicarMigracoes(db, { dir }));
      const { rows } = await db.query(`SELECT to_regclass('prospeccao.parcial') AS t`);
      assert.equal(rows[0].t, null);
      assert.deepEqual((await statusMigracoes(db, { dir })).pendentes, ['001_quebrada.sql']);
    } finally {
      await db.fechar();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('diagnosticar (db_status) reporta versão, migrações e contagens', async () => {
    const db = await criarConexao({ memoria: true });
    try {
      const antes = await diagnosticar(db);
      assert.equal(antes.conectado, true);
      assert.equal(antes.em_dia, false);
      await aplicarMigracoes(db);
      const s = await diagnosticar(db);
      assert.equal(s.tipo, 'pglite');
      assert.match(s.servidor, /^PostgreSQL \d+/);
      assert.equal(s.em_dia, true);
      assert.deepEqual(Object.keys(s.contagens), TABELAS);
      assert.ok(Object.values(s.contagens).every((n) => n === 0));
    } finally {
      await db.fechar();
    }
  });
});
