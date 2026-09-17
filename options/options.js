document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('apiForm');
  const status = document.getElementById('status');
  const pappersKeyInput = document.getElementById('pappersKey');
  const serpapiKeyInput = document.getElementById('serpapiKey');

  const browserApi = typeof browser !== 'undefined' ? browser : (typeof chrome !== 'undefined' ? chrome : null);
  if (!browserApi?.storage?.local) return;

  const saved = await browserApi.storage.local.get(['pappersApiKey', 'serpapiKey']);
  if (saved.pappersApiKey) pappersKeyInput.value = saved.pappersApiKey;
  if (saved.serpapiKey)    serpapiKeyInput.value = saved.serpapiKey;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const pappersApiKey = pappersKeyInput.value.trim();
    const serpapiKey    = serpapiKeyInput.value.trim();

    await browserApi.storage.local.set({ pappersApiKey, serpapiKey });

    status.textContent = 'Clés enregistrées avec succès.';
    status.style.color = '#34d399';
  });
});
