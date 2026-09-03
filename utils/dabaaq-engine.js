// utils/dabaaq-engine.js

/**
 * Xisaabiyaha rasmiga ah ee Dabaaq, Foorada, iyo Guusha (Single Source of Truth)
 */
export function applyCorrectDabaaqScores({
    io,
    room,
    winnerName,
    providerName,
    victimName = null,
    getXiiliSession,
    attachRoomToXiiliSession,
    normalizeSessionName,
    ensureSessionScore,
    fooroOwnersFor,
    applyWinnerScore,
    canonicalScore,
    rebalanceScoreMap,
    addScoreDelta,
    saveSessionsData
}) {
    console.log('DABAAQ IN:', {
        winnerName,
        providerName,
        victimName
    });

    const target = room.xiiliTarget || 5;
    const season = getXiiliSession(target);

    if (season?.ended) {
        return {
            scores: room.sessionScores,
            deltas: {},
            dabaaqType: null
        };
    }

    attachRoomToXiiliSession(room, target);

    if (!Array.isArray(season.dabaaqPairs)) {
        season.dabaaqPairs = [];
    }

    const scores = JSON.parse(JSON.stringify(room.sessionScores || {}));
    const beforeScores = room.sessionScores || {};
    const deltas = {};

    const winner = ensureSessionScore(scores, winnerName);

    if (!winner) {
        return {
            scores: room.sessionScores,
            deltas,
            dabaaqType: null
        };
    }

    const winnerKey = normalizeSessionName(winnerName);
    const winnerPlayer = room.players?.find(
        player => normalizeSessionName(player?.name) === winnerKey
    );
    const hoosgalePlayer = room.players?.find(
        player => player?.id !== winnerPlayer?.id && player?.hoosgale
    );
    const netOf = score =>
        (Number(score?.wins) || 0) - (Number(score?.fooros) || 0);
    const scoreSnapshot = (name, scoreMap) => {
        const key = normalizeSessionName(name);
        const score = key ? scoreMap?.[key] : null;
        return {
            name,
            net: netOf(score),
            wins: Number(score?.wins) || 0,
            fooros: Number(score?.fooros) || 0,
        };
    };
    // Haddii owner-kii foorada uusan ku jirin session-kii hore, provider-ka
    // ayaa ah fallback-ka saxda ah marka fooradu ku dhacday isla provider-ka.
    // Ha ku qorin guuleystaha si toos ah, sababtoo ah taas waxay UI-ga ka
    // dhigi jirtay: “Jaamac ayaa wareejiyay fooro uu lahaa Jaamac”.
    const ownerFallbackName =
        providerName &&
        victimName &&
        normalizeSessionName(providerName) === normalizeSessionName(victimName)
            ? providerName
            : winnerName;
    const winnerFooroOwners = fooroOwnersFor(winner, ownerFallbackName);
    const winnerHadFooro = (Number(winner.fooros) || 0) > 0;
    let transferredFooroOwnerName = null;
    let fooroWasTransferred = false;
    let fooroReturnedToOwnerName = null;

    // 1. MARKA HORE: raadi Dabaaq hore loo kaydiyay
    let dabaaqPairIndex = -1;
    let dabaaqPair = null;
    const rawPendingPairs = Array.isArray(room.activeDabaaqPairs) && room.activeDabaaqPairs.length
        ? room.activeDabaaqPairs
        : season.dabaaqPairs;
    const pendingPairs = [];
    const pairedPlayers = new Set();
    for (const pair of rawPendingPairs || []) {
        const p1 = normalizeSessionName(pair?.player1);
        const p2 = normalizeSessionName(pair?.player2);
        if (!p1 || !p2 || p1 === p2 || pairedPlayers.has(p1) || pairedPlayers.has(p2)) {
            continue;
        }
        pendingPairs.push(pair);
        pairedPlayers.add(p1);
        pairedPlayers.add(p2);
    }

        for (let i = 0; i < pendingPairs.length; i++) {
        const pair = pendingPairs[i];
        const p1 = normalizeSessionName(pair.player1);
        const p2 = normalizeSessionName(pair.player2);
            const pairHasWinner = winnerKey === p1 || winnerKey === p2;
            const pairOtherKey = winnerKey === p1 ? p2 : p1;
            const victimKey = normalizeSessionName(victimName);
            const providerKey = normalizeSessionName(providerName);

        // Dabaaqdu waxay khuseysaa winner-ka iyo provider-ka saxda ah oo keliya.
        if (
                pairHasWinner &&
                (pairOtherKey === victimKey || (!victimKey && pairOtherKey === providerKey))
        ) {
            dabaaqPairIndex = i;
            dabaaqPair = pair;
            break;
        }
    }

    /*
     * Provider-ka iyo qofka Dabaaqda ku lammaan mar walba isku qof ma aha.
     * Haddii Faarax yahay provider-ka, laakiin Abshir iyo Jaamac ay yihiin
     * labada score ee taban, pair-ka saxda ahi waa Abshir-Jaamac.
     */
    if (!dabaaqPair) {
        for (let i = 0; i < pendingPairs.length; i++) {
            const pair = pendingPairs[i];
            const p1 = normalizeSessionName(pair?.player1);
            const p2 = normalizeSessionName(pair?.player2);
            const pairHasWinner = winnerKey === p1 || winnerKey === p2;
            if (!pairHasWinner) continue;

            const pairOtherKey = winnerKey === p1 ? p2 : p1;
            const otherScore = scores[pairOtherKey];
            const otherNet = netOf(otherScore);
            const winnerNet = netOf(winner);

            const isNegativeDabaaq =
                pair.type === 'negative_negative' &&
                winnerNet < 0 &&
                otherNet < 0;
            const isPositiveDabaaq =
                pair.type === 'positive_positive' &&
                ((winnerNet > 0 && otherNet > 0 && winnerNet === otherNet) ||
                    (winnerNet === 1 && otherNet > 0) ||
                    (otherNet === 1 && winnerNet > 0));

            if (isNegativeDabaaq || isPositiveDabaaq) {
                dabaaqPairIndex = i;
                dabaaqPair = pair;
                break;
            }
        }
    }

    // Haddii snapshot-ku duugoobay, samee pair-ka saxda ah hadda.
    // Ha ka soo qaadan pair uu winner-ku keligiis ku jiro.
    if (!dabaaqPair) {
        const relatedNames = [victimName, providerName]
            .filter(Boolean)
            .filter(name => normalizeSessionName(name) !== winnerKey);
        for (const relatedName of relatedNames) {
            const relatedKey = normalizeSessionName(relatedName);
            const relatedScore = scores[relatedKey];
            const winnerNet = netOf(winner);
            const relatedNet = netOf(relatedScore);
            const isPositivePair =
                (winnerNet > 0 && relatedNet > 0 && winnerNet === relatedNet) ||
                (winnerNet === 1 && relatedNet > 0) ||
                (relatedNet === 1 && winnerNet > 0);
            const isNegativePair = winnerNet < 0 && relatedNet < 0;
            if (isPositivePair || isNegativePair) {
                dabaaqPair = {
                    player1: winnerName,
                    player2: relatedName,
                    type: isPositivePair ? 'positive_positive' : 'negative_negative',
                    amount: isNegativePair
                        ? Math.min(Math.abs(winnerNet), Math.abs(relatedNet))
                        : 2,
                };
                break;
            }
        }
    }

    // 2. SCORE-KA CIYAARTA CUSUB
    const winnerBefore = netOf(winner);
    const winnerAfterScore = {
        wins: Number(winner.wins) || 0,
        fooros: Number(winner.fooros) || 0,
        displayName: winner.displayName || winnerName,
    };
    applyWinnerScore(winnerAfterScore);
    let winnerAfter = netOf(winnerAfterScore);

    // 3. HADDII DABAAQ JIRO
    let dabaaqType = null;
    let positiveDabaaqApplied = false;

    if (dabaaqPair) {
        dabaaqType = dabaaqPair.type === 'positive_positive' ? 'positive' : 'negative';

        const otherName =
            normalizeSessionName(dabaaqPair.player1) === winnerKey
                ? dabaaqPair.player2
                : dabaaqPair.player1;

        const otherKey = normalizeSessionName(otherName);
        const otherScore = ensureSessionScore(scores, otherName);

        if (dabaaqPair.type === 'positive_positive') {
            const otherBefore = netOf(otherScore);

            if (winnerBefore > 0 && winnerBefore === otherBefore) {
                // Tusaale +2/+2: winner-ku wuxuu helayaa +5,
                // qofka kale dhibcihiisana eber ayaa loo celiyaa.
                winnerAfter = winnerBefore + otherBefore + 1;

                if (otherScore) {
                    scores[otherKey] = {
                        ...canonicalScore(0),
                        fooroOwners: [],
                        displayName: otherScore.displayName || otherName,
                    };
                }

                positiveDabaaqApplied = true;
            } else if (winnerBefore === 1 && otherBefore >= 1) {
                winnerAfter = winnerBefore + 2;

                if (otherScore) {
                    const otherAfter = Math.max(0, otherBefore - 1);
                    scores[otherKey] = {
                        ...canonicalScore(otherAfter),
                        fooroOwners: fooroOwnersFor(otherScore).slice(
                            0,
                            Math.max(0, -otherAfter)
                        ),
                        displayName: otherScore.displayName || otherName,
                    };
                }

                positiveDabaaqApplied = true;
            } else {
                winnerAfter = winnerBefore + 1;
            }

            console.log('🟢 POSITIVE DABAAQ LA QAATAY:', {
                winner: winnerName,
                other: otherName,
                result: winnerAfter
            });
        }
        else if (dabaaqPair.type === 'negative_negative') {
            // Amount-ka dib uga xisaabi score-ka hore; snapshot-ku wuu duugoobi karaa.
            const otherBefore = netOf(otherScore);
            const dabaaqAmount = Math.max(
                1,
                Math.min(Math.abs(winnerBefore), Math.abs(otherBefore))
            );
            const winnerBeforeFooros = Number(winner.fooros) || 0;
            const extraFooroToAdd = dabaaqAmount;
            
            // Guusha caadiga ah iyo Dabaaqdu waxay ka jaraan laba fooro:
            // tusaale -2 -> 0. Foorada dheeraadka ahi waxay ku dhacaysaa
            // qofka kale ee pair-ka ku jira.
             // Negative Dabaaqdu waxay siin kartaa guuleystaha ugu badnaan +1:
             // -1 -> +1, -2 -> 0, -3 -> -1.
             winnerAfter = Math.min(1, winnerBefore + 2);

            if (otherScore) {
                scores[otherKey] = {
                    wins: 0,
                    fooros: (Number(otherScore.fooros) || 0) + dabaaqAmount,
                    fooroOwners: fooroOwnersFor(otherScore).concat([winnerName]).slice(0, target),
                    displayName: otherScore.displayName || otherName
                };
            }

            console.log('🔴 NEGATIVE DABAAQ FIXED:', {
                winner: winnerName,
                other: otherName,
                winnerResult: winnerAfter
            });
        }

        const samePair = pair => {
            const a = normalizeSessionName(pair?.player1);
            const b = normalizeSessionName(pair?.player2);
            const x = normalizeSessionName(dabaaqPair?.player1);
            const y = normalizeSessionName(dabaaqPair?.player2);
            return (a === x && b === y) || (a === y && b === x);
        };
        season.dabaaqPairs = season.dabaaqPairs.filter(pair => !samePair(pair));
        if (Array.isArray(room.activeDabaaqPairs)) {
            room.activeDabaaqPairs = room.activeDabaaqPairs.filter(pair => !samePair(pair));
        }
    }

    if (hoosgalePlayer) {
        const hoosgaleScore = ensureSessionScore(scores, hoosgalePlayer.name);
        if (hoosgaleScore) {
            const isAlreadyFooroVictim =
                normalizeSessionName(victimName) === normalizeSessionName(hoosgalePlayer.name);

            // Haddii Hoosgale-gu yahay victim-ka Foorada, hal Fooro ayaa
            // ku filan. Wins-- dheeraad ah wuxuu noqonayaa ciqaab labaad.
            if (!isAlreadyFooroVictim && (Number(hoosgaleScore.wins) || 0) > 0) {
                hoosgaleScore.wins = Math.max(0, (Number(hoosgaleScore.wins) || 0) - 1);
            }
            console.log('🟣 HOOSGALE FOORO:', {
                player: hoosgalePlayer.name,
                result: netOf(hoosgaleScore),
                fooroTarget: victimName || null,
                fooroAlreadyPlanned: isAlreadyFooroVictim
            });
        }
    }

    // 4. UGU DAMBAYN: wareeji ama baabi'i foorada
    const victimKey = normalizeSessionName(victimName);
    if (victimKey && victimKey !== winnerKey) {
        const victim = ensureSessionScore(scores, victimName);
        if (victim) {
            /*
             * Kala saar qofka hadda foorada hayay iyo milkiilihii
             * foorada. Haddii winner-ku uusan fooro hore u haysan,
             * fooradani waa mid cusub ee ma aha fooro qof kale lahaa.
             */
            fooroWasTransferred = winnerHadFooro;
            transferredFooroOwnerName =
                winnerHadFooro
                    ? winnerFooroOwners.shift() || winnerName
                    : winnerName;

            // Haddii Fooradu ugu noqoto milkiilihii hore, weli waa Fooro
            // cusub oo ku dhacday qofkaas. Tusaale ahaan -4 -> -5.
            victim.fooros = (Number(victim.fooros) || 0) + 1;
            victim.fooroOwners = [
                ...fooroOwnersFor(victim),
                transferredFooroOwnerName
            ].slice(0, victim.fooros);
        }
    }

    // 5. Ku qor winner-ka score-kiisa
    const winnerCanonical = canonicalScore(winnerAfter);
    winnerCanonical.fooroOwners = winnerFooroOwners.slice(
        0,
        winnerCanonical.fooros
    );

    scores[winnerKey] = {
        wins: winnerCanonical.wins,
        fooros: winnerCanonical.fooros,
        fooroOwners: winnerCanonical.fooroOwners,
        displayName: winner.displayName || winnerName
    };

    const balanceFix = positiveDabaaqApplied
        ? null
        : rebalanceScoreMap(scores, winnerName);
    if (balanceFix) {
        console.log('⚖️ SESSION SCORE BALANCED:', balanceFix);
    }

    Object.keys(deltas).forEach(key => delete deltas[key]);
    const scoreKeys = new Set([
        ...Object.keys(beforeScores),
        ...Object.keys(scores),
    ]);
    scoreKeys.forEach(key => {
        const before = beforeScores[key] || {};
        const after = scores[key] || {};
        const winsDelta = (Number(after.wins) || 0) - (Number(before.wins) || 0);
        const foorosDelta = (Number(after.fooros) || 0) - (Number(before.fooros) || 0);
        const netDelta = (winsDelta - foorosDelta);
        if (winsDelta || foorosDelta || netDelta) {
            addScoreDelta(deltas, after.displayName || before.displayName || key, {
                wins: winsDelta,
                fooros: foorosDelta,
                net: netDelta,
            });
        }
    });

    // 6. Session-ka ku celi
    season.scores = scores;
    room.sessionScores = season.scores;

    saveSessionsData();

    if (io && room.id) {
        io.to(room.id).emit('updateScores', {
            sessionScores: room.sessionScores,
            xiiliTarget: target
        });
    }

    const loserEntry = Object.entries(room.sessionScores).find(
        ([, score]) => (Number(score?.fooros) || 0) >= target
    );

    if (loserEntry && !season.ended) {
        const [loserKey] = loserEntry;
        season.ended = true;
        saveSessionsData();

        if (io && room.id) {
            io.to(room.id).emit('seasonEnded', {
                loser: room.sessionScores[loserKey]?.displayName || loserKey,
                scores: room.sessionScores,
                target
            });
        }
    }

    return {
        scores: room.sessionScores,
        deltas,
        dabaaqType,
        dabaaqPair: dabaaqPair
            ? {
                player1: dabaaqPair.player1,
                player2: dabaaqPair.player2,
                type: dabaaqPair.type,
                amount: dabaaqPair.amount || 2,
                player1Before: scoreSnapshot(dabaaqPair.player1, beforeScores),
                player2Before: scoreSnapshot(dabaaqPair.player2, beforeScores),
                player1After: scoreSnapshot(dabaaqPair.player1, scores),
                player2After: scoreSnapshot(dabaaqPair.player2, scores),
            }
            : null,
        fooroOwnerName: transferredFooroOwnerName,
        fooroTransferorName: fooroWasTransferred ? winnerName : null,
        fooroWasTransferred,
        fooroReturnedToOwnerName,
    };
}

export function simulateAndApplyDabaaq(
    io,
    room,
    winnerName,
    dabaaqOwnerName,
    victimFooroName = null,
    helpers = {}
) {
    return applyCorrectDabaaqScores({
        io,
        room,
        winnerName,
        providerName: dabaaqOwnerName,
        victimName: victimFooroName,
        ...helpers
    });
}

export function applyDabaaq(
    io,
    room,
    winnerName,
    dabaaqProviderName,
    victimFooroName = null,
    helpers = {}
) {
    return simulateAndApplyDabaaq(
        io,
        room,
        winnerName,
        dabaaqProviderName,
        victimFooroName,
        helpers
    );
}