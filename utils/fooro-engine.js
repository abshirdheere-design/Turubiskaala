// utils/fooro-engine.js
import { applyCorrectDabaaqScores } from './dabaaq-engine.js';

/**
 * Maamulaha Foorada iyo Socodka Xiritaanka Gacanta
 */
export function handleRoundClosure({
    room,
    winnerName,
    providerName,
    victimName = null,
    helpers = {}
}) {
    const {
        normalizeSessionName = (name) => name?.toLowerCase(),
        ensureSessionScore = (scores, name) => scores[name],
        getXiiliSession,
        saveSessionsData
    } = helpers;

    const winnerKey = normalizeSessionName(winnerName);
    const scores = room.sessionScores || {};

    // 1. Hubi marka hore in qof hoosgale yahay
    const hoosgalePlayer = room.players?.find(
        player => normalizeSessionName(player?.name) !== winnerKey && player?.hoosgale
    );

    // 2. Hubi qofka kugu xiga in uu degay (iyo xaaladda ciyaartoyda kale)
    // Tusaale: Hubinta in ciyaartoydu degeen ama aysan degin
    const playersStatus = room.players || [];
    const nonWinners = playersStatus.filter(p => normalizeSessionName(p.name) !== winnerKey);
    const allDegay = nonWinners.every(p => p.degay); // Tusaale haddii ay wada degeen

    // 3. Hubi haddii 3da qof degtay (ama ciyaartoyda kale wada degeen) in midka ugu tirada badan dhibcaha foorda ku dhacdo
    let targetVictim = victimName;
    if (allDegay && nonWinners.length > 0)  {
        // Tusaale: Raadi kan leh kaararka ama dhibcaha ugu badan ee ku dhacay
        // (Waxaada ku saleysan shuruudahaaga gaarka ah ee dhibcaha harsan)
    }

    // 4. Hubi qofka degay ee aan foorada ku dhicin ma dabaaq baa idiin taalay, 
    //    haddii ay dabaaq jirtay wac function-ka dabaaqda.
    const target = room.xiiliTarget || 5;
    const season = getXiiliSession ? getXiiliSession(target) : null;

    let dabaaqResult = null;
    let hasActiveDabaaq = false;

    if (season && Array.isArray(season.dabaaqPairs)) {
        hasActiveDabaaq = season.dabaaqPairs.some(
            pair => normalizeSessionName(pair.player1) === winnerKey || normalizeSessionName(pair.player2) === winnerKey
        );
    }

    if (hasActiveDabaaq) {
        // Haddii dabaaq jirtay, u gudbi xisaabta dabaqda
        dabaaqResult = applyCorrectDabaaqScores({
            io: null, // Waxaa laga soo gudbin karaa server-ka
            room,
            winnerName,
            providerName,
            victimName: targetVictim,
            ...helpers
        });
        return dabaaqResult;
    } else {
        // Haddii aysan dabaaq jirin, halkan waxaa lagu fuliyaa xisaabta caadiga ah 
        // ee foorada iyo guusha (tusaale: Abshir oo -2 ka noqonaya -1 marka uu xiro).
        const winnerScore = ensureSessionScore(scores, winnerName);
        if (winnerScore) {
            if ((Number(winnerScore.fooros) || 0) > 0) {
                winnerScore.fooros = Math.max(0, (Number(winnerScore.fooros) || 0) - 1);
            } else {
                winnerScore.wins = (Number(winnerScore.wins) || 0) + 1;
            }
        }

        if (saveSessionsData) {
            saveSessionsData();
        }

        return {
            scores: room.sessionScores,
            dabaaqType: 'none',
            deltas: {}
        };
    }
}