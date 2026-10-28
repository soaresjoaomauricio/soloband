# Sobe pro Release que ja existe os arquivos que faltam (instalador, latest.yml, blockmap) da versao do package.json.
# Pede o token (escondido) ou usa o salvo. Tudo que aparece aqui tambem vai pra dist\release.log.
# Trocar um arquivo que ja subiu errado: .\upload-release.ps1 -Substituir latest.yml
# Texto sem acento de proposito: o PowerShell 5 le este arquivo como ANSI.
param([string[]]$Substituir = @())
$ErrorActionPreference = 'Stop'
$repo = 'soaresjoaomauricio/soloband'
$log = Join-Path $PSScriptRoot 'dist\release.log'
function Say($msg) { Write-Host $msg; Add-Content -Path $log -Value "$(Get-Date -Format s) $msg" }

$version = (Get-Content (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json).version
$file = Join-Path $env:APPDATA 'SoloBand-release\token.dat'
if (Test-Path $file) { $secure = Get-Content $file | ConvertTo-SecureString } else { $secure = Read-Host 'Cola o token do GitHub (fica escondido) e aperta Enter' -AsSecureString }
$token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$h = @{ Authorization = "Bearer $token"; 'User-Agent' = 'soloband-release'; Accept = 'application/vnd.github+json' }

Say "--- subindo arquivos da v$version"
try {
  # Pela lista (e nao por /releases/tags/...), pra achar tambem a release em rascunho.
  $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=30" -Headers $h | Where-Object { $_.tag_name -eq "v$version" } | Select-Object -First 1
  if (-not $rel) { throw "nao achei a release v$version no GitHub" }
  foreach ($a in $rel.assets) {
    if ($Substituir -contains $a.name) {
      Invoke-RestMethod "https://api.github.com/repos/$repo/releases/assets/$($a.id)" -Method Delete -Headers $h | Out-Null
      Say "tirei o antigo: $($a.name)"
    }
  }
  $have = @($rel.assets | Where-Object { $Substituir -notcontains $_.name } | ForEach-Object { $_.name })
  foreach ($name in @("SoloBand-Setup-$version.exe", 'latest.yml', "SoloBand-Setup-$version.exe.blockmap")) {
    if ($have -contains $name) { Say "ja tem: $name"; continue }
    $path = Join-Path $PSScriptRoot "dist\$name"
    if (-not (Test-Path $path)) { Say "FALTA NO PC: $path (roda npm run dist antes)"; continue }
    Say "subindo $name ($([math]::Round((Get-Item $path).Length/1MB,1)) MB)..."
    $url = "https://uploads.github.com/repos/$repo/releases/$($rel.id)/assets?name=$name"
    Invoke-RestMethod $url -Method Post -Headers $h -ContentType 'application/octet-stream' -InFile $path -TimeoutSec 1800 | Out-Null
    Say "ok: $name"
  }
  Say "PRONTO: https://github.com/$repo/releases/tag/v$version"
  # Deu certo: guarda o token criptografado pelo Windows (DPAPI) pra nao pedir de novo.
  if (-not (Test-Path $file)) {
    New-Item -ItemType Directory -Force (Split-Path $file) | Out-Null
    $secure | ConvertFrom-SecureString | Set-Content $file
    Say 'Token salvo (criptografado pelo Windows). Da proxima vez nao pede.'
  }
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  Say "ERRO ($code): $($_.Exception.Message)"
  if ($code -eq 403) { Say 'O token nao pode escrever: precisa de Contents = Read and write (ou a caixinha repo, no classico).' }
} finally {
  $token = $null
}
