# Publica uma versao nova do SoloBand no GitHub Releases (gera o instalador e sobe).
# O token precisa de: Repository access = soloband, Contents = Read and write.
# Na 1a vez pede o token (escondido) e oferece salvar. Salvo, ele fica criptografado pelo Windows (DPAPI) com o
# teu usuario: so o teu login neste PC abre. Arquivo: %APPDATA%\SoloBand-release\token.dat
# Trocar ou apagar o token salvo: .\release.ps1 -NovoToken   (ou apaga o arquivo)
# Texto sem acento de proposito: o PowerShell 5 le este arquivo como ANSI.
param([switch]$NovoToken)

$dir = Join-Path $env:APPDATA 'SoloBand-release'
$file = Join-Path $dir 'token.dat'
if ($NovoToken -and (Test-Path $file)) { Remove-Item $file }

if (Test-Path $file) {
  $secure = Get-Content $file | ConvertTo-SecureString
  Write-Host 'Usando o token salvo (criptografado pelo Windows).'
} else {
  $secure = Read-Host 'Cola o token do GitHub (fica escondido) e aperta Enter' -AsSecureString
  $save = (Read-Host 'Salvar se der certo, pra nao pedir de novo? (s/n)') -eq 's'
}

$env:GH_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
try {
  npm run release
  # So guarda o token depois que o envio funcionou (token sem permissao nao fica salvo).
  if ($LASTEXITCODE -eq 0 -and $save) {
    New-Item -ItemType Directory -Force $dir | Out-Null
    $secure | ConvertFrom-SecureString | Set-Content $file
    Write-Host "Token salvo em $file (so o teu usuario do Windows consegue abrir)."
  } elseif ($LASTEXITCODE -ne 0) {
    Write-Host 'Deu erro, o token NAO foi salvo. Se for 403: o token precisa de escrita no repositorio soloband.'
  }
} finally {
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host 'Pronto. O token nao ficou em nenhuma variavel aberta.'
}
