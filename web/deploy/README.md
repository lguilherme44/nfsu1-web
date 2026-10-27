# Deploy

| Arquivo | Para quê |
|---|---|
| `compose.local.yml` | Rodar na sua máquina com HTTPS (`https://localhost:8443/`). O `./run.sh --docker` usa este. |
| `compose.yml` | Um VPS Linux com o seu domínio: Caddy pega o certificado do Let's Encrypt. |
| `Caddyfile` | O proxy HTTPS do `compose.yml`. |

Os arquivos do jogo nunca vão no pacote nem na imagem: você copia a **sua** pasta do jogo para o servidor e
aponta `NFSU2_DATA` para ela.
