# Guarda o token do GitHub pra nao pedir mais no release (criptografado pelo Windows/DPAPI: so o teu usuario abre).
# Testa antes se o token consegue escrever no repositorio; token ruim nao fica salvo.
# Texto sem acento de proposito: o PowerShell 5 le este arquivo como ANSI.
$repo = 'soaresjoaomauricio/soloband'
$file = Join-Path $env:APPDATA 'SoloBand-release\token.dat'
$secure = Read-Host 'Cola o token do GitHub (fica escondido) e aperta Enter' -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$h = @{ Authorization = "Bearer $token"; 'User-Agent' = 'soloband-release' }
$body = '{"ref":"refs/heads/soloband-token-test","sha":"0000000000000000000000000000000000000000"}'
$ok = $false
try {
  Invoke-RestMethod "https://api.github.com/repos/$repo/git/refs" -Method Post -Body $body -ContentType 'application/json' -Headers $h | Out-Null
  $ok = $true
} catch {
  $ok = ($_.Exception.Response.StatusCode.value__ -eq 422)
}
$token = $null
if (-not $ok) {
  Write-Host 'Esse token NAO consegue escrever no soloband. Nada foi salvo.'
  return
}
New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
$secure | ConvertFrom-SecureString | Set-Content $file
Write-Host "Salvo. O release.ps1 nao vai pedir mais (ate o token vencer)."
