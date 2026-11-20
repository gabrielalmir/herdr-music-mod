The manual OAuth callback uses PKCE S256, a random state value, and a single-use
authorization attempt that expires after ten minutes. The access token stays in
memory. The mod checks cryptography before offering to save your account.
Disconnecting clears the local Music vault under `data/herdr-music-vault.json`.
You can revoke authorization from your Spotify account.

Herdr Vault uses AES-GCM and PBKDF2-SHA256. A new password or code starts with
a fresh 16-byte salt, and each write uses a fresh 12-byte IV. The unlocked
key stays in memory while the session is active so a refresh-token rotation
can reuse it. Older base64 vaults are read with the same password or code and
are written as v2 at the next successful vault write.

User-entered passwords use 600,000 PBKDF2 iterations through Windows CNG in a
short-lived PowerShell process. The worker authenticates both ends of a
loopback connection before exchanging password and key material. Use **Cancel
operation** to stop an unlock or password change before it writes. Generated
unlock codes contain 192 random bits and use one PBKDF2 iteration. Save the
code to unlock your account in a future session.
