// public/client.js
// ------------------------------------------------------------------
// 브라우저 클라이언트 로직입니다.
// v6: 2장/3장 선택, 3장 공개패 선택, 낼 패 조합 선택, 구사 투표 UI 포함.
// ------------------------------------------------------------------

const socket = io();
let currentState = null;
let toastTimer = null;
let autoRestartInterval = null;
let lastTurnPlayerId = null;
let lastRoomStatus = null;
let audioUnlocked = false;
let audioContext = null;

const lobbyScreen = document.getElementById('lobbyScreen');
const gameScreen = document.getElementById('gameScreen');
const nicknameInput = document.getElementById('nicknameInput');
const gameModeSelect = document.getElementById('gameModeSelect');
const roomCodeInput = document.getElementById('roomCodeInput');
const createRoomBtn = document.getElementById('createRoomBtn');
const joinRoomBtn = document.getElementById('joinRoomBtn');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const myIdDisplay = document.getElementById('myIdDisplay');
const hostDisplay = document.getElementById('hostDisplay');
const modeDisplay = document.getElementById('modeDisplay');
const potDisplay = document.getElementById('potDisplay');
const currentBetDisplay = document.getElementById('currentBetDisplay');
const turnBanner = document.getElementById('turnBanner');
const autoRestartBanner = document.getElementById('autoRestartBanner');
const replayPanel = document.getElementById('replayPanel');
const replayInfoText = document.getElementById('replayInfoText');
const joinReplayBtn = document.getElementById('joinReplayBtn');
const playersList = document.getElementById('playersList');
const myCards = document.getElementById('myCards');
const myHandSummary = document.getElementById('myHandSummary');
const publicCardPanel = document.getElementById('publicCardPanel');
const handChoicePanel = document.getElementById('handChoicePanel');
const gusaVotePanel = document.getElementById('gusaVotePanel');
const logBox = document.getElementById('logBox');
const lastResultBox = document.getElementById('lastResultBox');
const startGameBtn = document.getElementById('startGameBtn');
const leaveRoomBtn = document.getElementById('leaveRoomBtn');
const callBtn = document.getElementById('callBtn');
const betBtn = document.getElementById('betBtn');
const foldBtn = document.getElementById('foldBtn');
const betAmountInput = document.getElementById('betAmountInput');
const quickAdd10Btn = document.getElementById('quickAdd10');
const quickAdd50Btn = document.getElementById('quickAdd50');
const quickAdd100Btn = document.getElementById('quickAdd100');
const quickAdd500Btn = document.getElementById('quickAdd500');
const developerPanel = document.getElementById('developerPanel');
const devTargetInput = document.getElementById('devTargetInput');
const devAmountInput = document.getElementById('devAmountInput');
const devSecretInput = document.getElementById('devSecretInput');
const devGrantBtn = document.getElementById('devGrantBtn');
const devResult = document.getElementById('devResult');
const toast = document.getElementById('toast');

nicknameInput.value = localStorage.getItem('sutdaNickname') || '';

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}

function switchToLobby() {
  lobbyScreen.classList.remove('hidden');
  gameScreen.classList.add('hidden');
  currentState = null;
  lastTurnPlayerId = null;
  lastRoomStatus = null;
  stopAutoRestartCountdown();
}
function switchToGame() { lobbyScreen.classList.add('hidden'); gameScreen.classList.remove('hidden'); }
function saveNickname() { const n = nicknameInput.value.trim(); if (n) localStorage.setItem('sutdaNickname', n); }
function escapeHtml(text) { return String(text).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }

function ensureAudio() {
  if (audioUnlocked) return;
  try { audioContext = new (window.AudioContext || window.webkitAudioContext)(); audioUnlocked = true; } catch (_) {}
}
function playTone(freq, duration = 0.12) {
  if (!audioUnlocked || !audioContext) return;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = 'sine'; osc.frequency.value = freq; gain.gain.value = 0.045;
  osc.connect(gain); gain.connect(audioContext.destination); osc.start(); osc.stop(audioContext.currentTime + duration);
}
function playMyTurnSound() { playTone(880, 0.16); setTimeout(() => playTone(1175, 0.12), 110); }
function playOtherTurnSound() { playTone(440, 0.08); }
function playRoundEndSound() { playTone(660, 0.12); setTimeout(() => playTone(520, 0.12), 120); }

function renderCardFront(card, extra = '') {
  const kwang = card.isKwang ? '<span class="kwang-mark">光</span>' : '';
  return `<div class="card front ${extra}" data-card-id="${escapeHtml(card.id)}"><div class="card-month">${card.month}월</div>${kwang}<div class="card-copy">${escapeHtml(card.copy || '')}</div></div>`;
}
function renderCardBack() { return '<div class="card back"><div class="back-pattern">섯다</div></div>'; }

function startAutoRestartCountdown(targetTime) {
  if (!targetTime) return stopAutoRestartCountdown();
  autoRestartBanner.classList.remove('hidden');
  if (autoRestartInterval) clearInterval(autoRestartInterval);
  const tick = () => {
    const remain = Math.max(0, Math.ceil((targetTime - Date.now()) / 1000));
    autoRestartBanner.textContent = remain > 0 ? `${remain}초 후 자동 시작됩니다.` : '곧 시작됩니다.';
  };
  tick();
  autoRestartInterval = setInterval(tick, 250);
}
function stopAutoRestartCountdown() {
  if (autoRestartInterval) clearInterval(autoRestartInterval);
  autoRestartInterval = null;
  autoRestartBanner.classList.add('hidden');
}

function renderTurnBanner(state) {
  turnBanner.className = 'turn-banner';
  if (state.pendingReplay) { turnBanner.textContent = '구사 재경기 대기 중입니다. 재참가 가능한 사람은 버튼을 눌러 참가하세요.'; turnBanner.classList.add('waiting'); return; }
  if (!state.game) { turnBanner.textContent = state.controls?.canStart ? '방장이 게임을 시작할 수 있습니다.' : '게임 시작을 기다리는 중입니다.'; turnBanner.classList.add('waiting'); return; }
  if (state.game.phase === 'reveal') {
    if (state.controls?.canReveal) { turnBanner.textContent = '3장 중 공개할 카드 1장을 선택하세요.'; turnBanner.classList.add('my-turn'); }
    else { turnBanner.textContent = '다른 플레이어가 공개패를 선택하는 중입니다.'; turnBanner.classList.add('other-turn'); }
    return;
  }
  if (state.game.phase === 'gusaVote') {
    if (state.controls?.canVote) { turnBanner.textContent = '구사 처리 방식을 투표하세요: 재경기 또는 판돈 분배'; turnBanner.classList.add('my-turn'); }
    else { turnBanner.textContent = '구사 투표 진행 중입니다.'; turnBanner.classList.add('other-turn'); }
    return;
  }
  if (state.controls?.canAct) { turnBanner.textContent = '내 차례입니다. 콜/베팅/다이를 선택하세요.'; turnBanner.classList.add('my-turn'); }
  else { turnBanner.textContent = state.game.currentTurnPlayerId ? `${state.game.currentTurnPlayerId}님의 차례입니다.` : '결과 처리 중입니다.'; turnBanner.classList.add('other-turn'); }
}

function renderMyCardsSection(state) {
  const cards = state.game?.myCards || [];
  publicCardPanel.classList.add('hidden');
  handChoicePanel.classList.add('hidden');
  gusaVotePanel.classList.add('hidden');

  if (!cards.length) {
    myHandSummary.textContent = '아직 받은 패가 없습니다.';
    myCards.innerHTML = '';
    return;
  }

  const publicId = state.game.myPublicCardId;
  myCards.innerHTML = cards.map((card) => renderCardFront(card, publicId === card.id ? 'public-selected' : '')).join('');

  const summary = state.game.myHandSummary;
  const selected = state.game.mySelectedHand;
  myHandSummary.innerHTML = selected
    ? `<strong>선택한 패:</strong> ${escapeHtml(selected.name)}<br /><span>${escapeHtml(selected.note || '')}</span>`
    : summary ? `${escapeHtml(summary.text)}<br /><span>${escapeHtml(summary.note || '')}</span>` : '패 확인 중';

  if (state.game.phase === 'reveal' && state.controls?.canReveal) {
    publicCardPanel.classList.remove('hidden');
    publicCardPanel.innerHTML = `<strong>공개할 카드 1장 선택</strong><div class="choice-row">${cards.map((card) => `<button class="choice-btn select-public-card" data-card-id="${escapeHtml(card.id)}">${card.month}월 ${card.copy}</button>`).join('')}</div>`;
  }

  if (state.game.gameMode === 'THREE' && ['betting','gusaVote','showdown'].includes(state.game.phase)) {
    const opts = state.game.myHandOptions || [];
    if (opts.length) {
      handChoicePanel.classList.remove('hidden');
      handChoicePanel.innerHTML = `<strong>낼 수 있는 2장 조합</strong><p class="small-label">9·9·4처럼 여러 선택지가 있으면 여기서 9땡/구사 중 선택하세요. 선택하지 않으면 자동 최고 조합으로 처리됩니다.</p>${opts.map((opt) => `<button class="combo-option ${state.game.mySelectedComboId === opt.comboId ? 'selected' : ''}" data-combo-id="${escapeHtml(opt.comboId)}"><span>${escapeHtml(opt.hand.name)}</span><small>${opt.cards.map(c => `${c.month}월`).join(' + ')}${opt.hand.replay ? ' · 구사 처리 대상' : ''}</small></button>`).join('')}`;
    }
  }

  if (state.game.phase === 'gusaVote') {
    const vote = state.game.gusaVote;
    gusaVotePanel.classList.remove('hidden');
    const myVote = vote?.myVote ? (vote.myVote === 'split' ? '분배' : '재경기') : '아직 선택 안 함';
    const disabled = state.controls?.canVote ? '' : 'disabled';
    gusaVotePanel.innerHTML = `<strong>구사 투표</strong><p>구사 플레이어: ${(vote?.replayPlayerIds || []).map(escapeHtml).join(', ')}</p><p>내 선택: ${myVote}</p><div class="choice-row"><button class="primary-btn vote-gusa" data-vote="replay" ${disabled}>재경기</button><button class="secondary-btn vote-gusa" data-vote="split" ${disabled}>판돈 분배</button></div><p class="small-label">투표가 동률이면 구사 뽑은 사람의 선택으로 결정됩니다.</p>`;
  }
}

function renderPlayers(state) {
  const orderedPlayers = [...state.players].sort((a,b)=>{ if(a.id===state.myId) return 1; if(b.id===state.myId) return -1; return 0; });
  playersList.innerHTML = orderedPlayers.map((p) => {
    const isTurn = state.game?.currentTurnPlayerId === p.id;
    const isMe = p.id === state.myId;
    const publicCards = p.publicCards?.length ? p.publicCards.map((c) => renderCardFront(c, 'public-card')).join('') : '';
    const revealed = p.revealedCards?.length ? p.revealedCards.map((c) => renderCardFront(c)).join('') : '';
    let hiddenCount = 0;
    if (!revealed && state.roomStatus === 'playing') hiddenCount = Math.max((p.cardCount || (state.gameMode === 'THREE' ? 3 : 2)) - (p.publicCards?.length || 0), 0);
    const hidden = new Array(hiddenCount).fill(0).map(() => renderCardBack()).join('');
    return `<div class="player-card ${isTurn ? 'turn' : ''} ${isMe ? 'me' : ''} ${p.allIn ? 'all-in-player' : ''} ${state.roomStatus === 'playing' && !p.inRound ? 'not-in-round' : ''}">
      <div class="player-row-top"><div><div class="player-name">${escapeHtml(p.id)}${isMe ? ' (나)' : ''}</div><div class="small-label">보유 ${p.pieces}조각 / 투입 ${p.totalContribution}조각</div></div><strong>${p.currentBet}조각</strong></div>
      <div class="player-badges">${state.hostId===p.id?'<span class="badge host">방장</span>':''}${isTurn?'<span class="badge turn">현재 차례</span>':''}${p.folded?'<span class="badge fold">다이</span>':''}${p.allIn?'<span class="badge allin">올인</span>':''}${p.replayParticipant?'<span class="badge replay-in">재경기 참가</span>':''}${p.replayJoinable?'<span class="badge replay-wait">재참가 가능</span>':''}${state.roomStatus==='playing'&&!p.inRound?'<span class="badge inactive">미참가</span>':''}${p.handName?`<span class="badge hand">${escapeHtml(p.handName)}</span>`:''}${p.selectedHandName?`<span class="badge hand">선택: ${escapeHtml(p.selectedHandName)}</span>`:''}</div>
      ${p.publicCards?.length ? '<div class="player-hand-note">공개패</div>' : ''}<div class="cards-row" style="margin-top:10px;">${revealed || publicCards + hidden}</div>
      ${state.roomStatus==='playing'&&!p.inRound?'<div class="player-hand-note inactive-note">이번 재경기에 참가하지 않아 베팅할 수 없습니다.</div>':''}
    </div>`;
  }).join('');
}

function renderLogs(state) {
  const items = state.messages || [];
  logBox.innerHTML = items.length ? items.map((item) => `<div class="log-item">${escapeHtml(item.text)}</div>`).join('') : '<div class="small-label">아직 로그가 없습니다.</div>';
  logBox.scrollTop = logBox.scrollHeight;
}

function renderLastResult(state) {
  const r = state.lastResult;
  if (!r) { lastResultBox.classList.add('hidden'); lastResultBox.innerHTML = ''; return; }
  const winnersHtml = r.replay ? `<strong>재경기</strong><br />유지 판돈 ${r.carryOverPot || r.pot}조각` : (r.winners || []).map((w) => `<strong>${escapeHtml(w.id)}</strong> (+${w.payout}조각, ${escapeHtml(w.handName)})`).join('<br />');
  const playersHtml = (r.players || []).map((p) => {
    const cards = p.cards?.length ? `<div class="cards-row" style="margin-top:8px;">${p.cards.map((c) => renderCardFront(c, p.publicCardId===c.id?'public-card':'')).join('')}</div>` : '<div class="small-label" style="margin-top:8px;">공개 카드 없음</div>';
    return `<div class="result-player"><div><strong>${escapeHtml(p.id)}</strong>${p.allIn?'<span class="badge allin" style="margin-left:8px;">올인</span>':''}</div><div class="small-label">${p.folded?'다이':(p.handName || '자동 승리')} / 총 투입 ${p.totalContribution}조각</div>${cards}</div>`;
  }).join('');
  lastResultBox.classList.remove('hidden');
  lastResultBox.innerHTML = `<h4>${r.replay?'재경기 안내':r.split?'판돈 분배 결과':'지난 판 결과'}</h4><div class="small-label">${escapeHtml(r.reason)}</div><div style="margin-top:8px;"><strong>판돈:</strong> ${r.pot}조각</div><div style="margin-top:8px;"><strong>${r.replay?'안내':'결과'}:</strong><br />${winnersHtml || '없음'}</div><div style="margin-top:12px;"><strong>패 공개</strong></div>${playersHtml}`;
}

function renderReplayPanel(state) {
  if (!state.pendingReplay || !state.replayInfo) { replayPanel.classList.add('hidden'); joinReplayBtn.disabled = true; return; }
  const info = state.replayInfo;
  replayPanel.classList.remove('hidden');
  replayInfoText.innerHTML = `<strong>구사 재경기 대기 중</strong><br />유지 판돈: ${info.deadPot || info.carryPot}조각<br />재참가 비용: ${info.joinFee}조각<br />현재 참가자: ${info.participants.length ? info.participants.map(escapeHtml).join(', ') : '없음'}<br />재참가 가능: ${info.joinable.length ? info.joinable.map(escapeHtml).join(', ') : '없음'}`;
  joinReplayBtn.disabled = !info.canJoin;
  joinReplayBtn.textContent = info.canJoin ? `재경기 참가 (${info.joinFee}조각)` : '재경기 참가 불가';
}

function renderButtons(state) {
  const canStart = !!state.controls?.canStart && !state.pendingReplay;
  const canAct = !!state.controls?.canAct;
  startGameBtn.disabled = !canStart; startGameBtn.style.opacity = canStart ? '1' : '0.5';
  [callBtn, betBtn, foldBtn, quickAdd10Btn, quickAdd50Btn, quickAdd100Btn, quickAdd500Btn].forEach((b) => { if (b) { b.disabled = !canAct; b.style.opacity = canAct ? '1' : '0.5'; } });
}
function renderDeveloperPanel(state) { developerPanel.classList.toggle('hidden', !state.developerTools?.enabled); }

function handleSoundByState(state) {
  const turn = state.game?.currentTurnPlayerId || null;
  const status = state.roomStatus;
  if (status === 'playing' && turn && turn !== lastTurnPlayerId) state.controls?.canAct ? playMyTurnSound() : playOtherTurnSound();
  if (lastRoomStatus === 'playing' && status === 'lobby' && state.lastResult) playRoundEndSound();
  lastTurnPlayerId = turn; lastRoomStatus = status;
}

function renderState(state) {
  switchToGame();
  roomCodeDisplay.textContent = state.roomCode || '-';
  myIdDisplay.textContent = state.myId || '-';
  hostDisplay.textContent = state.hostId || '-';
  modeDisplay.textContent = state.gameMode === 'THREE' ? '3장 섯다' : '2장 섯다';
  potDisplay.textContent = `${state.game?.pot || 0}조각`;
  currentBetDisplay.textContent = `${state.game?.currentBet || 0}조각`;
  renderTurnBanner(state); renderPlayers(state); renderMyCardsSection(state); renderLogs(state); renderLastResult(state); renderReplayPanel(state); renderDeveloperPanel(state); renderButtons(state);
  state.nextAutoStartAt ? startAutoRestartCountdown(state.nextAutoStartAt) : stopAutoRestartCountdown();
  handleSoundByState(state);
}

function addToBetInput(amount) { const cur = Number(betAmountInput.value || 0); betAmountInput.value = String((Number.isFinite(cur) ? cur : 0) + amount); betAmountInput.focus(); }
function validateAndEmitJoin(action) { ensureAudio(); const nickname = nicknameInput.value.trim(); if (!nickname) return showToast('닉네임을 입력해 주세요.'); saveNickname(); action(nickname); }

createRoomBtn.addEventListener('click', () => validateAndEmitJoin((nickname) => socket.emit('createRoom', { nickname, gameMode: gameModeSelect.value })));
joinRoomBtn.addEventListener('click', () => validateAndEmitJoin((nickname) => { const roomCode = roomCodeInput.value.trim().toUpperCase(); if (!roomCode) return showToast('방 코드를 입력해 주세요.'); socket.emit('joinRoom', { nickname, roomCode }); }));
startGameBtn.addEventListener('click', () => { ensureAudio(); socket.emit('startGame'); });
joinReplayBtn.addEventListener('click', () => { ensureAudio(); socket.emit('joinReplay'); });
leaveRoomBtn.addEventListener('click', () => socket.emit('leaveRoom'));
quickAdd10Btn.addEventListener('click', () => addToBetInput(10)); quickAdd50Btn.addEventListener('click', () => addToBetInput(50)); quickAdd100Btn.addEventListener('click', () => addToBetInput(100)); quickAdd500Btn.addEventListener('click', () => addToBetInput(500));
callBtn.addEventListener('click', () => socket.emit('gameAction', { type: 'call' }));
betBtn.addEventListener('click', () => socket.emit('gameAction', { type: 'bet', amount: betAmountInput.value.trim() }));
foldBtn.addEventListener('click', () => socket.emit('gameAction', { type: 'fold' }));
devGrantBtn.addEventListener('click', () => socket.emit('adminGrantPieces', { targetNickname: devTargetInput.value.trim(), amount: devAmountInput.value.trim(), secret: devSecretInput.value }));

document.addEventListener('click', (e) => {
  const publicBtn = e.target.closest('.select-public-card');
  if (publicBtn) { ensureAudio(); socket.emit('selectPublicCard', { cardId: publicBtn.dataset.cardId }); return; }
  const comboBtn = e.target.closest('.combo-option');
  if (comboBtn) { ensureAudio(); socket.emit('selectHandCombination', { comboId: comboBtn.dataset.comboId }); return; }
  const voteBtn = e.target.closest('.vote-gusa');
  if (voteBtn) { ensureAudio(); socket.emit('voteGusa', { vote: voteBtn.dataset.vote }); }
});

socket.on('roomState', (state) => { currentState = state; renderState(state); });
socket.on('leftRoom', switchToLobby);
socket.on('errorMessage', showToast);
socket.on('adminGrantResult', (result) => { devResult.textContent = `${result.targetNickname}님의 조각이 ${result.amount > 0 ? '+' : ''}${result.amount} 변경되었습니다. 현재 총 ${result.totalPieces}조각입니다.`; showToast('개발자 조각 변경 완료'); });
socket.on('connect_error', () => showToast('서버 연결에 실패했습니다.'));
socket.on('disconnect', () => showToast('서버와 연결이 끊어졌습니다.'));
