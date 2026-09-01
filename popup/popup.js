document.addEventListener('DOMContentLoaded', async () => {
  const searchType = document.getElementById('searchType');
  const personFields = document.getElementById('personFields');
  const emailFields = document.getElementById('emailFields');
  const searchForm = document.getElementById('searchForm');
  const btnSaveKeys = document.getElementById('btnSaveKeys');
  const btnOpenOptions = document.getElementById('btnOpenOptions');
  const statusMsg = document.getElementById('statusMsg');

  // Load saved API Keys
  const saved = await browser.storage.local.get(['pappersApiKey', 'serpapiKey']);
  if (saved.pappersApiKey) document.getElementById('pappersKey').value = saved.pappersApiKey;
  if (saved.serpapiKey) document.getElementById('serpapiKey').value = saved.serpapiKey;

  // Toggle input fields
  searchType.addEventListener('change', () => {
    if (searchType.value === 'person') {
      personFields.style.display = 'block';
      emailFields.style.display = 'none';
    } else {
      personFields.style.display = 'none';
      emailFields.style.display = 'block';
    }
  });

  // Save API Keys
  btnSaveKeys.addEventListener('click', async () => {
    const pappersApiKey = document.getElementById('pappersKey').value.trim();
    const serpapiKey = document.getElementById('serpapiKey').value.trim();

    await browser.storage.local.set({ pappersApiKey, serpapiKey });
    statusMsg.style.display = 'block';
    setTimeout(() => { statusMsg.style.display = 'none'; }, 2000);
  });

  btnOpenOptions.addEventListener('click', () => {
    browser.runtime.openOptionsPage();
  });

  // Handle Form Submit
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const type = searchType.value;
    let queryPayload = {};

    if (type === 'person') {
      const nom = document.getElementById('nom').value.trim();
      const prenom = document.getElementById('prenom').value.trim();
      if (!nom && !prenom) {
        alert('Veuillez saisir un nom ou un prénom.');
        return;
      }
      queryPayload = { type: 'person', nom, prenom };
    } else {
      const email = document.getElementById('email').value.trim();
      if (!email) {
        alert('Veuillez saisir une adresse email.');
        return;
      }
      queryPayload = { type: 'email', email };
    }

    // Send query to background script
    browser.runtime.sendMessage({ action: 'startSearch', payload: queryPayload });

    // Open graph page in new tab
    browser.tabs.create({ url: browser.runtime.getURL('view/graph.html') });

    window.close();
  });
});