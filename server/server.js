// server/server.js
// -----------------------------------------------------------------------------
// 섯다 멀티플레이 서버입니다.
// v6 반영 내용
// - 방 만들 때 2장 섯다 / 3장 섯다 모드 선택
// - 3장 섯다: 3장 수령 → 1장 공개 선택 → 2장 조합 선택 → 베팅/콜/쇼다운
// - 9·9·4처럼 여러 선택지가 있으면 9땡/구사 중 플레이어가 직접 선택 가능
// - 암행어사(4·7)는 광땡을 잡고, 땡잡이(3·7)는 일반 땡을 잡음
// - 구사/멍텅구리 구사는 재경기 또는 판돈 분배 투표
// - 투표 동률이면 구사 뽑은 사람의 표로 결정
// - 기존 v5의 올인/사이드팟/재경기 판돈 유지/재참가/자동 재시작 유지
// -----------------------------------------------------------------------------

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const { initDb, ensureUser, getUser, adjustChips, hasEnoughChips, insertGameHistory } = require('./db');
const {
  createDeck,
  shuffleDeck,
  drawCards,
  findWinners,
  formatCard,
  summarizeHand,
  getHandOptions,
  getSelectedHand,
} = require('./game-logic');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const BASE_ANTE = 1;
const AUTO_RESTART_DELAY_MS = 5000;
const DEV_NICK = process.env.DEV_NICK || 'DEV_MASTER';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'CHANGE_ME';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));

const rooms = new Map();
const onlineNicknameToSocketId = new Map();

function validateNickname(rawNickname) {
  const nickname = String(rawNickname || '').trim();
  const regex = /^[0-9A-Za-z가-힣_]{2,12}$/;
  if (!regex.test(nickname)) return { ok: false, message: '닉네임은 2~12자의 한글/영문/숫자/밑줄만 사용할 수 있습니다.' };
  return { ok: true, nickname };
}

function normalizeGameMode(rawMode) {
  return rawMode === 'THREE' ? 'THREE' : 'TWO';
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 6; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

function addRoomMessage(room, text) {
  room.messages.push({ text, timestamp: new Date().toISOString() });
  if (room.messages.length > 24) room.messages = room.messages.slice(-24);
}

function clearAutoRestart(room) {
  if (room.autoRestartTimer) clearTimeout(room.autoRestartTimer);
  room.autoRestartTimer = null;
  room.autoRestartAt = null;
}

function scheduleAutoRestart(room) {
  clearAutoRestart(room);
  room.autoRestartAt = Date.now() + AUTO_RESTART_DELAY_MS;
  room.autoRestartTimer = setTimeout(async () => {
    room.autoRestartTimer = null;
    room.autoRestartAt = null;
    try {
      if (!rooms.has(room.code)) return;
      if (room.status !== 'lobby') return;
      if (room.players.length < MIN_PLAYERS) return;
      const startOptions = room.pendingStart ? { ...room.pendingStart } : {};
      room.pendingStart = null;
      await startGame(room, startOptions);
    } catch (error) {
      addRoomMessage(room, `자동 시작 실패: ${error.message}`);
      emitRoomState(room);
    }
  }, AUTO_RESTART_DELAY_MS);
}

function getRoomPlayerIds(room) { return room.players.map((p) => p.id); }
function getPlayerFromRoom(room, playerId) { return room.players.find((p) => p.id === playerId) || null; }

async function syncPlayerPieces(room, playerId) {
  const user = await getUser(playerId);
  const player = getPlayerFromRoom(room, playerId);
  if (player && user) player.pieces = user.chips;
}

async function changePlayerPieces(room, playerId, delta) {
  const updatedUser = await adjustChips(playerId, delta);
  const player = getPlayerFromRoom(room, playerId);
  if (player) player.pieces = updatedUser.chips;
  return updatedUser;
}

function rotateArray(arr, startIndex) {
  if (!arr.length) return [];
  const index = ((startIndex % arr.length) + arr.length) % arr.length;
  return [...arr.slice(index), ...arr.slice(0, index)];
}

function getActivePlayerIds(room) {
  if (!room.game) return [];
  return room.game.turnOrder.filter((id) => !room.game.playerStates[id].folded);
}

function getActionablePlayerIds(room) {
  if (!room.game || room.game.phase !== 'betting') return [];
  return room.game.turnOrder.filter((id) => {
    const state = room.game.playerStates[id];
    return state && !state.folded && !state.allIn;
  });
}

function getPlayerHandOptions(state) {
  if (!state?.cards || state.cards.length !== 3) return [];
  return getHandOptions(state.cards);
}

function buildStateForPlayer(room, viewerId) {
  const myState = room.game?.playerStates?.[viewerId] || null;
  const isHost = room.hostId === viewerId;
  const isDeveloper = viewerId === DEV_NICK;
  const gameMode = room.game?.gameMode || room.gameMode || 'TWO';

  return {
    roomCode: room.code,
    roomStatus: room.status,
    hostId: room.hostId,
    myId: viewerId,
    isHost,
    isDeveloper,
    baseAnte: BASE_ANTE,
    gameMode,
    players: room.players.map((player) => {
      const gs = room.game?.playerStates?.[player.id] || null;
      const last = room.lastResult?.players?.find((p) => p.id === player.id) || null;
      const publicCards = gs?.publicCardId ? gs.cards.filter((c) => c.id === gs.publicCardId).map(formatCard) : [];
      return {
        id: player.id,
        pieces: player.pieces,
        inRound: !!gs,
        replayParticipant: room.pendingStart?.isReplay ? (room.pendingStart.participantIds || []).includes(player.id) : false,
        replayJoinable: room.pendingStart?.isReplay ? (room.pendingStart.joinableIds || []).includes(player.id) : false,
        folded: gs ? !!gs.folded : !!last?.folded,
        allIn: gs ? !!gs.allIn : !!last?.allIn,
        currentBet: gs ? gs.currentBet : 0,
        totalContribution: gs ? gs.totalContribution : last?.totalContribution || 0,
        cardCount: gs?.cards?.length || 0,
        publicCards,
        selectedHandName: gs?.selectedHand?.name || null,
        revealedCards: room.game?.phase === 'showdown' ? (gs?.cards || []).map(formatCard) : (last?.cards || []).map(formatCard),
        handName: room.game?.phase === 'showdown' ? gs?.hand?.name || null : last?.handName || null,
      };
    }),
    game: room.game ? {
      phase: room.game.phase,
      gameMode: room.game.gameMode,
      pot: room.game.pot,
      currentBet: room.game.currentBet,
      currentTurnPlayerId: room.game.currentTurnPlayerId,
      needResponseFrom: Array.from(room.game.needResponseFrom || []),
      needRevealFrom: Array.from(room.game.needRevealFrom || []),
      needVoteFrom: Array.from(room.game.needVoteFrom || []),
      myCards: (myState?.cards || []).map(formatCard),
      myPublicCardId: myState?.publicCardId || null,
      myHandOptions: myState?.cards?.length === 3 ? getPlayerHandOptions(myState) : [],
      mySelectedComboId: myState?.selectedComboId || null,
      mySelectedHand: myState?.selectedHand || null,
      myFolded: !!myState?.folded,
      myAllIn: !!myState?.allIn,
      myCurrentBet: myState?.currentBet || 0,
      myTotalContribution: myState?.totalContribution || 0,
      myHandSummary: myState?.cards?.length >= 2 ? summarizeHand(myState.cards, myState.selectedComboId) : null,
      gusaVote: room.game.gusaVote ? {
        activePlayerIds: room.game.gusaVote.activePlayerIds,
        replayPlayerIds: room.game.gusaVote.replayPlayerIds,
        votes: room.game.gusaVote.votes,
        myVote: room.game.gusaVote.votes[viewerId] || null,
      } : null,
    } : null,
    lastResult: room.lastResult,
    pendingReplay: room.pendingStart?.isReplay || false,
    replayInfo: room.pendingStart?.isReplay ? {
      carryPot: room.pendingStart.carryPot || 0,
      deadPot: room.pendingStart.deadPot || room.pendingStart.carryPot || 0,
      joinFee: room.pendingStart.joinFee || 0,
      participants: [...(room.pendingStart.participantIds || [])],
      joinable: [...(room.pendingStart.joinableIds || [])],
      joined: [...(room.pendingStart.joinedIds || [])],
      canJoin: (room.pendingStart.joinableIds || []).includes(viewerId),
      replayPlayers: [...(room.pendingStart.replayPlayerIds || [])],
    } : null,
    nextAutoStartAt: room.autoRestartAt,
    messages: room.messages,
    controls: {
      canStart: isHost && room.status === 'lobby' && room.players.length >= MIN_PLAYERS && !room.pendingStart,
      canReveal: room.status === 'playing' && room.game?.phase === 'reveal' && (room.game.needRevealFrom || new Set()).has(viewerId),
      canVote: room.status === 'playing' && room.game?.phase === 'gusaVote' && (room.game.needVoteFrom || new Set()).has(viewerId),
      canAct: room.status === 'playing' && room.game?.phase === 'betting' && room.game.currentTurnPlayerId === viewerId && !myState?.folded && !myState?.allIn,
    },
    developerTools: { enabled: isDeveloper, devNick: DEV_NICK },
  };
}

function emitRoomState(room) {
  for (const player of room.players) io.to(player.socketId).emit('roomState', buildStateForPlayer(room, player.id));
}

function emitError(socket, message) { socket.emit('errorMessage', message); }

function rebuildNeedResponseFrom(room, actorId) {
  const ids = getActionablePlayerIds(room).filter((id) => {
    if (id === actorId) return false;
    return room.game.playerStates[id].currentBet < room.game.currentBet;
  });
  room.game.needResponseFrom = new Set(ids);
}

function findNextTurnPlayer(room, afterPlayerId) {
  const game = room.game;
  if (!game || game.phase !== 'betting' || game.needResponseFrom.size === 0) return null;
  const order = game.turnOrder;
  const startIndex = Math.max(order.indexOf(afterPlayerId), 0);
  for (let step = 1; step <= order.length; step += 1) {
    const id = order[(startIndex + step) % order.length];
    const st = game.playerStates[id];
    if (st && !st.folded && !st.allIn && game.needResponseFrom.has(id)) return id;
  }
  return null;
}

function beginBettingIfReady(room) {
  if (!room.game || room.game.phase !== 'reveal') return;
  if (room.game.needRevealFrom.size > 0) return;
  room.game.phase = 'betting';
  const actionable = getActionablePlayerIds(room);
  room.game.needResponseFrom = new Set(actionable);
  room.game.currentTurnPlayerId = actionable[0] || null;
  addRoomMessage(room, '모든 플레이어가 공개패를 선택했습니다. 베팅을 시작합니다.');
  if (!room.game.currentTurnPlayerId) showdown(room);
  else emitRoomState(room);
}

function calculatePayoutsAndHistory(room, timestamp) {
  const game = room.game;
  const payouts = {};
  const historyRows = [];
  for (const id of game.turnOrder) payouts[id] = 0;

  const levels = [...new Set(game.turnOrder.map((id) => game.playerStates[id].totalContribution).filter((v) => v > 0))].sort((a, b) => a - b);
  let prev = 0;
  for (const level of levels) {
    const tier = level - prev;
    prev = level;
    if (tier <= 0) continue;
    const contributors = game.turnOrder.filter((id) => game.playerStates[id].totalContribution >= level);
    const potAmount = tier * contributors.length;
    const eligible = contributors.filter((id) => !game.playerStates[id].folded);
    if (!eligible.length) {
      contributors.forEach((id) => { payouts[id] += tier; });
      continue;
    }
    const winners = findWinners(eligible.map((id) => ({ playerId: id, hand: game.playerStates[id].hand }))).map((e) => e.playerId);
    const share = Math.floor(potAmount / winners.length);
    let rem = potAmount % winners.length;
    for (const id of winners) payouts[id] += share + (rem-- > 0 ? 1 : 0);

    const losers = contributors.filter((id) => !winners.includes(id));
    for (const loser of losers) {
      const each = Math.floor(tier / winners.length);
      let r = tier % winners.length;
      for (const winner of winners) {
        const amount = each + (r-- > 0 ? 1 : 0);
        if (amount > 0) historyRows.push({ winner_id: winner, loser_id: loser, bet_amount: amount, timestamp });
      }
    }
  }

  const deadPot = Number(game.deadPot || 0);
  if (deadPot > 0) {
    const activeIds = getActivePlayerIds(room);
    const winners = findWinners(activeIds.map((id) => ({ playerId: id, hand: game.playerStates[id].hand }))).map((e) => e.playerId);
    const share = Math.floor(deadPot / winners.length);
    let rem = deadPot % winners.length;
    for (const id of winners) payouts[id] += share + (rem-- > 0 ? 1 : 0);
  }

  return { payouts, historyRows };
}

function buildResultPlayers(room) {
  return room.game.turnOrder.map((id) => {
    const st = room.game.playerStates[id];
    return {
      id,
      folded: st.folded,
      allIn: st.allIn,
      totalContribution: st.totalContribution,
      cards: st.folded ? [] : st.cards,
      publicCardId: st.publicCardId || null,
      selectedComboId: st.selectedComboId || null,
      handName: st.folded ? null : st.hand?.name || null,
    };
  });
}

async function splitPotAmong(room, playerIds, reason) {
  const game = room.game;
  const timestamp = new Date().toISOString();
  const resultPlayers = buildResultPlayers(room);
  const pot = game.pot;
  const share = Math.floor(pot / playerIds.length);
  let rem = pot % playerIds.length;
  for (const id of playerIds) await changePlayerPieces(room, id, share + (rem-- > 0 ? 1 : 0));
  room.lastResult = { reason, pot, timestamp, replay: false, split: true, winners: playerIds.map((id) => ({ id, payout: share, handName: '구사 분배' })), players: resultPlayers };
  room.pendingStart = null;
  room.game = null;
  room.status = 'lobby';
  addRoomMessage(room, `${reason} 판돈 ${pot}조각을 ${playerIds.length}명이 나눠 가졌습니다.`);
  scheduleAutoRestart(room);
  emitRoomState(room);
}

async function queueReplayRound(room, replayPlayerIds, reason) {
  const game = room.game;
  const timestamp = new Date().toISOString();
  const resultPlayers = buildResultPlayers(room);
  const activePlayerIds = getActivePlayerIds(room);
  const foldedPlayerIds = game.turnOrder.filter((id) => game.playerStates[id].folded);
  const joinFee = Math.max(1, Math.ceil(game.pot / Math.max(1, activePlayerIds.length)));

  room.lastResult = {
    reason,
    pot: game.pot,
    timestamp,
    replay: true,
    carryOverPot: game.pot,
    replayPlayers: replayPlayerIds,
    rematchParticipants: activePlayerIds,
    rematchJoinable: foldedPlayerIds,
    rematchJoined: [],
    rematchJoinFee: joinFee,
    winners: [],
    players: resultPlayers,
  };
  room.pendingStart = {
    skipAnte: true,
    carryPot: 0,
    deadPot: game.pot,
    isReplay: true,
    participantIds: activePlayerIds,
    joinableIds: foldedPlayerIds,
    joinedIds: [],
    joinFee,
    replayPlayerIds,
    gameMode: room.gameMode,
  };
  room.game = null;
  room.status = 'lobby';
  addRoomMessage(room, `${replayPlayerIds.join(', ')}님의 구사로 판돈 ${game.pot}조각을 유지하고 재경기합니다.`);
  if (foldedPlayerIds.length) addRoomMessage(room, `다이했던 플레이어는 ${joinFee}조각을 내고 재경기에 참가할 수 있습니다.`);
  addRoomMessage(room, '5초 후 자동으로 재경기가 시작됩니다. 참가하지 않은 사람은 베팅할 수 없습니다.');
  scheduleAutoRestart(room);
  emitRoomState(room);
}

async function finishRound(room, winnerIdsForMessage, reason) {
  const game = room.game;
  if (!game) return;
  const timestamp = new Date().toISOString();
  const resultPlayers = buildResultPlayers(room);
  const { payouts, historyRows } = calculatePayoutsAndHistory(room, timestamp);
  for (const id of Object.keys(payouts)) if (payouts[id] > 0) await changePlayerPieces(room, id, payouts[id]);
  if (historyRows.length) await insertGameHistory(historyRows);
  let finalWinnerIds = winnerIdsForMessage;
  if (!Array.isArray(finalWinnerIds) || !finalWinnerIds.length) {
    const maxPayout = Math.max(...Object.values(payouts));
    finalWinnerIds = Object.keys(payouts).filter((id) => payouts[id] === maxPayout);
  }
  room.lastResult = {
    reason,
    pot: game.pot,
    timestamp,
    replay: false,
    carryOverPot: 0,
    winners: finalWinnerIds.map((id) => ({ id, payout: payouts[id] || 0, handName: game.playerStates[id]?.hand?.name || '자동 승리' })),
    players: resultPlayers,
  };
  addRoomMessage(room, finalWinnerIds.length === 1 ? `${finalWinnerIds[0]}님이 승리했습니다. 최종 획득 ${payouts[finalWinnerIds[0]] || 0}조각 (${reason})` : `${finalWinnerIds.join(', ')}님이 공동 승리했습니다. (${reason})`);
  room.pendingStart = null;
  room.game = null;
  room.status = 'lobby';
  if (room.players.length >= MIN_PLAYERS) {
    addRoomMessage(room, '5초 후 자동으로 다음 판이 시작됩니다.');
    scheduleAutoRestart(room);
  } else clearAutoRestart(room);
  emitRoomState(room);
}

function finalizeHands(room) {
  const activeIds = getActivePlayerIds(room);
  return activeIds.map((id) => {
    const st = room.game.playerStates[id];
    st.hand = st.cards.length === 3 ? getSelectedHand(st.cards, st.selectedComboId) : getSelectedHand(st.cards, null);
    st.selectedHand = { name: st.hand.name, type: st.hand.type, replay: !!st.hand.replay, note: st.hand.note };
    return { playerId: id, hand: st.hand };
  });
}

async function showdown(room) {
  const playerHands = finalizeHands(room);
  const replayPlayers = playerHands.filter((e) => e.hand.replay).map((e) => e.playerId);
  if (replayPlayers.length) {
    room.game.phase = 'gusaVote';
    room.game.gusaVote = { activePlayerIds: getActivePlayerIds(room), replayPlayerIds: replayPlayers, votes: {} };
    room.game.needVoteFrom = new Set(room.game.gusaVote.activePlayerIds);
    room.game.currentTurnPlayerId = null;
    addRoomMessage(room, `구사 발생! 살아있는 플레이어들이 재경기/분배를 투표합니다. 동률이면 ${replayPlayers[0]}님의 선택으로 결정됩니다.`);
    emitRoomState(room);
    return;
  }
  const winnerIds = findWinners(playerHands).map((e) => e.playerId);
  await finishRound(room, winnerIds, '배팅 라운드 종료 후 패를 비교했습니다.');
}

async function resolveGusaVoteIfReady(room) {
  const vote = room.game?.gusaVote;
  if (!vote || room.game.needVoteFrom.size > 0) return;
  const counts = { replay: 0, split: 0 };
  for (const v of Object.values(vote.votes)) if (v === 'split') counts.split += 1; else counts.replay += 1;
  let decision;
  if (counts.replay > counts.split) decision = 'replay';
  else if (counts.split > counts.replay) decision = 'split';
  else decision = vote.votes[vote.replayPlayerIds[0]] || 'replay';

  if (decision === 'split') await splitPotAmong(room, vote.activePlayerIds, '구사 투표 결과 분배로 결정되었습니다.');
  else await queueReplayRound(room, vote.replayPlayerIds, '구사 투표 결과 재경기로 결정되었습니다.');
}

async function resolveGameProgress(room, actorId) {
  if (!room.game) return;
  const activeIds = getActivePlayerIds(room);
  if (activeIds.length === 1) return finishRound(room, [activeIds[0]], '상대가 모두 다이했습니다.');
  if (getActionablePlayerIds(room).length === 0 || room.game.needResponseFrom.size === 0) return showdown(room);
  room.game.currentTurnPlayerId = findNextTurnPlayer(room, actorId);
  emitRoomState(room);
}

async function startGame(room, options = {}) {
  clearAutoRestart(room);
  if (room.status === 'playing') throw new Error('이미 게임이 진행 중입니다.');
  const mode = normalizeGameMode(options.gameMode || room.gameMode);
  const skipAnte = !!options.skipAnte;
  const deadPot = Number(options.deadPot || 0);
  const participantIds = Array.isArray(options.participantIds) && options.participantIds.length ? options.participantIds.filter((id) => getPlayerFromRoom(room, id)) : getRoomPlayerIds(room);
  if (participantIds.length < MIN_PLAYERS) throw new Error('게임은 2명 이상일 때만 시작할 수 있습니다.');
  if (!skipAnte) {
    for (const id of participantIds) if (!(await hasEnoughChips(id, BASE_ANTE))) throw new Error(`${id}님의 조각이 부족합니다.`);
    for (const id of participantIds) await changePlayerPieces(room, id, -BASE_ANTE);
  }
  const deck = shuffleDeck(createDeck());
  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  const allOrder = rotateArray(getRoomPlayerIds(room), room.dealerIndex + 1);
  const turnOrder = allOrder.filter((id) => participantIds.includes(id));
  const cardCount = mode === 'THREE' ? 3 : 2;
  const playerStates = {};
  for (const id of turnOrder) {
    const p = getPlayerFromRoom(room, id);
    playerStates[id] = { cards: drawCards(deck, cardCount), publicCardId: null, selectedComboId: null, selectedHand: null, folded: false, allIn: p ? p.pieces === 0 : false, currentBet: 0, totalContribution: skipAnte ? 0 : BASE_ANTE, hand: null };
  }
  const actionable = turnOrder.filter((id) => !playerStates[id].allIn);
  room.game = {
    phase: mode === 'THREE' ? 'reveal' : 'betting',
    gameMode: mode,
    deck,
    pot: deadPot + (skipAnte ? 0 : participantIds.length * BASE_ANTE),
    deadPot,
    isReplay: !!options.isReplay,
    currentBet: 0,
    turnOrder,
    currentTurnPlayerId: mode === 'TWO' ? actionable[0] || null : null,
    needResponseFrom: mode === 'TWO' ? new Set(actionable) : new Set(),
    needRevealFrom: mode === 'THREE' ? new Set(turnOrder) : new Set(),
    needVoteFrom: new Set(),
    playerStates,
    gusaVote: null,
  };
  room.pendingStart = null;
  room.lastResult = null;
  room.status = 'playing';
  addRoomMessage(room, skipAnte ? `재경기가 시작되었습니다. 이전 판돈 ${deadPot}조각을 유지합니다.` : `${mode === 'THREE' ? '3장 섯다' : '2장 섯다'} 게임 시작! 참가비 ${BASE_ANTE}조각이 차감되었습니다.`);
  if (mode === 'THREE') addRoomMessage(room, '3장 중 공개할 카드 1장을 먼저 선택하세요.');
  else if (!room.game.currentTurnPlayerId) await showdown(room);
  emitRoomState(room);
}

function parsePositiveInteger(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function findRoomContainingPlayer(playerId) {
  for (const room of rooms.values()) if (room.players.some((p) => p.id === playerId)) return room;
  return null;
}

function cleanupEmptyRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (room && room.players.length === 0) {
    clearAutoRestart(room);
    rooms.delete(roomCode);
  }
}

async function removePlayerFromRoom(socket, reasonText = '방을 나갔습니다.') {
  const roomCode = socket.data.roomCode;
  const playerId = socket.data.nickname;
  if (!roomCode || !playerId) return;
  const room = rooms.get(roomCode);
  if (!room) { onlineNicknameToSocketId.delete(playerId); return; }
  if (room.status === 'playing' && room.game?.playerStates?.[playerId]) {
    room.game.playerStates[playerId].folded = true;
    room.game.needResponseFrom?.delete(playerId);
    room.game.needRevealFrom?.delete(playerId);
    room.game.needVoteFrom?.delete(playerId);
    addRoomMessage(room, `${playerId}님이 연결 종료로 자동 다이 처리되었습니다.`);
  }
  room.players = room.players.filter((p) => p.id !== playerId);
  socket.leave(roomCode);
  onlineNicknameToSocketId.delete(playerId);
  delete socket.data.roomCode;
  delete socket.data.nickname;
  if (room.hostId === playerId && room.players.length) room.hostId = room.players[0].id;
  if (room.status === 'playing') await resolveGameProgress(room, playerId);
  if (room.players.length && room.status !== 'playing') { addRoomMessage(room, `${playerId}님이 ${reasonText}`); emitRoomState(room); }
  cleanupEmptyRoom(roomCode);
}

io.on('connection', (socket) => {
  socket.on('createRoom', async ({ nickname, gameMode }) => {
    try {
      if (socket.data.roomCode) return emitError(socket, '이미 방에 들어와 있습니다.');
      const v = validateNickname(nickname);
      if (!v.ok) return emitError(socket, v.message);
      if (onlineNicknameToSocketId.has(v.nickname)) return emitError(socket, '이미 접속 중인 닉네임입니다.');
      const user = await ensureUser(v.nickname);
      const roomCode = generateRoomCode();
      const mode = normalizeGameMode(gameMode);
      const room = { code: roomCode, hostId: v.nickname, gameMode: mode, dealerIndex: -1, status: 'lobby', players: [{ id: v.nickname, socketId: socket.id, pieces: user.chips }], game: null, lastResult: null, messages: [], createdAt: new Date().toISOString(), autoRestartTimer: null, autoRestartAt: null, pendingStart: null };
      rooms.set(roomCode, room);
      onlineNicknameToSocketId.set(v.nickname, socket.id);
      socket.data.nickname = v.nickname;
      socket.data.roomCode = roomCode;
      socket.join(roomCode);
      addRoomMessage(room, `${v.nickname}님이 ${mode === 'THREE' ? '3장 섯다' : '2장 섯다'} 방을 만들었습니다.`);
      emitRoomState(room);
    } catch (e) { console.error(e); emitError(socket, '방 생성 중 오류가 발생했습니다.'); }
  });

  socket.on('joinRoom', async ({ nickname, roomCode }) => {
    try {
      if (socket.data.roomCode) return emitError(socket, '이미 방에 들어와 있습니다.');
      const v = validateNickname(nickname);
      if (!v.ok) return emitError(socket, v.message);
      const code = String(roomCode || '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return emitError(socket, '존재하지 않는 방 코드입니다.');
      if (onlineNicknameToSocketId.has(v.nickname)) return emitError(socket, '이미 접속 중인 닉네임입니다.');
      if (room.status === 'playing') return emitError(socket, '게임 진행 중인 방에는 참가할 수 없습니다.');
      if (room.players.length >= MAX_PLAYERS) return emitError(socket, '방이 가득 찼습니다.');
      const user = await ensureUser(v.nickname);
      room.players.push({ id: v.nickname, socketId: socket.id, pieces: user.chips });
      onlineNicknameToSocketId.set(v.nickname, socket.id);
      socket.data.nickname = v.nickname;
      socket.data.roomCode = code;
      socket.join(code);
      addRoomMessage(room, `${v.nickname}님이 방에 참가했습니다.`);
      emitRoomState(room);
    } catch (e) { console.error(e); emitError(socket, '방 참가 중 오류가 발생했습니다.'); }
  });

  socket.on('leaveRoom', async () => { await removePlayerFromRoom(socket, '방을 나갔습니다.'); socket.emit('leftRoom'); });

  socket.on('startGame', async () => {
    try {
      const room = rooms.get(socket.data.roomCode);
      if (!room) return emitError(socket, '현재 참가 중인 방이 없습니다.');
      if (room.hostId !== socket.data.nickname) return emitError(socket, '방장만 게임을 시작할 수 있습니다.');
      await startGame(room);
    } catch (e) { console.error(e); emitError(socket, e.message || '게임 시작 중 오류가 발생했습니다.'); }
  });

  socket.on('selectPublicCard', ({ cardId }) => {
    const room = rooms.get(socket.data.roomCode);
    const playerId = socket.data.nickname;
    const st = room?.game?.playerStates?.[playerId];
    if (!room || room.game?.phase !== 'reveal' || !st) return emitError(socket, '공개패를 선택할 수 있는 상태가 아닙니다.');
    if (!st.cards.some((c) => c.id === cardId)) return emitError(socket, '내 카드만 공개할 수 있습니다.');
    st.publicCardId = cardId;
    room.game.needRevealFrom.delete(playerId);
    addRoomMessage(room, `${playerId}님이 공개패를 선택했습니다.`);
    beginBettingIfReady(room);
    emitRoomState(room);
  });

  socket.on('selectHandCombination', ({ comboId }) => {
    const room = rooms.get(socket.data.roomCode);
    const playerId = socket.data.nickname;
    const st = room?.game?.playerStates?.[playerId];
    if (!room || !st || st.cards.length !== 3) return emitError(socket, '3장 섯다에서만 조합을 선택할 수 있습니다.');
    const opt = getHandOptions(st.cards).find((o) => o.comboId === comboId);
    if (!opt) return emitError(socket, '선택할 수 없는 조합입니다.');
    st.selectedComboId = comboId;
    st.selectedHand = opt.hand;
    addRoomMessage(room, `${playerId}님이 낼 패를 선택했습니다: ${opt.hand.name}`);
    emitRoomState(room);
  });

  socket.on('voteGusa', async ({ vote }) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const playerId = socket.data.nickname;
      if (!room || room.game?.phase !== 'gusaVote' || !room.game.gusaVote) return emitError(socket, '구사 투표 상태가 아닙니다.');
      if (!room.game.gusaVote.activePlayerIds.includes(playerId)) return emitError(socket, '살아있는 플레이어만 투표할 수 있습니다.');
      const finalVote = vote === 'split' ? 'split' : 'replay';
      room.game.gusaVote.votes[playerId] = finalVote;
      room.game.needVoteFrom.delete(playerId);
      addRoomMessage(room, `${playerId}님이 구사 처리 방식을 선택했습니다.`);
      await resolveGusaVoteIfReady(room);
      if (room.game) emitRoomState(room);
    } catch (e) { console.error(e); emitError(socket, '구사 투표 처리 중 오류가 발생했습니다.'); }
  });

  socket.on('joinReplay', async () => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const playerId = socket.data.nickname;
      if (!room || !room.pendingStart?.isReplay) return emitError(socket, '현재 참가 가능한 재경기가 없습니다.');
      if (!(room.pendingStart.joinableIds || []).includes(playerId)) return emitError(socket, '전 판에서 다이한 플레이어만 재경기에 참가할 수 있습니다.');
      const joinFee = Number(room.pendingStart.joinFee || 0);
      const player = getPlayerFromRoom(room, playerId);
      if (joinFee > player.pieces) return emitError(socket, `재경기 참가비 ${joinFee}조각이 부족합니다.`);
      await changePlayerPieces(room, playerId, -joinFee);
      room.pendingStart.participantIds.push(playerId);
      room.pendingStart.joinedIds.push(playerId);
      room.pendingStart.joinableIds = room.pendingStart.joinableIds.filter((id) => id !== playerId);
      room.pendingStart.deadPot += joinFee;
      if (room.lastResult?.replay) {
        room.lastResult.carryOverPot = room.pendingStart.deadPot;
        room.lastResult.rematchParticipants = [...room.pendingStart.participantIds];
        room.lastResult.rematchJoinable = [...room.pendingStart.joinableIds];
        room.lastResult.rematchJoined = [...room.pendingStart.joinedIds];
      }
      addRoomMessage(room, `${playerId}님이 ${joinFee}조각을 내고 구사 재경기에 참가했습니다.`);
      emitRoomState(room);
    } catch (e) { console.error(e); emitError(socket, '재경기 참가 중 오류가 발생했습니다.'); }
  });

  socket.on('gameAction', async ({ type, amount }) => {
    try {
      const room = rooms.get(socket.data.roomCode);
      const playerId = socket.data.nickname;
      if (!room || !room.game || room.status !== 'playing') return emitError(socket, '현재 진행 중인 게임이 없습니다.');
      if (room.game.phase !== 'betting') return emitError(socket, '아직 베팅 단계가 아닙니다.');
      if (room.game.currentTurnPlayerId !== playerId) return emitError(socket, '지금은 당신의 차례가 아닙니다.');
      const player = getPlayerFromRoom(room, playerId);
      const st = room.game.playerStates[playerId];
      if (!player || !st) return emitError(socket, '재경기에 참가하지 않은 사람은 베팅할 수 없습니다.');
      if (st.folded) return emitError(socket, '이미 다이했습니다.');
      if (st.allIn) return emitError(socket, '이미 올인 상태입니다.');
      const toCall = Math.max(0, room.game.currentBet - st.currentBet);

      if (type === 'call') {
        const actual = Math.min(toCall, player.pieces);
        if (toCall === 0) addRoomMessage(room, `${playerId}님이 체크했습니다.`);
        else if (actual > 0) {
          await changePlayerPieces(room, playerId, -actual);
          st.currentBet += actual;
          st.totalContribution += actual;
          room.game.pot += actual;
          if (player.pieces === 0) { st.allIn = true; addRoomMessage(room, `${playerId}님이 ${actual}조각 콜하고 올인했습니다.`); }
          else addRoomMessage(room, `${playerId}님이 콜(${actual}조각)했습니다.`);
        } else return emitError(socket, '베팅할 조각이 없습니다.');
        room.game.needResponseFrom.delete(playerId);
        await resolveGameProgress(room, playerId);
        return;
      }

      if (type === 'bet') {
        const raiseAmount = parsePositiveInteger(amount);
        if (!raiseAmount) return emitError(socket, '베팅 금액은 1 이상의 정수여야 합니다.');
        const wanted = toCall + raiseAmount;
        const actual = Math.min(wanted, player.pieces);
        if (actual <= 0) return emitError(socket, '베팅할 조각이 없습니다.');
        const prev = room.game.currentBet;
        await changePlayerPieces(room, playerId, -actual);
        st.currentBet += actual;
        st.totalContribution += actual;
        room.game.pot += actual;
        if (st.currentBet > room.game.currentBet) room.game.currentBet = st.currentBet;
        if (player.pieces === 0) st.allIn = true;
        if (room.game.currentBet > prev) rebuildNeedResponseFrom(room, playerId);
        else room.game.needResponseFrom.delete(playerId);
        addRoomMessage(room, `${playerId}님이 ${actual}조각 ${st.allIn ? '올인' : '베팅'}했습니다. 현재 최고 베팅: ${room.game.currentBet}`);
        await resolveGameProgress(room, playerId);
        return;
      }

      if (type === 'fold') {
        st.folded = true;
        room.game.needResponseFrom.delete(playerId);
        addRoomMessage(room, `${playerId}님이 다이했습니다.`);
        await resolveGameProgress(room, playerId);
        return;
      }
      emitError(socket, '알 수 없는 액션입니다.');
    } catch (e) { console.error(e); emitError(socket, e.message || '게임 액션 처리 중 오류가 발생했습니다.'); }
  });

  socket.on('adminGrantPieces', async ({ targetNickname, amount, secret }) => {
    try {
      if (socket.data.nickname !== DEV_NICK) return emitError(socket, '개발자 닉네임으로 접속한 사용자만 사용할 수 있습니다.');
      if (secret !== ADMIN_SECRET) return emitError(socket, '관리자 비밀키가 올바르지 않습니다.');
      const v = validateNickname(targetNickname);
      if (!v.ok) return emitError(socket, '지급 대상 닉네임 형식이 올바르지 않습니다.');
      const parsed = Number(amount);
      if (!Number.isInteger(parsed) || parsed === 0) return emitError(socket, '금액은 0이 아닌 정수여야 합니다.');
      await ensureUser(v.nickname);
      await adjustChips(v.nickname, parsed);
      const targetRoom = findRoomContainingPlayer(v.nickname);
      if (targetRoom) { await syncPlayerPieces(targetRoom, v.nickname); addRoomMessage(targetRoom, `관리자 기능으로 ${v.nickname}님의 조각이 ${parsed > 0 ? '+' : ''}${parsed} 변경되었습니다.`); emitRoomState(targetRoom); }
      const updated = await getUser(v.nickname);
      socket.emit('adminGrantResult', { targetNickname: v.nickname, amount: parsed, totalPieces: updated?.chips || 0 });
    } catch (e) { console.error(e); emitError(socket, '관리자 조각 지급 중 오류가 발생했습니다.'); }
  });

  socket.on('disconnect', async () => { try { await removePlayerFromRoom(socket, '연결이 종료되었습니다.'); } catch (e) { console.error(e); } });
});

(async () => {
  try {
    await initDb();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`섯다 서버가 포트 ${PORT}에서 실행 중입니다.`);
      console.log(`개발자 닉네임(DEV_NICK): ${DEV_NICK}`);
    });
  } catch (e) {
    console.error('서버 시작 실패:', e);
    process.exit(1);
  }
})();
