// Conector Geo: CEP/endereço → latitude/longitude.
// 1º BrasilAPI CEP v2 (traz coordenadas quando disponíveis) → 2º Nominatim (OpenStreetMap).
import { buscarJson, HttpError } from '../lib/http.js';
import { lerCache, gravarCache } from '../lib/cache.js';
import { limitar } from '../lib/throttle.js';

export const BRASILAPI_CEP = 'https://brasilapi.com.br/api/cep/v2/';
export const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// Política de uso do Nominatim: no máximo 1 requisição/segundo.
const INTERVALO_NOMINATIM = () => Number(process.env.NOMINATIM_INTERVALO_MS ?? 1_100);

export function limparCep(cep) {
  const d = String(cep ?? '').replace(/\D/g, '');
  if (d.length !== 8) throw new Error(`CEP inválido: "${cep}" (esperado 8 dígitos).`);
  return d;
}

function coordenadaValida(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || (la === 0 && lo === 0)) return null;
  // Caixa aproximada do território brasileiro
  if (la < -34 || la > 6 || lo < -74 || lo > -28) return null;
  return { lat: la, lon: lo };
}

export function normalizarCepBrasilApi(d) {
  return {
    cep: d.cep,
    logradouro: d.street || null,
    bairro: d.neighborhood || null,
    cidade: d.city || null,
    uf: d.state || null,
    codigoIbge: d.ibge?.city ?? null,
    coordenadas: coordenadaValida(d.location?.coordinates?.latitude, d.location?.coordinates?.longitude),
  };
}

async function nominatim(params) {
  const url = new URL(NOMINATIM);
  url.search = new URLSearchParams({ format: 'jsonv2', countrycodes: 'br', limit: '1', ...params }).toString();
  if (process.env.NOMINATIM_EMAIL) url.searchParams.set('email', process.env.NOMINATIM_EMAIL);
  const res = await limitar('nominatim', INTERVALO_NOMINATIM, () => buscarJson(url.toString(), { tentativas: 1 }));
  const primeiro = Array.isArray(res) ? res[0] : null;
  if (!primeiro) return null;
  const c = coordenadaValida(primeiro.lat, primeiro.lon);
  return c ? { ...c, descricao: primeiro.display_name ?? null } : null;
}

/** Tenta, em ordem de precisão, geocodificar via Nominatim. */
async function geocodificarNominatim({ cep, logradouro, cidade, uf }, avisos) {
  const tentativas = [];
  if (logradouro && cidade) tentativas.push({ precisao: 'endereco', params: { street: logradouro, city: cidade, ...(uf && { state: uf }) } });
  if (cep) tentativas.push({ precisao: 'cep', params: { postalcode: `${cep.slice(0, 5)}-${cep.slice(5)}` } });
  if (cidade) tentativas.push({ precisao: 'cidade', params: { city: cidade, ...(uf && { state: uf }) } });
  for (const t of tentativas) {
    try {
      const r = await nominatim(t.params);
      if (r) return { ...r, precisao: t.precisao };
    } catch (e) {
      avisos.push({ fonte: 'nominatim', status: e instanceof HttpError ? e.status : 0, mensagem: e.message });
    }
  }
  return null;
}

/**
 * Geocodifica um CEP (preferencial) ou um endereço livre.
 * Obs.: as coordenadas da BrasilAPI costumam ser o centróide do município (vários CEPs da mesma
 * cidade devolvem o mesmo ponto), por isso a precisão é marcada como "cep_aproximado".
 * Com precisaoRua=true, tenta antes o Nominatim pela rua + cidade.
 * @param {{ cep?: string, endereco?: string, precisaoRua?: boolean }} entrada
 */
export async function geocodificar({ cep, endereco, precisaoRua = false } = {}) {
  if (!cep && !endereco) throw new Error('Informe "cep" ou "endereco".');
  const avisos = [];

  // Endereço livre, sem CEP → direto no Nominatim
  if (!cep) {
    const chave = `end_${endereco}`;
    const emCache = await lerCache('geo', chave);
    if (emCache) return { ...emCache, doCache: true };
    let r = null;
    try {
      r = await nominatim({ q: endereco });
    } catch (e) {
      avisos.push({ fonte: 'nominatim', status: e instanceof HttpError ? e.status : 0, mensagem: e.message });
    }
    if (!r) return { encontrado: false, endereco, avisos, doCache: false };
    const final = { encontrado: true, endereco, lat: r.lat, lon: r.lon, precisao: 'endereco', descricao: r.descricao, fonte: 'nominatim' };
    await gravarCache('geo', chave, final);
    return { ...final, avisos, doCache: false };
  }

  const c = limparCep(cep);
  const chaveCep = `cep_${c}${precisaoRua ? '_rua' : ''}`;
  const emCache = await lerCache('geo', chaveCep);
  if (emCache) return { ...emCache, doCache: true };

  let base = { cep: c, logradouro: null, bairro: null, cidade: null, uf: null, codigoIbge: null, coordenadas: null };
  try {
    base = normalizarCepBrasilApi(await buscarJson(BRASILAPI_CEP + c));
  } catch (e) {
    avisos.push({ fonte: 'brasilapi', status: e instanceof HttpError ? e.status : 0, mensagem: e.message });
  }

  let geo = null;
  let fonte = null;
  if (precisaoRua && base.logradouro && base.cidade) {
    geo = await geocodificarNominatim({ logradouro: base.logradouro, cidade: base.cidade, uf: base.uf }, avisos);
    if (geo?.precisao !== 'endereco') geo = null; // só aceita se achou a rua
    fonte = geo ? 'nominatim' : null;
  }
  if (!geo && base.coordenadas) {
    geo = { ...base.coordenadas, precisao: 'cep_aproximado' };
    fonte = 'brasilapi';
  } else if (!geo) {
    geo = await geocodificarNominatim({ cep: c, logradouro: base.logradouro, cidade: base.cidade, uf: base.uf }, avisos);
    fonte = geo ? 'nominatim' : null;
  }

  const { coordenadas, ...endereco_ } = base;
  if (!geo && !base.cidade) return { encontrado: false, cep: c, avisos, doCache: false };

  const final = {
    encontrado: true,
    ...endereco_,
    lat: geo?.lat ?? null,
    lon: geo?.lon ?? null,
    precisao: geo?.precisao ?? null,
    fonte,
  };
  if (geo) await gravarCache('geo', chaveCep, final); // só guarda quando há coordenada
  return { ...final, avisos, doCache: false };
}
