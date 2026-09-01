/**
 * Regression gate for fork finding 28 / `[retrieval 1]`.
 *
 * `codegraph_explore` ranked files containing ZERO occurrences of an exactly
 * queried symbol above the sole file containing it, and presented the result
 * with the same confidence as a correct answer. On a real design,
 * `explore` for an exact field name led with a behavioural model that never mentions
 * the token while the one real consumer fell into the unshown overflow.
 *
 * The cause is not FTS — `nodes_fts MATCH 'cfg_tx_offset'` returns exactly
 * the right single row. It is the NAMED-SYMBOL SEEDING tier in handleExplore,
 * which guarantees that a symbol the agent explicitly named is injected into
 * the subgraph and its file scored. That tier was gated to a `SEEDABLE` kind
 * set of callables plus `variable`/`constant` — and every HDL net, port and
 * register is indexed as `field`. So for a hardware query the one thing an
 * engineer names could never seed, and its file competed on generic text rank
 * alone against files reached only by graph expansion.
 *
 * This pins the OUTCOME, not the mechanism: whatever future work does to
 * ranking, the file that DECLARES an exactly-named signal must not lose to a
 * file that never mentions it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

/** The ONLY file containing the token. */
const TARGET = 'rtl/tx_top.v';
const SIGNAL = 'cfg_tx_offset';

/**
 * The decoys instantiate tx_top POSITIONALLY, which is why they are connected
 * to the signal in the graph while containing zero occurrences of its name —
 * the same shape as the files that displaced the real answer.
 */
const FILES: Record<string, string> = {
  'rtl/tx_top.v': `
module tx_top(input clk, input [7:0] ${SIGNAL}, output reg [7:0] dout);
  reg [7:0] ofs_cnt;
  always @(posedge clk) begin
    if (ofs_cnt < ${SIGNAL}) dout <= 8'h00;
    else dout <= ofs_cnt;
  end
endmodule
`,
  'rtl/mid_if.v': `
module mid_if(input clk, output [7:0] o0, output [7:0] o1);
  wire [7:0] frame_offset;
  wire [7:0] width_cfg;
  wire [7:0] lane_mask;
  wire [7:0] frame_len;
  wire [7:0] bit_depth;
  wire [7:0] sample_rate;
  wire [7:0] fifo_level;
  wire [7:0] pad_count;
  reg  [7:0] shadow_a;
  reg  [7:0] shadow_b;
  reg  [7:0] shadow_c;
  assign frame_offset = width_cfg + lane_mask;
  always @(posedge clk) shadow_a <= frame_len;
  always @(posedge clk) shadow_b <= bit_depth;
  always @(posedge clk) shadow_c <= sample_rate;
  tx_top u_tx0(clk, frame_offset, o0);
  helper u_help(clk, fifo_level, o1);
endmodule
`,
  'rtl/helper.v': `
module helper(input clk, input [7:0] level, output reg [7:0] q);
  reg [7:0] acc;
  reg [7:0] tmp;
  always @(posedge clk) acc <= level;
  always @(posedge clk) tmp <= acc;
  always @(posedge clk) q <= tmp;
endmodule
`,
  // Decoys that share the query's SEGMENTS (cfg / tx / offset) without
  // ever containing the token. This is what makes the fixture reproduce the
  // finding rather than an adjacent one: the text rank has plenty to chew on,
  // so the subgraph is richly populated and the declaring file has to win on
  // ranking rather than by being the only thing present.
  'rtl/cfg_rx.v': `
module cfg_rx(input clk, input [7:0] cfg_rx_en, output reg [7:0] rx_dat);
  reg [7:0] offset_cnt_rx;
  reg [7:0] tx_offset_shadow;
  reg [7:0] cfg_rx_mode;
  always @(posedge clk) rx_dat <= offset_cnt_rx + tx_offset_shadow + cfg_rx_en;
  always @(posedge clk) offset_cnt_rx <= cfg_rx_mode;
endmodule
`,
  'rtl/cfg_tx.v': `
module cfg_tx(input clk, input [7:0] cfg_tx_en, output reg [7:0] tx_dat);
  reg [7:0] offset_cnt_tx;
  reg [7:0] tx_offset_latch;
  reg [7:0] cfg_tx_mode;
  always @(posedge clk) tx_dat <= offset_cnt_tx + tx_offset_latch + cfg_tx_en;
  always @(posedge clk) offset_cnt_tx <= cfg_tx_mode;
endmodule
`,
  'beh/bus_model.v': `
module bus_model(input clk, output reg [7:0] model_out);
  reg [7:0] cfg_tx_len;
  reg [7:0] offset_acc;
  reg [7:0] tx_offset_model;
  reg [7:0] cfg_start;
  always @(posedge clk) offset_acc <= cfg_tx_len;
  always @(posedge clk) tx_offset_model <= offset_acc;
  always @(posedge clk) model_out <= tx_offset_model + cfg_start;
  cfg_tx u_tx(clk, cfg_tx_len, model_out);
  cfg_rx u_rx(clk, cfg_start, model_out);
endmodule
`,
};

let tempDir: string;
let cg: CodeGraph;
let handler: ToolHandler;
let text = '';

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hdl-seed-'));
  for (const [rel, body] of Object.entries(FILES)) {
    const abs = path.join(tempDir, rel.replace(/\//g, path.sep));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  handler = new ToolHandler(cg);
  const res = await handler.execute('codegraph_explore', { query: SIGNAL });
  text = res.content[0]?.text ?? '';
}, 120_000);

afterAll(() => {
  try { cg?.destroy(); } catch { /* best effort */ }
  if (tempDir && fs.existsSync(tempDir)) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* Windows lock */ }
  }
});

/** Files in the order explore rendered them. */
function renderedFiles(out: string): string[] {
  const seen: string[] = [];
  for (const m of out.matchAll(/\*\*`([^`]+)`\*\*/g)) {
    const f = m[1]!;
    if (!seen.includes(f)) seen.push(f);
  }
  return seen;
}

describe('explore — an exactly-named HDL signal leads with the file that declares it', () => {
  it('leads with the declaring file, not a file that never mentions the token', () => {
    // The defect symptom: the declaring file is absent or outranked.
    expect(renderedFiles(text)[0]).toBe(TARGET);
  });

  it('never ranks a zero-occurrence file above the file containing the token', () => {
    const order = renderedFiles(text);
    const target = order.indexOf(TARGET);
    expect(target, `${TARGET} was not rendered at all`).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < target; i++) {
      const rel = order[i]!;
      const src = fs.readFileSync(path.join(tempDir, rel.replace(/\//g, path.sep)), 'utf8');
      expect(src, `${rel} ranked above ${TARGET} without containing "${SIGNAL}"`).toContain(SIGNAL);
    }
  });

  it('renders the declaring source, so the agent never has to Read it', () => {
    expect(text).toContain(SIGNAL);
    expect(text).toContain('ofs_cnt');
  });
});
