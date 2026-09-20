'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const fs = require('node:fs');
const path = require('node:path');
const { Server } = require('socket.io');

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
  users.set(socket.id, { name: 'Игрок', room: null, ready: false });
  ratings.set(socket.id, 1200);
  socket.emit('connected_info', { id: socket.id });
  broadcastUsers();

  socket.on('profile_update', profile => {
    const user = users.get(socket.id);
    if (!user) return;
    user.name = String(profile?.name || 'Игрок').slice(0, 24);
    ratings.set(socket.id, Math.max(800, Number(profile?.rating) || ratings.get(socket.id) || 1200));
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

  socket.on('player_ready', payload => {
    const user = users.get(socket.id);
    const room = roomFor(socket.id);
    if (!user || !room) return;
    user.ready = Boolean(payload?.ready);
    if (room.players.length === 2 && room.players.every(playerId => users.get(playerId)?.ready)) {
      room.started = true;
      room.players.forEach(playerId => io.to(playerId).emit('match_started', { code: room.code }));
    }
    broadcastRoom(room);
  });

  socket.on('move', data => {
    const room = roomFor(socket.id);
    if (!room || room.players.length !== 2 || !room.started) return socket.emit('room_error', { message: 'Оба игрока должны быть готовы.' });
    const opponentId = room.players.find(playerId => playerId !== socket.id);
    if (opponentId) io.to(opponentId).emit('opponent_move', data);
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
    broadcastRoom(room);
  });

  socket.on('chat message', message => io.to(users.get(socket.id)?.room || socket.id).emit('chat message', String(message).slice(0, 500)));
  socket.on('disconnect', () => { leaveRoom(socket.id); users.delete(socket.id); ratings.delete(socket.id); broadcastUsers(); });
});

baseServer.listen(port, () => console.log(`${hasCertificate ? 'HTTPS' : 'HTTP'} Gridbound server listening on ${port}`));
