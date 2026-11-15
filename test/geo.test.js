import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { geocodificar, limparCep } from '../src/conectores/geo.js';
import { ambienteIsolado, simularFetch } from './helpers.js';

const cepComCoord = {
  cep: '79002075', state: 'MS', city: 'Campo Grande', neighborhood: 'Centro', street: 'Avenida Afonso Pena',
  service: 'open-cep', ibge: { city: '5002704', state: '50' },
  location: { type: 'Point', coordinates: { longitude: '-54.64639', latitude: '-20.44278' } },
};
const cepSemCoord = { ...cepComCoord, location: { type: 'Point', coordinates: {} } };
const nominatimRua = [{ lat: '-20.4600', lon: '-54.6100', display_name: 'Avenida Afonso Pena, Campo Grande' }];

describe('geocodificar (fetch simulado)', () => {
  let limpar, fetchSim;
  beforeEach(() => (limpar = ambienteIsolado()));
  afterEach(() => {
    fetchSim?.restaurar();
    limpar();
  });

  test('usa coordenadas da BrasilAPI e grava cache', async () => {
    fetchSim = simularFetch([['brasilapi.com.br/api/cep/v2/79002075', { json: cepComCoord }]]);
    const r = await geocodificar({ cep: '79002-075' });
    assert.equal(r.fonte, 'brasilapi');
    assert.equal(r.lat, -20.44278);
    assert.equal(r.lon, -54.64639);
    assert.equal(r.precisao, 'cep_aproximado');
    assert.equal(r.cidade, 'Campo Grande');
    assert.equal((await geocodificar({ cep: '79002075' })).doCache, true);
    assert.equal(fetchSim.chamadas.length, 1);
  });

  test('sem coordenadas na BrasilAPI → fallback Nominatim pela rua', async () => {
    fetchSim = simularFetch([
      ['brasilapi.com.br', { json: cepSemCoord }],
      ['nominatim.openstreetmap.org', { json: nominatimRua }],
    ]);
    const r = await geocodificar({ cep: '79002075' });
    assert.equal(r.fonte, 'nominatim');
    assert.equal(r.precisao, 'endereco');
    assert.equal(r.lat, -20.46);
    assert.match(fetchSim.chamadas[1], /street=Avenida\+Afonso\+Pena/);
  });

  test('precisao_rua prefere Nominatim mesmo com coordenada da BrasilAPI', async () => {
    fetchSim = simularFetch([
      ['brasilapi.com.br', { json: cepComCoord }],
      ['nominatim.openstreetmap.org', { json: nominatimRua }],
    ]);
    const r = await geocodificar({ cep: '79002075', precisaoRua: true });
    assert.equal(r.fonte, 'nominatim');
    assert.equal(r.precisao, 'endereco');
  });

  test('BrasilAPI fora do ar e Nominatim sem resultado → encontrado=false', async () => {
    fetchSim = simularFetch([
      ['brasilapi.com.br', { status: 500 }],
      ['nominatim.openstreetmap.org', { json: [] }],
    ]);
    const r = await geocodificar({ cep: '79002075' });
    assert.equal(r.encontrado, false);
  });

  test('endereço livre vai direto ao Nominatim', async () => {
    fetchSim = simularFetch([['nominatim.openstreetmap.org', { json: nominatimRua }]]);
    const r = await geocodificar({ endereco: 'Av. Afonso Pena, Campo Grande, MS' });
    assert.equal(r.fonte, 'nominatim');
    assert.equal(r.lon, -54.61);
  });

  test('CEP inválido', async () => {
    assert.throws(() => limparCep('123'), /CEP inválido/);
    await assert.rejects(geocodificar({}), /Informe/);
  });
});
