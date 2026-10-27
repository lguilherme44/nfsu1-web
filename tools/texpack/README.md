# tools/texpack — upscaled texture pack builder

Builds the optional texture pack for `textures = upscaled` (runtime/texrep.m) from
**your own** game files, on your Mac. No game asset is part of the port and none
leaves the machine.

```bash
tools/texpack/setup.sh            # once: private Python env + model (about 0.8 GB)
tools/texpack/build.sh            # the pack, from the game folder in settings.ini
                                  # (or --game <folder>); a few minutes
```

Then set `textures = upscaled` in `~/Library/Application Support/NFSU2/settings.ini`.

| File | What |
|---|---|
| `setup.sh` | venv in `<Application Support>/NFSU2/texpack/venv` (Python 3.12–3.14), packages from `requirements.txt` with every wheel checked against its SHA-256 (`pip --require-hashes`), model download with SHA-256 check (`--with-dat2` adds the slow best-quality model) |
| `build.sh` | runs `texpack.py` from that venv (`build`, `scan`, `info`, `fetch-model`) |
| `texpack.py` | TPK scan of the game files, texture dumps, upscaling (PyTorch MPS via spandrel; the model file's SHA-256 is checked before every build), back-projection onto the original, BC encoding, pack layout |

Models (CC0, fetched from the author's repositories, never stored in this repo):
PBRify Upscaler SPAN v4 (default) and PBRify Upscaler V4 (DAT2, `--model dat2`).
