The manual OAuth callback uses PKCE S256, a random state value, and a single-use
authorization attempt that expires after ten minutes. The access token stays in
memory. The mod tests PBKDF2-SHA256 and AES-GCM before offering to save your
account. Each vault write uses a fresh 16-byte salt and 12-byte IV. If
cryptography is unavailable, the connection lasts for the current session.
Disconnecting clears the local vault. Revoke authorization from your Spotify
account.

The v2 vault uses AES-GCM from @noble/ciphers 1.3.0 and PBKDF2-SHA256. For a
user-entered password, the mod uses the Windows .NET implementation in a
short-lived PowerShell process. The password and key travel over a single-use
loopback connection that authenticates both ends. They stay out of process
arguments and temporary files. The package includes the third-party license.
Unlocking retrieves the refresh token to renew the session.

The unlock code option generates 192 random bits in Herdr and uses one PBKDF2
iteration. User-entered passwords use 600,000 iterations. Save the generated
code to unlock your account in a future session.
