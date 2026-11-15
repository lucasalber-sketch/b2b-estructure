// Regras gravadas no próprio banco (testadas com SQL cru, sem passar pelo repositório/Zod).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bancoMigrado, comoApp, inserirCru, gerarCnpj, ORG_A, ORG_B } from './ajuda-db.js';

const C1 = gerarCnpj('112223330001');
const C2 = gerarCnpj('445556660001');

describe('schema prospeccao (constraints do banco)', () => {
  let db;
  before(async () => { db = await bancoMigrado(); });
  after(() => db.fechar());

  test('função cnpj_valido confere com o validador JS (numérico e alfanumérico)', async () => {
    const { rows } = await db.query(
      `SELECT prospeccao.cnpj_valido('00000000000191') a, prospeccao.cnpj_valido('12ABC34501DE35') b,
              prospeccao.cnpj_valido('00000000000192') c, prospeccao.cnpj_valido('11111111111111') d,
              prospeccao.cnpj_valido('12ABC34501DEAB') e`
    );
    assert.deepEqual(rows[0], { a: true, b: true, c: false, d: false, e: false });
  });

  test('CNPJ com DV inválido é recusado pelo banco', async () => {
    await assert.rejects(
      comoApp(db, ORG_A, (tx) => inserirCru(tx, ORG_A, '00000000000192')),
      /cnpj_check|check constraint/
    );
  });

  test('CNPJ único por organização; o mesmo CNPJ pode existir em outra organização', async () => {
    await comoApp(db, ORG_A, (tx) => inserirCru(tx, ORG_A, C1));
    await assert.rejects(comoApp(db, ORG_A, (tx) => inserirCru(tx, ORG_A, C1)), /empresas_cnpj_por_org/);
    await comoApp(db, ORG_B, (tx) => inserirCru(tx, ORG_B, C1));
    const { rows } = await db.query('SELECT count(*)::int n FROM prospeccao.empresas WHERE cnpj = $1', [C1]);
    assert.equal(rows[0].n, 2);
  });

  test('anti-invenção: telefone/e-mail/geo presentes exigem origem', async () => {
    const casos = [
      [{ telefone_e164: '+556733210000' }, /empresas_telefone_com_origem/],
      [{ telefone_origem: 'brasilapi' }, /empresas_telefone_com_origem/],
      [{ email: 'contato@teste.com.br' }, /empresas_email_com_origem/],
      [{ lat: -20.4, lon: -54.6 }, /empresas_geo_com_origem/],
      [{ lat: -20.4, lon: -54.6, geo_fonte: 'nominatim' }, /empresas_geo_com_origem/],
    ];
    for (const [extra, erro] of casos) {
      await assert.rejects(comoApp(db, ORG_A, (tx) => inserirCru(tx, ORG_A, C2, extra)), erro, JSON.stringify(extra));
    }
    await comoApp(db, ORG_A, (tx) =>
      inserirCru(tx, ORG_A, C2, {
        telefone_e164: '+556733210000', telefone_origem: 'brasilapi',
        lat: -20.4, lon: -54.6, geo_fonte: 'nominatim', geo_precisao: 'rua',
      })
    );
  });

  test('não há coluna para número de funcionários', async () => {
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'prospeccao' AND column_name ~ 'funcion|empregad|colaborad'`
    );
    assert.deepEqual(rows, []);
  });

  test('LGPD: MEI, Empresário Individual, porte ME e natureza não empresarial são recusados', async () => {
    const casos = [
      { mei: true },
      { natureza_juridica_codigo: '2135' },
      { natureza_juridica_codigo: '3999' },
      { porte: 'ME' },
    ];
    for (const extra of casos) {
      await assert.rejects(comoApp(db, ORG_A, (tx) => inserirCru(tx, ORG_A, gerarCnpj('777888990001'), extra)), /check/, JSON.stringify(extra));
    }
  });

  test('LGPD: razão social contendo CPF é recusada', async () => {
    for (const razao of ['JOAO DA SILVA 12345678900', 'MARIA 123.456.789-00 COMERCIO']) {
      await assert.rejects(
        comoApp(db, ORG_A, (tx) => inserirCru(tx, ORG_A, gerarCnpj('777888990001'), { razao_social: razao })),
        /razao_social_check|check/
      );
    }
  });

  test('LGPD: nenhuma coluna de sócio/QSA/CPF/nome de pessoa em todo o schema', async () => {
    const { rows } = await db.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'prospeccao'
          AND column_name ~* '(cpf|socio|sócio|qsa|nome_pessoa|responsavel|titular|representante|administrador)'`
    );
    assert.deepEqual(rows, []);
  });

  test('sinal CONFIRMADO sem evidência literal é recusado', async () => {
    await assert.rejects(
      comoApp(db, ORG_A, async (tx) => {
        const { rows } = await tx.query('SELECT id FROM prospeccao.empresas WHERE cnpj = $1', [C1]);
        await tx.query(
          `INSERT INTO prospeccao.empresa_sinais_erp (organization_id, empresa_id, tipo, nome, erp_fonte, status)
           VALUES ($1, $2, 'erp', 'totvs', 'site_radar_html', 'CONFIRMADO')`,
          [ORG_A, rows[0].id]
        );
      }),
      /sinais_confirmado_com_evidencia/
    );
  });

  test('FK composta impede ligar contrato/sinal a empresa de outra organização', async () => {
    const { rows } = await db.query('SELECT id FROM prospeccao.empresas WHERE cnpj = $1 AND organization_id = $2', [C1, ORG_B]);
    await assert.rejects(
      comoApp(db, ORG_A, (tx) =>
        tx.query(
          `INSERT INTO prospeccao.empresa_sinais_erp (organization_id, empresa_id, tipo, nome, erp_fonte)
           VALUES ($1, $2, 'erp', 'sap', 'manual')`,
          [ORG_A, rows[0].id]
        )
      ),
      /sinais_empresa_fk|foreign key/
    );
  });

  test('funil_historico é somente-inserção (inclusive para o dono)', async () => {
    const { rows } = await db.query('SELECT count(*)::int n FROM prospeccao.funil_historico');
    assert.ok(rows[0].n > 0, 'gatilho grava a etapa inicial');
    await assert.rejects(comoApp(db, ORG_A, (tx) => tx.query(`UPDATE prospeccao.funil_historico SET motivo = 'x'`)), /permission denied/);
    await assert.rejects(comoApp(db, ORG_A, (tx) => tx.query('DELETE FROM prospeccao.funil_historico')), /permission denied/);
    await assert.rejects(db.query('DELETE FROM prospeccao.funil_historico'), /somente-inserção/);
    await assert.rejects(db.query('TRUNCATE prospeccao.funil_historico CASCADE'), /somente-inserção/);
  });

  test('o papel do app não tem DELETE em nenhuma tabela', async () => {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.role_table_grants
        WHERE grantee = 'prospeccao_app' AND table_schema = 'prospeccao' AND privilege_type IN ('DELETE', 'TRUNCATE')`
    );
    assert.deepEqual(rows, []);
  });
});
