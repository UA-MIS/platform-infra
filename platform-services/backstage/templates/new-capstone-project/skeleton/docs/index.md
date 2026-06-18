# ${{ values.appName }}

${{ values.description }}

Scaffolded by **Relay** onto the UA-MIS capstone platform golden path.

## Quick start

1. Clone this repo and edit `app/` (your code). Leave `.devops/` alone.
2. Run the tests: `cd app && go test ./...`.
3. Open a pull request — a **preview** environment is built automatically.
4. Merge to `main` — **dev** auto-deploys.
5. Tag `vX.Y.Z` — **staging** auto-deploys; **prod** waits on the manual gate.

## Deployment targets

| Environment | URL |
| --- | --- |
| dev | `https://${{ values.appName }}.${{ values.team }}.dev.<platform-domain>` |
| staging | `https://${{ values.appName }}.${{ values.team }}.staging.<platform-domain>` |
| prod | `https://${{ values.appName }}.${{ values.team }}.<platform-domain>` |

## The `.devops/` contract

The platform owns everything under `.devops/`. Your only knobs are the four fields in
`.devops/app-metadata.yaml` (`team`, `semester`, `app-name`, `port`).
