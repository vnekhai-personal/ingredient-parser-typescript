/**
 * Port of `ingredient_parser/en/preprocess.py` (pin ffd6ae3). Identifiers verbatim.
 * Every value produced here is a feature string inside the parity boundary (CLAUDE.md I1);
 * feature-dict key ORDER also mirrors upstream so canonical-JSON dumps diff byte for byte.
 */
import { Token, TokenFeatures } from '../dataclasses.js';
import {
  PY_PUNCTUATION,
  PY_S,
  dictGet,
  pyCapitalize,
  pyChars,
  pyFindall,
  pyFloat,
  pyHtmlUnescape,
  pyInt,
  pyReplaceAll,
  pyReprStrList,
  pyStrip,
} from '../_py.js';
import {
  AMBIGUOUS_UNITS,
  DIMENSIONS,
  FLATTENED_UNITS_LIST,
  LENGTH_UNITS,
  STRING_NUMBERS,
  UNICODE_FRACTIONS,
  UNITS,
} from './_constants.js';
import {
  CAPITALISED_PATTERN,
  CURRENCY_PATTERN,
  DIGIT_PATTERN,
  DUPE_UNIT_RANGES_PATTERN,
  EXPANDED_RANGE,
  FRACTION_PARTS_PATTERN,
  FRACTION_TOKEN_PATTERN,
  LOWERCASE_PATTERN,
  QUANTITY_UNITS_PATTERN,
  QUANTITY_X_PATTERN,
  STRING_QUANTITY_HYPHEN_PATTERN,
  UNITS_HYPHEN_QUANTITY_PATTERN,
  UNITS_QUANTITY_PATTERN,
  UPPERCASE_PATTERN,
} from './_regex.js';
import { SentenceStrucureFeatures } from './_structure_features.js';
import type { Quirks } from './postprocess.js';
import {
  combine_quantities_split_by_and,
  is_unit_synonym,
  pos_tag,
  replace_string_range,
  stem,
  tokenize,
} from './_utils.js';

const CONSECUTIVE_SPACES = new RegExp(`${PY_S}+`, 'gu');

/** Dict of token features. */
export type FeatureDict = Record<string, string | boolean>;

export interface PreProcessorOptions {
  custom_units?: Readonly<Record<string, string>> | null;
  /** `'upstream'` (default) normalises exactly as Python at the pin; `'fixed'` adds the input corrections in docs/QUIRKS.md. */
  quirks?: Quirks;
}

// QUIRK fix `dimension_fraction_count` helper: a plural word right after a hyphenated dimension
// ("-inch-thick slices", "-inch pieces"), which marks "12 1/4-inch-thick slices" as a count plus a
// fraction rather than the mixed number 12¼.
const HYPHENATED_DIMENSION_THEN_PLURAL = /^-(?:inch|inches|in|cm|mm|centimet(?:er|re)|millimet(?:er|re))(?:-[A-Za-z]+)?\s+[A-Za-z]+(?<!s)s\b/u;

/**
 * Recipe ingredient sentence PreProcessor: normalises the sentence, tokenises it, and
 * produces per-token feature dicts for the CRF model.
 */
export class PreProcessor {
  readonly input: string;
  readonly sentence: string;
  readonly _units: Map<string, string>;
  readonly singularised_indices: number[];
  readonly tokenized_sentence: Token[];
  readonly sentence_structure: SentenceStrucureFeatures;
  readonly quirks: Quirks;

  constructor(input_sentence: string, options: PreProcessorOptions = {}) {
    const custom_units = options.custom_units ?? null;
    this.quirks = options.quirks ?? 'upstream';
    this.input = input_sentence;
    this.sentence = this._normalise(input_sentence);

    if (custom_units !== null) {
      this._units = new Map(Object.entries({ ...UNITS, ...custom_units }));
    } else {
      this._units = new Map(Object.entries(UNITS));
    }

    this.singularised_indices = [];
    this.tokenized_sentence = this._calculate_tokens(this.sentence);
    this.sentence_structure = new SentenceStrucureFeatures(this.tokenized_sentence);
  }

  repr(): string {
    return `PreProcessor("${this.input}")`;
  }

  toString(): string {
    const _str = [
      'Pre-processed recipe ingredient sentence',
      `\t  Input: ${this.input}`,
      `\tCleaned: ${this.sentence}`,
      `\t Tokens: ${pyReprStrList(this.tokenized_sentence.map((t) => t.text))}`,
    ];
    return _str.join('\n');
  }

  /** Normalise sentence prior to feature extraction. Order matters. */
  _normalise(sentence: string): string {
    const funcs: ((s: string) => string)[] = [
      (s) => this._fixed_input_rewrites(s),
      (s) => this._remove_price_annotations(s),
      (s) => this._replace_en_em_dash(s),
      (s) => this._replace_html_fractions(s),
      (s) => this._replace_unicode_fractions(s),
      combine_quantities_split_by_and,
      (s) => this._identify_fractions(s),
      (s) => this._split_quantity_and_units(s),
      (s) => this._remove_unit_trailing_period(s),
      replace_string_range,
      (s) => this._replace_dupe_units_ranges(s),
      (s) => this._merge_quantity_x(s),
      (s) => this._collapse_ranges(s),
    ];
    for (const func of funcs) sentence = func(sentence);
    return pyStrip(sentence);
  }

  /**
   * QUIRK fixes applied to the raw sentence before upstream's normalisation, 'fixed' mode only
   * (docs/QUIRKS.md). Each rewrites the input into a shape the model already handles well; the
   * default mode returns the sentence untouched.
   */
  _fixed_input_rewrites(sentence: string): string {
    if (this.quirks !== 'fixed') return sentence;
    // `literal_escapes`: the two-character sequences \n, \t, \r (an export artefact) are whitespace.
    sentence = sentence.replace(/\\[ntr]/gu, ' ');
    // `number_words`: phrasings upstream's STRING_NUMBERS table lacks.
    sentence = sentence.replace(/\bhalf a dozen\b/giu, '6');
    sentence = sentence.replace(/\ba dozen\b/giu, '12');
    sentence = sentence.replace(/\bhalf (?:of )?an?\b/giu, '1/2');
    // "a couple (of)" only where an amount stands: sentence start, after "(", ",", "or", "and", "plus";
    // not inside prose ("soaked for a couple of hours").
    sentence = sentence.replace(/(?<=^|\(|,\s*|\b(?:or|and|plus)\s+)a couple(?: of)?\b/giu, 'about 2');
    // `spaceless_mixed_number`: "11/2", "13/4", "12/3" are "1 1/2", "1 3/4", "1 2/3" — two digits starting
    // with 1 whose second digit is a proper numerator for the single-digit denominator.
    sentence = sentence.replace(/(?<![0-9/.])1([1-9])\/([2-9])(?![0-9/])/gu, (m, n: string, d: string) =>
      Number(n) < Number(d) ? `1 ${n}/${d}` : m,
    );
    // `hyphenated_count_container`: "1-14 1/2-ounce can" is a count joined to a sized container by a
    // hyphen, not a range: only when the second number is itself hyphen-attached to a word.
    // A weight range written with hyphens ("2-3-lb roast") stays a range: the container size must be
    // clearly larger than the count (more than twice it).
    sentence = sentence.replace(/^([0-9]+)-(?=([0-9]+)(?: [0-9]+\/[0-9]+)?-[A-Za-z])/u, (m, count: string, size: string) =>
      Number(size) > 2 * Number(count) ? `${count} ` : m,
    );
    return sentence;
  }

  /** Remove price annotations like ($0.20), (£1.50). */
  _remove_price_annotations(sentence: string): string {
    return sentence.replace(CURRENCY_PATTERN, '');
  }

  /** Replace en-dashes and em-dashes with hyphens. */
  _replace_en_em_dash(sentence: string): string {
    return pyReplaceAll(pyReplaceAll(sentence, '–', '-'), '—', ' - ');
  }

  /** Replace html fractions e.g. &frac12; with unicode equivalents. */
  _replace_html_fractions(sentence: string): string {
    return pyHtmlUnescape(sentence);
  }

  /** Mark fractions (1/2, 1 1/2) as #1$2 / 1#1$2 so the tokenizer keeps them whole. */
  _identify_fractions(sentence: string): string {
    // Replace unicode FRACTION SLASH (U+2044) with forward slash.
    sentence = pyReplaceAll(sentence, '⁄', '/');

    let matches = pyFindall(FRACTION_PARTS_PATTERN, sentence).map((m) => m[1] as string);
    if (matches.length === 0) return sentence;

    // Replace the longest matches first so "1/2" inside "1 1/2" is not replaced on its own.
    matches = matches.map((match) => pyStrip(match));
    matches.sort((a, b) => pyChars(b).length - pyChars(a).length);

    for (const match of matches) {
      // Skip percentage-breakdown ratios like 80/20 (X/Y where X+Y==100).
      if (!match.includes(' ')) {
        const parts = match.split('/');
        if (parts.length === 2) {
          const n = pyInt(parts[0] as string);
          const d = pyInt(parts[1] as string);
          if (n !== null && d !== null && n + d === 100n) continue;
        }
      }

      // QUIRK fix `dimension_fraction_count`: "12 1/4-inch-thick slices" is twelve slices a quarter inch
      // thick, not 12¼ of something; upstream merges the whole number into the fraction. In 'fixed'
      // mode a mixed number whose fraction is hyphen-attached to a dimension followed by a plural word
      // keeps its whole number as a separate token ("1 1/2-inch-thick slice", singular, still merges).
      if (this.quirks === 'fixed' && match.includes(' ')) {
        const at = sentence.indexOf(match);
        // Not when another number precedes the mixed number ("2 1 1/2-pound eggplants": the count is there).
        const precededByNumber = at > 0 && /[0-9]\s*$/u.test(sentence.slice(0, at));
        const parts = match.split(CONSECUTIVE_SPACES);
        const fraction = parts[parts.length - 1] as string;
        const whole = parts.slice(0, -1).join(' ');
        // A whole number of 1 before a plural noun ("(1½-inch pieces)") is the fraction's, not a count.
        if (at >= 0 && !precededByNumber && whole !== '1' && HYPHENATED_DIMENSION_THEN_PLURAL.test(sentence.slice(at + match.length))) {
          sentence = pyReplaceAll(sentence, match, `${whole} #${pyReplaceAll(fraction, '/', '$')}`);
          continue;
        }
      }
      let replacement = pyReplaceAll(match, '/', '$');
      if (replacement.includes(' ')) {
        replacement = replacement.replace(CONSECUTIVE_SPACES, '#');
      } else {
        replacement = '#' + replacement;
      }
      sentence = pyReplaceAll(sentence, match, replacement);
    }
    return sentence;
  }

  /** Replace unicode fractions with a 'fake' ascii equivalent. */
  _replace_unicode_fractions(sentence: string): string {
    for (const [f_unicode, f_ascii] of Object.entries(UNICODE_FRACTIONS)) {
      sentence = pyReplaceAll(sentence, f_unicode, f_ascii);
    }
    return sentence;
  }

  /** Insert a space between quantity and unit. */
  _split_quantity_and_units(sentence: string): string {
    sentence = sentence.replace(QUANTITY_UNITS_PATTERN, '$1 $2');
    sentence = sentence.replace(UNITS_QUANTITY_PATTERN, '$1 $2');
    sentence = sentence.replace(UNITS_HYPHEN_QUANTITY_PATTERN, '$1 - $2');
    return sentence.replace(STRING_QUANTITY_HYPHEN_PATTERN, '$1 $2');
  }

  /** Remove trailing periods from units e.g. tsp. -> tsp. */
  _remove_unit_trailing_period(sentence: string): string {
    const units = ['tsp.', 'tsps.', 'tbsp.', 'tbsps.', 'tbs.', 'tb.', 'lb.', 'lbs.', 'oz.'];
    units.push(...units.map((u) => pyCapitalize(u)));
    for (const unit of units) {
      const unit_no_period = pyReplaceAll(unit, '.', '');
      sentence = pyReplaceAll(sentence, unit, unit_no_period);
    }
    return sentence;
  }

  /** "227 g - 283.5 g" → "227-283.5 g" where both units are the same (or synonyms). */
  _replace_dupe_units_ranges(sentence: string): string {
    const matches = pyFindall(DUPE_UNIT_RANGES_PATTERN, sentence);
    if (matches.length === 0) return sentence;

    for (const m of matches) {
      const full_match = m[1] as string;
      const quantity1 = m[2] as string;
      const unit1 = m[3] as string;
      const quantity2 = m[4] as string;
      const unit2 = m[5] as string;
      if (unit1 !== unit2 && !is_unit_synonym(unit1, unit2)) continue;
      if (!FLATTENED_UNITS_LIST.has(unit1) && !LENGTH_UNITS.has(unit1)) continue;
      sentence = pyReplaceAll(sentence, full_match, `${quantity1}-${quantity2} ${unit1}`);
    }
    return sentence;
  }

  /** Merge a quantity followed by "x" into a single token: "8 x 450 g" → "8x 450 g". */
  _merge_quantity_x(sentence: string): string {
    return sentence.replace(QUANTITY_X_PATTERN, '$1x ');
  }

  /** Collapse whitespace inside ranges: "8 - 10" → "8-10". */
  _collapse_ranges(sentence: string): string {
    return sentence.replace(EXPANDED_RANGE, '$1-$2');
  }

  /** Tokenize the sentence and calculate per-token attributes. */
  _calculate_tokens(sentence: string): Token[] {
    const tokens: Token[] = [];
    const tagged = pos_tag(tokenize(sentence));
    for (let i = 0; i < tagged.length; i++) {
      let [text, pos] = tagged[i] as [string, string];
      let feat_text: string;
      // Singularise units; replace numeric tokens with "!num".
      const singular = this._units.get(text);
      if (singular) {
        this.singularised_indices.push(i);
        feat_text = singular;
        text = singular;
      } else if (this._is_numeric(text)) {
        feat_text = '!num';
      } else {
        feat_text = text;
      }

      // Part of speech tag, with overrides for certain tokens.
      if (this._is_numeric(text)) {
        pos = 'CD';
      } else if (['c', 'g'].includes(text.toLowerCase())) {
        pos = 'NN';
      } else if (['and/or', 'or', 'and'].includes(text.toLowerCase())) {
        pos = 'CC';
      } else if (text.toLowerCase() === 'e.g.') {
        pos = 'IN';
      } else if (text.toLowerCase() === '/') {
        pos = 'SYM';
      } else if (text === 'in' && i > 0 && (tokens[i - 1] as Token).feat_text === '!num') {
        pos = 'NN';
      }

      const features = new TokenFeatures({
        stem: stem(feat_text),
        shape: this._word_shape(feat_text),
        is_capitalised: this._is_capitalised(feat_text),
        is_unit: this._is_unit(feat_text),
        is_punc: this._is_punc(feat_text),
        is_ambiguous_unit: this._is_ambiguous_unit(feat_text),
      });

      tokens.push(new Token({ index: i, text, feat_text, pos_tag: pos, features }));
    }
    return tokens;
  }

  /** True if token is a unit (a singular form in the units map, excluding length units). */
  _is_unit(token: string): boolean {
    const lower = token.toLowerCase();
    let found = false;
    for (const v of this._units.values()) {
      if (v === lower) {
        found = true;
        break;
      }
    }
    return found && !LENGTH_UNITS.has(lower);
  }

  _is_dimension(token: string): boolean {
    return DIMENSIONS.has(token.toLowerCase());
  }

  /** True if the token at index is a length unit ("in" only after a number). */
  _is_length_unit(index: number): boolean {
    const token = (this.tokenized_sentence[index] as Token).feat_text;
    if (token === 'in') {
      if (index > 0 && (this.tokenized_sentence[index - 1] as Token).feat_text === '!num') return true;
      return false;
    }
    return LENGTH_UNITS.has(token.toLowerCase());
  }

  /** True if token is a punctuation mark (a substring of string.punctuation, or "--"). */
  _is_punc(token: string): boolean {
    return PY_PUNCTUATION.includes(token) || token === '--';
  }

  _is_numeric(token: string): boolean {
    if (['00'].includes(token)) return false;
    if (FRACTION_TOKEN_PATTERN.test(token)) return true;
    if (Object.hasOwn(STRING_NUMBERS, token.toLowerCase())) return true;
    if (token.includes('-')) {
      const parts = token.split('-');
      return parts.every((part) => this._is_numeric(part));
    }
    if (token === 'dozen') return true;
    if (token.endsWith('x')) {
      return pyFloat(token.slice(0, -1)) !== null;
    }
    return pyFloat(token) !== null;
  }

  /** True if any token before index is a comma. */
  _follows_comma(index: number): boolean {
    return this.tokenized_sentence.slice(0, index).some((t) => t.feat_text === ',');
  }

  /** True if any token before index is "plus". */
  _follows_plus(index: number): boolean {
    return this.tokenized_sentence.slice(0, index).some((t) => t.feat_text === 'plus');
  }

  _is_capitalised(token: string): boolean {
    return CAPITALISED_PATTERN.test(token);
  }

  /** True if the token is inside parentheses/brackets or is one. */
  _is_inside_parentheses(index: number): boolean {
    if (['(', ')', '[', ']'].includes((this.tokenized_sentence[index] as Token).feat_text)) return true;

    const open_parens: number[] = [];
    const closed_parens: number[] = [];
    this.tokenized_sentence.forEach((token, i) => {
      if (token.feat_text === '(' || token.feat_text === '[') open_parens.push(i);
      else if (token.feat_text === ')' || token.feat_text === ']') closed_parens.push(i);
    });

    const n = Math.min(open_parens.length, closed_parens.length);
    for (let k = 0; k < n; k++) {
      const start = open_parens[k] as number;
      const end = closed_parens[k] as number;
      if (start < index && index < end) return true;
    }
    return false;
  }

  _is_ambiguous_unit(token: string): boolean {
    return AMBIGUOUS_UNITS.includes(token);
  }

  /** Sentence length rounded down to the nearest bucket of 2, 4, 8, 12, 16, 20, 32, 64. */
  _sentence_length_bucket(): number {
    const length = this.tokenized_sentence.length;
    let bucket = 1;
    for (const length_bucket of [2, 4, 8, 12, 16, 20, 32, 64]) {
      if (length >= length_bucket) bucket = length_bucket;
    }
    return bucket;
  }

  /** Word shape: lowercase → x, uppercase → X, digits → d, after removing accents. */
  _word_shape(token: string): string {
    const normalised = this._remove_accents(token);
    let shape = normalised.replace(LOWERCASE_PATTERN, 'x');
    shape = shape.replace(UPPERCASE_PATTERN, 'X');
    shape = shape.replace(DIGIT_PATTERN, 'd');
    return shape;
  }

  /** NFD-normalise and drop combining marks (category Mn). */
  _remove_accents(token: string): string {
    return Array.from(token.normalize('NFD'))
      .filter((c) => !/\p{Mn}/u.test(c))
      .join('');
  }

  _common_features(index: number, prefix: string): Record<string, string | boolean> {
    const token = this.tokenized_sentence[index] as Token;
    return {
      [prefix + 'is_capitalised']: token.features.is_capitalised,
      [prefix + 'is_unit']: token.features.is_unit,
      [prefix + 'is_punc']: token.features.is_punc,
      [prefix + 'is_ambiguous']: token.features.is_ambiguous_unit,
      [prefix + 'is_in_parens']: this._is_inside_parentheses(index),
      [prefix + 'is_after_comma']: this._follows_comma(index),
      [prefix + 'is_after_plus']: this._follows_plus(index),
      [prefix + 'word_shape']: token.features.shape,
      [prefix + 'is_length_unit']: this._is_length_unit(index),
      [prefix + 'is_dimension']: this._is_dimension(token.feat_text),
    };
  }

  /** Prefix/suffix n-grams (N = 3, 4, 5) when the token is long enough; none for "!num". */
  _ngram_features(token: string, prefix: string): Record<string, string> {
    const ngram_features: Record<string, string> = {};
    const chars = pyChars(token);
    const len = chars.length;
    if (token !== '!num' && len >= 4) {
      ngram_features[prefix + 'prefix_3'] = chars.slice(0, 3).join('');
      ngram_features[prefix + 'suffix_3'] = chars.slice(-3).join('');
    }
    if (token !== '!num' && len >= 5) {
      ngram_features[prefix + 'prefix_4'] = chars.slice(0, 4).join('');
      ngram_features[prefix + 'suffix_4'] = chars.slice(-4).join('');
    }
    if (token !== '!num' && len >= 6) {
      ngram_features[prefix + 'prefix_5'] = chars.slice(0, 5).join('');
      ngram_features[prefix + 'suffix_5'] = chars.slice(-5).join('');
    }
    return ngram_features;
  }

  /** Features for one token, in upstream's insertion order. */
  _token_features(token: Token): FeatureDict {
    const index = token.index;
    const ts = this.tokenized_sentence;
    const features: FeatureDict = {};

    features['bias'] = '';
    features['sentence_length'] = String(this._sentence_length_bucket());

    features['pos'] = token.pos_tag;
    features['stem'] = token.features.stem;
    if (token.feat_text !== token.features.stem) features['token'] = token.feat_text;

    Object.assign(features, this._common_features(index, ''));
    Object.assign(features, this._ngram_features(token.feat_text, ''));
    Object.assign(features, this.sentence_structure.token_features(index, ''));

    const pos = (i: number) => (ts[i] as Token).pos_tag;

    if (index > 0) {
      features['prev_stem'] = (ts[index - 1] as Token).features.stem;
      features['prev_pos_ngram'] = [pos(index - 1), pos(index)].join('+');
      features['prev_pos'] = pos(index - 1);
      Object.assign(features, this._common_features(index - 1, 'prev_'));
      Object.assign(features, this.sentence_structure.token_features(index - 1, 'prev_'));
    }
    if (index > 1) {
      features['prev2_stem'] = (ts[index - 2] as Token).features.stem;
      features['prev2_pos_ngram'] = [pos(index - 2), pos(index - 1), pos(index)].join('+');
      features['prev2_pos'] = pos(index - 2);
      Object.assign(features, this._common_features(index - 2, 'prev2_'));
      Object.assign(features, this.sentence_structure.token_features(index - 2, 'prev2_'));
    }
    if (index > 2) {
      features['prev3_stem'] = (ts[index - 3] as Token).features.stem;
      features['prev3_pos_ngram'] = [pos(index - 3), pos(index - 2), pos(index - 1), pos(index)].join('+');
      features['prev3_pos'] = pos(index - 3);
      Object.assign(features, this._common_features(index - 3, 'prev3_'));
      Object.assign(features, this.sentence_structure.token_features(index - 3, 'prev3_'));
    }
    if (index < ts.length - 1) {
      features['next_stem'] = (ts[index + 1] as Token).features.stem;
      features['next_pos_ngram'] = [pos(index), pos(index + 1)].join('+');
      features['next_pos'] = pos(index + 1);
      Object.assign(features, this._common_features(index + 1, 'next_'));
      Object.assign(features, this.sentence_structure.token_features(index + 1, 'next_'));
    }
    if (index < ts.length - 2) {
      features['next2_stem'] = (ts[index + 2] as Token).features.stem;
      features['next2_pos_ngram'] = [pos(index), pos(index + 1), pos(index + 2)].join('+');
      features['next2_pos'] = pos(index + 2);
      Object.assign(features, this._common_features(index + 2, 'next2_'));
      Object.assign(features, this.sentence_structure.token_features(index + 2, 'next2_'));
    }
    if (index < ts.length - 3) {
      features['next3_stem'] = (ts[index + 3] as Token).features.stem;
      features['next3_pos_ngram'] = [pos(index), pos(index + 1), pos(index + 2), pos(index + 3)].join('+');
      features['next3_pos'] = pos(index + 3);
      Object.assign(features, this._common_features(index + 3, 'next3_'));
      Object.assign(features, this.sentence_structure.token_features(index + 3, 'next3_'));
    }
    return features;
  }

  /** Feature dicts for every token in the sentence. */
  sentence_features(): FeatureDict[] {
    return this.tokenized_sentence.map((token) => this._token_features(token));
  }
}
