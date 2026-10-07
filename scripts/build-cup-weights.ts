// Builds src/domain/cup-weights.ts — what a cup of an ingredient weighs —
// from USDA FoodData Central's SR Legacy release, which is public domain and
// measured rather than estimated. Every figure in the output names the USDA
// record it came from, so any one of them can be checked at
// https://fdc.nal.usda.gov/food-details/<fdcId>/nutrients.
//
//   curl -LO https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_csv_2018-04.zip
//   unzip FoodData_Central_sr_legacy_food_csv_2018-04.zip
//   npx tsx scripts/build-cup-weights.ts FoodData_Central_sr_legacy_food_csv_2018-04
//
// To add an ingredient, add a line to SPEC and run it again.

import fs from 'node:fs'
import path from 'node:path'

type Spec = {
  // How recipes write it. Matched on the food words, so "unsalted butter"
  // already finds "butter" — list the wordings that genuinely differ.
  names: string[]
  fdcId: number
  // Which USDA portion to use for each way of preparing it. The first is
  // the default; the others are picked when the recipe line says "sliced",
  // "packed" and so on.
  portions: [prep: string, modifier: RegExp][]
}

// Deliberately missing:
// - salt: a tablespoon of kosher salt weighs about half a tablespoon of table
//   salt, and recipes rarely say which. One figure would be wrong for one of them.
// - spices, baking soda and powder: measured by the teaspoon, which is too
//   small to be worth weighing.
// - caster sugar, panko, Greek yogurt, black beans: close cousins weigh
//   noticeably differently and SR Legacy has no cup weight for them.
// - bare "coriander", "shallots", "red pepper": each means a different
//   ingredient depending on the country or the recipe.
const SPEC: Spec[] = [
  // flours and starches
  { names: ['flour', 'all-purpose flour', 'all purpose flour', 'plain flour', 'ap flour', 'white flour'], fdcId: 168894, portions: [['cup', /^cup$/]] },
  { names: ['self-raising flour', 'self-rising flour', 'self raising flour', 'self rising flour'], fdcId: 168895, portions: [['cup', /^cup$/]] },
  { names: ['bread flour', 'strong flour'], fdcId: 168896, portions: [['cup', /^cup$/]] },
  { names: ['whole wheat flour', 'whole-wheat flour', 'wholemeal flour', 'whole grain flour'], fdcId: 168893, portions: [['cup', /^cup$/]] },
  { names: ['cake flour'], fdcId: 169723, portions: [['cup', /^cup unsifted/]] },
  { names: ['rye flour'], fdcId: 168886, portions: [['cup', /^cup$/]] },
  { names: ['semolina', 'semolina flour'], fdcId: 169715, portions: [['cup', /^cup$/]] },
  { names: ['rice flour'], fdcId: 169714, portions: [['cup', /^cup$/]] },
  { names: ['cornstarch', 'corn starch', 'cornflour'], fdcId: 169698, portions: [['cup', /^cup$/]] },
  { names: ['cornmeal', 'polenta', 'ground polenta'], fdcId: 169697, portions: [['cup', /^cup$/]] },
  { names: ['breadcrumbs', 'bread crumbs', 'dry breadcrumbs', 'dried breadcrumbs'], fdcId: 174928, portions: [['cup', /^cup$/]] },
  { names: ['oats', 'rolled oats', 'old-fashioned oats', 'quick oats', 'oatmeal'], fdcId: 173904, portions: [['cup', /^cup$/]] },

  // sugars and syrups
  { names: ['sugar', 'white sugar', 'granulated sugar', 'cane sugar'], fdcId: 169655, portions: [['cup', /^cup$/]] },
  { names: ['brown sugar'], fdcId: 168833, portions: [['packed', /^cup packed$/], ['unpacked', /^cup unpacked$/]] },
  { names: ['powdered sugar', 'icing sugar', 'confectioners sugar'], fdcId: 169656, portions: [['cup', /^cup unsifted$/], ['sifted', /^cup sifted$/]] },
  { names: ['honey'], fdcId: 169640, portions: [['cup', /^cup$/]] },
  { names: ['maple syrup'], fdcId: 169661, portions: [['cup', /^cup$/]] },
  { names: ['molasses'], fdcId: 168820, portions: [['cup', /^cup$/]] },
  { names: ['corn syrup'], fdcId: 168837, portions: [['cup', /^cup$/]] },
  { names: ['cocoa', 'cocoa powder', 'unsweetened cocoa', 'unsweetened cocoa powder'], fdcId: 169593, portions: [['cup', /^cup$/]] },
  { names: ['chocolate chips', 'semisweet chocolate chips', 'semi-sweet chocolate chips', 'dark chocolate chips', 'milk chocolate chips'], fdcId: 167976, portions: [['cup', /chips \(6 oz package\)/]] },

  // fats
  { names: ['butter'], fdcId: 173430, portions: [['cup', /^cup$/]] },
  { names: ['shortening', 'vegetable shortening'], fdcId: 171011, portions: [['cup', /^cup$/]] },
  { names: ['olive oil'], fdcId: 171413, portions: [['cup', /^cup$/]] },
  { names: ['oil', 'vegetable oil', 'canola oil', 'neutral oil', 'sunflower oil', 'grapeseed oil', 'avocado oil'], fdcId: 172370, portions: [['cup', /^cup$/]] },
  { names: ['sesame oil', 'toasted sesame oil'], fdcId: 171016, portions: [['cup', /^cup$/]] },
  { names: ['coconut oil'], fdcId: 171412, portions: [['cup', /^cup$/]] },
  { names: ['peanut butter'], fdcId: 172470, portions: [['cup', /^cup$/]] },
  { names: ['mayonnaise', 'mayo'], fdcId: 171009, portions: [['cup', /^cup$/]] },

  // dairy
  { names: ['milk', 'whole milk', 'full cream milk', 'skim milk', 'low fat milk'], fdcId: 171265, portions: [['cup', /^cup$/]] },
  { names: ['buttermilk'], fdcId: 170874, portions: [['cup', /^cup$/]] },
  { names: ['cream', 'heavy cream', 'whipping cream', 'heavy whipping cream', 'thickened cream', 'double cream', 'pouring cream'], fdcId: 170859, portions: [['cup', /^cup, fluid/]] },
  { names: ['sour cream'], fdcId: 171257, portions: [['cup', /^cup$/]] },
  { names: ['yogurt', 'yoghurt', 'plain yogurt', 'plain yoghurt'], fdcId: 171284, portions: [['cup', /^cup/]] },
  { names: ['cream cheese'], fdcId: 173418, portions: [['cup', /^cup$/]] },
  { names: ['ricotta', 'ricotta cheese'], fdcId: 170851, portions: [['cup', /^cup$/]] },
  { names: ['cheese', 'cheddar', 'cheddar cheese', 'tasty cheese'], fdcId: 173414, portions: [['shredded', /^cup, shredded$/], ['chopped', /^cup, diced$/]] },
  { names: ['mozzarella', 'mozzarella cheese'], fdcId: 170845, portions: [['shredded', /^cup, shredded$/]] },
  { names: ['monterey jack', 'monterey jack cheese', 'jack cheese'], fdcId: 170844, portions: [['shredded', /^cup, shredded$/], ['chopped', /^cup, diced$/]] },
  { names: ['swiss cheese', 'gruyere', 'gruyere cheese'], fdcId: 171251, portions: [['shredded', /^cup, shredded$/], ['chopped', /^cup, diced$/]] },
  { names: ['parmesan', 'parmesan cheese', 'parmigiano', 'parmigiano-reggiano'], fdcId: 171247, portions: [['cup', /^cup$/]] },
  { names: ['feta', 'feta cheese'], fdcId: 173420, portions: [['crumbled', /^cup, crumbled$/]] },
  { names: ['coconut milk'], fdcId: 170173, portions: [['cup', /^cup$/]] },

  // grains and legumes, uncooked unless they say otherwise
  { names: ['rice', 'white rice', 'long grain rice', 'long-grain rice', 'long-grain white rice', 'jasmine rice', 'basmati rice'], fdcId: 168877, portions: [['cup', /^cup$/]] },
  { names: ['arborio rice', 'short grain rice', 'short-grain rice', 'sushi rice', 'risotto rice'], fdcId: 168881, portions: [['cup', /^cup$/]] },
  { names: ['brown rice'], fdcId: 169703, portions: [['cup', /^cup$/]] },
  { names: ['quinoa'], fdcId: 168874, portions: [['cup', /^cup$/]] },
  { names: ['lentils', 'red lentils', 'green lentils', 'brown lentils'], fdcId: 172420, portions: [['cup', /^cup$/]] },
  { names: ['couscous'], fdcId: 169699, portions: [['cup', /^cup$/]] },
  { names: ['chickpeas', 'garbanzo beans', 'canned chickpeas'], fdcId: 173801, portions: [['cup', /^cup drained/]] },
  { names: ['pinto beans', 'canned pinto beans'], fdcId: 173797, portions: [['cup', /^cup$/]] },
  { names: ['kidney beans', 'red kidney beans', 'canned kidney beans'], fdcId: 175243, portions: [['cup', /^cup/]] },

  // nuts and seeds
  { names: ['almonds'], fdcId: 170567, portions: [['whole', /^cup, whole$/], ['sliced', /^cup, sliced$/], ['slivered', /^cup, slivered$/], ['ground', /^cup, ground$/]] },
  { names: ['almond meal', 'almond flour', 'ground almonds'], fdcId: 170567, portions: [['ground', /^cup, ground$/]] },
  { names: ['walnuts'], fdcId: 170187, portions: [['chopped', /^cup, chopped$/], ['halves', /50 halves/], ['ground', /^cup, ground$/]] },
  { names: ['pecans'], fdcId: 170182, portions: [['chopped', /^cup, chopped$/], ['halves', /^cup, halves$/]] },
  { names: ['pine nuts'], fdcId: 170591, portions: [['cup', /^cup$/]] },
  { names: ['peanuts'], fdcId: 172430, portions: [['cup', /^cup$/]] },
  { names: ['sesame seeds'], fdcId: 170150, portions: [['cup', /^cup$/]] },
  { names: ['coconut', 'desiccated coconut', 'flaked coconut', 'sweetened coconut'], fdcId: 168586, portions: [['shredded', /^cup, shredded$/]] },
  { names: ['raisins', 'sultanas'], fdcId: 168165, portions: [['cup', /not packed/], ['packed', /^cup, packed$/]] },

  // liquids
  { names: ['water', 'cold water', 'warm water', 'hot water', 'boiling water', 'ice water'], fdcId: 174158, portions: [['cup', /^cup$/]] },
  { names: ['chicken broth', 'chicken stock', 'broth', 'stock', 'chicken broth stock'], fdcId: 171609, portions: [['cup', /^cup$/]] },
  { names: ['beef broth', 'beef stock'], fdcId: 171538, portions: [['cup', /^cup$/]] },
  { names: ['vegetable broth', 'vegetable stock', 'veggie broth', 'veggie stock'], fdcId: 171583, portions: [['cup', /^cup$/]] },
  { names: ['soy sauce', 'light soy sauce', 'dark soy sauce', 'tamari', 'shoyu'], fdcId: 174277, portions: [['cup', /^cup$/]] },
  { names: ['vinegar', 'white vinegar', 'distilled vinegar', 'white wine vinegar', 'red wine vinegar', 'rice vinegar'], fdcId: 172237, portions: [['cup', /^cup$/]] },
  { names: ['apple cider vinegar', 'cider vinegar'], fdcId: 173469, portions: [['cup', /^cup$/]] },
  { names: ['balsamic vinegar', 'balsamic'], fdcId: 172241, portions: [['cup', /^cup$/]] },
  { names: ['lemon juice'], fdcId: 167747, portions: [['cup', /^cup$/]] },
  { names: ['lime juice'], fdcId: 168156, portions: [['cup', /^cup$/]] },
  { names: ['tomato sauce'], fdcId: 170054, portions: [['cup', /^cup$/]] },
  { names: ['tomato puree', 'passata'], fdcId: 170460, portions: [['cup', /^cup$/]] },
  { names: ['tomato paste'], fdcId: 170459, portions: [['cup', /^cup$/]] },
  { names: ['crushed tomatoes', 'canned crushed tomatoes'], fdcId: 170501, portions: [['cup', /^cup$/]] },

  // vegetables, herbs and fruit — how they're cut changes the weight a lot
  { names: ['onion', 'yellow onion', 'brown onion', 'white onion', 'red onion', 'sweet onion'], fdcId: 170000, portions: [['chopped', /^cup, chopped$/], ['sliced', /^cup, sliced$/]] },
  { names: ['celery'], fdcId: 169988, portions: [['chopped', /^cup chopped$/]] },
  { names: ['carrots', 'carrot'], fdcId: 170393, portions: [['chopped', /^cup chopped$/], ['grated', /^cup grated$/], ['sliced', /strips or slices/]] },
  { names: ['bell pepper', 'red bell pepper', 'green bell pepper', 'yellow bell pepper', 'capsicum', 'red capsicum', 'sweet pepper'], fdcId: 170108, portions: [['chopped', /^cup, chopped$/], ['sliced', /^cup, sliced$/]] },
  { names: ['broccoli', 'broccoli florets'], fdcId: 170379, portions: [['chopped', /^cup chopped$/]] },
  { names: ['spinach', 'baby spinach', 'fresh spinach'], fdcId: 168462, portions: [['cup', /^cup$/]] },
  { names: ['kale'], fdcId: 168421, portions: [['cup', /^cup$/]] },
  { names: ['cabbage', 'green cabbage', 'red cabbage'], fdcId: 169975, portions: [['chopped', /^cup, chopped$/], ['shredded', /^cup, shredded$/]] },
  { names: ['mushrooms', 'white mushrooms', 'button mushrooms', 'cremini mushrooms'], fdcId: 169251, portions: [['sliced', /pieces or slices/], ['whole', /^cup, whole$/]] },
  { names: ['peas', 'frozen peas', 'green peas'], fdcId: 170016, portions: [['cup', /^cup$/]] },
  { names: ['corn', 'corn kernels', 'frozen corn', 'sweet corn'], fdcId: 168398, portions: [['cup', /^cup$/]] },
  { names: ['tomatoes', 'tomato'], fdcId: 170457, portions: [['chopped', /chopped or sliced/]] },
  { names: ['cherry tomatoes', 'grape tomatoes'], fdcId: 170457, portions: [['cup', /cherry tomatoes/]] },
  { names: ['potatoes', 'potato'], fdcId: 170026, portions: [['chopped', /diced/]] },
  { names: ['sweet potato', 'sweet potatoes', 'kumara'], fdcId: 168482, portions: [['chopped', /cubes/]] },
  { names: ['zucchini', 'courgette'], fdcId: 169291, portions: [['chopped', /^cup, chopped$/], ['sliced', /^cup, sliced$/]] },
  { names: ['leeks', 'leek'], fdcId: 169246, portions: [['cup', /^cup$/]] },
  { names: ['cucumber'], fdcId: 168409, portions: [['sliced', /slices/]] },
  { names: ['green onions', 'scallions', 'spring onions'], fdcId: 170005, portions: [['chopped', /^cup, chopped$/]] },
  { names: ['garlic'], fdcId: 169230, portions: [['cup', /^cup$/]] },
  { names: ['ginger', 'fresh ginger', 'ginger root'], fdcId: 169231, portions: [['sliced', /slices/]] },
  { names: ['cilantro', 'cilantro leaves', 'coriander leaves', 'fresh coriander'], fdcId: 169997, portions: [['cup', /^cup$/]] },
  { names: ['parsley', 'flat-leaf parsley', 'italian parsley'], fdcId: 170416, portions: [['chopped', /^cup chopped$/]] },
  { names: ['basil', 'basil leaves'], fdcId: 172232, portions: [['cup', /leaves, whole/]] },
  { names: ['romaine', 'romaine lettuce', 'lettuce', 'cos lettuce'], fdcId: 169247, portions: [['shredded', /shredded/]] },
  { names: ['arugula', 'rocket'], fdcId: 169387, portions: [['cup', /^cup$/]] },
  { names: ['blueberries'], fdcId: 171711, portions: [['cup', /^cup$/]] },
  { names: ['strawberries'], fdcId: 167762, portions: [['whole', /^cup, whole$/], ['sliced', /^cup, sliced$/], ['halves', /^cup, halves$/]] },
  { names: ['banana', 'bananas'], fdcId: 173944, portions: [['mashed', /^cup, mashed$/], ['sliced', /^cup, sliced$/]] },
  { names: ['apples', 'apple'], fdcId: 171688, portions: [['chopped', /quartered or chopped/], ['sliced', /slices/]] },
  // Nobody measures raw chicken by the cup, so a cup of chicken is cooked.
  { names: ['chicken', 'cooked chicken', 'rotisserie chicken'], fdcId: 171054, portions: [['chopped', /chopped or diced/]] },
]

// --- minimal CSV reading: every field in these files is quoted ---

function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, 'utf8')
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (c !== '\r') field += c
  }
  if (field || row.length) rows.push([...row, field])
  const [header, ...body] = rows
  return body.map((r) => Object.fromEntries(header!.map((h, n) => [h, r[n] ?? ''])))
}

const dir = process.argv[2]
if (!dir) {
  console.error('usage: npx tsx scripts/build-cup-weights.ts <unzipped SR Legacy folder>')
  process.exit(1)
}

const descriptions = new Map(
  readCsv(path.join(dir, 'food.csv')).map((r) => [Number(r.fdc_id), r.description!]),
)
const portionsByFood = new Map<number, Record<string, string>[]>()
for (const p of readCsv(path.join(dir, 'food_portion.csv'))) {
  const id = Number(p.fdc_id)
  portionsByFood.set(id, [...(portionsByFood.get(id) ?? []), p])
}

const out = SPEC.map((spec) => {
  const usda = descriptions.get(spec.fdcId)
  if (!usda) throw new Error(`no USDA food ${spec.fdcId}`)
  const grams: Record<string, number> = {}
  for (const [prep, modifier] of spec.portions) {
    const portion = (portionsByFood.get(spec.fdcId) ?? []).find((p) =>
      modifier.test(p.modifier ?? ''),
    )
    if (!portion) throw new Error(`${usda}: no portion matching ${modifier}`)
    // Some foods are only given per ¼ or ½ cup.
    grams[prep] = Math.round(Number(portion.gram_weight) / Number(portion.amount))
  }
  // "(Includes foods for USDA's Food Distribution Program)" is bookkeeping,
  // not a description of the food.
  const name = usda.replace(/\s*\(Includes foods for USDA's Food Distribution Program\)/, '')
  return { names: spec.names, usda: name, fdcId: spec.fdcId, grams }
})

const target = path.join(import.meta.dirname, '..', 'src', 'domain', 'cup-weights.ts')
fs.writeFileSync(
  target,
  `// GENERATED by scripts/build-cup-weights.ts — edit the spec there, not this file.
//
// What one US cup (236.6 ml) of each ingredient weighs, in grams, from USDA
// FoodData Central, SR Legacy (April 2018). Public domain and measured, not
// estimated by us; fdcId is the USDA record each figure came from. The first
// entry in \`grams\` is the default; the rest are picked by how the recipe
// says it's prepared ("sliced", "packed").

export type CupWeight = {
  names: string[]
  usda: string
  fdcId: number
  grams: Record<string, number>
}

export const CUP_WEIGHTS: CupWeight[] = [
${out.map((e) => `  ${JSON.stringify(e)},`).join('\n')}
]
`,
)
console.log(`wrote ${out.length} ingredients to ${path.relative(process.cwd(), target)}`)
