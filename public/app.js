// Controlador da Interface b2b-estructure (Etapa 4)
// Segue o design system e a API de mapa (Leaflet + MarkerCluster + Heat) do b2b-hitmap-clients,
// com tema Claro/Escuro, filtros coloridos por setor e ícones monocromáticos.

/* global L */

const $ = (id) => document.getElementById(id);
const n = (v) => Number(v ?? 0).toLocaleString('pt-BR');
const moeda = (v) =>
  Number(v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const esc = (s) =>
  String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const fmtCnpj = (c) =>
  String(c ?? '').length === 14
    ? `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`
    : String(c ?? '');

const token = (nome) => getComputedStyle(document.documentElement).getPropertyValue(nome).trim();

const estado = {
  resumo: null,
  empresas: [],
  cnpjSelecionado: null,
  camada: 'pontos',
  mapa: null,
  grupoCluster: null,
  camadaCalor: null,
  camadaPolos: null,
  marcadores: new Map(),
};

function avisar(texto, duracao = 2600) {
  const el = $('aviso');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(avisar._t);
  avisar._t = setTimeout(() => { el.hidden = true; }, duracao);
}

// ───────────────────────── Tema Claro / Escuro ─────────────────────────

function aplicarTema(tema) {
  const t = tema === 'escuro' ? 'escuro' : 'claro';
  document.documentElement.setAttribute('data-tema', t);
  localStorage.setItem('b2b_tema', t);
  $('icone-sol').hidden = t !== 'escuro';
  $('icone-lua').hidden = t === 'escuro';
  $('rotulo-tema').textContent = t === 'escuro' ? 'Claro' : 'Escuro';
  if (estado.mapa) atualizarCamadasMapa();
}

function iniciarTema() {
  const salvo = localStorage.getItem('b2b_tema') || 'claro';
  aplicarTema(salvo);
  $('btn-tema').addEventListener('click', () => {
    const atual = document.documentElement.getAttribute('data-tema');
    aplicarTema(atual === 'escuro' ? 'claro' : 'escuro');
  });
}

// ───────────────────────── Mapa (OpenStreetMap + MarkerCluster + HeatLayer) ─────────────────────────

function iniciarMapa() {
  const map = L.map('map', { zoomControl: false }).setView([-20.65, -54.5], 7);
  L.control.zoom({ position: 'topleft' }).addTo(map);

  // Mesma API de mapa base do b2b-hitmap-clients (OpenStreetMap estilizado por filtro CSS)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap',
  }).addTo(map);

  const grupo = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 38,
    iconCreateFunction: (cluster) => {
      const qtd = cluster.getChildCount();
      const tam = qtd < 10 ? 30 : qtd < 50 ? 36 : 42;
      return L.divIcon({
        html: `<span class="grupo-pinos" style="width:${tam}px;height:${tam}px">${qtd}</span>`,
        className: '',
        iconSize: [tam, tam],
      });
    },
  });

  estado.mapa = map;
  estado.grupoCluster = grupo;
  estado.camadaPolos = L.layerGroup().addTo(map);
  map.addLayer(grupo);

  $('m-camada').addEventListener('change', (ev) => {
    estado.camada = ev.target.value;
    atualizarCamadasMapa();
  });

  $('chk-polos-fundo').addEventListener('change', () => {
    atualizarCamadasMapa();
  });
}

function iconePino(e, selecionado) {
  const cor = e.qualificacao?.setor?.cor || token('--cor-destaque') || '#2350c8';
  const clsDemais = e.porte === 'DEMAIS' ? ' demais' : '';
  const clsAtivo = selecionado ? ' ativo' : '';
  return L.divIcon({
    className: '',
    html: `<span class="pino${clsDemais}${clsAtivo}" style="--cor-pino:${cor}"></span>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function desenharPolosMunicipais() {
  if (!estado.camadaPolos || !estado.resumo) return;
  estado.camadaPolos.clearLayers();
  const mostrar = $('chk-polos-fundo').checked || estado.camada === 'polos';
  if (!mostrar) return;

  const corDestaque = token('--cor-destaque') || '#2350c8';
  for (const m of estado.resumo.municipios) {
    if (m.lat == null || m.lon == null) continue;
    const raio = Math.max(6, Math.min(32, Math.sqrt(m.total) * 0.42));
    const c = L.circleMarker([m.lat, m.lon], {
      radius: raio,
      color: corDestaque,
      weight: 1.5,
      fillColor: corDestaque,
      fillOpacity: estado.camada === 'polos' ? 0.28 : 0.12,
    });
    c.bindTooltip(
      `<strong>${esc(m.municipio)}</strong><br/>${n(m.total)} matrizes (${n(m.demais)} DEMAIS · ${n(m.epp)} EPP)<br/>Capital: ${moeda(m.capital_total)}`,
      { direction: 'top' }
    );
    c.on('click', () => {
      $('f-municipio').value = m.municipio;
      carregarEmpresas({ enquadrar: true });
    });
    c.addTo(estado.camadaPolos);
  }
}

function atualizarCamadasMapa({ enquadrar = false } = {}) {
  if (!estado.mapa) return;
  desenharPolosMunicipais();

  estado.grupoCluster.clearLayers();
  estado.marcadores.clear();
  if (estado.camadaCalor) {
    estado.mapa.removeLayer(estado.camadaCalor);
    estado.camadaCalor = null;
  }

  const pontos = estado.empresas.filter((e) => Number.isFinite(e.lat_mapa) && Number.isFinite(e.lon_mapa));

  if (estado.camada === 'pontos') {
    for (const e of pontos) {
      const m = L.marker([e.lat_mapa, e.lon_mapa], {
        icon: iconePino(e, e.cnpj === estado.cnpjSelecionado),
        title: e.razao_social,
      });
      m.bindTooltip(
        `<strong>${esc(e.razao_social)}</strong><br/>${esc(e.municipio)} · ${esc(e.porte)} · Score ${e.qualificacao.score}`,
        { direction: 'top', offset: [0, -6] }
      );
      m.on('click', () => selecionarEmpresa(e.cnpj, { centralizar: false }));
      estado.grupoCluster.addLayer(m);
      estado.marcadores.set(e.cnpj, { m, e });
    }
  } else if (estado.camada === 'potencial' || estado.camada === 'setor') {
    const peso = estado.camada === 'potencial' ? (e) => (e.qualificacao?.score || 50) / 100 : () => 1;
    estado.camadaCalor = L.heatLayer(
      pontos.map((e) => [e.lat_mapa, e.lon_mapa, peso(e)]),
      {
        radius: 30,
        blur: 22,
        maxZoom: 10,
        minOpacity: 0.35,
        gradient: {
          0.3: token('--cor-destaque-suave') || '#e9eefb',
          0.65: token('--prio-media') || '#8aa3e6',
          1: token('--prio-alta') || '#2350c8',
        },
      }
    ).addTo(estado.mapa);
  }

  if (enquadrar && pontos.length) {
    estado.mapa.fitBounds(
      L.latLngBounds(pontos.map((p) => [p.lat_mapa, p.lon_mapa])),
      { padding: [44, 44], maxZoom: 13 }
    );
  }
}

// ───────────────────────── Chips Coloridos de Setor e Legenda ─────────────────────────

function renderizarChipsELegenda() {
  if (!estado.resumo) return;
  const setorAtual = $('f-setor').value;

  $('chips-setores').innerHTML = [
    `<button type="button" class="chip-setor ${!setorAtual ? 'ativo' : ''}" data-setor="">Todos os setores</button>`,
    ...estado.resumo.setores.map(
      (s) => `
      <button
        type="button"
        class="chip-setor ${setorAtual === s.id ? 'ativo' : ''}"
        data-setor="${esc(s.id)}"
        style="--cor-setor:${s.cor};--cor-setor-suave:${s.corSuave || 'rgba(35,80,200,0.12)'}"
      >
        <span class="tag-ponto" style="background:${s.cor}"></span>
        <span>${esc(s.nome.split(',')[0])}</span>
      </button>`
    ),
  ].join('');

  for (const btn of document.querySelectorAll('.chip-setor')) {
    btn.addEventListener('click', () => {
      $('f-setor').value = btn.dataset.setor;
      renderizarChipsELegenda();
      carregarEmpresas({ enquadrar: false });
    });
  }

  $('legenda-mapa').innerHTML = `
    <b>Macro-Setores no Mapa</b>
    ${estado.resumo.setores
      .map(
        (s) => `
      <div class="legenda-item">
        <span class="pino" style="--cor-pino:${s.cor}"></span>
        <span>${esc(s.nome.split(',')[0])} (${n(s.total)})</span>
      </div>`
      )
      .join('')}
    <div class="legenda-item" style="margin-top:8px;padding-top:6px;border-top:1px solid var(--cor-borda);">
      <span class="pino demais" style="--cor-pino:var(--cor-destaque)"></span>
      <span>Anel externo = Porte DEMAIS</span>
    </div>
  `;
}

// ───────────────────────── Lista Lateral de Empresas (.card) ─────────────────────────

function renderizarListaEmpresas() {
  const cont = $('lista-empresas');
  const totalBase = estado.resumo?.kpis?.total_empresas ?? estado.empresas.length;
  $('lista-contagem').textContent = `${n(estado.empresas.length)} exibidas de ${n(totalBase)} matrizes`;

  if (!estado.empresas.length) {
    cont.innerHTML = `<p class="vazio">Nenhuma empresa encontrada com esses filtros.</p>`;
    return;
  }

  cont.innerHTML = estado.empresas
    .map((e) => {
      const q = e.qualificacao;
      const sinais = Array.isArray(e.sinais) ? e.sinais : [];
      const tagsSinais = sinais
        .map(
          (s) =>
            `<span class="tag ${s.tipo === 'erp' ? 'tag-alerta' : 'tag-sucesso'}">${esc(s.tipo.toUpperCase())}: ${esc(s.nome.toUpperCase())}</span>`
        )
        .join('');
      const tagPncp =
        e.contratos_pncp > 0
          ? `<span class="tag tag-roxo">PNCP (${e.contratos_pncp}) · ${moeda(e.valor_contratos_pncp)}</span>`
          : '';
      const tagPorte =
        e.porte === 'DEMAIS'
          ? `<span class="tag tag-destaque">Porte DEMAIS</span>`
          : `<span class="tag">Porte EPP</span>`;

      return `
        <button class="card" type="button" data-cnpj="${esc(e.cnpj)}" ${e.cnpj === estado.cnpjSelecionado ? 'aria-current="true"' : ''}>
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">
            <h3 style="margin:0;flex:1;">${esc(e.razao_social)}</h3>
            <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([e.razao_social, e.municipio, 'MS'].join(' '))}" target="_blank" rel="noopener" class="link-maps-card" title="Abrir no Google Maps" onclick="event.stopPropagation();" style="color:var(--cor-texto-suave);display:inline-flex;padding:2px;">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
            </a>
          </div>
          <div class="score">
            <strong>${q.score}</strong>
            <div class="barra"><i style="width:${q.score}%;background:${q.setor.cor}"></i></div>
          </div>
          <div class="meta">${esc(q.cnae_descricao)} · ${esc(e.municipio)}</div>
          <div class="tags">
            <span class="tag" style="background:${q.setor.corSuave};color:${q.setor.cor}">
              <span class="tag-ponto" style="background:${q.setor.cor}"></span>
              ${esc(q.setor.nome.split(',')[0])}
            </span>
            ${tagPorte}
            ${tagsSinais}
            ${tagPncp}
            ${e.dominio ? `<span class="tag">${esc(e.dominio)}</span>` : ''}
          </div>
        </button>
      `;
    })
    .join('');

  for (const btn of cont.querySelectorAll('.card')) {
    btn.addEventListener('click', () => selecionarEmpresa(btn.dataset.cnpj, { centralizar: true }));
  }
}

// ───────────────────────── Painel Flutuante de Detalhe (.painel) ─────────────────────────

async function selecionarEmpresa(cnpj, { centralizar = true } = {}) {
  estado.cnpjSelecionado = cnpj;
  for (const c of document.querySelectorAll('.card')) {
    c.toggleAttribute('aria-current', c.dataset.cnpj === cnpj);
  }

  const res = await fetch(`/api/empresas/${cnpj}`);
  if (!res.ok) return;
  const d = await res.json();

  if (centralizar && estado.mapa && Number.isFinite(d.lat_mapa) && Number.isFinite(d.lon_mapa)) {
    const reg = estado.marcadores.get(cnpj);
    if (reg && estado.camada === 'pontos') {
      estado.grupoCluster.zoomToShowLayer(reg.m, () => estado.mapa.panTo([d.lat_mapa, d.lon_mapa]));
    } else {
      estado.mapa.flyTo([d.lat_mapa, d.lon_mapa], d.geo_aproximado_municipio ? 11 : 14, { duration: 0.7 });
    }
  }
  atualizarCamadasMapa({ enquadrar: false });
  renderizarPainelDetalhe(d);
}

function renderizarPainelDetalhe(d) {
  const q = d.qualificacao;
  const telDigitos = String(d.telefone_e164 || '').replace(/\D/g, '');

  $('d-nome').textContent = d.razao_social;
  $('d-meta').textContent = [d.nome_fantasia, `CNPJ ${fmtCnpj(d.cnpj)}`, d.municipio].filter(Boolean).join(' · ');
  $('d-score').textContent = q.score;

  const sinaisHtml =
    d.sinais && d.sinais.length
      ? d.sinais
          .map(
            (s) => `
          <div style="margin-bottom:8px;">
            <div class="linha-tags" style="margin-bottom:4px;">
              <span class="tag ${s.tipo === 'erp' ? 'tag-alerta' : 'tag-sucesso'}">${esc(s.tipo.toUpperCase())}: ${esc(s.nome.toUpperCase())}</span>
              <span class="tag">Evidência verificada</span>
            </div>
            <blockquote class="citacao">${esc(s.evidencia)}</blockquote>
            ${s.url_evidencia ? `<p class="dica"><a href="${esc(s.url_evidencia)}" target="_blank" rel="noopener" style="color:var(--cor-destaque)">Abrir fonte (${esc(s.url_evidencia)})</a></p>` : ''}
          </div>`
          )
          .join('')
      : `<p class="dica" style="margin:0">Nenhuma assinatura de ERP ou portal de RH confirmada no HTML até o momento.</p>`;

  const pncpHtml =
    d.contratos && d.contratos.length
      ? `
        <ul class="pncp-lista">
          ${d.contratos
            .map(
              (c) => `
            <li>
              <strong>${esc(c.orgao_nome || 'Órgão contratante')} — ${moeda(c.valor_global)}</strong>
              <span>${esc(c.objeto || 'Objeto não informado')}</span>
              <div style="display:flex;justify-content:space-between;margin-top:4px;">
                <span>Assinatura: ${esc(c.data_assinatura || '—')}</span>
                <a href="${esc(c.url_fonte)}" target="_blank" rel="noopener" style="color:var(--cor-destaque)">Fonte PNCP</a>
              </div>
            </li>`
            )
            .join('')}
        </ul>`
      : `<p class="dica" style="margin:0">Nenhum contrato público vinculado no período sincronizado.</p>`;

  $('d-corpo').innerHTML = `
    <div class="linha-tags">
      <span class="tag" style="background:${q.setor.corSuave};color:${q.setor.cor}">
        <span class="tag-ponto" style="background:${q.setor.cor}"></span>
        ${esc(q.setor.nome)}
      </span>
      <span class="tag tag-destaque">Porte ${esc(d.porte)}</span>
      <span class="tag">${esc(q.classificacao)}</span>
      <span class="tag">Funil: ${esc(d.etapa_funil)}</span>
    </div>

    ${q.alertas.map((a) => `<p class="aviso-regra">${esc(a)}</p>`).join('')}

    <div class="dados">
      <div><span>Capital social</span><strong>${moeda(d.capital_social)}</strong></div>
      <div><span>Abertura</span><strong>${esc(d.data_abertura || '—')}</strong></div>
      <div>
        <span>Telefone (${esc(d.telefone_origem)})</span>
        <strong>${esc(d.telefone_e164 || 'Não informado')}</strong>
        ${d.telefone_repeticoes >= 10 ? `<small class="dica">Repetido em ${d.telefone_repeticoes} empresas (contador)</small>` : ''}
      </div>
      <div>
        <span>E-mail (${esc(d.email_origem)})</span>
        <strong>${esc(d.email || 'Não informado')}</strong>
      </div>
      <div class="dados-largo">
        <span>Endereço (Receita Federal)</span>
        <strong>${esc([d.logradouro, d.numero, d.complemento, d.bairro, d.municipio, d.uf, d.cep].filter(Boolean).join(', '))}</strong>
        <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
          <a class="btn btn-fantasma" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([d.razao_social, d.logradouro, d.numero, d.municipio, 'MS'].filter(Boolean).join(' '))}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px;display:inline-flex;align-items:center;gap:4px;" title="Ver localização e dados no Google Maps">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px;height:13px" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>
            <span>Google Maps</span>
          </a>
          ${Number.isFinite(d.lat_mapa) && Number.isFinite(d.lon_mapa) ? `
          <a class="btn btn-fantasma" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${d.lat_mapa},${d.lon_mapa}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px;display:inline-flex;align-items:center;gap:4px;" title="Visualizar fachada no Google Street View">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px;height:13px" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path><circle cx="12" cy="13" r="4"></circle></svg>
            <span>Street View</span>
          </a>` : ''}
          <a class="btn btn-fantasma" href="https://www.google.com/search?q=${encodeURIComponent(d.razao_social + ' ' + d.municipio + ' avaliacoes')}" target="_blank" rel="noopener" style="font-size:12px;padding:4px 8px;display:inline-flex;align-items:center;gap:4px;" title="Buscar reputação e avaliações públicas no Google">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px;height:13px" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>
            <span>Avaliações Google</span>
          </a>
        </div>
      </div>
      <div>
        <label for="sel-etapa-painel"><span>Etapa do funil</span></label>
        <select id="sel-etapa-painel" class="campo" style="width:100%;margin-top:4px;">
          ${['candidato', 'enriquecido', 'qualificado', 'contatado', 'descartado']
            .map((et) => `<option value="${et}" ${d.etapa_funil === et ? 'selected' : ''}>${et.toUpperCase()}</option>`)
            .join('')}
        </select>
      </div>
      <div>
        <span>Localização no mapa</span>
        <strong>${d.geo_aproximado_municipio ? 'Centro do município' : `CEP geocodificado (${esc(d.geo_precisao)})`}</strong>
      </div>
    </div>

    <div>
      <span class="rotulo">Diagnóstico Operacional &amp; Tese ERP</span>
      <div class="dados" style="grid-template-columns:1fr;gap:8px;">
        <div><span>Cenário identificado</span><strong>${esc(q.cenario_erp)}</strong></div>
        <div><span>Dor reconhecida do setor</span><strong>${esc(q.dor_diagnosticada)}</strong></div>
        <div><span>Estratégia de abordagem RevOps</span><strong>${esc(q.estrategia_abordagem)}</strong></div>
      </div>
    </div>

    <div>
      <span class="rotulo">Radar de Site (ERP / RH) &amp; Inspeção sob Demanda</span>
      ${sinaisHtml}
      <div style="display:flex;gap:6px;margin-top:8px;">
        <input id="inp-dom-painel" class="campo" style="flex:1" type="text" placeholder="empresa.com.br" value="${esc(d.dominio || '')}" />
        <button id="btn-inspecionar-painel" class="btn" type="button">Inspecionar site</button>
      </div>
      <p class="dica">Status atual: ${esc(d.site_status || 'não verificado')}</p>
    </div>

    <div>
      <span class="rotulo">Contratos Públicos (PNCP)</span>
      ${pncpHtml}
    </div>

    <div>
      <span class="rotulo">Composição do Score (${q.score} pts)</span>
      <ul class="fatores-lista">
        ${q.fatores
          .map(
            (f) => `
          <li>
            <span>${esc(f.criterio)}</span>
            <strong style="color:${f.impacto >= 0 ? 'var(--cor-sucesso)' : 'var(--cor-erro)'}">${f.impacto >= 0 ? `+${f.impacto}` : f.impacto}</strong>
          </li>`
          )
          .join('')}
      </ul>
    </div>

    <div>
      <span class="rotulo">Mensagem Consultiva (WhatsApp / Abordagem)</span>
      <textarea id="txt-msg-painel" class="mensagem">${esc(q.roteiro_whatsapp)}</textarea>
      <p class="dica">${q.roteiro_whatsapp.length} caracteres</p>
    </div>
  `;

  $('d-rodape').innerHTML = `
    <button id="btn-optout-painel" class="btn btn-perigo" type="button" style="margin-right:auto">Não contatar (LGPD)</button>
    <button id="btn-copiar-painel" class="btn" type="button">Copiar mensagem</button>
    ${
      telDigitos
        ? `<a id="btn-wa-painel" class="btn btn-primario" href="https://wa.me/${telDigitos}?text=${encodeURIComponent(q.roteiro_whatsapp)}" target="_blank" rel="noopener">Abrir no WhatsApp</a>`
        : ''
    }
  `;

  $('painel').hidden = false;

  $('sel-etapa-painel').addEventListener('change', async (ev) => {
    const etapa = ev.target.value;
    const r = await fetch(`/api/empresas/${d.cnpj}/funil`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ etapa, motivo: `Alterado para ${etapa} pelo operador` }),
    });
    if (r.ok) {
      const resp = await r.json();
      avisar(resp.aviso_demo || `Etapa atualizada para ${etapa.toUpperCase()}`);
      renderizarPainelDetalhe(resp);
      await carregarEmpresas({ enquadrar: false });
    }
  });

  $('btn-inspecionar-painel').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget;
    const dom = $('inp-dom-painel').value.trim();
    btn.disabled = true;
    btn.textContent = 'Verificando...';
    try {
      const r = await fetch(`/api/empresas/${d.cnpj}/enriquecer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dominio: dom || undefined }),
      });
      if (r.ok) {
        const resp = await r.json();
        renderizarPainelDetalhe(resp);
        avisar(resp.aviso_demo || 'Inspeção de site e geocodificação concluídas');
        await carregarResumo();
        await carregarEmpresas({ enquadrar: false });
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Inspecionar site';
    }
  });

  $('btn-copiar-painel').addEventListener('click', async () => {
    const txt = $('txt-msg-painel').value;
    await navigator.clipboard.writeText(txt);
    avisar('Mensagem copiada para a área de transferência');
  });

  $('btn-optout-painel').addEventListener('click', async () => {
    if (!confirm(`Confirmar inclusão permanente de ${d.razao_social} na lista global nao_contatar (LGPD)?`)) return;
    const r = await fetch(`/api/empresas/${d.cnpj}/bloquear`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ motivo: 'Solicitação de não contato registrada pelo operador' }),
    });
    if (r.ok) {
      const resp = await r.json();
      $('painel').hidden = true;
      estado.cnpjSelecionado = null;
      avisar(resp.aviso_demo || 'Empresa incluída na lista global de não contato (LGPD)');
      await carregarResumo();
      await carregarEmpresas({ enquadrar: false });
    }
  });
}

// ───────────────────────── Dashboard Executivo ─────────────────────────

function renderizarDashboard() {
  const r = estado.resumo;
  if (!r) return;
  const k = r.kpis;

  $('st-total').textContent = n(k.total_empresas);
  $('st-demais').textContent = n(k.demais);
  $('st-pncp').textContent = `${n(k.total_contratos)} (${moeda(k.valor_total)})`;
  $('st-sinais').textContent = n(k.total_sinais);
  $('header-meta').textContent = `${n(k.total_empresas)} matrizes ativas em MS · ${n(k.com_telefone)} com telefone · ${n(k.com_email)} com e-mail`;

  $('dash-kpis').innerHTML = `
    <div class="kpi-card">
      <div class="k-label">Matrizes Qualificadas (MS)</div>
      <div class="k-val">${n(k.total_empresas)}</div>
      <div class="k-sub">${n(k.demais)} Porte DEMAIS · ${n(k.epp)} Porte EPP</div>
    </div>
    <div class="kpi-card">
      <div class="k-label">Capital Social Somado</div>
      <div class="k-val">${moeda(k.capital_social_total)}</div>
      <div class="k-sub">79 municípios sul-mato-grossenses</div>
    </div>
    <div class="kpi-card">
      <div class="k-label">Contatos Verificados (Receita)</div>
      <div class="k-val">${n(k.com_telefone)}</div>
      <div class="k-sub">${n(k.com_email)} com e-mail cadastral oficial</div>
    </div>
    <div class="kpi-card">
      <div class="k-label">Contratos Públicos (PNCP)</div>
      <div class="k-val">${moeda(k.valor_total)}</div>
      <div class="k-sub">${n(k.total_contratos)} contratos em ${n(k.empresas_com_contrato)} matrizes</div>
    </div>
    <div class="kpi-card">
      <div class="k-label">Sinais ERP / RH Confirmados</div>
      <div class="k-val">${n(k.total_sinais)}</div>
      <div class="k-sub">${n(k.dominio_confirmado)} domínios corporativos confirmados</div>
    </div>
  `;

  $('dash-setores').innerHTML = r.setores
    .map(
      (s) => `
      <div class="setor-card" style="border-left:4px solid ${s.cor}">
        <div class="setor-card-topo">
          <h3>
            <span class="tag-ponto" style="background:${s.cor};width:10px;height:10px;"></span>
            <span>${esc(s.nome)}</span>
          </h3>
          <span class="tag" style="background:${s.corSuave};color:${s.cor}">${n(s.total)} matrizes (${n(s.demais)} DEMAIS)</span>
        </div>
        <p class="setor-texto"><strong>Dor Operacional:</strong> ${esc(s.dorPadrao)}</p>
        <p class="setor-texto"><strong>Argumento Executivo ERP:</strong> ${esc(s.argumentoErp)}</p>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:4px;">
          <span class="dica" style="margin:0">Capital acumulado: ${moeda(s.capital_total)}</span>
          <button class="btn btn-ir-setor" data-setor="${esc(s.id)}" type="button">Filtrar no Mapa</button>
        </div>
      </div>`
    )
    .join('');

  for (const b of document.querySelectorAll('.btn-ir-setor')) {
    b.addEventListener('click', () => {
      $('f-setor').value = b.dataset.setor;
      renderizarChipsELegenda();
      alternarVisao('mapa');
      carregarEmpresas({ enquadrar: true });
    });
  }

  $('dash-sinais').innerHTML = r.sinais_confirmados.length
    ? `<table class="tabela">
        <thead><tr><th>Empresa</th><th>Município</th><th>Sinal</th><th>Evidência HTML</th></tr></thead>
        <tbody>
          ${r.sinais_confirmados
            .map(
              (s) => `
            <tr data-cnpj="${esc(s.cnpj)}">
              <td><strong>${esc(s.razao_social)}</strong><br/><span class="dica">${esc(fmtCnpj(s.cnpj))}</span></td>
              <td>${esc(s.municipio)}</td>
              <td><span class="tag ${s.tipo === 'erp' ? 'tag-alerta' : 'tag-sucesso'}">${esc(s.tipo.toUpperCase())}: ${esc(s.nome.toUpperCase())}</span></td>
              <td><code>${esc(s.evidencia)}</code></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`
    : `<p class="dica">Nenhum sinal confirmado ainda.</p>`;

  $('dash-pncp').innerHTML = r.contratos_pncp.length
    ? `<table class="tabela">
        <thead><tr><th>Fornecedora (MS)</th><th>Órgão</th><th>Objeto</th><th>Valor</th></tr></thead>
        <tbody>
          ${r.contratos_pncp
            .map(
              (c) => `
            <tr data-cnpj="${esc(c.cnpj_matriz)}">
              <td><strong>${esc(c.razao_social)}</strong><br/><span class="dica">${esc(c.municipio)}</span></td>
              <td>${esc(c.orgao_nome)}</td>
              <td>${esc((c.objeto || '').slice(0, 68))}…</td>
              <td><strong>${moeda(c.valor_global)}</strong></td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`
    : `<p class="dica">Nenhum contrato público sincronizado.</p>`;

  $('dash-municipios').innerHTML = `
    <table class="tabela">
      <thead><tr><th>Município (MS)</th><th>Total</th><th>Porte DEMAIS</th><th>Capital Social</th></tr></thead>
      <tbody>
        ${r.municipios
          .slice(0, 15)
          .map(
            (m) => `
          <tr data-mun="${esc(m.municipio)}">
            <td><strong>${esc(m.municipio)}</strong></td>
            <td>${n(m.total)}</td>
            <td>${n(m.demais)}</td>
            <td>${moeda(m.capital_total)}</td>
          </tr>`
          )
          .join('')}
      </tbody>
    </table>
  `;

  $('dash-governanca').innerHTML = `
    <div style="display:grid;gap:12px;font-size:var(--fs-sm);color:var(--cor-texto-2);line-height:1.55;">
      <div>
        <strong style="color:var(--cor-texto);display:block;">Proteção por Desenho (LGPD) no Banco de Dados</strong>
        Os arquivos de quadro societário (<code>Socios0..9.zip</code>) jamais são baixados e o schema PostgreSQL bloqueia qualquer coluna de sócio ou CPF na razão social/fantasia.
      </div>
      <div>
        <strong style="color:var(--cor-texto);display:block;">Filtro Estrito de Porte e Natureza Empresarial</strong>
        Foram descartados 321.696 registros de MEI, Empresário Individual e Microempresas na ingestão de MS, mantendo apenas sociedades empresárias (código 2xxx) de porte EPP e DEMAIS.
      </div>
      <div>
        <strong style="color:var(--cor-texto);display:block;">Sinalização de Escritórios Contábeis</strong>
        Detectados <strong>${n(r.qualidade_dados.telefones_contadores)}</strong> telefones compartilhados por 10 ou mais empresas (${n(r.qualidade_dados.empresas_com_telefone_contador)} CNPJs). O dossiê alerta automaticamente quando o telefone é de contabilidade.
      </div>
      <div>
        <strong style="color:var(--cor-texto);display:block;">Isolamento Multi-Tenant (RLS Forçado)</strong>
        Todas as leituras e escritas operam sob o papel restrito <code>prospeccao_app</code> sem permissão de <code>DELETE</code> e com auditoria imutável em <code>funil_historico</code>.
      </div>
    </div>
  `;

  for (const tr of document.querySelectorAll('#dash-sinais tr[data-cnpj], #dash-pncp tr[data-cnpj]')) {
    tr.addEventListener('click', () => {
      alternarVisao('mapa');
      selecionarEmpresa(tr.dataset.cnpj, { centralizar: true });
    });
  }
  for (const tr of document.querySelectorAll('#dash-municipios tr[data-mun]')) {
    tr.addEventListener('click', () => {
      $('f-municipio').value = tr.dataset.mun;
      alternarVisao('mapa');
      carregarEmpresas({ enquadrar: true });
    });
  }
}

// ───────────────────────── Carregamento e Eventos ─────────────────────────

async function carregarResumo() {
  const r = await fetch('/api/resumo');
  if (!r.ok) {
    const erro = await r.json().catch(() => ({}));
    avisar(erro.erro || 'Erro ao carregar dados do servidor');
    return;
  }
  estado.resumo = await r.json();

  const selMun = $('f-municipio');
  if (selMun.options.length <= 1) {
    for (const m of estado.resumo.municipios) {
      const opt = document.createElement('option');
      opt.value = m.municipio;
      opt.textContent = `${m.municipio} (${n(m.total)})`;
      selMun.appendChild(opt);
    }
  }

  renderizarChipsELegenda();
  renderizarDashboard();
  desenharPolosMunicipais();
}

function obterParametrosFiltro() {
  const params = new URLSearchParams();
  const q = $('f-q').value.trim();
  const municipio = $('f-municipio').value;
  const setor = $('f-setor').value;
  const porte = $('f-porte').value;
  const filtro = $('f-especial').value;
  const etapa = $('f-etapa').value;

  if (q) params.set('q', q);
  if (municipio) params.set('municipio', municipio);
  if (setor) params.set('setor', setor);
  if (porte) params.set('porte', porte);
  if (filtro) params.set('filtro', filtro);
  if (etapa) params.set('etapa', etapa);
  return params;
}

async function carregarEmpresas({ enquadrar = false } = {}) {
  const params = obterParametrosFiltro();
  params.set('limite', '160');

  const r = await fetch(`/api/empresas?${params}`);
  if (!r.ok) {
    const erro = await r.json().catch(() => ({}));
    avisar(erro.erro || 'Erro ao consultar empresas');
    return;
  }
  const dados = await r.json();
  estado.empresas = dados.empresas || [];

  renderizarListaEmpresas();
  atualizarCamadasMapa({ enquadrar });
}

function alternarVisao(visao) {
  for (const b of document.querySelectorAll('.aba-visao')) {
    b.setAttribute('aria-selected', String(b.dataset.view === visao));
  }
  $('view-mapa').hidden = visao !== 'mapa';
  $('view-dashboard').hidden = visao !== 'dashboard';
  if (visao === 'mapa' && estado.mapa) {
    setTimeout(() => estado.mapa.invalidateSize(), 60);
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  iniciarTema();
  iniciarMapa();

  for (const b of document.querySelectorAll('.aba-visao')) {
    b.addEventListener('click', () => alternarVisao(b.dataset.view));
  }

  $('btn-fechar-painel').addEventListener('click', () => {
    $('painel').hidden = true;
    estado.cnpjSelecionado = null;
    for (const c of document.querySelectorAll('.card')) c.removeAttribute('aria-current');
    atualizarCamadasMapa({ enquadrar: false });
  });

  let timerBusca = null;
  $('f-q').addEventListener('input', () => {
    clearTimeout(timerBusca);
    timerBusca = setTimeout(() => carregarEmpresas({ enquadrar: false }), 240);
  });

  for (const id of ['f-municipio', 'f-setor', 'f-porte', 'f-especial', 'f-etapa']) {
    $(id).addEventListener('change', () => {
      if (id === 'f-setor') renderizarChipsELegenda();
      carregarEmpresas({ enquadrar: id === 'f-municipio' });
    });
  }

  $('btn-limpar').addEventListener('click', () => {
    for (const id of ['f-q', 'f-municipio', 'f-setor', 'f-porte', 'f-especial', 'f-etapa']) {
      $(id).value = '';
    }
    renderizarChipsELegenda();
    carregarEmpresas({ enquadrar: false });
  });

  $('btn-exportar').addEventListener('click', () => {
    const params = obterParametrosFiltro();
    avisar('Exportando planilha CSV para CRM...');
    window.open(`/api/exportar?${params.toString()}`, '_blank');
  });

  await carregarResumo();
  await carregarEmpresas({ enquadrar: false });
});
