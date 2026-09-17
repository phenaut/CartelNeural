const browserApi = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);

if (browserApi && browserApi.runtime) {
  browserApi.runtime.onMessage.addListener((message) => {
    if (message.action === 'startSearch') {
      handleSearch(message.payload);
    }
    if (message.action === 'expandDepth') {
      handleExpand();
    }
  });
}

// ── Utilitaires ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanString(str = '') {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePersonKey(prenom = '', nom = '') {
  const p = cleanString(prenom).split(' ')[0] || '';
  const n = cleanString(nom);
  return `${p}_${n}`.trim();
}

function normalizeCompanyKey(siren, nom = '') {
  const cleanSiren = (siren || '').toString().replace(/\s+/g, '');
  if (cleanSiren && cleanSiren.length >= 8) return `siren_${cleanSiren}`;
  const n = cleanString(nom).replace(/[^a-z0-9]/g, '');
  return `co_${n || 'inconnue'}`;
}

// ── Variables d'état du graphe ───────────────────────────────────────────────

let nodes = [];
let edges = [];
let nodeMap = new Map();
let entityMap = {};
let processedPersonKeys = new Set();
let currentFrontier = [];
let currentDepth = 0;

function addNode(id, label, group, details = {}) {
  if (!nodeMap.has(id)) {
    const node = { id, label, group, ...details };
    nodeMap.set(id, node);
    nodes.push(node);
    return node;
  }
  return nodeMap.get(id);
}

function addEdge(from, to, label) {
  if (!from || !to || from === to) return;
  const edgeKey = `${from}=>${to}:${label || ''}`;
  if (!edges.some(e => `${e.from}=>${e.to}:${e.label || ''}` === edgeKey)) {
    edges.push({ from, to, label: label || '' });
  }
}

// ── Démarrage de la recherche ────────────────────────────────────────────────

async function handleSearch(payload) {
  if (!browserApi?.storage?.local) return;

  nodes = [];
  edges = [];
  nodeMap = new Map();
  entityMap = {};
  processedPersonKeys = new Set();
  currentFrontier = [];
  currentDepth = 0;

  let {
    nom = '',
    prenom = '',
    email = '',
    type = 'person',
    maxDepth = 3,
    pappersApiKey = '',
    serpapiKey = ''
  } = payload;

  // Sauvegarder les clés reçues
  const keysToSave = {};
  if (pappersApiKey) keysToSave.pappersApiKey = pappersApiKey;
  if (serpapiKey)    keysToSave.serpapiKey    = serpapiKey;
  if (Object.keys(keysToSave).length > 0) {
    await browserApi.storage.local.set(keysToSave);
  }

  // Lecture de toutes les clés enregistrées
  const savedKeys = await browserApi.storage.local.get(['pappersApiKey', 'serpapiKey']);
  const activePappersKey = pappersApiKey || savedKeys.pappersApiKey || '';
  const activeSerpapiKey = serpapiKey    || savedKeys.serpapiKey    || '';

  if (type === 'email' && email) {
    const parts = (email.split('@')[0] || '').split(/[._-]/);
    prenom = parts[0] || '';
    nom = parts.slice(1).join(' ') || prenom;
  }

  const rootLabel = `${prenom} ${nom}`.trim() || nom.trim() || 'Cible';
  const rootKey   = normalizePersonKey(prenom, nom);
  const rootId    = 'person_root';

  entityMap[rootKey] = rootId;
  processedPersonKeys.add(rootKey);

  addNode(rootId, rootLabel, 'person', {
    isRoot: true,
    depth: 0,
    title: 'Sujet de recherche principal (N0)'
  });

  await browserApi.storage.local.set({
    currentQuery: payload,
    graphStatus:  'loading',
    graphData:    { nodes: [...nodes], edges: [...edges] },
    graphError:   null,
    maxDepth:     parseInt(maxDepth, 10) || 3
  });

  if (!activePappersKey && !activeSerpapiKey) {
    await browserApi.storage.local.set({
      graphStatus: 'error',
      graphError:  'Aucune clé API configurée. Veuillez renseigner au moins une clé (Pappers ou SerpApi) dans le menu popup.'
    });
    return;
  }

  // ── Lancement des itérations N0 → N1 → N2 → N3 ────────────────────────────
  let frontier = [{ id: rootId, label: rootLabel, depth: 0 }];
  const targetDepth = parseInt(maxDepth, 10) || 3;

  for (let level = 1; level <= targetDepth; level++) {
    currentDepth = level;
    const nextFrontier = [];

    for (const person of frontier) {
      const discovered = await searchPersonOSINT(
        person.id,
        person.label,
        person.depth,
        activePappersKey,
        activeSerpapiKey
      );
      nextFrontier.push(...discovered);
      await sleep(250);
    }

    // Sauvegarde de l'itération terminée
    await browserApi.storage.local.set({
      graphStatus:  level < targetDepth ? 'partial' : 'complete',
      graphData:    { nodes: [...nodes], edges: [...edges] },
      currentDepth: level
    });

    frontier = nextFrontier;
    if (frontier.length === 0) {
      break;
    }
  }

  currentFrontier = frontier;

  await browserApi.storage.local.set({
    graphStatus: 'complete',
    graphData:   { nodes: [...nodes], edges: [...edges] }
  });
}

// ── Bouton Approfondir (+1 itération) ────────────────────────────────────────

async function handleExpand() {
  if (!browserApi?.storage?.local) return;

  const savedKeys = await browserApi.storage.local.get(['pappersApiKey', 'serpapiKey', 'maxDepth']);
  const activePappersKey = savedKeys.pappersApiKey || '';
  const activeSerpapiKey = savedKeys.serpapiKey    || '';

  if (!activePappersKey && !activeSerpapiKey) return;
  if (currentFrontier.length === 0) return;

  const newLevel = (parseInt(savedKeys.maxDepth, 10) || 3) + 1;

  await browserApi.storage.local.set({
    graphStatus: 'loading',
    maxDepth:    newLevel
  });

  const nextFrontier = [];
  for (const person of currentFrontier) {
    const discovered = await searchPersonOSINT(
      person.id,
      person.label,
      person.depth,
      activePappersKey,
      activeSerpapiKey
    );
    nextFrontier.push(...discovered);
    await sleep(250);
  }

  currentFrontier = nextFrontier;

  await browserApi.storage.local.set({
    graphStatus: 'complete',
    graphData:   { nodes: [...nodes], edges: [...edges] }
  });
}

// ── Moteur d'exploration OSINT (Pappers + SerpApi Facebook/LinkedIn) ─────────

async function searchPersonOSINT(personId, personLabel, depth, pappersKey, serpapiKey) {
  const newPersonsFound = [];

  // ── 1. Scan SerpApi (Facebook & LinkedIn) ──────────────────────────────────
  if (serpapiKey) {
    try {
      const dork = encodeURIComponent(`"${personLabel}" site:linkedin.com/in OR site:facebook.com`);
      const serpRes = await fetch(`https://serpapi.com/search.json?q=${dork}&api_key=${serpapiKey}`);

      if (serpRes.ok) {
        const serpData = await serpRes.json();
        const results = serpData.organic_results || [];

        results.forEach((res, idx) => {
          const isLinkedIn  = (res.link || '').includes('linkedin.com');
          const isFacebook  = (res.link || '').includes('facebook.com');
          const sourceLabel = isLinkedIn ? 'LinkedIn' : (isFacebook ? 'Facebook' : 'Web');

          let profileName = (res.title || '').split(/[-|–]/)[0].trim();
          if (!profileName) profileName = res.title || 'Profil';

          const pKey = normalizePersonKey('', profileName);
          let targetId = entityMap[pKey];

          if (!targetId) {
            targetId = `soc_${sourceLabel.toLowerCase()}_${idx}_d${depth + 1}`;
            entityMap[pKey] = targetId;

            addNode(targetId, profileName, 'person', {
              depth: depth + 1,
              title: `Profil ${sourceLabel} : ${res.link}\n${res.snippet || ''}`
            });

            if (!processedPersonKeys.has(pKey)) {
              processedPersonKeys.add(pKey);
              newPersonsFound.push({
                id: targetId,
                label: profileName,
                depth: depth + 1
              });
            }
          }

          if (personId !== targetId) {
            addEdge(personId, targetId, `PROFIL_${sourceLabel.toUpperCase()}`);
          }

          // Détection d'une société mentionnée dans la bio / snippet
          const snippetText = `${res.title || ''} ${res.snippet || ''}`;
          const companyMatch = snippetText.match(/(?:chez|at|de la société|au sein de)\s+([A-Z0-9À-ÖØ-ß][A-Za-z0-9À-ÖØ-ß\s&]{2,25})/i);
          if (companyMatch && companyMatch[1]) {
            const compName = companyMatch[1].trim();
            const cKey = `co_${cleanString(compName).replace(/[^a-z0-9]/g, '')}`;
            let compId = entityMap[cKey];

            if (!compId) {
              compId = `comp_soc_${cKey}`;
              entityMap[cKey] = compId;
              addNode(compId, compName, 'company', {
                title: `Société détectée via ${sourceLabel} (${profileName})`
              });
            }

            addEdge(targetId, compId, 'POSTE / SOCIÉTÉ');
          }
        });
      }
    } catch (err) {
      console.error(`[CartelNeural] Erreur SerpApi pour "${personLabel}":`, err);
    }
  }

  // ── 2. Scan Pappers (Dirigeants et Sociétés légales) ────────────────────────
  if (pappersKey) {
    try {
      const query = encodeURIComponent(personLabel);
      const pappersRes = await fetch(
        `https://api.pappers.fr/v2/recherche-dirigeants?api_token=${pappersKey}&q=${query}&par_page=5`
      );

      if (pappersRes.ok) {
        const data = await pappersRes.json();
        const resultats = data.resultats || [];

        resultats.forEach((dir, idx) => {
          const dirPrenom = dir.prenom || '';
          const dirNom    = dir.nom    || '';
          const dirName   = `${dirPrenom} ${dirNom}`.trim();
          if (!dirName) return;

          const pKey = normalizePersonKey(dirPrenom, dirNom);
          let targetPersonId = entityMap[pKey];

          if (!targetPersonId) {
            targetPersonId = `dir_${pKey || idx}_d${depth + 1}`;
            entityMap[pKey] = targetPersonId;

            addNode(targetPersonId, dirName, 'person', {
              depth: depth + 1,
              title: `Qualité: ${dir.qualite || 'Dirigeant'}`
            });

            if (!processedPersonKeys.has(pKey)) {
              processedPersonKeys.add(pKey);
              newPersonsFound.push({
                id: targetPersonId,
                label: dirName,
                depth: depth + 1
              });
            }
          }

          if (personId !== targetPersonId) {
            addEdge(personId, targetPersonId, dir.qualite || 'CORRESPONDANCE_POSSIBLE');
          }

          if (dir.entreprises) {
            dir.entreprises.forEach((ent, eIdx) => {
              const rawSiren = ent.siren || '';
              const siren    = rawSiren.toString().replace(/\s+/g, '');
              const entName  = ent.nom_entreprise || ent.denomination || 'Entreprise';
              const cKey     = normalizeCompanyKey(siren, entName);

              let targetCompanyId = entityMap[cKey];
              if (!targetCompanyId) {
                targetCompanyId = `ent_${cKey || eIdx}`;
                entityMap[cKey] = targetCompanyId;
                addNode(targetCompanyId, entName, 'company', {
                  title: `SIREN: ${siren || 'N/A'}`
                });
              }

              addEdge(targetPersonId, targetCompanyId, dir.qualite || ent.qualite || 'DIRIGEANT');
            });
          }
        });
      }
    } catch (err) {
      console.error(`[CartelNeural] Erreur Pappers pour "${personLabel}":`, err);
    }
  }

  return newPersonsFound;
}