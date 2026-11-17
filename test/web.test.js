// Testes da Etapa 4: qualificador RevOps e servidor HTTP/API sobre PGlite.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { criarServidorWeb } from '../src/web/servidor.js';
import { criarRepositorio } from '../src/db/repositorio.js';
import { qualificarEmpresa, classificarSetor } from '../src/servicos/qualificador.js';
import { bancoMigrado, gerarCnpj, empresaBase, ORG_A } from './db/ajuda-db.js';

const CNPJ_AGRO = gerarCnpj('770000010001');

describe('Etapa 4 — Qualificador RevOps & Servidor Web/API', () => {
  let db, repo, server, baseUrl;

  before(async () => {
    db = await bancoMigrado();
    repo = criarRepositorio(db, { organizationId: ORG_A });
    await repo.salvarEmpresa(
      empresaBase(CNPJ_AGRO, {
        razao_social: 'AGROINDUSTRIAL CAMPO GRANDE SA',
        porte: 'DEMAIS',
        capital_social: 15_000_000,
        data_abertura: '2015-03-10',
        cnae_principal: '0115600',
        municipio: 'Campo Grande',
        telefone_e164: '+556733219999',
        telefone_origem: 'rfb_lote',
        dominio: 'agrocg.com.br',
        dominio_origem: 'email_rfb',
      })
    );
    await repo.registrarSinal({
      cnpj: CNPJ_AGRO,
      tipo: 'erp',
      nome: 'totvs',
      erp_fonte: 'site_radar_html',
      status: 'CONFIRMADO',
      evidencia: 'Portal TOTVS Protheus',
      url_evidencia: 'https://agrocg.com.br/',
    });

    server = criarServidorWeb({ conexao: db, organizationId: ORG_A });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    await db.fechar();
  });

  test('classificarSetor e qualificarEmpresa geram score, fatores e tese ERP', () => {
    assert.equal(classificarSetor('0115600').id, 'agro');
    assert.equal(classificarSetor('4930202').id, 'logistica');

    const q = qualificarEmpresa({
      porte: 'DEMAIS',
      capital_social: 15_000_000,
      data_abertura: '2015-03-10',
      cnae_principal: '0115600',
      municipio: 'Campo Grande',
      telefone_e164: '+556733219999',
      telefone_repeticoes: 1,
      sinais: [{ tipo: 'erp', nome: 'totvs' }],
      contratos_pncp: 1,
    });
    assert.ok(q.score >= 70);
    assert.match(q.cenario_erp, /TOTVS/);
    assert.ok(q.roteiro_whatsapp.includes('Campo Grande'));
  });

  test('GET /api/resumo, /api/empresas, /api/empresas/:cnpj e POST /funil funcionam ponta a ponta', async () => {
    const resHtml = await fetch(`${baseUrl}/`);
    assert.equal(resHtml.status, 200);
    assert.match(await resHtml.text(), /b2b-estructure/);

    const resumo = await (await fetch(`${baseUrl}/api/resumo`)).json();
    assert.equal(resumo.kpis.total_empresas, 1);
    assert.equal(resumo.kpis.demais, 1);
    assert.equal(resumo.sinais_confirmados.length, 1);

    const lista = await (await fetch(`${baseUrl}/api/empresas?setor=agro`)).json();
    assert.equal(lista.total, 1);
    assert.equal(lista.empresas[0].cnpj, CNPJ_AGRO);
    assert.ok(lista.empresas[0].qualificacao.score >= 70);

    const dossie = await (await fetch(`${baseUrl}/api/empresas/${CNPJ_AGRO}`)).json();
    assert.equal(dossie.razao_social, 'AGROINDUSTRIAL CAMPO GRANDE SA');
    assert.equal(dossie.sinais[0].nome, 'totvs');

    const mov = await (
      await fetch(`${baseUrl}/api/empresas/${CNPJ_AGRO}/funil`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ etapa: 'qualificado', motivo: 'teste api' }),
      })
    ).json();
    assert.equal(mov.etapa_funil, 'qualificado');

    // Teste de exportação CSV
    const resCsv = await fetch(`${baseUrl}/api/exportar?setor=agro`);
    assert.equal(resCsv.status, 200);
    assert.equal(resCsv.headers.get('content-type'), 'text/csv; charset=utf-8');
    const buf = Buffer.from(await resCsv.arrayBuffer());
    // BOM UTF-8 (0xEF, 0xBB, 0xBF)
    assert.equal(buf[0], 0xef);
    assert.equal(buf[1], 0xbb);
    assert.equal(buf[2], 0xbf);
    const csvTexto = buf.toString('utf-8');
    assert.ok(csvTexto.includes('AGROINDUSTRIAL CAMPO GRANDE SA'));
    assert.ok(csvTexto.includes('ERP: totvs'));

    // Teste de resumo forçando refresh
    const resAtualizado = await (await fetch(`${baseUrl}/api/resumo?refresh=1`)).json();
    assert.equal(resAtualizado.kpis.total_empresas, 1);
  });
});
