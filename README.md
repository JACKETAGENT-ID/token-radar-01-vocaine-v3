# token-radar-01-vocaine-v3

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/JACKETAGENT-ID/token-radar-01-vocaine-v3/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/JACKETAGENT-ID/token-radar-01-vocaine-v3/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

An endurance-weighted, log-scale token launch radar. It ranks the pre-token protocols of the sealed DefiLlama snapshot by an implied value that grows slower than TVL — `(TVL / $1M)^0.55` — times winsorised 7-day growth, a log-age endurance factor for how long the protocol has run with no token recorded, chain breadth, and standing against its own category's median TVL. Protocols whose token already trades are never ranked; the dashboard shows them apart as comparables at their real market caps. The dashboard is sortable and filterable, with a detail view per protocol showing the value waterfall, peer comparison, risk flags, and a concrete seven-step farm plan with costs and durations.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18+, standard library only, no network. Writes board.json, data.js, dashboard/, screenshots/ and dossier.json into the output directory.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
