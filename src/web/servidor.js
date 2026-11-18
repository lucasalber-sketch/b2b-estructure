#!/usr/bin/env node
// Servidor Web & API REST da Etapa 4 (Mapa de Polos + Dashboard Executivo + Dossiê RevOps).
// Usa apenas node:http nativo, respeitando RLS (SET LOCAL ROLE prospeccao_app + app.organization_id).
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { criarConexao, mascararSegredos } from '../db/conexao.js';
import { criarRepositorio } from '../db/repositorio.js';
import { geocodificar } from '../conectores/geo.js';
import { inspecionarSite } from '../conectores/site-radar.js';
import { extrairDominioCandidato, dominioPertenceAEmpresa } from '../servicos/enriquecedor.js';
import {
  MACRO_SETORES,
  NOMES_CNAE,
  COORDENADAS_MUNICIPIOS_MS,
  classificarSetor,
  qualificarEmpresa,
} from '../servicos/qualificador.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR_PUBLIC = existsSync(path.join(RAIZ, 'public'))
  ? path.join(RAIZ, 'public')
  : path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const CONDICAO_SETOR_SQL = {
  agro: `(substr(e.cnae_principal,1,2) IN ('01','02','03','10','11','12') OR e.razao_social ~* 'AGRO|USINA|BIOENERG|PECUARIA|SEMENTE|FERTILIZ')`,
  industria: `(substr(e.cnae_principal,1,2) BETWEEN '05' AND '09' OR substr(e.cnae_principal,1,2) BETWEEN '13' AND '39')`,
  logistica: `(substr(e.cnae_principal,1,2) IN ('45','49','50','51','52','53'))`,
  construcao: `(substr(e.cnae_principal,1,2) IN ('41','42','43','68','71'))`,
  atacado: `(substr(e.cnae_principal,1,2) IN ('46','47'))`,
  servicos: `(substr(e.cnae_principal,1,2) NOT IN ('01','02','03','10','11','12','41','42','43','45','46','47','49','50','51','52','53','68','71') AND substr(e.cnae_principal,1,2) NOT BETWEEN '05' AND '09' AND substr(e.cnae_principal,1,2) NOT BETWEEN '13' AND '39')`,
};

/** Deslocamento determinístico leve pelo CNPJ para espalhar pinos no centro do município quando sem CEP geocodificado. */
function coordenadaParaMapa(e) {
  if (e.lat != null && e.lon != null) {
    return { lat: Number(e.lat), lon: Number(e.lon), aproximado: false };
  }
  const base = COORDENADAS_MUNICIPIOS_MS[e.municipio] ?? { lat: -20.4697, lon: -54.6201 };
  let hash = 0;
  for (let i = 0; i < e.cnpj.length; i++) hash = (hash * 31 + e.cnpj.charCodeAt(i)) | 0;
  const dLat = ((hash % 1000) / 1000) * 0.036 - 0.018;
  const dLon = (((hash >> 10) % 1000) / 1000) * 0.036 - 0.018;
  return {
    lat: Number((base.lat + dLat).toFixed(6)),
    lon: Number((base.lon + dLon).toFixed(6)),
    aproximado: true,
  };
}

function responderJson(res, status, dados) {
  const corpo = JSON.stringify(dados);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(corpo);
}

async function lerJsonBody(req) {
  const pedacos = [];
  for await (const p of req) pedacos.push(p);
  const texto = Buffer.concat(pedacos).toString('utf8').trim();
  return texto ? JSON.parse(texto) : {};
}

const modoDemoAtivo = () => {
  const v = String(process.env.MODO_DEMO || process.env.DEMO_MODE || '').trim().replace(/^["']|["']$/g, '');
  return v === '1' || v.toLowerCase() === 'true';
};

export function criarServidorWeb({ conexao, organizationId }) {
  const repo = criarRepositorio(conexao, { organizationId });

  /** Executa consulta no contexto RLS da organização. */
  const comOrg = (fn) =>
    conexao.transacao(async (tx) => {
      await tx.query(`SELECT set_config('app.organization_id', $1, true)`, [organizationId]);
      await tx.exec('SET LOCAL ROLE prospeccao_app');
      return fn(tx);
    });

  let cacheResumo = null;
  let cacheResumoExpira = 0;
  const CACHE_RESUMO_TTL_MS = 60_000; // 60 segundos de cache para agregação instantânea (<2ms)

  function invalidarCacheResumo() {
    cacheResumo = null;
    cacheResumoExpira = 0;
  }

  async function obterResumo({ forcar = false } = {}) {
    if (!forcar && cacheResumo && Date.now() < cacheResumoExpira) {
      return cacheResumo;
    }

    const resultado = await comOrg(async (tx) => {
      const kpis = (
        await tx.query(`
          SELECT
            count(*)::int AS total_empresas,
            count(*) FILTER (WHERE e.porte = 'DEMAIS')::int AS demais,
            count(*) FILTER (WHERE e.porte = 'EPP')::int AS epp,
            count(*) FILTER (WHERE e.telefone_e164 IS NOT NULL)::int AS com_telefone,
            count(*) FILTER (WHERE e.email IS NOT NULL)::int AS com_email,
            count(*) FILTER (WHERE e.dominio IS NOT NULL)::int AS com_dominio,
            count(*) FILTER (WHERE e.dominio_confirmado = true)::int AS dominio_confirmado,
            count(*) FILTER (WHERE e.lat IS NOT NULL AND e.lon IS NOT NULL)::int AS com_geo,
            coalesce(sum(e.capital_social), 0)::float8 AS capital_social_total
          FROM prospeccao.empresas e
          WHERE NOT EXISTS (SELECT 1 FROM prospeccao.nao_contatar n WHERE n.cnpj = e.cnpj)
        `)
      ).rows[0];

      const porEtapa = (
        await tx.query(`
          SELECT e.etapa_funil, count(*)::int AS total
          FROM prospeccao.empresas e
          WHERE NOT EXISTS (SELECT 1 FROM prospeccao.nao_contatar n WHERE n.cnpj = e.cnpj)
          GROUP BY e.etapa_funil
        `)
      ).rows;

      const municipiosRows = (
        await tx.query(`
          SELECT
            e.municipio,
            e.codigo_ibge,
            count(*)::int AS total,
            count(*) FILTER (WHERE e.porte = 'DEMAIS')::int AS demais,
            count(*) FILTER (WHERE e.porte = 'EPP')::int AS epp,
            coalesce(sum(e.capital_social), 0)::float8 AS capital_total,
            avg(e.lat)::float8 AS lat_media,
            avg(e.lon)::float8 AS lon_media
          FROM prospeccao.empresas e
          WHERE NOT EXISTS (SELECT 1 FROM prospeccao.nao_contatar n WHERE n.cnpj = e.cnpj)
          GROUP BY e.municipio, e.codigo_ibge
          ORDER BY total DESC
        `)
      ).rows;

      const municipios = municipiosRows.map((m) => {
        const coord = COORDENADAS_MUNICIPIOS_MS[m.municipio] ?? {
          lat: m.lat_media ?? -20.4697,
          lon: m.lon_media ?? -54.6201,
        };
        return {
          municipio: m.municipio,
          codigo_ibge: m.codigo_ibge,
          total: m.total,
          demais: m.demais,
          epp: m.epp,
          capital_total: m.capital_total,
          lat: coord.lat,
          lon: coord.lon,
        };
      });

      const cnaesRows = (
        await tx.query(`
          SELECT
            e.cnae_principal AS cnae,
            count(*)::int AS total,
            count(*) FILTER (WHERE e.porte = 'DEMAIS')::int AS demais
          FROM prospeccao.empresas e
          WHERE e.cnae_principal IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM prospeccao.nao_contatar n WHERE n.cnpj = e.cnpj)
          GROUP BY e.cnae_principal
          ORDER BY total DESC
          LIMIT 25
        `)
      ).rows.map((r) => ({
        ...r,
        descricao: NOMES_CNAE[r.cnae] || `CNAE ${r.cnae}`,
        setor: classificarSetor(r.cnae).nome,
      }));

      // Agregação por macro-setor (pelo prefixo de 2 dígitos do CNAE)
      const divisoesRows = (
        await tx.query(`
          SELECT
            substr(e.cnae_principal, 1, 2) AS div,
            count(*)::int AS total,
            count(*) FILTER (WHERE e.porte = 'DEMAIS')::int AS demais,
            coalesce(sum(e.capital_social), 0)::float8 AS capital_total
          FROM prospeccao.empresas e
          WHERE NOT EXISTS (SELECT 1 FROM prospeccao.nao_contatar n WHERE n.cnpj = e.cnpj)
          GROUP BY substr(e.cnae_principal, 1, 2)
        `)
      ).rows;

      const mapaSetores = new Map(
        Object.values(MACRO_SETORES).map((s) => [s.id, { ...s, total: 0, demais: 0, capital_total: 0 }])
      );
      for (const r of divisoesRows) {
        const s = classificarSetor(r.div ? `${r.div}00000` : '');
        const item = mapaSetores.get(s.id);
        item.total += r.total;
        item.demais += r.demais;
        item.capital_total += r.capital_total;
      }

      const sinaisRows = (
        await tx.query(`
          SELECT
            s.tipo, s.nome, s.status, s.evidencia, s.url_evidencia, s.coletado_em,
            e.cnpj, e.razao_social, e.municipio, e.porte
          FROM prospeccao.empresa_sinais_erp s
          JOIN prospeccao.empresas e ON e.id = s.empresa_id
          ORDER BY s.coletado_em DESC
          LIMIT 50
        `)
      ).rows;

      const contratosRows = (
        await tx.query(`
          SELECT
            c.numero_controle_pncp, c.cnpj_fornecedor, c.orgao_nome, c.objeto,
            c.valor_global::float8 AS valor_global, c.data_assinatura, c.url_fonte,
            e.cnpj AS cnpj_matriz, e.razao_social, e.municipio, e.porte
          FROM prospeccao.empresa_contratos_pncp c
          JOIN prospeccao.empresas e ON e.id = c.empresa_id
          ORDER BY c.valor_global DESC NULLS LAST
          LIMIT 50
        `)
      ).rows;

      const resumoPncp = (
        await tx.query(`
          SELECT
            count(*)::int AS total_contratos,
            count(DISTINCT empresa_id)::int AS empresas_com_contrato,
            coalesce(sum(valor_global), 0)::float8 AS valor_total
          FROM prospeccao.empresa_contratos_pncp
        `)
      ).rows[0];

      const telefonesContadores = (
        await tx.query(`
          SELECT count(*)::int AS qtd_telefones, coalesce(sum(c), 0)::int AS empresas_afetadas
          FROM (
            SELECT telefone_e164, count(*) AS c
            FROM prospeccao.empresas
            WHERE telefone_e164 IS NOT NULL
            GROUP BY telefone_e164
            HAVING count(*) >= 10
          ) t
        `)
      ).rows[0];

      const execucoes = (
        await tx.query(`
          SELECT id, tipo, status, parametros, contadores, iniciado_em, finalizado_em
          FROM prospeccao.ingestao_execucoes
          ORDER BY iniciado_em DESC
          LIMIT 10
        `)
      ).rows;

      return {
        kpis: {
          ...kpis,
          com_sinais: new Set(sinaisRows.map((s) => s.cnpj)).size,
          total_sinais: sinaisRows.length,
          ...resumoPncp,
        },
        por_etapa: porEtapa,
        setores: [...mapaSetores.values()].sort((a, b) => b.total - a.total),
        municipios,
        top_cnaes: cnaesRows,
        sinais_confirmados: sinaisRows,
        contratos_pncp: contratosRows,
        qualidade_dados: {
          telefones_contadores: telefonesContadores.qtd_telefones,
          empresas_com_telefone_contador: telefonesContadores.empresas_afetadas,
        },
        execucoes,
      };
    });

    cacheResumo = resultado;
    cacheResumoExpira = Date.now() + CACHE_RESUMO_TTL_MS;
    return resultado;
  }

  async function buscarEmpresas(urlObj, limiteMaximo = 400) {
    const q = urlObj.searchParams.get('q')?.trim() || '';
    const municipio = urlObj.searchParams.get('municipio')?.trim() || '';
    const porte = urlObj.searchParams.get('porte')?.trim() || '';
    const setor = urlObj.searchParams.get('setor')?.trim() || '';
    const etapa = urlObj.searchParams.get('etapa')?.trim() || '';
    const filtroEspecial = urlObj.searchParams.get('filtro')?.trim() || '';
    const limiteParam = Number(urlObj.searchParams.get('limite')) || 120;
    const limite = Math.min(Math.max(1, limiteParam), limiteMaximo);

    return comOrg(async (tx) => {
      const cond = [`NOT EXISTS (SELECT 1 FROM prospeccao.nao_contatar n WHERE n.cnpj = e.cnpj)`];
      const params = [];
      const add = (sql, v) => {
        params.push(v);
        cond.push(sql.replaceAll('?', `$${params.length}`));
      };

      if (q) {
        const limpo = q.replace(/\D/g, '');
        if (limpo.length >= 6) {
          add(`(e.cnpj LIKE ? OR e.razao_social ILIKE ? OR coalesce(e.nome_fantasia,'') ILIKE ?)`, `%${limpo}%`);
          params.push(`%${q}%`, `%${q}%`);
          cond[cond.length - 1] = `(e.cnpj LIKE $${params.length - 2} OR e.razao_social ILIKE $${params.length - 1} OR coalesce(e.nome_fantasia,'') ILIKE $${params.length})`;
        } else {
          params.push(`%${q}%`);
          cond.push(`(e.razao_social ILIKE $${params.length} OR coalesce(e.nome_fantasia,'') ILIKE $${params.length})`);
        }
      }
      if (municipio) add(`e.municipio = ?`, municipio);
      if (porte === 'DEMAIS' || porte === 'EPP') add(`e.porte = ?`, porte);
      if (etapa) add(`e.etapa_funil = ?`, etapa);
      if (setor && CONDICAO_SETOR_SQL[setor]) cond.push(CONDICAO_SETOR_SQL[setor]);

      if (filtroEspecial === 'com_sinais') {
        cond.push(`cs.empresa_id IS NOT NULL`);
      } else if (filtroEspecial === 'com_pncp') {
        cond.push(`cp.empresa_id IS NOT NULL`);
      } else if (filtroEspecial === 'com_geo') {
        cond.push(`e.lat IS NOT NULL AND e.lon IS NOT NULL`);
      } else if (filtroEspecial === 'dominio_confirmado') {
        cond.push(`e.dominio_confirmado = true`);
      }

      params.push(limite);
      const sql = `
        WITH com_sinais AS (
          SELECT empresa_id,
                 json_agg(json_build_object('tipo', tipo, 'nome', nome, 'evidencia', evidencia, 'url_evidencia', url_evidencia)) AS sinais
          FROM prospeccao.empresa_sinais_erp
          GROUP BY empresa_id
        ),
        com_pncp AS (
          SELECT empresa_id,
                 count(*)::int AS contratos_pncp,
                 sum(valor_global)::float8 AS valor_contratos_pncp
          FROM prospeccao.empresa_contratos_pncp
          GROUP BY empresa_id
        )
        SELECT
          e.id, e.cnpj, e.razao_social, e.nome_fantasia, e.porte, e.capital_social::float8 AS capital_social,
          e.data_abertura::text AS data_abertura, e.cnae_principal, e.municipio, e.uf, e.codigo_ibge,
          e.bairro, e.cep, e.lat::float8 AS lat, e.lon::float8 AS lon, e.geo_precisao,
          e.telefone_e164, e.telefone_origem, e.email, e.email_origem,
          e.dominio, e.dominio_origem, e.dominio_confirmado, e.site_status, e.etapa_funil,
          coalesce(cs.sinais, '[]'::json) AS sinais,
          coalesce(cp.contratos_pncp, 0)::int AS contratos_pncp,
          coalesce(cp.valor_contratos_pncp, 0)::float8 AS valor_contratos_pncp
        FROM prospeccao.empresas e
        LEFT JOIN com_sinais cs ON cs.empresa_id = e.id
        LEFT JOIN com_pncp cp ON cp.empresa_id = e.id
        WHERE ${cond.join(' AND ')}
        ORDER BY
          (cs.empresa_id IS NOT NULL) DESC,
          (cp.empresa_id IS NOT NULL) DESC,
          (e.porte = 'DEMAIS') DESC,
          e.capital_social DESC NULLS LAST,
          e.razao_social
        LIMIT $${params.length}
      `;

      const { rows } = await tx.query(sql, params);
      const enriquecidas = rows.map((r) => {
        const qualificacao = qualificarEmpresa(r);
        const mapa = coordenadaParaMapa(r);
        return {
          ...r,
          lat_mapa: mapa.lat,
          lon_mapa: mapa.lon,
          geo_aproximado_municipio: mapa.aproximado,
          qualificacao,
        };
      });

      enriquecidas.sort((a, b) => b.qualificacao.score - a.qualificacao.score || (b.capital_social ?? 0) - (a.capital_social ?? 0));
      return { total: enriquecidas.length, empresas: enriquecidas };
    });
  }

  async function exportarEmpresasCsv(urlObj) {
    const { empresas } = await buscarEmpresas(urlObj, 5000);

    const escapeCsv = (val) => {
      if (val == null) return '';
      const str = String(val).replaceAll('"', '""').replaceAll('\r', ' ').replaceAll('\n', ' ');
      return `"${str}"`;
    };

    const cabecalho = [
      'CNPJ',
      'Razão Social',
      'Nome Fantasia',
      'Porte',
      'Capital Social (R$)',
      'Data Abertura',
      'Macro-Setor',
      'CNAE Principal',
      'Município',
      'UF',
      'Bairro',
      'CEP',
      'Telefone',
      'Origem Telefone',
      'E-mail',
      'Domínio',
      'Domínio Confirmado',
      'Sinais ERP / RH',
      'Contratos PNCP (Qtd)',
      'Contratos PNCP (Valor Total R$)',
      'Score B2B',
      'Classificação',
      'Etapa Funil',
      'Roteiro Abordagem WhatsApp',
    ];

    const linhas = [cabecalho.map(escapeCsv).join(';')];

    for (const e of empresas) {
      const q = e.qualificacao || qualificarEmpresa(e);
      const sinaisStr = (e.sinais || []).map((s) => `${s.tipo?.toUpperCase()}: ${s.nome}`).join(' | ');
      linhas.push(
        [
          e.cnpj,
          e.razao_social,
          e.nome_fantasia || '',
          e.porte,
          Number(e.capital_social || 0).toFixed(2),
          e.data_abertura || '',
          q.setor?.nome || '',
          e.cnae_principal || '',
          e.municipio,
          e.uf,
          e.bairro || '',
          e.cep || '',
          e.telefone_e164 || '',
          e.telefone_origem || '',
          e.email || '',
          e.dominio || '',
          e.dominio_confirmado ? 'SIM' : 'NÃO',
          sinaisStr,
          e.contratos_pncp || 0,
          Number(e.valor_contratos_pncp || 0).toFixed(2),
          q.score,
          q.classificacao,
          e.etapa_funil,
          q.roteiro_whatsapp || '',
        ]
          .map(escapeCsv)
          .join(';')
      );
    }

    return '\uFEFF' + linhas.join('\r\n');
  }

  async function obterDossieEmpresa(cnpj) {
    const emp = await repo.buscarPorCnpj(cnpj);
    if (!emp) return null;
    const extras = await comOrg(async (tx) => {
      const contratos = (
        await tx.query(
          `SELECT numero_controle_pncp, cnpj_fornecedor, orgao_cnpj, orgao_nome, objeto,
                  valor_global::float8 AS valor_global, data_assinatura::text AS data_assinatura,
                  data_vigencia_fim::text AS data_vigencia_fim, url_fonte
             FROM prospeccao.empresa_contratos_pncp
            WHERE empresa_id = $1
            ORDER BY data_assinatura DESC NULLS LAST, valor_global DESC NULLS LAST`,
          [emp.id]
        )
      ).rows;

      let repTel = 1;
      if (emp.telefone_e164) {
        const r = await tx.query(
          `SELECT count(*)::int AS c FROM prospeccao.empresas WHERE telefone_e164 = $1`,
          [emp.telefone_e164]
        );
        repTel = r.rows[0]?.c ?? 1;
      }
      return { contratos, repTel };
    });

    const historico = await repo.historico(emp.cnpj);
    const valorContratos = extras.contratos.reduce((acc, c) => acc + (c.valor_global || 0), 0);
    const completo = {
      ...emp,
      contratos: extras.contratos,
      valor_contratos_pncp: valorContratos,
      telefone_repeticoes: extras.repTel,
      historico,
    };
    const mapa = coordenadaParaMapa(completo);
    return {
      ...completo,
      lat_mapa: mapa.lat,
      lon_mapa: mapa.lon,
      geo_aproximado_municipio: mapa.aproximado,
      qualificacao: qualificarEmpresa(completo),
    };
  }

  async function enriquecerEmpresaIndividual(cnpj, body = {}) {
    const emp = await repo.buscarPorCnpj(cnpj);
    if (!emp) throw new Error(`Empresa ${cnpj} não encontrada`);

    // 1) Geocodificação se ainda não tiver coordenada
    if (emp.lat == null && emp.cep) {
      const g = await geocodificar({ cep: emp.cep });
      if (g?.encontrado && g.lat != null && g.lon != null) {
        await repo.registrarEnriquecimentoGeo(emp.cnpj, {
          lat: g.lat,
          lon: g.lon,
          geo_precisao: g.precisao === 'endereco' ? 'rua' : 'cep_aproximado',
          geo_fonte: g.fonte === 'nominatim' ? 'nominatim' : 'brasilapi_cep',
        });
      } else {
        await repo.registrarEnriquecimentoGeo(emp.cnpj, {});
      }
    }

    // 2) Inspeção de site (domínio manual informado ou candidato do e-mail)
    const domManual = body.dominio ? String(body.dominio).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
    const cand = domManual
      ? { status: 'ok', dominio: domManual, origem: 'manual' }
      : extrairDominioCandidato(emp);

    if (cand.status === 'ok') {
      const radar = await inspecionarSite(cand.dominio);
      const pertence = cand.origem === 'manual' ? Boolean(radar?.acessivel) : dominioPertenceAEmpresa(emp, cand.dominio, radar);
      const site_status = !radar?.acessivel ? 'inacessivel' : pertence ? 'cnpj_confirmado' : 'cnpj_nao_encontrado';
      await repo.registrarEnriquecimentoSite(emp.cnpj, {
        dominio: cand.dominio,
        dominio_origem: cand.origem,
        dominio_confirmado: pertence,
        site_status,
        radar,
      });
    } else {
      await repo.registrarEnriquecimentoSite(emp.cnpj, { site_status: cand.status });
    }

    const atualizado = await repo.buscarPorCnpj(emp.cnpj);
    if (atualizado.etapa_funil === 'candidato' && (atualizado.lat != null || atualizado.dominio_confirmado)) {
      await repo.moverFunil({
        cnpj: emp.cnpj,
        etapa: 'enriquecido',
        motivo: 'enriquecimento sob demanda na interface',
        ator: 'usuario',
      });
    }
    return obterDossieEmpresa(emp.cnpj);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const p = urlObj.pathname;

      if (process.env.DEMO_SENHA && p.startsWith('/api/')) {
        const auth = req.headers['authorization'] || '';
        const esperado = 'Basic ' + Buffer.from(`demo:${process.env.DEMO_SENHA}`).toString('base64');
        if (auth !== esperado) {
          res.writeHead(401, {
            'WWW-Authenticate': 'Basic realm="Acesso Restrito - Demonstracao b2b-estructure"',
            'Content-Type': 'application/json; charset=utf-8',
          });
          return res.end(JSON.stringify({ erro: 'Acesso restrito. Forneça o usuário (demo) e a senha da demonstração.' }));
        }
      }

      if (req.method === 'GET' && p === '/api/resumo') {
        const forcar = urlObj.searchParams.get('refresh') === '1';
        return responderJson(res, 200, await obterResumo({ forcar }));
      }
      if (req.method === 'GET' && p === '/api/empresas') {
        return responderJson(res, 200, await buscarEmpresas(urlObj));
      }
      if (req.method === 'GET' && p === '/api/exportar') {
        const csv = await exportarEmpresasCsv(urlObj);
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="prospeccao-ms-empresas.csv"',
          'Cache-Control': 'no-store',
        });
        return res.end(csv);
      }

      const mEmpresa = /^\/api\/empresas\/([A-Za-z0-9]{14})(?:\/(enriquecer|funil|bloquear))?$/.exec(p);
      if (mEmpresa) {
        const [, cnpjAlvo, acao] = mEmpresa;
        if (req.method === 'GET' && !acao) {
          const dossie = await obterDossieEmpresa(cnpjAlvo);
          if (!dossie) return responderJson(res, 404, { erro: 'Empresa não encontrada' });
          return responderJson(res, 200, dossie);
        }
        if (req.method === 'POST' && acao === 'enriquecer') {
          const body = await lerJsonBody(req);
          if (modoDemoAtivo()) {
            const dossie = await obterDossieEmpresa(cnpjAlvo);
            return responderJson(res, 200, {
              ...dossie,
              aviso_demo: 'Modo Demonstração: enriquecimento simulado sem consumir cota de APIs externas.',
            });
          }
          const r = await enriquecerEmpresaIndividual(cnpjAlvo, body);
          invalidarCacheResumo();
          return responderJson(res, 200, r);
        }
        if (req.method === 'POST' && acao === 'funil') {
          const body = await lerJsonBody(req);
          if (modoDemoAtivo()) {
            const dossie = await obterDossieEmpresa(cnpjAlvo);
            return responderJson(res, 200, {
              ...dossie,
              etapa_funil: body.etapa,
              aviso_demo: `Modo Demonstração: etapa simulada (${body.etapa?.toUpperCase()}) sem alterar o banco de dados.`,
            });
          }
          await repo.moverFunil({
            cnpj: cnpjAlvo,
            etapa: body.etapa,
            motivo: body.motivo || 'atualização manual pelo painel',
            ator: 'usuario',
          });
          invalidarCacheResumo();
          return responderJson(res, 200, await obterDossieEmpresa(cnpjAlvo));
        }
        if (req.method === 'POST' && acao === 'bloquear') {
          const body = await lerJsonBody(req);
          if (modoDemoAtivo()) {
            return responderJson(res, 200, {
              sucesso: true,
              bloqueado: true,
              cnpj: cnpjAlvo,
              aviso_demo: 'Modo Demonstração: bloqueio LGPD simulado sem alterar a lista permanente.',
            });
          }
          const r = await repo.bloquearContato({
            cnpj: cnpjAlvo,
            motivo: body.motivo || 'solicitação de opt-out LGPD via painel',
            origem_solicitacao: body.origem_solicitacao || 'titular',
          });
          invalidarCacheResumo();
          return responderJson(res, 200, r);
        }
      }

      // Arquivos estáticos (SPA)
      const rel = p === '/' ? 'index.html' : p.slice(1);
      const arq = path.resolve(DIR_PUBLIC, rel);
      if (!arq.startsWith(DIR_PUBLIC) || !existsSync(arq)) {
        return responderJson(res, 404, { erro: `Rota não encontrada: ${p}` });
      }
      const ext = path.extname(arq);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(readFileSync(arq));
    } catch (e) {
      console.error('[web]', mascararSegredos(e.message));
      responderJson(res, 400, { erro: mascararSegredos(e.message) });
    }
  });

  server.obterResumo = obterResumo;
  server.invalidarCacheResumo = invalidarCacheResumo;
  return server;
}

const executadoDireto =
  process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (executadoDireto) {
  const porta = Number(process.env.PORT || 3030);
  const org = process.env.ORGANIZACAO_ID;
  if (!org) {
    console.error('✗ Defina ORGANIZACAO_ID no .env antes de iniciar o servidor web.');
    process.exit(1);
  }
  const conexao = await criarConexao();
  const server = criarServidorWeb({ conexao, organizationId: org });
  server.listen(porta, '127.0.0.1', () => {
    console.log(`\n🚀 b2b-estructure rodando em http://localhost:${porta}`);
    console.log(`   Organização RLS: ${org}`);
    console.log(`   Visões ativas: [ 🗺️ Mapa & Polos de MS ] + [ 📊 Dashboard Executivo & RevOps ]\n`);
    server.obterResumo().then(() => {
      console.log('⚡ Cache de agregação executiva pré-aquecido (<2ms).');
    }).catch((err) => console.error('[cache warm]', err.message));
  });
}
