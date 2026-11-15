import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { validarCnpj, formatarCnpj, podeExporContato, normalizarBrasilApi, normalizarCnpjWs, consultarCnpj } from '../src/conectores/cnpj.js';
import { ambienteIsolado, simularFetch, fixture } from './helpers.js';

describe('validarCnpj', () => {
  test('aceita CNPJ numérico com e sem máscara', () => {
    assert.equal(validarCnpj('00000000000191').valido, true);
    assert.equal(validarCnpj('00.000.000/0001-91').valido, true);
    assert.equal(validarCnpj('11.222.333/0001-81').valido, true);
  });

  test('aceita CNPJ alfanumérico (exemplo oficial da Receita: 12.ABC.345/01DE-35)', () => {
    const v = validarCnpj('12.abc.345/01de-35');
    assert.equal(v.valido, true);
    assert.equal(v.alfanumerico, true);
    assert.equal(v.cnpj, '12ABC34501DE35');
  });

  test('rejeita DV errado, sequência repetida e formato inválido', () => {
    assert.equal(validarCnpj('00000000000192').valido, false);
    assert.equal(validarCnpj('12ABC34501DE36').valido, false);
    assert.equal(validarCnpj('11111111111111').valido, false);
    assert.equal(validarCnpj('123').valido, false);
    assert.equal(validarCnpj('12ABC34501DEAB').valido, false); // DV precisa ser numérico
  });

  test('formatarCnpj', () => {
    assert.equal(formatarCnpj('00000000000191'), '00.000.000/0001-91');
  });
});

describe('regra LGPD de contato', () => {
  test('libera DEMAIS e EPP com natureza empresarial (Ltda 2062, S.A. 2054)', () => {
    assert.equal(podeExporContato({ porte: 'DEMAIS', naturezaCodigo: '2062', mei: false }).permitido, true);
    assert.equal(podeExporContato({ porte: 'EPP', naturezaCodigo: '2054', mei: false }).permitido, true);
  });
  test('oculta ME, MEI, Empresário Individual e natureza não empresarial', () => {
    assert.equal(podeExporContato({ porte: 'ME', naturezaCodigo: '2062', mei: false }).motivo, 'oculto_porte');
    assert.equal(podeExporContato({ porte: 'EPP', naturezaCodigo: '2062', mei: true }).motivo, 'oculto_mei');
    assert.equal(podeExporContato({ porte: 'DEMAIS', naturezaCodigo: '2135', mei: false }).motivo, 'oculto_empresario_individual');
    assert.equal(podeExporContato({ porte: 'DEMAIS', naturezaCodigo: '3999', mei: false }).motivo, 'oculto_natureza_nao_empresarial');
  });
});

describe('normalização', () => {
  test('BrasilAPI → esquema comum', () => {
    const r = normalizarBrasilApi(fixture('brasilapi-cnpj-bb.json'));
    assert.equal(r.razaoSocial, 'BANCO DO BRASIL SA');
    assert.equal(r.matrizFilial, 'MATRIZ');
    assert.equal(r.situacao, 'ATIVA');
    assert.equal(r.porte, 'DEMAIS');
    assert.equal(r.naturezaJuridica.codigo, '2038');
    assert.equal(r.cnaePrincipal.codigo, '6422100');
    assert.equal(r.capitalSocial, 120000000000);
    assert.equal(r.telefone, '(61) 3493-9002');
    assert.equal(r.inscricoesEstaduais, null);
    assert.equal(r.endereco.uf, 'DF');
  });

  test('CNPJ.ws → mesmo esquema, com IE', () => {
    const a = normalizarBrasilApi(fixture('brasilapi-cnpj-bb.json'));
    const b = normalizarCnpjWs(fixture('cnpjws-bb.json'));
    for (const campo of ['cnpj', 'razaoSocial', 'matrizFilial', 'situacao', 'dataAbertura', 'porte', 'capitalSocial', 'telefone']) {
      assert.deepEqual(b[campo], a[campo], `campo ${campo}`);
    }
    assert.deepEqual(b.cnaePrincipal, a.cnaePrincipal);
    assert.deepEqual(b.inscricoesEstaduais, [{ inscricao: '0809427800174', uf: 'DF', ativa: true }]);
  });

  test('oculta telefone quando a empresa é MEI', () => {
    const d = { ...fixture('brasilapi-cnpj-bb.json'), opcao_pelo_mei: true, codigo_porte: 1 };
    const r = normalizarBrasilApi(d);
    assert.equal(r.telefone, null);
    assert.equal(r.email, null);
    assert.equal(r.contatoMotivo, 'oculto_mei');
  });
});

describe('consultarCnpj (fetch simulado)', () => {
  let limpar, fetchSim;
  beforeEach(() => (limpar = ambienteIsolado()));
  afterEach(() => {
    fetchSim?.restaurar();
    limpar();
  });

  test('BrasilAPI + IE do CNPJ.ws, e segunda chamada vem do cache', async () => {
    fetchSim = simularFetch([
      ['brasilapi.com.br/api/cnpj', { json: fixture('brasilapi-cnpj-bb.json') }],
      ['publica.cnpj.ws', { json: fixture('cnpjws-bb.json') }],
    ]);
    const r = await consultarCnpj('00.000.000/0001-91');
    assert.equal(r.encontrado, true);
    assert.equal(r.fonte, 'brasilapi+cnpjws');
    assert.equal(r.inscricoesEstaduais.length, 1);
    assert.equal(r.doCache, false);
    const r2 = await consultarCnpj('00000000000191');
    assert.equal(r2.doCache, true);
    assert.equal(fetchSim.chamadas.length, 2);
  });

  test('fallback para CNPJ.ws quando BrasilAPI falha (5xx)', async () => {
    fetchSim = simularFetch([
      ['brasilapi.com.br/api/cnpj', { status: 503 }],
      ['publica.cnpj.ws', { json: fixture('cnpjws-bb.json') }],
    ]);
    const r = await consultarCnpj('00000000000191');
    assert.equal(r.fonte, 'cnpjws');
    assert.equal(r.razaoSocial, 'BANCO DO BRASIL SA');
    assert.equal(r.avisos[0].fonte, 'brasilapi');
  });

  test('não encontrado nas duas fontes → encontrado=false', async () => {
    fetchSim = simularFetch([
      ['brasilapi.com.br', { status: 404 }],
      ['publica.cnpj.ws', { status: 404 }],
    ]);
    const r = await consultarCnpj('11222333000181');
    assert.equal(r.encontrado, false);
  });

  test('CNPJ inválido lança erro sem chamar rede', async () => {
    fetchSim = simularFetch([]);
    await assert.rejects(consultarCnpj('00000000000192'), /CNPJ inválido/);
    assert.equal(fetchSim.chamadas.length, 0);
  });
});
