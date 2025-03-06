// app.js - Main Express application file
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Game rooms storage
const gameRooms = {};

// Session middleware
app.use(session({
  secret: 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Home page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Create a new game room
app.post('/api/create-room', (req, res) => {
  const roomId = uuidv4().substring(0, 6);
  gameRooms[roomId] = {
    id: roomId,
    players: {},
    currentRound: 0,
    totalRounds: 5,
    roundsToWin: 3,
    state: 'waiting', // waiting, betting, roundEnd, gameEnd
    bets: {},
    roundWinners: []
  };
  
  res.json({ roomId });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected');
  
  // Join game room
  socket.on('joinRoom', ({ roomId, playerName }) => {
    // Check if room exists
    if (!gameRooms[roomId]) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    // Check if game is already full or started
    const room = gameRooms[roomId];
    if (room.state !== 'waiting') {
      socket.emit('error', { message: 'Game already started' });
      return;
    }
    
    // Add player to room
    const playerId = uuidv4();
    room.players[playerId] = {
      id: playerId,
      name: playerName,
      money: 100,
      roundsWon: 0,
      socketId: socket.id
    };
    
    // Join socket room
    socket.join(roomId);
    socket.playerId = playerId;
    socket.roomId = roomId;
    
    // Notify everyone about new player
    io.to(roomId).emit('roomUpdate', {
      players: Object.values(room.players),
      state: room.state
    });
    
    socket.emit('joinedRoom', {
      playerId,
      roomId
    });
  });
  
  // Start game
  socket.on('startGame', () => {
    const roomId = socket.roomId;
    const room = gameRooms[roomId];
    
    if (!room) return;
    
    // Need at least 2 players to start
    if (Object.keys(room.players).length < 2) {
      socket.emit('error', { message: 'Need at least 2 players to start' });
      return;
    }
    
    // Start the first round
    room.state = 'betting';
    room.currentRound = 1;
    
    io.to(roomId).emit('gameStarted', {
      currentRound: room.currentRound,
      state: room.state,
      players: Object.values(room.players)
    });
  });
  
  // Place bet
  socket.on('placeBet', ({ amount }) => {
    const roomId = socket.roomId;
    const playerId = socket.playerId;
    const room = gameRooms[roomId];
    
    if (!room || room.state !== 'betting') return;
    
    const player = room.players[playerId];
    if (!player) return;
    
    // Validate bet amount
    amount = parseInt(amount);
    if (isNaN(amount) || amount <= 0) {
      socket.emit('error', { message: 'Invalid bet amount' });
      return;
    }
    
    // Check if player has enough money
    if (amount > player.money) {
      socket.emit('error', { message: `You don't have enough money! Your balance: ${player.money}` });
      return;
    }
    
    // Record bet
    room.bets[playerId] = amount;
    player.money -= amount;
    
    // Notify all players about the bet
    io.to(roomId).emit('betPlaced', {
      playerId,
      playerName: player.name,
      amount
    });
    
    // Check if all players have bet
    if (Object.keys(room.bets).length === Object.keys(room.players).length) {
      endRound(roomId);
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected');
    
    const roomId = socket.roomId;
    const playerId = socket.playerId;
    
    if (roomId && playerId && gameRooms[roomId]) {
      const room = gameRooms[roomId];
      
      // Remove player
      delete room.players[playerId];
      
      // If no players left, remove the room
      if (Object.keys(room.players).length === 0) {
        delete gameRooms[roomId];
        return;
      }
      
      // Notify remaining players
      io.to(roomId).emit('playerLeft', {
        playerId,
        players: Object.values(room.players)
      });
      
      // If game is in progress and all players have bet, end the round
      if (room.state === 'betting' && Object.keys(room.bets).length === Object.keys(room.players).length) {
        endRound(roomId);
      }
    }
  });
});

// Helper function to end a round
function endRound(roomId) {
  const room = gameRooms[roomId];
  if (!room) return;
  
  // Find highest bet
  let highestBet = 0;
  let winnerIds = [];
  
  Object.entries(room.bets).forEach(([playerId, betAmount]) => {
    if (betAmount > highestBet) {
      highestBet = betAmount;
      winnerIds = [playerId];
    } else if (betAmount === highestBet) {
      winnerIds.push(playerId);
    }
  });
  
  // In case of a tie, first player wins (simplification)
  const winnerId = winnerIds[0];
  const winner = room.players[winnerId];
  
  // Update winner stats
  winner.roundsWon++;
  room.roundWinners.push({
    round: room.currentRound,
    winnerId,
    winnerName: winner.name,
    betAmount: highestBet
  });
  
  // Change state
  room.state = 'roundEnd';
  
  // Notify all players about round end
  io.to(roomId).emit('roundEnded', {
    round: room.currentRound,
    winnerId,
    winnerName: winner.name,
    bets: room.bets,
    players: Object.values(room.players)
  });
  
  // Check if game is over
  if (winner.roundsWon >= room.roundsToWin || room.currentRound >= room.totalRounds) {
    endGame(roomId);
  } else {
    // Prepare for next round after a delay
    setTimeout(() => {
      startNextRound(roomId);
    }, 5000);
  }
}

// Helper function to start next round
function startNextRound(roomId) {
  const room = gameRooms[roomId];
  if (!room) return;
  
  // Reset bets
  room.bets = {};
  
  // Increment round
  room.currentRound++;
  
  // Set state to betting
  room.state = 'betting';
  
  // Notify all players
  io.to(roomId).emit('roundStarted', {
    currentRound: room.currentRound,
    state: room.state,
    players: Object.values(room.players)
  });
}

// Helper function to end the game
function endGame(roomId) {
  const room = gameRooms[roomId];
  if (!room) return;
  
  // Find player with most rounds won
  let maxRoundsWon = 0;
  let gameWinnerId = null;
  
  Object.entries(room.players).forEach(([playerId, player]) => {
    if (player.roundsWon > maxRoundsWon) {
      maxRoundsWon = player.roundsWon;
      gameWinnerId = playerId;
    }
  });
  
  const gameWinner = room.players[gameWinnerId];
  
  // Set state to game end
  room.state = 'gameEnd';
  
  // Notify all players
  io.to(roomId).emit('gameEnded', {
    winnerId: gameWinnerId,
    winnerName: gameWinner.name,
    roundsWon: maxRoundsWon,
    roundResults: room.roundWinners,
    players: Object.values(room.players)
  });
  
  // Remove room after a delay
  setTimeout(() => {
    delete gameRooms[roomId];
  }, 60000);
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app; // For testing purposes