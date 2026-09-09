/**
 * Port of `ingredient_parser/en/postprocess.py` (pin ffd6ae3). Identifiers are upstream's
 * verbatim. Behaviour is ported 1:1, quirks included — see the `Upstream quirk` comments;
 * `logger.debug` calls are dropped.
 */
import { consume, group_consecutive_idx } from '../_common.js';
import {
  CompositeIngredientAmount,
  type FoundationFood,
  type IngredientAmount,
  IngredientText,
  type LabelledToken,
  ParsedIngredient,
} from '../dataclasses.js';
import { PY_W, pyMean, pyReplaceAll, pyReprStr, pyRound, pyStrip } from '../_py.js';
import {
  APPROXIMATE_PREFIXES,
  APPROXIMATE_SUFFIXES,
  INDEFINITE_QUANTIFIERS,
  PREPARED_INGREDIENT_TOKENS,
  SINGULAR_TOKENS,
  SIZES,
  STOP_WORDS,
  STRING_NUMBERS_REGEXES,
} from './_constants.js';
import { FRACTION_TOKEN_PATTERN } from './_regex.js';
import {
  combine_quantities_split_by_and,
  ingredient_amount_factory,
  is_unit_synonym,
  pluralise_units,
  replace_string_range,
} from './_utils.js';
import { UNITS } from './_constants.js';

/**
 * `'upstream'` reproduces Python at the pin byte for byte (the harness contract); `'fixed'` applies
 * this port's corrections of documented upstream bugs (docs/QUIRKS.md). Default `'upstream'`.
 */
export type Quirks = 'upstream' | 'fixed';
import { match_foundation_foods } from './foundationfoods/index.js';

export const WORD_CHAR = new RegExp(PY_W, 'u');

// ---------------------------------------------------------------------------------------
// Python-semantics helpers local to this module
// ---------------------------------------------------------------------------------------

/**
 * Python list indexing: negative indices wrap to the end, out-of-range raises
 * (Python: IndexError). Used wherever upstream indexes with a value that can be negative or
 * is a sentence index rather than a list position.
 */
function pyAt<T>(a: readonly T[], i: number): T {
  const j = i < 0 ? a.length + i : i;
  if (j < 0 || j >= a.length) {
    // Python: IndexError
    throw new RangeError('list index out of range');
  }
  return a[j] as T;
}

/** Python `list == list` for flat string lists (element-wise). */
function listEq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Python `list in list_of_lists` for flat string lists. */
function listIn(a: readonly string[], lists: readonly (readonly string[])[]): boolean {
  return lists.some((l) => listEq(a, l));
}

// ---------------------------------------------------------------------------------------

export interface PartialIngredientAmountInit {
  quantity: string;
  unit: string[];
  confidence: number[];
  starting_index: number;
  related_to_previous?: boolean;
  APPROXIMATE?: boolean;
  SINGULAR?: boolean;
  implicit_quantity?: boolean;
}

/** Dataclass for incrementally building ingredient amount information. */
/** Two unit token texts (possibly pluralised) name the same unit: equal, equal after singularising, or synonyms. */
// QUIRK fix `size_adjective_container`: words the model labels UNIT in "10 thin slices" that are
// sizes, not measures. Upstream's SIZES table plus the shapes the corpus uses ("paper-thin",
// "1/2-inch-thick", "nickel-size", "thumb-sized", "thick-cut").
const SIZE_SUFFIX = /-(thick|thin|size|sized|cut)$/u;
const DIMENSION_SUFFIX = /-(thick|thin)$/u;
const EXTRA_SIZE_WORDS: ReadonlySet<string> = new Set(['round', 'square', 'long', 'short', 'fine', 'coarse', 'thickish', 'paper-thin', 'wafer-thin']);
function is_size_word(text: string): boolean {
  const lower = text.toLowerCase();
  return SIZES.includes(lower) || EXTRA_SIZE_WORDS.has(lower) || SIZE_SUFFIX.test(lower);
}
/**
 * QUIRK fix `stray_unit_token` helper: words that can never be the unit completing an amount — sizes
 * proper and approximation words ("scant", "generous"). Narrower than `is_size_word`: "square" and
 * "round" are containers in noun position ("8 (1 ounce) squares", "1 (8 ounce) round Reblochon").
 */
const EXTRA_DESCRIPTIVE_WORDS: ReadonlySet<string> = new Set(['paper-thin', 'wafer-thin', 'thickish', 'scant', 'heaping', 'heaped', 'rounded', 'level']);
function is_descriptive_word(text: string): boolean {
  const lower = text.toLowerCase();
  return SIZES.includes(lower) || SIZE_SUFFIX.test(lower) || EXTRA_DESCRIPTIVE_WORDS.has(lower) || APPROXIMATE_PREFIXES.includes(lower);
}
/** A fraction placeholder anywhere in a token ("1-1#1$2"), where FRACTION_TOKEN_PATTERN wants the whole token. */
const FRACTION_PLACEHOLDER = /#[0-9]+\$[0-9]+/u;

function sameUnit(a: string, b: string): boolean {
  const sing = (u: string): string => (Object.hasOwn(UNITS, u) ? (UNITS as Record<string, string>)[u] as string : u);
  const sa = sing(a).toLowerCase();
  const sb = sing(b).toLowerCase();
  return sa === sb || is_unit_synonym(sa, sb);
}

export class _PartialIngredientAmount {
  quantity: string;
  unit: string[];
  confidence: number[];
  starting_index: number;
  related_to_previous: boolean;
  APPROXIMATE: boolean;
  SINGULAR: boolean;
  /** Upstream: a class attribute (`PREPARED_INGREDIENT = False`), not an init field. */
  PREPARED_INGREDIENT = false;
  implicit_quantity: boolean;

  constructor(a: PartialIngredientAmountInit) {
    this.quantity = a.quantity;
    this.unit = a.unit;
    this.confidence = a.confidence;
    this.starting_index = a.starting_index;
    this.related_to_previous = a.related_to_previous ?? false;
    this.APPROXIMATE = a.APPROXIMATE ?? false;
    this.SINGULAR = a.SINGULAR ?? false;
    this.implicit_quantity = a.implicit_quantity ?? false;
  }
}

export interface PostProcessorOptions {
  custom_units: Readonly<Record<string, string>>;
  quirks?: Quirks;
  separate_names?: boolean;
  discard_isolated_stop_words?: boolean;
  string_units?: boolean;
  volumetric_units_system?: string;
  foundation_foods?: boolean;
}

interface CompositePatternInfo {
  pattern: string[];
  conjunction: string | null;
  conj_index: number | null;
  start1: number;
  start2: number;
  join: string;
  subtractive: boolean;
}

/**
 * Recipe ingredient sentence PostProcessor class: turns the labelled tokens from the CRF
 * into a coherent `ParsedIngredient`.
 */
export class PostProcessor {
  sentence: string;
  tokens: LabelledToken[];
  custom_units: Readonly<Record<string, string>>;
  quirks: Quirks;
  separate_names: boolean;
  discard_isolated_stop_words: boolean;
  string_units: boolean;
  volumetric_units_system: string;
  foundation_foods: boolean;
  consumed: number[];
  /** Upstream sets `self.labels` only on the `separate_names=False` path of `parsed`. */
  labels?: string[];

  #parsed: ParsedIngredient | undefined = undefined;

  constructor(sentence: string, labelled_tokens: LabelledToken[], options: PostProcessorOptions) {
    this.sentence = sentence;
    this.tokens = labelled_tokens;
    this.custom_units = options.custom_units;
    this.quirks = options.quirks ?? 'upstream';
    this.separate_names = options.separate_names ?? true;
    this.discard_isolated_stop_words = options.discard_isolated_stop_words ?? true;
    this.string_units = options.string_units ?? false;
    this.volumetric_units_system = options.volumetric_units_system ?? 'us_customary';
    this.foundation_foods = options.foundation_foods ?? false;
    this.consumed = [];
  }

  /** `__repr__`. */
  repr(): string {
    return `PostProcessor("${this.sentence}")`;
  }

  /** `__str__`: human readable representation (Python prints a list of tuples). */
  toString(): string {
    const tokens_labels: [string, string][] = this.tokens.map((t) => [t.text, t.label]);
    const _str = [
      'Post-processed recipe ingredient sentence',
      '\t[' + tokens_labels.map(([t, l]) => '(' + pyReprStr(t) + ', ' + pyReprStr(l) + ')').join(', ') + ']',
    ];
    return _str.join('\n');
  }

  /** `@cached_property parsed`: return parsed ingredient data (computed once). */
  get parsed(): ParsedIngredient {
    if (this.#parsed !== undefined) return this.#parsed;

    const amounts = this._postprocess_amounts();

    let foundationfoods: FoundationFood[] = [];
    let name: IngredientText[];
    if (this.separate_names) {
      [name, foundationfoods] = this._postprocess_names();
    } else {
      // Replace all labels containing NAME with "NAME"
      const name_replaced_labels: string[] = [];
      for (const t of this.tokens) {
        if (t.label.includes('NAME')) {
          t.label = 'NAME';
        }
      }
      this.labels = name_replaced_labels;

      // Process NAME labels as any other label, but return as a list
      const processed_name = this._postprocess('NAME');
      if (processed_name) {
        name = [processed_name];
        if (this.foundation_foods) {
          // Extract name tokens. We can only return a single foundation food,
          // but we still need to return a list.
          const name_pos: [string, string][] = this.tokens
            .filter((t) => t.label === 'NAME')
            .map((t) => [t.text, t.pos_tag]);
          const name_tokens = name_pos.map(([text]) => text);
          const pos_tags = name_pos.map(([, pos]) => pos);
          const ff = match_foundation_foods(name_tokens, pos_tags, 0);
          if (ff) {
            foundationfoods = [ff];
          }
        }
      } else {
        name = [];
      }
    }

    const size = this._postprocess('SIZE');
    const preparation = this._postprocess('PREP');
    const comment = this._postprocess('COMMENT');
    let purpose = this._postprocess('PURPOSE');

    // QUIRK fix `section_headers` (docs/PORTING.md): a recipe section header such as "For the sauce" or
    // "To serve" has no amount and gets labelled as a low-confidence name by the model. In 'fixed'
    // mode a sentence whose tokens are ALL name tokens, starting with For/To, with the name's
    // confidence below 0.6, is returned as `purpose` (what upstream itself produces when a colon
    // follows: "For the sauce:" → PURPOSE) and no name.
    if (
      this.quirks === 'fixed' &&
      amounts.length === 0 &&
      name.length === 1 &&
      purpose === null &&
      this.tokens.every((t) => t.label.includes('NAME')) &&
      /^(for|to)$/i.test(this.tokens[0]?.text ?? '') &&
      (name[0] as IngredientText).confidence < 0.6
    ) {
      purpose = name[0] as IngredientText;
      name = [];
      foundationfoods = [];
    }

    this.#parsed = new ParsedIngredient({
      name,
      size,
      amount: amounts,
      preparation,
      comment,
      purpose,
      foundation_foods: foundationfoods,
      sentence: this.sentence,
    });
    return this.#parsed;
  }

  /** Process tokens with `selected_label` (plus PUNC) into an IngredientText, or null. */
  _postprocess(selected_label: string): IngredientText | null {
    // Select indices of tokens, labels and scores for selected_label
    // Do not include tokens, labels and scores in self.consumed
    const label_idx: number[] = [];
    this.tokens.forEach((t, i) => {
      if ((t.label === selected_label || t.label === 'PUNC') && !this.consumed.includes(i)) {
        label_idx.push(i);
      }
    });

    // If idx is empty or all the selected idx are PUNC, return None
    if (label_idx.length === 0 || label_idx.every((i) => (this.tokens[i] as LabelledToken).label === 'PUNC')) {
      return null;
    }

    return this._postprocess_indices(label_idx, selected_label);
  }

  /** Process the ingredient name(s), one IngredientText per alternative name. */
  _postprocess_names(): [IngredientText[], FoundationFood[]] {
    const name_idx: number[] = [];
    this.tokens.forEach((t, i) => {
      if ((t.label.includes('NAME') || t.label === 'PUNC') && !this.consumed.includes(i)) {
        name_idx.push(i);
      }
    });

    // If idx is empty or all the selected idx are PUNC, return None
    if (name_idx.length === 0 || name_idx.every((i) => (this.tokens[i] as LabelledToken).label === 'PUNC')) {
      return [[], []];
    }

    const name_labels = name_idx.map((i) => (this.tokens[i] as LabelledToken).label);
    const bio_groups = this._group_name_labels(name_labels);
    const constructed_names = this._construct_names_from_bio_groups(bio_groups);
    const [names, foundation_foods] = this._convert_name_indices_to_object(name_idx, constructed_names);
    return [names, foundation_foods];
  }

  /** Merge IngredientText objects: texts joined by a space (or one if all equal), mean confidence, min index. */
  _merge(objs: IngredientText[]): IngredientText {
    // Python `sorted` is stable; so is JS `toSorted` with a comparator.
    const sorted_objs = [...objs].sort((a, b) => a.starting_index - b.starting_index);

    let text: string;
    if (new Set(sorted_objs.map((n) => n.text)).size === 1) {
      text = (sorted_objs[0] as IngredientText).text;
    } else {
      text = sorted_objs.map((n) => n.text).join(' ');
    }

    const merged = new IngredientText({
      text,
      confidence: pyRound(pyMean(sorted_objs.map((n) => n.confidence)), 6),
      starting_index: Math.min(...sorted_objs.map((n) => n.starting_index)),
    });
    return merged;
  }

  /** Group name labels into BIO groups of (index, label) tuples. */
  _group_name_labels(name_labels: string[]): [number, string][][] {
    const name_groups: [number, string][][] = [];
    let current_group: [number, string][] = [];
    let prev_label: string | null = null;
    name_labels.forEach((label, idx) => {
      // Start new group on NAME_SEP name label
      if (label === 'NAME_SEP') {
        if (current_group.length > 0) {
          name_groups.push(current_group);
        }
        current_group = [];
      }
      // Start new group for new "B_*" name label
      else if (label.startsWith('B_')) {
        if (current_group.length > 0) {
          name_groups.push(current_group);
        }
        current_group = [[idx, label]];
      }
      // Start new group if encountering new NAME_MOD or NAME_VAR, or append to
      // current group if previous label was the same as current label.
      else if (label === 'NAME_MOD' || label === 'NAME_VAR') {
        if (prev_label === label) {
          current_group.push([idx, label]);
        } else {
          if (current_group.length > 0) {
            name_groups.push(current_group);
          }
          current_group = [[idx, label]];
        }
      }
      // Must be an I_NAME_TOK or PUNC label, so append to current group
      else {
        current_group.push([idx, label]);
      }

      prev_label = label;
    });

    // Add last group to list if not empty
    if (current_group.length > 0) {
      name_groups.push(current_group);
    }

    return name_groups;
  }

  /** Construct names from BIO groups: VAR groups prepend the next TOK group, MOD groups all subsequent. */
  _construct_names_from_bio_groups(name_groups: [number, string][][]): number[][] {
    let constructed_names: number[][] = [];

    // Keep track the last TOK group we come across (moving from last to first).
    // Also keep track of whether we have used it by prepending a VAR or MOD group.
    let last_encountered_name: number[] | null = null;
    let last_encountered_name_used = false;

    // Iterate from last to first BIO group
    for (const group of [...name_groups].reverse()) {
      // `zip(*group)` — Python raises ValueError for an empty group (unreachable: groups are never empty).
      const current_group_idx = group.map(([idx]) => idx);
      const labels = group.map(([, label]) => label);
      const current_label = this._get_name_group_label(labels);

      if (current_label === 'TOK') {
        // If we've previously come across a TOK group and haven't used it, then store it.
        if (last_encountered_name && last_encountered_name.length > 0 && !last_encountered_name_used) {
          constructed_names.push(last_encountered_name);
        }

        // Set current group to last_encountered_name group.
        last_encountered_name = current_group_idx;
        last_encountered_name_used = false;
      } else if (current_label === 'VAR') {
        // Prepend this group to last encountered NAME group
        if (last_encountered_name && last_encountered_name.length > 0) {
          constructed_names.push([...current_group_idx, ...last_encountered_name]);
          last_encountered_name_used = true;
        } else {
          // A VAR group that does not precede a TOK group (model labelling error). Add it anyway.
          constructed_names.push(current_group_idx);
        }
      } else if (current_label === 'MOD') {
        // If we've previously come across a NAME group and haven't used it, then store it.
        if (last_encountered_name && last_encountered_name.length > 0 && !last_encountered_name_used) {
          constructed_names.push(last_encountered_name);
          last_encountered_name_used = true;
        }

        // Prepend this group to all constructed names so far
        constructed_names = constructed_names.map((name) => [...current_group_idx, ...name]);
      }
    }

    // If we've iterated through all BIO groups and haven't used last_encountered_name, add it now.
    if (last_encountered_name && last_encountered_name.length > 0 && !last_encountered_name_used) {
      constructed_names.push(last_encountered_name);
    }

    // Return reversed list, so names are in the order they appear in sentence.
    return constructed_names.reverse();
  }

  /** NAME label type for a name group: one of TOK, VAR, MOD ("" if all PUNC). */
  _get_name_group_label(labels: readonly string[]): string {
    for (const label of labels) {
      if (label !== 'PUNC') {
        return label.split('_').at(-1) as string;
      }
    }

    return '';
  }

  /**
   * Convert grouped name indices into IngredientText objects (merging a name that ends in
   * DT/IN/JJ with the next, and duplicate names together), plus foundation foods.
   */
  _convert_name_indices_to_object(name_idx: number[], name_index_groups: number[][]): [IngredientText[], FoundationFood[]] {
    // Keep track of IngredientText objects and indices to merge with next.
    // We do the merge if the name ends with DT, IN, JJ part of speech tag.
    let merge_with_next = false;
    let merge_with_next_idx: number[] = [];

    // Merge name_idx group with next if it ends with DT, IN or JJ part of speech tag.
    const merged_name_idx: number[][] = [];
    for (const group of name_index_groups) {
      // Convert from name_label indices to token indices
      let token_idx = group.map((idx) => pyAt(name_idx, idx));

      if (merge_with_next && merge_with_next_idx.length > 0) {
        token_idx = [...merge_with_next_idx, ...token_idx];
      }

      const pos = this._last_non_punc_token_pos(token_idx);
      if (pos === 'DT' || pos === 'IN' || pos === 'JJ') {
        // Mark name for merging with next name.
        merge_with_next = true;
        merge_with_next_idx = token_idx;
        // Skip to next iteration
        continue;
      } else {
        merged_name_idx.push(token_idx);
        merge_with_next = false;
        merge_with_next_idx = [];
      }
    }

    if (merge_with_next && merge_with_next_idx.length > 0) {
      // Catch any remaining name indices marked as needing to be merged but haven't been.
      merged_name_idx.push(merge_with_next_idx);
    }

    // Build IngredientText objects, merging duplicate names where found.
    const names: IngredientText[] = [];
    const foundation_foods: FoundationFood[] = [];
    for (const token_idx of merged_name_idx) {
      const ing_text = this._postprocess_indices(token_idx, 'NAME');
      if (!ing_text) {
        continue;
      }

      if (names.some((n) => n.text === ing_text.text)) {
        const dupe_idx: number[] = [];
        names.forEach((n, i) => {
          if (n.text === ing_text.text) dupe_idx.push(i);
        });
        const merged = this._merge([...dupe_idx.map((i) => names[i] as IngredientText), ing_text]);
        names[dupe_idx[0] as number] = merged;
      } else {
        names.push(ing_text);

        if (this.foundation_foods) {
          // We don't match foundation foods for duplicate names because we will have
          // already found any match for the first instance of the name.
          const tokens = token_idx.map((i) => pyAt(this.tokens, i).text);
          const pos_tags = token_idx.map((i) => pyAt(this.tokens, i).pos_tag);
          const ff = match_foundation_foods(tokens, pos_tags, names.length - 1);
          if (ff) {
            foundation_foods.push(ff);
          }
        }
      }
    }

    return [names, foundation_foods];
  }

  /** POS tag of the last non-punctuation index in token_idx ("" if none). */
  _last_non_punc_token_pos(token_idx: number[]): string {
    for (const idx of [...token_idx].reverse()) {
      if (pyAt(this.tokens, idx).label === 'PUNC') {
        continue;
      }

      return pyAt(this.tokens, idx).pos_tag;
    }

    // Return empty string so we don't try to merge this with the next name.
    return '';
  }

  /**
   * Process a list of token indices into a single IngredientText: consecutive tokens are
   * joined by a space, non-consecutive groups by ", " (a space for NAME). Null if nothing left.
   */
  _postprocess_indices(label_idx: number[], selected_label: string): IngredientText | null {
    // Join consecutive tokens together and average their score
    let parts: string[] = [];
    let confidence_parts: number[] = [];
    let starting_index = pyAt(label_idx, -1);
    for (const group of group_consecutive_idx(label_idx)) {
      let idx = [...group];
      idx = this._remove_invalid_indices(idx);

      if (idx.every((i) => pyAt(this.tokens, i).label === 'PUNC')) {
        // Skip if the group only contains PUNC
        continue;
      }

      // Convert any fractions in intermediate form (i.e. #1$2) into text
      const group_tokens: string[] = [];
      for (const i of idx) {
        const tokText = pyAt(this.tokens, i).text;
        // QUIRK fix `placeholder_text`: upstream only restores tokens that are entirely a fraction, so a
        // range with a mixed number ("1- to 1 1/2-inch" → "1-1#1$2") leaks its placeholder into the text.
        if (FRACTION_TOKEN_PATTERN.test(tokText) || (this.quirks === 'fixed' && FRACTION_PLACEHOLDER.test(tokText))) {
          let text_fraction = pyStrip(pyReplaceAll(pyReplaceAll(tokText, '#', ' '), '$', '/'));
          // If fraction range, remove space that will follow hyphen caused by replacing # with space.
          text_fraction = pyReplaceAll(text_fraction, '- ', '-');
          group_tokens.push(text_fraction);
        } else if (this.quirks === 'fixed' && pyAt(this.tokens, i).plural) {
          // QUIRK fix `name_pluralisation`: the preprocessor singularised this token ("leaves" → "leaf");
          // restore its plural here, per token, instead of re-pluralising the whole text below. Since
          // 2026-09-09 this applies to every text field, not only NAME ("(one 3-inch knob)" stays singular).
          group_tokens.push(pluralise_units(tokText, this.custom_units));
        } else {
          group_tokens.push(tokText);
        }
      }

      const joined = group_tokens.join(' ');
      const confidence = pyMean(idx.map((i) => pyAt(this.tokens, i).score));

      if (this.discard_isolated_stop_words && STOP_WORDS.has(joined.toLowerCase())) {
        // Skip part if it's a stop word
        continue;
      }

      this.consumed.push(...idx);
      parts.push(joined);
      confidence_parts.push(confidence);
      starting_index = Math.min(starting_index, idx[0] as number);
    }

    // Find the indices of the joined tokens list where the element
    // is the same as the previous element in the list.
    const keep_idx = this._remove_adjacent_duplicates(parts);
    parts = keep_idx.map((i) => parts[i] as string);
    confidence_parts = keep_idx.map((i) => confidence_parts[i] as number);

    // Join all the parts together into a single string and fix any punctuation weirdness.
    // If the selected_label is NAME, join with a space. For all other labels, join
    // with a comma and a space.
    let text: string;
    if (selected_label === 'NAME') {
      text = parts.join(' ');
    } else {
      text = parts.join(', ');
    }
    text = this._fix_punctuation(text);
    // QUIRK fix `name_pluralisation` (docs/PORTING.md): upstream re-pluralises every unit word inside
    // every IngredientText, so a NAME like "flat-leaf parsley" becomes "flat-leaves parsley". In
    // 'fixed' mode a NAME only restores the tokens the preprocessor singularised (per token, above);
    // other fields keep upstream's behaviour.
    if (this.quirks !== 'fixed') text = pluralise_units(text, this.custom_units);

    if (parts.length === 0) {
      return null;
    }

    return new IngredientText({
      text,
      confidence: pyRound(pyMean(confidence_parts), 6),
      starting_index,
    });
  }

  /** Process tokens into IngredientAmount / CompositeIngredientAmount objects, sorted by starting index. */
  _postprocess_amounts(): (IngredientAmount | CompositeIngredientAmount)[] {
    this._convert_string_number_qty();

    const funcs: ((tokens: LabelledToken[]) => (IngredientAmount | CompositeIngredientAmount)[])[] = [
      (tokens) => this._sizeable_unit_pattern(tokens),
      (tokens) => this._composite_amounts_pattern(tokens),
      (tokens) => this._fallback_pattern(tokens),
    ];

    const amounts: (IngredientAmount | CompositeIngredientAmount)[] = [];
    for (const func of funcs) {
      const tokens = this._unconsumed(this.tokens);

      const parsed_amounts = func(tokens);
      amounts.push(...parsed_amounts);
    }

    // Python `sorted` is stable; JS `sort` with a comparator is stable too.
    return [...amounts].sort((a, b) => a.starting_index - b.starting_index);
  }

  /** Elements of `list_` whose `.index` is not in `consumed`. */
  _unconsumed(list_: LabelledToken[]): LabelledToken[] {
    return list_.filter((el) => !this.consumed.includes(el.index));
  }

  /** Remove indices of punctuation that cannot start/end a phrase, and unmatched brackets. */
  _remove_invalid_indices(idx: number[]): number[] {
    // For groups with more than 1 element, remove invalid leading and trailing
    // punctuation so they don't get incorrectly consumed.
    const leading = [')', ']', '}', ',', ':', ';', '-', '.', '!', '?', '*', '&', '/', '--'];
    while (idx.length > 1 && leading.includes(pyAt(this.tokens, idx[0] as number).text)) {
      idx = idx.slice(1);
    }

    const trailing = ['[', '(', '{', ',', ':', ';', '-', '&', '/', '*', '--', '+'];
    while (idx.length > 1 && trailing.includes(pyAt(this.tokens, pyAt(idx, -1)).text)) {
      idx = idx.slice(0, -1);
    }

    // Remove brackets that aren't part of a matching pair
    const idx_to_remove: number[] = [];
    let tok_name: string | null = null; // Unnecessary, but prevents typing errors
    const stack = new Map<string | null, number[]>(); // Separate stack for each bracket type (defaultdict(list))
    const stackFor = (name: string | null): number[] => {
      let s = stack.get(name);
      if (s === undefined) {
        s = [];
        stack.set(name, s);
      }
      return s;
    };
    const toks = idx.map((i) => pyAt(this.tokens, i).text);
    toks.forEach((tok, i) => {
      if (tok === '(' || tok === ')') {
        tok_name = 'PAREN';
      } else if (tok === '[' || tok === ']') {
        tok_name = 'SQAURE';
      }

      if (tok === '(' || tok === '[') {
        // Add index to stack when we find an opening parens
        stackFor(tok_name).push(i);
      } else if (tok === ')' || tok === ']') {
        if (stackFor(tok_name).length === 0) {
          // If the stack is empty, we've found a dangling closing parens
          idx_to_remove.push(i);
        } else {
          // Remove last added index from stack when we find a closing parens
          stackFor(tok_name).pop();
        }
      }
    });

    // Insert anything left in stack into idx_to_remove and remove
    for (const stack_idx of stack.values()) {
      idx_to_remove.push(...stack_idx);
    }
    idx = idx.filter((_, i) => !idx_to_remove.includes(i));

    return idx;
  }

  /** Fix common punctuation errors that result from joining tokens. */
  _fix_punctuation(text: string): string {
    if (text === '') {
      return text;
    }

    // Correct space following open parens or before close parens
    text = pyReplaceAll(pyReplaceAll(text, '( ', '('), ' )', ')');

    // Remove space around forward slash
    text = pyReplaceAll(text, ' / ', '/');

    // Correct space preceding various punctuation
    for (const punc of [',', ':', ';', '.', '!', '?', '*']) {
      text = pyReplaceAll(text, ` ${punc}`, punc);
    }

    return pyStrip(text);
  }

  /** Indices of `parts` to keep after dropping adjacent duplicates. */
  _remove_adjacent_duplicates(parts: string[]): number[] {
    const idx_to_keep: number[] = [];
    // pairwise([*parts, ""])
    const padded = [...parts, ''];
    for (let i = 0; i < padded.length - 1; i++) {
      const first = padded[i];
      const second = padded[i + 1];
      if (first !== second) {
        idx_to_keep.push(i);
      }
    }

    return idx_to_keep;
  }

  /** Replace string numbers (one, two, …) with numeric values. */
  _replace_string_numbers(text: string): string {
    for (const [regex, substitution] of Object.values(STRING_NUMBERS_REGEXES)) {
      // The substitutions carry no backslashes, so `re.sub`'s template is the literal string.
      text = text.replace(regex, () => substitution);
    }

    return text;
  }

  /**
   * Convert QTY tokens that are string numbers to numeric values, collapsing
   * "one and one-half" → "1#1$2" and "one or two" → "1-2" (modifies tokens in place).
   */
  _convert_string_number_qty(): void {
    for (const t of this.tokens) {
      if (t.label === 'QTY') {
        // Upstream quirk: `self.tokens[t.index]` indexes by position, not by the token itself.
        pyAt(this.tokens, t.index).text = this._replace_string_numbers(t.text);
      }
    }

    const QTY_idx = this.tokens.filter((t) => t.label === 'QTY').map((t) => t.index);

    // Find any cases where a group of consecutive QTY tokens can be collapsed into
    // a single token. Modify the first token and score in the group and mark all
    // others in group for deletion.
    const idx_to_remove: number[] = [];
    for (const group of group_consecutive_idx(QTY_idx)) {
      const idx_group = [...group];
      if (idx_group.length === 1) {
        continue;
      }

      const fragment = idx_group.map((i) => pyAt(this.tokens, i).text).join(' ');

      let replacement = combine_quantities_split_by_and(fragment);
      if (replacement !== fragment) {
        const mod_idx = idx_group[0] as number; // Index to replace with replacement
        pyAt(this.tokens, mod_idx).score = pyMean(idx_group.map((i) => pyAt(this.tokens, i).score));
        pyAt(this.tokens, mod_idx).text = replacement;

        idx_to_remove.push(...idx_group.slice(1));
        continue;
      }

      replacement = replace_string_range(fragment);
      if (replacement !== fragment) {
        const mod_idx = idx_group[0] as number; // Index to replace with replacement
        pyAt(this.tokens, mod_idx).score = pyMean(idx_group.map((i) => pyAt(this.tokens, i).score));
        pyAt(this.tokens, mod_idx).text = replacement;

        idx_to_remove.push(...idx_group.slice(1));
        continue;
      }
    }

    if (idx_to_remove.length > 0) {
      this.tokens = this.tokens.filter((t) => !idx_to_remove.includes(t.index));
    }
  }

  /**
   * "Sizeable unit" pattern: a quantity-unit pair split by one or more quantity-unit pairs
   * ("1 28 ounce can", "15 ounce can"). Returns the amounts, or an empty list.
   */
  _sizeable_unit_pattern(tokens: LabelledToken[]): IngredientAmount[] {
    // We assume that the pattern will not be longer than the longest list defined here.
    const patterns: string[][] = [
      ['QTY', 'QTY', 'UNIT', 'QTY', 'UNIT', 'QTY', 'UNIT', 'UNIT'],
      ['QTY', 'QTY', 'UNIT', 'QTY', 'UNIT', 'UNIT'],
      ['QTY', 'QTY', 'UNIT', 'UNIT'],
      ['QTY', 'UNIT', 'UNIT'],
    ];

    // List of possible units at end of pattern that constitute a match
    const end_units = [
      'bag',
      'block',
      'bottle',
      'box',
      'bucket',
      'can',
      'carton',
      'container',
      'envelope',
      'jar',
      'loaf',
      'package',
      'packet',
      'piece',
      'sachet',
      'slice',
      'tin',
    ];

    const amounts: IngredientAmount[] = [];
    for (const pattern of patterns) {
      for (const match of this._match_pattern(tokens, pattern, { ignore_other_labels: true })) {
        // The [QTY, UNIT, UNIT] pattern can match the tail end of a longer pattern like
        // [QTY, QTY, UNIT, UNIT]. Skip matches whose indices were already consumed by a longer pattern.
        if (match.some((i) => this.consumed.includes(pyAt(tokens, i).index))) {
          continue;
        }

        // If the pattern ends with one of end_units, we have found a match for this pattern!
        if (end_units.includes(pyAt(tokens, pyAt(match, -1)).text)) {
          // Get tokens and scores that are part of match
          const matching_tokens = match.map((i) => pyAt(tokens, i).text);
          const matching_scores = match.map((i) => pyAt(tokens, i).score);

          // Keep track of indices of matching elements so we don't use them again elsewhere
          this.consumed.push(...match.map((i) => pyAt(tokens, i).index));

          let first: IngredientAmount;
          if (
            this.quirks === 'fixed' &&
            listEq(pattern, patterns[3] as string[]) &&
            is_size_word(pyAt(tokens, match[1] as number).text) &&
            // "Very thin lemon slices": the QTY token must be a number, not a stray word.
            /[0-9]/u.test(pyAt(tokens, match[0] as number).text) &&
            // "1 1/2-inch-thick slice": a fractional quantity before a dimension word IS the dimension.
            !(DIMENSION_SUFFIX.test(pyAt(tokens, match[1] as number).text) && /[#.]/u.test(pyAt(tokens, match[0] as number).text))
          ) {
            // QUIRK fix `size_adjective_container` (docs/QUIRKS.md): "10 thin slices" is ten slices, not one
            // slice of "10 thin". Upstream's container pattern treats the middle token as the size of a
            // single container ("14 ounce can"). When that token is a size word rather than a measure, the
            // quantity counts the containers and the word becomes the SIZE.
            const qty = pyAt(tokens, match[0] as number);
            const size = pyAt(tokens, match[1] as number);
            const unit = pyAt(tokens, match[2] as number);
            this.consumed.pop(); // the match was pushed above; re-push without the size token
            this.consumed.pop();
            this.consumed.pop();
            this.consumed.push(qty.index, unit.index);
            size.label = 'SIZE';
            amounts.push(
              ingredient_amount_factory({
                quantity: qty.text,
                unit: unit.text,
                text: pyStrip([qty.text, unit.text].join(' ')),
                confidence: pyMean([qty.score, unit.score]),
                starting_index: qty.index,
                APPROXIMATE: this._is_approximate(match[0] as number, tokens),
                string_units: this.string_units,
                volumetric_units_system: this.volumetric_units_system,
                custom_units: this.custom_units,
              }),
            );
            continue;
          }
          if (listEq(pattern, patterns[3] as string[])) {
            // ["QTY", "UNIT", "UNIT"]: no explicit count in pattern.
            // E.g., "15 ounce can" -> first amount: 1 can
            const unit = matching_tokens.pop() as string;
            first = ingredient_amount_factory({
              quantity: '1',
              unit,
              text: '1 ' + unit,
              confidence: matching_scores.pop() as number,
              starting_index: pyAt(tokens, match[0] as number).index,
              APPROXIMATE: this._is_approximate(match[0] as number, tokens),
              string_units: this.string_units,
              volumetric_units_system: this.volumetric_units_system,
              custom_units: this.custom_units,
            });
            amounts.push(first);
            match.pop();
          } else {
            // The first amount is made up of the first and last items
            // Note that this cannot be singular, but may be approximate
            const quantity = matching_tokens.shift() as string;
            const unit = matching_tokens.pop() as string;
            const text = pyStrip([quantity, unit].join(' '));

            first = ingredient_amount_factory({
              quantity,
              unit,
              text,
              confidence: pyMean([matching_scores.shift() as number, matching_scores.pop() as number]),
              starting_index: pyAt(tokens, match[0] as number).index,
              APPROXIMATE: this._is_approximate(match[0] as number, tokens),
              string_units: this.string_units,
              volumetric_units_system: this.volumetric_units_system,
              custom_units: this.custom_units,
            });
            amounts.push(first);
            // Pop the first and last items from the list of matching indices
            match.shift();
            match.pop();
          }

          // Create IngredientAmount objects for the remaining quantity-unit pairs
          for (let i = 0; i < matching_tokens.length; i += 2) {
            const quantity = matching_tokens[i] as string;
            const unit = pyAt(matching_tokens, i + 1);
            const text = pyStrip([quantity, unit].join(' '));
            // Upstream quirk: `matching_scores[i : i + 1]` — the mean of the quantity's score only.
            const confidence = pyMean(matching_scores.slice(i, i + 1));

            // If the first amount (e.g. 1 can) is approximate, so are all the pairs in between
            const amount = ingredient_amount_factory({
              quantity,
              unit,
              text,
              confidence,
              starting_index: pyAt(tokens, pyAt(match, i)).index,
              SINGULAR: true,
              APPROXIMATE: first.APPROXIMATE,
              string_units: this.string_units,
              volumetric_units_system: this.volumetric_units_system,
              custom_units: this.custom_units,
            });
            amounts.push(amount);
          }
        }
      }
    }

    return amounts;
  }

  /**
   * Composite amounts pattern: adjacent amounts considered together ("1 lb 2 oz",
   * "1 pint 2 fl oz", "2 cups plus 1 tablespoon").
   */
  _composite_amounts_pattern(tokens: LabelledToken[]): CompositeIngredientAmount[] {
    // Define patterns for composite amounts based on a sequence of labels, the indices of the
    // pattern where the first and second amounts start, the join string, and subtractive flag.
    const patterns: Record<string, CompositePatternInfo> = {
      ptfloz: {
        pattern: ['QTY', 'UNIT', 'QTY', 'UNIT', 'UNIT'],
        conjunction: null,
        conj_index: null,
        start1: 0,
        start2: 2,
        join: '',
        subtractive: false,
      },
      lboz: {
        pattern: ['QTY', 'UNIT', 'QTY', 'UNIT'],
        conjunction: null,
        conj_index: null,
        start1: 0,
        start2: 2,
        join: '',
        subtractive: false,
      },
      plus: {
        pattern: ['QTY', 'UNIT', 'COMMENT', 'QTY', 'UNIT'],
        conjunction: 'plus',
        conj_index: 2,
        start1: 0,
        start2: 3,
        join: ' plus ',
        subtractive: false,
      },
      plus_punc: {
        pattern: ['QTY', 'UNIT', 'PUNC', 'QTY', 'UNIT'],
        conjunction: '+',
        conj_index: 2,
        start1: 0,
        start2: 3,
        join: ' + ',
        subtractive: false,
      },
      plus_punc_comment: {
        pattern: ['QTY', 'UNIT', 'PUNC', 'COMMENT', 'QTY', 'UNIT'],
        conjunction: 'plus',
        conj_index: 3,
        start1: 0,
        start2: 4,
        join: ' plus ',
        subtractive: false,
      },
      and: {
        pattern: ['QTY', 'UNIT', 'COMMENT', 'QTY', 'UNIT'],
        conjunction: 'and',
        conj_index: 2,
        start1: 0,
        start2: 3,
        join: ' and ',
        subtractive: false,
      },
      minus: {
        pattern: ['QTY', 'UNIT', 'COMMENT', 'QTY', 'UNIT'],
        conjunction: 'minus',
        conj_index: 2,
        start1: 0,
        start2: 3,
        join: ' minus ',
        subtractive: true,
      },
      less: {
        pattern: ['QTY', 'UNIT', 'COMMENT', 'QTY', 'UNIT'],
        conjunction: 'less',
        conj_index: 2,
        start1: 0,
        start2: 3,
        join: ' minus ',
        subtractive: true,
      },
    };

    // List of possible units for first and second amount matched for pltfloz and lboz patterns.
    const valid_first_units = new Set(['lb', 'pound', 'pt', 'pint']);
    const valid_last_units = new Set(['oz', 'ounce']);

    const composite_amounts: CompositeIngredientAmount[] = [];
    for (const [pattern_name, pattern_info] of Object.entries(patterns)) {
      const pattern = pattern_info.pattern;
      const start1 = pattern_info.start1;
      const start2 = pattern_info.start2;
      const join = pattern_info.join;
      const conj_index = pattern_info.conj_index;
      const subtractive = pattern_info.subtractive;

      for (const match of this._match_pattern(tokens, pattern, { ignore_other_labels: false })) {
        // Check if match fits with "ptfloz" or "lboz" pattern constraints
        if (pattern_name === 'ptfloz' || pattern_name === 'lboz') {
          const first_unit = pyAt(tokens, pyAt(match, start1 + 1)).text;
          const last_unit = pyAt(tokens, pyAt(match, -1)).text;
          if (!valid_first_units.has(first_unit) || !valid_last_units.has(last_unit)) {
            // Units of match do not align with expectations for ptfloz or lboz patterns, so skip
            continue;
          }
        }
        // For other patterns, check if token at the conj_index in match matches
        // conjunction and skip if not.
        else if (pyAt(tokens, pyAt(match, conj_index as number)).text.toLowerCase() !== pattern_info.conjunction) {
          continue;
        }

        // First amount
        const mstart1 = pyAt(match, start1); // Index of start of 1st part in full sentence.
        const quantity_1 = pyAt(tokens, mstart1).text;
        const unit_1 = pyAt(tokens, pyAt(match, start1 + 1)).text;
        const score_1 = pyMean(match.slice(start1, start1 + 2).map((i) => pyAt(tokens, i).score));
        const text_1 = pyStrip([quantity_1, unit_1].join(' '));

        const first_amount = ingredient_amount_factory({
          quantity: quantity_1,
          unit: unit_1,
          text: text_1,
          confidence: score_1,
          starting_index: pyAt(tokens, mstart1).index,
          string_units: this.string_units,
          volumetric_units_system: this.volumetric_units_system,
          custom_units: this.custom_units,
        });

        // Second amount
        const mstart2 = pyAt(match, start2); // Index of start of 2nd part in full sentence.
        const quantity_2 = pyAt(tokens, mstart2).text;
        const unit_2 = match
          .slice(start2 + 1)
          .map((i) => pyAt(tokens, i).text)
          .join(' ');
        const score_2 = pyMean(match.slice(start2).map((i) => pyAt(tokens, i).score));
        const text_2 = pyStrip([quantity_2, unit_2].join(' '));

        const second_amount = ingredient_amount_factory({
          quantity: quantity_2,
          unit: unit_2,
          text: text_2,
          confidence: score_2,
          starting_index: pyAt(tokens, mstart2).index,
          string_units: this.string_units,
          volumetric_units_system: this.volumetric_units_system,
          custom_units: this.custom_units,
        });

        // Check if flags should be set and make sure both IngredientAmounts get the same flags.
        // Upstream passes `.index` (sentence index) where these helpers expect a list position.
        const prepared =
          this._is_prepared(pyAt(tokens, mstart1).index, tokens) ||
          this._is_prepared(pyAt(tokens, mstart2).index, tokens);

        // Upstream quirk: the second operand is `_is_prepared`, not `_is_approximate`.
        let approximate =
          this._is_approximate(pyAt(tokens, mstart1).index, tokens) ||
          this._is_prepared(pyAt(tokens, mstart2).index, tokens);

        // The _is_singular check only works if the index provided is for a token labelled UNIT.
        // Upstream quirk: `tokens[mstart1 + 1]` (not `tokens[match[start1 + 1]]`).
        let singular =
          this._is_singular(pyAt(tokens, mstart1 + 1).index, tokens) ||
          this._is_singular(pyAt(tokens, pyAt(match, -1)).index, tokens);

        if (
          this._is_singular_and_approximate(pyAt(tokens, mstart1).index, tokens) ||
          this._is_singular_and_approximate(pyAt(tokens, mstart2).index, tokens)
        ) {
          approximate = true;
          singular = true;
        }

        if (approximate) {
          first_amount.APPROXIMATE = true;
          second_amount.APPROXIMATE = true;
        }

        if (singular) {
          first_amount.SINGULAR = true;
          second_amount.SINGULAR = true;
        }

        if (prepared) {
          first_amount.PREPARED_INGREDIENT = true;
          second_amount.PREPARED_INGREDIENT = true;
        }

        composite_amounts.push(
          new CompositeIngredientAmount({
            amounts: [first_amount, second_amount],
            join,
            subtractive,
          }),
        );

        // Keep track of indices of matching elements so we don't use them again elsewhere
        this.consumed.push(...match.map((i) => pyAt(tokens, i).index));
      }
    }

    return composite_amounts;
  }

  /**
   * Find a pattern of labels, returning the (non-overlapping) lists of matching indices.
   * With `ignore_other_labels`, labels not in the pattern are skipped over.
   */
  _match_pattern(
    tokens: LabelledToken[],
    pattern: string[],
    options: { ignore_other_labels?: boolean } = {},
  ): number[][] {
    const ignore_other_labels = options.ignore_other_labels ?? true;
    const labels = tokens.map((t) => t.label);

    const plen = pattern.length;
    const plabels = new Set(pattern);

    let lbls: string[];
    let idx: number[];
    if (ignore_other_labels) {
      // Select just the labels and indices of labels that are in the pattern.
      lbls = labels.filter((label) => plabels.has(label));
      idx = [];
      labels.forEach((label, i) => {
        if (plabels.has(label)) idx.push(i);
      });
    } else {
      // Consider all labels
      lbls = labels;
      idx = labels.map((_, i) => i);
    }

    if (pattern.length > lbls.length) {
      // We can never find a match.
      return [];
    }
    // Python evaluates `pattern[0]` for the first label: an empty pattern raises IndexError.
    if (pattern.length === 0 && lbls.length > 0) throw new RangeError('list index out of range');

    const matches: number[][] = [];
    // `for i in iter(range(len(lbls)))` with `consume(indices, plen - 1)` after a match:
    // the next i is i + plen (no overlapping matches).
    const indices = lbls.keys();
    for (let step = indices.next(); !step.done; step = indices.next()) {
      const i = step.value;
      // Short circuit: If lbls[i] is not equal to the first element of pattern, skip
      if (lbls[i] === pattern[0] && listEq(lbls.slice(i, i + plen), pattern)) {
        matches.push(idx.slice(i, i + plen));
        // Advance iterator to prevent overlapping matches
        consume(indices, plen - 1);
      }
    }

    return matches;
  }

  /**
   * Fallback pattern: group a QTY with all following UNIT tokens until the next QTY.
   * "dozen" following a QTY modifies the previous amount's quantity.
   */
  _fallback_pattern(tokens: LabelledToken[]): IngredientAmount[] {
    let amounts: _PartialIngredientAmount[] = [];

    // If a new amount starts with the token after a (, / or [ then it we assume it is related
    // to the previous amount. Upstream quirk: `t.index + 1` (sentence index) is later compared
    // with the list position `i`.
    const related_idx = tokens.filter((t) => t.text === '(' || t.text === '/' || t.text === '[').map((t) => t.index + 1);

    // QUIRK fix `stray_unit_token`: sentence index of the last token folded into the current amount, and
    // the parenthetical per-container measures to flag SINGULAR after the related-flag distribution
    // (flagging them earlier would spread the flag onto the count through `_distribute_related_flags`).
    let last_index = -1;
    const per_container: _PartialIngredientAmount[] = [];
    tokens.forEach((token, i) => {
      if (token.label === 'QTY') {
        last_index = token.index;
        // Whenever we come across a new QTY, create new IngredientAmount with some exceptions.
        // Upstream quirk: `tokens[i - 1]` with i == 0 is Python negative indexing → the LAST token.
        if (token.text === 'dozen' && pyAt(tokens, i - 1).label === 'QTY') {
          // "dozen" following a QTY: modify the quantity of the previous amount.
          pyAt(amounts, -1).quantity = pyAt(amounts, -1).quantity + ' dozen';
          pyAt(amounts, -1).confidence.push(token.score);
        } else if (pyAt(tokens, i - 1).label === 'QTY' && pyAt(tokens, i - 1).text.endsWith('x')) {
          // This is a multiplier followed by another amount e.g. "1x 15 ml tbsp", so mark
          // this amount as related to the previous one.
          amounts.push(
            new _PartialIngredientAmount({
              quantity: token.text,
              unit: [],
              confidence: [token.score],
              starting_index: token.index,
              related_to_previous: true,
            }),
          );
        } else {
          amounts.push(
            new _PartialIngredientAmount({
              quantity: token.text,
              unit: [],
              confidence: [token.score],
              starting_index: token.index,
              related_to_previous: related_idx.includes(i),
            }),
          );
        }
      }

      if (token.label === 'UNIT') {
        const before_stray = this.tokens.find((t) => t.index === token.index - 1);
        if (
          this.quirks === 'fixed' &&
          amounts.length > 0 &&
          last_index >= 0 &&
          token.index !== last_index + 1 &&
          before_stray !== undefined &&
          // Only after a parenthetical or a size/comment run; "4 large garlic cloves" (a NAME between) keeps
          // upstream's reading, where "cloves" completes the unit "large clove".
          (before_stray.text === ')' || before_stray.text === ']' || ['SIZE', 'COMMENT', 'PREP', 'PURPOSE'].includes(before_stray.label))
        ) {
          // QUIRK fix `stray_unit_token` (docs/QUIRKS.md): upstream appends every UNIT token to the
          // current amount however far away it is, so "2 ounces ginger root (one 3-inch knob)" gets the
          // unit "ounces knobs". A UNIT token that does not directly follow the amount's last token
          // completes the previous unit-less amount ("2 (6-ounce) fillets" → "2 fillets") or, failing
          // that, joins the field of the token before it (the SIZE of "(one 3-inch knob)").
          const current = pyAt(amounts, -1);
          const previous = amounts.length >= 2 ? pyAt(amounts, -2) : null;
          // A size or approximation word ("scant", "large") is never a unit to complete an amount with.
          const descriptive = is_descriptive_word(token.text);
          const target = descriptive ? null : current.unit.length === 0 ? current : previous !== null && previous.unit.length === 0 ? previous : null;
          if (target !== null) {
            target.unit.push(token.text);
            target.confidence.push(token.score);
            if (target === current) last_index = token.index;
            // The parenthetical measure between the count and its container is per container
            // ("4 (6 ounce) containers": 6 ounces each), the same SINGULAR upstream sets for "1 (14 oz) can".
            else per_container.push(current);
          } else {
            token.label = ['SIZE', 'COMMENT', 'PREP', 'PURPOSE'].includes(before_stray.label) ? before_stray.label : 'COMMENT';
          }
          return;
        }
        last_index = token.index;
        if (amounts.length === 0) {
          // Not come across a QTY yet, so create IngredientAmount
          let implicit_quantity = false;
          let quantity = '';
          // `INDEFINITE_QUANTIFIERS & {t.text.lower() for t in tokens[:i]}` — truthy if non-empty.
          if (!token.plural && !tokens.slice(0, i).some((t) => INDEFINITE_QUANTIFIERS.has(t.text.toLowerCase()))) {
            // If the token is not plural and the sentence does not contain an indefinite
            // quantifier prior to this token, assume a quantity of 1.
            quantity = '1';
            implicit_quantity = true;
          }

          amounts.push(
            new _PartialIngredientAmount({
              quantity,
              unit: [],
              confidence: [token.score],
              starting_index: token.index,
              implicit_quantity,
            }),
          );
        }

        // Append token and score for unit to last IngredientAmount
        let text = token.text;
        if (token.plural && pyAt(amounts, -1).implicit_quantity) {
          // If this token is plural and the current amount has an implicit quantity, revert
          // the implicit quantity and re-pluralize the unit.
          pyAt(amounts, -1).quantity = '';
          pyAt(amounts, -1).implicit_quantity = false;
          text = pluralise_units(token.text, this.custom_units);
        } else if (token.plural && pyAt(amounts, -1).quantity === '') {
          // If this token is plural and there is no quantity, re-pluralize it.
          // Note that is there was a quantity, the unit would be pluralized within
          // ingredient_amount_factory() as appropriate.
          text = pluralise_units(token.text, this.custom_units);
        }

        pyAt(amounts, -1).unit.push(text);
        pyAt(amounts, -1).confidence.push(token.score);
      }

      // Check if any flags should be set
      if (this._is_approximate(i, tokens)) {
        pyAt(amounts, -1).APPROXIMATE = true;
      }

      if (this._is_singular(i, tokens)) {
        pyAt(amounts, -1).SINGULAR = true;
      }

      if (this._is_singular_and_approximate(i, tokens)) {
        pyAt(amounts, -1).APPROXIMATE = true;
        pyAt(amounts, -1).SINGULAR = true;
      }

      if (this._is_prepared(i, tokens)) {
        pyAt(amounts, -1).PREPARED_INGREDIENT = true;
      }
    });

    // Set APPROXIMATE, SINGULAR and PREPARED_INGREDIENT flags to be the same for all related amounts.
    amounts = this._distribute_related_flags(amounts);
    for (const a of per_container) a.SINGULAR = true; // QUIRK fix `stray_unit_token`, see above

    // Loop through amounts list to fix unit and confidence: unit needs converting to a string,
    // confidence needs averaging. Then convert to IngredientAmount object.
    const processed_amounts: IngredientAmount[] = [];
    for (const amount of amounts) {
      // QUIRK fix `duplicate_unit_tokens` (docs/PORTING.md): "1 teaspoon (tsp) salt" carries two UNIT tokens
      // for the same unit; upstream joins them ("teaspoon tsp") and pint reads the space as a product
      // (`teaspoon ** 2`). In 'fixed' mode, unit tokens that all name the same unit collapse to the first.
      if (this.quirks === 'fixed' && amount.unit.length > 1 && amount.unit.every((u) => sameUnit(u, amount.unit[0] as string))) {
        amount.unit = [amount.unit[0] as string];
      }
      const unit = amount.unit.join(' ');
      const text = pyStrip([amount.quantity, unit].join(' '));

      // Convert to an IngredientAmount object for returning
      processed_amounts.push(
        ingredient_amount_factory({
          quantity: amount.quantity,
          unit,
          text,
          confidence: pyMean(amount.confidence),
          starting_index: amount.starting_index,
          APPROXIMATE: amount.APPROXIMATE,
          SINGULAR: amount.SINGULAR,
          PREPARED_INGREDIENT: amount.PREPARED_INGREDIENT,
          string_units: this.string_units,
          volumetric_units_system: this.volumetric_units_system,
          custom_units: this.custom_units,
        }),
      );
    }

    return processed_amounts;
  }

  /**
   * True if the token at `i` is approximate (QTY/UNIT preceded by an approximate prefix, or
   * followed by an approximate suffix). Marks the qualifier tokens as consumed.
   */
  _is_approximate(i: number, tokens: LabelledToken[]): boolean {
    if (pyAt(tokens, i).label === 'QTY' && i > 0 && APPROXIMATE_PREFIXES.includes(pyAt(tokens, i - 1).text.toLowerCase())) {
      // Mark i - 1 element as consumed.
      this.consumed.push(pyAt(tokens, i - 1).index);
      return true;
    } else if (
      pyAt(tokens, i).label === 'QTY' &&
      i > 1 &&
      pyAt(tokens, i - 1).text === '.' &&
      APPROXIMATE_PREFIXES.includes(pyAt(tokens, i - 2).text.toLowerCase())
    ) {
      // Special case for "approx."
      // Mark i - 1 and i - 2 elements as consumed.
      this.consumed.push(pyAt(tokens, i - 1).index);
      this.consumed.push(pyAt(tokens, i - 2).index);
      return true;
    } else if (
      pyAt(tokens, i).label === 'UNIT' &&
      i > 0 &&
      APPROXIMATE_PREFIXES.includes(pyAt(tokens, i - 1).text.toLowerCase())
    ) {
      // For cases like "2 generous cups"
      // Mark i - 1 element as consumed.
      this.consumed.push(pyAt(tokens, i - 1).index);
      return true;
    } else if (
      (pyAt(tokens, i).label === 'UNIT' || pyAt(tokens, i).label === 'QTY') &&
      // Upstream quirk: bounds-checked against `self.tokens`, not `tokens`.
      i < this.tokens.length - 2 &&
      listIn(
        tokens.slice(i + 1, i + 3).map((t) => t.text.toLowerCase()),
        APPROXIMATE_SUFFIXES,
      )
    ) {
      // For cases like "2/3 cup or so", "12 or so" etc.
      // Mark i + 1 element as consumed.
      this.consumed.push(pyAt(tokens, i + 1).index);
      this.consumed.push(pyAt(tokens, i + 2).index);
      return true;
    }

    return false;
  }

  /** True if the UNIT token at `i` is followed by a singular token ("each"). Marks it consumed. */
  _is_singular(i: number, tokens: LabelledToken[]): boolean {
    if (this.quirks === 'fixed' && pyAt(tokens, i).label === 'QTY') {
      // QUIRK fix `each_before_amount` (docs/QUIRKS.md): upstream only sees "each" AFTER the amount
      // ("4 pounds each"); "each weighing about 6 ounces" leaves the amount unmarked. Up to three
      // comment tokens before the quantity are searched for "each"; the run is consumed.
      const run: number[] = [];
      for (let k = i - 1; k >= 0 && run.length < 3; k--) {
        const t = pyAt(tokens, k);
        if (t.label !== 'COMMENT') break;
        run.push(k);
        if (SINGULAR_TOKENS.includes(t.text.toLowerCase())) {
          for (const j of run) this.consumed.push(pyAt(tokens, j).index);
          return true;
        }
      }
    }
    if (i === tokens.length - 1) {
      return false;
    }

    if (pyAt(tokens, i).label === 'UNIT' && SINGULAR_TOKENS.includes(pyAt(tokens, i + 1).text.toLowerCase())) {
      // Mark i - 1 element as consumed
      this.consumed.push(pyAt(tokens, i + 1).index);
      return true;
    }

    if (i === tokens.length - 2) {
      return false;
    }

    // Case where the amount is in brackets
    if (
      pyAt(tokens, i).label === 'UNIT' &&
      (pyAt(tokens, i + 1).text === ')' || pyAt(tokens, i + 1).text === ']') &&
      SINGULAR_TOKENS.includes(pyAt(tokens, i + 2).text.toLowerCase())
    ) {
      // Mark i - 1 element as consumed
      this.consumed.push(pyAt(tokens, i + 2).index);
      return true;
    }

    return false;
  }

  /**
   * True if the token at `i` is both approximate and singular ("each nearly 200 g",
   * "5 lbs or so each"). Marks the qualifier tokens consumed.
   */
  _is_singular_and_approximate(i: number, tokens: LabelledToken[]): boolean {
    if (
      pyAt(tokens, i).label === 'QTY' &&
      i > 1 &&
      APPROXIMATE_PREFIXES.includes(pyAt(tokens, i - 1).text.toLowerCase()) &&
      SINGULAR_TOKENS.includes(pyAt(tokens, i - 2).text.toLowerCase())
    ) {
      // Mark i - 1 and i - 2 elements as consumed
      this.consumed.push(pyAt(tokens, i - 1).index);
      this.consumed.push(pyAt(tokens, i - 2).index);
      return true;
    } else if (
      pyAt(tokens, i).label === 'UNIT' &&
      // Upstream quirk: bounds-checked against `self.tokens`, not `tokens`.
      i < this.tokens.length - 3 &&
      listIn(
        tokens.slice(i + 1, i + 3).map((t) => t.text.toLowerCase()),
        APPROXIMATE_SUFFIXES,
      ) &&
      SINGULAR_TOKENS.includes(pyAt(tokens, i + 3).text.toLowerCase())
    ) {
      // e.g. "2 pounds or so each"
      this.consumed.push(pyAt(tokens, i + 1).index);
      this.consumed.push(pyAt(tokens, i + 2).index);
      this.consumed.push(pyAt(tokens, i + 3).index);
      return true;
    }

    return false;
  }

  /**
   * True if the QTY token at `i` is preceded by a prepared-ingredient phrase ("to yield",
   * "to make"), optionally with an approximate prefix in between. Marks the phrase consumed.
   */
  _is_prepared(i: number, tokens: LabelledToken[]): boolean {
    // All PREPARED_INGREDIENT_TOKENS have length 2, so cannot be prepared if i < 2.
    if (i < 2) {
      return false;
    }

    if (pyAt(tokens, i).label !== 'QTY') {
      return false;
    }

    for (const pattern of PREPARED_INGREDIENT_TOKENS) {
      if (listEq(tokens.slice(i - 2, i).map((t) => t.text.toLowerCase()), pattern)) {
        // Mark i - 1 and i - 2 elements as consumed
        this.consumed.push(pyAt(tokens, i - 1).index);
        this.consumed.push(pyAt(tokens, i - 2).index);
        return true;
      } else if (
        i > 2 &&
        APPROXIMATE_PREFIXES.includes(pyAt(tokens, i - 1).text.toLowerCase()) &&
        listEq(tokens.slice(i - 3, i - 1).map((t) => t.text.toLowerCase()), pattern)
      ) {
        // Mark i - 2 and i - 3 elements as consumed
        this.consumed.push(pyAt(tokens, i - 2).index);
        this.consumed.push(pyAt(tokens, i - 3).index);
        return true;
      }
    }

    return false;
  }

  /** Distribute set flags to all related amounts; amounts after a multiplier become SINGULAR. */
  _distribute_related_flags(amounts: _PartialIngredientAmount[]): _PartialIngredientAmount[] {
    // Group amounts into related groups
    const grouped: _PartialIngredientAmount[][] = [];
    for (const amount of amounts) {
      if (grouped.length > 0 && amount.related_to_previous) {
        pyAt(grouped, -1).push(amount);
      } else {
        grouped.push([amount]);
      }
    }

    // Set flags for all amounts in group if any amount has flag set
    for (const group of grouped) {
      if (group.some((am) => am.APPROXIMATE)) {
        for (const am of group) {
          am.APPROXIMATE = true;
        }
      }

      if (group.some((am) => am.SINGULAR)) {
        for (const am of group) {
          am.SINGULAR = true;
        }
      }

      if (group.some((am) => am.PREPARED_INGREDIENT)) {
        for (const am of group) {
          am.PREPARED_INGREDIENT = true;
        }
      }

      // If any amount in a group of related amounts is a multiplier (e.g. 1x)
      // then mark all following amounts with SINGULAR=True
      let singular_after_multiplier = false;
      for (const amount of group) {
        if (singular_after_multiplier) {
          amount.SINGULAR = true;
          continue;
        }

        if (amount.quantity.endsWith('x')) {
          singular_after_multiplier = true;
        }
      }
    }

    // Flatten list for return
    return grouped.flat();
  }
}
