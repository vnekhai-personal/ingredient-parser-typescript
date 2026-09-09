# The `quirks` option

`parse_ingredient`, `parse_multiple_ingredients` and `inspect_parser` accept
`quirks: 'upstream' | 'fixed'`.

- `'upstream'` (default) reproduces the Python library at the pin exactly, including its
  postprocessing quirks. This is what the parity harness verifies.
- `'fixed'` applies the corrections below. Each is asserted in both modes in
  `tests/quirks/quirks.test.ts`.

| Name | Upstream behaviour (default) | With `quirks: 'fixed'` |
|---|---|---|
| `duplicate_unit_tokens` | "1 teaspoon (tsp) salt" carries two unit tokens for one unit; they are joined ("teaspoon tsp") and pint reads the space as a product: `teaspoon ** 2` | unit tokens that all name the same unit (equal, equal after singularising, or listed synonyms) collapse to the first: unit `teaspoon`, text "1 teaspoon". Genuinely different units ("1 pound 2 ounce") are untouched |
| `name_pluralisation` | every text field is re-pluralised for unit-like words, so "flat-leaf parsley" becomes "flat-leaves parsley", "1 bay leaf" becomes "bay leaves", "or 1 teaspoon dried" becomes "or 1 teaspoons dried", and brand names such as "Original Recipe" become "Recipes" | a text field restores only the words the preprocessor singularised on the way in: "2 bay leaves" stays "bay leaves", "1 bay leaf" stays "bay leaf", "flat-leaf" and "1 teaspoon dried" are untouched. Since 2026-09-09 this covers name, size, preparation, comment and purpose (it was name-only); amount text keeps upstream's quantity-based pluralisation. Over the training corpus this changes 913 names and about 1,500 other text fields, each to the author's own word |
| `section_headers` | a recipe section header without a colon, "For the sauce" or "To serve", comes back as a low-confidence name | when every token is a name token, the first is "For" or "To" and the name's confidence is below 0.6, the line is returned as `purpose` with an empty name, the same shape upstream produces for "For the sauce:" |
| `multiple_ingredients_default` | `parse_multiple_ingredients` defaults `volumetric_units_system` to `"us"`, which its own validation rejects | the default is `"us_customary"` |
| `literal_escapes` | the two-character sequences `\n`, `\t`, `\r` in the input (an export artefact) stay inside the last word: name "olive oil\n" | they are whitespace |
| `number_words` | upstream converts "one" to "nineteen" and a few fraction words before tagging; "half a lemon" keeps the string quantity `half`, "a couple of sprigs" has no quantity, "a dozen oysters" has the string quantity `dozen` | "half a"/"half an"/"half of a" → 1/2, "a couple (of)" → about 2 (so APPROXIMATE is set by upstream's own rule) where an amount stands (sentence start, after "(", ",", "or", "and", "plus"; not "soaked for a couple of hours"), "a dozen" → 12, "half a dozen" → 6. "a few" is left alone |
| `spaceless_mixed_number` | "11/2 ounces" is eleven halves (5.5) | a two-digit number starting with 1 whose second digit is below the single-digit denominator is a mixed number missing its space: "11/2" → 1 1/2, "13/4" → 1 3/4, "12/3" → 1 2/3. "19/2" and "111/2" are untouched |
| `hyphenated_count_container` | "1-14 1/2-ounce can" is read as a range 1–14½ | when the number after the hyphen is itself hyphen-attached to a word ("14 1/2-ounce") and is more than twice the first number, the hyphen separates a count from a sized container: `1 can` + `14 1/2 ounces` SINGULAR. "2-3 pounds", "2-3-lb roast" and "1 8- to 10-pound goose" stay ranges. 0 corpus lines |
| `dimension_fraction_count` | "12 1/4-inch-thick slices" merges into the mixed number 12¼ before tagging: `1 slice` + `12 1/4 inch-thick` | when the fraction is hyphen-attached to a dimension word (inch, cm, mm, optionally "-thick"/"-thin") and a plural word follows, the whole number stays a count: `12 slices`, size "1/4 inch-thick". A singular noun ("1 1/2-inch-thick slice") or a preceding count ("2 1 1/2-pound eggplants") keeps upstream's reading |
| `size_adjective_container` | the container pattern reads "10 to 20 thin slices" like "14 ounce can": `1 slice` + `10-20 thin` SINGULAR, the count lost | when the middle word is a size word (upstream's SIZES table, plus "-thick", "-thin", "-size", "-sized", "-cut", "paper-thin", "round", …) rather than a measure, the quantity counts the containers and the word becomes `size`: `10-20 slice` (RANGE), size "thin". Measurable inner units ("14 1/2 ounce can") and unresolvable spellings ("500 gm tin") are untouched. 233 corpus lines |
| `each_before_amount` | only "each" AFTER an amount marks it SINGULAR ("4 pounds each"); "6 apples, each weighing about 6 ounces" leaves the 6 ounces as a total, comment "each weighing" | up to three comment tokens before the quantity are searched for "each"; the run is consumed: `6 ounces` SINGULAR APPROXIMATE, no comment. 40 corpus lines |
| `stray_unit_token` | every UNIT token joins the current amount however far away it is: "2 ounces ginger root (one 3-inch knob)" has unit "ounces knobs"; "8 (1 ounce) squares white chocolate" has `8` + `1 ounce square`; "(a scant 1 1/3 cups)" has unit "ounces scant" | a UNIT token that follows a parenthesis or a size/comment run instead of the amount completes the nearest unit-less amount ("8 squares" + "1 ounce", the parenthetical measure flagged SINGULAR as per-container, exactly as upstream flags "1 (14 oz) can") or, failing that, joins the field of the token before it (size "(one 3 inch knob)"). Size and approximation words ("scant", "large") never complete an amount. After a name token ("4 large garlic cloves") upstream's reading stays |
| `placeholder_text` | a range containing a mixed number ("cut into 1- to 1 1/2-inch cubes") leaks the internal fraction placeholder: "cut into 1-1#1$2 inch cubes" | placeholders are restored wherever they occur: "cut into 1-1 1/2 inch cubes" |

The input corrections (`literal_escapes`, `number_words`, `spaceless_mixed_number`,
`hyphenated_count_container`, `dimension_fraction_count`) rewrite the sentence before
tokenisation, so in `'fixed'` mode the model can see different tokens on those lines; each was
checked on every corpus line it touches. `tag_ingredient` honours `quirks` for them.

Over the training corpus `'fixed'` changes 3,060 of 81,416 lines: 913 names and about 1,550
other text fields through the pluralisation restore, and 544 amount lists: 222 size-adjective
containers, 195 parenthetical container sizes and 37 fused units (`stray_unit_token`), 49
number words, 18 dimension counts, 16 `each` flags, 5 spaceless mixed numbers. Every one of the
3,060 changed lines was read, each with the fields that differ between the two modes. The first
version of this batch failed that review on seven shapes ("4 large garlic cloves",
"2 1 1/2-pound eggplants", "(1½-inch pieces)", "Very thin lemon slices", "2-3-lb roast",
"scant ½ cup", "a couple of hours" in prose), which is what the guards in the table are for.
One rewrite reaches prose by design: "a dozen" becomes 12 wherever it stands ("cut into a dozen
2-ounce slices" → "cut into 12 2 ounce slices"), since it is a count in every position.

Not changed, with reasons: a phrase like "A mess of greens" being labelled as a name is the
model's decision, not postprocessing, and so are "with liquid" or "Julienned" inside a name.
"plus" across an intervening preparation ("1 tablespoon butter, softened, plus 7 tablespoons")
is not grouped because the same wording ("plus more for dusting") usually means an extra
amount for another purpose; the consumer sees both amounts and the comment. Amounts belonging
to different alternatives ("2 cups fresh peas or one 10-ounce package frozen peas") are not
linked to their names. Unit words the model never saw (`mls`) are what `custom_units` is for.
Typos ("tablepoons") are not corrected. Custom-unit singulars containing regex syntax are
undefined on both sides.

## `tag_ingredient`

An addition beyond the upstream API, independent of `quirks`:

```ts
tag_ingredient(sentence, options) // → { sentence, tokens, pos_tags, labels, scores }
```

The model's per-token labels and marginal scores exactly as `parse_ingredient` computes them —
same preprocessing, same model, same `expect_name_in_output` fallback, same `custom_units` —
without the postprocessor. A caller that builds its own structure from labels never meets a
postprocessing quirk or one of the raises upstream's postprocessor produces on some inputs
("dozen eggs or 2" raises in `parse_ingredient`; `tag_ingredient` returns its labels).
