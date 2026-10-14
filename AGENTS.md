# repository-db — pravidla pro agenta

Public engine `@lazurio/repository-db`. Repo je veřejné; platí tvrdá hranice
obsahu.

## Hranice

- Engine drží jen generickou Git-backed YAML mechaniku: config kontrakt,
  boundary guard, collections CRUD, status model, publish/pull/conflict
  lifecycle, odvozená data jako ignorovaná mezipaměť, hostitelskou službu
  synchronizace (`createSyncHost`), model karty (`deriveDraftPanel`) a
  credential preflight.
- Sem nikdy nepatří Spectoda business data, doménová schémata (Deals, Products,
  …), secrets, tokeny, interní URL ani zákaznické hodnoty. Doménové schéma
  žije v owner modulu aplikace (pilot: `modules/deals/app/v3`), později jako
  samostatný schema package (`@spectoda/deals-data-schema`).
- Testy používají výhradně syntetické fixture repo v temp adresáři; žádná
  reálná data.

## Invarianty enginu

- Každá Git operace běží přes `git -C <mountRoot>` a před ní platí boundary
  guard: mount = repo root, origin = `data_repo.remote`, branch =
  `data_repo.branch`. Operace z parent code repa musí selhat.
- Publish je jediná cesta, kterou engine commituje a pushuje. Drží lock,
  ověří Git identitu, postaví odvozená data a spustí validátory v živém
  checkoutu a commitne jen sledovaný koncept s deterministickými
  Repository-Db-* trailery validovanými parserem (`src/trailers.ts`).
- Publikační lifecycle (publish, finishSend, pull, konflikt) vlastní jen
  engine. Vzdálené změny se začleňují v dočasném worktree jen Gitem (rebase +
  sémantický YAML merge), nikdy v živém checkoutu; checkout se posune jen
  `reset --keep` po úspěchu, výsledek se postaví a ověří v živém checkoutu a
  při selhání se checkout vrátí na lokální commit se zaznamenaným konfliktem.
  Pull je jen fast-forward, i pod konceptem nad jinými záznamy. Konflikt se
  detekuje ze stavu repa (rebase dir, unmerged paths), nikdy jen z exit kódu.
- Odvozená data (`generated_manifest`) nejsou nikdy v Gitu: datové repo je
  ignoruje, engine sledovanou odvozenou cestu odmítne s přesným návodem
  k převodu a nikdy se neúčastní konceptu, překryvu, konfliktu, review ani
  discardu. Materializery a validátory běží s cwd = mount a nesahají mimo něj.
- Legacy stav ze starších enginů (zámek bez tokenu, konflikt bez pending
  commitu, sledované `.repository-db/`) se nemigruje: engine ho odmítne se
  zprávou „vyčistěte checkout“.
- Zápis záznamu s `baseRevision` kontroluje revizi i zapisuje pod společnou
  bránou (`writeRecordDraft`); revize záznamu je per záznam, ne revize draftu.
- Při aktivním konfliktu jsou writes i publish blokované do explicitního
  `conflict --resolved` / `conflict --abort`.
- Credential preflight nikdy nezapisuje credentials; jen ověřuje externí
  mechanismus (gh, ssh-agent, credential helper) před mutací working tree.

## Vývoj

- Bun-first: `bun test`, `bunx tsc --noEmit`. Žádné dependencies kromě `yaml`.
- V Bunu `spawnSync`/`execSync` nedědí runtime mutace `process.env` — env
  předávej explicitně (`env: { ...process.env }`).
- Změny chování doplň testem ve `tests/` a záznamem v `CHANGELOG.md`.
