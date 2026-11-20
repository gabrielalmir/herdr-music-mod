# Herdr Music

Mini-player GPUI para Spotify Connect.

## Desenvolvimento

Use Node.js 22.13+ (ou 20.19+) e npm. Em uma cópia limpa, execute
`herdr-app check mods/herdr-music` com a mesma versão do Herdr usada para rodar
o mod. Aponte o TypeScript para as declarações geradas pelo Herdr mantendo
`gpui-kit.d.ts` ao lado de `main.js`. Se o arquivo já estiver disponível na
pasta do mod em `HERDR_APP_HOME/mods/herdr-music`, copie-o para
`mods/herdr-music/gpui-kit.d.ts` na cópia de trabalho.

```sh
npm ci
npm run check
```

- `npm run lint` mostra arquivo, linha, coluna e regra do ESLint.
- `npm run typecheck` mostra os erros de tipos com a posição e o código do
  diagnóstico. Confira se `gpui-kit.d.ts` está presente se o TypeScript indicar
  que falta o arquivo ou que os módulos do Herdr não foram encontrados.
- `npm test` executa os testes locais de PKCE, cofre, renovação, desconexão e
  erros da API.
- `herdr-app check mods/herdr-music` verifica carregamento e renderização inicial
  no runtime. Para validar o painel em execução, use um `HERDR_APP_HOME` isolado
  e teste a entrada de conta desconectada, o desbloqueio de um cofre de teste,
  os controles de reprodução e a configuração.

No Windows, verifique a sintaxe dos scripts e gere o ZIP de desenvolvimento
com PowerShell.

```powershell
foreach ($file in 'scripts/package.ps1', 'tests/smoke.ps1', 'mods/herdr-music/vault-kdf.ps1') {
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile(
        (Resolve-Path $file).Path, [ref]$null, [ref]$parseErrors
    )
    if ($parseErrors) { throw ($parseErrors | Out-String) }
}
./scripts/package.ps1 -Development
```

O ZIP contém os arquivos de runtime, os ícones e o script de derivação do Windows.
O empacotamento usa uma lista explícita de arquivos e deixa as dependências de
desenvolvimento na cópia de trabalho.

[Instalação](docs/install.md) · [Arquitetura](docs/architecture.md) · [Capacidades](docs/capabilities.md) · [Segurança](docs/security.md)
