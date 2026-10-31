import React from 'react';

/**
 * Complaints by state, as a tile grid.
 *
 * One square per state, placed roughly where it sits. Not a boundary map,
 * and deliberately so: drawing real borders would mean shipping an outline
 * of India and getting every one of them right, and a disputed boundary
 * drawn carelessly is worse than no map at all. This needs no tiles, no
 * API key and no mapping library, and it claims no border.
 *
 * Five discrete bands rather than a gradient, with the count printed on
 * the tile. Nobody can tell 12 from 17 by shade, and "which is worst" is
 * the only question this chart exists to answer.
 */

export interface StateLoad {
  name: string;
  total: number;
  resolved: number;
  overdue: number;
  open: number;
}

export interface StateHeat {
  states: StateLoad[];
  busiest: number;
  total: number;
}

/** [code, column, row] — the same layout the citizen portal uses. */
const GRID: ReadonlyArray<readonly [string, number, number]> = [
  ['JK', 1, 0],
  ['PB', 1, 1], ['CH', 2, 1], ['HP', 3, 1], ['UK', 4, 1],
  ['RJ', 1, 2], ['HR', 2, 2], ['DL', 3, 2], ['NE', 5, 2], ['AS', 6, 2],
  ['GJ', 0, 3], ['MP', 2, 3], ['UP', 3, 3], ['BR', 4, 3],
  ['MH', 1, 4], ['CG', 2, 4], ['JH', 3, 4], ['WB', 4, 4],
  ['TG', 2, 5], ['OR', 3, 5],
  ['LD', 0, 6], ['KA', 1, 6], ['AP', 2, 6], ['AN', 4, 6],
  ['KL', 1, 7], ['TN', 2, 7], ['PY', 3, 7],
];

/**
 * State name to code.
 *
 * The workspace stores the name a ward was seeded with, not a code, so the
 * mapping has to happen somewhere. It is here rather than on the server
 * because the grid above is the only thing that needs codes at all.
 */
const CODES: Record<string, string> = {
  'Delhi': 'DL', 'Haryana': 'HR', 'Punjab': 'PB', 'Chandigarh': 'CH',
  'Himachal Pradesh': 'HP', 'Jammu & Kashmir': 'JK', 'Uttar Pradesh': 'UP',
  'Uttarakhand': 'UK', 'Rajasthan': 'RJ', 'Gujarat': 'GJ', 'Maharashtra': 'MH',
  'Madhya Pradesh': 'MP', 'Chhattisgarh': 'CG', 'Telangana': 'TG',
  'Andhra Pradesh': 'AP', 'Karnataka': 'KA', 'Tamil Nadu': 'TN',
  'Puducherry': 'PY', 'Kerala': 'KL', 'Lakshadweep': 'LD', 'West Bengal': 'WB',
  'Andaman & Nicobar Islands': 'AN', 'Odisha': 'OR', 'Assam': 'AS',
  'North Eastern States': 'NE', 'Bihar': 'BR', 'Jharkhand': 'JH',
};

const TILE = 34;
const GAP = 4;

function band(count: number, busiest: number) {
  if (count <= 0) return 0;
  if (busiest <= 1) return 5;
  return Math.max(1, Math.min(5, Math.ceil((count / busiest) * 5)));
}

export function StateHeatmap({ data }: { data: StateHeat | null }) {
  const byCode = new Map<string, StateLoad>();
  let unplaced = 0;

  for (const entry of data?.states ?? []) {
    const code = CODES[entry.name];
    // A ticket whose state we cannot place is counted and reported, not
    // quietly dropped - a total that does not add up is its own bug.
    if (!code) {
      unplaced += entry.total;
      continue;
    }
    byCode.set(code, entry);
  }

  const busiest = data?.busiest ?? 0;
  const columns = Math.max(...GRID.map(([, x]) => x)) + 1;
  const rows = Math.max(...GRID.map(([, , y]) => y)) + 1;

  return (
    <div className="panel" style={{ marginTop: '14px' }}>
      <div className="panel-head">
        <h3>Complaints by State</h3>
        <span className="table-secondary">
          {data?.total ? `${data.total} case(s) in your scope` : 'No placed cases yet'}
        </span>
      </div>
      <div className="panel-body">
        <div className="heat-wrap">
          <svg
            viewBox={`0 0 ${columns * (TILE + GAP)} ${rows * (TILE + GAP)}`}
            className="heat-svg"
            role="img"
            aria-label="Cases by state, as a grid of tiles"
          >
            {GRID.map(([code, x, y]) => {
              const found = byCode.get(code);
              const count = found?.total ?? 0;
              return (
                <g key={code} className={`heat-tile heat-${band(count, busiest)}`}>
                  <title>
                    {`${code}: ${count} case(s)${found?.overdue ? `, ${found.overdue} overdue` : ''}`}
                  </title>
                  <rect
                    x={x * (TILE + GAP)}
                    y={y * (TILE + GAP)}
                    width={TILE}
                    height={TILE}
                    rx={7}
                  />
                  <text
                    x={x * (TILE + GAP) + TILE / 2}
                    y={y * (TILE + GAP) + TILE / 2 - 1}
                    textAnchor="middle"
                    className="heat-code"
                  >
                    {code}
                  </text>
                  {count > 0 && (
                    <text
                      x={x * (TILE + GAP) + TILE / 2}
                      y={y * (TILE + GAP) + TILE - 7}
                      textAnchor="middle"
                      className="heat-count"
                    >
                      {count}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        <div className="heat-legend">
          <span className="table-secondary">Fewer</span>
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} className={`heat-key heat-${n}`} />
          ))}
          <span className="table-secondary">More</span>
          <span className="table-secondary" style={{ marginInlineStart: 'auto' }}>
            One tile per state, placed roughly. Not a boundary map.
          </span>
        </div>

        {unplaced > 0 && (
          <p className="table-secondary" style={{ marginTop: '8px' }}>
            {unplaced} case(s) carry no recognised state and are not shown on the grid.
          </p>
        )}
      </div>
    </div>
  );
}
