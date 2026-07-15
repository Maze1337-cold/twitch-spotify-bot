require('dotenv').config();
const SpotifyWebApi = require('spotify-web-api-node');
const { ChatClient } = require('@twurple/chat');
const { RefreshingAuthProvider } = require('@twurple/auth');
const { ApiClient } = require('@twurple/api');
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: process.env.SPOTIFY_REDIRECT_URI
});

// === DIE OPTIMIERTE queueSpotifySong FUNKTION (Inklusive Link-Erkennung) ===
async function queueSpotifySong(songQuery, chatClient, channel, user) {
    try {
        let trackUri = '';
        let songTitle = '';
        let artistName = '';

        // Bereinige die Eingabe von unnötigen Leerzeichen
        const queryClean = songQuery.trim();

        // Regex, um Spotify-Track-IDs aus Links zu fischen (z.B. https://open.spotify.com/track/4PTG3Z6...)
        const linkMatch = queryClean.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);

        if (linkMatch) {
            // SZENARIO A: User hat einen direkten Link geschickt
            const trackId = linkMatch[1];
            console.log(`[Spotify] Direktlink erkannt. Hole Track-Details für ID: ${trackId}`);
            
            const trackData = await spotifyApi.getTrack(trackId);
            const track = trackData.body;
            
            trackUri = track.uri;
            songTitle = track.name;
            artistName = track.artists[0].name;
        } else {
            // SZENARIO B: Normale Textsuche
            const searchResults = await spotifyApi.searchTracks(queryClean, { limit: 1 });
            const tracks = searchResults.body.tracks.items;

            if (tracks.length === 0) {
                await chatClient.say(channel, `⚠️ @${user}, ich konnte den Song "${queryClean}" leider nicht finden.`);
                return;
            }

            const track = tracks[0];
            trackUri = track.uri;
            songTitle = track.name;
            artistName = track.artists[0].name;
        }

        // 1. In Spotify-Queue einreihen
        await spotifyApi.addToQueue(trackUri);
        await chatClient.say(channel, `🎶 @${user} hat "${songTitle}" von ${artistName} zur Warteschlange hinzugefügt! 🟢`);
        console.log(`[Spotify] Eingereiht: ${songTitle} - ${artistName}`);

        // 2. In die Supabase-Datenbank schreiben (Für dein Website-Leaderboard!)
        const { error } = await supabase
            .from('song_requests')
            .insert([
                { username: user, song_title: songTitle, artist: artistName }
            ]);

        if (error) {
            console.error('❌ Fehler beim Speichern in Supabase:', error.message);
        } else {
            console.log(`💾 Datenbank: Wunsch von ${user} erfolgreich protokolliert.`);
        }

    } catch (err) {
        console.error('❌ Fehler beim Hinzufügen zur Queue:', err.message);
        await chatClient.say(channel, `❌ @${user}, Fehler! Ist Spotify beim Streamer geöffnet und aktiv?`);
    }
}

// === HIER DEN NAMEN DER TWITCH-KANALPUNKTE-BELOHNUNG EINTRAGEN ===
const REWARD_NAME = "Wunschsong"; 

async function initSpotify() {
    try {
        console.log('🔄 Spotify: Verbinde über Refresh-Token...');
        
        spotifyApi.setRefreshToken(process.env.SPOTIFY_REFRESH_TOKEN);
        
        const data = await spotifyApi.refreshAccessToken();
        spotifyApi.setAccessToken(data.body['access_token']);
        
        console.log('✅ Spotify: Verbindung erfolgreich über Refresh-Token hergestellt!');

        setInterval(async () => {
            try {
                const refreshData = await spotifyApi.refreshAccessToken();
                spotifyApi.setAccessToken(refreshData.body['access_token']);
                console.log('🔄 Spotify: Access Token automatisch erneuert.');
            } catch (x) {
                console.error('❌ Automatischer Token-Refresh fehlgeschlagen:', x.message);
            }
        }, 1000 * 60 * 30);
    } catch (err) {
        console.error('❌ Spotify Fehler beim Start mit Refresh-Token:', err.message);
    }
}

async function initTwitch() {
    const channelName = process.env.TWITCH_CHANNEL.toLowerCase();
    
    // Automatischen Refresh-Provider für Twitch initialisieren
    const authProvider = new RefreshingAuthProvider({
        clientId: process.env.TWITCH_CLIENT_ID,
        clientSecret: process.env.TWITCH_CLIENT_SECRET
    });

    // Token aus der .env-Datei laden
    await authProvider.addUserForToken({
        accessToken: process.env.TWITCH_OAUTH_TOKEN,
        refreshToken: process.env.TWITCH_REFRESH_TOKEN,
        expiresIn: 0,
        obtainmentTimestamp: 0
    }, ['chat']);

    // Loggt im Terminal, wenn Twitch im Hintergrund einen neuen Key generiert hat
    authProvider.onRefresh((userId, newTokenData) => {
        console.log('🔄 Twitch: Access Token wurde automatisch im Hintergrund erneuert!');
    });
    
    const apiClient = new ApiClient({ authProvider });
    const chatClient = new ChatClient({ authProvider, channels: [channelName] });

    chatClient.onConnect(() => {
        console.log(`✅ Twitch: Bot erfolgreich im Chat von #${channelName} eingeloggt!`);
    });

    chatClient.onMessage(async (channel, user, text, msg) => {
        if (text.toLowerCase() === '!ping') {
            await chatClient.say(channel, `Pong! @${user} Der Spotify-Bot ist aktiv! 🤖`);
            return;
        }

        if (msg.tags.get('custom-reward-id')) {
            try {
                console.log(`[Twitch] Kanalpunkte-Event registriert...`);
                
                const rewardId = msg.tags.get('custom-reward-id');
                const broadcasterUser = await apiClient.users.getUserByName(channelName);
                const rewardInfo = await apiClient.channelPoints.getCustomRewardById(broadcasterUser.id, rewardId);

                if (rewardInfo && rewardInfo.title.toLowerCase() === REWARD_NAME.toLowerCase()) {
                    console.log(`🎯 Wunschsong-Einlösung von ${user}: ${text}`);
                    await queueSpotifySong(text, chatClient, channel, user);
                }
            } catch (e) {
                console.error("❌ Twitch API Fehler beim Abrufen der Belohnung:", e.message);
            }
        }
    });

    await chatClient.connect();
}

async function start() {
    console.log("=== STARTE LIVE-SYSTEM ===");
    await initSpotify();
    await initTwitch();
}

// Dummy-Server für Render, damit der Port-Scan nicht fehlschlägt
const http = require('http');
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Bot läuft!\n');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`✅ Web-Server läuft auf Port ${PORT}`);
});

start();
