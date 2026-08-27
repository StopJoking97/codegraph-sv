/**
 * Census over the INDEXED corpus files: how many `define sites, how many
 * distinct names, how many `text_macro_usage` nodes the grammar sees, and how
 * many macro references live inside conditional-compilation DIRECTIVES (which
 * the pre-parse blanks before the grammar ever sees them).
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const REPO = path.resolve(__dirname, '..', '..');
const ROOT = process.argv[2] || '.';
const DB = process.argv[3] || path.join(ROOT, '.codegraph', 'codegraph.db');

(async () => {
  const db = new DatabaseSync(DB, { readOnly: true });
  const files = db
    .prepare("SELECT path FROM files WHERE language = 'systemverilog'")
    .all()
    .map((r) => r.path.replace(/\\/g, '/'));

  const g = require(path.join(REPO, 'dist/extraction/grammars.js'));
  await g.initGrammars();
  await g.loadAllGrammars();
  const { blankVerilogConditionalDirectives } = require(path.join(REPO, 'dist/extraction/languages/systemverilog.js'));
  const parser = g.getParser('systemverilog');

  const defsByName = new Map(); // name -> Set(file)
  let defSites = 0;
  let usageNodes = 0;
  let directiveUses = 0;
  const directiveNames = new Set();

  for (const rel of files) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, rel.replace(/\//g, path.sep)), 'utf8'); } catch { continue; }

    // Directive references, counted on the ORIGINAL source.
    for (const m of src.matchAll(/^[ \t]*`(?:ifndef|ifdef|elsif)[ \t]+([A-Za-z_]\w*)/gm)) {
      directiveUses++;
      directiveNames.add(m[1]);
    }

    const tree = parser.parse(blankVerilogConditionalDirectives(src));
    const stack = [tree.rootNode];
    while (stack.length) {
      const n = stack.pop();
      if (n.type === 'text_macro_definition') {
        defSites++;
        for (let i = 0; i < n.namedChildCount; i++) {
          const c = n.namedChild(i);
          if (c.type === 'text_macro_name') {
            const id = c.namedChild(0);
            if (id) {
              const nm = id.text.trim();
              if (!defsByName.has(nm)) defsByName.set(nm, new Set());
              defsByName.get(nm).add(rel);
            }
          }
        }
      } else if (n.type === 'text_macro_usage') {
        usageNodes++;
      }
      for (let i = n.namedChildCount - 1; i >= 0; i--) stack.push(n.namedChild(i));
    }
  }

  const multi = [...defsByName].filter(([, s]) => s.size > 1);
  console.log(`files:              ${files.length}`);
  console.log(`\`define sites:      ${defSites}`);
  console.log(`distinct names:     ${defsByName.size}`);
  console.log(`names defined in >1 file: ${multi.length}`);
  console.log(`text_macro_usage nodes:   ${usageNodes}`);
  console.log(`directive references:     ${directiveUses}  (${directiveNames.size} distinct, blanked by pre-parse)`);
  console.log(`  of those, names that ARE defined somewhere: ${[...directiveNames].filter((n) => defsByName.has(n)).length}`);
})();
