(function() {
    if (window.discordRpcInjected) {
        return;
    }
    window.discordRpcInjected = true;

    const originalOpen = window.open;
    const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
    window.open = function(url, target, features) {
        const urlStr = String(url || '');
        const isExternalAuth = urlStr.includes('last.fm') ||
                               urlStr.includes('spotify.com') ||
                               urlStr.includes('google.com') ||
                               urlStr.includes('discord.com') ||
                               urlStr.includes('monochrome-database.firebaseapp.com');

        if (isExternalAuth) {
            if (isMobile) {
                return originalOpen.apply(window, arguments);
            }
            if (window.__TAURI__?.shell) {
                window.__TAURI__.shell.open(urlStr);
            }
            return {
                close: () => {},
                focus: () => {},
                blur: () => {},
                postMessage: () => {},
                closed: false,
                location: { href: urlStr }
            };
        }

        return originalOpen.apply(window, arguments);
    };

    document.addEventListener('contextmenu', e => e.preventDefault());
    let debounceTimer;
    let lastState = {};
    let lastAudioTime = 0;
    let lastUpdateTime = 0;

    function invoke(cmd, args) {
        if (window.__TAURI__?.core?.invoke) {
            return window.__TAURI__.core.invoke(cmd, args);
        }
        if (window.__TAURI__?.tauri?.invoke) {
            return window.__TAURI__.tauri.invoke(cmd, args);
        }
        return Promise.reject("Tauri API not found");
    }

    if (window.__TAURI__?.event?.listen) {
        window.__TAURI__.event.listen('media-toggle', () => {
            const audio = document.getElementById('audio-player');
            if (audio) {
                if (audio.paused) audio.play(); else audio.pause();
            }
        });
    }

    function getCurrentTrackFromQueue() {
        try {
            const queueData = localStorage.getItem('monochrome-queue');
            if (!queueData) return null;

            const queue = JSON.parse(queueData);
            const activeQueue = queue.shuffleActive ? queue.shuffledQueue : queue.queue;
            if (!activeQueue || activeQueue.length === 0) return null;

            const currentTrack = activeQueue[queue.currentQueueIndex];
            return currentTrack || null;
        } catch (e) {
            if (window.__DISCORD_RPC_DEBUG__) {
                console.error('[Discord RPC] Failed to read queue:', e);
            }
            return null;
        }
    }

    function isLocalFile(trackId) {
        // Local files have IDs that start with "local-"
        return typeof trackId === 'string' && trackId.startsWith('local-');
    }

    function updateRPC(force = false) {
        const audioEl = document.getElementById('audio-player');
        if (!audioEl) return;

        const currentTrack = getCurrentTrackFromQueue();
        if (!currentTrack) {
            // No track in queue - clear RPC
            if (Object.keys(lastState).length > 0) {
                lastState = {};
                invoke('clear_discord_presence', {}).catch(() => {});
            }
            return;
        }

        const isPaused = audioEl.paused;
        const currentSec = audioEl.currentTime || 0;
        const totalSec = audioEl.duration || 0;

        // Check if this is a local file
        const isLocal = isLocalFile(currentTrack.id);

        // Extract metadata
        const title = currentTrack.title || 'Unknown Track';
        const artistName = currentTrack.artists?.[0]?.name || currentTrack.artist?.name || 'Unknown Artist';
        const albumName = currentTrack.album?.title || '';
        
        // Extract year from release date
        const releaseDate = currentTrack.album?.releaseDate || currentTrack?.streamStartDate || '';
        const yearMatch = releaseDate.match(/^(\d{4})/);
        const year = yearMatch ? yearMatch[1] : '';

        // Get cover image - prefer album cover, fallback to artist picture
        let image = 'logo';
        const coverEl = document.querySelector('.now-playing-bar img.cover');
        if (coverEl && coverEl.src && coverEl.src.startsWith('http') && coverEl.src.length < 256) {
                image = coverEl.src;
        }
        else if (isLocal) {image = 'local';}


        // Build URLs only for non-local files
        const baseUrl = window.location.origin;
        const trackUrl = !isLocal && currentTrack.id ? `${baseUrl}/track/${currentTrack.id}` : '';
        const artistUrl = !isLocal && currentTrack.artist?.id ? `${baseUrl}/artist/${currentTrack.artist.id}` : '';
        const albumUrl = !isLocal && currentTrack.album?.id ? `${baseUrl}/album/${currentTrack.album.id}` : '';

        const currentState = {
            trackId: currentTrack.id,
            title: title,
            artist: artistName,
            year: year,
            album: albumName,
            image: image,
            isPaused: isPaused,
            isLocal: isLocal,
            trackUrl: trackUrl,
            artistUrl: artistUrl,
            albumUrl: albumUrl
        };

        // Only update if track changed or play/pause state changed
        const trackChanged = lastState.trackId !== currentState.trackId;
        const playStateChanged = lastState.isPaused !== currentState.isPaused;
        
        if (!force && !trackChanged && !playStateChanged) {
            return;
        }

        lastState = currentState;

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            // Re-read current time to account for any playback during debounce
            const finalCurrentSec = audioEl.currentTime || 0;
            const finalTotalSec = audioEl.duration || 0;
            
            const payload = {
                title: title,
                artist: artistName,
                year: year,
                album: albumName,
                image: image,
                isPaused: isPaused,
                isLocal: isLocal,
                currentSec: finalCurrentSec,
                totalSec: finalTotalSec,
                trackUrl: trackUrl,
                artistUrl: artistUrl,
                albumUrl: albumUrl
            };
            
            // Debug logging
            if (window.__DISCORD_RPC_DEBUG__) {
                console.log('[Discord RPC] Sending payload:', JSON.stringify(payload, null, 2));
            }
            
            invoke('update_discord_presence', payload).catch(() => {});
            
            // Store the time we sent this update
            lastAudioTime = finalCurrentSec;
            lastUpdateTime = Date.now();
        }, 300);
    }

    // Sync RPC time periodically to handle hiccups/buffering
    function syncRPCTime() {
        const audioEl = document.getElementById('audio-player');
        if (!audioEl || audioEl.paused || !lastState.trackId) return;

        const currentTime = audioEl.currentTime || 0;
        const timeSinceLastUpdate = (Date.now() - lastUpdateTime) / 1000;
        
        // If audio time has drifted more than 2 seconds from expected position, resync
        const expectedTime = lastAudioTime + timeSinceLastUpdate;
        const drift = Math.abs(currentTime - expectedTime);
        
        if (drift > 2.0) {
            if (window.__DISCORD_RPC_DEBUG__) {
                console.log(`[Discord RPC] Time drift detected: ${drift.toFixed(1)}s - resyncing`);
            }
            updateRPC(true);
        }
    }

    let observer = null;
    
    function attachAudioListeners() {
        const audio = document.getElementById('audio-player');
        if (audio && !audio.dataset.rpcAttached) {
            audio.addEventListener('play', () => updateRPC(false));
            audio.addEventListener('pause', () => updateRPC(false));
            audio.addEventListener('seeked', () => updateRPC(true));
            audio.addEventListener('loadedmetadata', () => updateRPC(true));
            audio.addEventListener('timeupdate', () => {
                // Check for drift every 10 seconds of playback
                const currentTime = audio.currentTime || 0;
                if (Math.floor(currentTime) % 10 === 0 && Math.floor(currentTime) !== Math.floor(lastAudioTime)) {
                    syncRPCTime();
                }
            });
            audio.dataset.rpcAttached = "true";
        }
    }

    // Listen for queue changes (track switches)
    let lastQueueString = '';
    function checkQueueChanges() {
        try {
            const queueData = localStorage.getItem('monochrome-queue');
            if (queueData !== lastQueueString) {
                lastQueueString = queueData;
                // Queue changed - update immediately
                updateRPC(true);
            }
        } catch (e) {}
    }

    function initializeWatcher() {
        attachAudioListeners();
        checkQueueChanges();
        updateRPC(false);
    }
    
    function tryInit() {
        initializeWatcher();
    }
    
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryInit);
    } else {
        tryInit();
    }
    
    // Check for queue changes every 2 seconds
    setInterval(checkQueueChanges, 2000);
    
    // Check for time drift every 5 seconds
    setInterval(syncRPCTime, 5000);
    
    // Re-init periodically as fallback
    setInterval(tryInit, 10000);
    
    // Global function to toggle debug mode
    window.toggleDiscordRPCDebug = function() {
        window.__DISCORD_RPC_DEBUG__ = !window.__DISCORD_RPC_DEBUG__;
        console.log('[Discord RPC] Debug mode:', window.__DISCORD_RPC_DEBUG__ ? 'ENABLED' : 'DISABLED');
        if (window.__DISCORD_RPC_DEBUG__) {
            console.log('[Discord RPC] Current state:', lastState);
            console.log('[Discord RPC] Current track from queue:', getCurrentTrackFromQueue());
            console.log('[Discord RPC] To disable debug mode, run: toggleDiscordRPCDebug()');
        }
        return window.__DISCORD_RPC_DEBUG__;
    };
    
    // Global function to force RPC update
    window.forceDiscordRPCUpdate = function() {
        console.log('[Discord RPC] Forcing update...');
        updateRPC(true);
        return 'Update triggered';
    };
})();