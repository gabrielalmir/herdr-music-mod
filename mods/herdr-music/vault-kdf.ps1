param([int]$Port, [string]$Challenge)
$ErrorActionPreference = 'Stop'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Server.ExclusiveAddressUse = $true
$client = $null
$kdf = $null
try {
    $listener.Start(1)
    $client = $listener.AcceptTcpClient()
    $listener.Stop()
    $stream = $client.GetStream()
    $stream.ReadTimeout = 3000
    $stream.WriteTimeout = 3000
    $reader = [IO.StreamReader]::new($stream)
    $writer = [IO.StreamWriter]::new($stream)
    $writer.AutoFlush = $true
    # Authenticate both ends before transmitting any vault material.
    function Proof([string]$role) {
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $bytes = [Text.Encoding]::ASCII.GetBytes("${role}:$Challenge")
            [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
        } finally { $sha.Dispose() }
    }
    $writer.WriteLine((Proof 'server'))
    if ($reader.ReadLine() -cne (Proof 'client')) { throw 'Invalid handshake' }
    $password = [Convert]::FromBase64String($reader.ReadLine())
    $salt = [Convert]::FromBase64String($reader.ReadLine())
    if ($salt.Length -ne 16) { throw 'Invalid salt' }
    $kdf = [Security.Cryptography.Rfc2898DeriveBytes]::new(
        $password, $salt, 600000, [Security.Cryptography.HashAlgorithmName]::SHA256
    )
    $key = $kdf.GetBytes(32)
    $writer.WriteLine([BitConverter]::ToString($key).Replace('-', '').ToLowerInvariant())
} finally {
    if ($key) { [Array]::Clear($key, 0, $key.Length) }
    if ($password) { [Array]::Clear($password, 0, $password.Length) }
    if ($kdf) { $kdf.Dispose() }
    if ($client) { $client.Dispose() }
    $listener.Stop()
}
