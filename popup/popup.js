document.addEventListener('DOMContentLoaded', async () => {
  const browserApi = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  const searchType  = document.getElementById('searchType');
  const personFields = document.getElementById('personFields');
  const emailFields  = document.getElementById('emailFields');
  const searchForm   = document.getElementById('searchForm');
  const btnSaveKeys  = document.getElementById('btnSaveKeys');
  const btnOpenOptions = document.getElementById('btnOpenOptions');
  const statusMsg    = document.getElementById('statusMsg');

  if (!browserApi?.storage?.local) {
    statusMsg.textContent = 'L\'extension n\'a pas accès au stockage navigateur.';
    statusMsg.style.display = 'block';
    return;
  }

  // Chargement des clés sauvegardées
  const saved = await browserApi.storage.local.get(['pappersApiKey', 'serpapiKey']);
  if (saved.pappersApiKey) document.getElementById('pappersKey').value = saved.pappersApiKey;
  if (saved.serpapiKey)    document.getElementById('serpapiKey').value = saved.serpapiKey;

  // Bascule des champs selon le type de recherche
  searchType.addEventListener('change', () => {
    const isPerson = searchType.value === 'person';
    personFields.style.display = isPerson ? 'block' : 'none';
    emailFields.style.display  = isPerson ? 'none'  : 'block';
  });

  // Sauvegarde des clés API
  btnSaveKeys.addEventListener('click', async () => {
    const pappersApiKey = document.getElementById('pappersKey').value.trim();
    const serpapiKey    = document.getElementById('serpapiKey').value.trim();
    await browserApi.storage.local.set({ pappersApiKey, serpapiKey });
    statusMsg.style.display = 'block';
    setTimeout(() => { statusMsg.style.display = 'none'; }, 2000);
  });

  btnOpenOptions.addEventListener('click', () => {
    if (browserApi?.runtime?.openOptionsPage) browserApi.runtime.openOptionsPage();
  });

  // Soumission du formulaire
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const type     = searchType.value;
    const maxDepth = parseInt(document.getElementById('maxDepth').value, 10) || 3;
    let queryPayload = {};

    const pappersApiKey = document.getElementById('pappersKey').value.trim();
    const serpapiKey    = document.getElementById('serpapiKey').value.trim();

    if (pappersApiKey || serpapiKey) {
      await browserApi.storage.local.set({ pappersApiKey, serpapiKey });
    }

    if (type === 'person') {
      const nom    = document.getElementById('nom').value.trim();
      const prenom = document.getElementById('prenom').value.trim();
      if (!nom && !prenom) {
        alert('Veuillez saisir un nom ou un prénom.');
        return;
      }
      queryPayload = { type: 'person', nom, prenom, maxDepth, pappersApiKey, serpapiKey };
    } else {
      const email = document.getElementById('email').value.trim();
      if (!email) {
        alert('Veuillez saisir une adresse email.');
        return;
      }
      queryPayload = { type: 'email', email, maxDepth, pappersApiKey, serpapiKey };
    }

    if (browserApi?.runtime?.sendMessage) {
      browserApi.runtime.sendMessage({ action: 'startSearch', payload: queryPayload });
    }

    if (browserApi?.tabs?.create) {
      browserApi.tabs.create({ url: browserApi.runtime.getURL('view/graph.html') });
    }

    window.close();
  });
});