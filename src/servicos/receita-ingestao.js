// Ingestão dos Dados Abertos do CNPJ para MS em 3 passos, com checkpoint por arquivo:
//   1) Estabelecimentos*.zip → só UF=MS, ATIVA, MATRIZ  → ms-estab-<n>.ndjson
//   2) Empresas*.zip         → só cnpj_basico do passo 1 → ms-empresas-<n>.ndjson
//   3) junção → filtros LGPD/escopo → EmpresaEntrada → repositorio.salvarEmpresas (ou só conta, em simulação)
// Cada arquivo processado gera um marcador .ok com seus contadores: rodar de novo retoma de onde parou.
import { createReadStream, createWriteStream, existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import path from 'node:path';
import * as receita from '../conectores/receita.js';
import { listarMunicipios } from '../conectores/ibge.js';
import { EmpresaEntrada } from '../db/esquemas.js';

const UF = 'MS';
const LOTE_GRAVACAO = 2000;
const AMOSTRA_LAYOUT = 1000;

const somar = (alvo, origem) => {
  for (const [k, v] of Object.entries(origem)) {
    if (typeof v === 'number') alvo[k] = (alvo[k] ?? 0) + v;
    else if (v && typeof v === 'object') somar((alvo[k] ??= {}), v);
  }
  return alvo;
};
const inc = (obj, chave, n = 1) => { obj[chave] = (obj[chave] ?? 0) + n; };

async function* lerNdjson(arquivo) {
  const rl = createInterface({ input: createReadStream(arquivo, 'utf8'), crlfDelay: Infinity });
  for await (const l of rl) if (l) yield JSON.parse(l);
}

/** Escreve linhas respeitando o backpressure do stream. */
function escritor(arquivo) {
  const ws = createWriteStream(arquivo, 'utf8');
  return {
    async escrever(linhaJson) { if (!ws.write(`${linhaJson}\n`)) await once(ws, 'drain'); },
    async fechar() { ws.end(); await once(ws, 'finish'); },
  };
}

/**
 * @param {object} o
 * @param {string} o.mes              AAAA-MM (obrigatório; o CLI resolve "mais recente")
 * @param {string} o.dir              pasta de trabalho (data/receita/<mes>)
 * @param {boolean} [o.simular]       true = não grava no banco (dry-run)
 * @param {object} [o.repo]           repositório (obrigatório se simular=false)
 * @param {number[]} [o.indices]      restringe aos arquivos de número N (ex.: [0] → Estabelecimentos0/Empresas0)
 * @param {object} [o.fonte]          injeção para testes: { listarArquivosDoMes, baixarArquivo }
 * @param {Array}  [o.municipiosIbge] injeção para testes (padrão: IBGE da UF, com cache)
 * @param {(msg: string) => void} [o.aoLog]
 */
export async function ingerirReceita({
  mes, dir, simular = true, repo, indices, fonte = receita, municipiosIbge, aoLog = () => {},
}) {
  if (!simular && !repo) throw new Error('repo é obrigatório quando simular=false');
  mkdirSync(dir, { recursive: true });
  const liberar = travarPasta(dir);
  try {
    return await executar({ mes, dir, simular, repo, indices, fonte, municipiosIbge, aoLog });
  } finally {
    liberar();
  }
}

/**
 * Trava exclusiva da pasta de trabalho: duas ingestões no mesmo mês escreveriam no mesmo .parcial
 * (no Windows, parar o `npm` não encerra o `node` filho). Trava de processo morto é descartada.
 */
export function travarPasta(dir) {
  const trava = path.join(dir, '.trava');
  try {
    writeFileSync(trava, String(process.pid), { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(readFileSync(trava, 'utf8'));
    let vivo = false;
    try { process.kill(pid, 0); vivo = pid !== process.pid; } catch { vivo = false; }
    if (vivo) throw new Error(`outra ingestão (PID ${pid}) já está usando ${dir} — encerre-a antes de iniciar outra`);
    writeFileSync(trava, String(process.pid));
  }
  return () => { try { if (readFileSync(trava, 'utf8') === String(process.pid)) unlinkSync(trava); } catch { /* já removida */ } };
}

async function executar({ mes, dir, simular, repo, indices, fonte, municipiosIbge, aoLog }) {
  const inicio = Date.now();
  const listagem = await fonte.listarArquivosDoMes(mes);
  const filtrar = (lista) => (indices ? lista.filter((a) => indices.includes(Number(/(\d+)\.zip$/i.exec(a.nome)[1]))) : lista);
  const estabs = filtrar(listagem.estabelecimentos);
  const emps = filtrar(listagem.empresas);
  if (!estabs.length || !emps.length || !listagem.municipios) throw new Error(`mês ${mes}: arquivos incompletos na Receita`);
  const consultadoEm = estabs[0].modificadoEm ?? `${mes}-01T00:00:00.000Z`;

  const marcador = (nome) => path.join(dir, `${nome}.ok`);
  const feito = (nome) => existsSync(marcador(nome));
  const lerMarcador = (nome) => JSON.parse(readFileSync(marcador(nome), 'utf8'));
  const gravarMarcador = (nome, dados) => writeFileSync(marcador(nome), JSON.stringify(dados));

  // Downloads em fila única (um por vez), adiantados em relação ao processamento.
  const precisa = [listagem.municipios, ...estabs.filter((a) => !feito(a.nome)), ...emps.filter((a) => !feito(a.nome))];
  const downloads = new Map();
  let cadeia = Promise.resolve();
  for (const arq of precisa) {
    const p = cadeia.then(() => {
      let ultimo = -1;
      return fonte.baixarArquivo({
        mes, arquivo: arq, dir,
        aoProgredir: (rec, total) => {
          const pct = total ? Math.floor((rec / total) * 100) : null;
          if (pct != null && pct >= ultimo + 10) { ultimo = pct; aoLog(`↓ ${arq.nome} ${pct}%`); }
        },
      });
    });
    p.catch(() => {}); // o erro é tratado por quem aguarda
    downloads.set(arq.nome, p);
    cadeia = p.catch(() => {});
  }

  // Municípios TOM → IBGE (apenas os da UF)
  const tomParaNome = new Map();
  await receita.lerZipCsv(await downloads.get(listagem.municipios.nome), (c) => { if (c.length >= 2) tomParaNome.set(c[0], c[1]); });
  const ibge = municipiosIbge ?? (await listarMunicipios(UF)).municipios;
  const municipios = receita.mapearMunicipios(tomParaNome, ibge);

  // ── Passo 1: estabelecimentos ──
  const c1 = {};
  for (const arq of estabs) {
    if (feito(arq.nome)) { somar(c1, lerMarcador(arq.nome)); aoLog(`✓ ${arq.nome} (já processado)`); continue; }
    const zip = await downloads.get(arq.nome);
    aoLog(`⚙ ${arq.nome}: filtrando ${UF} / ativa / matriz…`);
    const saida = escritor(path.join(dir, `ms-estab-${arq.nome}.ndjson`));
    const c = { linhas: 0, malformadas: 0, layout_divergente: 0, uf: 0, uf_ativas: 0, uf_ativas_matriz: 0, situacao_uf: {} };
    const pendentes = [];
    let amostra = 0;
    const r = await receita.lerZipCsv(zip, (campos) => {
      if (amostra < AMOSTRA_LAYOUT) {
        amostra++;
        if (!receita.layoutConfere(campos, 'estab')) c.layout_divergente++;
        if (amostra === AMOSTRA_LAYOUT && c.layout_divergente > AMOSTRA_LAYOUT / 100) {
          throw new Error(`${arq.nome}: layout divergente em ${c.layout_divergente}/${AMOSTRA_LAYOUT} linhas — ingestão abortada`);
        }
      }
      if (campos[receita.ESTAB.uf] !== UF) return;
      c.uf++;
      inc(c.situacao_uf, campos[receita.ESTAB.situacao]);
      if (campos[receita.ESTAB.situacao] !== receita.SITUACAO_ATIVA) return;
      c.uf_ativas++;
      if (campos[receita.ESTAB.matriz_filial] !== receita.MATRIZ) return;
      c.uf_ativas_matriz++;
      // JSON.stringify gera uma string nova: guardar os campos (fatias da linha) prenderia na memória
      // o pedaço inteiro do CSV descompactado de onde vieram (sliced strings do V8) → estouro de heap.
      pendentes.push(JSON.stringify(receita.compactarEstab(campos)));
    });
    if (amostra && amostra < AMOSTRA_LAYOUT && c.layout_divergente > amostra / 100) {
      throw new Error(`${arq.nome}: layout divergente em ${c.layout_divergente}/${amostra} linhas — ingestão abortada`);
    }
    for (const p of pendentes) await saida.escrever(p);
    await saida.fechar();
    c.linhas = r.linhas;
    c.malformadas = r.malformadas;
    gravarMarcador(arq.nome, c);
    somar(c1, c);
    aoLog(`✓ ${arq.nome}: ${r.linhas.toLocaleString('pt-BR')} linhas · ${c.uf_ativas_matriz.toLocaleString('pt-BR')} matrizes ativas em ${UF}`);
  }

  const basicos = new Set();
  for (const arq of estabs) for await (const e of lerNdjson(path.join(dir, `ms-estab-${arq.nome}.ndjson`))) basicos.add(e.b);

  // ── Passo 2: empresas ──
  const c2 = {};
  for (const arq of emps) {
    if (feito(arq.nome)) { somar(c2, lerMarcador(arq.nome)); aoLog(`✓ ${arq.nome} (já processado)`); continue; }
    const zip = await downloads.get(arq.nome);
    aoLog(`⚙ ${arq.nome}: cruzando com ${basicos.size.toLocaleString('pt-BR')} CNPJs básicos…`);
    const c = { linhas: 0, malformadas: 0, layout_divergente: 0, casadas: 0 };
    const pendentes = [];
    let amostra = 0;
    const r = await receita.lerZipCsv(zip, (campos) => {
      if (amostra < AMOSTRA_LAYOUT) {
        amostra++;
        if (!receita.layoutConfere(campos, 'empresa')) c.layout_divergente++;
        if (amostra === AMOSTRA_LAYOUT && c.layout_divergente > AMOSTRA_LAYOUT / 100) {
          throw new Error(`${arq.nome}: layout divergente em ${c.layout_divergente}/${AMOSTRA_LAYOUT} linhas — ingestão abortada`);
        }
      }
      if (!basicos.has(campos[receita.EMPR.cnpj_basico])) return;
      c.casadas++;
      pendentes.push(JSON.stringify(receita.compactarEmpresa(campos)));
    });
    const saida = escritor(path.join(dir, `ms-empresas-${arq.nome}.ndjson`));
    for (const p of pendentes) await saida.escrever(p);
    await saida.fechar();
    c.linhas = r.linhas;
    c.malformadas = r.malformadas;
    gravarMarcador(arq.nome, c);
    somar(c2, c);
    aoLog(`✓ ${arq.nome}: ${r.linhas.toLocaleString('pt-BR')} linhas · ${c.casadas.toLocaleString('pt-BR')} casadas`);
  }

  const empresasPorBasico = new Map();
  for (const arq of emps) for await (const e of lerNdjson(path.join(dir, `ms-empresas-${arq.nome}.ndjson`))) empresasPorBasico.set(e.b, e);

  // ── Passo 3: junção, filtros e gravação ──
  const c3 = {
    candidatas: 0, aptas: 0, gravadas: 0, recusadas_banco: 0, invalidas: 0,
    descartes: {}, invalidas_motivos: {}, avisos: {}, por_porte: {}, com_telefone: 0, com_email: 0,
    por_municipio: {}, por_cnae: {}, nao_mapeados: {},
  };
  const amostra = [];
  let execucaoId = null;
  if (!simular) execucaoId = await repo.iniciarExecucao({ tipo: 'receita', parametros: { mes, uf: UF, indices: indices ?? 'todos' } });
  let lote = [];
  const gravar = async () => {
    if (!lote.length) return;
    const r = await repo.salvarEmpresas(lote);
    c3.gravadas += r.gravadas;
    c3.recusadas_banco += r.recusadas.length;
    for (const x of r.recusadas) inc(c3.invalidas_motivos, `banco: ${x.motivo.slice(0, 80)}`);
    lote = [];
    await repo.atualizarExecucao(execucaoId, { contadores: { gravadas: c3.gravadas, recusadas: c3.recusadas_banco, aptas: c3.aptas } });
    aoLog(`⇪ ${c3.gravadas.toLocaleString('pt-BR')} empresas gravadas`);
  };

  try {
    for (const arq of estabs) {
      for await (const est of lerNdjson(path.join(dir, `ms-estab-${arq.nome}.ndjson`))) {
        c3.candidatas++;
        const m = receita.montarEmpresa(est, empresasPorBasico.get(est.b), municipios, { consultadoEm });
        if (!m.aceita) {
          inc(c3.descartes, m.motivo);
          if (m.motivo === 'municipio_nao_mapeado') inc(c3.nao_mapeados, `${est.m}:${tomParaNome.get(est.m) ?? '?'}`);
          continue;
        }
        const v = EmpresaEntrada.safeParse(m.empresa);
        if (!v.success) {
          c3.invalidas++;
          for (const i of v.error.issues) inc(c3.invalidas_motivos, `${i.path.join('.')}: ${i.message}`);
          continue;
        }
        const e = v.data;
        c3.aptas++;
        for (const a of m.avisos) inc(c3.avisos, a);
        inc(c3.por_porte, e.porte);
        inc(c3.por_municipio, e.municipio);
        if (e.cnae_principal) inc(c3.por_cnae, e.cnae_principal);
        if (e.telefone_e164) c3.com_telefone++;
        if (e.email) c3.com_email++;
        if (amostra.length < 5) {
          amostra.push({ cnpj: e.cnpj, razao_social: e.razao_social, municipio: e.municipio, porte: e.porte, cnae: e.cnae_principal });
        }
        if (!simular) {
          lote.push(m.empresa);
          if (lote.length >= LOTE_GRAVACAO) await gravar();
        }
      }
    }
    if (!simular) {
      await gravar();
      await repo.atualizarExecucao(execucaoId, {
        status: 'concluida', contadores: { gravadas: c3.gravadas, recusadas: c3.recusadas_banco, aptas: c3.aptas },
      });
    }
  } catch (e) {
    if (execucaoId) await repo.atualizarExecucao(execucaoId, { status: 'falhou', erro: e.message }).catch(() => {});
    throw e;
  }

  const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
  return {
    mes, uf: UF, simulado: simular, consultado_em: consultadoEm,
    arquivos: { estabelecimentos: estabs.map((a) => a.nome), empresas: emps.map((a) => a.nome) },
    municipios_mapeados: municipios.size,
    estabelecimentos: c1,
    empresas: c2,
    juncao: { ...c3, por_municipio: top(c3.por_municipio, 15), por_cnae: top(c3.por_cnae, 15) },
    amostra,
    execucao_id: execucaoId,
    duracao_s: Math.round((Date.now() - inicio) / 1000),
  };
}
