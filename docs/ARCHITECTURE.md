# Architecture — as-built map of the port

Module ↔ upstream file (pin `ffd6ae3c6efb9925c40fc9b4454d77b40469ef91`, release 2.7.0), with
parity status. A module's status changes only with harness evidence (docs/VERIFICATION.md).

| TS module | Upstream file | Status | Evidence |
|---|---|---|---|
| `src/inference.ts` | `ingredient_parser/inference.py` | **Level 1 PASS** (2026-09-02) | 16,272 / 16,272 sequences, 117,369 tokens: labels exact; confidences bit-exact 115,938 / 117,369, max abs diff 2.8e-14 (`pnpm harness`) |
| `src/index.ts` | `ingredient_parser/__init__.py` (exports only) | n/a | — |
| `src/_py.ts` | (CPython semantics: `re` str classes, `float()`, `int()`, `str.capitalize/strip/repr`, `html.unescape`) | supporting module | covered by level 2 |
| `src/_common.ts` | `ingredient_parser/_common.py` (minus `UREG`, NLTK download) | **conformance PASS** | `tests/upstream/test_common.test.ts` 13/14 (+1 not-portable skip) |
| `src/dataclasses.ts` | `ingredient_parser/dataclasses.py` (complete) | **Level 3 PASS** | 81,523 / 81,523 ParsedIngredient byte-identical; upstream test_IngredientAmount 15/15, test_CompositeIngredientAmount 3/3 |
| `src/fraction.ts` | Python stdlib `fractions.Fraction` (bigint-backed) | supporting module | level 3 + amount tests (incl. numerators > 2^53) |
| `src/_pint.ts` | `pint` 0.25.3 subset: name resolution, unit expressions, `str(Unit)` D/P, root-unit factors, `Quantity.to` (+ density context), add/sub/mul | supporting module | level 3 (parse path) + convert_to/combined tests (exact rationals) |
| `src/en/_pintRegistry.ts` | pint default registry + `pint_extensions.txt` | **generated** by `training/gen-pint.py` | — |
| `src/en/postprocess.ts` | `en/postprocess.py` | **Level 3 PASS** (2026-09-02) | 81,523 / 81,523; 16 upstream test files 118/118 |
| `src/en/parser.ts` | `en/parser.py` | **Level 3 PASS** | parser tests 38/40 + 2 model-delta `it.fails` |
| `src/parsers.ts` | `parsers.py` (`parse_ingredient`, `parse_multiple_ingredients`, `inspect_parser`) | **Level 3 PASS** | — |
| `src/en/_loaders.ts` | `en/_loaders.py` | n/a | model asset = generated `src/en/data/model.en.ts`; asset registry for foundation foods |
| `src/foundation-foods.ts` | (entry point `./foundation-foods`) | n/a | the only module referencing `glove.en.ts`, `fdc.en.ts`, `ffcache.en.ts`; `preload_foundation_foods()` dynamic-imports them (`pnpm model`) |
| `src/en/foundationfoods/_ff_dataclasses.ts`, `_ff_constants.ts`, `_ff_utils.ts`, `_bm25.ts` | `en/foundationfoods/` same stems | **ported** (2026-09-02) | FDC loading byte-identical (11,362 rows: tokens, embedding tokens, weights); BM25 scores identical; 8 upstream tests green + 3 tagger-delta `it.fails` |
| `src/en/foundationfoods/_usif.ts`, `_fuzzy.ts`, `_foundationfoods.ts` | `en/foundationfoods/` same stems | **ported**, level 3 (FF) measured — see below | 36 / 37 end-to-end tests (1 tagger+model delta); uSIF constants bit-identical |
| `src/en/_embeddings.ts` | `en/_embeddings.py` (`GloVeModel`; `_binarize_vectors` unused upstream, not ported) | ported | — |
| `src/en/foundationfoods/_snowball.ts` | NLTK `nltk.stem.snowball.EnglishStemmer` | supporting module | 13,839 / 13,839 vocabulary tokens identical (`tests/harness/snowball.test.ts`) |
| `src/_pyset.ts` | CPython 3.12 `set` iteration order for int-hashed keys | supporting module | 120 generated cases identical (`tests/harness/pyset.test.ts`) |
| `src/_np.ts` | numpy `pairwise_sum` (f64/f32), mean/std, float32 dot/norm/distance | supporting module | see the float32 seam below |
| `src/en/data/glove.en.ts`, `fdc.en.ts` | `data/ingredient_embeddings.35d.glove.txt.gz`, `data/fdc_ingredients.csv.gz` | **generated** by `training/extract-ff-assets.mjs` (Node; `gen-ff-assets.py`, gitignored, lazy | — |
| `src/en/data/ffcache.en.ts` | (none — the FDC-side caches upstream builds lazily in `load_fdc_ingredients`, `uSIF.__init__`, `BM25.__init__`) | **generated** by `training/precompute-ff-caches.mjs` (`pnpm model`), gitignored, lazy | `tests/harness/ffcache.test.ts`: identical to the runtime computation, all 11,362 entries |
| `src/en/_constants.ts` | `en/_constants.py` | **generated** by `training/gen-constants.py` | level 2 |
| `src/en/_htmlEntities.ts` | Python stdlib `html.entities.html5` + invalid charref tables | **generated** by `training/gen-constants.py` | level 2 |
| `src/en/_regex.ts` | `en/_regex.py` | **Level 2 PASS** | 81,523 / 81,523 sentences |
| `src/en/_utils.ts` | `en/_utils.py` (complete; `pos_tag`/`stem` delegate to `_brill.ts` / `_porter.ts`) | **Level 3 PASS** | test_utils 27/27 |
| `src/en/_brill.ts` | natural 8.1.1 `BrillPOSTagger(Lexicon('EN','NN','NNP'), RuleSet('EN'))` — behaviour reimplemented; lexicon + rules vendored in `models/natural/` | supporting module (2026-09-03) | `tests/harness/linguistics.test.ts`: identical to natural over every corpus + fixture token list, every FDC description and adversarial lists; level 2 over the corpus |
| `src/en/_porter.ts` | natural 8.1.1 `PorterStemmer.stem` (MIT), ported step for step | supporting module (2026-09-03) | same test: identical over the corpus vocabulary (+ lowercased, hyphen parts) and adversarial tokens |
| `src/en/data/brill.en.ts` | `models/natural/lexicon_from_posjs.json.gz` + `tr_from_posjs.txt` (first category per word, grouped) | **generated** by `training/extract-brill.mjs` (`pnpm model`), gitignored, eager | — |
| `src/en/_nltk_chunk.ts` | `nltk.chunk.regexp` subset (RegexpParser with chunk rules, ChunkString, Tree) | supporting module | level 2 + structure-feature tests |
| `src/en/_structure_features.ts` | `en/_structure_features.py` | **Level 2 PASS** | 26 upstream tests: 23 pass, 3 tagger-delta (`it.fails`, see tests/upstream/README.md) |
| `src/en/preprocess.ts` | `en/preprocess.py` | **Level 2 PASS** (2026-09-02) | features-test.jsonl 16,272 seqs / 117,369 tokens: 0 value, 0 key-order mismatches; feature-hashes.jsonl 81,523 lines (corpus + fixtures): 0 mismatches; 15 upstream test files green |
| `src/en/index.ts` | `en/__init__.py` | n/a | — |
| `src/en/postprocess.ts`, `src/dataclasses.ts` | `en/postprocess.py`, `dataclasses.py` | level 3 (81,523 / 81,523) | — |
| `src/en/foundationfoods/*` | `en/foundationfoods/*` | level 3 FF (0 semantic) | see "The float32 seam" |

## Identifier policy

Upstream identifiers are kept verbatim, snake_case included (`tag_from_features`,
`_convert_features`, `sentence_structure`), and source files keep upstream's stems. Reason:
dataclass fields are the output contract the level-3 harness diffs against Python's
`asdict()` output, and side-by-side reading is the parity discipline. Keyword arguments
become one trailing options object with the same keys. Mapping table: `tests/upstream/README.md`.

## Runtime shape

- Pure ESM, strict TS, no runtime dependency. The Brill tagger and Porter stemmer — the exact
  components the ship model was trained with, CLAUDE.md I2 — are natural 8.1.1's, reproduced in
  `_brill.ts` / `_porter.ts` with the lexicon and rules as a generated module (PORTING.md §3.10);
  `natural` itself is a devDependency the differential test runs against (`tests/types/` holds its
  minimal typings). No Node APIs in `src/` (Hermes must run it); `.json.gz` reading lives in
  `tests/helpers/loadModel.ts` only. How the model asset ships is decided (uncompressed module,
  PORTING.md §3.9).
- `NumpyCRFInference` takes the parsed model JSON (`CRFModelJson`,
  shape from `train/export.py`) and exposes `tag_from_features(featureDicts)` →
  `[label, confidence][]` and `marginal(label, position)`.
- `NumpyViterbiInference` holds `Int32Array` emission
  (features × labels) and transition (labels × labels) matrices plus float32-dequantized
  transitions, and implements Viterbi with the I_NAME_TOK constraint and forward–backward
  marginals.

## Parity decisions by module (condensed; full notes are kept privately)

- **`inference.ts`** — labels exact by construction (int16 weights summed in float64); marginals
  follow numpy's precision path (float32 dequantisation with weak-scalar semantics, float64
  forward recursion, float32 `transitions + next_emissions` before the float64 beta, `logaddexp`
  as a left fold); residual seam is the engine's `Math.exp`/`Math.log1p` (≤2.8e-14, never a
  label). Upstream's truthiness-gated transition constraint is mirrored. Float32 (unquantized)
  weights are not supported: upstream's own path for them is hash-order dependent.
- **Preprocessing** — Python `re` classes (`\d \s \w \b $`) and `re.IGNORECASE` folding are
  spelled out Unicode-aware; `float()`/`int()` acceptance, `str.replace`, `html.unescape`,
  code-point slicing, `string.punctuation` substring membership and prototype-free dict lookups
  are reimplemented; NLTK's `RegexpParser` is ported at the mechanism level with grammars
  verbatim; constants and entity tables are generated. Three upstream structure-feature tests
  encode NLTK POS tags and are kept as documented expected failures.
- **Output contract** — bigint `Fraction` mirroring CPython; exact `statistics.mean` and
  half-even `round`; a mechanism-level pint subset (name resolution in registry order,
  root-unit factor cancellation keyed by scale, exact factors for rational magnitudes, density
  context, pint's string preprocessor, tokenizer acceptance and expression-tree checks, `str`
  sorted / `repr` in insertion order). Upstream's postprocessor quirks — negative indexing,
  position-vs-index confusions, bounds checks against the wrong list, the `"SQAURE"` key — are
  mirrored and marked `Upstream quirk` in the code; corrections live behind `quirks: 'fixed'`
  (`docs/QUIRKS.md`).
- **Foundation foods** — Snowball stems for the matcher (its tables are Snowball stems), Porter
  for CRF features; Brill tags for FDC descriptions on both sides; assets lazy behind
  `preload_foundation_foods()`; FDC-side caches precomputed by the runtime's own code and
  identity-tested; CPython `set` order emulated where it reaches the output; numpy reductions
  and float32 promotion reproduced; the float32 dot and the hash-ordered fuzzy accumulation are
  the documented confidence seam (VERIFICATION.md §3). Upstream quirks mirrored: the
  `"stronghard"` constant, the desynchronising `normalise_spelling`, `pos_tags` passed as
  `embedding_pos_tags`, the shared override object, the unreachable `"NS"` and comma branches.

## Test layout

- `tests/harness/level2.ts` + `features.test.ts` — recompute feature dicts from raw sentences and
  diff key/value and key order against `features-test.jsonl`; `corpus.test.ts` — full corpus +
  fixtures via `feature-hashes.jsonl` (normalised sentence, tokens, tags, feature-dict sha256).
- `tests/harness/output-ff.test.ts` — level 3 with `foundation_foods: true` over `parsed-ff.jsonl`;
  classifies confidence-only ±1e-6 differences separately from semantic ones.
- `tests/harness/ffcache.test.ts` — the precomputed FDC caches vs the runtime computation
  (sample of rows + full rankers always; every row under `HARNESS=full`).
- `tests/harness/snowball.test.ts`, `pyset.test.ts` — differential tests of the supporting modules;
  `linguistics.test.ts` — the vendored Brill tagger and Porter stemmer against natural 8.1.1 live
  (5,000-line sample + fixtures + adversarial lists always; every line and every FDC description
  under `HARNESS=full`) and against the committed Python-side tags.
- `tests/harness/serialize.ts` + `output.test.ts` — level 3: `parse_ingredient` over `parsed.jsonl`
  (`training/dump-parsed.py`, ship model, corpus + fixtures) compared byte for byte against Python's
  canonical serialisation (Fraction → "Fraction(n, d)", Unit → "<Unit('x')>", floats in Python repr).
- `tests/harness/level1.ts` — streams a dump (`training/dump-features.py`) through the decoder
  and diffs labels / confidences. `tests/harness/decoder.test.ts` runs it on the committed
  60-sequence sample (`tests/goldens/level1-sample.jsonl`, generated, never hand-edited) and,
  when `features-test.jsonl` exists at the repo root or `HARNESS=full`, on the full split.
- `tests/upstream/` — upstream's pytest suite recreated verbatim (45 files, 458 tests);
  Conventions, identifier mapping and the expected-failure policy: `tests/upstream/README.md`.
- `tests/harness/dumps.ts` — resolves each Python reference: the regenerable root file if present,
  else the committed `tests/goldens/parity/<name>.jsonl.gz`.
- `tests/quirks/quirks.test.ts` — every `quirks: 'fixed'` correction asserted in both modes.
- `pnpm test` = vitest; `HARNESS=full pnpm harness` = every level; `EVAL=1` adds the primitive
  goldens; `pnpm typecheck` covers `src/` and the tests.

## Beyond upstream (PORTING.md §8, QUIRKS.md)

Everything above is the parity port. Added without touching the default path:
- `quirks: 'upstream' | 'fixed'` on every parse entry point (`parsers.ts` → `en/parser.ts` →
  `PreProcessor` and `PostProcessor`). `'upstream'` (default) is the harness contract; `'fixed'` gates the
  corrections, each marked `QUIRK fix <name>` in the code and tested in both modes in
  `tests/quirks/quirks.test.ts`. Since 2026-09-09 five of them are input rewrites in
  `PreProcessor._fixed_input_rewrites` / `_identify_fractions` (so fixed mode can tokenise a line
  differently); the rest live in the postprocessor's amount assembly and text restoration.
- `tag_ingredient()` (`parsers.ts`, `en/parser.ts: tag_ingredient_en`): the first half of
  `parse_ingredient_en` — PreProcessor, model, `expect_name_in_output` fallback — returning tokens,
  POS tags, labels and scores; no postprocessor, so none of its mirrored raises.
