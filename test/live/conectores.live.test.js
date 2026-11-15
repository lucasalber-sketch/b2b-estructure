// Testes AO VIVO contra as APIs públicas reais. Só rodam com LIVE=1 (npm run test:live).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { listarMunicipios, listarSecoesCnae, listarClassesCnae } from '../../src/conectores/ibge.js';
import { consultarCnpj } from '../../src/conectores/cnpj.js';
import { geocodificar } from '../../src/conectores/geo.js';
import { inspecionarSite } from '../../src/conectores/site-radar.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const LIVE = process.env.LIVE === '1';
const opts = { skip: !LIVE && 'defina LIVE=1 para rodar', timeout: 90_000 };
const mostrar = (rotulo, obj) => console.log(`\n── ${rotulo} ──\n${JSON.stringify(obj, null, 2)}`);

describe('AO VIVO', { skip: opts.skip }, () => {
  let dir;
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mcp-live-')); // cache vazio → força chamada real
    process.env.CACHE_DIR = dir;
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test('IBGE: MS tem 79 municípios', opts, async () => {
    const r = await listarMunicipios('MS');
    assert.equal(r.total, 79);
    assert.equal(r.doCache, false);
    mostrar('IBGE municípios MS (5 primeiros)', { total: r.total, amostra: r.municipios.slice(0, 5).map((m) => m.nome) });
  });

  test('IBGE: CNAE 21 seções e classes da seção C', opts, async () => {
    const s = await listarSecoesCnae();
    assert.equal(s.total, 21);
    const c = await listarClassesCnae('C');
    assert.ok(c.total > 50);
    mostrar('IBGE CNAE', { secoes: s.total, classesSecaoC: c.total, exemplo: c.classes[0] });
  });

  test('CNPJ: Banco do Brasil (BrasilAPI + IE via CNPJ.ws)', opts, async () => {
    const r = await consultarCnpj('00.000.000/0001-91', { ignorarCache: true });
    assert.equal(r.encontrado, true);
    assert.equal(r.razaoSocial, 'BANCO DO BRASIL SA');
    assert.equal(r.porte, 'DEMAIS');
    assert.ok(r.telefone, 'porte DEMAIS + S.A. deve expor telefone');
    const { cnaesSecundarios, ...resumo } = r;
    mostrar('CNPJ 00.000.000/0001-91', { ...resumo, cnaesSecundarios: cnaesSecundarios.length });
  });

  test('Geo: CEP 79002-075 (Campo Grande/MS)', opts, async () => {
    const r = await geocodificar({ cep: '79002-075' });
    assert.equal(r.encontrado, true);
    assert.equal(r.uf, 'MS');
    assert.ok(r.lat < -19 && r.lat > -22 && r.lon < -53 && r.lon > -56, 'coordenada dentro de Campo Grande');
    mostrar('Geo CEP 79002-075', r);
  });

  test('Geo: precisão de rua via Nominatim', opts, async () => {
    const r = await geocodificar({ cep: '79002-075', precisaoRua: true });
    assert.equal(r.encontrado, true);
    mostrar('Geo CEP 79002-075 (precisao_rua)', r);
  });

  test('Radar: site real (totvs.com)', opts, async () => {
    const r = await inspecionarSite('totvs.com');
    mostrar('Radar totvs.com', { ...r, erps: r.erps.map((e) => e.nome), rh: r.rh.map((e) => e.nome) });
    assert.equal(r.acessivel, true, JSON.stringify(r.avisos));
    assert.ok(r.erps.some((e) => e.nome === 'totvs'));
  });
});
