import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { listarMunicipios, listarSecoesCnae, listarClassesCnae, normalizarUf } from '../src/conectores/ibge.js';
import { ambienteIsolado, simularFetch, fixture } from './helpers.js';

describe('IBGE (fetch simulado)', () => {
  let limpar, fetchSim;
  beforeEach(() => {
    limpar = ambienteIsolado();
    fetchSim = simularFetch([
      ['/localidades/estados/MS/municipios', { json: fixture('ibge-municipios-ms.json') }],
      ['/cnae/secoes', { json: fixture('ibge-cnae-secoes.json') }],
      ['/cnae/classes', { json: fixture('ibge-cnae-classes.json') }],
    ]);
  });
  afterEach(() => {
    fetchSim.restaurar();
    limpar();
  });

  test('municípios de MS (padrão) = 79, normalizados e em cache', async () => {
    const r = await listarMunicipios();
    assert.equal(r.uf, 'MS');
    assert.equal(r.total, 79);
    const cg = r.municipios.find((m) => m.nome === 'Campo Grande');
    assert.equal(cg.id, 5002704);
    assert.ok(cg.mesorregiao);
    const r2 = await listarMunicipios('ms');
    assert.equal(r2.doCache, true);
    assert.equal(fetchSim.chamadas.length, 1);
  });

  test('seções CNAE = 21', async () => {
    const r = await listarSecoesCnae();
    assert.equal(r.total, 21);
    assert.deepEqual(Object.keys(r.secoes[0]), ['id', 'descricao']);
  });

  test('classes CNAE filtradas por seção', async () => {
    const r = await listarClassesCnae('g');
    assert.ok(r.total > 0);
    assert.ok(r.classes.every((c) => c.secao === 'G'));
  });

  test('entradas inválidas', async () => {
    assert.throws(() => normalizarUf('XX'), /UF inválida/);
    await assert.rejects(listarClassesCnae('Z'), /Seção CNAE inválida/);
  });
});
