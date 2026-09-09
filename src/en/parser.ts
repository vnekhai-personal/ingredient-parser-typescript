/** Port of `ingredient_parser/en/parser.py` (pin ffd6ae3). Identifiers verbatim. */
import { group_consecutive_idx } from '../_common.js';
import { LabelledToken, ParsedIngredient, type ParserDebugInfo } from '../dataclasses.js';
import { pyCapitalize } from '../_py.js';
import type { NumpyCRFInference } from '../inference.js';
import { load_parser_model } from './_loaders.js';
import { PostProcessor, type Quirks } from './postprocess.js';
import { PreProcessor } from './preprocess.js';

export interface ParseIngredientEnOptions {
  separate_names?: boolean;
  discard_isolated_stop_words?: boolean;
  expect_name_in_output?: boolean;
  string_units?: boolean;
  volumetric_units_system?: string;
  foundation_foods?: boolean;
  custom_units?: Readonly<Record<string, string>> | null;
  /** Beyond upstream: 'upstream' (default, byte-parity with Python) or 'fixed' (docs/PORTING.md). */
  quirks?: Quirks;
}

/** Addition beyond upstream: the model's view of a sentence without the postprocessor (`tag_ingredient`). */
export interface TaggedIngredient {
  /** Normalised sentence the tokens come from (`PreProcessor.sentence`). */
  sentence: string;
  tokens: string[];
  pos_tags: string[];
  labels: string[];
  scores: number[];
}

interface Prepared {
  processed_sentence: PreProcessor;
  postprocessed_sentence: PostProcessor;
  TAGGER: NumpyCRFInference;
}

function prepare(sentence: string, options: ParseIngredientEnOptions): Prepared {
  const separate_names = options.separate_names ?? true;
  const discard_isolated_stop_words = options.discard_isolated_stop_words ?? true;
  const expect_name_in_output = options.expect_name_in_output ?? true;
  const string_units = options.string_units ?? false;
  const volumetric_units_system = options.volumetric_units_system ?? 'us_customary';
  const foundation_foods = options.foundation_foods ?? false;
  let custom_units: Record<string, string> = { ...(options.custom_units ?? {}) };

  const TAGGER = load_parser_model();

  // Generate capitalized version of each entry in the custom units dictionary.
  const _capitalized_units: Record<string, string> = {};
  for (const [plural, singular] of Object.entries(custom_units)) {
    _capitalized_units[pyCapitalize(plural)] = pyCapitalize(singular);
  }
  custom_units = { ...custom_units, ..._capitalized_units };

  const processed_sentence = new PreProcessor(sentence, { custom_units, quirks: options.quirks ?? 'upstream' });
  const features = processed_sentence.sentence_features();
  const tagged = TAGGER.tag_from_features(features);
  let labels = tagged.map(([l]) => l);
  let scores = tagged.map(([, s]) => s);

  if (expect_name_in_output && labels.every((label) => !label.includes('NAME'))) {
    [labels, scores] = guess_ingredient_name(TAGGER, labels, scores);
  }

  const labelled_tokens = processed_sentence.tokenized_sentence.map(
    (token, i) =>
      new LabelledToken({
        index: token.index,
        text: token.text,
        pos_tag: token.pos_tag,
        label: labels[i] as string,
        score: scores[i] as number,
        plural: processed_sentence.singularised_indices.includes(token.index),
      }),
  );

  const postprocessed_sentence = new PostProcessor(sentence, labelled_tokens, {
    custom_units,
    separate_names,
    discard_isolated_stop_words,
    string_units,
    volumetric_units_system,
    foundation_foods,
    quirks: options.quirks ?? 'upstream',
  });
  return { processed_sentence, postprocessed_sentence, TAGGER };
}

/**
 * Addition beyond upstream (docs/QUIRKS.md): labels and marginal scores per token, exactly as
 * `parse_ingredient` computes them (same preprocessing, model and `expect_name_in_output`
 * fallback), without running the postprocessor. Lets a consumer build its own structure and
 * never hit a postprocessor quirk or one of its upstream-mirrored raises.
 */
export function tag_ingredient_en(sentence: string, options: ParseIngredientEnOptions = {}): TaggedIngredient {
  const expect_name_in_output = options.expect_name_in_output ?? true;
  let custom_units: Record<string, string> = { ...(options.custom_units ?? {}) };
  const _capitalized_units: Record<string, string> = {};
  for (const [plural, singular] of Object.entries(custom_units)) {
    _capitalized_units[pyCapitalize(plural)] = pyCapitalize(singular);
  }
  custom_units = { ...custom_units, ..._capitalized_units };
  const TAGGER = load_parser_model();
  const processed_sentence = new PreProcessor(sentence, { custom_units, quirks: options.quirks ?? 'upstream' });
  const tagged = TAGGER.tag_from_features(processed_sentence.sentence_features());
  let labels = tagged.map(([l]) => l);
  let scores = tagged.map(([, s]) => s);
  if (expect_name_in_output && labels.every((label) => !label.includes('NAME'))) {
    [labels, scores] = guess_ingredient_name(TAGGER, labels, scores);
  }
  return {
    sentence: processed_sentence.sentence,
    tokens: processed_sentence.tokenized_sentence.map((t) => t.text),
    pos_tags: processed_sentence.tokenized_sentence.map((t) => t.pos_tag),
    labels,
    scores,
  };
}

/** Parse an English ingredient sentence into structured data. */
export function parse_ingredient_en(sentence: string, options: ParseIngredientEnOptions = {}): ParsedIngredient {
  return prepare(sentence, options).postprocessed_sentence.parsed;
}

/** Return the intermediate objects generated during parsing. */
export function inspect_parser_en(sentence: string, options: ParseIngredientEnOptions = {}): ParserDebugInfo {
  const { processed_sentence, postprocessed_sentence, TAGGER } = prepare(sentence, options);
  return { sentence, PreProcessor: processed_sentence, PostProcessor: postprocessed_sentence, tagger: TAGGER };
}

/** Anything with `marginal(label, position)` — the tagger, or a stand-in in tests. */
export interface MarginalTagger {
  marginal(label: string, position: number): number;
}

/**
 * When no token got a NAME label, relabel the longest run of tokens whose most likely
 * NAME label scores above `min_score`.
 */
export function guess_ingredient_name(
  TAGGER: MarginalTagger,
  labels: string[],
  scores: number[],
  min_score = 0.2,
): [string[], number[]] {
  const NAME_LABELS = ['B_NAME_TOK', 'I_NAME_TOK', 'NAME_VAR', 'NAME_MOD', 'NAME_SEP'];

  const candidate_score_labels = new Map<number, [number, string]>();
  for (let i = 0; i < labels.length; i++) {
    const alt_label_scores: [number, string][] = NAME_LABELS.map((label) => [TAGGER.marginal(label, i), label]);
    // Python max(key=score): first maximal element.
    let max_score = alt_label_scores[0] as [number, string];
    for (const c of alt_label_scores.slice(1)) if (c[0] > max_score[0]) max_score = c;
    if (max_score[0] > min_score) candidate_score_labels.set(i, max_score);
  }

  if (candidate_score_labels.size === 0) return [labels, scores];

  const groups = [...group_consecutive_idx([...candidate_score_labels.keys()])].map((g) => [...g]);
  // sorted(groups, key=len, reverse=True)[0]: stable, so the first longest group wins.
  let indices = groups[0] as number[];
  for (const g of groups.slice(1)) if (g.length > indices.length) indices = g;
  for (const token_index of indices) {
    const [new_score, new_label] = candidate_score_labels.get(token_index) as [number, string];
    labels[token_index] = new_label;
    scores[token_index] = new_score;
  }
  return [labels, scores];
}
