// Serviço de enriquecimento incremental (Etapa 3):
//   1) Geocodificação (CEP/endereço → lat/lon via BrasilAPI CEP v2 + fallback Nominatim).
//   2) Descoberta de domínio corporativo (a partir do e-mail cadastral não gratuito) + Radar de Site
//      (confirmação de CNPJ no HTML e detecção de assinaturas de ERP e portais de RH).
//   - Domínios inspecionados são cacheados na rodada (um contador com 50 empresas gera só 1 requisição HTTP).
//   - Sinais de ERP/RH só são vinculados à empresa se o próprio CNPJ/raiz aparecer no site (ou domínio manual).
import { geocodificar as geocodificarPadrao } from '../conectores/geo.js';
import { inspecionarSite as inspecionarSitePadrao } from '../conectores/site-radar.js';
import { PROVEDORES_GRATUITOS } from '../conectores/receita.js';

const ORIGEM_DOMINIO_POR_EMAIL = {
  rfb_lote: 'email_rfb',
  brasilapi: 'email_brasilapi',
  cnpjws: 'email_cnpjws',
};

const MAPA_PRECISAO = {
  endereco: 'rua',
  cep_aproximado: 'cep_aproximado',
  cep: 'cep_aproximado',
  cidade: 'municipio',
};

const MAPA_FONTE_GEO = {
  brasilapi: 'brasilapi_cep',
  nominatim: 'nominatim',
};

const PALAVRAS_GENERICAS = new Set([
  'brasil', 'brasileira', 'comercio', 'comercial', 'servicos', 'industria', 'industrial', 'agro', 'agronegocios',
  'agropecuaria', 'agroindustrial', 'holding', 'participacoes', 'empreendimentos', 'incorporadora', 'distribuidora',
  'transportes', 'logistica', 'energia', 'bioenergia', 'alimentos', 'engenharia', 'construtora', 'construcoes',
  'grupo', 'companhia', 'empresa', 'empresas', 'ltda', 'eireli', 'mato', 'grosso', 'campo', 'grande', 'dourados',
  'lagoas', 'corumba', 'ponta', 'pora', 'chapadao', 'sul', 'norte', 'leste', 'oeste', 'centro', 'central', 'nova',
  'novo', 'santa', 'santo', 'sao', 'vale', 'rio', 'brilhante', 'vista', 'alegre', 'passa', 'tempo',
]);

const DOMINIO_TERCEIRO = /contab|assessor|escritorio|consultor|advog|advocacia|audit|pericia|prefeitura|gov\.br/i;

/**
 * Verifica se o domínio inspecionado pertence de fato à empresa (e não ao escritório contábil):
 *   1) O HTML exibe um CNPJ com a mesma raiz (8 dígitos) da empresa; OU
 *   2) O rótulo principal do domínio (sem ser contabilidade/assessoria) casa com um termo distintivo
 *      (>= 4 letras) da razão social ou do nome fantasia da empresa.
 */
export function dominioPertenceAEmpresa(empresa, dominio, radar) {
  if (!radar?.acessivel || !dominio) return false;
  const basico = String(empresa.cnpj ?? '').slice(0, 8);
  if (
    Array.isArray(radar.cnpjs) &&
    radar.cnpjs.some((x) => x.cnpj === empresa.cnpj || x.cnpj.slice(0, 8) === basico)
  ) {
    return true;
  }
  const host = String(dominio).toLowerCase().replace(/^www\./, '');
  if (DOMINIO_TERCEIRO.test(host)) return false;
  const rotulo = host.split('.')[0].replace(/[^a-z0-9]/g, '');
  if (rotulo.length < 4) return false;

  const texto = `${empresa.razao_social ?? ''} ${empresa.nome_fantasia ?? ''}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  const tokens = texto.split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !PALAVRAS_GENERICAS.has(t));
  return tokens.some((t) => rotulo.includes(t) || (t.length >= 5 && t.includes(rotulo)));
}

/**
 * Extrai domínio candidato a partir dos dados já salvos na empresa.
 * @returns {{ status: 'ok', dominio: string, origem: string } | { status: 'sem_dominio' | 'dominio_gratuito' }}
 */
export function extrairDominioCandidato(empresa) {
  if (empresa.dominio) {
    return { status: 'ok', dominio: empresa.dominio.toLowerCase(), origem: empresa.dominio_origem || 'manual' };
  }
  if (!empresa.email || !empresa.email.includes('@')) {
    return { status: 'sem_dominio' };
  }
  const dom = empresa.email.split('@')[1]?.trim().toLowerCase();
  if (!dom || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(dom)) return { status: 'sem_dominio' };
  if (PROVEDORES_GRATUITOS.has(dom)) return { status: 'dominio_gratuito' };
  const origem = ORIGEM_DOMINIO_POR_EMAIL[empresa.email_origem] ?? 'email_rfb';
  return { status: 'ok', dominio: dom, origem };
}

/**
 * Executa uma rodada de enriquecimento sobre as empresas pendentes no banco.
 * @param {object} o
 * @param {ReturnType<import('../db/repositorio.js').criarRepositorio>} o.repo
 * @param {'geo' | 'site' | 'ambos'} [o.tipo='ambos']
 * @param {string} [o.codigo_ibge]
 * @param {string} [o.cnae]
 * @param {'EPP' | 'DEMAIS'} [o.porte]
 * @param {number} [o.limite=100]
 * @param {boolean} [o.simular=false]
 * @param {typeof geocodificarPadrao} [o.geocodificarFn]
 * @param {typeof inspecionarSitePadrao} [o.inspecionarSiteFn]
 * @param {(msg: string) => void} [o.aoLog]
 */
export async function enriquecerEmpresas({
  repo,
  tipo = 'ambos',
  codigo_ibge,
  cnae,
  porte,
  limite = 100,
  simular = false,
  geocodificarFn = geocodificarPadrao,
  inspecionarSiteFn = inspecionarSitePadrao,
  aoLog = () => {},
}) {
  if (!repo) throw new Error('repo é obrigatório');
  const inicio = Date.now();
  const pendentes = await repo.listarPendentesEnriquecimento({ tipo, codigo_ibge, cnae, porte, limite });

  const contadores = {
    selecionadas: pendentes.length,
    geo: { tentadas: 0, com_coordenada: 0, sem_coordenada: 0, sem_endereco: 0, por_precisao: {} },
    site: {
      tentadas: 0,
      requisicoes_http: 0,
      reuso_cache_dominio: 0,
      por_status: {},
      sinais_erp: 0,
      sinais_rh: 0,
    },
    qualificadas_funil: 0,
  };

  let execucaoId = null;
  if (!simular && pendentes.length > 0) {
    execucaoId = await repo.iniciarExecucao({
      tipo: 'enriquecimento',
      parametros: { tipo, codigo_ibge: codigo_ibge ?? null, cnae: cnae ?? null, porte: porte ?? null, limite },
    });
  }

  const cacheRadar = new Map();
  const amostraSinais = [];

  try {
    for (let idx = 0; idx < pendentes.length; idx++) {
      const e = pendentes[idx];
      let geoOk = e.lat != null && e.lon != null;
      let siteConfirmado = e.dominio_confirmado === true;

      // ── 1) Geocodificação ──
      if ((tipo === 'geo' || tipo === 'ambos') && !e.geo_enriquecido_em) {
        contadores.geo.tentadas += 1;
        let lat = null, lon = null, geo_precisao = 'NAO_VERIFICADO', geo_fonte = null;

        if (!e.cep && !(e.logradouro && e.municipio)) {
          contadores.geo.sem_endereco += 1;
        } else {
          const r = await geocodificarFn(
            e.cep
              ? { cep: e.cep }
              : { endereco: [e.logradouro, e.numero, e.municipio, e.uf].filter(Boolean).join(', ') }
          );
          if (r?.encontrado && r.lat != null && r.lon != null) {
            lat = r.lat;
            lon = r.lon;
            geo_precisao = MAPA_PRECISAO[r.precisao] ?? 'cep_aproximado';
            geo_fonte = MAPA_FONTE_GEO[r.fonte] ?? 'brasilapi_cep';
            contadores.geo.com_coordenada += 1;
            contadores.geo.por_precisao[geo_precisao] = (contadores.geo.por_precisao[geo_precisao] ?? 0) + 1;
            geoOk = true;
          } else {
            contadores.geo.sem_coordenada += 1;
          }
        }

        if (!simular) {
          await repo.registrarEnriquecimentoGeo(e.cnpj, { lat, lon, geo_precisao, geo_fonte });
        }
      }

      // ── 2) Domínio e Radar de Site ──
      if ((tipo === 'site' || tipo === 'ambos') && !e.site_enriquecido_em) {
        contadores.site.tentadas += 1;
        const cand = extrairDominioCandidato(e);

        if (cand.status !== 'ok') {
          contadores.site.por_status[cand.status] = (contadores.site.por_status[cand.status] ?? 0) + 1;
          if (!simular) {
            await repo.registrarEnriquecimentoSite(e.cnpj, { site_status: cand.status });
          }
        } else {
          let radar = cacheRadar.get(cand.dominio);
          if (!radar) {
            contadores.site.requisicoes_http += 1;
            radar = await inspecionarSiteFn(cand.dominio);
            cacheRadar.set(cand.dominio, radar);
          } else {
            contadores.site.reuso_cache_dominio += 1;
          }

          const pertence = dominioPertenceAEmpresa(e, cand.dominio, radar);
          const site_status = !radar?.acessivel
            ? 'inacessivel'
            : pertence
              ? 'cnpj_confirmado'
              : 'cnpj_nao_encontrado';
          const dominio_confirmado = pertence;
          siteConfirmado = dominio_confirmado;

          contadores.site.por_status[site_status] = (contadores.site.por_status[site_status] ?? 0) + 1;

          if (!simular) {
            const { sinais } = await repo.registrarEnriquecimentoSite(e.cnpj, {
              dominio: cand.dominio,
              dominio_origem: cand.origem,
              dominio_confirmado,
              site_status,
              radar,
            });
            for (const s of sinais) {
              if (s.tipo === 'erp') contadores.site.sinais_erp += 1;
              if (s.tipo === 'rh') contadores.site.sinais_rh += 1;
            }
            if (sinais.length && amostraSinais.length < 10) {
              amostraSinais.push({
                cnpj: e.cnpj,
                razao_social: e.razao_social,
                dominio: cand.dominio,
                sinais: sinais.map((s) => `${s.tipo}:${s.nome}`),
              });
            }
          } else if (radar?.acessivel && (dominio_confirmado || cand.origem === 'manual')) {
            const erps = (radar.erps ?? []).filter((x) => x.evidencia);
            const rhs = (radar.rh ?? []).filter((x) => x.evidencia);
            contadores.site.sinais_erp += erps.length;
            contadores.site.sinais_rh += rhs.length;
          }
        }
      }

      // Avança etapa_funil de 'candidato' para 'enriquecido' quando ganhou coordenada ou site confirmado
      if (!simular && e.etapa_funil === 'candidato' && (geoOk || siteConfirmado)) {
        await repo.moverFunil({
          cnpj: e.cnpj,
          etapa: 'enriquecido',
          motivo: 'enriquecimento automático (geo/site)',
          ator: 'sistema',
        });
        contadores.qualificadas_funil += 1;
      }

      if ((idx + 1) % 25 === 0 || idx + 1 === pendentes.length) {
        aoLog(`✓ ${idx + 1}/${pendentes.length} empresas enriquecidas`);
        if (execucaoId) {
          await repo.atualizarExecucao(execucaoId, {
            checkpoint: { processadas: idx + 1, ultimo_cnpj: e.cnpj },
            contadores,
          });
        }
      }
    }

    if (execucaoId) {
      await repo.atualizarExecucao(execucaoId, { status: 'concluida', contadores });
    }
  } catch (erro) {
    if (execucaoId) {
      await repo.atualizarExecucao(execucaoId, { status: 'falhou', contadores, erro: erro.message }).catch(() => {});
    }
    throw erro;
  }

  return {
    tipo,
    simulado: simular,
    contadores,
    amostra_sinais: amostraSinais,
    execucao_id: execucaoId,
    duracao_s: Math.round((Date.now() - inicio) / 1000),
  };
}
