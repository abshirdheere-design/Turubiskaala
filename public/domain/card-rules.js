// Xeerarka kaararka Turubiskaala.
export const SUITS = ['♦', '♥', '♠', '♣'];
export const VALUES = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

export function getCardPoints(value) {
  if (['J', 'Q', 'K'].includes(value)) return 10;
  if (value === 'A') return 11;
  const points = Number.parseInt(value, 10);
  return Number.isNaN(points) ? 0 : points;
}

export function getCardValue(card) {
  const values = { A: 14, K: 13, Q: 12, J: 11 };
  return values[card?.value] ?? Number.parseInt(card?.value, 10);
}

export function createDeck(random = Math.random) {
  const deck = [];
  for (let copy = 0; copy < 4; copy++) {
    for (const suit of SUITS) {
      for (const value of VALUES) {
        deck.push({
          suit,
          value,
          id: `${suit}-${value}-${copy}-${random().toString(36).slice(2, 7)}`,
          points: getCardPoints(value),
        });
      }
    }
  }
  return shuffle(deck, random);
}

export function shuffle(cards, random = Math.random) {
  const result = [...cards];
  for (let index = result.length - 1; index > 0; index--) {
    const next = Math.floor(random() * (index + 1));
    [result[index], result[next]] = [result[next], result[index]];
  }
  return result;
}

export function isValidMeldSet(cards) {
  if (!Array.isArray(cards) || cards.length < 3 || cards.some(card => !card)) return false;

  const sameSuit = cards.every(card => card.suit === cards[0].suit);
  if (sameSuit) {
    const values = cards.map(getCardValue).sort((a, b) => a - b);
    return values.every((value, index) => index === 0 || value === values[index - 1] + 1);
  }

  const sameValue = cards.every(card => card.value === cards[0].value);
  const suits = new Set(cards.map(card => card.suit));
  return sameValue && suits.size === cards.length && cards.length <= 4;
}

export function prepareGame() {
  const deck = createDeck();
  const allHands = [];
  for (let index = 0; index < 4; index++) {
    allHands.push(deck.splice(0, index === 0 ? 15 : 14));
  }
  return { allHands, remainingDeck: deck };
}