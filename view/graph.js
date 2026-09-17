document.addEventListener('DOMContentLoaded', async () => {
  const browserApi = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  const container = document.getElementById('mynetwork');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const queryDisplay = document.getElementById('queryDisplay');
  const nodeDetails = document.getElementById('nodeDetails');

  if (!browserApi || !browserApi.storage || !browserApi.storage.local) {
    showRuntimeError('L’extension n’est pas accessible dans ce contexte. Ouvre cette vue depuis l’extension Firefox/Chrome.');
    return;
  }

  let cy = null;
  let fcoseRegistered = false;

  const groupColors = {
    person: '#38bdf8',
    company: '#10b981',
    social: '#f59e0b',
    email: '#8b5cf6',
    source: '#ec4899'
  };

  const rootColor = '#ef4444';

  function showRuntimeError(message) {
    loadingOverlay.style.display = 'none';
    nodeDetails.innerHTML = `<div style="color: #ef4444; font-weight: 600;">Erreur de rendu du graphe</div><div style="color: var(--text-muted); margin-top: 8px;">${message}</div>`;
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#f8fafc;">Le graphe n’a pas pu être affiché.</div>';
  }

  function buildCytoscapeGraph(graphData) {
    const nodes = (graphData.nodes || []).map(node => ({
      data: {
        id: String(node.id),
        label: node.label,
        group: node.group,
        title: node.title || node.label,
        raw: node,
        color: node.isRoot ? rootColor : (groupColors[node.group] || groupColors.person),
        size: node.isRoot ? 45 : 30,
        shape: node.isRoot ? 'diamond' : 'ellipse'
      }
    }));

    const edges = (graphData.edges || []).map(edge => ({
      data: {
        id: `${edge.from}->${edge.to}:${edge.label || 'link'}`,
        source: String(edge.from),
        target: String(edge.to),
        label: edge.label || '',
        color: '#94a3b8'
      }
    }));

    return { nodes, edges };
  }

  function renderGraph(graphData) {
    if (typeof cytoscape === 'undefined') {
      showRuntimeError('La bibliothèque Cytoscape.js n’est pas chargée.');
      return;
    }

    if (!fcoseRegistered) {
      if (typeof cytoscapeFcose === 'undefined') {
        showRuntimeError('Le plugin fCoSE n’est pas chargé.');
        return;
      }
      cytoscapeFcose(cytoscape);
      fcoseRegistered = true;
    }

    const elements = buildCytoscapeGraph(graphData);

    if (cy) {
      cy.destroy();
    }

    cy = cytoscape({
      container,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            'background-color': 'data(color)',
            'label': 'data(label)',
            'text-valign': 'center',
            'text-halign': 'center',
            'font-size': '12px',
            'font-weight': '600',
            'color': '#f8fafc',
            'text-outline-width': 2,
            'text-outline-color': '#0f172a',
            'width': 'data(size)',
            'height': 'data(size)',
            'shape': 'data(shape)',
            'border-width': 2,
            'border-color': '#0f172a'
          }
        },
        {
          selector: 'edge',
          style: {
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#94a3b8',
            'line-color': '#94a3b8',
            'width': 1.5,
            'label': 'data(label)',
            'font-size': '9px',
            'color': '#cbd5e1',
            'text-rotation': 'autorotate'
          }
        }
      ],
      layout: {
        name: 'fcose',
        quality: 'default',
        animate: true,
        randomize: false,
        fit: true,
        padding: 30,
        nodeRepulsion: 4500,
        idealEdgeLength: 100,
        edgeElasticity: 0.45,
        nestingFactor: 0.1,
        gravity: 0.25,
        numIter: 250,
        tile: true,
        tilingPaddingVertical: 10,
        tilingPaddingHorizontal: 10
      },
      wheelSensitivity: 0.35
    });

    cy.on('tap', 'node', function (event) {
      const node = event.target;
      const raw = node.data('raw');
      if (raw) {
        renderSidebarDetails(raw);
      }
    });

    cy.on('tap', function (event) {
      if (event.target === cy) {
        nodeDetails.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">Cliquez sur un nœud du réseau pour afficher ses informations détaillées.</div>';
      }
    });

    cy.on('dragfree', 'node', function (event) {
      const movedNode = event.target;
      const localGraph = movedNode.closedNeighborhood();

      localGraph.layout({
        name: 'fcose',
        quality: 'default',
        randomize: false,
        animate: true,
        fit: false,
        padding: 20,
        nodeRepulsion: 3000,
        idealEdgeLength: 90,
        edgeElasticity: 0.45,
        gravity: 0.15,
        numIter: 80,
        tile: false
      }).run();
    });

    cy.fit();
  }

  function renderSidebarDetails(raw) {
    let html = `
      <div class="node-detail-name">${raw.label}</div>
      <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">Type: ${(raw.group || 'unknown').toUpperCase()}</div>
      <div style="font-size: 13px; line-height: 1.4; color: var(--text-main);">
        <strong>Description:</strong><br>${raw.title || 'N/A'}
      </div>
    `;
    nodeDetails.innerHTML = html;
  }

  async function loadDataAndRender() {
    const data = await browserApi.storage.local.get(['currentQuery', 'graphData', 'graphStatus']);

    if (data.currentQuery) {
      if (data.currentQuery.type === 'person') {
        queryDisplay.textContent = `Cible : ${data.currentQuery.prenom} ${data.currentQuery.nom}`;
      } else {
        queryDisplay.textContent = `Cible : ${data.currentQuery.email}`;
      }
    }

    if (data.graphStatus === 'loading') {
      setTimeout(() => {
        loadDataAndRender();
      }, 1500);
      return;
    }

    loadingOverlay.style.display = 'none';

    if (!data.graphData || !data.graphData.nodes || data.graphData.nodes.length === 0) {
      const fallbackData = {
        nodes: [
          { id: 'fallback_root', label: data.currentQuery ? (data.currentQuery.type === 'person' ? `${data.currentQuery.prenom} ${data.currentQuery.nom}`.trim() : data.currentQuery.email) : 'Recherche', group: 'person', isRoot: true, title: 'Sujet de recherche principal' },
          { id: 'fallback_company', label: 'Entreprise associée', group: 'company', title: 'Données de secours générées localement' },
          { id: 'fallback_assoc', label: 'Contact associé', group: 'person', title: 'Données de secours générées localement' }
        ],
        edges: [
          { from: 'fallback_root', to: 'fallback_company', label: 'RELATION_DE_SECOURS' },
          { from: 'fallback_company', to: 'fallback_assoc', label: 'ASSOCIÉ' }
        ]
      };
      renderGraph(fallbackData);
      return;
    }

    renderGraph(data.graphData);
  }

  document.getElementById('btnFit').addEventListener('click', () => {
    if (cy) cy.fit();
  });

  document.getElementById('btnExport').addEventListener('click', () => {
    if (cy) {
      const png = cy.png({ scale: 2, full: true, bg: '#0b0f19' });
      const link = document.createElement('a');
      link.download = 'osint-graph-export.png';
      link.href = png;
      link.click();
    }
  });

  loadDataAndRender();
});