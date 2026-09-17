document.addEventListener('DOMContentLoaded', async () => {
  const browserApi = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  const container = document.getElementById('mynetwork');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const queryDisplay = document.getElementById('queryDisplay');
  const nodeDetails = document.getElementById('nodeDetails');
  const statsDisplay = document.getElementById('statsDisplay');
  const btnExpand = document.getElementById('btnExpand');
  const errorBanner = document.getElementById('errorBanner');

  if (!browserApi?.storage?.local) {
    showRuntimeError('L’extension n’est pas accessible dans ce contexte. Ouvre cette vue depuis l’extension Firefox/Chrome.');
    return;
  }

  let cy = null;
  let fcoseRegistered = false;
  let pollTimer = null;

  const DEPTH_COLORS = {
    0: '#ef4444', // N0 Cible principale
    1: '#38bdf8', // N1 Contacts directs
    2: '#a78bfa', // N2 Contacts de contacts
    3: '#f97316', // N3 Niveau 3
    4: '#eab308', // N4 Niveau étendu
  };

  const groupColors = {
    person:  '#38bdf8',
    company: '#10b981'
  };

  const rootColor = '#ef4444';

  function createLayoutOptions({ fit = true, randomize = false, numIter = 250, animate = true, duration = 500 } = {}) {
    return {
      name: 'fcose',
      quality: 'default',
      animate,
      animationDuration: duration,
      randomize,
      fit,
      padding: 40,
      nodeRepulsion: 5000,
      idealEdgeLength: 110,
      edgeElasticity: 0.45,
      nestingFactor: 0.1,
      gravity: 0.25,
      numIter,
      tile: true,
      tilingPaddingVertical: 15,
      tilingPaddingHorizontal: 15
    };
  }

  function showRuntimeError(message) {
    if (loadingOverlay) loadingOverlay.style.display = 'none';
    if (errorBanner) {
      errorBanner.style.display = 'block';
      errorBanner.textContent = '⚠ ' + message;
    }
  }

  function getNodeColor(node) {
    if (node.isRoot) return rootColor;
    if (node.group === 'company') return groupColors.company;
    const d = node.depth ?? 1;
    return DEPTH_COLORS[d] || '#94a3b8';
  }

  function ensureFcose() {
    if (fcoseRegistered) return true;
    if (typeof cytoscape === 'undefined') {
      showRuntimeError('La bibliothèque Cytoscape.js n’est pas chargée.');
      return false;
    }
    if (typeof cytoscapeFcose === 'undefined') {
      showRuntimeError('Le plugin fCoSE n’est pas chargé.');
      return false;
    }
    cytoscapeFcose(cytoscape);
    fcoseRegistered = true;
    return true;
  }

  function formatCyNode(node) {
    return {
      group: 'nodes',
      data: {
        id:    String(node.id),
        label: node.label,
        group: node.group,
        depth: node.depth ?? 0,
        title: node.title || node.label,
        raw:   node,
        color: getNodeColor(node),
        size:  node.isRoot ? 46 : (node.group === 'company' ? 26 : 32),
        shape: node.isRoot ? 'diamond' : (node.group === 'company' ? 'round-rectangle' : 'ellipse')
      }
    };
  }

  function formatCyEdge(edge) {
    const edgeId = `${edge.from}->${edge.to}`;
    return {
      group: 'edges',
      data: {
        id:     edgeId,
        source: String(edge.from),
        target: String(edge.to),
        label:  edge.label || '',
        color:  '#94a3b8'
      }
    };
  }

  // ── Initialisation de Cytoscape au premier chargement ───────────────────────

  function initCytoscape(graphData) {
    if (!ensureFcose()) return;

    const cyNodes = (graphData.nodes || []).map(formatCyNode);
    const validIds = new Set(cyNodes.map(n => n.data.id));
    const cyEdges = (graphData.edges || [])
      .filter(e => validIds.has(String(e.from)) && validIds.has(String(e.to)))
      .map(formatCyEdge);

    if (cy) cy.destroy();

    cy = cytoscape({
      container,
      elements: [...cyNodes, ...cyEdges],
      style: [
        {
          selector: 'node',
          style: {
            'background-color':   'data(color)',
            'label':              'data(label)',
            'text-valign':        'center',
            'text-halign':        'center',
            'font-size':          '11px',
            'font-weight':        '600',
            'color':              '#f8fafc',
            'text-outline-width': 2,
            'text-outline-color': '#0f172a',
            'width':              'data(size)',
            'height':             'data(size)',
            'shape':              'data(shape)',
            'border-width':       2,
            'border-color':       '#0f172a'
          }
        },
        {
          selector: 'node[group="company"]',
          style: {
            'font-size':      '10px',
            'text-wrap':      'wrap',
            'text-max-width': '75px'
          }
        },
        {
          selector: 'edge',
          style: {
            'curve-style':        'bezier',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#94a3b8',
            'line-color':         '#94a3b8',
            'width':              1.5,
            'label':              'data(label)',
            'font-size':          '9px',
            'color':              '#cbd5e1',
            'text-rotation':      'autorotate'
          }
        },
        {
          selector: 'edge.edge-labels-hidden',
          style: { 'label': '' }
        },
        {
          selector: 'edge:selected',
          style: {
            'line-color':         '#38bdf8',
            'target-arrow-color': '#38bdf8',
            'width':              3
          }
        }
      ],
      layout: createLayoutOptions({ fit: true, randomize: false, animate: true }),
      wheelSensitivity: 0.35
    });

    cy.on('tap', 'node', function (event) {
      const raw = event.target.data('raw');
      if (raw) renderSidebarDetails(raw);
    });

    cy.on('tap', 'edge', function (event) {
      const edge = event.target;
      cy.elements().unselect();
      edge.select();
      renderEdgeSidebarDetails(edge);
    });

    cy.on('tap', function (event) {
      if (event.target === cy) {
        nodeDetails.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">Cliquez sur un nœud ou un lien du réseau pour afficher ses informations détaillées.</div>';
      }
    });

    cy.on('dragfree', 'node', function (event) {
      const movedNode = event.target;
      const localGraph = movedNode.closedNeighborhood();
      localGraph.layout({
        ...createLayoutOptions({ fit: false, numIter: 80, animate: true, duration: 300 }),
        padding: 20,
        nodeRepulsion: 3000,
        idealEdgeLength: 90,
        gravity: 0.15,
        tile: false
      }).run();
    });

    cy.fit();
    updateHeaderStats(graphData.nodes || [], graphData.edges || []);
  }

  // ── Mise à jour progressive Nœud par Nœud ───────────────────────────────────

  function applyIncrementalGraphUpdate(graphData) {
    if (!graphData || !graphData.nodes || graphData.nodes.length === 0) return;

    if (!cy) {
      initCytoscape(graphData);
      return;
    }

    const existingNodeIds = new Set(cy.nodes().map(n => n.id()));
    const existingEdgeIds = new Set(cy.edges().map(e => e.id()));

    const newNodes = [];
    for (const n of graphData.nodes) {
      const nid = String(n.id);
      if (!existingNodeIds.has(nid)) {
        newNodes.push(formatCyNode(n));
        existingNodeIds.add(nid);
      }
    }

    const newEdges = [];
    for (const e of (graphData.edges || [])) {
      const eid = `${e.from}->${e.to}`;
      if (!existingEdgeIds.has(eid) && existingNodeIds.has(String(e.from)) && existingNodeIds.has(String(e.to))) {
        newEdges.push(formatCyEdge(e));
        existingEdgeIds.add(eid);
      }
    }

    // Si de nouveaux nœuds ou liens sont apparus, on les insère et on anime
    if (newNodes.length > 0 || newEdges.length > 0) {
      const added = cy.add([...newNodes, ...newEdges]);

      // Positionner initialement chaque nouveau nœud près d'un nœud relié existant
      newNodes.forEach(nData => {
        const cNode = cy.getElementById(nData.data.id);
        if (!cNode || cNode.length === 0) return;

        const neighbors = cNode.neighborhood('node').not(cNode);
        if (neighbors.length > 0) {
          const pPos = neighbors[0].position();
          cNode.position({
            x: pPos.x + (Math.random() - 0.5) * 80,
            y: pPos.y + (Math.random() - 0.5) * 80
          });
        }
      });

      // Relancer un layout fluide et doux sans bousculer la vue
      cy.layout(createLayoutOptions({
        fit: false,
        randomize: false,
        animate: true,
        duration: 450,
        numIter: 90
      })).run();
    }

    updateHeaderStats(graphData.nodes, graphData.edges || []);
  }

  function updateHeaderStats(nodes, edges) {
    if (statsDisplay && nodes) {
      const pCount = nodes.filter(n => n.group === 'person').length;
      const cCount = nodes.filter(n => n.group === 'company').length;
      const eCount = (edges || []).length;
      statsDisplay.textContent = `${pCount} personne${pCount > 1 ? 's' : ''} · ${cCount} société${cCount > 1 ? 's' : ''} · ${eCount} lien${eCount > 1 ? 's' : ''}`;
    }
  }

  function renderSidebarDetails(raw) {
    const depthStr = raw.depth !== undefined ? ` · N${raw.depth}` : '';
    let html = `
      <div class="node-detail-name">${raw.label}</div>
      <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">Type : ${(raw.group || 'unknown').toUpperCase()}${depthStr}</div>
      <div style="font-size: 13px; line-height: 1.4; color: var(--text-main);">
        <strong>Description :</strong><br>${raw.title || 'N/A'}
      </div>
    `;
    nodeDetails.innerHTML = html;
  }

  function renderEdgeSidebarDetails(edge) {
    nodeDetails.innerHTML = `
      <div class="node-detail-name">${edge.data('label') || 'Relation'}</div>
      <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">Lien sélectionné</div>
      <div style="font-size: 13px; line-height: 1.4; color: var(--text-main);">
        <strong>De :</strong> ${edge.source().data('label')}<br>
        <strong>Vers :</strong> ${edge.target().data('label')}
      </div>
    `;
  }

  // ── Synchronisation en temps réel via storage.onChanged ─────────────────────

  if (browserApi.storage?.onChanged) {
    browserApi.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;

      if (changes.graphData?.newValue) {
        applyIncrementalGraphUpdate(changes.graphData.newValue);
      }

      if (changes.graphStatus?.newValue) {
        handleStatusChange(changes.graphStatus.newValue);
      }

      if (changes.graphError?.newValue) {
        showRuntimeError(changes.graphError.newValue);
      }
    });
  }

  function handleStatusChange(status) {
    if (status === 'complete') {
      if (loadingOverlay) loadingOverlay.style.display = 'none';
      if (btnExpand) {
        browserApi.storage.local.get(['maxDepth']).then(st => {
          const maxD = st.maxDepth || 3;
          btnExpand.textContent = `▶ Approfondir (N${maxD} → N${maxD + 1})`;
          btnExpand.style.display = 'block';
          btnExpand.disabled = false;
        });
      }
    } else if (status === 'partial' || status === 'loading') {
      if (loadingOverlay) {
        // Mode discret flottant pour laisser le graphe visible et interactif
        loadingOverlay.classList.add('floating');
      }
    }
  }

  // ── Chargement initial et Polling périodique ────────────────────────────────

  async function pollSync() {
    const data = await browserApi.storage.local.get([
      'currentQuery',
      'graphData',
      'graphStatus',
      'graphError',
      'maxDepth'
    ]);

    if (data.currentQuery) {
      if (data.currentQuery.type === 'person') {
        queryDisplay.textContent = `Cible : ${data.currentQuery.prenom || ''} ${data.currentQuery.nom || ''}`.trim();
      } else {
        queryDisplay.textContent = `Cible : ${data.currentQuery.email || ''}`;
      }
    }

    if (data.graphError) {
      showRuntimeError(data.graphError);
    }

    if (data.graphData?.nodes?.length > 0) {
      applyIncrementalGraphUpdate(data.graphData);
      if (loadingOverlay) {
        loadingOverlay.classList.add('floating');
      }
    }

    if (data.graphStatus) {
      handleStatusChange(data.graphStatus);
    }

    // Polling actif tant que la cartographie tourne
    if (data.graphStatus === 'loading' || data.graphStatus === 'partial') {
      pollTimer = setTimeout(pollSync, 400);
    }
  }

  // ── Boutons de contrôle ───────────────────────────────────────────────────

  document.getElementById('btnReorganize').addEventListener('click', () => {
    if (cy) cy.layout(createLayoutOptions({ fit: true, randomize: true, numIter: 300 })).run();
  });

  document.getElementById('btnFit').addEventListener('click', () => {
    if (cy) cy.fit();
  });

  document.getElementById('btnToggleLabels').addEventListener('click', (event) => {
    if (!cy) return;
    const button = event.currentTarget;
    const labelsVisible = button.getAttribute('aria-pressed') === 'true';
    cy.edges().toggleClass('edge-labels-hidden', labelsVisible);
    button.setAttribute('aria-pressed', String(!labelsVisible));
    button.textContent = `Liens : ${labelsVisible ? 'masqués' : 'visibles'}`;
  });

  function zoomAroundCenter(factor) {
    if (!cy) return;
    cy.zoom({
      level: cy.zoom() * factor,
      renderedPosition: { x: container.clientWidth / 2, y: container.clientHeight / 2 }
    });
  }

  document.getElementById('btnZoomOut').addEventListener('click', () => zoomAroundCenter(0.85));
  document.getElementById('btnZoomIn').addEventListener('click', () => zoomAroundCenter(1.15));

  document.getElementById('btnExport').addEventListener('click', () => {
    if (cy) {
      const png = cy.png({ scale: 2, full: true, bg: '#0b0f19' });
      const link = document.createElement('a');
      link.download = `cartelneural-${Date.now()}.png`;
      link.href = png;
      link.click();
    }
  });

  if (btnExpand) {
    btnExpand.addEventListener('click', () => {
      btnExpand.disabled = true;
      btnExpand.textContent = 'Approfondissement en cours...';
      if (loadingOverlay) {
        loadingOverlay.style.display = 'flex';
        loadingOverlay.classList.add('floating');
      }
      browserApi.runtime.sendMessage({ action: 'expandDepth' });
      setTimeout(pollSync, 300);
    });
  }

  // Démarrage initial
  pollSync();
});