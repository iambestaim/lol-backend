// Szükséges csomagok betöltése
require('dotenv').config(); // .env fájl tartalmának betöltése
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const mongoose = require('mongoose');

// Express alkalmazás létrehozása
const app = express();
const PORT = 3000; // Ezen a porton fog futni a szerverünk

// API kulcs és régió beállítása
// A .trim() eltávolítja a láthatatlan szóközöket és sortöréseket a kulcs végéről!
const RIOT_API_KEY = process.env.RIOT_API_KEY ? process.env.RIOT_API_KEY.trim() : null;

// --- DEBUGGING LÉPÉS ---
console.log(`A szerver a következő API kulcsot próbálja használni (részlet): ${RIOT_API_KEY ? RIOT_API_KEY.substring(0, 10) + '...' : 'NINCS KULCS'}`);

// Ellenőrizzük, hogy az API kulcs be van-e töltve
if (!RIOT_API_KEY) {
  console.error("HIBA: A RIOT_API_KEY környezeti változó nincs beállítva! Ellenőrizd a .env fájlt.");
  process.exit(1); // Leállítjuk a szervert, ha nincs kulcs.
}

// --- ADATBÁZIS CSATLAKOZÁS ÉS BEÁLLÍTÁS ---
const MONGO_URI = process.env.MONGO_URI;
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Sikeresen csatlakozva a MongoDB adatbázishoz!'))
    .catch(err => console.error('❌ MongoDB csatlakozási hiba:', err));
} else {
  console.log('⚠️ Nincs MONGO_URI beállítva. Az adatgyűjtés szünetel.');
}

// Adatbázis séma (Hogyan nézzen ki egy mentett rang-rekord)
const playerHistorySchema = new mongoose.Schema({
  puuid: String,
  riotId: String,
  region: String,
  queueType: { type: String, default: 'RANKED_SOLO_5x5' },
  date: { type: Date, default: Date.now },
  tier: String,
  rank: String,
  leaguePoints: Number,
  wins: Number,
  losses: Number,
  matchId: String
});
const PlayerHistory = mongoose.model('PlayerHistory', playerHistorySchema);

// LP Számoló segédfüggvény (hogy a divízió lépéseket is jól számolja)
const TIER_VALUES = { "IRON": 0, "BRONZE": 400, "SILVER": 800, "GOLD": 1200, "PLATINUM": 1600, "EMERALD": 2000, "DIAMOND": 2400, "MASTER": 2800, "GRANDMASTER": 2800, "CHALLENGER": 2800 };
const RANK_VALUES = { "IV": 0, "III": 100, "II": 200, "I": 300 };
function calculateAbsoluteLp(tier, rank, lp) {
    if (["MASTER", "GRANDMASTER", "CHALLENGER"].includes(tier.toUpperCase())) return TIER_VALUES[tier.toUpperCase()] + lp;
    return (TIER_VALUES[tier.toUpperCase()] || 0) + (RANK_VALUES[rank.toUpperCase()] || 0) + lp;
}

const platformToRegional = {
  'eun1': 'europe', 'euw1': 'europe', 'tr1': 'europe', 'ru': 'europe',
  'na1': 'americas', 'br1': 'americas', 'la1': 'americas', 'la2': 'americas',
  'oc1': 'sea', 'ph2': 'sea', 'sg2': 'sea', 'tw2': 'sea', 'th2': 'sea', 'vn2': 'sea',
  'jp1': 'asia', 'kr': 'asia',
};

// Middleware-ek használata
app.use(cors()); // CORS engedélyezése, hogy a frontend elérje a backendet

// Egy végpont (endpoint) definiálása a játékos adatok lekérésére
app.get('/summoner/:region/:riotId', async (req, res) => {
  const region = req.params.region; // Kiválasztott szerver (pl. eun1)
  const riotId = req.params.riotId;
  
  let gameName = riotId;
  let tagLine = '';
  
  if (riotId.includes('#')) {
    [gameName, tagLine] = riotId.split('#');
  } else {
    const defaultTags = { 
        'eun1': 'EUN1', 'euw1': 'EUW1', 'na1': 'NA1',
        'br1': 'BR1', 'la1': 'LAN', 'la2': 'LAS', 'oc1': 'OCE',
        'tr1': 'TR1', 'ru': 'RU', 'jp1': 'JP1', 'kr': 'KR1',
        'ph2': 'PH2', 'sg2': 'SG2', 'tw2': 'TW2', 'th2': 'TH2', 'vn2': 'VN2'
    };
    tagLine = defaultTags[region] || 'EUNE';
  }

  const regionalRoute = platformToRegional[region] || 'europe';

  try {
    // 1. Lépés: PUUID lekérése Riot ID alapján (Szigorúan azt használva, amit beírtál)
    const accountUrl = `https://${regionalRoute}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
    let accountResponse;
    try {
        accountResponse = await axios.get(accountUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
    } catch (err) {
        return res.status(404).json({ message: `Nem találtunk Riot fiókot ezzel a névvel: ${gameName}#${tagLine}.` });
    }
    const puuid = accountResponse.data.puuid;

    // 2. Lépés: Summoner API a kiválasztott régióban
    const summonerUrl = `https://${region}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${puuid}`;
    let summonerData = null;
    let actualRegion = region;

    try {
        const summonerResponse = await axios.get(summonerUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
        summonerData = summonerResponse.data;
    } catch (err) {
        // Ha itt hiba van, bypass-hoz alapértéket adunk
        summonerData = { puuid: puuid, summonerLevel: 1, profileIconId: 1 };
    }

    // 3. Lépés: Ranked adatok lekérése a PUUID alapján (EZ VOLT A MEGOLDÁS!)
    let leagueData = [];
    try {
        const leagueUrl = `https://${actualRegion}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`;
        const leagueResponse = await axios.get(leagueUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
        leagueData = leagueResponse.data;
    } catch (leagueErr) {
        console.log(`[Figyelmeztetés] A Riot megtagadta a Ranked adatokat (státusz: ${leagueErr.response ? leagueErr.response.status : 'ismeretlen'}).`);
    }

    // 3.5 Lépés: Utolsó 20 meccs lekérése (Ez előrébb jön, hogy el tudjuk menteni a matchId-t a DB-be!)
    let matchHistory = [];
    try {
        const matchIdsUrl = `https://${regionalRoute}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=0&count=20`;
        const matchIdsResponse = await axios.get(matchIdsUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
        const matchIds = matchIdsResponse.data;

        // Rate Limit (Túl sok kérés) elkerülése érdekében 5-ösével kérjük le a meccseket
        for (let i = 0; i < matchIds.length; i += 5) {
            const batch = matchIds.slice(i, i + 5);
            const matchPromises = batch.map(matchId => {
                return axios.get(`https://${regionalRoute}.api.riotgames.com/lol/match/v5/matches/${matchId}`, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
            });
            const batchResponses = await Promise.all(matchPromises);
            matchHistory.push(...batchResponses.map(res => res.data));
        }
    } catch (matchErr) {
        console.log(`[Figyelmeztetés] A meccselőzmények lekérése sikertelen volt:`, matchErr.response ? matchErr.response.status : matchErr.message);
    }

    // 4. Lépés: OKOS ADATBÁZIS MENTÉS ÉS MECCSENKÉNTI LP KISZÁMÍTÁSA
    let lpChanges = { 'RANKED_SOLO_5x5': null, 'RANKED_FLEX_SR': null };
    let matchLpChanges = {}; // Ide mentjük, hogy pontosan melyik matchId mennyi LP-t adott

    if (MONGO_URI && leagueData && leagueData.length > 0) {
        const soloMatches = matchHistory.filter(m => m.info.queueId === 420);
        const flexMatches = matchHistory.filter(m => m.info.queueId === 440);
        const latestMatches = {
            'RANKED_SOLO_5x5': soloMatches.length > 0 ? soloMatches[0].metadata.matchId : null,
            'RANKED_FLEX_SR': flexMatches.length > 0 ? flexMatches[0].metadata.matchId : null
        };

        for (const qType of ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR']) {
            const queueInfo = leagueData.find(q => q.queueType === qType);
            if (queueInfo) {
                try {
                    const latestRecord = await PlayerHistory.findOne({ puuid: puuid, queueType: qType }).sort({ date: -1 });
                    
                    if (!latestRecord || latestRecord.wins !== queueInfo.wins || latestRecord.losses !== queueInfo.losses || latestRecord.leaguePoints !== queueInfo.leaguePoints) {
                        const newRecord = new PlayerHistory({
                            puuid: puuid,
                            riotId: `${accountResponse.data.gameName}#${accountResponse.data.tagLine}`,
                            region: actualRegion,
                            queueType: qType,
                            tier: queueInfo.tier,
                            rank: queueInfo.rank,
                            leaguePoints: queueInfo.leaguePoints,
                            wins: queueInfo.wins,
                            losses: queueInfo.losses,
                            matchId: latestMatches[qType] // ÚJ: Elmentjük a legutóbbi meccs azonosítóját!
                        });
                        await newRecord.save();
                        console.log(`[Adatbázis] Új ${qType} frissítés elmentve: ${newRecord.riotId} -> ${queueInfo.tier} ${queueInfo.rank} (${queueInfo.leaguePoints} LP) -> Match: ${latestMatches[qType]}`);
                    }

                    // Visszaolvassuk az utolsó 20 mentést, hogy minden korábbi meccshez hozzárendeljük a pontos LP-t
                    const historyRecords = await PlayerHistory.find({ puuid: puuid, queueType: qType }).sort({ date: -1 }).limit(20);
                    if (historyRecords.length >= 2) {
                        // Az utolsó frissítés óta történt teljes változás (Bal oldali Ranked sávba)
                        const currentAbsLp = calculateAbsoluteLp(historyRecords[0].tier, historyRecords[0].rank, historyRecords[0].leaguePoints);
                        const previousAbsLp = calculateAbsoluteLp(historyRecords[1].tier, historyRecords[1].rank, historyRecords[1].leaguePoints);
                        lpChanges[qType] = currentAbsLp - previousAbsLp;

                        // Minden egyes rögzített meccs ID-hoz kiszámoljuk a konkrét LP nyereséget/veszteséget
                        for (let i = 0; i < historyRecords.length - 1; i++) {
                            const curr = historyRecords[i];
                            const prev = historyRecords[i+1];
                            if (curr.matchId) {
                                const cLp = calculateAbsoluteLp(curr.tier, curr.rank, curr.leaguePoints);
                                const pLp = calculateAbsoluteLp(prev.tier, prev.rank, prev.leaguePoints);
                                matchLpChanges[curr.matchId] = cLp - pLp;
                            }
                        }
                    }
                } catch (dbErr) {
                    console.error(`[Adatbázis] Hiba a ${qType} mentéskor:`, dbErr.message);
                }
            }
        }
    }

    // 5. Lépés: Élő meccs (Spectator API) lekérése
    let activeGame = null;
    try {
        const spectatorUrl = `https://${actualRegion}.api.riotgames.com/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(puuid)}`;
        const spectatorResponse = await axios.get(spectatorUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
        activeGame = spectatorResponse.data;

        // Játékosok rangjának gyors lekérése az élő meccshez
        if (activeGame && activeGame.participants) {
            const rankPromises = activeGame.participants.map(async (p) => {
                try {
                    const rankUrl = `https://${actualRegion}.api.riotgames.com/lol/league/v4/entries/by-puuid/${encodeURIComponent(p.puuid)}`;
                    const rankRes = await axios.get(rankUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
                    const soloQ = rankRes.data.find(q => q.queueType === 'RANKED_SOLO_5x5');
                    if (soloQ) {
                        // Formázzuk szebbre (pl. PLATINUM III -> Platinum III)
                        const formattedTier = soloQ.tier.charAt(0) + soloQ.tier.slice(1).toLowerCase();
                        p.rankStr = `${formattedTier} ${soloQ.rank}`;
                        p.wins = soloQ.wins;
                        p.losses = soloQ.losses;
                        if (soloQ.miniSeries) p.promos = soloQ.miniSeries.progress;
                    } else {
                        p.rankStr = 'Unranked';
                    }
                } catch (e) {
                    p.rankStr = 'Unranked';
                }

                // ÚJ: Hős Mastery lekérése az aktuális hősre
                try {
                    const masteryUrl = `https://${actualRegion}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(p.puuid)}/by-champion/${p.championId}`;
                    const masteryRes = await axios.get(masteryUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
                    p.currentChampMastery = masteryRes.data.championPoints;
                } catch (e) {
                    p.currentChampMastery = 0; // Ha 404, akkor még sosem játszott vele
                }
                return p;
            });
            await Promise.all(rankPromises); // Párhuzamosan kérjük le a 10 rangot, hogy gyors legyen!
        }
    } catch (specErr) {
        // Ha 404-et kapunk, a játékos egyszerűen nincs meccsben, ez teljesen normális.
    }

    // 6. Lépés: Top 10 Champion Mastery lekérése
    let masteryData = [];
    try {
        const masteryUrl = `https://${actualRegion}.api.riotgames.com/lol/champion-mastery/v4/champion-masteries/by-puuid/${encodeURIComponent(puuid)}/top?count=10`;
        const masteryResponse = await axios.get(masteryUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
        masteryData = masteryResponse.data;
    } catch (err) {
        console.log(`[Figyelmeztetés] A Champion Mastery lekérése sikertelen volt.`);
    }

    // Válasz elküldése a frontendnek
    res.json({
        ...summonerData,
        name: `${accountResponse.data.gameName}#${accountResponse.data.tagLine}`,
        activeRegion: actualRegion.toUpperCase(),
        rankedData: leagueData,
        matchHistory: matchHistory,
        activeGame: activeGame,
        masteryData: masteryData,
        lpChanges: lpChanges,
        matchLpChanges: matchLpChanges
    });

  } catch (error) {
      console.error(error);
      res.status(500).json({ message: 'Belső szerverhiba történt az adatok feldolgozása közben.' });
  }
});

// ÚJ VÉGPONT: Meccsek lapozása (További 5 meccs betöltése)
app.get('/matches/:region/:puuid', async (req, res) => {
  const region = req.params.region;
  const puuid = req.params.puuid;
  const start = parseInt(req.query.start) || 0; // Honnan kezdjük a lekérést?
  const count = 5; // Hány meccset kérjünk?
  const regionalRoute = platformToRegional[region] || 'europe';

  try {
    const matchIdsUrl = `https://${regionalRoute}.api.riotgames.com/lol/match/v5/matches/by-puuid/${puuid}/ids?start=${start}&count=${count}`;
    const matchIdsResponse = await axios.get(matchIdsUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
    
    const matchPromises = matchIdsResponse.data.map(matchId => {
        return axios.get(`https://${regionalRoute}.api.riotgames.com/lol/match/v5/matches/${matchId}`, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
    });
    const matchResponses = await Promise.all(matchPromises);
    res.json(matchResponses.map(r => r.data));
  } catch (error) {
    res.status(500).json({ message: 'Hiba a további meccsek lekérésekor.' });
  }
});

// ÚJ VÉGPONT: Meccs idővonal (Timeline) lekérése grafikonokhoz
app.get('/match/:region/:matchId/timeline', async (req, res) => {
  const region = req.params.region;
  const matchId = req.params.matchId;
  const regionalRoute = platformToRegional[region] || 'europe';

  try {
    const timelineUrl = `https://${regionalRoute}.api.riotgames.com/lol/match/v5/matches/${matchId}/timeline`;
    const response = await axios.get(timelineUrl, { headers: { 'X-Riot-Token': RIOT_API_KEY } });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ message: 'Hiba az idővonal lekérésekor.' });
  }
});

// A szerver elindítása
app.listen(PORT, () => {
  console.log(`Szerver elindítva a http://localhost:${PORT} címen`);
});
