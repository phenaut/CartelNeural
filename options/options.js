document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('apiForm');
  const status = document.getElementById('status');
  const pappersKeyInput = document.getElementById('pappersKey');
  const serpapiKeyInput = document.getElementById('serpapiKey');

  const saved = await browser.storage.local.get(['pappersApiKey', 'serpapiKey']);
  if (saved.pappersApiKey) pappersKeyInput.value = saved.pappersApiKey;
  if (saved.serpapiKey) serpapiKeyInput.value = saved.serpapiKey;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const pappersApiKey = pappersKeyInput.value.trim();
    const serpapiKey = serpapiKeyInput.value.trim();

    await browser.storage.local.set({ pappersApiKey, serpapiKey });

    status.textContent = 'Clés enregistrées avec succès.';
    status.style.color = '#34d399';
  });
});
