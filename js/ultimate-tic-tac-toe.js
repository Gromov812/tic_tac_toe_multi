'use strict';

const $ = (selector) => document.querySelector(selector);
const boardEl = $('#board');
const wins = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
const emptyBoards = () => Array.from({ length: 9 }, () => Array(9).fill(null));
const playerKey = 'gridbound-profile';

let profile = JSON.parse(localStorage.getItem(playerKey) || '{"name":"Игрок","rating":1200}');
if (!profile.playerId) { profile.playerId = globalThis.crypto?.randomUUID?.() || `player-${Date.now()}-${Math.random().toString(36).slice(2)}`; localStorage.setItem(playerKey, JSON.stringify(profile)); }
let boards = emptyBoards();
let boardWinners = Array(9).fill(null);
let currentBoard = null;
let turn = 'X';
let gameOver = false;
let mode = 'ai';
let difficulty = 'medium';
let playerSide = 'X';
let roomCode = '';
let ready = true;
let history = [];
let socket = null;
let socketConnected = false;
let aiTimer = null;
let scores = { X: 0, O: 0 };
let chatScope = 'room';
const chatMessages = { room: [], global: [] };
const sounds = { notice: new Audio('./js/1.mp3'), start: new Audio('./js/3.mp3') };
const socialInbox = [];
let onlineUsers = [];
let onlineTab = 'all';

function saveProfile() { localStorage.setItem(playerKey, JSON.stringify(profile)); }
function initials(name) { return (name || 'И').trim().slice(0, 1).toUpperCase(); }
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]); }
function paintProfile() {
  const first = initials(profile.name);
  [['#profile-name', profile.name], ['#online-name', profile.name], ['#online-user-name', profile.name], ['#profile-avatar', first], ['#online-avatar', first], ['#rating-value', profile.rating], ['#profile-rating', `${profile.rating} рейтинга`]].forEach(([selector, value]) => { const element = $(selector); if (element) element.textContent = value; });
  const progress = $('#rating-progress'); if (progress) progress.style.width = `${Math.max(8, Math.min(100, ((profile.rating - 800) % 400) / 4))}%`;
}
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600); }
function playSound(name) { const sound = sounds[name]; if (!sound) return; sound.currentTime = 0; sound.play().catch(() => {}); }
function setConnection(connected, label = connected ? 'Сервер подключен' : 'Офлайн режим') { socketConnected = connected; $('#connection-dot').classList.toggle('online', connected); $('#connection-label').textContent = label; }
function setMode(nextMode) {
  mode = nextMode;
  $('#mode-label').textContent = mode === 'online' ? 'ONLINE MATCH' : 'PRACTICE MATCH';
  $('#score-o-name').textContent = mode === 'online' ? 'Соперник' : 'Компьютер';
}
function checkWin(cells) { return wins.some(line => line.every(index => cells[index])); }
function hasPlayerWon(cells, player) { return wins.some(line => line.every(index => cells[index] === player)); }
function isFull(cells) { return cells.every(Boolean); }
function availableBoards() { return boardWinners.map((winner, index) => winner || isFull(boards[index]) ? null : index).filter(index => index !== null); }
function availableCells(boardIndex) { return boards[boardIndex].map((value, index) => value ? null : index).filter(index => index !== null); }

function render() {
  boardEl.innerHTML = '';
  for (let boardIndex = 0; boardIndex < 9; boardIndex += 1) {
    const small = document.createElement('div');
    const winner = boardWinners[boardIndex];
    small.className = `small-board ${winner ? `won-${winner.toLowerCase()}` : ''} ${isFull(boards[boardIndex]) && !winner ? 'drawn' : ''} ${currentBoard === null || currentBoard === boardIndex ? 'active' : ''}`;
    small.dataset.winner = winner || '';
    small.setAttribute('role', 'group');
    small.setAttribute('aria-label', `Малое поле ${boardIndex + 1}${winner ? `, выиграл ${winner}` : ''}`);
    for (let cellIndex = 0; cellIndex < 9; cellIndex += 1) {
      const cell = document.createElement('button');
      const value = boards[boardIndex][cellIndex];
      cell.className = `cell ${value ? value.toLowerCase() : ''}`;
      cell.textContent = value || '';
      cell.type = 'button';
      cell.dataset.board = boardIndex;
      cell.dataset.cell = cellIndex;
      cell.disabled = Boolean(value || winner || gameOver || (currentBoard !== null && currentBoard !== boardIndex) || (mode === 'ai' && turn === 'O') || (mode === 'online' && turn !== playerSide));
      cell.setAttribute('aria-label', value ? `Поле ${boardIndex + 1}, клетка ${cellIndex + 1}: ${value}` : `Поле ${boardIndex + 1}, клетка ${cellIndex + 1}`);
      cell.addEventListener('click', () => makeMove(boardIndex, cellIndex));
      small.appendChild(cell);
    }
    boardEl.appendChild(small);
  }
  $('#turn-symbol').textContent = turn;
  $('#turn-symbol').className = `turn-symbol ${turn === 'O' ? 'o-color' : ''}`;
  $('#turn-label').textContent = mode === 'ai' && turn === 'O' ? 'Компьютер думает' : turn === 'X' ? 'Вы' : 'Соперник';
  $('#turn-hint').textContent = gameOver ? 'Партия завершена' : currentBoard === null ? 'Выберите любое малое поле' : `Играйте в поле ${currentBoard + 1}`;
  $('#score-x').textContent = scores.X; $('#score-o').textContent = scores.O;
}

function snapshot() { return { boards: boards.map(row => [...row]), boardWinners: [...boardWinners], currentBoard, turn, gameOver, scores: { ...scores } }; }
function restore(state) { boards = state.boards.map(row => [...row]); boardWinners = [...state.boardWinners]; currentBoard = state.currentBoard; turn = state.turn; gameOver = state.gameOver; scores = { ...state.scores }; render(); }
function chooseNextBoard(cellIndex) { return boardWinners[cellIndex] || isFull(boards[cellIndex]) ? null : cellIndex; }
function updateBoardWinner(boardIndex) { if (hasPlayerWon(boards[boardIndex], turn)) boardWinners[boardIndex] = turn; else if (isFull(boards[boardIndex])) boardWinners[boardIndex] = 'D'; }
function finishGame(winner) {
  gameOver = true;
  const won = winner === playerSide;
  if (winner) { scores[winner] += 1; resultRating(won); } else resultRating(null);
  showResult(winner);
  if (mode === 'online' && socket) socket.emit('game_result', { winner: winner || 'draw' });
  render();
}
function makeMove(boardIndex, cellIndex, remote = false) {
  if (gameOver || boards[boardIndex][cellIndex] || boardWinners[boardIndex] || (currentBoard !== null && currentBoard !== boardIndex)) return;
  if (!remote && ((mode === 'ai' && turn === 'O') || (mode === 'online' && turn !== 'X'))) return;
  history.push(snapshot()); boards[boardIndex][cellIndex] = turn;
  updateBoardWinner(boardIndex);
  const globalWinner = hasPlayerWon(boardWinners, turn);
  if (globalWinner || availableBoards().length === 0) { finishGame(globalWinner ? turn : null); } else { currentBoard = chooseNextBoard(cellIndex); turn = turn === 'X' ? 'O' : 'X'; render(); }
  if (mode === 'online' && !remote && socket) socket.emit('move', JSON.stringify(toLegacyData()));
  if (mode === 'ai' && turn === 'O' && !gameOver) { clearTimeout(aiTimer); aiTimer = setTimeout(aiMove, difficulty === 'easy' ? 350 : 600); }
}
function resultRating(won) { const delta = mode === 'online' ? (won === null ? 3 : won ? 24 : -18) : (won === null ? 0 : won ? 8 : -4); profile.rating = Math.max(800, profile.rating + delta); saveProfile(); paintProfile(); $('#rating-value').textContent = profile.rating; $('.trend').textContent = `${delta > 0 ? '+' : ''}${delta}`; return delta; }
function showResult(winner) {
  const dialog = $('#result-dialog'); const won = winner === playerSide; const draw = !winner;
  dialog.className = `result-dialog ${draw ? 'draw' : won ? '' : 'loss'}`;
  $('#result-symbol').textContent = draw ? '—' : won ? 'X' : 'O';
  $('#result-kicker').textContent = draw ? 'MATCH DRAW' : won ? 'VICTORY' : 'MATCH LOST';
  $('#result-title').textContent = draw ? 'Ничья' : won ? 'Победа' : 'Поражение';
  $('#result-message').textContent = draw ? 'Оба игрока дошли до предела поля.' : won ? 'Вы забрали большую линию. Отличная партия.' : 'Соперник собрал линию первым. Реванш рядом.';
  const delta = mode === 'online' ? (draw ? 3 : won ? 24 : -18) : (draw ? 0 : won ? 8 : -4);
  $('#result-rating').textContent = `${delta > 0 ? '+' : ''}${delta} рейтинга`;
  dialog.showModal();
}

function aiMove() {
  const options = currentBoard === null ? availableBoards() : [currentBoard];
  const boardIndex = options[Math.floor(Math.random() * options.length)];
  if (boardIndex === undefined) return;
  const cells = availableCells(boardIndex);
  let cellIndex = cells[Math.floor(Math.random() * cells.length)];
  if (difficulty !== 'easy') {
    const winning = cells.find(index => { boards[boardIndex][index] = 'O'; const yes = hasPlayerWon(boards[boardIndex], 'O'); boards[boardIndex][index] = null; return yes; });
    const blocking = cells.find(index => { boards[boardIndex][index] = 'X'; const yes = hasPlayerWon(boards[boardIndex], 'X'); boards[boardIndex][index] = null; return yes; });
    cellIndex = winning ?? blocking ?? (cells.includes(4) ? 4 : cellIndex);
  }
  makeMove(boardIndex, cellIndex, true);
}

function newGame() { clearTimeout(aiTimer); boards = emptyBoards(); boardWinners = Array(9).fill(null); currentBoard = null; turn = 'X'; gameOver = false; history = []; scores = { X: 0, O: 0 }; render(); showToast(mode === 'online' ? 'Новая онлайн-партия готова' : 'Новая тренировочная партия'); }
function toLegacyData() {
  const zero = {}, iX = {};
  for (let i = 0; i < 9; i += 1) { zero[i] = { comb: boards[i].map((v, n) => v === 'O' ? n : null).filter(n => n !== null), counter: boards[i].filter(v => v === 'O').length, winner: boardWinners[i] === 'O' }; iX[i] = { comb: boards[i].map((v, n) => v === 'X' ? n : null).filter(n => n !== null), counter: boards[i].filter(v => v === 'X').length, winner: boardWinners[i] === 'X' }; }
  return { zero, iX, moves: [boardWinners.map((v, i) => v === 'X' ? i : null).filter(i => i !== null), boardWinners.map((v, i) => v === 'O' ? i : null).filter(i => i !== null)], nextField: currentBoard, firstMove: currentBoard === null, score: [scores.X, scores.O], counter: turn === 'X' ? 0 : 1 };
}
function applyLegacy(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  boards = emptyBoards(); boardWinners = Array(9).fill(null);
  for (let i = 0; i < 9; i += 1) { (data.iX?.[i]?.comb || []).forEach(index => boards[i][index] = 'X'); (data.zero?.[i]?.comb || []).forEach(index => boards[i][index] = 'O'); if (data.iX?.[i]?.winner) boardWinners[i] = 'X'; if (data.zero?.[i]?.winner) boardWinners[i] = 'O'; }
  currentBoard = data.nextField ?? null; scores = { X: data.score?.[0] || 0, O: data.score?.[1] || 0 }; turn = data.counter % 2 ? 'O' : 'X'; render();
}
function updateOnlineUsers(users) {
  const payload = Array.isArray(users) ? { users } : users;
  if (!Array.isArray(payload?.users)) return;
  onlineUsers = payload.users;
  renderOnlineUsers();
}
function renderOnlineUsers() {
  const list = $('#online-users');
  const friends = onlineUsers.filter(user => user.isFriend);
  const visibleUsers = onlineTab === 'friends' ? onlineUsers.filter(user => user.isSelf || user.isFriend) : onlineUsers;
  $('#online-count').textContent = onlineUsers.length;
  $('#online-tab-count').textContent = onlineUsers.length;
  $('#friends-tab-count').textContent = friends.length;
  if (!visibleUsers.length) { list.innerHTML = '<p class="friends-empty">Пока нет друзей онлайн</p>'; return; }
  list.innerHTML = visibleUsers.map(user => {
    const name = typeof user === 'string' ? user : (user.name || user.id || 'Игрок');
    const rating = typeof user === 'object' && user.rating ? user.rating : '—';
    const readyLabel = typeof user === 'object' && user.ready ? 'Готов играть' : 'В лобби';
    const id = typeof user === 'object' ? user.id : '';
    const self = user.isSelf || socket?.id === id;
    const status = self ? '<span class="self-mark">(Я)</span>' : user.isFriend ? '<small class="friend-status">В друзьях</small>' : '';
    const friendAction = user.isFriend ? 'friend-remove' : 'friend';
    const friendLabel = user.isFriend ? 'Убрать из друзей' : user.friendStatus === 'pending' ? 'Заявка отправлена' : 'В друзья';
    const friendButton = self ? '' : `<button type="button" class="user-action" data-social="${friendAction}" data-user-id="${escapeHtml(id)}" ${user.friendStatus === 'pending' ? 'disabled' : ''}>${friendLabel}</button>`;
    const actions = self ? '' : `<span class="user-actions">${friendButton}<button type="button" class="user-action" data-social="invite" data-user-id="${escapeHtml(id)}" title="Пригласить в игру">Играть</button></span>`;
    return `<div class="compact-user"><span class="avatar avatar-x">${escapeHtml(initials(name))}</span><span class="user-info"><b>${escapeHtml(name)}${status}</b><small>${readyLabel}</small></span><span class="user-rating">${escapeHtml(rating)}</span>${actions}</div>`;
  }).join('');
}
function addChatMessage(payload) {
  const message = typeof payload === 'string' ? { name: 'Игрок', text: payload } : payload;
  const scope = message.scope === 'global' ? 'global' : 'room';
  chatMessages[scope].push(message);
  if (chatMessages[scope].length > 20) chatMessages[scope].shift();
  if (scope !== chatScope) return;
  renderChat();
}
function renderChat() {
  const list = $('#chat-messages'); const empty = $('#chat-empty'); if (empty) empty.remove();
  list.innerHTML = '';
  const messages = chatMessages[chatScope];
  if (!messages.length) { list.innerHTML = '<p class="chat-empty" id="chat-empty">Напишите первое сообщение</p>'; return; }
  messages.forEach(message => { const item = document.createElement('div'); item.className = 'chat-message'; const date = new Date(message.at || Date.now()); item.innerHTML = `<b>${escapeHtml(message.name || 'Игрок')}</b><time>${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time><p></p>`; item.querySelector('p').textContent = message.text || message.message || ''; list.appendChild(item); });
  list.scrollTop = list.scrollHeight;
}
function renderSocialInbox() {
  const list = $('#social-inbox'); const badge = $('#inbox-badge');
  badge.textContent = socialInbox.length; badge.hidden = socialInbox.length === 0;
  if (!socialInbox.length) { list.innerHTML = '<p class="social-empty">Новых запросов нет</p>'; return; }
  list.innerHTML = socialInbox.map((item, index) => { const game = item.type === 'game'; const name = escapeHtml(item.from?.name || 'Игрок'); return `<article class="social-item ${game ? 'game' : 'friend'}"><span class="avatar ${game ? 'avatar-x' : ''}">${escapeHtml(initials(item.from?.name))}</span><div><b>${game ? 'Приглашение в игру' : 'Запрос в друзья'}</b><p>${game ? `${name} зовёт вас сыграть` : `${name} хочет добавить вас в друзья`}</p><div class="social-actions"><button type="button" class="${game ? 'join' : 'accept'}" data-inbox-action="accept" data-inbox-index="${index}">${game ? 'Принять и играть' : 'Принять'}</button><button type="button" data-inbox-action="decline" data-inbox-index="${index}">Скрыть</button></div></div></article>`; }).join('');
}
function addSocialItem(item) { socialInbox.push(item); renderSocialInbox(); playSound('notice'); showToast(item.type === 'game' ? 'Новое приглашение в игру' : 'Новый запрос в друзья'); }

function setupSocket() {
  if (typeof io !== 'function') { setConnection(false); return; }
  try { socket = io('https://db.timesy.ru:3111', { timeout: 5000 }); } catch { setConnection(false); return; }
  socket.on('connect', () => { setConnection(true); $('#online-count').textContent = '1'; socket.emit('profile_update', profile); socket.emit('chat_history', { scope: 'global' }); if (roomCode) socket.emit('chat_history', { scope: 'room' }); showToast('Соединение с сервером установлено'); });
  socket.on('connect_error', () => setConnection(false));
  socket.on('joined_success', () => { $('#room-status').textContent = 'Вы присоединились к комнате'; socket.emit('chat_history', { scope: 'room' }); showToast('Вы в комнате'); });
  socket.on('joined', () => { $('#opponent-name').textContent = 'Соперник'; $('#opponent-status').textContent = 'Подключен и готовится'; $('#opponent-ready').textContent = 'Готов'; $('#opponent-ready').classList.add('ready'); $('#player-count').textContent = '2 / 2'; $('#online-count').textContent = '2'; render(); showToast('Соперник присоединился'); });
  socket.on('opponent_move', data => { applyLegacy(data); });
  ['users', 'online_users', 'server_users', 'players'].forEach(eventName => socket.on(eventName, updateOnlineUsers));
  socket.on('room_created', data => { roomCode = data.code; $('#room-code').textContent = roomCode; if (data.auto) { mode = 'online'; playerSide = 'X'; setMode(mode); $('#room-status').textContent = 'Комната создана для приглашения'; } });
  socket.on('room_error', data => showToast(data.message || 'Не удалось войти в комнату'));
  socket.on('rating_update', data => { profile.rating = data.rating; saveProfile(); paintProfile(); });
  socket.on('chat message', addChatMessage);
  socket.on('chat_history', data => { if (!data?.scope || !Array.isArray(data.messages)) return; chatMessages[data.scope] = data.messages.slice(-20); if (data.scope === chatScope) renderChat(); });
  socket.on('social_notice', data => showToast(data.message));
  socket.on('social_error', data => showToast(data.message || 'Действие недоступно'));
  socket.on('social_inbox', data => { (data?.items || []).forEach(item => socialInbox.push(item)); renderSocialInbox(); if (data?.items?.length) playSound('notice'); });
  socket.on('friend_request_received', data => addSocialItem({ ...data, type: 'friend' }));
  socket.on('game_invite_received', data => addSocialItem({ ...data, type: 'game' }));
  socket.on('friend_request_accepted', data => showToast(`${data.by?.name || 'Игрок'} принял вашу заявку`));
  socket.on('game_invite_accepted', data => { mode = 'online'; playerSide = 'O'; roomCode = data.room; setMode(mode); $('#room-code').textContent = roomCode; $('#room-status').textContent = 'Соперник принял приглашение'; render(); });
  socket.on('room_state', data => { if (data.code) { roomCode = data.code; $('#room-code').textContent = data.code; } if (data.players?.length) { $('#player-count').textContent = `${data.players.length} / 2`; const opponent = data.players.find(player => player.id !== socket.id); if (opponent) { $('#opponent-name').textContent = opponent.name; $('#opponent-status').textContent = opponent.ready ? 'Готов играть' : 'В лобби'; $('#opponent-ready').textContent = opponent.ready ? 'Готов' : 'Не готов'; } } });
  socket.on('match_started', () => { $('#room-status').textContent = 'Оба игрока готовы. Игра началась'; $('#turn-bar').classList.add('match-started'); setTimeout(() => $('#turn-bar').classList.remove('match-started'), 900); playSound('start'); showToast('Новая игра началась'); });
  const disconnected = () => { $('#opponent-name').textContent = 'Ожидание соперника'; $('#opponent-status').textContent = 'Соперник вышел из комнаты'; $('#player-count').textContent = '1 / 2'; $('#online-count').textContent = '1'; showToast('Соперник покинул игру'); };
  socket.on('game_disconnected', disconnected); socket.on('game_disconnetcted', disconnected);
}
function createRoom() { mode = 'online'; playerSide = 'X'; setMode(mode); roomCode = Math.random().toString(36).slice(2, 8).toUpperCase(); $('#room-code').textContent = roomCode; $('#room-status').textContent = 'Ожидание второго игрока'; $('#opponent-row').classList.add('waiting-player'); if (socket) { socket.emit('create_game'); socket.emit('player_ready', { ready: true }); } showToast('Комната создана. Отправьте код другу.'); }
function joinRoom(code) { if (!code) { showToast('Введите код комнаты'); return; } mode = 'online'; playerSide = 'O'; setMode(mode); roomCode = code.toUpperCase(); $('#room-code').textContent = roomCode; $('#room-status').textContent = 'Подключение к комнате'; if (socket) { socket.emit('join_game', roomCode); socket.emit('player_ready', { ready: true }); } turn = 'X'; render(); }

$('#new-game-button').addEventListener('click', newGame);
$('#undo-button').addEventListener('click', () => { if (mode === 'online' || !history.length) return; restore(history.pop()); showToast('Последний ход отменён'); });
$('#create-room').addEventListener('click', createRoom);
$('#join-room').addEventListener('click', () => { $('#room-input-wrap').hidden = !$('#room-input-wrap').hidden; if (!$('#room-input-wrap').hidden) $('#room-input').focus(); });
$('#confirm-join').addEventListener('click', () => joinRoom($('#room-input').value.trim()));
$('#copy-room').addEventListener('click', async () => { if (!roomCode) return showToast('Сначала создайте комнату'); try { await navigator.clipboard.writeText(roomCode); showToast('Код скопирован'); } catch { showToast(`Код комнаты: ${roomCode}`); } });
$('#ready-button').addEventListener('click', () => { ready = !ready; $('#ready-button').classList.toggle('not-ready', !ready); $('#ready-label').textContent = ready ? 'Вы готовы' : 'Вы не готовы'; $('#your-ready').textContent = ready ? 'Готов' : 'Не готов'; if (socket) socket.emit('player_ready', { ready }); });
document.querySelectorAll('[data-difficulty]').forEach(button => button.addEventListener('click', () => { difficulty = button.dataset.difficulty; mode = 'ai'; setMode('ai'); document.querySelectorAll('[data-difficulty]').forEach(item => item.classList.toggle('selected', item === button)); showToast(`Компьютер: ${difficulty === 'easy' ? 'легко' : difficulty === 'medium' ? 'средне' : 'сложно'}`); newGame(); }));
$('#profile-button').addEventListener('click', () => { $('#name-input').value = profile.name; $('#profile-dialog').showModal(); });
$('#save-profile').addEventListener('click', () => { const name = $('#name-input').value.trim(); if (name) profile.name = name; saveProfile(); paintProfile(); if (socket) socket.emit('profile_update', profile); showToast('Профиль обновлён'); });
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#result-new-game').addEventListener('click', newGame);
function setChatScope(scope) { chatScope = scope; $('#chat-room-scope').classList.toggle('selected', scope === 'room'); $('#chat-global-scope').classList.toggle('selected', scope === 'global'); $('#chat-status').textContent = scope === 'room' ? 'Только для участников комнаты' : 'Все игроки на сервере'; renderChat(); if (socket) socket.emit('chat_history', { scope }); }
$('#chat-room-scope').addEventListener('click', () => setChatScope('room'));
$('#chat-global-scope').addEventListener('click', () => setChatScope('global'));
$('#chat-form').addEventListener('submit', event => { event.preventDefault(); const input = $('#chat-input'); const text = input.value.trim(); if (!text) return; if (!socket || !socketConnected) return showToast('Чат доступен после подключения к серверу'); socket.emit('chat message', { scope: chatScope, text }); input.value = ''; });
$('#online-users').addEventListener('click', event => { const button = event.target.closest('[data-social]'); if (!button || !socket || button.disabled) return; const events = { friend: 'friend_request', 'friend-remove': 'friend_remove', invite: 'game_invite' }; socket.emit(events[button.dataset.social], button.dataset.userId); });
$('#online-tab').addEventListener('click', () => { onlineTab = 'all'; $('#online-tab').classList.add('selected'); $('#friends-tab').classList.remove('selected'); $('#online-tab').setAttribute('aria-selected', 'true'); $('#friends-tab').setAttribute('aria-selected', 'false'); renderOnlineUsers(); });
$('#friends-tab').addEventListener('click', () => { onlineTab = 'friends'; $('#friends-tab').classList.add('selected'); $('#online-tab').classList.remove('selected'); $('#friends-tab').setAttribute('aria-selected', 'true'); $('#online-tab').setAttribute('aria-selected', 'false'); renderOnlineUsers(); });
$('#social-inbox').addEventListener('click', event => { const button = event.target.closest('[data-inbox-action]'); if (!button) return; const index = Number(button.dataset.inboxIndex); const item = socialInbox[index]; if (!item) return; if (button.dataset.inboxAction === 'accept') { if (item.type === 'friend') socket.emit('friend_request_accept', item.from.id); else socket.emit('game_invite_accept', item.room); } else if (item.type === 'friend') socket.emit('friend_request_decline', item.from.id); else socket.emit('game_invite_decline', item.room); socialInbox.splice(index, 1); renderSocialInbox(); });

paintProfile(); setMode('ai'); render(); setupSocket();
