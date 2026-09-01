document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('mynetwork');
  const loadingOverlay = document.getElementById('loadingOverlay');
  const queryDisplay = document.getElementById('queryDisplay');
  const nodeDetails = document.getElementById('nodeDetails');

  let network = null;

  // Color Mapping by Group
  const groupColors = {
    person: { background: '#38bdf8', border: '#0284c7', highlight: { background: '#7dd3fc', border: '#0369a1' } },
    company: { background: '#10b981', border: '#059669', highlight: { background: '#6ee7b7', border: '#047857' } },
    social: { background: '#f59e0b', border: '#d97706', highlight: { background: '#fcd34d', border: '#b45309' } },
    email: { background: '#8b5cf6', border: '#6d28d9', highlight: { background: '#c4b5fd', border: '#5b21b6' } },
    source: { background: '#ec4899', border: '#be185d', highlight: { background: '#fbcfe8', border: '#9d174d' } }
  };

  const rootColor = { background: '#ef4444', border: '#dc2626', highlight: { background: '#fca5a5', border: '#b91c1c' } };

  // Fetch graph data from storage
  async function loadDataAndRender() {
    const data = await browser.storage.local.get(['currentQuery', 'graphData', 'graphStatus']);

    if (data.currentQuery) {
      if (data.currentQuery.type === 'person') {
        queryDisplay.textContent = `Cible : ${data.currentQuery.prenom} ${data.currentQuery.nom}`;
      } else {
        queryDisplay.textContent = `Cible : ${data.currentQuery.email}`;
      }
    }

    if (data.graphStatus === 'loading') {
      setTimeout(loadDataAndRender, 500);
      return;
    }

    loadingOverlay.style.display = 'none';

    if (!data.graphData || !data.graphData.nodes || data.graphData.nodes.length === 0) {
      nodeDetails.innerHTML = '<div style="color: #ef4444;">Aucune donnée trouvée pour cette recherche.</div>';
      return;
    }

    // Format Nodes for Vis-network
    const formattedNodes = data.graphData.nodes.map(node => {
      const colorScheme = node.isRoot ? rootColor : (groupColors[node.group] || groupColors.person);
      return {
        id: node.id,
        label: node.label,
        group: node.group,
        title: node.title || node.label,
        shape: node.isRoot ? 'diamond' : 'dot',
        size: node.isRoot ? 25 : 16,
        color: colorScheme,
        font: { color: '#f8fafc', face: 'system-ui', size: 12, strokeWidth: 2, strokeColor: '#0f172a' },
        rawDetails: node
      };
    });

    // Format Edges
    const formattedEdges = data.graphData.edges.map(edge => ({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      color: { color: '#475569', highlight: '#38bdf8' },
      font: { color: '#94a3b8', size: 9, align: 'middle' },
      arrows: 'to',
      smooth: { type: 'continuous' }
    }));

    const visData = {
      nodes: new vis.DataSet(formattedNodes),
      edges: new vis.DataSet(formattedEdges)
    };

    const options = {
      nodes: {
        borderWidth: 2,
        shadow: true
      },
      edges: {
        width: 1.5,
        shadow: false
      },
      physics: {
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -50,
          centralGravity: 0.01,
          springLength: 100,
          springConstant: 0.08
        },
        stabilization: { iterations: 150 }
      },
      interaction: {
        hover: true,
        tooltipDelay: 200
      }
    };

    network = new vis.Network(container, visData, options);

    // Node click event
    network.on("selectNode", (params) => {
      const nodeId = params.nodes[0];
      const nodeObj = formattedNodes.find(n => n.id === nodeId);
      if (nodeObj) {
        renderSidebarDetails(nodeObj);
      }
    });

    network.on("deselectNode", () => {
      nodeDetails.innerHTML = '<div style="color: var(--text-muted); font-size: 13px;">Cliquez sur un nœud du réseau pour afficher ses informations détaillées.</div>';
    });
  }

  function renderSidebarDetails(node) {
    const raw = node.rawDetails;
    let html = `
      <div class="node-detail-name">${node.label}</div>
      <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">Type: ${node.group.toUpperCase()}</div>
      <div style="font-size: 13px; line-height: 1.4; color: var(--text-main);">
        <strong>Description:</strong><br>${raw.title || 'N/A'}
      </div>
    `;
    nodeDetails.innerHTML = html;
  }

  // Buttons handlers
  document.getElementById('btnFit').addEventListener('click', () => {
    if (network) network.fit({ animation: true });
  });

  document.getElementById('btnExport').addEventListener('click', () => {
    const canvas = container.querySelector('canvas');
    if (canvas) {
      const link = document.createElement('a');
      link.download = 'osint-graph-export.png';
      link.href = canvas.toDataURL();
      link.click();
    }
  });

  loadDataAndRender();
});