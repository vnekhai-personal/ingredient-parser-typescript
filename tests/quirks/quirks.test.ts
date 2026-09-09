// Every correction in docs/QUIRKS.md is asserted twice — the default ('upstream') keeps
// Python's behaviour at the pin, 'fixed' applies the correction. Parity numbers stay true.
import { describe, expect, it } from 'vitest';
import { inspect_parser, parse_ingredient, parse_multiple_ingredients, tag_ingredient } from '../../src/index.js';
import type { IngredientAmount } from '../../src/index.js';
import type { PostProcessor } from '../../src/en/index.js';

const unit = (a: unknown): string => String((a as IngredientAmount).unit);

describe('quirks: upstream (default) vs fixed', () => {
  it('duplicate_unit_tokens — "1 teaspoon (tsp) salt"', () => {
    const up = parse_ingredient('1 teaspoon (tsp) salt');
    expect(unit(up.amount[0])).toBe('teaspoon ** 2');
    expect(up.amount[0]!.text).toBe('1 teaspoon tsp');
    const fx = parse_ingredient('1 teaspoon (tsp) salt', { quirks: 'fixed' });
    expect(unit(fx.amount[0])).toBe('teaspoon');
    expect(fx.amount[0]!.text).toBe('1 teaspoon');
    expect(fx.name[0]!.text).toBe('salt');
    // pluralised variant
    const fx2 = parse_ingredient('2 tablespoons (tbsp) olive oil', { quirks: 'fixed' });
    expect(unit(fx2.amount[0])).toBe('tablespoon');
    expect(fx2.amount[0]!.text).toBe('2 tablespoons');
    // genuinely different units are NOT collapsed
    const keep = parse_ingredient('1 pound 2 ounce chicken', { quirks: 'fixed' });
    expect(keep.amount.length).toBeGreaterThan(0);
  });

  it('name_pluralisation — "flat-leaf parsley"', () => {
    expect(parse_ingredient('1 cup flat-leaf parsley, chopped').name[0]!.text).toBe('flat-leaves parsley');
    const fx = parse_ingredient('1 cup flat-leaf parsley, chopped', { quirks: 'fixed' });
    expect(fx.name[0]!.text).toBe('flat-leaf parsley');
    expect(fx.amount[0]!.text).toBe('1 cup'); // amounts still pluralise as upstream
    expect(parse_ingredient('2 cup flour', { quirks: 'fixed' }).amount[0]!.text).toBe('2 cups');
    // a real-world line
    const h = parse_ingredient('A big handful of chopped flat-leaf parsley', { quirks: 'fixed' });
    expect(h.name[0]!.text).toBe('flat-leaf parsley');
    expect(h.amount[0]!.text).toBe('1 big handful');
    // genuinely plural names keep their plural (the preprocessor singularises "leaves"), singular stay singular
    expect(parse_ingredient('2 bay leaves', { quirks: 'fixed' }).name[0]!.text).toBe('bay leaves');
    expect(parse_ingredient('1 bay leaf', { quirks: 'fixed' }).name[0]!.text).toBe('bay leaf');
    expect(parse_ingredient('1 bay leaf').name[0]!.text).toBe('bay leaves'); // upstream
  });

  it('section_headers — "For the sauce" / "To serve"', () => {
    const up = parse_ingredient('For the sauce');
    expect(up.name.map((n) => n.text)).toEqual(['For the sauce']);
    expect(up.purpose).toBeNull();
    const fx = parse_ingredient('For the sauce', { quirks: 'fixed' });
    expect(fx.name).toEqual([]);
    expect(fx.purpose?.text).toBe('For the sauce');
    expect(parse_ingredient('To serve', { quirks: 'fixed' }).purpose?.text).toBe('To serve');
    // a real ingredient starting with "To" or with an amount is untouched
    expect(parse_ingredient('Tomatoes, diced', { quirks: 'fixed' }).name[0]!.text).toBe('Tomatoes');
    expect(parse_ingredient('1 cup sauce for the chicken', { quirks: 'fixed' }).name.length).toBe(1);
  });

  it('multiple_ingredients_default — upstream default "us" raises, fixed does not', () => {
    expect(() => parse_multiple_ingredients(['1 cup flour'])).toThrow(/Unsupported volumetric_units_system "us"/);
    const fx = parse_multiple_ingredients(['1 cup flour', '2 tsp salt'], { quirks: 'fixed' });
    expect(fx.map((p) => p.name[0]!.text)).toEqual(['flour', 'salt']);
  });
});

describe('quirks batch 2026-09-09: input corrections and amount assembly', () => {
  const fx = (s: string) => parse_ingredient(s, { quirks: 'fixed' });
  const amounts = (p: ReturnType<typeof parse_ingredient>) => p.amount.map((a) => ('amounts' in a ? `[${a.text}]` : a.text));

  it('literal_escapes — "\\n" and "\\t" as two characters are whitespace', () => {
    expect(parse_ingredient('6 tablespoons olive oil\\n').name[0]!.text).toBe('olive oil\\n');
    expect(fx('6 tablespoons olive oil\\n').name[0]!.text).toBe('olive oil');
    expect(fx('1 cup\\tflour').name[0]!.text).toBe('flour');
  });

  it('number_words — half a, a couple of, a dozen', () => {
    expect(String((parse_ingredient('Juice of half a lemon').amount[0] as IngredientAmount).quantity)).toBe('half');
    expect(String((fx('Juice of half a lemon').amount[0] as IngredientAmount).quantity)).toBe('1/2');
    expect(fx('Half a vanilla bean, split lengthwise').amount[0]!.text).toBe('1/2');
    const couple = fx('A couple of sprigs each thyme and parsley');
    expect(couple.amount[0]!.text).toBe('2 sprigs');
    expect((couple.amount[0] as IngredientAmount).APPROXIMATE).toBe(true);
    expect((couple.amount[0] as IngredientAmount).SINGULAR).toBe(true);
    expect(couple.comment).toBeNull();
    expect(parse_ingredient('A couple of sprigs each thyme and parsley').comment?.text).toBe('A couple of');
    expect(amounts(fx('a dozen oysters'))).toEqual(['12']);
    expect(amounts(fx('half a dozen eggs'))).toEqual(['6']);
    expect(amounts(parse_ingredient('half a dozen eggs'))).toEqual(['half', 'dozen']);
    // "a couple of" inside prose is left alone
    expect(fx('1 cup beans, soaked for a couple of hours').preparation?.text).toBe('soaked for a couple of hours');
    expect(fx('Salt and a couple of grinds of pepper').amount[0]!.text).toBe('2 grinds');
    // "one and a half" is not touched (no "half a")
    expect(fx('one and a half cups flour').amount[0]!.text).toBe(parse_ingredient('one and a half cups flour').amount[0]!.text);
  });

  it('spaceless_mixed_number — "11/2" is 1 1/2', () => {
    expect(parse_ingredient('11/2 ounces tequila').amount[0]!.text).toBe('11/2 ounces');
    expect(fx('11/2 ounces tequila').amount[0]!.text).toBe('1 1/2 ounces');
    expect(String((fx('11/2 ounces tequila').amount[0] as IngredientAmount).quantity)).toBe('3/2');
    expect(amounts(fx('12 tablespoons (11/2 sticks) unsalted butter, softened'))).toEqual(['12 tablespoons', '1 1/2 sticks']);
    expect(fx('about 12/3 cups almonds').amount[0]!.text).toBe('1 2/3 cups');
    // not a spaceless mixed number: numerator not below the denominator, or more digits
    expect(fx('19/2 ounces x').amount[0]!.text).toBe(parse_ingredient('19/2 ounces x').amount[0]!.text);
    expect(fx('111/2 ounces x').amount[0]!.text).toBe(parse_ingredient('111/2 ounces x').amount[0]!.text);
  });

  it('hyphenated_count_container — "1-14 1/2-ounce can" is not a range', () => {
    const up = parse_ingredient('1-14 1/2-ounce can chopped tomatoes');
    expect((up.amount[1] as IngredientAmount).RANGE).toBe(true);
    const f = fx('1-14 1/2-ounce can chopped tomatoes');
    expect(amounts(f)).toEqual(['1 can', '14 1/2 ounces']);
    expect((f.amount[1] as IngredientAmount).RANGE).toBe(false);
    expect((f.amount[1] as IngredientAmount).SINGULAR).toBe(true);
    expect(amounts(fx('2-8-ounce cans tomato sauce'))).toEqual(['2 cans', '8 ounces']);
    // a real range stays a range, including a hyphenated weight range
    expect((fx('2-3 pounds small cremini mushrooms').amount[0] as IngredientAmount).RANGE).toBe(true);
    expect(amounts(fx('2-3-lb center-cut tenderloin roast, trimmed'))).toEqual(['2-3 lb']);
    expect(amounts(fx('1 8- to 10-pound goose'))).toEqual(amounts(parse_ingredient('1 8- to 10-pound goose')));
  });

  it('dimension_fraction_count — "12 1/4-inch-thick slices" is twelve slices', () => {
    expect(amounts(parse_ingredient('12 1/4-inch-thick slices brioche'))).toEqual(['1 slice', '12 1/4 inch-thick']);
    const f = fx('12 1/4-inch-thick slices brioche');
    expect(amounts(f)).toEqual(['12 slices']);
    expect(f.size?.text).toBe('1/4 inch-thick');
    expect(f.name[0]!.text).toBe('brioche');
    expect(amounts(fx('2 1/2-inch-thick steaks'))).toEqual(['2']);
    expect(fx('2 1/2-inch-thick steaks').size?.text).toBe('1/2 inch-thick');
    // a count already present, or a weight rather than a dimension: unchanged
    expect(amounts(fx('2 1 1/2-pound eggplants, peeled and diced'))).toEqual(amounts(parse_ingredient('2 1 1/2-pound eggplants, peeled and diced')));
    expect(amounts(fx('3 1/2-pound chickens'))).toEqual(amounts(parse_ingredient('3 1/2-pound chickens')));
    // singular noun: the mixed number is the thickness, as upstream reads it
    expect(amounts(fx('1 1/2-inch-thick slice of peeled fresh ginger'))).toEqual(amounts(parse_ingredient('1 1/2-inch-thick slice of peeled fresh ginger')));
  });

  it('size_adjective_container — "10 to 20 thin slices" counts slices', () => {
    const up = parse_ingredient('10 to 20 thin slices of prosciutto');
    expect(amounts(up)).toEqual(['1 slice', '10-20 thin']);
    const f = fx('10 to 20 thin slices of prosciutto');
    expect(amounts(f)).toEqual(['10-20 slice']); // ranges keep upstream's singular unit text ("2-3 pound")
    expect((f.amount[0] as IngredientAmount).RANGE).toBe(true);
    expect(f.size?.text).toBe('thin');
    expect(fx('4 thick slices day-old bread').amount[0]!.text).toBe('4 slices');
    expect(fx('4 thick slices day-old bread').size?.text).toBe('thick');
    expect(fx('8 large slices country rye bread').amount[0]!.text).toBe('8 slices');
    // a non-numeric quantity token is not a count
    expect(amounts(fx('Very thin lemon slices'))).toEqual(amounts(parse_ingredient('Very thin lemon slices')));
    // a measurable inner unit keeps upstream's container reading
    expect(amounts(fx('14 1/2 ounce can diced tomatoes'))).toEqual(['1 can', '14 1/2 ounces']);
    // an unresolvable measure spelling is not a size word: unchanged
    expect(amounts(fx('500 gm tin tomatoes'))).toEqual(amounts(parse_ingredient('500 gm tin tomatoes')));
    expect(amounts(fx('2 ltr bottle water'))).toEqual(amounts(parse_ingredient('2 ltr bottle water')));
  });

  it('each_before_amount — "each weighing about 6 ounces" is SINGULAR', () => {
    const up = parse_ingredient('6 McIntosh apples, each weighing about 6 ounces');
    expect((up.amount[1] as IngredientAmount).SINGULAR).toBe(false);
    expect(up.comment?.text).toBe('each weighing');
    const f = fx('6 McIntosh apples, each weighing about 6 ounces');
    expect((f.amount[1] as IngredientAmount).SINGULAR).toBe(true);
    expect((f.amount[1] as IngredientAmount).APPROXIMATE).toBe(true);
    expect(f.comment).toBeNull();
    // the upstream shape still works
    expect((fx('2 chickens, about 4 pounds each').amount[1] as IngredientAmount).SINGULAR).toBe(true);
  });

  it('stray_unit_token — a far-away UNIT token does not fuse into the unit', () => {
    const up = parse_ingredient('2 ounces ginger root (one 3-inch knob), thinly sliced');
    expect(unit(up.amount[0])).toBe('ounces knobs');
    const f = fx('2 ounces ginger root (one 3-inch knob), thinly sliced');
    expect(f.amount[0]!.text).toBe('2 ounces');
    expect(unit(f.amount[0])).toBe('ounce');
    expect(f.size?.text).toBe('(one 3 inch knob)');
    expect(f.preparation?.text).toBe('thinly sliced');
    // completes a unit-less count instead: "2 (6-ounce) pieces"
    expect(amounts(fx('2 (6-ounce) pieces salmon'))).toEqual(['2 pieces', '6 ounces']);
    expect((fx('2 (6-ounce) pieces salmon').amount[1] as IngredientAmount).SINGULAR).toBe(true); // 6 ounces per piece
    expect((fx('4 (6 ounce) containers low-fat vanilla yogurt').amount[1] as IngredientAmount).SINGULAR).toBe(true);
    expect(amounts(fx('8 (1 ounce) squares white chocolate, chopped'))).toEqual(['8 squares', '1 ounce']);
    expect(amounts(fx('1 (8 ounce) round Reblochon cheese'))).toEqual(['1 round', '8 ounces']);
    // a stray size or approximation word never completes an amount
    expect(amounts(fx('5 large egg yolks (100 grams or scant 1/2 cup)'))).toEqual(['5', '100 grams', '1/2 cups']);
    expect(fx('8 ounces orzo (a scant 1 1/3 cups)').amount[0]!.text).toBe('8 ounces');
    // a UNIT token after a NAME keeps upstream's reading ("large clove" is the unit)
    expect(amounts(fx('4 large garlic cloves, peeled'))).toEqual(amounts(parse_ingredient('4 large garlic cloves, peeled')));
    expect(amounts(fx('1 small fennel bulb, chopped'))).toEqual(amounts(parse_ingredient('1 small fennel bulb, chopped')));
  });

  it('placeholder_text — fraction placeholders never leak into text', () => {
    const s = '2 pounds boneless shank or shoulder lamb, cut into 1- to 1 1/2-inch cubes';
    expect(parse_ingredient(s).preparation?.text).toBe('cut into 1-1#1$2 inch cubes');
    expect(fx(s).preparation?.text).toBe('cut into 1-1 1/2 inch cubes');
  });

  it('name_pluralisation now covers every text field', () => {
    // upstream re-pluralises every unit word in every text field, even after "1"
    expect(parse_ingredient('1 tablespoon chopped fresh oregano or 1 teaspoon dried').comment?.text).toBe('or 1 teaspoons dried');
    expect(fx('1 tablespoon chopped fresh oregano or 1 teaspoon dried').comment?.text).toBe('or 1 teaspoon dried');
    expect(parse_ingredient('1 loaf bread, cut into 1/2 inch slice').preparation?.text).toBe('cut into 1/2 inch slices');
    expect(fx('1 loaf bread, cut into 1/2 inch slice').preparation?.text).toBe('cut into 1/2 inch slice');
    // a word the preprocessor singularised is restored
    expect(fx('1 pound beef, cut into 1-inch cubes').preparation?.text).toBe('cut into 1 inch cubes');
    expect(fx('1 cup peeled chestnuts (about 20), or 1 cup canned chestnuts').comment?.text).toContain('1 cup canned');
  });
});

describe('tag_ingredient (addition beyond upstream)', () => {
  it('returns the same labels and scores parse_ingredient uses, without the postprocessor', () => {
    const s = '2 tbsp chopped flat-leaf parsley';
    const t = tag_ingredient(s);
    const info = inspect_parser(s);
    const tokens = (info.PostProcessor as PostProcessor).tokens;
    expect(t.tokens).toEqual(tokens.map((x) => x.text));
    expect(t.labels).toEqual(tokens.map((x) => x.label));
    expect(t.scores).toEqual(tokens.map((x) => x.score));
    expect(t.pos_tags.length).toBe(t.tokens.length);
    expect(t.sentence).toBe('2 tbsp chopped flat-leaf parsley');
    expect(t.labels).toEqual(['QTY', 'UNIT', 'PREP', 'B_NAME_TOK', 'I_NAME_TOK']);
  });
  it('never runs the postprocessor: a line whose upstream postprocessing raises still tags', () => {
    // "dozen" first with nothing before it: upstream's fallback pattern raises IndexError (mirrored).
    expect(() => parse_ingredient('dozen eggs or 2')).toThrow();
    const t = tag_ingredient('dozen eggs or 2');
    expect(t.tokens.length).toBe(t.labels.length);
    expect(t.labels[0]).toBe('QTY');
  });
  it('honours expect_name_in_output and custom_units like parse_ingredient', () => {
    expect(tag_ingredient('1 cup, plus 2 tablespoons olive oil', { expect_name_in_output: false }).labels.some((l) => l.includes('NAME'))).toBe(true);
    const cu = tag_ingredient('2 punnets strawberries', { custom_units: { punnets: 'punnet' } });
    expect(cu.labels[1]).toBe('UNIT');
  });
});
