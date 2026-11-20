`main.js` renders the music panel and refreshes playback every 15 seconds while
connected. `spotify.js` handles OAuth, Music's vault lifecycle, and HTTPS
requests through `fetch`. Copies of the mod share one in-memory Spotify session.

The packaged Herdr Vault ESM supplies encryption, key state and the Windows
key derivation worker. Avlye Layout supplies the layout variants and shared
`tabs-avlye` mod. Music owns its own Spotify vault file and disconnect flow.
