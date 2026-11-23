// Token Radar v3 — endurance-weighted log-scale valuation (vocaine-radar-v3).
//
// A protocol's implied token value is built ONLY from the sealed snapshot's
// own figures. The model is deliberately NOT proportional to TVL: a protocol
// ten times larger is not worth ten times more, because a token's value
// saturates as a protocol grows — the market pays for the marginal user,
// not for the vault that is already full.
//
//   scale     = (tvl_usd / 1e6) ^ ALPHA          ALPHA = 0.55, sublinear.
//               $5M of TVL scores ~2.4 units, $13.8B scores ~190: a 2,700x
//               TVL gap becomes an ~80x value gap, spread over orders of
//               magnitude without letting raw size decide the board.
//   growth    = 1 + 0.6 * clamp(change_7d, -60, 300) / 100
//               A week's momentum, winsorised hard: one wild week (the
//               snapshot's max is +4,448%) cannot carry a protocol, and a
//               -60% week cannot kill one. Unreported growth counts as 0.
//   endurance = 0.70 + 0.50 * ln(1 + age/120) / ln(1 + 1500/120)
//               Log-age: how long the protocol has run with no token
//               recorded. A year of waiting matters far more than the
//               second year; a 45-day record scores ~0.76, a 1,500-day
//               record ~1.20. Unknown listing date assumes 365 days.
//   breadth   = 1 + 0.10 * ln(min(chains, 25))
//               Chain breadth, logged: the first extra chains add real
//               distribution, the 40th adds almost nothing.
//   peer      = 0.85 + 0.30 * clamp(log10(tvl / categoryMedianTvl), -1, 1)
//               Standing inside its own category: a protocol that leads
//               its category is worth more than the same TVL buried in a
//               bigger category. The median is computed from the snapshot
//               itself, per category, so no name is ever special-cased.
//
//   implied   = round(1_200_000 * scale * growth * endurance * breadth * peer)
//
// The board ranks every watchlist protocol plus every other rankable
// pre-token protocol (below the floor, not a CEX / bridge / liquid-staking
// / restaked product, not a versioned pool). Protocols whose token already
// trades are NEVER ranked: the dashboard shows them apart, at the market's
// own capitalisation, as comparables. No protocol name is special-cased
// anywhere in this file.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-v3-vocaine';

/** Sublinear TVL exponent: value grows slower than size. */
export const ALPHA = 0.55;
/** Dollars per unit of (TVL / $1M) ^ ALPHA. */
export const SCALE_BASE = 1_200_000;
/** Growth winsorisation, in per cent per week. */
export const GROWTH_FLOOR = -60;
export const GROWTH_CAP = 300;
export const GROWTH_WEIGHT = 0.6;
/** Endurance (log-age) curve. */
export const ENDURANCE_FLOOR = 0.7;
export const ENDURANCE_RANGE = 0.5;
export const ENDURANCE_SCALE_DAYS = 120;
export const ENDURANCE_REF_DAYS = 1500;
export const UNKNOWN_AGE_DAYS = 365;
/** Chain-breadth curve. */
export const BREADTH_WEIGHT = 0.1;
export const BREADTH_CHAIN_CAP = 25;
/** Peer-standing curve, in log10 of TVL over the category median. */
export const PEER_BASE = 0.85;
export const PEER_WEIGHT = 0.3;
export const PEER_LOG_CAP = 1;
/** How many live-token protocols the comparables panel carries, by market cap. */
export const LIVE_ROWS = 24;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Median TVL per category across every protocol in the snapshot. */
export function categoryMedians(snapshot: Snapshot): Record<string, number> {
  const byCat = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    const c = p.category ?? 'Uncategorised';
    const arr = byCat.get(c) ?? [];
    arr.push(p.tvl_usd);
    byCat.set(c, arr);
  }
  const out: Record<string, number> = {};
  for (const [c, arr] of [...byCat.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    arr.sort((a, b) => a - b);
    const mid = Math.floor(arr.length / 2);
    out[c] = arr.length % 2 === 1 ? arr[mid]! : Math.round((arr[mid - 1]! + arr[mid]!) / 2);
  }
  return out;
}

export interface Valuation {
  implied: number;
  scale: number;
  growthPct: number;
  growthMult: number;
  enduranceMult: number;
  breadthMult: number;
  peerMult: number;
  categoryMedianTvl: number;
  age: number | null;
}

/** Score one protocol. Every input is a snapshot figure; every factor is logged. */
export function valueProtocol(
  p: SnapshotProtocol,
  asOf: string,
  medians: Record<string, number>,
): Valuation {
  const age = ageDays(asOf, p.listed_at);
  const scale = Math.pow(Math.max(p.tvl_usd, 1) / 1_000_000, ALPHA);
  const rawGrowth = finite(p.change_7d, 0);
  const growthPct = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, rawGrowth));
  const growthMult = 1 + (GROWTH_WEIGHT * growthPct) / 100;
  const ageForModel = age ?? UNKNOWN_AGE_DAYS;
  const enduranceMult =
    ENDURANCE_FLOOR +
    (ENDURANCE_RANGE * Math.log(1 + Math.max(ageForModel, 0) / ENDURANCE_SCALE_DAYS)) /
      Math.log(1 + ENDURANCE_REF_DAYS / ENDURANCE_SCALE_DAYS);
  const breadthMult = 1 + BREADTH_WEIGHT * Math.log(Math.min(Math.max(p.chains.length, 1), BREADTH_CHAIN_CAP));
  const median = medians[p.category ?? 'Uncategorised'] ?? p.tvl_usd;
  const peerLog = Math.min(PEER_LOG_CAP, Math.max(-PEER_LOG_CAP, Math.log10(Math.max(p.tvl_usd, 1) / Math.max(median, 1))));
  const peerMult = PEER_BASE + PEER_WEIGHT * peerLog;
  const implied = Math.max(1, Math.min(100_000_000_000_000, Math.round(SCALE_BASE * scale * growthMult * enduranceMult * breadthMult * peerMult)));
  return {
    implied,
    scale: round4(scale),
    growthPct,
    growthMult: round4(growthMult),
    enduranceMult: round4(enduranceMult),
    breadthMult: round4(breadthMult),
    peerMult: round4(peerMult),
    categoryMedianTvl: median,
    age,
  };
}

/** Risk flags, each derived from the protocol's own snapshot figures. */
export function riskFlags(p: SnapshotProtocol, v: Valuation): string[] {
  const flags: string[] = [];
  if (p.change_7d !== null && p.change_7d <= -10) {
    flags.push(`TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in 7 days — momentum is against this farm right now; size the position small until the slide stops.`);
  }
  if (p.change_7d !== null && p.change_7d >= 100) {
    flags.push(`TVL jumped ${p.change_7d.toFixed(0)}% in 7 days — a surge this fast often reverses, so the growth factor is winsorised and the farm should not chase it.`);
  }
  if (p.change_7d === null) flags.push('No 7-day change reported — growth is unmeasured, so the value leans on TVL, age and category standing alone.');
  if (p.chains.length === 1 && p.tvl_usd >= 500_000_000) {
    flags.push('Single-chain with very large TVL — one chain outage or exploit hits the whole position.');
  }
  if (v.age !== null && v.age < 90) flags.push(`Tracked for only ${v.age} days — a young record; the launch case rests on thin evidence.`);
  if (v.age === null) flags.push('No listing date recorded — age is assumed at 365 days, so treat the endurance read as approximate.');
  if (p.tvl_usd >= 1_000_000_000 && (p.change_7d ?? 0) < 0) {
    flags.push('Over $1B TVL and shrinking — size alone does not make this a good farm.');
  }
  if (flags.length === 0) flags.push('No red flag in the snapshot: TVL, growth, age and category standing all read steady.');
  return flags;
}

/** One plain sentence saying which input drives this protocol's rank. */
export function whyRank(p: SnapshotProtocol, v: Valuation): string {
  const drivers: string[] = [];
  if (v.growthMult >= 1.3) drivers.push(`7-day growth of ${v.growthPct.toFixed(1)}% lifts it hard`);
  else if (v.growthMult <= 0.85) drivers.push(`a 7-day slide of ${v.growthPct.toFixed(1)}% drags it down`);
  if (v.enduranceMult >= 1.1) drivers.push(`a long no-token record (${v.age ?? 365} days) adds endurance value`);
  else if (v.enduranceMult <= 0.8) drivers.push(`a short track record (${v.age ?? 365} days) limits endurance value`);
  if (v.peerMult >= 1.05) drivers.push('it leads its own category on TVL');
  else if (v.peerMult <= 0.65) drivers.push('it trails its category median on TVL');
  if (v.breadthMult >= 1.2) drivers.push(`${p.chains.length} chains widen its distribution`);
  if (p.tvl_usd >= 1_000_000_000) drivers.push(`$${(p.tvl_usd / 1e9).toFixed(2)}B TVL still anchors the scale term`);
  else if (p.tvl_usd < 10_000_000) drivers.push('tiny TVL keeps it early — cheap to farm, thin evidence');
  if (drivers.length === 0) drivers.push('steady TVL, growth and age carry it — no single factor dominates');
  return drivers.slice(0, 2).join('; ') + '.';
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
/** Categories the watchlist rule itself keeps off the board: exchanges and wrapped / staked / bridged products of tokens that already trade. */
const EXCLUDED_CATEGORIES = new Set(['CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Rankable: pre-token, not an exchange / bridge / liquid-staking product, not a versioned pool, not a wrapped or staked product by name. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  return true;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  on_watchlist: boolean;
  valuation: {
    scale: number;
    growth_pct: number;
    growth_multiplier: number;
    endurance_multiplier: number;
    breadth_multiplier: number;
    peer_multiplier: number;
    category_median_tvl: number;
  };
  risk_flags: string[];
  why_rank: string;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: {
    alpha: number;
    scale_base: number;
    growth_floor: number;
    growth_cap: number;
    growth_weight: number;
    endurance_floor: number;
    endurance_range: number;
    breadth_weight: number;
    peer_base: number;
    peer_weight: number;
    unknown_age_days: number;
  };
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: BoardRow[];
  live: LiveRow[];
}

function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Farm capital, from the protocol's own TVL tier. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 150;
  if (p.tvl_usd >= 10_000_000) return 75;
  return 50;
}

/** Hold length, from the protocol's age: younger records need a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

/** The category's core farming action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${n} on ${chain}, then borrow $20 of a stable asset against it so the wallet shows both a supply and a borrow.`;
  if (c.includes('dex')) return `Add $${capital} of liquidity to ${n}'s deepest pool on ${chain} in a tight range, and leave the position earning fees instead of a single swap.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${n} vault on ${chain} and hold the vault shares for the whole season — curators score vault holders, not passers-by.`;
  if (c.includes('yield aggregator') || c.includes('yield')) return `Deposit $${capital} of USDC into ${n}'s highest-yield vault on ${chain} and leave the vault shares untouched for the season.`;
  if (c.includes('restak')) return `Restake $${capital} of the chain's staking asset through ${n} and keep the receipt token in the same wallet as the stake.`;
  if (c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${n} and keep the staking receipt in the same wallet.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${n}, open one small long with 2x leverage at most, and close it after a week.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one position in an active market on ${n}, then let it settle when that market closes.`;
  if (c.includes('stable')) return `Mint $${capital} of the stable asset through ${n} on ${chain} and hold it in the farming wallet for the season.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${n}'s yield-bearing asset on ${chain} and hold it so the accrual, not a flip, is what the record shows.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${n} on ${chain} and keep the policy active for the whole season.`;
  if (c.includes('payment')) return `Route $${capital} of payments through ${n} on ${chain} in at least three separate transactions spread over two weeks.`;
  if (c.includes('chain')) return `Bridge $${capital} onto the chain ${n} runs, use its native app once a week, and keep all of it in one wallet.`;
  if (c.includes('basis')) return `Deposit $${capital} into ${n}'s basis vault on ${chain} and hold the shares while the funding rate pays out.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} and keep the position open for the full season.`;
}

/** A second, category-flavoured qualifying action for the weekly rhythm. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'a small extra supply or a borrow repayment';
  if (c.includes('dex')) return 'a swap through the pool or a small range adjustment';
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield')) return 'a top-up deposit or a vault allocation vote';
  if (c.includes('restak') || c.includes('staking')) return 'a restake of the rewards or a delegation change';
  if (c.includes('perpetual') || c.includes('derivative')) return 'one small trade or a margin top-up';
  if (c.includes('prediction')) return 'one new market position';
  if (c.includes('rwa')) return 'a mint of the yield asset or a redemption check';
  if (c.includes('payment')) return 'one more payment routed through the app';
  return 'a deposit, a swap or a vote in the protocol app';
}

function money(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

function stepText(s: string): string {
  let t = s.trim().replace(/\s+/g, ' ');
  if (t.length > 600) t = `${t.slice(0, 597)}...`;
  if (t.length < 20) t = `${t} Keep the position open and re-check the protocol's own page monthly.`;
  return t;
}

/**
 * Seven farm steps: action, cost and time in every step, from the protocol's
 * own record (category, chains, TVL, age, growth, category median). No two
 * protocols share a plan unless their records coincide.
 */
export function farmSteps(p: SnapshotProtocol, v: Valuation): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(v.age);
  const weekly = weeklyFor(p);
  const gas = capital >= 150 ? 8 : 4;
  const median = money(v.categoryMedianTvl);
  const tvl = money(p.tvl_usd);
  const growthNote =
    p.change_7d === null
      ? 'its 7-day change is unreported, so farm for the long record, not a hot week'
      : p.change_7d <= -10
        ? `its TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in 7 days, so start with half the capital and add only if the slide stops`
        : p.change_7d >= 50
          ? `its TVL surged ${p.change_7d.toFixed(0)}% in 7 days, so do not chase the spike — farm the base position and wait`
          : `its 7-day change is ${p.change_7d >= 0 ? '+' : ''}${p.change_7d.toFixed(1)}%, steady enough to farm the full position`;
  return [
    stepText(`Open a fresh wallet that holds only the farm funds and write its seed phrase on paper, never in a screenshot or chat. Cost: under $3 of gas for the first transaction. Time: 5 minutes.`),
    stepText(`${actionFor(p, capital, chain)} Cost: $${capital} of capital plus about $${gas} of gas. Time: 20 minutes to set up.`),
    stepText(`Do one qualifying action each week — ${weekly} — so the wallet shows repeat activity, not a single deposit. Cost: about $2 of gas a week. Time: 10 minutes a week.`),
    stepText(`Hold the position for at least ${hold} days so the activity spans more than one snapshot window. Cost: the $${capital} stays locked in the position. Time: ${hold} days.`),
    stepText(`Once a month, compare ${p.name} against its own category: its TVL is ${tvl} while the ${p.category ?? 'uncategorised'} median is ${median} — if it slips below that median, the peer factor falls and the farm is worth re-sizing. Cost: free to check. Time: 10 minutes a month.`),
    stepText(`Size the entry to the momentum: ${growthNote}. Cost: no extra fee beyond the position itself. Time: 5 minutes to check the snapshot figures.`),
    stepText(`Before any claim, open the protocol's own points or rewards page from its official site and claim only from the link it publishes; log the wallet, the dates and every transaction hash, and never pay anyone to claim for you. Cost: no fee to check. Time: 10 minutes.`),
  ];
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const medians = categoryMedians(snapshot);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = valueProtocol(p, snapshot.as_of, medians);
    return { p, v };
  });
  // Deterministic: implied desc, then TVL desc, then slug.
  scored.sort((a, b) => b.v.implied - a.v.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const watch = new Set(snapshot.watchlist);
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    on_watchlist: watch.has(s.p.slug),
    valuation: {
      scale: s.v.scale,
      growth_pct: s.v.growthPct,
      growth_multiplier: s.v.growthMult,
      endurance_multiplier: s.v.enduranceMult,
      breadth_multiplier: s.v.breadthMult,
      peer_multiplier: s.v.peerMult,
      category_median_tvl: s.v.categoryMedianTvl,
    },
    risk_flags: riskFlags(s.p, s.v),
    why_rank: whyRank(s.p, s.v),
    farm_steps: farmSteps(s.p, s.v),
  }));
}

/** The live-token protocols, by market cap, for the comparables panel. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.on_watchlist).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: {
      alpha: ALPHA,
      scale_base: SCALE_BASE,
      growth_floor: GROWTH_FLOOR,
      growth_cap: GROWTH_CAP,
      growth_weight: GROWTH_WEIGHT,
      endurance_floor: ENDURANCE_FLOOR,
      endurance_range: ENDURANCE_RANGE,
      breadth_weight: BREADTH_WEIGHT,
      peer_base: PEER_BASE,
      peer_weight: PEER_WEIGHT,
      unknown_age_days: UNKNOWN_AGE_DAYS,
    },
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows, outside 100..4000`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
