# NFS Underground Web

*Need for Speed: Underground* (2003, PC, `SPEED.EXE` 1.4) rodando no navegador. O executável é traduzido de
x86 para C (recompilação estática) e compilado para WebAssembly; gráficos em WebGPU, som em Web Audio, saves
no próprio navegador (OPFS).

Projeto de fã, para estudo e uso pessoal. Sem vínculo com a Electronic Arts.

> **Traga o seu jogo.** Este repositório não tem nenhum arquivo do jogo nem código traduzido dele. Você precisa
> da sua cópia instalada (a pasta com o `SPEED.EXE` 1.4). Tudo que é gerado a partir dela (`gen/`, `out/`, o
> `.wasm`) fica só na sua máquina e está no `.gitignore`.

## Rodar

Precisa de Node.js, Python 3, Google Chrome e do [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases)
descompactado em `deps/`.

```sh
./run.sh "/caminho/da/pasta/do/jogo"   # 1ª vez: prepara tudo e abre o Chrome
./run.sh                               # depois: lembra a pasta; http://localhost:8080/
./run.sh --docker                      # o mesmo via Docker + Caddy: https://localhost:8443/
```

O `run.sh` só refaz o que falta: venv do Python, tradução do `SPEED.EXE` para C (`web/gen.sh`, ~30 s), build do
módulo (`web/build.sh`), build da página e o servidor. `./run.sh --help` mostra as opções.

**Controles:** setas ou **W A S D**, troca de marcha **E** (sobe) e **Z** (desce), Enter e Esc nos menus.

## O que funciona

Medido no Chrome do macOS (Apple Silicon), com os testes automatizados deste repositório:

| Área | Estado |
|---|---|
| Vídeos (logo EA, THX, intro) | Tocam com imagem e som pelo player do próprio jogo; Enter pula a intro |
| Menus, criar e carregar perfil, save | OK (no OPFS: `Profiles.usr` + `.opt`, `.cfg`, `.ugd`) |
| Quick Race: Circuit, Sprint, Drag, Drift, Lap Knockout, Free Run | Largam, o carro anda, sai pela pausa; 60 fps |
| Carreira (GO UNDERGROUND) | Entra e corre a primeira prova |
| Batida, "Totaled!", menu pós-corrida | OK (visto no Drag) |
| Saves na página: lista, backup, restore, cloud save | OK para perfis do NFSU1; renomear perfil não existe |

**Ainda não testado:** terminar uma prova completa em cada modo, oficina (peças, pintura, vinil), menus de
opções, gamepad e volante, sessões longas, Firefox e Safari. O online e a LAN do jogo original não funcionam (os
servidores da EA não existem mais).

## Como funciona

1. `tools/lift.py` desmonta cada função do `SPEED.EXE` e escreve o equivalente em C (`gen/all`, ~30 mil
   funções). As funções que o jogo só alcança por ponteiro vêm de `tools/nfsu1/seeds.txt`.
2. O runtime (`runtime/`) emula o que o jogo pede ao Windows: arquivos, threads, Direct3D 9 (traduzido para
   WebGPU), DirectSound (Web Audio) e DirectInput (teclado e gamepad).
3. As correções específicas do NFSU1 ficam todas em `runtime/overrides.c` (troca de uma função inteira ou gancho
   num endereço). O `web/gen.sh` só aceita o `SPEED.EXE` 1.4, porque esses endereços são dessa versão.
4. `web/` tem a página (TypeScript), o servidor local (`server.mjs`) e o servidor de produção (Rust, `server-rs`).

## Testes

```sh
(cd web && node --test test/*.test.mjs)   # unidade e integração; os de /data-blocks e /game.wasm pedem o servidor Rust
web/tools/coverage.sh                     # os 6 modos do Quick Race no Chrome headless (com o ./run.sh no ar)
node web/tools/fe-walk.mjs <saida> "profile,Enter,shot:menu"   # anda pelos menus com uma lista de passos
```

## Créditos

- **[nfsu2-web](https://github.com/th0mk/nfsu2-web)**, de th0mk (MIT): o runtime de navegador, a página e o
  servidor deste repositório vêm de lá, adaptados ao primeiro *Underground*. O teste `tests/web/aliastest.c`
  também é de lá.
- **Talha Müderrisoğlu**: a recompilação estática original do NFSU2 para Apple Silicon, base do nfsu2-web.
- O método segue o [N64: Recompiled](https://github.com/N64Recomp/N64Recomp) e o
  [XenonRecomp](https://github.com/hedge-dev/XenonRecomp).

## Licença

MIT ([LICENSE](LICENSE)), mantendo os avisos de copyright de th0mk e de Talha Müderrisoğlu. *Need for Speed* e
*Need for Speed: Underground* são marcas da Electronic Arts Inc.; o jogo e os arquivos dele são da EA e não fazem
parte deste repositório.
