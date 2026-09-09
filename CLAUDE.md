# INGREDIENT-PARSER-TS — CONSTRAINTS & DEVELOPMENT GUIDE

## 1. PROJECT IDENTITY & ARCHITECTURE

**ingredient-parser-typescript** is a TypeScript port of
[strangetom/ingredient-parser](https://github.com/strangetom/ingredient-parser) (Python, MIT):
a CRF sequence labeller that parses English recipe ingredient sentences ("2 tbsp olive oil,
divided") into structured `ParsedIngredient` data (name, amounts, size, preparation, comment,
purpose, foundation foods). Read `docs/PORTING.md` before any work: decisions, parity
discipline; `docs/QUIRKS.md` for the corrections beyond upstream.

- **Why TS:** the runtime has zero dependencies — quantized CRF weights in JSON, a Viterbi
  loop, an in-repo tagger and stemmer — so it runs everywhere JS runs, including React Native/Hermes, for as-you-type,
  on-device, offline parsing.
- **Scope:** the whole library, `foundationfoods/` included. The default output is upstream's
  `ParsedIngredient`, byte-identical at the pin.
- **Upstream pin:** `ffd6ae3c6efb9925c40fc9b4454d77b40469ef91` (release 2.7.0 = pip
  `ingredient-parser-nlp==2.7.0`). Parity means parity with this commit. The git tag
  `v2.7.0-parity` marks the parity version; the port evolves independently from there (§3).
- **Consumers:** downstream applications on Node, web bundlers and React Native/Metro. This
  repository never depends on any of them.

### Project structure — canonical reference

> Authoritative tree. Do not create files outside it; no new top-level directories without
> approval. `AGENTS.md` enforces.

```
ingredient-parser-typescript/
├── src/                  # TS runtime: module ↔ upstream file, 1:1 (+ src/en/data/ generated, gitignored)
├── models/               # trained model artifacts — write-once, provenance-recorded; vendored upstream data;
│                         # models/natural/ = natural 8.1.1's Brill lexicon + rules (README records the licence chain)
├── training/             # Python-side retrain + dump + eval pipeline; training/data/ = vendored corpus
├── fixtures/             # probe-recipes.json — 107 real lines / 10 recipes, trap-annotated
├── tests/                # vitest: upstream/ (pytest recreated verbatim), harness/, goldens/ (samples +
│                         # committed Python references under goldens/parity/), quirks/, eval/, helpers/
├── docs/                 # PORTING.md, VERIFICATION.md, QUIRKS.md, ARCHITECTURE.md, MODELS.md
├── notes/                # gitignored, private: detailed ledger, full parity-decision prose, audit reports,
│                         # one-off scripts (notes/README.md) — never published, never referenced from public docs
└── (root)                # CLAUDE.md, AGENTS.md, CONTRIBUTING.md, README.md, LICENSE*, configs only
```

### Key commands
```bash
pnpm install && pnpm typecheck && pnpm test   # suite incl. committed samples; no Python needed
pnpm model                                    # generated assets: brill.en.ts (tagger data), model.en.ts (CRF), glove.en.ts +
                                              # fdc.en.ts (lazy FF), ffcache.en.ts (precomputed FDC caches, ~5 s when stale)
HARNESS=full pnpm harness                     # every parity level: root *.jsonl if present, else the committed
                                              # tests/goldens/parity/*.jsonl.gz
EVAL=1 pnpm exec vitest run tests/eval        # primitive goldens vs CPython/numpy/pint
# Python side (training/eval; setup in docs/PORTING.md §6):
ip-repo/venv/bin/python training/eval-model.py <model.json.gz>       # accuracy on the seed-42 / 0.2 split
training/retrain.sh models/<name>.json.gz                            # held-out retrain (≈15 min)
training/ship-model.sh models/<m>.json.gz                            # switch the runtime model: regenerates asset + every
                                                                     # dump + committed references, runs suite + harness
training/compare-lines.sh lines.txt                                  # ad-hoc lines through Python AND the port, diffed
ip-repo/venv/bin/python training/gen-pint.py                         # regenerate src/en/_pintRegistry.ts
ip-repo/venv/bin/python training/gen-constants.py                    # regenerate src/en/_constants.ts + _htmlEntities.ts
```

## 2. AUTONOMY PROTOCOL

Read existing code before making changes. Understand the pattern. Reuse before inventing.

### Proceed without asking when
- The change is internal TS structure, harness implementation, or test organisation
- A retrain or experiment follows the recorded pipeline and its result will be recorded
- A `quirks: 'fixed'` correction is being implemented as specified (both-modes test included)

### Pause and ask when
- A settled decision (`docs/PORTING.md` §3) looks wrong — bring evidence, don't relitigate silently
- Changing the upstream pin, publishing anything, or altering the default (parity) output
- Accepting an accuracy regression beyond the recorded deltas
- Adding any runtime dependency (there are none; `natural` 8.1.1 is a devDependency: the
  reference the vendored tagger and stemmer are diffed against, and the training maps)
- Deleting or rewriting any frozen model artifact or committed reference dump
- A workaround is needed — verify it's intentional first

### Safe change order
1. Correct → 2. Consistent → 3. Clean → 4. Elegant. Never invert. Never trade reliability for momentum.

### Verification before declaring done
- The differential harness level for the touched layer passes (`docs/PORTING.md` §4): decoder =
  exact labels from dumped feature dicts; features = zero string divergence over the corpus +
  fixtures; output = upstream tests green + full-corpus `ParsedIngredient` diff
- The touched module's upstream tests are green; expectations there are never edited to pass
- Accuracy claims carry the seed-42 / 0.2-split numbers. "It looks right" is not a state
- Docs updated per §6

### Subagent instructions
Subagents do not read CLAUDE.md. When spawning one, include: the upstream pin, the parity
rule (port behaviour, not code; feature strings are the contract), the canonical JSON
convention, relevant file paths, and what harness level must pass after.

## 3. ARCHITECTURAL BOUNDARIES

- **Parity by default, corrections by option.** Up to `v2.7.0-parity` upstream bugs are ported
  faithfully and documented. From there the port evolves independently: nothing goes upstream
  as a PR; upstream is tracked and its changes adopted deliberately; corrections and API
  additions are allowed, each recorded in `docs/QUIRKS.md` (public) and `notes/ledger.md`
  (private detail) with a test asserting both modes, and the default output stays byte-parity
  so every number in these docs remains true. A change that silently alters the default output
  is an incident.
- **Module mapping is 1:1 with upstream:** `inference.py`, `en/preprocess.py` (+ `_constants`,
  `_regex`, `_utils`, `_structure_features`), `en/postprocess.py`, `dataclasses.py`,
  `en/foundationfoods/*`. Constants tables are data — generated or transcribed mechanically.
- **The training corpus is vendored** at `training/data/training.sqlite3` so the pipeline
  outlives upstream (provenance: `training/data/README.md`). Not part of the published package.
  The training and dump scripts still need upstream's Python code: they expect a clone of
  https://github.com/strangetom/ingredient-parser at the pin in `./ip-repo` (gitignored, local
  only, never pushed) with the venv inside it.
- **Canonical cross-language JSON** for every map and harness dump: compact separators
  (`(",", ":")` / default `JSON.stringify`), raw unicode (`ensure_ascii=False`). This
  convention has already eaten two real bugs; do not renegotiate it.
- **Asset strategy:** CRF model eager as an uncompressed generated module (~1.8 MB raw; Hermes has
  no zlib); Brill lexicon + rules eager as a generated module (~1 MB, `src/en/data/brill.en.ts`
  from `models/natural/`); foundation-foods assets referenced only from the `./foundation-foods` entry point
  (`src/foundation-foods.ts`, `preload_foundation_foods()`), so bundles built from the main entry
  never contain them on any bundler.
- **Anti-duplication:** before adding a utility, check whether upstream has the same logic
  elsewhere in the pipeline — port the shared shape once.

## 4. PARITY & PROVENANCE — INVARIANTS

Violating any invariant is an incident, not a judgment call.

- **I1 — Feature strings are the contract.** CRF weights key on exact strings; a
  one-character divergence degrades accuracy silently. Any code producing a feature value is
  inside the parity boundary and must pass the differential harness.
- **I2 — The linguistic components used at inference MUST be the ones used at training.**
  Tagger and stemmer changes require a retrain and a recorded evaluation. Never mix. The
  runtime's tagger and stemmer (`src/en/_brill.ts`, `_porter.ts`) are reproductions of natural
  8.1.1 kept identical by `tests/harness/linguistics.test.ts`; a divergence there is a bug.
- **I3 — Models are artifacts of a replayable pipeline.** Never hand-edit a model file. Every
  shipped model records: corpus, tagger, stemmer, seed, split, accuracy numbers, and the
  command that made it (`docs/MODELS.md`).
- **I4 — Write-once artifacts.** A model that shipped or was measured is never mutated — new
  experiments produce new files. Goldens and the committed Python references are regenerated
  from the pin, never hand-edited.
- **I5 — Determinism.** No randomness in the runtime. Tie-breaks and summation order match
  Python's behaviour; near-tie flips are bugs to chase, not noise to shrug at.
- **I6 — No secret ever enters a transcript, log, or commit.**

## 5. CODE QUALITY

- **Strict TypeScript.** No `any`. Pure ESM. No native deps, no Node-only APIs in the runtime
  path. Runtime floor is React Native 0.81+ Hermes: Unicode property escapes, lookbehind, BigInt
  and `Object.hasOwn` are allowed; classes, private fields and `import()` rely on Metro's
  transforms.
- **Port behaviour, not code.** Python `re`, NLTK internals, dict-order tie-breaks — the
  reference is what the Python *produces*, verified by diff, not what the source looks like.
  Translate regex behaviour; never copy patterns and hope.
- **Naming: upstream identifiers verbatim.** Functions, methods, attributes, dataclass fields,
  constants and private `_names` keep upstream's exact snake_case spelling; source files keep
  upstream's stems. Keyword arguments become one trailing options object with the same keys.
  Only additions beyond upstream (`Fraction`, `Unit`, `logaddexp`, `tag_ingredient`, `quirks`)
  are free. Mapping: `tests/upstream/README.md`.
- **Corrections are marked** `QUIRK fix <name>` in the code and gated on `quirks === 'fixed'`.
- **Keep it simple.** No premature abstraction. But never trade reliability for simplicity.

## 6. DOCUMENTATION

A change is not complete until its docs are updated.

- `CLAUDE.md` (this file) — constraints, invariants, measured facts. Private working material
  (detailed ledger, full parity-decision prose, audit reports, one-off scripts) lives in the
  gitignored `notes/` folder (`notes/README.md`); public docs never reference it.
- `AGENTS.md` — coordination rules, file responsibilities, session protocol.
- `docs/PORTING.md` — what was ported and why, settled decisions with evidence, parity
  discipline, training pipeline, publishing.
- `docs/QUIRKS.md` — the `quirks: 'fixed'` corrections and additions beyond upstream (public);
  `notes/ledger.md` holds the detailed, private record.
- `docs/VERIFICATION.md` — harness results, seams and their bounds, documented limits.
- `docs/ARCHITECTURE.md` — module ↔ upstream file map with parity status and per-module decisions.
- `docs/MODELS.md` — model provenance ledger (append-only).
- `README.md` — usage, fidelity statement, layout.

| When you modify... | Update... |
|---|---|
| A settled decision | `docs/PORTING.md` §3 + §8 measured facts below |
| Training pipeline / a retrain runs | `docs/MODELS.md` entry + `docs/PORTING.md` §6 |
| `src/**` | `docs/ARCHITECTURE.md` (module ↔ upstream file, parity status) |
| Harness levels, a new seam or limit | `docs/PORTING.md` §4 checklist + `docs/VERIFICATION.md` |
| A correction or API addition | `docs/QUIRKS.md` + `notes/ledger.md` + `tests/quirks/` |
| `fixtures/probe-recipes.json` | the entry's `style` annotation; regenerate references |
| `training/*` scripts | `training/README.md` |
| Upstream pin | `docs/PORTING.md` §2 + README + full harness re-run recorded |
| Environment variables | §7 below |

Documentation is as-built and evidence-bearing: numbers come from recorded runs, superseded
entries stay in the ledgers with what changed. If a reader cannot replay it, the doc is incomplete.

## 7. ENVIRONMENT

- Node ≥ 20, pnpm. Python ≥ 3.12 with a venv for the training side only.
- `BRILL_TAGS_FILE` — training-time env: JSONL map (canonical JSON) of token-list → Brill tags;
  substitutes NLTK tags via `training/preprocess-brill-patch.diff`. Unset = stock NLTK behaviour.
  Also drives `_utils.pos_tag` (foundation-foods FDC tagging).
- `PORTER_STEMS_FILE` — training-time env: JSONL map of token → natural Porter stem;
  substitutes NLTK Snowball stems via the same patch (a miss raises). Does not touch the
  foundation-foods path (Snowball on both sides). Both vars are set by `training/retrain.sh`.
- `NO_POS_FEATURES` — ablation hook in the patch: drops every POS-derived feature so a retrain
  measures the tagger's contribution. Unset in every recorded run; never set it for a dump.
- `PYTHONHASHSEED` / `VECLIB_MAXIMUM_THREADS` — `training/dump-parsed.py` pins them itself
  (0 / 1) and records them in the dump header; the hash seed is what makes Python's
  foundation-foods output reproducible (`docs/VERIFICATION.md` §3).
- `HARNESS=full`, `EVAL=1` — test gates (§1). `PARSED_DUMP`, `PARSED_FF_DUMP`,
  `FEATURE_HASHES`, `API_DUMP`, `PARSE_OPTIONS` — harness overrides for ad-hoc dumps.
- No API keys or secrets exist in this repo, and none may be introduced. Trim env vars before
  use. Never log values.
- Python helpers using process pools MUST guard with `if __name__ == "__main__"` (macOS spawn
  re-imports `__main__` — this crashed real runs).

## 8. WORKING MEMORY

### State
The whole library is ported and verified (`docs/VERIFICATION.md`); the parity version is tagged
`v2.7.0-parity`; the first corrections beyond upstream are in (`quirks: 'fixed'`, `tag_ingredient`);
0.1.0 is published (npm `ingredient-parser-typescript`, GitHub release v0.1.0). Since then: the
`natural` dependency is vendored (0.2.0 published); 0.2.1 = licence-notice wording. 0.3.0
(2026-09-09): nine more `quirks: 'fixed'` corrections from a consumer bug report (docs/QUIRKS.md),
incl. the first input rewrites; every corpus line they change was read.

### Measured facts (do not re-derive; update in the same change that changes them)
| Fact | Value |
|---|---|
| Corpus | 81,416 sentences (81,359 usable), table `en`, 6 sources incl. 15k BBC (UK); vendored `training/data/training.sqlite3` |
| Baseline (NLTK tags + NLTK stems, RETRAIN on the same split) | 94.73% sentence / 97.97% token — seed 42, split 0.2. The released upstream artifact is NOT comparable (random 80% fold; scores 97.11/99.02 here because it saw most of the split) |
| Brill tags (`natural`) | 94.59% / 97.90% — delta 0.14pt = noise; SETTLED |
| Brill tags + natural Porter stems (`models/brill-porter.json.gz`, seed-42 / 0.2 fold) | 94.60% / 97.90% — delta 0.13pt vs baseline; SETTLED. The ACCURACY ESTIMATE for the ship configuration; kept as fallback |
| SHIP MODEL `models/brill-porter-full.json.gz` | same components, all 81,359 lines, no split (690 iters, 22.5 min, 339 KB gz, 37,134 state features). No fair held-out number exists; train-set score on the split is 97.57/99.22 and is NOT accuracy. Switch = `training/ship-model.sh` |
| Rejected taggers | `pos` (= natural's Brill data), `compromise` (own tokenizer, ~mid-80s PTB), `wink-nlp` (own tokenizer, UD tags; ceiling is the 0.14pt) |
| Retrain cycle | ≈15–20 min on M-series (632–719 L-BFGS iterations); `training/retrain.sh` |
| Model size | ship: 339 KB gz / ~1.8 MB raw JSON; 17,454 attributes × 12 labels, 37,134 state features; Brill asset 0.97 MB raw (92,661 words, 71 categories, 18 rules); GloVe FF asset ~3.4 MB gz (lazy) |
| Runtime dependencies | none (2026-09-03; `natural` vendored: tagger reimplemented, stemmer ported, identical over 81,523 corpus/fixture token lists + 11,371 FDC descriptions + adversarial sets). Parser-only bundle 3.3 MB raw / 0.87 MB gz (0.1.0: 7.9 / 1.09); consumer install 1 package / 12 MB (0.1.0: 48 packages / 86 MB) |
| Decoder (level 1) | 16,272 seq / 117,369 tokens, labels exact, confidences bit-exact 98.8%, max diff 2.8e-14 |
| Features (level 2) | 16,272 seqs recomputed from text, 0 mismatches; 81,416 corpus + 107 fixture lines, 0 hash mismatches |
| Output (level 3) | 81,523 / 81,523 `ParsedIngredient` byte-identical; API 107 / 107; 92 option combinations 0; ~60,000 adversarial lines 0 |
| Foundation foods (level 3 FF) | 81,523 lines; 0 semantic mismatches; 3,456 (4.24%) confidence-only ≤9.3e-5, 3,396 of those exactly 1e-6 (float32 seam + upstream's hash-order variance); Snowball 13,839/13,839; caches identical on all 11,362 entries |
| Suite | `pnpm test` 491 passed / 9 skipped (7 `HARNESS=full` gates, Snowball gate, model card); 29 skipped counting the 20 `EVAL=1` cases; upstream 45 files / 458 cases with 9 documented `it.fails` deltas |
| Hermes (RN 0.81.5) | 4,814 / 4,814 parses byte-identical to Node (re-verified on the vendored-tagger build); plain parse ~5 ms CPU, FF parse ~60 ms, preload 1–3 s; first FF parse 0.17 s with precomputed caches |
| Stemmer | SETTLED — natural 8.1.1 vanilla `PorterStemmer` (upstream: NLTK Snowball), ported in `src/en/_porter.ts`; differs from Snowball on 5.2% of vocab / 2.3% of token occurrences, costs ~0pt |

### Quick glossary
- **Pin** — the upstream commit all parity targets (`ffd6ae3`, release 2.7.0).
- **Feature string** — an exact `key=value` string the CRF weights are keyed on; the parity unit.
- **Seam** — a cross-language divergence class (JSON separators, unicode escaping, regex
  semantics, tie-breaks, engine libm…); checklist in `docs/PORTING.md` §4, bounds in `docs/VERIFICATION.md` §3.
- **Harness levels** — decoder (labels from dumped features) → features (string diff over the
  corpus) → output (`ParsedIngredient` diff + upstream tests).
- **Goldens / references** — expected outputs generated from the pin, never hand-written; the
  Python side of the harness is committed under `tests/goldens/parity/`.
- **Quirks** — `'upstream'` (default, parity) or `'fixed'` (the corrections in `docs/QUIRKS.md`).
