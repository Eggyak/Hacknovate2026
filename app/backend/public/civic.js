/**
 * Core Features, on the citizen's own screens.
 *
 * The backend has carried these since the Core Features v1 migration -
 * grouping, support, case comments, satisfaction ratings, the public map and
 * the transparency board - and the web portal was the one place that still
 * did not show any of them. The Android client reads the same endpoints.
 *
 * Kept out of app.js deliberately. That file is already two and a half
 * thousand lines and every one of these is a self-contained panel; bolting
 * them on would have made the one long file longer without making anything
 * clearer. Nothing here touches app.js's state - the helpers it needs are
 * handed in as `ctx`, so there is exactly one direction of dependency.
 */

/**
 * Whether the citizen may rate this case now.
 *
 * The detail endpoint answers this itself - `canRate` - precisely so the
 * rule is not re-derived in each client and got subtly different. That
 * answer is used wherever it exists. The fallback is only for the list and
 * dashboard payloads, which carry the status and the rating but not the
 * verdict, and it decides whether a control is drawn and nothing more: the
 * server still refuses a premature rating with 409 and an out-of-range one
 * with 422, and when the two disagree the server's answer is what is shown.
 */
const FINISHED = new Set(['resolved', 'closed']);

const canRate = (g) => (
  typeof g.canRate === 'boolean'
    ? g.canRate
    : FINISHED.has(String(g.status || '').toLowerCase()) && !g.satisfaction_rating
);

/* ------------------------------------------------------------------ *
 * Panels on a grievance's own page
 * ------------------------------------------------------------------ */

/**
 * The action-taken report, as the department filed it.
 *
 * First of these panels on purpose. When a case has been resolved this is
 * the answer the citizen has been waiting for, and it used to be visible
 * only to the officer who wrote it.
 */
export function reportPanel(g, ctx) {
  if (!g.govt_report) return '';

  return `
    <div class="card mb-4">
      <h3 class="mb-3">Action taken report</h3>
      <p style="white-space:pre-wrap" data-no-i18n>${ctx.esc(g.govt_report)}</p>
      <p class="small muted mt-2">
        Filed by the handling division${g.govt_status_at ? ` on ${ctx.fmtDate(g.govt_status_at)}` : ''}.
      </p>
    </div>`;
}

/**
 * How many neighbours report the same thing.
 *
 * A grouped docket is still its own docket - the server groups without
 * merging, so nobody's complaint is absorbed into somebody else's - and the
 * wording has to make that clear or being "grouped" reads like being
 * dismissed.
 */
export function supportPanel(g, ctx) {
  const supporters = Number(g.supporters || 0);

  return `
    <div class="card mb-4">
      <h3 class="mb-3">Others affected</h3>
      <div class="row" style="gap:10px;align-items:baseline">
        <span class="n tnum" style="font-size:28px;font-weight:800">${supporters}</span>
        <span class="small muted">
          ${supporters === 1 ? 'neighbour reports the same problem' : 'neighbours report the same problem'}
        </span>
      </div>
      ${g.cluster_id ? `
        <p class="small muted mt-2">
          Grouped with nearby reports of the same kind so the division can see the scale of it.
          Your docket is still handled on its own and keeps its own deadline.
        </p>` : `
        <p class="small muted mt-2">
          If a neighbour files the same problem nearby, the two will be grouped automatically.
        </p>`}
      ${supporters > 0 && g.priority_score >= 3 ? `
        <p class="small mt-2" style="color:var(--accent)">
          The weight of support has raised this case's priority.
        </p>` : ''}
    </div>`;
}

/**
 * The thread between the citizen and the handling officer.
 *
 * Only ever the two of them: the server scopes a read to the owner and
 * returns 404 to anybody else, which is why this is on the docket page and
 * not anywhere public.
 */
export function updatesPanel(g, comments, ctx) {
  const rows = (comments || []).map((c) => `
    <div style="padding:10px 0;border-bottom:1px solid var(--line)">
      <p class="small" style="white-space:pre-wrap;margin:0 0 4px" data-no-i18n>${ctx.esc(c.body)}</p>
      <div class="small muted">
        ${ctx.esc(c.author_name || (c.author_kind === 'officer' ? 'Handling officer' : 'You'))}
        &middot; ${ctx.fmtDateTime(c.created_at)}
      </div>
    </div>`).join('');

  return `
    <div class="card mb-4">
      <h3 class="mb-3">Updates</h3>
      ${rows || '<p class="small muted">No updates have been added yet.</p>'}
      <form id="commentForm" class="mt-3">
        <label class="small muted" for="commentBody">Add something to your case</label>
        <textarea id="commentBody" rows="3" maxlength="2000"
                  placeholder="Anything that has changed, or more detail the division should know."></textarea>
        <div class="row between mt-2">
          <span class="small muted">The handling officer will see this.</span>
          <button class="btn primary" type="submit">Post update</button>
        </div>
      </form>
    </div>`;
}

/**
 * The satisfaction rating.
 *
 * Shown as a read-only result once given, because a rating that can be
 * quietly revised is not a record of anything. The server agrees: it
 * refuses a second one.
 */
export function ratingPanel(g, ctx) {
  if (g.satisfaction_rating) {
    return `
      <div class="card mb-4">
        <h3 class="mb-3">Your rating</h3>
        <div class="stars" aria-label="${g.satisfaction_rating} out of 5">
          ${[1, 2, 3, 4, 5].map((n) => `
            <span class="star ${n <= g.satisfaction_rating ? 'on' : ''}" aria-hidden="true">&#9733;</span>`).join('')}
          <span class="small muted" style="margin-left:8px">${g.satisfaction_rating}/5</span>
        </div>
        ${g.satisfaction_comment ? `
          <p class="small mt-2" style="white-space:pre-wrap" data-no-i18n>${ctx.esc(g.satisfaction_comment)}</p>` : ''}
        <p class="small muted mt-2">
          ${g.satisfaction_at ? `Recorded on ${ctx.fmtDate(g.satisfaction_at)}. ` : ''}This cannot be changed.
        </p>
      </div>`;
  }

  if (!canRate(g)) {
    // Say why rather than drawing a control that will be refused.
    return `
      <div class="card mb-4">
        <h3 class="mb-3">Rating</h3>
        <p class="small muted">
          You will be able to rate how this was handled once the division has closed it.
        </p>
      </div>`;
  }

  return `
    <div class="card mb-4">
      <h3 class="mb-3">How was this handled?</h3>
      <form id="ratingForm">
        <div class="stars pick" id="ratingStars" role="radiogroup" aria-label="Rating out of 5">
          ${[1, 2, 3, 4, 5].map((n) => `
            <button type="button" class="star" data-score="${n}" role="radio"
                    aria-checked="false" aria-label="${n} out of 5">&#9733;</button>`).join('')}
        </div>
        <textarea id="ratingComment" rows="2" maxlength="2000" class="mt-2"
                  placeholder="Anything you want on the record (optional)."></textarea>
        <div class="row between mt-2">
          <span class="small muted">This feeds the division's published score.</span>
          <button class="btn primary" type="submit" id="ratingSubmit" disabled>Submit rating</button>
        </div>
      </form>
    </div>`;
}

/**
 * Wires the two forms and the stars.
 *
 * Called after the detail view is in the DOM. `reload` re-renders the whole
 * page rather than patching it: the reply carries no comment row and no
 * recomputed priority, and inventing either locally would mean showing
 * something the server never said.
 */
export function wireDetail(g, ctx, reload) {
  const commentForm = document.querySelector('#commentForm');
  if (commentForm) {
    commentForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const field = document.querySelector('#commentBody');
      const body = field.value.trim();
      if (!body) return;

      const button = commentForm.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await ctx.api.post(`/civic/${encodeURIComponent(g.reference_id)}/comments`, { body });
        ctx.toast('Update added to your case.', 'good');
        await reload();
      } catch (err) {
        ctx.toast(err.message, 'bad');
        button.disabled = false;
      }
    });
  }

  const ratingForm = document.querySelector('#ratingForm');
  if (!ratingForm) return;

  let chosen = 0;
  const stars = [...document.querySelectorAll('#ratingStars .star')];
  const submit = document.querySelector('#ratingSubmit');

  const paint = (upto) => stars.forEach((star, index) => {
    star.classList.toggle('on', index < upto);
    star.setAttribute('aria-checked', String(index + 1 === chosen));
  });

  stars.forEach((star) => {
    const score = Number(star.dataset.score);
    // Hovering previews; only a click commits, so a stray mouse crossing
    // the row cannot leave somebody having rated four when they meant two.
    star.addEventListener('mouseenter', () => paint(score));
    star.addEventListener('focus', () => paint(score));
    star.addEventListener('click', () => {
      chosen = score;
      submit.disabled = false;
      paint(score);
    });
  });

  document.querySelector('#ratingStars').addEventListener('mouseleave', () => paint(chosen));

  ratingForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (chosen < 1) return;

    submit.disabled = true;
    try {
      await ctx.api.post(`/civic/${encodeURIComponent(g.reference_id)}/rating`, {
        rating: chosen,
        comment: document.querySelector('#ratingComment').value.trim() || undefined,
      });
      ctx.toast('Thank you. Your rating has been recorded.', 'good');
      await reload();
    } catch (err) {
      ctx.toast(err.message, 'bad');
      submit.disabled = false;
    }
  });
}

/* ------------------------------------------------------------------ *
 * The public page
 * ------------------------------------------------------------------ */

/**
 * What is being reported, and how well each division handles it.
 *
 * All three endpoints are public and carry no identity. The map rounds
 * every coordinate to three decimals - roughly a hundred metres - before it
 * is served, which is enough to show where a problem is and not enough to
 * show whose house.
 *
 * There are no map tiles. That would mean an API key and a mapping library
 * for a view that says little the grouped list does not, so the points are
 * counted and the clusters are listed.
 */
export async function viewNearby(ctx) {
  ctx.setView('<div class="center" style="padding:60px 0"><span class="spin dark"></span></div>');

  const [map, spots, board, heat] = await Promise.all([
    ctx.api.get('/civic/map').catch(() => ({ points: [] })),
    ctx.api.get('/civic/hotspots').catch(() => ({ hotspots: [] })),
    ctx.api.get('/civic/transparency').catch(() => ({ divisions: [] })),
    loadHeatmap(ctx),
  ]);

  const points = map.points || [];
  const hotspots = spots.hotspots || [];
  const divisions = board.divisions || [];

  const scoreColour = (score) => {
    if (score >= 75) return 'var(--success)';
    if (score >= 50) return 'var(--accent)';
    return 'var(--danger)';
  };

  ctx.setView(`
    <div class="measure">
      <div class="mb-4">
        <h1>Nearby and public</h1>
        <p class="muted small" style="margin:0">
          Open figures from the national record. No names, and no complaint text.
        </p>
      </div>

      <div class="grid c3 mb-4">
        <div class="stat"><div class="n tnum">${points.length}</div><div class="k">Reports plotted</div></div>
        <div class="stat"><div class="n tnum">${hotspots.length}</div><div class="k">Hotspots</div></div>
        <div class="stat"><div class="n tnum">${divisions.length}</div><div class="k">Divisions scored</div></div>
      </div>

      ${map.note ? `<p class="small muted mb-4">${ctx.esc(map.note)}</p>` : ''}

      <div class="mb-4">${heatmapPanel(heat, ctx, { compact: true })}</div>

      <div class="card mb-4">
        <h2 class="mb-3">Hotspots</h2>
        <p class="small muted">
          A hotspot appears once several people report the same kind of problem in one place.
        </p>
        ${hotspots.length ? hotspots.map((h) => `
          <div style="padding:12px 0;border-bottom:1px solid var(--line)">
            <div class="row between wrap">
              <div>
                <b>${ctx.esc(h.title || h.division || 'Grouped reports')}</b>
                <div class="small muted">
                  ${ctx.esc(h.division || '')}${h.pincode ? ` &middot; PIN ${ctx.esc(h.pincode)}` : ''}
                </div>
              </div>
              <div class="center">
                <div class="tnum" style="font-weight:800">${h.reports}</div>
                <div class="small muted">report(s)</div>
              </div>
            </div>
            <div class="small muted mt-1">
              ${h.resolved} of ${h.reports} resolved${h.lastReported ? ` &middot; last reported ${ctx.fmtDate(h.lastReported)}` : ''}
            </div>
          </div>`).join('') : '<p class="small muted mt-2">No hotspots have formed yet.</p>'}
      </div>

      <div class="card">
        <h2 class="mb-3">Transparency board</h2>
        <p class="small muted">
          ${ctx.esc(board.explain || 'Averages cover resolved cases only.')}
        </p>
        ${divisions.length ? divisions.map((d) => `
          <div style="padding:12px 0;border-bottom:1px solid var(--line)">
            <div class="row between wrap">
              <b>${ctx.esc(d.division)}</b>
              <span class="tnum" style="font-weight:800;color:${scoreColour(d.transparencyScore)}">
                ${d.transparencyScore}<span class="small muted" style="font-weight:400">/100</span>
              </span>
            </div>
            <div class="meter mt-1" aria-hidden="true">
              <span style="width:${Math.max(0, Math.min(100, d.transparencyScore))}%;background:${scoreColour(d.transparencyScore)}"></span>
            </div>
            <div class="small muted mt-1">
              ${d.resolved} of ${d.total} resolved
              ${d.overdue ? ` &middot; <span style="color:var(--danger)">${d.overdue} overdue</span>` : ''}
              ${d.averageDaysToResolve !== null ? ` &middot; about ${d.averageDaysToResolve} days to resolve` : ''}
              &middot; ${d.averageRating !== null
                ? `${d.averageRating}/5 from ${d.ratingsReceived} rating(s)`
                : 'no ratings yet'}
            </div>
          </div>`).join('') : '<p class="small muted mt-2">No division has enough history to score yet.</p>'}
      </div>
    </div>`);
}

/* ------------------------------------------------------------------ *
 * The dashboard nudge
 * ------------------------------------------------------------------ */

/**
 * Asks for a rating once, on the dashboard, where it belongs.
 *
 * Without this the satisfaction figure stays empty and the transparency
 * score is computed from nothing - which is exactly the state the board was
 * in before. Asking on every screen would be worse than not asking.
 */
export function ratingNudge(recent, ctx) {
  const unrated = (recent || []).filter(canRate);
  if (unrated.length === 0) return '';

  const first = unrated[0];
  return `
    <div class="notice mb-4" style="border-color:var(--accent)">
      <span>
        ${unrated.length === 1
          ? 'One of your grievances has been closed.'
          : `${unrated.length} of your grievances have been closed.`}
        Telling us how it was handled is what the division's published score is built from.
      </span>
      <a class="btn ghost small" href="#/g/${encodeURIComponent(first.reference_id)}">
        Rate ${ctx.esc(first.reference_id)}
      </a>
    </div>`;
}

/**
 * Reports that look like the one being written, offered before filing.
 *
 * An offer, never a redirect. Somebody with the same broken thing can add
 * their weight to an existing docket, and if they would rather file their
 * own then that is theirs to do.
 */
export async function similarOffer(ctx, { text, divisionId, pincode }) {
  if (!text || !divisionId || !pincode) return '';

  let found;
  try {
    found = await ctx.api.post('/civic/similar', { text, divisionId, pincode });
  } catch {
    return '';
  }

  const similar = found.similar || [];
  if (similar.length === 0) return '';

  return `
    <div class="card mb-3" style="border-color:var(--accent)">
      <h3 class="mb-2">Already reported near you</h3>
      <p class="small muted">
        ${similar.length === 1 ? 'One report' : `${similar.length} reports`} of the same kind
        ${similar.length === 1 ? 'is' : 'are'} already open nearby. Carry on with yours if it is
        a separate problem - these are shown so the division can see the scale of it.
      </p>
      ${similar.map((s) => `
        <div style="padding:8px 0;border-bottom:1px solid var(--line)">
          <div class="small"><b data-no-i18n>${ctx.esc(s.reference_id || '')}</b>
            ${s.supporters ? `<span class="muted"> &middot; ${s.supporters} supporter(s)</span>` : ''}</div>
          <div class="small muted">${ctx.esc((s.subject || s.translated_text || '').slice(0, 90))}</div>
        </div>`).join('')}
    </div>`;
}

/* ------------------------------------------------------------------ *
 * Heatmap
 * ------------------------------------------------------------------ */

/**
 * Where the states sit on the grid.
 *
 * A tile grid, not a map. Drawing real borders would mean shipping an
 * outline of India and getting every boundary right - a disputed one drawn
 * carelessly is worse than no map at all - for a picture whose only job is
 * "which states are busy". Each state is one square in roughly its real
 * position, so the shape of the country is recognisable and no border is
 * claimed. Newspapers have used this for years for the same reason.
 *
 * Codes match data/states.js on the server, which is also what the heatmap
 * endpoint returns, so nothing here has to map names to places.
 */
const STATE_GRID = [
  ['JK', 1, 0],
  ['PB', 1, 1], ['CH', 2, 1], ['HP', 3, 1], ['UK', 4, 1],
  ['RJ', 1, 2], ['HR', 2, 2], ['DL', 3, 2], ['NE', 5, 2], ['AS', 6, 2],
  ['GJ', 0, 3], ['MP', 2, 3], ['UP', 3, 3], ['BR', 4, 3],
  ['MH', 1, 4], ['CG', 2, 4], ['JH', 3, 4], ['WB', 4, 4],
  ['TG', 2, 5], ['OR', 3, 5],
  ['LD', 0, 6], ['KA', 1, 6], ['AP', 2, 6], ['AN', 4, 6],
  ['KL', 1, 7], ['TN', 2, 7], ['PY', 3, 7],
];

const TILE = 34;
const GAP = 4;

/**
 * Five steps, not a continuous ramp.
 *
 * A smooth gradient looks better and reads worse: nobody can tell 12 from
 * 17 by shade. Banded, with the counts printed on the tiles, somebody can
 * actually answer "which is worst" at a glance.
 */
function heatBand(count, busiest) {
  if (count <= 0) return 0;
  if (busiest <= 1) return 5;
  return Math.max(1, Math.min(5, Math.ceil((count / busiest) * 5)));
}

/**
 * The heatmap, as an inline SVG.
 *
 * No canvas and no charting library: 27 rounded squares and some text is
 * less code than wiring up a dependency, and it inherits the page's own
 * colours and text size.
 */
export function heatmapPanel(data, ctx, { compact = false } = {}) {
  const states = data?.states || [];
  const busiest = data?.busiest || 0;
  const byCode = new Map(states.filter((s) => s.code).map((s) => [s.code, s]));

  const cols = Math.max(...STATE_GRID.map(([, x]) => x)) + 1;
  const rows = Math.max(...STATE_GRID.map(([, , y]) => y)) + 1;
  const width = cols * (TILE + GAP);
  const height = rows * (TILE + GAP);

  const tiles = STATE_GRID.map(([code, x, y]) => {
    const found = byCode.get(code);
    const count = found ? found.total : 0;
    const band = heatBand(count, busiest);
    const label = found ? found.name : code;

    return `
      <g class="heat-tile heat-${band}">
        <title>${ctx.esc(label)}: ${count} complaint(s)${found && found.overdue ? `, ${found.overdue} overdue` : ''}</title>
        <rect x="${x * (TILE + GAP)}" y="${y * (TILE + GAP)}"
              width="${TILE}" height="${TILE}" rx="7" />
        <text x="${x * (TILE + GAP) + TILE / 2}" y="${y * (TILE + GAP) + TILE / 2 - 1}"
              text-anchor="middle" class="heat-code">${code}</text>
        ${count > 0 ? `
          <text x="${x * (TILE + GAP) + TILE / 2}" y="${y * (TILE + GAP) + TILE - 7}"
                text-anchor="middle" class="heat-count">${count}</text>` : ''}
      </g>`;
  }).join('');

  const legend = [1, 2, 3, 4, 5]
    .map((band) => `<span class="heat-key heat-${band}"></span>`)
    .join('');

  return `
    <div class="card heat-card">
      <div class="row between wrap mb-2">
        <div>
          <h3 style="margin:0">Complaint heatmap</h3>
          <p class="small muted" style="margin:2px 0 0">
            ${data?.total ? `${data.total} complaint(s) across ${states.length} state(s)`
              : 'No complaints have been filed with a location yet.'}
          </p>
        </div>
        ${!compact ? '<a class="small" href="#/nearby">Open the public board</a>' : ''}
      </div>

      <div class="heat-wrap">
        <svg viewBox="0 0 ${width} ${height}" class="heat-svg" role="img"
             aria-label="Complaints by state, as a grid of tiles">
          ${tiles}
        </svg>
      </div>

      <div class="row between wrap mt-2">
        <div class="row" style="gap:6px;align-items:center">
          <span class="small muted">Fewer</span>
          ${legend}
          <span class="small muted">More</span>
        </div>
        <span class="small muted">One tile per state, placed roughly. Not a boundary map.</span>
      </div>
    </div>`;
}

/** Fetches the heatmap. An empty one still renders, so failure is quiet. */
/**
 * The same figures, for one person's own area.
 *
 * A state tile is the right unit for a ministry and the wrong one for a
 * citizen: "Punjab: 14" tells somebody in Ludhiana nothing. With a pincode
 * the server groups by district instead, and this draws them as a ranked
 * bar list rather than a grid - there is no sensible fixed layout for
 * districts, and ordering by volume is what makes the list readable.
 */
export function districtHeatPanel(data, ctx) {
  const districts = data?.districts || [];
  const busiest = data?.busiest || 0;

  const rows = districts.slice(0, 12).map((d) => {
    const band = heatBand(d.total, busiest);
    const width = busiest > 0 ? Math.max(4, Math.round((d.total / busiest) * 100)) : 0;
    return `
      <div class="heat-row">
        <span class="heat-row-name">${ctx.esc(d.name)}</span>
        <span class="heat-row-bar"><i class="heat-${band}" style="width:${width}%"></i></span>
        <span class="heat-row-n tnum">${d.total}</span>
      </div>`;
  }).join('');

  return `
    <div class="card heat-card">
      <div class="row between wrap mb-2">
        <div>
          <h3 style="margin:0">Around you</h3>
          <p class="small muted" style="margin:2px 0 0">
            ${data?.area
              ? `${data.total} complaint(s) across ${districts.length} district(s) in ${ctx.esc(data.area)}`
              : 'We could not place your area yet.'}
          </p>
        </div>
        <a class="small" href="#/nearby">Open the public board</a>
      </div>

      ${rows || `<p class="small muted">
        Nothing has been reported near you yet. This fills in as complaints
        are filed in your district.</p>`}

      ${districts.length ? `<p class="small muted mt-2">
        Grouped by district from the complaint pincode. No names, no addresses.</p>` : ''}
    </div>`;
}

/**
 * Where the citizen's own area comes from.
 *
 * Their most recent filing, because that is a pincode we already hold and
 * that they chose. Device coordinates would be the obvious alternative,
 * but turning a position into a district needs a geocoder we do not have,
 * and asking for location permission to draw a chart is a poor trade.
 */
export async function loadLocalHeatmap(ctx, pincode) {
  if (!pincode) return null;
  try {
    return await ctx.api.get(`/civic/heatmap?scope=district&pincode=${encodeURIComponent(pincode)}`);
  } catch {
    return null;
  }
}

/** Fetches the heatmap. An empty one still renders, so failure is quiet. */
export async function loadHeatmap(ctx, params = '') {
  try {
    return await ctx.api.get(`/civic/heatmap${params}`);
  } catch {
    return { states: [], busiest: 0, total: 0 };
  }
}

/* ------------------------------------------------------------------ *
 * Spoken status callback
 * ------------------------------------------------------------------ */

/**
 * "Call me and tell me."
 *
 * The portal already reads in fourteen languages and the bot already
 * speaks them, but all of that still assumes a screen and a literate
 * reader. A grievance system whose status is only legible to people who
 * can read it has the same gap as one that only accepts written English -
 * just moved one step later in the process.
 *
 * So: pick a language, the system rings the number already on the account,
 * and a synthesised voice reads back where the case has got to. There is
 * no field to type a number into, deliberately - this cannot be pointed at
 * anybody else's phone.
 */
export function callbackPanel(options, ctx) {
  if (!options) return '';

  if (!options.available) {
    return `
      <div class="card mb-4">
        <h3 class="mb-2">Hear your status</h3>
        <p class="small muted">${ctx.esc(options.unavailableReason || 'Not available yet.')}</p>
      </div>`;
  }

  const languages = (options.languages || []).map((l) => `
    <option value="${ctx.esc(l.code)}">${ctx.esc(l.native || l.name)}</option>`).join('');

  const last = (options.recent || [])[0];
  const lastLine = last
    ? `<p class="small muted mt-2">Last request: ${ctx.esc(last.status)}${
        last.requested_at ? ` on ${ctx.fmtDate(last.requested_at)}` : ''
      }.</p>`
    : '';

  return `
    <div class="card mb-4" id="callbackCard">
      <h3 class="mb-2">Hear your status</h3>
      <p class="small muted">
        We will ring ${options.callsTo ? `<b>${ctx.esc(options.callsTo)}</b>` : 'your registered number'}
        and read out where your most recent grievance has got to. Status only &mdash;
        your complaint is never read aloud.
      </p>

      <label class="small muted mt-2" for="callLang">Language for the call</label>
      <select id="callLang" class="select">${languages}</select>

      <button class="btn primary mt-2" id="callNow" style="width:100%">
        Call me now
      </button>
      ${lastLine}
      <p class="small muted mt-1" id="callResult"></p>
    </div>`;
}

/** Wires the button. Called once the card is in the DOM. */
export function wireCallback(ctx, onDone) {
  const button = document.querySelector('#callNow');
  if (!button) return;

  button.addEventListener('click', async () => {
    const language = document.querySelector('#callLang')?.value || 'en';
    const result = document.querySelector('#callResult');

    button.disabled = true;
    if (result) result.textContent = 'Requesting…';

    try {
      const reply = await ctx.api.post('/calls/request', { language });
      if (result) result.textContent = reply.message || 'Your phone will ring shortly.';
      ctx.toast(reply.message || 'Call requested.', 'good');
      if (onDone) await onDone();
    } catch (err) {
      if (result) result.textContent = err.message;
      ctx.toast(err.message, 'bad');
      // Re-enabled only on failure: a queued call should not be asked for
      // twice because the first one has not rung yet.
      button.disabled = false;
    }
  });
}

/** Options for the card. Absent means the panel simply is not drawn. */
export async function loadCallbackOptions(ctx) {
  try {
    return await ctx.api.get('/calls/options');
  } catch {
    return null;
  }
}
