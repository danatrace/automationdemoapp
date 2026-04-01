const state = {
  user: null,
  activeView: 'transactions'
};

const elements = {
  authView: document.querySelector('#authView'),
  transactionsView: document.querySelector('#transactionsView'),
  stocksView: document.querySelector('#stocksView'),
  chaosView: document.querySelector('#chaosView'),
  nav: document.querySelector('#nav'),
  logoutButton: document.querySelector('#logoutButton'),
  sessionSummary: document.querySelector('#sessionSummary'),
  balanceAmount: document.querySelector('#balanceAmount'),
  transactionList: document.querySelector('#transactionList'),
  stocksGrid: document.querySelector('#stocksGrid'),
  chaosStatus: document.querySelector('#chaosStatus'),
  toast: document.querySelector('#toast')
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(errorPayload.error || 'Request failed');
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.remove('hidden');
  elements.toast.style.borderColor = isError ? 'rgba(255, 107, 107, 0.45)' : 'rgba(94, 240, 197, 0.35)';
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => {
    elements.toast.classList.add('hidden');
  }, 3200);
}

async function logClientEvent(event, message, details = {}, level = 'info') {
  try {
    await api('/api/client-logs', {
      method: 'POST',
      body: JSON.stringify({ event, message, details, level })
    });
  } catch (error) {
    console.warn('Client log failed', error.message);
  }
}

function setView(view) {
  state.activeView = view;
  elements.transactionsView.classList.toggle('hidden', view !== 'transactions');
  elements.stocksView.classList.toggle('hidden', view !== 'stocks');
  elements.chaosView.classList.toggle('hidden', view !== 'chaos');

  document.querySelectorAll('.nav-link').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });

  logClientEvent('ui.view.change', 'View changed', { view });
}

function setAuthenticated(user) {
  state.user = user;
  const authenticated = Boolean(user);

  elements.authView.classList.toggle('hidden', authenticated);
  elements.nav.classList.toggle('hidden', !authenticated);
  elements.logoutButton.classList.toggle('hidden', !authenticated);
  elements.transactionsView.classList.toggle('hidden', !authenticated || state.activeView !== 'transactions');
  elements.stocksView.classList.toggle('hidden', !authenticated || state.activeView !== 'stocks');
  elements.chaosView.classList.toggle('hidden', !authenticated || state.activeView !== 'chaos');
  elements.sessionSummary.textContent = authenticated
    ? `${user.fullName} (${user.username})`
    : 'Not authenticated';

  if (authenticated) {
    setView(state.activeView);
  }
}

function renderTransactions(account) {
  elements.balanceAmount.textContent = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(account.balance);

  elements.transactionList.innerHTML = account.transactions
    .map(
      (transaction) => {
        const safeDescription = escapeHtml(transaction.description);
        const safeType = escapeHtml(transaction.type);
        return `
        <article class="list-item">
          <header>
            <strong>${safeDescription}</strong>
            <span class="pill ${safeType}">${safeType}</span>
          </header>
          <p>${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(transaction.amount)}</p>
          <small>${new Date(transaction.createdAt).toLocaleString()}</small>
        </article>
      `;
      }
    )
    .join('');
}

function renderStocks(stocks, asOf) {
  elements.stocksGrid.innerHTML = stocks
    .map(
      (stock) => {
        const safeSymbol = escapeHtml(stock.symbol);
        const safeCompany = escapeHtml(stock.company);
        return `
        <article class="stock-card">
          <header>
            <div>
              <strong>${safeSymbol}</strong>
              <div class="stock-meta">${safeCompany}</div>
            </div>
            <span class="pill ${stock.change >= 0 ? 'up' : 'down'}">${stock.change >= 0 ? '+' : ''}${stock.change}%</span>
          </header>
          <p>${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(stock.price)}</p>
          <small>${new Date(asOf).toLocaleString()}</small>
        </article>
      `;
      }
    )
    .join('');
}

async function refreshAccount() {
  const payload = await api('/api/account');
  renderTransactions(payload.account);
}

async function refreshStocks() {
  const payload = await api('/api/stocks');
  renderStocks(payload.stocks, payload.asOf);
}

async function refreshChaosStatus() {
  const status = await api('/api/chaos/status');
  elements.chaosStatus.textContent = JSON.stringify(status, null, 2);
  await updateChaosButtonStates();
}

async function initializeSession() {
  const payload = await api('/api/auth/session');
  setAuthenticated(payload.user);
  if (payload.user) {
    await Promise.all([refreshAccount(), refreshStocks(), refreshChaosStatus(), updateLoadGeneratorButtonStates()]);
  }
}

document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    const payload = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form.entries()))
    });
    setAuthenticated(payload.user);
    await Promise.all([refreshAccount(), refreshStocks(), refreshChaosStatus()]);
    await logClientEvent('auth.login.success', 'User logged in', { username: payload.user.username });
    showToast('Logged in successfully');
  } catch (error) {
    await logClientEvent('auth.login.failed', 'Login failed in UI', { reason: error.message }, 'warn');
    showToast(error.message, true);
  }
});

document.querySelector('#signupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);

  try {
    const payload = await api('/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(form.entries()))
    });
    setAuthenticated(payload.user);
    await Promise.all([refreshAccount(), refreshStocks(), refreshChaosStatus()]);
    await logClientEvent('auth.signup.success', 'User signed up', { username: payload.user.username });
    showToast('Signup complete');
    event.currentTarget.reset();
  } catch (error) {
    await logClientEvent('auth.signup.failed', 'Signup failed in UI', { reason: error.message }, 'warn');
    showToast(error.message, true);
  }
});

document.querySelector('#transactionForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = Object.fromEntries(form.entries());

  try {
    const response = await api('/api/transactions', {
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        amount: Number(payload.amount)
      })
    });
    renderTransactions(response.account);
    await logClientEvent('transaction.submit.success', 'Transaction submitted', response.transaction);
    showToast('Transaction posted');
    event.currentTarget.reset();
  } catch (error) {
    await logClientEvent('transaction.submit.failed', 'Transaction failed in UI', { reason: error.message }, 'error');
    showToast(error.message, true);
  }
});

document.querySelector('#refreshStocksButton').addEventListener('click', async () => {
  try {
    await refreshStocks();
    await logClientEvent('stocks.refresh', 'Stocks refreshed');
    showToast('Stocks refreshed');
  } catch (error) {
    await logClientEvent('stocks.refresh.failed', 'Stocks refresh failed', { reason: error.message }, 'warn');
    showToast(error.message, true);
  }
});

async function updateChaosButtonStates() {
  const status = await api('/api/chaos/status');
  const buttons = {
    saturation: { activate: 'saturationActivateButton', deactivate: 'saturationDeactivateButton' },
    ramp: { activate: 'rampActivateButton', deactivate: 'rampDeactivateButton' },
    errors: { activate: 'errorsActivateButton', deactivate: 'errorsDeactivateButton' }
  };

  Object.entries(buttons).forEach(([mode, ids]) => {
    const isActive = mode === 'saturation' ? status.saturation : mode === 'ramp' ? status.ramp : status.errorInjection;
    const activateBtn = document.querySelector(`#${ids.activate}`);
    const deactivateBtn = document.querySelector(`#${ids.deactivate}`);

    if (isActive) {
      activateBtn.classList.add('hidden');
      deactivateBtn.classList.remove('hidden');
    } else {
      activateBtn.classList.remove('hidden');
      deactivateBtn.classList.add('hidden');
    }
  });
}

async function updateLoadGeneratorButtonStates() {
  const status = await api('/api/load/status');
  const startBtn = document.querySelector('#loadStartButton');
  const stopBtn = document.querySelector('#loadStopButton');

  if (status.active) {
    startBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
  } else {
    startBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
  }
}

document.querySelector('#saturationActivateButton').addEventListener('click', async () => {
  try {
    await api('/api/chaos/saturation', { method: 'POST' });
    await refreshChaosStatus();
    await updateChaosButtonStates();
    await logClientEvent('chaos.saturation.trigger', 'Immediate CPU saturation activated');
    showToast('Immediate CPU saturation activated');
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector('#saturationDeactivateButton').addEventListener('click', async () => {
  try {
    await api('/api/chaos/saturation', { method: 'DELETE' });
    await refreshChaosStatus();
    await updateChaosButtonStates();
    await logClientEvent('chaos.saturation.deactivate', 'Immediate CPU saturation deactivated');
    showToast('Immediate CPU saturation deactivated');
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector('#rampActivateButton').addEventListener('click', async () => {
  try {
    await api('/api/chaos/ramp', { method: 'POST' });
    await refreshChaosStatus();
    await updateChaosButtonStates();
    await logClientEvent('chaos.ramp.trigger', 'Slow CPU ramp activated');
    showToast('Slow CPU ramp activated');
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector('#rampDeactivateButton').addEventListener('click', async () => {
  try {
    await api('/api/chaos/ramp', { method: 'DELETE' });
    await refreshChaosStatus();
    await updateChaosButtonStates();
    await logClientEvent('chaos.ramp.deactivate', 'Slow CPU ramp deactivated');
    showToast('Slow CPU ramp deactivated');
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector('#errorsActivateButton').addEventListener('click', async () => {
  try {
    await api('/api/chaos/errors', { method: 'POST' });
    await refreshChaosStatus();
    await updateChaosButtonStates();
    await logClientEvent('chaos.errors.trigger', 'Error injection activated');
    showToast('Error injection activated');
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector('#errorsDeactivateButton').addEventListener('click', async () => {
  try {
    await api('/api/chaos/errors', { method: 'DELETE' });
    await refreshChaosStatus();
    await updateChaosButtonStates();
    await logClientEvent('chaos.errors.deactivate', 'Error injection deactivated');
    showToast('Error injection deactivated');
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector('#loadStartButton').addEventListener('click', async () => {
  try {
    const userCount = Number(document.querySelector('#userCountInput').value) || 10;
    await api('/api/load/start', { method: 'POST', body: JSON.stringify({ userCount }) });
    await updateLoadGeneratorButtonStates();
    await logClientEvent('load.start', 'Load generator started', { userCount });
    showToast(`Load generator started with ${userCount} concurrent users`);
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelector('#loadStopButton').addEventListener('click', async () => {
  try {
    await api('/api/load/stop', { method: 'POST' });
    await updateLoadGeneratorButtonStates();
    await logClientEvent('load.stop', 'Load generator stopped');
    showToast('Load generator stopped');
  } catch (error) {
    showToast(error.message, true);
  }
});

elements.logoutButton.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
    setAuthenticated(null);
    await logClientEvent('auth.logout', 'User logged out');
    showToast('Logged out');
  } catch (error) {
    showToast(error.message, true);
  }
});

document.querySelectorAll('.nav-link').forEach((button) => {
  button.addEventListener('click', async () => {
    setView(button.dataset.view);
    if (button.dataset.view === 'stocks') {
      await refreshStocks().catch(() => {});
    }
    if (button.dataset.view === 'chaos') {
      await Promise.all([refreshChaosStatus(), updateLoadGeneratorButtonStates()]).catch(() => {});
    }
  });
});

initializeSession().catch((error) => {
  console.error(error);
  showToast('Failed to initialize application', true);
});