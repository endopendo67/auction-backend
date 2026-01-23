// Состояние приложения
const state = {
  user: null,
  currentAuction: null,
  socket: null,
  timerInterval: null,
  leaderboardInterval: null,
};

// DOM элементы
const $ = (id) => document.getElementById(id);

const el = {
  // Секции
  authSection: $('auth-section'),
  userPanel: $('user-panel'),
  auctionsSection: $('auctions-section'),
  auctionsPagination: $('auctions-pagination'),
  auctionsPrev: $('auctions-prev'),
  auctionsNext: $('auctions-next'),
  auctionsPage: $('auctions-page'),
  auctionDetail: $('auction-detail'),
  createAuctionSection: $('create-auction-section'),
  historySection: $('history-section'),
  
  // Авторизация
  loginForm: $('login-form'),
  loginUsername: $('login-username'),
  logoutBtn: $('logout-btn'),
  userName: $('user-name'),
  
  // Баланс
  balanceTotal: $('balance-total'),
  balanceLocked: $('balance-locked'),
  balanceAvailable: $('balance-available'),
  depositAmount: $('deposit-amount'),
  depositBtn: $('deposit-btn'),
  
  // Аукционы
  auctionsList: $('auctions-list'),
  createAuctionBtn: $('create-auction-btn'),
  refreshAuctionsBtn: $('refresh-auctions-btn'),
  
  // Детали аукциона
  backBtn: $('back-btn'),
  auctionName: $('auction-name'),
  auctionStatus: $('auction-status'),
  auctionDescription: $('auction-description'),
  auctionRound: $('auction-round'),
  auctionRoundItems: $('auction-round-items'),
  auctionItems: $('auction-items'),
  auctionExtensions: $('auction-extensions'),
  extensionsStat: $('extensions-stat'),
  auctionTime: $('auction-time'),
  minWinningBid: $('min-winning-bid'),
  yourBid: $('your-bid'),
  yourPosition: $('your-position'),
  bidAmount: $('bid-amount'),
  placeBidBtn: $('place-bid-btn'),
  quickBidOutbid: $('quick-bid-outbid'),
  leaderboardBody: $('leaderboard-body'),
  refreshLeaderboardBtn: $('refresh-leaderboard-btn'),
  leaderboardPagination: $('leaderboard-pagination'),
  leaderboardPrev: $('leaderboard-prev'),
  leaderboardNext: $('leaderboard-next'),
  leaderboardPage: $('leaderboard-page'),
  
  // Создание
  cancelCreateBtn: $('cancel-create-btn'),
  createAuctionForm: $('create-auction-form'),
  addRoundBtn: $('add-round-btn'),
  roundsConfig: $('rounds-config'),
  enableBotSimulation: $('enable-bot-simulation'),
  
  // История
  historyBtn: $('history-btn'),
  historyBackBtn: $('history-back-btn'),
  historyList: $('history-list'),
  historyPagination: $('history-pagination'),
  historyPrev: $('history-prev'),
  historyNext: $('history-next'),
  historyPage: $('history-page'),
  
  // Предметы
  itemsBtn: $('items-btn'),
  itemsBackBtn: $('items-back-btn'),
  itemsSection: $('items-section'),
  itemsList: $('items-list'),
  itemsPagination: $('items-pagination'),
  itemsPrev: $('items-prev'),
  itemsNext: $('items-next'),
  itemsPage: $('items-page'),
  
  // Уведомления
  notifications: $('notifications'),
  
  // Язык
  langSelect: $('lang-select'),
};

// API клиент
const api = {
  async request(endpoint, options = {}) {
    const config = {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...options,
    };

    if (config.body && typeof config.body === 'object') {
      config.body = JSON.stringify(config.body);
    }

    const response = await fetch(`/api${endpoint}`, config);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || t('error.network'));
    }

    return data;
  },

  // Auth
  login: (username, initialBalance = 10000) => 
    api.request('/auth/login', { method: 'POST', body: { username, initialBalance } }),
  
  logout: () => 
    api.request('/auth/logout', { method: 'POST' }),
  
  getMe: () => 
    api.request('/auth/me'),

  // Users
  getUserBalance: (userId) => 
    api.request(`/users/${userId}/balance`),
  
  deposit: (userId, amount) => 
    api.request(`/users/${userId}/deposit`, { method: 'POST', body: { amount } }),

  // Auctions
  getAuctions: (page = 1, limit = 50) => 
    api.request(`/auctions?page=${page}&limit=${limit}`),
  
  getAuction: (auctionId) => 
    api.request(`/auctions/${auctionId}`),
  
  createAuction: (data) => 
    api.request('/auctions', { method: 'POST', body: data }),
  
  startAuction: (auctionId, options = {}) => 
    api.request(`/auctions/${auctionId}/start`, { method: 'POST', body: options }),
  
  placeBid: (auctionId, userId, amount) => 
    api.request(`/auctions/${auctionId}/bid`, { method: 'POST', body: { userId, amount } }),
  
  quickBid: (auctionId, userId, type) => 
    api.request(`/auctions/${auctionId}/quick-bid`, { method: 'POST', body: { userId, type } }),
  
  getLeaderboard: (auctionId, limit = 100) => 
    api.request(`/auctions/${auctionId}/leaderboard?limit=${limit}`),
  
  getWinners: (auctionId) => 
    api.request(`/auctions/${auctionId}/winners`),
  
  getUserBidStatus: (auctionId, userId) => 
    api.request(`/auctions/${auctionId}/user/${userId}/status`),
  
  // History
  getBidHistory: (userId, page = 1, limit = 20) => 
    api.request(`/users/${userId}/bids?page=${page}&limit=${limit}`),
  
  // Won Items
  getWonItems: (userId, page = 1, limit = 20) => 
    api.request(`/users/${userId}/won-items?page=${page}&limit=${limit}`),
};

// Уведомления
function notify(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  el.notifications.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('fade-out');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Форматирование времени
function formatTime(ms) {
  if (ms <= 0) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

// Показать/скрыть секции
function showSection(section) {
  // Скрываем ВСЕ секции
  [
    el.authSection, 
    el.auctionsSection, 
    el.auctionDetail, 
    el.createAuctionSection,
    el.historySection,
    el.itemsSection
  ].forEach(s => s?.classList.add('hidden'));
  
  // Показываем userPanel если авторизован
  if (state.user) {
    el.userPanel?.classList.remove('hidden');
  } else {
    el.userPanel?.classList.add('hidden');
  }
  
  // Показываем нужную секцию
  section?.classList.remove('hidden');
}

// =====================
// АВТОРИЗАЦИЯ
// =====================

async function checkAuth() {
  try {
    const result = await api.getMe();
    if (result.data?.user) {
      state.user = result.data.user;
      el.userName.textContent = state.user.username;
      showSection(el.auctionsSection);
      updateBalance();
      loadAuctions();
      initSocket();
    } else {
      showSection(el.authSection);
    }
  } catch (err) {
    showSection(el.authSection);
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = el.loginUsername.value.trim();
  
  if (username.length < 3) {
    notify(t('error.invalid_amount'), 'error');
    return;
  }

  try {
    const result = await api.login(username);
    state.user = result.data.user;
    el.userName.textContent = state.user.username;
    el.loginUsername.value = '';
    
    showSection(el.auctionsSection);
    updateBalance();
    loadAuctions();
    initSocket();
    
    notify(result.data.isNewUser ? t('auth.welcome') : t('auth.welcome_back'), 'success');
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function handleLogout() {
  try {
    await api.logout();
    
    if (state.socket) {
      state.socket.disconnect();
      state.socket = null;
    }
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
    
    state.user = null;
    state.currentAuction = null;
    
    showSection(el.authSection);
    notify(t('auth.logged_out'), 'info');
  } catch (err) {
    notify(err.message, 'error');
  }
}

// =====================
// БАЛАНС
// =====================

async function updateBalance() {
  if (!state.user) return;
  
  try {
    const result = await api.getUserBalance(state.user.id);
    const b = result.data;
    el.balanceTotal.textContent = `${b.balance} ⭐`;
    el.balanceLocked.textContent = `${b.lockedBalance} ⭐`;
    el.balanceAvailable.textContent = `${b.availableBalance} ⭐`;
  } catch (err) {
    console.error('Balance update error:', err);
  }
}

async function handleDeposit() {
  const amount = parseInt(el.depositAmount.value);
  
  if (!amount || amount <= 0) {
    notify(t('error.invalid_amount'), 'error');
    return;
  }

  try {
    await api.deposit(state.user.id, amount);
    el.depositAmount.value = '';
    await updateBalance();
    notify(t('balance.deposited', { amount }), 'success');
  } catch (err) {
    notify(err.message, 'error');
  }
}

// =====================
// АУКЦИОНЫ
// =====================

// ==================== ИСТОРИЯ ====================
let historyPage = 1;
let historyTotalPages = 1;

async function loadHistory(page = 1) {
  if (!state.user) return;
  
  el.historyList.innerHTML = `<p class="empty-state">${t('common.loading')}</p>`;
  
  try {
    const result = await api.getBidHistory(state.user.id, page, 20);
    historyPage = result.pagination.page;
    historyTotalPages = result.pagination.pages;
    renderHistory(result.data);
    updateHistoryPagination();
  } catch (err) {
    el.historyList.innerHTML = `<p class="empty-state">${t('common.error')}</p>`;
  }
}

function renderHistory(bids) {
  if (!bids || !bids.length) {
    el.historyList.innerHTML = `<p class="empty-state">${t('history.no_bids')}</p>`;
    el.historyPagination.classList.add('hidden');
    return;
  }
  
  el.historyList.innerHTML = bids.map(bid => {
    const date = new Date(bid.createdAt).toLocaleString();
    const auctionTitle = bid.auctionId?.title || t('history.unknown_auction');
    const isWinner = bid.isWinner;
    
    return `
      <div class="history-item ${isWinner ? 'winner' : ''}">
        <div class="history-item-main">
          <span class="history-auction">${auctionTitle}</span>
          <span class="history-amount">${bid.amount} ⭐</span>
        </div>
        <div class="history-item-meta">
          <span class="history-date">${date}</span>
          ${isWinner ? `<span class="history-badge winner">${t('history.won')}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function updateHistoryPagination() {
  if (historyTotalPages <= 1) {
    el.historyPagination.classList.add('hidden');
    return;
  }
  
  el.historyPagination.classList.remove('hidden');
  el.historyPage.textContent = `${historyPage} / ${historyTotalPages}`;
  el.historyPrev.disabled = historyPage <= 1;
  el.historyNext.disabled = historyPage >= historyTotalPages;
}

function showHistory() {
  showSection(el.historySection);
  loadHistory(1);
}

function hideHistory() {
  showSection(el.auctionsSection);
}

// ==================== ПРЕДМЕТЫ ====================
let itemsPage = 1;
let itemsTotalPages = 1;

async function loadItems(page = 1) {
  if (!state.user) return;
  
  el.itemsList.innerHTML = `<p class="empty-state">${t('common.loading')}</p>`;
  
  try {
    const result = await api.getWonItems(state.user.id, page, 20);
    itemsPage = result.pagination.page;
    itemsTotalPages = result.pagination.pages;
    renderItems(result.data);
    updateItemsPagination();
  } catch (err) {
    el.itemsList.innerHTML = `<p class="empty-state">${t('common.error')}</p>`;
  }
}

function renderItems(items) {
  if (!items || !items.length) {
    el.itemsList.innerHTML = `<p class="empty-state">${t('items.no_items')}</p>`;
    el.itemsPagination.classList.add('hidden');
    return;
  }
  
  el.itemsList.innerHTML = items.map(item => {
    const auctionTitle = item.auctionId?.title || t('items.unknown_auction');
    const wonDate = new Date(item.updatedAt).toLocaleString();
    
    return `
      <div class="item-card">
        <div class="item-header">
          <span class="item-number">#${item.itemNumber}</span>
          <span class="item-badge">🏆</span>
        </div>
        <div class="item-auction">${escapeHtml(auctionTitle)}</div>
        <div class="item-details">
          <div class="item-row">
            <span>${t('items.winning_bid')}:</span>
            <span class="item-amount">${item.amount} ⭐</span>
          </div>
          <div class="item-row">
            <span>${t('items.round')}:</span>
            <span>${item.round + 1}</span>
          </div>
          <div class="item-date">${wonDate}</div>
        </div>
      </div>
    `;
  }).join('');
  
  el.itemsPagination.classList.remove('hidden');
}

function updateItemsPagination() {
  if (itemsTotalPages <= 1) {
    el.itemsPagination.classList.add('hidden');
    return;
  }
  
  el.itemsPagination.classList.remove('hidden');
  el.itemsPage.textContent = `${itemsPage} / ${itemsTotalPages}`;
  el.itemsPrev.disabled = itemsPage <= 1;
  el.itemsNext.disabled = itemsPage >= itemsTotalPages;
}

function showItems() {
  showSection(el.itemsSection);
  loadItems(1);
}

function hideItems() {
  showSection(el.auctionsSection);
}

// ==================== АУКЦИОНЫ ====================
let auctionsPage = 1;
let auctionsTotalPages = 1;

// Пагинация лидерборда
let leaderboardPage = 1;
let leaderboardTotalPages = 1;
let leaderboardData = []; // Все данные лидерборда
const LEADERBOARD_PER_PAGE = 50;

async function loadAuctions(page = 1) {
  try {
    const result = await api.getAuctions(page, 20);
    auctionsPage = result.pagination.page;
    auctionsTotalPages = result.pagination.pages;
    renderAuctionsList(result.data);
    updateAuctionsPagination();
  } catch (err) {
    el.auctionsList.innerHTML = `<p class="empty-state">${t('common.error')}</p>`;
  }
}

function updateAuctionsPagination() {
  if (auctionsTotalPages <= 1) {
    el.auctionsPagination.classList.add('hidden');
    return;
  }
  
  el.auctionsPagination.classList.remove('hidden');
  el.auctionsPage.textContent = `${auctionsPage} / ${auctionsTotalPages}`;
  el.auctionsPrev.disabled = auctionsPage <= 1;
  el.auctionsNext.disabled = auctionsPage >= auctionsTotalPages;
}

async function refreshAuctions() {
  el.refreshAuctionsBtn.disabled = true;
  el.refreshAuctionsBtn.textContent = '⏳';
  
  try {
    await loadAuctions(auctionsPage);
  } finally {
    el.refreshAuctionsBtn.disabled = false;
    el.refreshAuctionsBtn.textContent = '↻';
  }
}

function renderAuctionCard(a) {
  return `
    <div class="auction-card" data-id="${a.id}">
      <div class="auction-card-header">
        <h3>${escapeHtml(a.title)}</h3>
        <span class="status-badge ${a.status}">${t('status.' + a.status)}</span>
      </div>
      <div class="auction-card-stats">
        <span>${t('auctions.distributed')} ${a.distributedItems}/${a.totalItems}</span>
        <span>${t('auctions.round')} ${a.currentRound + 1}/${a.rounds.length}</span>
        <span>${t('auctions.starting_price')} ${a.startingPrice} ⭐</span>
      </div>
    </div>
  `;
}

function renderAuctionsList(auctions) {
  if (!auctions || !auctions.length) {
    el.auctionsList.innerHTML = `<p class="empty-state">${t('auctions.no_auctions')}</p>`;
    return;
  }

  el.auctionsList.innerHTML = auctions.map(renderAuctionCard).join('');

  el.auctionsList.querySelectorAll('.auction-card').forEach(card => {
    card.addEventListener('click', () => openAuction(card.dataset.id));
  });
}

// Добавить аукцион в начало списка (без перезагрузки)
function prependAuction(auction) {
  const emptyState = el.auctionsList.querySelector('.empty-state');
  if (emptyState) emptyState.remove();
  
  const existing = el.auctionsList.querySelector(`[data-id="${auction.id}"]`);
  if (existing) return; // Уже есть
  
  el.auctionsList.insertAdjacentHTML('afterbegin', renderAuctionCard(auction));
  const card = el.auctionsList.querySelector(`[data-id="${auction.id}"]`);
  card?.addEventListener('click', () => openAuction(auction.id));
}

// Обновить карточку аукциона (статус, раунд и т.д.)
function updateAuctionCard(auction) {
  const card = el.auctionsList.querySelector(`[data-id="${auction.id}"]`);
  if (!card) return;
  
  card.outerHTML = renderAuctionCard(auction);
  const newCard = el.auctionsList.querySelector(`[data-id="${auction.id}"]`);
  newCard?.addEventListener('click', () => openAuction(auction.id));
}

async function openAuction(auctionId) {
  try {
    await loadAuctionDetail(auctionId);
    showSection(el.auctionDetail);
    
    if (state.socket) {
      state.socket.emit('auction:join', auctionId);
    }
    
    startTimer();
    startLeaderboardAutoRefresh();
  } catch (err) {
    notify(err.message, 'error');
  }
}

async function loadAuctionDetail(auctionId) {
  const result = await api.getAuction(auctionId);
  state.currentAuction = result.data;
  
  const a = state.currentAuction;
  const round = a.rounds[a.currentRound];
  
  el.auctionName.textContent = a.title;
  el.auctionDescription.textContent = a.description || '';
  el.auctionStatus.textContent = t('status.' + a.status);
  el.auctionStatus.className = `status-badge ${a.status}`;
  el.auctionRound.textContent = `${a.currentRound + 1} / ${a.rounds.length}`;
  
  if (round) {
    el.auctionRoundItems.textContent = round.itemsToDistribute;
    el.auctionExtensions.textContent = round.extensionCount || 0;
    el.extensionsStat.style.display = a.status === 'active' ? '' : 'none';
  }
  
  el.auctionItems.textContent = `${a.totalItems - a.distributedItems} / ${a.totalItems}`;
  el.minWinningBid.textContent = `${a.minWinningBid || a.startingPrice} ⭐`;
  
  // Обновляем заголовок таблицы в зависимости от статуса
  const leaderboardTitle = document.querySelector('.leaderboard-header h3');
  if (leaderboardTitle) {
    leaderboardTitle.setAttribute('data-i18n', a.status === 'completed' ? 'leaderboard.winners_title' : 'leaderboard.title');
    leaderboardTitle.textContent = t(a.status === 'completed' ? 'leaderboard.winners_title' : 'leaderboard.title');
  }
  
  // Скрываем форму ставок для завершённых аукционов
  const bidSection = document.querySelector('.bid-section');
  if (bidSection) {
    bidSection.style.display = a.status === 'completed' ? 'none' : 'block';
  }
  
  if (round) {
    state.currentAuction.roundEndTime = new Date(round.endTime).getTime();
  }
  
  await loadLeaderboard(auctionId);
  // Статус пользователя обновляется автоматически из лидерборда
  updateUserStatusFromLeaderboard();
}

async function loadLeaderboard(auctionId, resetPage = true) {
  try {
    // Для завершённых аукционов показываем победителей
    if (state.currentAuction?.status === 'completed') {
      console.log('Loading winners for completed auction:', auctionId);
      const result = await api.getWinners(auctionId);
      console.log('Winners received:', result.data?.length || 0);
      renderWinners(result.data);
      // Пагинация управляется внутри renderWinners -> updateLeaderboardPagination
    } else {
      // Загружаем больше данных для пагинации (до 500)
      const result = await api.getLeaderboard(auctionId, 500);
      leaderboardData = (result.data || []).map(b => ({
        ...b,
        oduserId: b.oduserId,  // Сохраняем userId для поиска своей позиции
      }));
      leaderboardTotalPages = Math.ceil(leaderboardData.length / LEADERBOARD_PER_PAGE);
      if (resetPage) leaderboardPage = 1;
      renderLeaderboardPage();
      // Обновляем статус пользователя из лидерборда (БЕЗ HTTP!)
      updateUserStatusFromLeaderboard();
    }
  } catch (err) {
    console.error('Error loading leaderboard:', err);
    el.leaderboardBody.innerHTML = `<tr><td colspan="3">${t('common.error')}</td></tr>`;
    el.leaderboardPagination?.classList.add('hidden');
  }
}

function renderLeaderboardPage() {
  if (!leaderboardData.length) {
    el.leaderboardBody.innerHTML = `<tr><td colspan="3">${t('leaderboard.no_bids')}</td></tr>`;
    el.leaderboardPagination?.classList.add('hidden');
    return;
  }

  // Вычисляем срез для текущей страницы
  const start = (leaderboardPage - 1) * LEADERBOARD_PER_PAGE;
  const end = start + LEADERBOARD_PER_PAGE;
  const pageBids = leaderboardData.slice(start, end);

  renderLeaderboard(pageBids, start);
  updateLeaderboardPagination();
}

function renderLeaderboard(bids, startIndex = 0) {
  if (!bids || !bids.length) {
    el.leaderboardBody.innerHTML = `<tr><td colspan="3">${t('leaderboard.no_bids')}</td></tr>`;
    return;
  }

  const round = state.currentAuction?.rounds[state.currentAuction.currentRound];
  const itemsInRound = round?.itemsToDistribute || 0;

  el.leaderboardBody.innerHTML = bids.map((bid, i) => {
    const globalIndex = startIndex + i;
    const isWinning = globalIndex < itemsInRound;
    const isYou = state.user && bid.username === state.user.username;
    const classes = [isWinning ? 'winning' : '', isYou ? 'you' : ''].filter(Boolean).join(' ');
    const position = bid.position || globalIndex + 1;
    const positionText = isWinning ? `🏆 #${position}` : `#${position}`;
    
    return `
      <tr class="${classes}">
        <td>${positionText}</td>
        <td>${escapeHtml(bid.username)}${isYou ? ' ' + t('leaderboard.you') : ''}</td>
        <td>${bid.amount} ⭐</td>
      </tr>
    `;
  }).join('');
}

function updateLeaderboardPagination() {
  if (leaderboardTotalPages <= 1) {
    el.leaderboardPagination?.classList.add('hidden');
    return;
  }
  
  el.leaderboardPagination?.classList.remove('hidden');
  
  if (el.leaderboardPage) {
    el.leaderboardPage.textContent = `${leaderboardPage} / ${leaderboardTotalPages}`;
  }
  if (el.leaderboardPrev) el.leaderboardPrev.disabled = leaderboardPage <= 1;
  if (el.leaderboardNext) el.leaderboardNext.disabled = leaderboardPage >= leaderboardTotalPages;
}

function changeLeaderboardPage(delta) {
  const newPage = leaderboardPage + delta;
  if (newPage >= 1 && newPage <= leaderboardTotalPages) {
    leaderboardPage = newPage;
    
    // Для завершённых аукционов — рендерим победителей с пагинацией
    if (state.currentAuction?.status === 'completed' && leaderboardData.length > 0) {
      const start = (leaderboardPage - 1) * LEADERBOARD_PER_PAGE;
      const end = start + LEADERBOARD_PER_PAGE;
      const pageData = leaderboardData.slice(start, end);
      
      el.leaderboardBody.innerHTML = pageData.map((winner) => {
        const isYou = state.user && winner.username === state.user.username;
        const classes = ['winning', isYou ? 'you' : ''].filter(Boolean).join(' ');
        
        return `
          <tr class="${classes}">
            <td>🏆 #${winner.itemNumber}</td>
            <td>${escapeHtml(winner.username)}${isYou ? ' ' + t('leaderboard.you') : ''}</td>
            <td>${winner.amount} ⭐</td>
          </tr>
        `;
      }).join('');
      
      updateLeaderboardPagination();
    } else {
      renderLeaderboardPage();
    }
  }
}

function renderWinners(winners) {
  console.log('renderWinners called with:', winners);
  
  if (!winners || !winners.length) {
    console.warn('No winners to display');
    el.leaderboardBody.innerHTML = `<tr><td colspan="3">${t('leaderboard.no_winners')}</td></tr>`;
    el.leaderboardPagination?.classList.add('hidden');
    return;
  }

  console.log('Rendering', winners.length, 'winners');
  
  // Сохраняем победителей для пагинации
  leaderboardData = winners.map((w, idx) => ({
    position: idx + 1,
    username: w.username,
    amount: w.amount,
    itemNumber: w.itemNumber,
  }));
  
  leaderboardTotalPages = Math.ceil(winners.length / LEADERBOARD_PER_PAGE);
  leaderboardPage = 1;
  
  // Показываем первую страницу
  const start = 0;
  const end = LEADERBOARD_PER_PAGE;
  const pageWinners = winners.slice(start, end);
  
  el.leaderboardBody.innerHTML = pageWinners.map((winner) => {
    const isYou = state.user && winner.username === state.user.username;
    const classes = ['winning', isYou ? 'you' : ''].filter(Boolean).join(' ');
    
    return `
      <tr class="${classes}">
        <td>🏆 #${winner.itemNumber}</td>
        <td>${escapeHtml(winner.username)}${isYou ? ' ' + t('leaderboard.you') : ''}</td>
        <td>${winner.amount} ⭐</td>
      </tr>
    `;
  }).join('');
  
  // Показываем пагинацию если нужно
  updateLeaderboardPagination();
}

/**
 * Обновление статуса пользователя из данных лидерборда
 * БЕЗ HTTP ЗАПРОСОВ — всё вычисляется из WebSocket данных!
 */
function updateUserStatusFromLeaderboard() {
  if (!state.user || !leaderboardData.length) {
    el.yourBid.textContent = t('auction.not_placed');
    el.yourPosition.textContent = '—';
    return;
  }

  // Находим ставку пользователя в лидерборде
  const userBid = leaderboardData.find(b => b.oduserId === state.user.id);
  
  if (userBid) {
    el.yourBid.textContent = `${userBid.amount} ⭐`;
    el.yourPosition.textContent = `#${userBid.position} / ${leaderboardData.length}`;
  } else {
    el.yourBid.textContent = t('auction.not_placed');
    el.yourPosition.textContent = '—';
  }
}

function startTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);

  state.timerInterval = setInterval(() => {
    if (!state.currentAuction || state.currentAuction.status !== 'active') {
      el.auctionTime.textContent = '—';
      return;
    }

    const remaining = state.currentAuction.roundEndTime - Date.now();
    el.auctionTime.textContent = formatTime(remaining);

    if (remaining <= 0) {
      loadAuctionDetail(state.currentAuction.id);
    }
  }, 1000);
}

function startLeaderboardAutoRefresh() {
  stopLeaderboardAutoRefresh();
  
  // Backup polling раз в 10 секунд (основные обновления через WebSocket push)
  state.leaderboardInterval = setInterval(async () => {
    if (state.currentAuction && state.currentAuction.status === 'active') {
      // Запрашиваем лидерборд через WS (сервер отправит push)
      if (state.socket?.connected) {
        state.socket.emit('auction:subscribe_leaderboard', state.currentAuction.id);
      } else {
        // Fallback на HTTP если WS отключён
        await loadLeaderboard(state.currentAuction.id);
      }
    }
  }, 10000);
}

function stopLeaderboardAutoRefresh() {
  if (state.leaderboardInterval) {
    clearInterval(state.leaderboardInterval);
    state.leaderboardInterval = null;
  }
}

async function refreshLeaderboard() {
  if (!state.currentAuction) return;
  
  el.refreshLeaderboardBtn.disabled = true;
  el.refreshLeaderboardBtn.textContent = '⏳';
  
  try {
    await loadLeaderboard(state.currentAuction.id, false); // не сбрасывать страницу
    // Статус обновляется автоматически из лидерборда
  } finally {
    el.refreshLeaderboardBtn.disabled = false;
    el.refreshLeaderboardBtn.textContent = '↻';
  }
}

async function handlePlaceBid() {
  const amount = parseInt(el.bidAmount.value);
  
  if (!amount || amount <= 0) {
    notify(t('error.invalid_amount'), 'error');
    return;
  }

  try {
    el.placeBidBtn.disabled = true;
    const result = await api.placeBid(state.currentAuction.id, state.user.id, amount);
    
    el.bidAmount.value = '';
    
    // Обновляем баланс (статус придёт через WebSocket лидерборд)
    updateBalance();

    const msg = result.data.isNewBid
      ? t('auction.bid_placed', { amount })
      : t('auction.bid_raised', { amount });
    
    notify(result.data.roundExtended ? msg + t('auction.time_extended') : msg, 'success');
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    el.placeBidBtn.disabled = false;
  }
}

// Быстрая ставка — перебить лидера
async function handleOutbid() {
  if (!state.user || !state.currentAuction) return;
  
  try {
    el.quickBidOutbid.disabled = true;
    
    const result = await api.quickBid(state.currentAuction.id, state.user.id, 'outbid');
    
    // Обновляем баланс (статус придёт через WebSocket лидерборд)
    updateBalance();
    
    const amount = result.data.bid.amount;
    notify(result.data.roundExtended 
      ? t('auction.bid_raised', { amount }) + ' ' + t('auction.time_extended') 
      : t('auction.bid_raised', { amount }), 'success');
  } catch (err) {
    notify(err.message, 'error');
  } finally {
    el.quickBidOutbid.disabled = false;
  }
}

function backToList() {
  if (state.socket && state.currentAuction) {
    state.socket.emit('auction:leave', state.currentAuction.id);
  }
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  stopLeaderboardAutoRefresh();
  
  state.currentAuction = null;
  showSection(el.auctionsSection);
  loadAuctions();
  updateBalance();
}

// =====================
// СОЗДАНИЕ АУКЦИОНА
// =====================

function openCreateForm() {
  showSection(el.createAuctionSection);
}

function addRoundRow() {
  const row = document.createElement('div');
  row.className = 'round-row';
  row.innerHTML = `
    <span>${t('create.round_items')}</span>
    <input type="number" class="round-items" value="3" min="1">
    <span>${t('create.round_duration')}</span>
    <input type="number" class="round-duration" value="60" min="30">
    <button type="button" class="btn-remove" onclick="this.parentElement.remove()">${t('create.remove_round')}</button>
  `;
  el.roundsConfig.appendChild(row);
}

async function handleCreateAuction(e) {
  e.preventDefault();

  const roundItems = el.roundsConfig.querySelectorAll('.round-items');
  const roundDurations = el.roundsConfig.querySelectorAll('.round-duration');
  
  const roundsConfig = [];
  roundItems.forEach((input, i) => {
    const items = parseInt(input.value);
    const duration = parseInt(roundDurations[i].value) * 1000;
    if (items > 0 && duration > 0) {
      roundsConfig.push({ itemsToDistribute: items, durationMs: duration });
    }
  });

  const totalItems = parseInt($('total-items').value);
  const roundsSum = roundsConfig.reduce((sum, r) => sum + r.itemsToDistribute, 0);

  if (roundsSum !== totalItems) {
    notify(t('create.items_mismatch', { sum: roundsSum, total: totalItems }), 'error');
    return;
  }

  // Опции симуляции ботов (количество = 3x товаров)
  const enableBotSimulation = el.enableBotSimulation?.checked || false;
  const botCount = Math.max(5, totalItems * 3); // Минимум 5, или 3x от товаров

  const data = {
    title: $('auction-title').value,
    description: $('auction-desc').value,
    totalItems,
    startingPrice: parseInt($('starting-price').value),
    roundsConfig,
    startTime: new Date().toISOString(),
    createdBy: state.user.id,
  };

  try {
    const result = await api.createAuction(data);
    
    // Запускаем с опциями ботов
    await api.startAuction(result.data.id, { 
      enableBotSimulation, 
      botCount 
    });
    
    showSection(el.auctionsSection);
    loadAuctions();
    
    if (enableBotSimulation) {
      notify(t('create.success') + ' Боты активированы!', 'success');
    } else {
    notify(t('create.success'), 'success');
    }
  } catch (err) {
    notify(err.message || t('create.error'), 'error');
  }
}

// =====================
// WEBSOCKET
// =====================

function initSocket() {
  state.socket = io({ transports: ['websocket', 'polling'] });

  state.socket.on('connect', () => {
    console.log('WS connected');
    // Автоматически подписываемся на лобби
    state.socket.emit('lobby:join');
  });
  
  state.socket.on('disconnect', () => console.log('WS disconnected'));

  // Лобби: новый аукцион появился (добавляем мгновенно без запроса)
  state.socket.on('lobby:new_auction', (data) => {
    if (el.auctionsSection.classList.contains('hidden')) return;
    prependAuction(data.auction);
    notify(t('auctions.new_auction') || 'Новый аукцион!', 'info');
  });

  // Лобби: статус аукциона изменился
  state.socket.on('lobby:auction_status', (data) => {
    if (el.auctionsSection.classList.contains('hidden')) return;
    updateAuctionCard(data.auction);
  });

  // Лобби: список аукционов обновился (fallback)
  state.socket.on('lobby:auctions_updated', (data) => {
    if (el.auctionsSection.classList.contains('hidden')) return;
    renderAuctionsList(data.auctions);
  });

  state.socket.on('auction:event', (event) => {
    if (state.currentAuction && event.auctionId === state.currentAuction.id) {
      handleAuctionEvent(event);
    }
  });

  // Push-обновление ставки (моментальное)
  state.socket.on('auction:new_bid', (data) => {
    if (state.currentAuction && data.auctionId === state.currentAuction.id) {
      el.minWinningBid.textContent = `${data.minWinningBid} ⭐`;
      // Не делаем loadLeaderboard — ждём push от сервера
    }
  });

  // Push-обновление лидерборда — МГНОВЕННОЕ для real-time
  state.socket.on('auction:leaderboard', (data) => {
    if (state.currentAuction && data.auctionId === state.currentAuction.id) {
      // Игнорируем для завершённых аукционов (там показываем победителей)
      if (state.currentAuction.status === 'completed') {
        return;
      }
      
      // Обновляем данные лидерборда (включая oduserId для поиска своей позиции)
      leaderboardData = data.leaderboard.map(b => ({
        position: b.position,
        username: b.username,
        amount: b.amount,
        status: b.status,
        oduserId: b.oduserId,  // ID пользователя для поиска своей позиции
      }));
      leaderboardTotalPages = Math.ceil(leaderboardData.length / LEADERBOARD_PER_PAGE);
      
      // Рендерим мгновенно
      renderLeaderboardPage();
      
      // Обновляем статус пользователя из лидерборда (БЕЗ HTTP!)
      updateUserStatusFromLeaderboard();
    }
  });

  state.socket.on('auction:time_extended', (data) => {
    if (state.currentAuction && data.auctionId === state.currentAuction.id) {
      notify(t('event.round_ending') + t('auction.time_extended'), 'info');
      state.currentAuction.roundEndTime = new Date(data.newEndTime).getTime();
      
      // Обновляем счётчик продлений
      if (data.extensionCount !== undefined) {
        el.auctionExtensions.textContent = data.extensionCount;
      }
    }
  });
}

function handleAuctionEvent(event) {
  switch (event.type) {
    case 'round_started':
      notify(t('event.round_started', { n: event.roundNumber + 1 }), 'success');
      loadAuctionDetail(state.currentAuction.id);
      break;
    case 'round_ending_soon':
      notify(t('event.round_ending'), 'warning');
      break;
    case 'round_ended':
      notify(t('event.round_ended', { count: event.data?.winnersCount || 0 }), 'info');
      loadAuctionDetail(state.currentAuction.id);
      updateBalance();
      break;
    case 'auction_completed':
      notify(t('event.auction_completed'), 'success');
      // Загружаем детали и явно перезагружаем лидерборд как победителей
      loadAuctionDetail(state.currentAuction.id).then(() => {
        loadLeaderboard(state.currentAuction.id, true);
      });
      updateBalance();
      break;
  }
}

// =====================
// УТИЛИТЫ
// =====================

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// =====================
// СМЕНА ЯЗЫКА
// =====================

async function handleLanguageChange() {
  const locale = el.langSelect.value;
  await I18n.setLocale(locale);
  
  // Перерисовать динамический контент
  if (state.currentAuction) {
    loadAuctionDetail(state.currentAuction.id);
  } else if (state.user) {
    loadAuctions();
  }
}

// =====================
// ИНИЦИАЛИЗАЦИЯ
// =====================

async function init() {
  try {
  // Загрузить переводы из API
  await I18n.init();
  el.langSelect.value = I18n.currentLocale;
  } catch (err) {
    console.warn('Не удалось загрузить переводы:', err);
  }
  
  // Слушатели
  el.loginForm?.addEventListener('submit', handleLogin);
  el.logoutBtn?.addEventListener('click', handleLogout);
  el.depositBtn?.addEventListener('click', handleDeposit);
  el.historyBtn?.addEventListener('click', showHistory);
  el.historyBackBtn?.addEventListener('click', hideHistory);
  el.historyPrev?.addEventListener('click', () => loadHistory(historyPage - 1));
  el.historyNext?.addEventListener('click', () => loadHistory(historyPage + 1));
  el.itemsBtn?.addEventListener('click', showItems);
  el.itemsBackBtn?.addEventListener('click', hideItems);
  el.itemsPrev?.addEventListener('click', () => loadItems(itemsPage - 1));
  el.itemsNext?.addEventListener('click', () => loadItems(itemsPage + 1));
  el.auctionsPrev?.addEventListener('click', () => loadAuctions(auctionsPage - 1));
  el.auctionsNext?.addEventListener('click', () => loadAuctions(auctionsPage + 1));
  el.refreshAuctionsBtn?.addEventListener('click', refreshAuctions);
  el.createAuctionBtn?.addEventListener('click', openCreateForm);
  el.cancelCreateBtn?.addEventListener('click', backToList);
  el.backBtn?.addEventListener('click', backToList);
  el.placeBidBtn?.addEventListener('click', handlePlaceBid);
  el.quickBidOutbid?.addEventListener('click', handleOutbid);
  el.refreshLeaderboardBtn?.addEventListener('click', refreshLeaderboard);
  el.leaderboardPrev?.addEventListener('click', () => changeLeaderboardPage(-1));
  el.leaderboardNext?.addEventListener('click', () => changeLeaderboardPage(1));
  el.addRoundBtn?.addEventListener('click', addRoundRow);
  el.createAuctionForm?.addEventListener('submit', handleCreateAuction);
  el.langSelect?.addEventListener('change', handleLanguageChange);
  
  el.bidAmount?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handlePlaceBid();
  });
  
  el.depositAmount?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleDeposit();
  });
  
  // Проверить авторизацию (показать форму входа если не авторизован)
  await checkAuth();
}

init().catch(err => {
  console.error('Ошибка инициализации:', err);
  // Показать форму входа если что-то пошло не так
  el.authSection?.classList.remove('hidden');
});
