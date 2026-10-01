/*
 * Game Over Explanation Engine
 *
 * Kani waa engine fasiraad ah oo keliya. Ma beddelo score, fooro, Dabaaq
 * ama history; wuxuu akhriyaa natiijada la dhammeeyay oo soo celiyaa
 * sharaxaad la fahmi karo oo ay UI-du soo bandhigi karto.
 */

function cleanName(value) {
  const name = String(value || '').trim();
  return name || null;
}

function scoreNet(score) {
  return (Number(score?.wins) || 0) - (Number(score?.fooros) || 0);
}

function formatDelta(delta) {
  const amount = Number(delta) || 0;
  if (amount > 0) return `+${amount}`;
  return String(amount);
}

export function explainGameOver(input = {}) {
  const winnerName = cleanName(input.winnerName) || 'Ciyaaryahanka guuleystay';
  const targetName = cleanName(input.fooroTargetName);
  const ownerName = cleanName(input.fooroOwnerName);
  const transferorName = cleanName(input.fooroTransferorName) || winnerName;
  const providerName = cleanName(input.providerName);
  const hoosgaleName = cleanName(input.hoosgaleName);
  const targetBefore = input.fooroTargetBefore;
  const targetAfter = input.fooroTargetAfter;
  const dabaaqPairs = Array.isArray(input.dabaaqPairs)
    ? input.dabaaqPairs
      .filter(pair => pair && pair.player1 && pair.player2)
      .map(pair => `${cleanName(pair.player1)} iyo ${cleanName(pair.player2)}`)
    : [];
  const facts = [];

  let type = 'normal';
  let summary = `${winnerName} ayaa ku guuleystay ciyaarta.`;

  if (input.allBatuuto) {
    type = 'all-batuuto';
    summary =
      `${winnerName} ayaa si automatic ah u guuleystay, sababtoo ah ` +
      'saddex ciyaaryahan ayaa BATUUTO noqday, isaga ayaana soo haray.';
  } else if (input.actionType === 'discard') {
    summary = providerName
      ? `${winnerName} ayaa ciyaarta ka xiray gacanta ${providerName}.`
      : `${winnerName} ayaa soo gabagabeeyay.`;
  }

  if (targetName) {
    if (providerName && input.providerOpened) {
      facts.push(
        `${providerName} oo kaarka soo tuuray ayaa degay; ` +
        `sidaas darteed ${targetName} ayaa lagu xiray.`
      );
    }

    const targetBeforeNet = scoreNet(targetBefore);
    const targetAfterNet = scoreNet(targetAfter);
    const fooroConsumedPositiveScore =
      targetBefore &&
      targetAfter &&
      targetBeforeNet > 0 &&
      targetAfterNet === 0 &&
      (Number(targetAfter.fooros) || 0) > (Number(targetBefore.fooros) || 0);

    if (fooroConsumedPositiveScore) {
      facts.push(
        `${targetName} wuxuu hore u lahaa +${targetBeforeNet}; ` +
        `Fooradii ayaa loo dhigay +${targetBeforeNet}, sidaasna wuxuu ku noqday +${targetAfterNet}.`
      );
    } else if (input.fooroReturnedToOwnerName) {
      const returnedTo = cleanName(input.fooroReturnedToOwnerName);
      facts.push(
        `Fooradii waxay ugu noqotay ${returnedTo || targetName}; qof kale looma wareejin.`
      );
    } else if (input.fooroWasTransferred) {
      facts.push(
        `Fooradu waxay ku dhacday ${targetName}; ${transferorName} ` +
        `ayaa wareejiyay Fooro uu lahaa ${ownerName || 'milkiile hore'}.`
      );
    } else {
      facts.push(
        `Fooro cusub ayaa ku dhacday ${targetName}; ` +
        `${winnerName} ayaa yeeshay Fooradaas.`
      );
    }
  }

  if (hoosgaleName) {
    facts.push(
      `${hoosgaleName} wuxuu noqday BATUUTO/Hoosgale; ` +
      'kaarkiisii ayaa dib loo celiyay, ciqaabtiisana waa la xisaabiyay.'
    );
  }

  if (dabaaqPairs.length) {
    facts.push(
      `DABAAQ ayaa u taalay: ${dabaaqPairs.join('; ')}. ` +
      'Haddii laba qof ama in kabadan ay u taalay dabaaq waxaa loo xisaabayaa kala horreynta.'
    );
  } else if (input.dabaaqType === 'positive' && input.dabaaqPair) {
    facts.push(
      `DABAAQ togan ayaa dhacday: ${input.dabaaqPair.player1} iyo ` +
      `${input.dabaaqPair.player2} ayaa lammaane DABAAQ noqday; ` +
      'guuleystaha wuxuu helay laba dhibcood, ciyaaryahanka kalena hal dhibic ayaa laga jaray.'
    );
  } else if (input.dabaaqType === 'negative' && input.dabaaqPair) {
    facts.push(
      `DABAAQ taban ayaa dhacay: ${input.dabaaqPair.player1} iyo ` +
      `${input.dabaaqPair.player2} ayaa labadooduba Fooro lahaa.`
    );
  }

  const scoreChanges = Object.values(input.roundDeltas || {})
    .filter(delta => delta && delta.name && Number(delta.delta))
    .map(delta => ({
      name: String(delta.name),
      delta: Number(delta.delta),
      text: `${delta.name}: ${formatDelta(delta.delta)}`,
    }));

  return {
    version: 1,
    type,
    title: 'FASIRAADDA GAME OVER',
    summary,
    facts,
    scoreChanges,
    winnerName,
    providerName,
    fooroTargetName: targetName,
    fooroOwnerName: ownerName,
    fooroWasTransferred: input.fooroWasTransferred === true,
    fooroTargetBefore: targetBefore || null,
    fooroTargetAfter: targetAfter || null,
    players: Array.isArray(input.players)
      ? input.players.map(player => ({
          name: cleanName(player?.name),
          net: scoreNet(player?.score),
        }))
      : [],
  };
}
