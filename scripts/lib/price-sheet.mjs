/**
 * Price-sheet parsing.
 *
 * The workbooks are not tabular. Each sheet is a repeating block:
 *
 *   "CORN (1 PASS)","RATE PER ACRE","COST PER ACRE","Finance App",...
 *   "Ventas","32 oz","","0","0","0","0"
 *   ...
 *   "","TOTAL","0","0","0","0","0"
 *
 * so the parser is a small state machine over rows rather than a column mapping.
 *
 * Pure and dependency-free: the importing script owns all database access, which
 * means every rule below is unit-testable without a database or a network.
 */

/** Splits one CSV line, honouring quoted values and doubled quotes. */
export function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      fields.push(current);
      current = '';
    } else current += char;
  }

  fields.push(current);
  return fields;
}

export function parseCsv(text) {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseCsvLine);
}

const cell = (row, index) => (row[index] ?? '').trim();

/** `/\((\d+)\s*PASS\)/` — "CORN PRE (2 PASS)". */
function parsePassCount(name) {
  const match = /\((\d+)\s*pass\)/i.exec(name);
  return match ? Number.parseInt(match[1], 10) : 1;
}

/** The parenthesised token when it is not a pass marker: "E3's", "Ext.Flex". */
function parseTraitSystem(name) {
  const match = /\(([^)]+)\)/g;
  let found = null;
  let result = match.exec(name);

  while (result !== null) {
    if (!/\d+\s*pass/i.test(result[1])) found = result[1].trim();
    result = match.exec(name);
  }

  if (!found) return null;
  // "E3's" -> "E3"; leave deliberate punctuation like "Ext.Flex" alone.
  return found.replace(/'s$/i, '').replace(/^flex$/i, 'Flex');
}

function deriveCrop(name) {
  if (/\bcorn\b/i.test(name)) return 'corn';
  if (/\bbean/i.test(name)) return 'bean';
  return 'other';
}

function deriveStage(name) {
  if (/\bfung/i.test(name)) return 'fungicide';
  // "PRE BEAN (E3)" puts the stage first, so order does not matter here.
  if (/\bpre\b|\bpre-/i.test(name)) return 'pre';
  if (/\bpost\b/i.test(name)) return 'post';
  return 'single';
}

/** Parses a rate cell like "32 oz", "2.50 oz", "1.000SP", "2 #". */
export function parseRate(value) {
  const match = /^([\d.]+)\s*(.*)$/.exec((value ?? '').trim());
  if (!match) return { ratePerAcre: null, rateUnit: null };

  const ratePerAcre = Number.parseFloat(match[1]);
  const unit = match[2].trim().toLowerCase();

  const unitMap = {
    oz: 'oz',
    'oz.': 'oz',
    gal: 'gal',
    'gal.': 'gal',
    qt: 'qt',
    pt: 'pt',
    lb: 'lb',
    lbs: 'lb',
    '#': 'lb',
    'fl oz': 'oz',
    bag: 'bag',
    sp: 'bag',
  };

  return {
    ratePerAcre: Number.isFinite(ratePerAcre) ? ratePerAcre : null,
    rateUnit: unitMap[unit] ?? null,
  };
}

/**
 * Dollars to cents, treating blank, zero and unparseable as absent.
 *
 * A sheet full of `0` means "not yet priced", not "free", so zero is dropped
 * rather than imported — an invoice priced at $0.00 is worse than one the
 * composer refuses.
 */
export function parsePriceCents(value) {
  const raw = (value ?? '').replace(/[$,\s]/g, '');
  if (raw === '' || raw === '0' || raw === '0.00') return null;

  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed === 0) return null;
  return Math.round(parsed * 100);
}

/**
 * Parses a program sheet into blocks.
 *
 * `priceColumns` names the tier columns in order, and must line up with the
 * sheet's header row; a mismatch is a hard error rather than a silent shift,
 * because misaligned prices are worse than no prices.
 */
export function parseProgramSheet(rows, options) {
  const { priceColumns, seasonYear, requireCostColumn = true } = options;

  const programs = [];
  const annotations = [];
  const warnings = [];

  let current = null;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const label = cell(row, 1);
    const name = cell(row, 0);

    // Stray notes live beyond the price columns ("107.00 new price"). Header
    // rows are excluded: a column heading out there is a label, not lost data.
    const isHeader = label === 'RATE PER ACRE' || label === 'Rate Per Acre';
    if (!isHeader) {
      for (let column = 4 + priceColumns.length; column < row.length; column += 1) {
        const value = cell(row, column);
        if (value !== '') annotations.push({ row: index + 1, column: column + 1, value });
      }
    }

    if (isHeader) {
      const found = priceColumns.map((tier, offset) => ({
        tier,
        header: cell(row, 3 + offset),
      }));

      // Compare on letters and digits only: the sheet writes "Finance & Carry" on
      // some blocks and "Finance Carry" on others, and a missing ampersand is not
      // a layout error worth warning about.
      const bare = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
      const mismatched = found.filter(
        (entry) => entry.header && !bare(entry.header).includes(bare(entry.tier)),
      );

      if (mismatched.length > 0) {
        warnings.push(
          `row ${index + 1}: expected ${priceColumns.join(', ')} but found ${found
            .map((entry) => entry.header || '(blank)')
            .join(', ')}`,
        );
      }

      if (requireCostColumn && !/COST PER ACRE/i.test(cell(row, 2))) {
        warnings.push(`row ${index + 1}: cost column heading not recognised`);
      }

      current = {
        name: name || '(unnamed)',
        crop: deriveCrop(name),
        stage: deriveStage(name),
        passCount: parsePassCount(name),
        traitSystem: parseTraitSystem(name),
        seasonYear,
        ingredients: [],
        totals: null,
      };
      continue;
    }

    if (!current) continue;

    if (label.toUpperCase() === 'TOTAL') {
      current.totals = {
        costPerAcreCents: parsePriceCents(cell(row, 2)),
        pricesByTier: Object.fromEntries(
          priceColumns.map((tier, offset) => [tier, parsePriceCents(cell(row, 3 + offset))]),
        ),
      };
      programs.push(current);
      current = null;
      continue;
    }

    if (name === '') continue;

    current.ingredients.push({
      name,
      ...parseRate(cell(row, 1)),
      costPerAcreCents: parsePriceCents(cell(row, 2)),
      pricesByTier: Object.fromEntries(
        priceColumns.map((tier, offset) => [tier, parsePriceCents(cell(row, 3 + offset))]),
      ),
    });
  }

  if (current) {
    warnings.push(`program "${current.name}" has no TOTAL row; its totals were not read`);
    programs.push(current);
  }

  return { programs, annotations, warnings };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Product reconciliation
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Normalises a product name for matching.
 *
 * The sheets spell the same product several ways — `XSAte 53.8%` and `Xsate
 * 53.8%`, `Fulltec ` with a trailing space, `Delta`/`Delaro` style typos — so
 * punctuation, spacing and case are removed before comparison.
 */
export function normalizeName(value) {
  return (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .replace(/(\d)[.,](\d)/g, '$1$2');
}

/** Levenshtein distance, used only for the fallback similarity check. */
export function editDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }

  return previous[b.length] ?? Math.max(a.length, b.length);
}

/** 0..1 similarity of two already-normalised names. */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const distance = editDistance(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

/**
 * Finds the best existing product for a sheet name.
 *
 * Order matters: an exact normalised match wins, then one name containing the
 * other, then an edit-distance fallback. Returns null when nothing is close
 * enough, so the caller creates a product rather than attaching a price to the
 * wrong one.
 */
export function matchProduct(rawName, products, threshold = 0.85) {
  const needle = normalizeName(rawName);
  if (!needle) return null;

  let best = null;
  let bestScore = 0;

  for (const product of products) {
    const candidate = normalizeName(product.name);
    if (!candidate) continue;

    let score = similarity(needle, candidate);

    if (candidate === needle) score = 1;
    else if (candidate.startsWith(needle) || needle.startsWith(candidate)) {
      score = Math.max(score, 0.9);
    }

    if (score > bestScore) {
      bestScore = score;
      best = product;
    }
  }

  return bestScore >= threshold ? best : null;
}

/** A stable SKU for a product created from a sheet name. */
export function skuFor(name, prefix = 'CHEM') {
  const slug = (name ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);

  return `${prefix}-${slug || 'UNKNOWN'}`;
}
