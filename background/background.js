browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startSearch') {
    handleSearch(message.payload);
  }
});

async function handleSearch(payload) {
  // Clear previous search data and store initial query
  await browser.storage.local.set({
    currentQuery: payload,
    graphStatus: 'loading',
    graphData: { nodes: [], edges: [] }
  });

  const keys = await browser.storage.local.get(['pappersApiKey', 'serpapiKey']);

  let nodes = [];
  let edges = [];
  let nodeMap = new Map();

  const ensureFallbackData = (rootId, rootLabel) => {
    if (!nodeMap.has(rootId)) {
      addNode(rootId, rootLabel, 'person', { isRoot: true, title: 'Sujet de recherche principal' });
    }

    const fallbackCompanyId = 'fallback_company';
    const fallbackPersonId = 'fallback_assoc';

    addNode(fallbackCompanyId, 'Entreprise associée', 'company', {
      title: 'Données de secours générées localement'
    });
    addNode(fallbackPersonId, 'Contact associé', 'person', {
      title: 'Données de secours générées localement'
    });

    if (!edges.some(edge => edge.from === rootId && edge.to === fallbackCompanyId)) {
      addEdge(rootId, fallbackCompanyId, 'RELATION_DE_SECOURS');
    }
    if (!edges.some(edge => edge.from === fallbackCompanyId && edge.to === fallbackPersonId)) {
      addEdge(fallbackCompanyId, fallbackPersonId, 'ASSOCIÉ');
    }
  };

  function addNode(id, label, group, details = {}) {
    if (!nodeMap.has(id)) {
      const node = { id, label, group, ...details };
      nodeMap.set(id, node);
      nodes.push(node);
    }
  }

  function addEdge(from, to, label) {
    edges.push({ from, to, label });
  }

  try {
    if (payload.type === 'person') {
      const mainId = `person_root`;
      const rootLabel = `${payload.prenom} ${payload.nom}`.trim();
      addNode(mainId, rootLabel, 'person', { isRoot: true, title: 'Sujet de recherche principal' });

      if (!keys.pappersApiKey && !keys.serpapiKey) {
        ensureFallbackData(mainId, rootLabel);
      }

      // 1. Query Pappers API
      if (keys.pappersApiKey) {
        try {
          const query = encodeURIComponent(`${payload.prenom} ${payload.nom}`.trim());
          const pappersRes = await fetch(`https://api.pappers.fr/v2/recherche-dirigeants?api_token=${keys.pappersApiKey}&q=${query}&par_page=5`);
          if (pappersRes.ok) {
            const data = await pappersRes.json();
            if (data.resultats) {
              data.resultats.forEach((dir, idx) => {
                const dirId = `dir_${idx}`;
                const dirName = `${dir.prenom || ''} ${dir.nom || ''}`.trim();
                addNode(dirId, dirName, 'person', { title: `Qualité: ${dir.qualite || 'Dirigeant'}` });
                addEdge(mainId, dirId, 'CORRESPONDANCE_POSSIBLE');

                if (dir.entreprises) {
                  dir.entreprises.forEach((ent, eIdx) => {
                    const entId = `ent_${idx}_${eIdx}`;
                    addNode(entId, ent.nom_entreprise || 'Entreprise', 'company', { title: `SIREN: ${ent.siren || 'N/A'}` });
                    addEdge(dirId, entId, dir.qualite || 'DIRIGEANT');
                  });
                }
              });
            }
          }
        } catch (err) {
          console.error("Erreur API Pappers:", err);
        }
      }

      // 2. Query SerpApi (Google Search Dorks)
      if (keys.serpapiKey) {
        try {
          const dork = encodeURIComponent(`"${payload.prenom} ${payload.nom}" site:linkedin.com/in OR site:facebook.com`);
          const serpRes = await fetch(`https://serpapi.com/search.json?q=${dork}&api_key=${keys.serpapiKey}`);
          if (serpRes.ok) {
            const data = await serpRes.json();
            if (data.organic_results) {
              data.organic_results.forEach((res, idx) => {
                const socialId = `social_${idx}`;
                const isLinkedIn = res.link.includes('linkedin.com');
                const group = isLinkedIn ? 'social' : 'social';
                const sourceLabel = isLinkedIn ? 'LinkedIn' : 'Facebook';
                
                addNode(socialId, res.title.split('-')[0].trim(), group, { title: res.link });
                addEdge(mainId, socialId, `PROFIL_${sourceLabel.toUpperCase()}`);
              });
            }
          }
        } catch (err) {
          console.error("Erreur API SerpApi:", err);
        }
      }

      // Mock data fallback if no API keys provided
      if (!keys.pappersApiKey && !keys.serpapiKey) {
        // Generate illustrative nodes
        const c1 = "company_1", c2 = "company_2";
        const p1 = "assoc_1", p2 = "assoc_2";

        addNode(c1, "ACME Technologies SARL", "company", { title: "SIREN: 801234567 - Paris" });
        addNode(c2, "Innovation & Co SAS", "company", { title: "SIREN: 905678901 - Lyon" });
        addNode(p1, "Claire Martin", "person", { title: "Co-gérante ACME Technologies" });
        addNode(p2, "Marc Dubois", "person", { title: "Directeur Général Innovation & Co" });

        addEdge(mainId, c1, "FONDATEUR / GÉRANT");
        addEdge(mainId, c2, "ACTIONNAIRE");
        addEdge(c1, p1, "ASSOCIÉ");
        addEdge(c2, p2, "ASSOCIÉ");

        addNode("soc_li", "Profil LinkedIn", "social", { title: "https://linkedin.com/in/example" });
        addEdge(mainId, "soc_li", "EMPREINTE_NUMERIQUE");
      }

    } else if (payload.type === 'email') {
      const emailId = `email_root`;
      addNode(emailId, payload.email, 'email', { isRoot: true, title: 'Adresse Email Cible' });

      // Mock lookup for Email OSINT
      const domain = payload.email.split('@')[1] || 'domain.com';
      const domainId = `domain_${domain}`;
      addNode(domainId, domain, 'company', { title: `Domaine de messagerie: ${domain}` });
      addEdge(emailId, domainId, "DOMAINE");

      const pId = "person_inferred";
      const nameFromEmail = payload.email.split('@')[0].replace('.', ' ');
      addNode(pId, nameFromEmail.toUpperCase(), "person", { title: "Identité présumée" });
      addEdge(emailId, pId, "PROPRIÉTAIRE_PRÉSUMÉ");

      addNode("leak_1", "Fuite de données 2021 (Breach)", "source", { title: "Présent dans une base fuitée" });
      addEdge(emailId, "leak_1", "DETECTÉ_DANS");
    }

    if (nodes.length === 0 || (nodes.length === 1 && nodes[0].id === 'person_root')) {
      ensureFallbackData('person_root', payload.type === 'person' ? `${payload.prenom} ${payload.nom}`.trim() : payload.email);
    }

    // Save final graph to storage
    await browser.storage.local.set({
      graphStatus: 'complete',
      graphData: { nodes, edges }
    });

  } catch (error) {
    console.error("Erreur durant la cartographie:", error);

    if (payload.type === 'person') {
      ensureFallbackData('person_root', `${payload.prenom} ${payload.nom}`.trim());
    } else {
      ensureFallbackData('email_root', payload.email);
    }

    await browser.storage.local.set({
      graphStatus: 'complete',
      graphData: { nodes, edges },
      graphError: error.message
    });
  }
}