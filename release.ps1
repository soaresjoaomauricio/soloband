# Publica uma versao nova do SoloBand no GitHub Releases (gera o instalador e sobe).
# Token: classico (github.com/settings/tokens/new) com a caixinha "repo" marcada.
# Na 1a vez pede o token (escondido); se o envio der certo, guarda criptografado pelo Windows (DPAPI) com o
# teu usuario: so o teu login neste PC abre. Arquivo: %APPDATA%\SoloBand-release\token.dat
# Trocar o token salvo: .\release.ps1 -NovoToken
# Texto sem acento de proposito: o PowerShell 5 le este arquivo como ANSI.
param([switch]$NovoToken)

$repo = 'soaresjoaomauricio/soloband'
# Roda de qualquer pasta: o npm run release precisa estar na do projeto.
Set-Location $PSScriptRoot

# O electron-builder cria a tag no main DO GITHUB: se o commit nao subiu, a versao sai com o codigo velho
# (foi o que aconteceu na 0.1.2). Confere antes de gastar 5 minutos gerando.
$version = (Get-Content (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json).version
$branch = git rev-parse --abbrev-ref HEAD
if ($branch -ne 'main') { Write-Host "Ta no branch '$branch'. Volta pro main (git switch main) e roda de novo."; return }
if (git status --porcelain --untracked-files=no) { Write-Host 'Tem mudanca sem commit. Commita (ou desfaz) e roda de novo: o instalador tem que ser igual ao commit.'; return }
git fetch -q origin main
if ($LASTEXITCODE -ne 0) { Write-Host 'Nao consegui falar com o GitHub pelo git (git fetch falhou). Confere a internet e roda de novo.'; return }
$ahead = [int](git rev-list --count origin/main..HEAD)
$behind = [int](git rev-list --count HEAD..origin/main)
if ($ahead -gt 0) { Write-Host "Tem $ahead commit(s) que nao subiram pro GitHub. Roda git push e depois este script de novo."; return }
if ($behind -gt 0) { Write-Host "O GitHub tem $behind commit(s) que este PC nao tem. Roda git pull e depois este script de novo."; return }
$remoteTag = git ls-remote --tags origin "refs/tags/v$version"
if ($remoteTag -and -not $remoteTag.StartsWith((git rev-parse HEAD))) {
  Write-Host "A v$version ja foi lancada (a tag existe no GitHub em outro commit). Sobe o version no package.json e escreve as novidades."
  return
}
Write-Host "Git ok: main enviado, v$version vai sair do commit $(git rev-parse --short HEAD)."

$dir = Join-Path $env:APPDATA 'SoloBand-release'
$file = Join-Path $dir 'token.dat'
if ($NovoToken -and (Test-Path $file)) { Remove-Item $file }

$saved = Test-Path $file
if ($saved) {
  $secure = Get-Content $file | ConvertTo-SecureString
  Write-Host 'Usando o token salvo (criptografado pelo Windows).'
} else {
  $secure = Read-Host 'Cola o token do GitHub (fica escondido) e aperta Enter' -AsSecureString
}
$token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))

# Testa o token antes de gastar 5 minutos gerando o instalador.
try {
  $info = Invoke-RestMethod "https://api.github.com/repos/$repo" -Headers @{ Authorization = "Bearer $token"; 'User-Agent' = 'soloband-release' }
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 401) { Write-Host 'Token invalido ou vencido. Gera outro em https://github.com/settings/tokens/new (caixinha repo).' }
  elseif ($code -eq 404) { Write-Host "Esse token nao enxerga o $repo. No token classico, marca a caixinha repo. No token novo, Repository access tem que incluir soloband." }
  else { Write-Host "Nao consegui falar com o GitHub ($code): $($_.Exception.Message)" }
  if ($saved) { Remove-Item $file; Write-Host 'Tirei o token salvo; roda de novo e cola um token bom.' }
  return
}
# Teste de escrita de verdade, sem criar nada: pede uma referencia apontando pra um commit que nao existe.
# Com permissao, o GitHub responde 422 ("objeto nao existe"); sem, 403. ($info.permissions diz o que a PESSOA pode, nao o token.)
$body = '{"ref":"refs/heads/soloband-token-test","sha":"0000000000000000000000000000000000000000"}'
$canWrite = $false
try {
  Invoke-RestMethod "https://api.github.com/repos/$repo/git/refs" -Method Post -Body $body -ContentType 'application/json' -Headers @{ Authorization = "Bearer $token"; 'User-Agent' = 'soloband-release' } | Out-Null
  $canWrite = $true
} catch {
  $canWrite = ($_.Exception.Response.StatusCode.value__ -eq 422)
}
if (-not $canWrite) {
  Write-Host "O token enxerga o repositorio mas NAO pode escrever nele (por isso o 403)."
  Write-Host 'Token classico: marca a caixinha repo. Token novo: Repository permissions > Contents = Read and write.'
  if ($saved) { Remove-Item $file }
  return
}
Write-Host "Token ok: pode publicar no $repo."

$env:GH_TOKEN = $token
try {
  # Tudo que o build e o envio mostram vai tambem pra dist\release.log (da pra ler mesmo se a janela fechar).
  New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot 'dist') | Out-Null
  npm run release 2>&1 | Tee-Object -FilePath (Join-Path $PSScriptRoot 'dist\release.log')
  if ($LASTEXITCODE -eq 0) {
    if (-not $saved) {
      New-Item -ItemType Directory -Force $dir | Out-Null
      $secure | ConvertFrom-SecureString | Set-Content $file
      Write-Host "Token salvo em $file (so o teu usuario do Windows consegue abrir). Da proxima vez nao pede."
    }
    Write-Host "Publicado: https://github.com/$repo/releases/latest"
  } else {
    Write-Host 'O envio deu erro (olha acima). O token nao foi salvo.'
  }
} finally {
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  $token = $null
}
