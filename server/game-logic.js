// server/game-logic.js
// -----------------------------------------------------------------------------
// 섯다 규칙 모듈입니다.
// - 2장 섯다: 카드 2장 그대로 족보 판정
// - 3장 섯다: 3장 중 2장 조합 3개를 만들고, 플레이어가 낼 조합을 선택 가능
// - 특수룰: 암행어사(4·7)는 광땡을 잡고, 땡잡이(3·7)는 일반 땡을 잡습니다.
// - 구사(4·9) / 멍텅구리 구사(4·9 중 특정 복사 조합)는 재경기 투표 대상으로 표시합니다.
// -----------------------------------------------------------------------------

function createDeck() {
  const deck = [];
  for (let month = 1; month <= 10; month += 1) {
    deck.push({ id: `${month}-A`, month, copy: 'A', isKwang: month === 1 || month === 3 || month === 8 });
    deck.push({ id: `${month}-B`, month, copy: 'B', isKwang: false });
  }
  return deck;
}

function shuffleDeck(deck) {
  const arr = [...deck];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function drawCards(deck, count) {
  const cards = [];
  for (let i = 0; i < count; i += 1) {
    const card = deck.shift();
    if (!card) break;
    cards.push(card);
  }
  return cards;
}

function getSortedMonths(cards) {
  return cards.map((c) => c.month).sort((a, b) => a - b);
}

function isExactPair(cards, a, b) {
  const months = getSortedMonths(cards);
  return months[0] === Math.min(a, b) && months[1] === Math.max(a, b);
}

function isDdang(cards, month) {
  return cards[0].month === month && cards[1].month === month;
}

function getKwangDdangName(cards) {
  const allKwang = cards.every((c) => c.isKwang);
  if (!allKwang) return null;
  if (isExactPair(cards, 3, 8)) return '3·8광땡';
  if (isExactPair(cards, 1, 8)) return '1·8광땡';
  if (isExactPair(cards, 1, 3)) return '1·3광땡';
  return null;
}

function makeHand({ rankValue, name, type, note, cards, replay = false, catcher = null }) {
  return { rankValue, name, type, note, cards, replay, catcher };
}

function evaluateHand(cards) {
  if (!cards || cards.length !== 2) throw new Error('evaluateHand에는 반드시 카드 2장이 필요합니다.');

  const kwangDdang = getKwangDdangName(cards);
  if (kwangDdang) {
    const valueMap = { '3·8광땡': 100, '1·8광땡': 99, '1·3광땡': 98 };
    return makeHand({ rankValue: valueMap[kwangDdang], name: kwangDdang, type: '광땡', note: '최상급 광땡 패입니다.', cards });
  }

  for (let month = 10; month >= 1; month -= 1) {
    if (isDdang(cards, month)) {
      return makeHand({ rankValue: 80 + month, name: month === 10 ? '장땡' : `${month}땡`, type: '땡', note: '같은 월 두 장으로 만든 땡 패입니다.', cards });
    }
  }

  if (isExactPair(cards, 4, 7)) {
    return makeHand({ rankValue: 42, name: '암행어사', type: '특수', note: '특수룰: 광땡을 잡습니다.', cards, catcher: 'gwang' });
  }

  if (isExactPair(cards, 3, 7)) {
    return makeHand({ rankValue: 41, name: '땡잡이', type: '특수', note: '특수룰: 모든 일반 땡을 잡습니다.', cards, catcher: 'ddang' });
  }

  const specialHands = [
    { pair: [1, 2], name: '알리', rankValue: 79, note: '강한 특수 족보입니다.' },
    { pair: [1, 4], name: '독사', rankValue: 78, note: '강한 특수 족보입니다.' },
    { pair: [1, 9], name: '구삥', rankValue: 77, note: '강한 특수 족보입니다.' },
    { pair: [1, 10], name: '장삥', rankValue: 76, note: '강한 특수 족보입니다.' },
    { pair: [4, 10], name: '장사', rankValue: 75, note: '강한 특수 족보입니다.' },
    { pair: [4, 6], name: '세륙', rankValue: 74, note: '강한 특수 족보입니다.' },
  ];

  for (const hand of specialHands) {
    if (isExactPair(cards, hand.pair[0], hand.pair[1])) {
      return makeHand({ rankValue: hand.rankValue, name: hand.name, type: '특수', note: hand.note, cards });
    }
  }

  if (isExactPair(cards, 4, 9)) {
    const isMeongteongguri = cards.some((c) => c.month === 4 && c.copy === 'A') && cards.some((c) => c.month === 9 && c.copy === 'A');
    return makeHand({
      rankValue: 10,
      name: isMeongteongguri ? '멍텅구리 구사' : '구사',
      type: '구사',
      note: isMeongteongguri ? '멍텅구리 구사입니다. 일반 구사와 구분 표시됩니다.' : '구사입니다. 재경기/분배 투표 대상입니다.',
      cards,
      replay: true,
    });
  }

  const points = (cards[0].month + cards[1].month) % 10;
  return makeHand({
    rankValue: 60 + points,
    name: points === 9 ? '갑오' : points === 0 ? '망통' : `${points}끗`,
    type: '끗',
    points,
    note: points === 9 ? '끗 패 중 가장 높은 갑오입니다.' : `${points}끗 상태입니다.`,
    cards,
  });
}

function compareHands(a, b) {
  if (a.catcher === 'gwang' && b.type === '광땡') return 1;
  if (b.catcher === 'gwang' && a.type === '광땡') return -1;
  if (a.catcher === 'ddang' && b.type === '땡') return 1;
  if (b.catcher === 'ddang' && a.type === '땡') return -1;
  if (a.rankValue > b.rankValue) return 1;
  if (a.rankValue < b.rankValue) return -1;
  return 0;
}

function findWinners(playerHands) {
  if (!playerHands || playerHands.length === 0) return [];
  let best = playerHands[0].hand;
  for (let i = 1; i < playerHands.length; i += 1) {
    if (compareHands(playerHands[i].hand, best) === 1) best = playerHands[i].hand;
  }
  return playerHands.filter((entry) => compareHands(entry.hand, best) === 0);
}

function formatCard(card) {
  return { id: card.id, month: card.month, label: `${card.month}월`, isKwang: card.isKwang, copy: card.copy };
}

function getCombinationId(cards) {
  return cards.map((c) => c.id).sort().join('|');
}

function getTwoCardCombinations(cards) {
  if (!cards || cards.length < 2) return [];
  const combos = [];
  for (let i = 0; i < cards.length; i += 1) {
    for (let j = i + 1; j < cards.length; j += 1) combos.push([cards[i], cards[j]]);
  }
  return combos;
}

function getHandOptions(cards) {
  return getTwoCardCombinations(cards).map((combo) => {
    const hand = evaluateHand(combo);
    const usedIds = new Set(combo.map((c) => c.id));
    const leftover = cards.filter((c) => !usedIds.has(c.id));
    return {
      comboId: getCombinationId(combo),
      cards: combo.map(formatCard),
      leftover: leftover.map(formatCard),
      hand: { name: hand.name, type: hand.type, note: hand.note, replay: !!hand.replay, catcher: hand.catcher || null, rankValue: hand.rankValue },
    };
  }).sort((a, b) => -compareHands({ ...a.hand, cards: a.cards }, { ...b.hand, cards: b.cards }));
}

function getBestHandFromCards(cards) {
  const options = getTwoCardCombinations(cards).map((combo) => evaluateHand(combo));
  if (options.length === 0) throw new Error('족보를 만들 수 없습니다.');
  let best = options[0];
  for (let i = 1; i < options.length; i += 1) if (compareHands(options[i], best) === 1) best = options[i];
  return best;
}

function getSelectedHand(cards, selectedComboId) {
  if (!selectedComboId) return getBestHandFromCards(cards);
  const combo = getTwoCardCombinations(cards).find((c) => getCombinationId(c) === selectedComboId);
  if (!combo) return getBestHandFromCards(cards);
  return evaluateHand(combo);
}

function summarizeHand(cards, selectedComboId = null) {
  if (!cards || cards.length < 2) return null;
  const hand = cards.length === 2 ? evaluateHand(cards) : getSelectedHand(cards, selectedComboId);
  const months = hand.cards.map((card) => `${card.month}월`).join(' + ');
  const extra = cards.length === 3 && !selectedComboId ? '자동 최고 조합: ' : '';
  return { name: hand.name, type: hand.type, note: hand.note || '', replay: !!hand.replay, text: `${extra}${months} = ${hand.name}` };
}

module.exports = {
  createDeck,
  shuffleDeck,
  drawCards,
  evaluateHand,
  compareHands,
  findWinners,
  formatCard,
  summarizeHand,
  getHandOptions,
  getSelectedHand,
  getBestHandFromCards,
  getCombinationId,
};
