`main.js` renders the music panel and refreshes playback every 15 seconds while
connected. `spotify.js` handles OAuth, vault encryption, and HTTPS requests
through `fetch`. Copies of the mod share one in-memory Spotify session.
`windows-kdf.js` coordinates native password-based key derivation on Windows.
