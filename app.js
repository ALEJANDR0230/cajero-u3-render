const el = id => document.getElementById(id);
const money = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' });
const date = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const currency = amount => money.format(amount / 100);
const typeLabels = { deposit: 'Depósito', withdraw: 'Retiro' };
let action = 'deposit';

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? 'No se obtuvo respuesta del cajero.');
  return data;
}

function message(value, error = false) {
  el('message').textContent = value;
  el('message').classList.toggle('error', error);
}

function render(state) {
  el('balance').textContent = currency(state.balance);
  el('environment').textContent = state.environment;
  el('database').textContent = state.database === 'postgresql' ? 'PostgreSQL' : 'SQLite';
  el('movement-count').textContent = state.movements.length === 1 ? '1 movimiento reciente' : state.movements.length + ' movimientos recientes';
  el('empty').hidden = state.movements.length > 0;
  el('movements').replaceChildren(...state.movements.map(movement => {
    const row = document.createElement('li');
    const mark = document.createElement('span');
    const info = document.createElement('div');
    const detail = document.createElement('small');
    const label = document.createElement('strong');
    const amount = document.createElement('strong');
    const deposit = movement.type === 'deposit';
    mark.className = 'movement-icon ' + movement.type;
    mark.textContent = deposit ? '↓' : '↑';
    mark.setAttribute('aria-hidden', 'true');
    label.textContent = typeLabels[movement.type];
    detail.textContent = '#' + movement.id + ' · ' + date.format(new Date(movement.created_at));
    amount.className = 'movement-value ' + movement.type;
    amount.textContent = (deposit ? '+' : '−') + currency(movement.amount);
    info.append(label, detail);
    row.append(mark, info, amount);
    return row;
  }));
}

function choose(type) {
  action = type;
  for (const button of document.querySelectorAll('[data-action]')) {
    button.setAttribute('aria-pressed', button.dataset.action === type);
  }
  el('submit').firstChild.textContent = type === 'deposit' ? 'Confirmar depósito ' : 'Confirmar retiro ';
  message('');
}

function parseAmount(value) {
  const match = value.trim().match(/^(\d{1,5})(?:[.,](\d{1,2}))?$/);
  if (!match) return 0;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => choose(button.dataset.action));
}
for (const button of document.querySelectorAll('[data-quick]')) {
  button.addEventListener('click', () => {
    el('amount').value = button.dataset.quick;
    message('');
    el('amount').focus();
  });
}
el('operation').addEventListener('submit', async event => {
  event.preventDefault();
  if (el('submit').disabled) return;
  const amount = parseAmount(el('amount').value);
  if (!amount || amount > 1_000_000) return message('Ingresa un monto entre $0.01 y $10,000.00.', true);
  el('submit').disabled = true;
  const type = action;
  try {
    const state = await api('/api/movements', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, amount }),
    });
    render(state);
    el('amount').value = '';
    message(typeLabels[type] + ' de ' + currency(amount) + ' registrado. Folio #' + state.receipt.id + '.');
  } catch (error) {
    message(error.message, true);
  } finally {
    el('submit').disabled = false;
  }
});
try {
  render(await api('/api/account'));
  el('submit').disabled = false;
} catch {
  el('environment').textContent = 'Sin conexión';
  message('No se pudo conectar con el cajero. Vuelve a cargar la página.', true);
}
