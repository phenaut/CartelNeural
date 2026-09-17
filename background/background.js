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

function slugFromUrl(url = '') {
  return url
    .replace(/^https?:\/\/(?:www\.)?/i, '')
    .replace(/[^a-z0-9]/gi, '_')
    .slice(0, 60);
}

// ── Variables d'état du graphe ───────────────────────────────────────────────

let nodes = [];
let edges = [];
let nodeMap = new Map();
let entityMap = {};
let processedPersonKeys = new Set();
let processedCompanies = new Set();
let currentFrontier = []; // Nœuds personnes N3 pour "Approfondir"
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

async function notifyUpdate(status = 'partial') {
  if (!browserApi?.storage?.local) return;
  await browserApi.storage.local.set({
    graphStatus:  status,
    graphData:    { nodes: [...nodes], edges: [...edges] },
    currentDepth: currentDepth
  });
}

// ── Extraction et validation OSINT ───────────────────────────────────────────

/** Vérifie si l'URL est un profil personnel individuel et non une page média, vidéo, groupe ou page de recherche */
function isGenuineProfileUrl(link = '') {
  if (!link) return false;
  const l = link.toLowerCase();

  // Pages de recherche d'homonymes et annuaires Facebook
  if (l.includes('/search') || l.includes('/public/') || l.includes('/directory/') || l.includes('/find-friends/')) {
    return false;
  }

  const bannedKeywords = [
    '/watch', '/videos', '/video', '/posts', '/post', '/photos', '/photo',
    '/groups', '/group', '/events', '/event', '/permalink', '/story',
    '/stories', '/reels', '/reel', '/share', '/gaming', '/news', '/live',
    '/hashtag', '/marketplace'
  ];

  if (bannedKeywords.some(kw => l.includes(kw))) {
    return false;
  }

  // Sur LinkedIn, s'assurer qu'il s'agit bien d'un profil individuel (/in/)
  if (l.includes('linkedin.com') && !l.includes('/in/')) {
    return false;
  }

  return true;
}

/** Nettoie et valide qu'un titre correspond à un nom de personne physique */
function parseAndValidatePersonName(title = '') {
  if (!title) return null;

  let clean = title
    .replace(/\s*\|\s*(Facebook|LinkedIn|Meta).*$/i, '')
    .replace(/\s*-\s*(Facebook|LinkedIn|Meta).*$/i, '')
    .trim();

  const parts = clean.split(/\s*[-–—|]\s*/);
  const candidate = parts[0].trim();

  const noiseRegex = /\b(watch|vidéo|video|direct|live|actualité|actualités|news|replay|épisode|journal|publication|regardez|reportage|media|info|infos|cours|formation|recrutement|recherche)\b/i;
  if (noiseRegex.test(candidate)) {
    return null;
  }

  const words = candidate.split(/\s+/);
  if (words.length < 2 || words.length > 5) {
    return null;
  }

  if (candidate.length < 4 || candidate.length > 45) {
    return null;
  }

  return candidate;
}

/** Extrait les noms de sociétés depuis un titre ou snippet textuel (ex: LinkedIn) */
function extractCompaniesFromText(text = '') {
  if (!text) return [];
  const companies = new Set();

  const patterns = [
    /(?:chez|at|au sein de|de la société)\s+([A-Z0-9À-ÖØ-ß][A-Za-z0-9À-ÖØ-ß\s&'. -]{2,30}?)(?=[,.;\n|–—-]|\s+chez|\s+at|\s+depuis|\s+en|\s+pour|\s*$)/gi,
    /(?:Poste actuel|Expérience|Anciennement chez|Auparavant chez)\s*:\s*([A-Z0-9À-ÖØ-ß][A-Za-z0-9À-ÖØ-ß\s&'. -]{2,30}?)(?=[,.;\n|–—-]|\s*$)/gi,
    /[-–—|]\s*([A-Z0-9À-ÖØ-ß][A-Za-z0-9À-ÖØ-ß\s&'. -]{2,25})\s*\|\s*LinkedIn/gi
  ];

  for (const pat of patterns) {
    let match;
    while ((match = pat.exec(text)) !== null) {
      let name = (match[1] || '').trim();
      name = name.replace(/^[-–—@:\s]+|[-–—@:\s]+$/g, '').trim();
      const lower = name.toLowerCase();
      const noise = ['linkedin', 'facebook', 'paris', 'france', 'stage', 'freelance', 'cdi', 'cdd', 'alternance', 'temps plein', 'recherche'];
      if (name.length >= 3 && name.length <= 40 && !noise.includes(lower)) {
        companies.add(name);
      }
    }
  }

  return Array.from(companies);
}

/** Tente de retrouver le SIREN officiel d'une société mentionnée sur LinkedIn via Pappers */
async function resolveCompanySiren(companyName, pappersKey) {
  if (!pappersKey || !companyName) return null;
  try {
    const q = encodeURIComponent(companyName);
    const res = await fetch(`https://api.pappers.fr/v2/recherche?api_token=${pappersKey}&q=${q}&par_page=1`);
    if (res.ok) {
      const data = await res.json();
      const first = (data.resultats || [])[0];
      if (first && first.siren) {
        return {
          siren: (first.siren || '').toString().replace(/\s+/g, ''),
          officialName: first.nom_entreprise || first.denomination || companyName,
          statut: first.statut_rcs || ''
        };
      }
    }
  } catch (e) {
    // Échec silencieux
  }
  return null;
}

// ── Démarrage de la recherche (Architecture 4 Niveaux) ─────────────────────────

async function handleSearch(payload) {
  if (!browserApi?.storage?.local) return;

  nodes = [];
  edges = [];
  nodeMap = new Map();
  entityMap = {};
  processedPersonKeys = new Set();
  processedCompanies = new Set();
  currentFrontier = [];
  currentDepth = 0;

  let {
    nom = '',
    prenom = '',
    email = '',
    type = 'person',
    pappersApiKey = '',
    serpapiKey = ''
  } = payload;

  const keysToSave = {};
  if (pappersApiKey) keysToSave.pappersApiKey = pappersApiKey;
  if (serpapiKey)    keysToSave.serpapiKey    = serpapiKey;
  if (Object.keys(keysToSave).length > 0) {
    await browserApi.storage.local.set(keysToSave);
  }

  const savedKeys = await browserApi.storage.local.get(['pappersApiKey', 'serpapiKey']);
  const activePappersKey = pappersApiKey || savedKeys.pappersApiKey || '';
  const activeSerpapiKey = serpapiKey    || savedKeys.serpapiKey    || '';

  if (type === 'email' && email) {
    const parts = (email.split('@')[0] || '').split(/[._-]/);
    prenom = parts[0] || '';
    nom = parts.slice(1).join(' ') || prenom;
  }

  const rootLabel = `${prenom} ${nom}`.trim() || nom.trim() || 'Cible';
  const rootId = 'person_root';

  addNode(rootId, rootLabel, 'person', {
    isRoot: true,
    depth: 0,
    title: `Recherche initiale (N0) : ${rootLabel}`
  });

  // Affichage immédiat du nœud N0 sur le graphe
  await browserApi.storage.local.set({
    currentQuery: payload,
    graphStatus:  'partial',
    graphData:    { nodes: [...nodes], edges: [...edges] },
    graphError:   null,
    maxDepth:     3
  });

  if (!activePappersKey && !activeSerpapiKey) {
    await browserApi.storage.local.set({
      graphStatus: 'error',
      graphError:  'Aucune clé API configurée. Veuillez renseigner au moins une clé (Pappers ou SerpApi) dans le menu popup.'
    });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 1 : N0 → N1 (HOMONYMES & PROFILS IDENTIFIÉS)
  // ══════════════════════════════════════════════════════════════════════════
  currentDepth = 1;
  const n1Candidates = [];

  // 1.1 Recherche Pappers des dirigeants homonymes
  if (activePappersKey) {
    try {
      const q = encodeURIComponent(rootLabel);
      const res = await fetch(`https://api.pappers.fr/v2/recherche-dirigeants?api_token=${activePappersKey}&q=${q}&par_page=20`);
      if (res.ok) {
        const data = await res.json();
        const resultats = data.resultats || [];

        for (let idx = 0; idx < resultats.length; idx++) {
          const dir = resultats[idx];
          const dirPrenom = dir.prenom || '';
          const dirNom = dir.nom || '';
          const dirName = `${dirPrenom} ${dirNom}`.trim();
          if (!dirName) continue;

          // Clé unique pour chaque dirigeant homonyme distinct
          const birthYear = (dir.date_de_naissance || '').slice(0, 4);
          const dirUniqueKey = `pappers_dir_${cleanString(dirNom)}_${cleanString(dirPrenom)}_${birthYear || idx}`;
          const n1Id = `n1_${dirUniqueKey}`;

          const displaySuffix = birthYear ? ` (né en ${birthYear})` : (dir.qualite ? ` (${dir.qualite})` : ' (Pappers)');
          const n1Label = `${dirName}${displaySuffix}`;

          const dirInfo = [
            `Dirigeant Pappers (N1)`,
            `Nom complet : ${dirName}`,
            `Date de naissance : ${dir.date_de_naissance_formate || dir.date_de_naissance || 'Non renseignée'}`,
            `Nationalité : ${dir.nationalite || 'N/A'}`,
            `Qualité : ${dir.qualite || 'Dirigeant'}`,
            `Sociétés rattachées : ${(dir.entreprises || []).length}`
          ].join('\n');

          addNode(n1Id, n1Label, 'person', {
            depth: 1,
            title: dirInfo,
            source: 'pappers',
            rawDir: dir
          });

          addEdge(rootId, n1Id, 'HOMONYME / PAPPERS');

          n1Candidates.push({
            id: n1Id,
            label: dirName,
            type: 'pappers',
            rawDir: dir,
            depth: 1
          });

          await notifyUpdate('partial');
          await sleep(50);
        }
      }
    } catch (err) {
      console.error('[CartelNeural] Erreur Pappers N1:', err);
    }
  }

  // 1.2 Recherche SerpApi (LinkedIn & Facebook)
  if (activeSerpapiKey) {
    try {
      const dork = encodeURIComponent(
        `"${rootLabel}" (site:linkedin.com/in OR (site:facebook.com -inurl:watch -inurl:posts -inurl:videos -inurl:groups -inurl:events -inurl:photo -inurl:story -inurl:reel))`
      );
      const serpRes = await fetch(`https://serpapi.com/search.json?q=${dork}&api_key=${activeSerpapiKey}`);
      if (serpRes.ok) {
        const serpData = await serpRes.json();
        const results = serpData.organic_results || [];

        for (let idx = 0; idx < results.length; idx++) {
          const res = results[idx];
          const rawLink = res.link || '';

          if (!isGenuineProfileUrl(rawLink)) continue;

          const profileName = parseAndValidatePersonName(res.title);
          if (!profileName) continue;

          const isLinkedIn = rawLink.includes('linkedin.com');
          const isFacebook = rawLink.includes('facebook.com');
          const platform = isLinkedIn ? 'linkedin' : (isFacebook ? 'facebook' : 'web');
          const platformLabel = isLinkedIn ? 'LinkedIn' : (isFacebook ? 'Facebook' : 'Web');

          const slug = slugFromUrl(rawLink);
          const n1Id = `n1_${platform}_${slug || idx}`;

          // Extraction d'un extrait de poste pour le label
          let roleSnippet = '';
          if (isLinkedIn && res.title) {
            const titleParts = res.title.split(/[-–—|]/);
            if (titleParts.length > 1) {
              const part1 = titleParts[1].trim();
              if (part1 && !part1.toLowerCase().includes('linkedin')) {
                roleSnippet = ` • ${part1.slice(0, 24)}`;
              }
            }
          }

          const n1Label = `${profileName}${roleSnippet || ` (${platformLabel})`}`;

          const tooltip = [
            `Profil ${platformLabel} (N1)`,
            `Nom : ${profileName}`,
            `URL : ${rawLink}`,
            res.snippet ? `Description : ${res.snippet}` : ''
          ].filter(Boolean).join('\n');

          addNode(n1Id, n1Label, 'person', {
            depth: 1,
            title: tooltip,
            source: platform,
            url: rawLink,
            titleText: res.title,
            snippet: res.snippet
          });

          addEdge(rootId, n1Id, `PROFIL_${platformLabel.toUpperCase()}`);

          n1Candidates.push({
            id: n1Id,
            label: profileName,
            type: 'social',
            source: platform,
            rawLink,
            titleText: res.title,
            snippet: res.snippet,
            depth: 1
          });

          await notifyUpdate('partial');
          await sleep(50);
        }
      }
    } catch (err) {
      console.error('[CartelNeural] Erreur SerpApi N1:', err);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 2 : N1 → N2 (SOCIÉTÉS PASSÉES ET PRÉSENTES)
  // ══════════════════════════════════════════════════════════════════════════
  currentDepth = 2;
  const n2Companies = [];

  for (const candidate of n1Candidates) {
    // 2.1 Mandats Pappers
    if (candidate.type === 'pappers' && candidate.rawDir?.entreprises) {
      for (const ent of candidate.rawDir.entreprises) {
        const rawSiren = ent.siren || '';
        const siren = rawSiren.toString().replace(/\s+/g, '');
        const entName = ent.nom_entreprise || ent.denomination || 'Entreprise';
        const cKey = normalizeCompanyKey(siren, entName);

        const isPast = (ent.statut_rcs && ent.statut_rcs.toLowerCase().includes('radi')) || !!ent.date_cessation;
        const statusLabel = isPast ? 'Mandat passé (radiée/cessation)' : 'Mandat actif (actuel)';
        const edgeLabel = isPast ? 'ANCIEN MANDAT' : (ent.qualite || candidate.rawDir.qualite || 'MANDAT ACTIF');

        let targetCompanyId = entityMap[cKey];
        if (!targetCompanyId) {
          targetCompanyId = `ent_${cKey}`;
          entityMap[cKey] = targetCompanyId;

          addNode(targetCompanyId, entName, 'company', {
            depth: 2,
            siren: siren || null,
            isPast,
            title: `Société (N2) : ${entName}\nSIREN : ${siren || 'N/A'}\nStatut : ${statusLabel}\nRôle : ${ent.qualite || candidate.rawDir.qualite || 'Dirigeant'}`
          });

          n2Companies.push({
            id: targetCompanyId,
            siren,
            name: entName,
            depth: 2
          });

          await notifyUpdate('partial');
          await sleep(50);
        }

        addEdge(candidate.id, targetCompanyId, edgeLabel);
      }
    }

    // 2.2 Entreprises extraites de LinkedIn / Facebook
    if (candidate.type === 'social') {
      const fullText = `${candidate.titleText || ''} ${candidate.snippet || ''}`;
      const extracted = extractCompaniesFromText(fullText);

      for (const rawCompName of extracted) {
        let siren = null;
        let officialName = rawCompName;
        let isPast = false;

        // Si clé Pappers disponible, tentative de résolution du SIREN
        if (activePappersKey) {
          const resolved = await resolveCompanySiren(rawCompName, activePappersKey);
          if (resolved) {
            siren = resolved.siren;
            officialName = resolved.officialName;
            if (resolved.statut?.toLowerCase().includes('radi')) isPast = true;
          }
        }

        const cKey = normalizeCompanyKey(siren, officialName);
        let targetCompanyId = entityMap[cKey];

        if (!targetCompanyId) {
          targetCompanyId = `ent_${cKey}`;
          entityMap[cKey] = targetCompanyId;

          addNode(targetCompanyId, officialName, 'company', {
            depth: 2,
            siren: siren || null,
            isPast,
            title: `Société (N2) : ${officialName}\nSource : Détectée via ${candidate.source}\nSIREN : ${siren || 'Non renseigné'}`
          });

          n2Companies.push({
            id: targetCompanyId,
            siren,
            name: officialName,
            depth: 2
          });

          await notifyUpdate('partial');
          await sleep(50);
        }

        addEdge(candidate.id, targetCompanyId, 'POSTE / EXPÉRIENCE');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ÉTAPE 3 : N2 → N3 (ASSOCIÉS & CO-DIRIGEANTS DANS LES SOCIÉTÉS N2)
  // ══════════════════════════════════════════════════════════════════════════
  currentDepth = 3;
  const n3Persons = [];

  if (activePappersKey) {
    for (const comp of n2Companies) {
      if (!comp.siren || processedCompanies.has(comp.siren)) continue;
      processedCompanies.add(comp.siren);

      await sleep(150);

      try {
        const entUrl = `https://api.pappers.fr/v2/entreprise/dirigeants?siren=${comp.siren}&api_token=${activePappersKey}`;
        let entRes = await fetch(entUrl);
        let rawList = [];

        if (entRes.ok) {
          const entData = await entRes.json();
          rawList = Array.isArray(entData)
            ? entData
            : (entData.dirigeants || entData.representants || entData.resultats || []);
        } else {
          const fbUrl = `https://api.pappers.fr/v2/entreprise?siren=${comp.siren}&api_token=${activePappersKey}`;
          const fbRes = await fetch(fbUrl);
          if (fbRes.ok) {
            const fbData = await fbRes.json();
            rawList = fbData.representants || fbData.dirigeants || [];
            if (Array.isArray(fbData.beneficiaires_effectifs)) {
              rawList = rawList.concat(fbData.beneficiaires_effectifs);
            }
          }
        }

        for (const rep of rawList) {
          if (rep.personne_morale === true) continue;

          const repPrenom = rep.prenom || rep.prenom_usuel || rep.prenoms || '';
          const repNom = rep.nom || rep.nom_usage || '';
          const repComplet = rep.nom_complet || `${repPrenom} ${repNom}`.trim();
          if (!repPrenom && !repNom && !repComplet) continue;

          const repLabel = repComplet || `${repPrenom} ${repNom}`.trim();
          const repKey = normalizePersonKey(repPrenom, repNom || repLabel);

          // Ne pas relier si c'est la cible N0
          const rootKey = normalizePersonKey(prenom, nom);
          if (repKey === rootKey) continue;

          let coDirId = entityMap[repKey];
          if (!coDirId) {
            coDirId = `n3_codir_${repKey}`;
            entityMap[repKey] = coDirId;

            addNode(coDirId, repLabel, 'person', {
              depth: 3,
              title: `Associé / Co-dirigeant (N3) : ${repLabel}\nQualité : ${rep.qualite || 'Dirigeant'}\nSociété : ${comp.name}`
            });

            n3Persons.push({
              id: coDirId,
              label: repLabel,
              depth: 3
            });

            await notifyUpdate('partial');
            await sleep(40);
          }

          addEdge(comp.id, coDirId, rep.qualite || 'DIRIGEANT / ASSOCIÉ');
        }
      } catch (err) {
        console.warn(`[CartelNeural] Erreur récupération dirigeants SIREN ${comp.siren}:`, err);
      }
    }
  }

  currentFrontier = n3Persons;

  await browserApi.storage.local.set({
    graphStatus: 'complete',
    graphData:   { nodes: [...nodes], edges: [...edges] }
  });
}

// ── Bouton Approfondir (+1 itération alternée N3 -> N4 -> N5) ────────────────

async function handleExpand() {
  if (!browserApi?.storage?.local) return;

  const savedKeys = await browserApi.storage.local.get(['pappersApiKey', 'serpapiKey', 'maxDepth']);
  const activePappersKey = savedKeys.pappersApiKey || '';
  if (!activePappersKey) return;
  if (currentFrontier.length === 0) return;

  const currentLevel = parseInt(savedKeys.maxDepth, 10) || 3;
  const newLevel = currentLevel + 1;

  await browserApi.storage.local.set({
    graphStatus: 'loading',
    maxDepth:    newLevel
  });

  const nextCompanies = [];
  const nextPersons = [];

  // N4 : Trouver les autres sociétés des personnes de la frontière N3
  for (const person of currentFrontier) {
    try {
      const q = encodeURIComponent(person.label);
      const res = await fetch(`https://api.pappers.fr/v2/recherche-dirigeants?api_token=${activePappersKey}&q=${q}&par_page=5`);
      if (res.ok) {
        const data = await res.json();
        for (const dir of data.resultats || []) {
          for (const ent of dir.entreprises || []) {
            const rawSiren = ent.siren || '';
            const siren = rawSiren.toString().replace(/\s+/g, '');
            const entName = ent.nom_entreprise || ent.denomination || 'Entreprise';
            const cKey = normalizeCompanyKey(siren, entName);

            let compId = entityMap[cKey];
            if (!compId) {
              compId = `ent_${cKey}`;
              entityMap[cKey] = compId;
              addNode(compId, entName, 'company', {
                depth: 4,
                siren: siren || null,
                title: `Société (N4) : ${entName}\nSIREN : ${siren || 'N/A'}\nQualité : ${ent.qualite || 'Dirigeant'}`
              });
              nextCompanies.push({ id: compId, siren, name: entName, depth: 4 });
              await notifyUpdate('partial');
              await sleep(50);
            }
            addEdge(person.id, compId, ent.qualite || 'DIRIGEANT');
          }
        }
      }
    } catch (e) {
      console.warn(`[CartelNeural] Erreur expand pour ${person.label}:`, e);
    }
  }

  // N5 : Trouver les associés dans ces nouvelles sociétés N4
  for (const comp of nextCompanies) {
    if (!comp.siren || processedCompanies.has(comp.siren)) continue;
    processedCompanies.add(comp.siren);
    await sleep(150);

    try {
      const entUrl = `https://api.pappers.fr/v2/entreprise/dirigeants?siren=${comp.siren}&api_token=${activePappersKey}`;
      const entRes = await fetch(entUrl);
      if (entRes.ok) {
        const rawList = await entRes.json();
        for (const rep of (Array.isArray(rawList) ? rawList : (rawList.dirigeants || []))) {
          if (rep.personne_morale === true) continue;
          const repPrenom = rep.prenom || '';
          const repNom = rep.nom || '';
          const repLabel = rep.nom_complet || `${repPrenom} ${repNom}`.trim();
          if (!repLabel) continue;

          const repKey = normalizePersonKey(repPrenom, repNom || repLabel);
          let coDirId = entityMap[repKey];
          if (!coDirId) {
            coDirId = `n5_codir_${repKey}`;
            entityMap[repKey] = coDirId;
            addNode(coDirId, repLabel, 'person', {
              depth: 5,
              title: `Associé étendu (N5) : ${repLabel}\nSociété : ${comp.name}`
            });
            nextPersons.push({ id: coDirId, label: repLabel, depth: 5 });
            await notifyUpdate('partial');
            await sleep(40);
          }
          addEdge(comp.id, coDirId, rep.qualite || 'DIRIGEANT / ASSOCIÉ');
        }
      }
    } catch (e) {
      console.warn(`[CartelNeural] Erreur expand co-dirigeants pour ${comp.name}:`, e);
    }
  }

  currentFrontier = nextPersons;

  await browserApi.storage.local.set({
    graphStatus: 'complete',
    graphData:   { nodes: [...nodes], edges: [...edges] }
  });
}