'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');

const app = express();
app.use(cors({ origin: true }));
app.get('/health', (_request, response) => response.json({ ok: true, service: 'gridbound-server' }));

const port = Number(process.env.PORT || 3111);
const certificateDirectory = process.env.TLS_DIR || '/etc/letsencrypt/live/db.timesy.ru';
const hasCertificate = fs.existsSync(path.join(certificateDirectory, 'privkey.pem')) && fs.existsSync(path.join(certificateDirectory, 'fullchain.pem'));
const baseServer = hasCertificate
  ? https.createServer({
      key: fs.readFileSync(path.join(certificateDirectory, 'privkey.pem')),
      cert: fs.readFileSync(path.join(certificateDirectory, 'fullchain.pem')),
    }, app)
  : http.createServer(app);
const io = new Server(baseServer, { cors: { origin: true, credentials: true } });

const rooms = new Map();
const users = new Map();
const ratings = new Map();
let db = null;

async function initializeDatabase() {
  if (!process.env.DB_HOST || !process.env.DB_NAME) return;
  try {
    db = mysql.createPool({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4' });
    await db.query('SELECT 1');
    console.log('MySQL database connected');
  } catch (error) {
    db = null;
    console.warn(`MySQL disabled: ${error.message}`);
  }
}

async function ensurePlayer(externalId, name = 'Игрок', rating = 1200) {
  if (!db) return null;
  const safeName = String(name || 'Игрок').slice(0, 24);
  await db.execute('INSERT INTO players (external_id, display_name, rating) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name)', [externalId, safeName, rating]);
  const [rows] = await db.execute('SELECT id, rating FROM players WHERE external_id = ?', [externalId]);
  return rows[0] || null;
}

async function saveChatMessage(user, scope, roomCode, text) {
  if (!db || !user?.dbId) return;
  await db.execute('INSERT INTO chat_messages (player_id, scope, room_code, message) VALUES (?, ?, ?, ?)', [user.dbId, scope, scope === 'room' ? roomCode : null, text]);
}

async function sendChatHistory(socket, scope, roomCode) {
  if (!db) return socket.emit('chat_history', { scope, room: roomCode || null, messages: [] });
  const [rows] = scope === 'global'
    ? await db.execute(`SELECT c.message AS text, c.scope, c.created_at AS at, p.display_name AS name FROM chat_messages c JOIN players p ON p.id = c.player_id WHERE c.scope = 'global' ORDER BY c.created_at DESC LIMIT 20`)
    : await db.execute(`SELECT c.message AS text, c.scope, c.room_code AS room, c.created_at AS at, p.display_name AS name FROM chat_messages c JOIN players p ON p.id = c.player_id WHERE c.scope = 'room' AND c.room_code = ? ORDER BY c.created_at DESC LIMIT 20`, [roomCode || '']);
  socket.emit('chat_history', { scope, room: roomCode || null, messages: rows.reverse().map(row => ({ ...row, at: new Date(row.at).getTime() })) });
}

async function createFriendRequest(fromUser, targetSocketId) {
  const target = users.get(targetSocketId);
  if (!db || !fromUser?.dbId || !target?.dbId || targetSocketId === fromUser.socketId) return false;
  await db.execute('INSERT INTO friendships (requester_id, addressee_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE status = IF(status = \'declined\', \'pending\', status)', [fromUser.dbId, target.dbId]);
  return true;
}

async function createGameInvite(fromUser, targetSocketId, roomCode) {
  const target = users.get(targetSocketId);
  if (!db || !fromUser?.dbId || !target?.dbId || !roomCode) return false;
  await db.execute('INSERT INTO game_invites (sender_id, recipient_id, room_code) VALUES (?, ?, ?)', [fromUser.dbId, target.dbId, roomCode]);
  return true;
}

function makeRoomCode() {
  let code;
  do code = Math.random().toString(36).slice(2, 8).toUpperCase(); while (rooms.has(code));
  return code;
}

function publicUser(socketId) {
  const user = users.get(socketId) || {};
  return { id: socketId, name: user.name || 'Игрок', rating: ratings.get(socketId) || 1200, ready: Boolean(user.ready), room: user.room || null };
}

function broadcastUsers() {
  io.emit('online_users', [...users.keys()].map(publicUser));
}

function roomFor(socketId) {
  const user = users.get(socketId);
  return user && user.room ? rooms.get(user.room) : null;
}

function broadcastRoom(room) {
  if (!room) return;
  const players = room.players.map(publicUser);
  room.players.forEach(playerId => io.to(playerId).emit('room_state', {
    code: room.code,
    players,
    ready: players.every(player => player.ready),
    started: room.started,
  }));
  broadcastUsers();
}

async function startMatchRecord(room) {
  if (!db || room.matchId || room.players.length !== 2) return;
  const x = users.get(room.players[0]);
  const o = users.get(room.players[1]);
  if (!x?.dbId || !o?.dbId) return;
  const [result] = await db.execute('INSERT INTO matches (room_code, player_x_id, player_o_id) VALUES (?, ?, ?)', [room.code, x.dbId, o.dbId]);
  room.matchId = result.insertId;
}

async function saveMove(room, socketId, data) {
  if (!db || !room?.matchId) return;
  const user = users.get(socketId);
  if (!user?.dbId) return;
  let state = data;
  try { state = typeof data === 'string' ? JSON.parse(data) : data; } catch { return; }
  const symbol = state.counter % 2 ? 'X' : 'O';
  await db.execute('INSERT INTO game_moves (match_id, player_id, symbol, state_json) VALUES (?, ?, ?, ?)', [room.matchId, user.dbId, symbol, JSON.stringify(state)]);
  await db.execute('UPDATE matches SET moves_count = moves_count + 1 WHERE id = ?', [room.matchId]);
}

async function finishMatchRecord(room, winner) {
  if (!db || !room?.matchId || room.resultSaved) return;
  room.resultSaved = true;
  const result = winner === 'X' ? 'X' : winner === 'O' ? 'O' : 'draw';
  await db.execute('UPDATE matches SET winner = ?, status = \'finished\', finished_at = CURRENT_TIMESTAMP WHERE id = ?', [result, room.matchId]);
  const deltas = result === 'draw' ? [3, 3] : [result === 'X' ? 24 : -18, result === 'O' ? 24 : -18];
  for (let index = 0; index < room.players.length; index += 1) {
    const user = users.get(room.players[index]);
    if (!user?.dbId) continue;
    const won = deltas[index] > 0;
    const draw = result === 'draw';
    await db.execute(`UPDATE players SET rating = GREATEST(800, rating + ?), games_played = games_played + 1, wins = wins + ?, losses = losses + ?, draws = draws + ? WHERE id = ?`, [deltas[index], won && !draw ? 1 : 0, !won && !draw ? 1 : 0, draw ? 1 : 0, user.dbId]);
  }
}

function leaveRoom(socketId, notify = true) {
  const user = users.get(socketId);
  if (!user || !user.room) return;
  const room = rooms.get(user.room);
  if (room) {
    room.players = room.players.filter(playerId => playerId !== socketId);
    room.started = false;
    const opponentId = room.players[0];
    if (notify && opponentId) io.to(opponentId).emit('game_disconnected');
    if (!room.players.length) rooms.delete(room.code);
    else broadcastRoom(room);
  }
  user.room = null;
  user.ready = false;
}

function joinRoom(socket, code) {
  const requestedCode = String(code || '').trim();
  const room = rooms.get(requestedCode.toUpperCase()) || (users.has(requestedCode) ? roomFor(requestedCode) : null);
  if (!room) return socket.emit('room_error', { message: 'Комната не найдена или уже закрыта.' });
  if (room.players.length >= 2 && !room.players.includes(socket.id)) return socket.emit('room_error', { message: 'В комнате уже два игрока.' });
  leaveRoom(socket.id, false);
  if (!room.players.includes(socket.id)) room.players.push(socket.id);
  const user = users.get(socket.id);
  user.room = room.code;
  user.ready = false;
  socket.join(room.code);
  if (room.players.length === 2) {
    room.started = false;
    room.players.forEach(playerId => io.to(playerId).emit('joined', { room: room.code, player: playerId, players: room.players.map(publicUser) }));
  }
  socket.emit('joined_success', { room: room.code });
  broadcastRoom(room);
}

io.on('connection', socket => {
  users.set(socket.id, { socketId: socket.id, name: 'Игрок', room: null, ready: false });
  ratings.set(socket.id, 1200);
  socket.emit('connected_info', { id: socket.id });
  broadcastUsers();

  socket.on('profile_update', profile => {
    const user = users.get(socket.id);
    if (!user) return;
    user.name = String(profile?.name || 'Игрок').slice(0, 24);
    ratings.set(socket.id, Math.max(800, Number(profile?.rating) || ratings.get(socket.id) || 1200));
    user.externalId = String(profile?.playerId || socket.id).slice(0, 128);
    ensurePlayer(user.externalId, user.name, ratings.get(socket.id)).then(player => { if (player) user.dbId = player.id; }).catch(error => console.warn('Could not save player:', error.message));
    broadcastUsers();
    broadcastRoom(roomFor(socket.id));
  });

  socket.on('create_game', () => {
    leaveRoom(socket.id, false);
    const code = makeRoomCode();
    const room = { code, players: [socket.id], started: false };
    rooms.set(code, room);
    const user = users.get(socket.id);
    user.room = code;
    user.ready = false;
    socket.join(code);
    socket.emit('room_created', { code });
    socket.emit('await_player', { code });
    broadcastRoom(room);
  });

  socket.on('join_game', code => joinRoom(socket, code));

  socket.on('player_ready', async payload => {
    const user = users.get(socket.id);
    const room = roomFor(socket.id);
    if (!user || !room) return;
    user.ready = Boolean(payload?.ready);
    if (room.players.length === 2 && room.players.every(playerId => users.get(playerId)?.ready)) {
      room.started = true;
      try { await startMatchRecord(room); } catch (error) { console.warn('Could not create match record:', error.message); }
      room.players.forEach(playerId => io.to(playerId).emit('match_started', { code: room.code }));
    }
    broadcastRoom(room);
  });

  socket.on('move', data => {
    const room = roomFor(socket.id);
    if (!room || room.players.length !== 2 || !room.started) return socket.emit('room_error', { message: 'Оба игрока должны быть готовы.' });
    const opponentId = room.players.find(playerId => playerId !== socket.id);
    if (opponentId) io.to(opponentId).emit('opponent_move', data);
    saveMove(room, socket.id, data).catch(error => console.warn('Could not save move:', error.message));
  });

  socket.on('game_result', payload => {
    const room = roomFor(socket.id);
    if (!room || room.players.length !== 2) return;
    const winnerId = payload?.winner === 'draw' ? null : room.players.find(playerId => playerId === (payload?.winner === 'X' ? room.players[0] : room.players[1]));
    room.players.forEach(playerId => {
      const won = playerId === winnerId;
      const delta = winnerId ? (won ? 24 : -18) : 3;
      ratings.set(playerId, Math.max(800, (ratings.get(playerId) || 1200) + delta));
      io.to(playerId).emit('rating_update', { rating: ratings.get(playerId), delta });
    });
    room.started = false;
    finishMatchRecord(room, payload?.winner).catch(error => console.warn('Could not save match result:', error.message));
    broadcastRoom(room);
  });

  socket.on('chat message', payload => {
    const user = users.get(socket.id);
    const room = user?.room;
    const scope = payload?.scope === 'global' ? 'global' : 'room';
    if (scope === 'room' && !room) return socket.emit('room_error', { message: 'Сначала войдите в комнату.' });
    const text = String(payload?.text || payload?.message || payload || '').trim().slice(0, 240);
    if (!text) return;
    const message = { id: socket.id, name: user.name || 'Игрок', scope, room: scope === 'room' ? room : null, text, at: Date.now() };
    if (scope === 'global') io.emit('chat message', message);
    else io.to(room).emit('chat message', message);
    saveChatMessage(user, scope, room, text).catch(error => console.warn('Could not save chat message:', error.message));
  });
  socket.on('chat_history', payload => {
    const scope = payload?.scope === 'global' ? 'global' : 'room';
    const room = users.get(socket.id)?.room;
    if (scope === 'room' && !room) return socket.emit('chat_history', { scope, room: null, messages: [] });
    sendChatHistory(socket, scope, room).catch(error => console.warn('Could not load chat history:', error.message));
  });
  socket.on('friend_request', async targetSocketId => {
    const user = users.get(socket.id); const target = users.get(String(targetSocketId));
    if (!user || !target) return socket.emit('social_error', { message: 'Игрок больше не в сети.' });
    try { if (!await createFriendRequest(user, String(targetSocketId))) throw new Error('База данных недоступна.'); io.to(String(targetSocketId)).emit('friend_request_received', { from: publicUser(socket.id) }); socket.emit('social_notice', { message: `Заявка отправлена игроку ${target.name}.` }); } catch (error) { socket.emit('social_error', { message: error.message }); }
  });
  socket.on('game_invite', async targetSocketId => {
    const user = users.get(socket.id); const target = users.get(String(targetSocketId));
    if (!user?.room) return socket.emit('social_error', { message: 'Сначала создайте комнату.' });
    if (!target) return socket.emit('social_error', { message: 'Игрок больше не в сети.' });
    try { if (!await createGameInvite(user, String(targetSocketId), user.room)) throw new Error('База данных недоступна.'); io.to(String(targetSocketId)).emit('game_invite_received', { from: publicUser(socket.id), room: user.room }); socket.emit('social_notice', { message: `Приглашение отправлено игроку ${target.name}.` }); } catch (error) { socket.emit('social_error', { message: error.message }); }
  });
  socket.on('disconnect', () => { leaveRoom(socket.id); users.delete(socket.id); ratings.delete(socket.id); broadcastUsers(); });
});

initializeDatabase().catch(error => console.warn('Database initialization failed:', error.message));
baseServer.listen(port, () => console.log(`${hasCertificate ? 'HTTPS' : 'HTTP'} Gridbound server listening on ${port}`));
